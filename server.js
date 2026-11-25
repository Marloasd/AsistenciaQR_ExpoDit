const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const S = require('./lib/seguridad');
const R = require('./lib/reglas');
const { crearDatosDemo } = require('./lib/demo');

/* ---------- Configuración ---------- */
const puerto = Number(process.env.PORT || 8000);
const enRender = process.env.RENDER === 'true';
const urlPublica = process.env.RENDER_EXTERNAL_URL;
const usuarioAdmin = process.env.APP_USER || 'admin';
const claveAdmin = process.env.APP_PASSWORD || (enRender ? undefined : 'admin');
const tokenBot = process.env.N8N_TOKEN; // lo usa n8n para leer y confirmar los avisos de WhatsApp
if (enRender && (!claveAdmin || !process.env.MONGODB_URI || !urlPublica)) {
  throw new Error('Configura APP_PASSWORD y MONGODB_URI para iniciar en Render.');
}
if (!process.env.APP_PASSWORD) console.warn('Sin APP_PASSWORD: en local la contraseña del administrador es «admin».');
const secreto = process.env.SESSION_SECRET || S.derivarSecreto(claveAdmin);
const DURACION_SESION = 8 * 60 * 60 * 1000;

const cliente = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 3000 });
const bd = cliente.db(process.env.MONGODB_DB || 'asistencia_qr');
const alumnos = bd.collection('alumnos');
const materias = bd.collection('materias');
const clases = bd.collection('clases');
const asistencias = bd.collection('asistencias');
const avisos = bd.collection('avisos');
const usuarios = bd.collection('usuarios');

const zona = process.env.APP_TZ || 'America/Mexico_City';
const formatoFecha = new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' });
const formatoHora = new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const ahora = () => { const d = new Date(); return { fecha: formatoFecha.format(d), hora: formatoHora.format(d), iso: d.toISOString() }; };

const archivos = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/css/style.css', ['css/style.css', 'text/css']],
  ...['db.js', 'ui.js', 'qr.js', 'maestro.js', 'alumno.js', 'app.js', 'vendor/qrcode.min.js', 'vendor/html5-qrcode.min.js']
    .map(nombre => ['/js/' + nombre, ['js/' + nombre, 'text/javascript']])
]);

/* ---------- Utilidades ---------- */
function json(res, estado, datos) {
  res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: estado < 400, ...datos }));
}
const fallo = (estado, mensaje) => Object.assign(new Error(mensaje), { estado, mensaje });

async function cuerpo(req) {
  if (req.headers['content-type'] !== 'application/json') throw fallo(415, 'Se requiere un cuerpo JSON.');
  const partes = [];
  let bytes = 0;
  for await (const parte of req) {
    bytes += parte.length;
    if (bytes <= 16384) partes.push(parte);
  }
  if (bytes > 16384) throw fallo(413, 'Solicitud demasiado grande.');
  try { return JSON.parse(Buffer.concat(partes).toString('utf8')) || {}; } catch { throw fallo(400, 'JSON inválido.'); }
}

const texto = v => typeof v === 'string' ? v.trim() : '';
const normalizar = v => texto(v).toUpperCase();
const matriculaValida = /^[A-Z0-9]{4,15}$/;
const fechaValida = /^\d{4}-\d{2}-\d{2}$/;
const horaValida = /^([01]\d|2[0-3]):[0-5]\d$/;

async function insertarSiNoExiste(coleccion, doc) {
  try { await coleccion.insertOne(doc); return true; }
  catch (error) { if (error.code === 11000) return false; throw error; }
}

/* ---------- Sesión ---------- */
const intentos = new Map(); // ip -> { n, hasta }: freno sencillo contra adivinar contraseñas o PIN
const ipDe = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function bloqueado(ip) { const i = intentos.get(ip); return i && i.n >= 8 && i.hasta > Date.now(); }
function registrarFallo(ip) {
  const i = intentos.get(ip);
  intentos.set(ip, i && i.hasta > Date.now() ? { n: i.n + 1, hasta: i.hasta } : { n: 1, hasta: Date.now() + 15 * 60 * 1000 });
}

function obtenerSesion(req) {
  const auth = req.headers.authorization || '';
  if (tokenBot && auth.startsWith('Bearer ') && S.iguales(auth.slice(7), tokenBot)) return { rol: 'bot', u: 'n8n' };
  if (auth.startsWith('Basic ')) { // útil para scripts y pruebas; en el navegador se usa el formulario de acceso
    const [u, ...c] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
    if (u === usuarioAdmin && claveAdmin && S.iguales(c.join(':'), claveAdmin)) return { rol: 'admin', u, nombre: 'Administrador' };
  }
  const datos = S.leerFirmado(S.leerCookie(req.headers.cookie, 'sid'), secreto);
  return datos ? { rol: datos.r, u: datos.u, nombre: datos.n } : null;
}

const cookieSesion = (token, edad) => 'sid=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + edad + (enRender ? '; Secure' : '');
function iniciarSesion(res, sesion) {
  const token = S.firmar({ r: sesion.rol, u: sesion.u, n: sesion.nombre, exp: Date.now() + DURACION_SESION }, secreto);
  res.setHeader('Set-Cookie', cookieSesion(token, DURACION_SESION / 1000));
}

/* ---------- Cálculos compartidos ---------- */
const porMatricula = lista => {
  const mapa = new Map();
  for (const r of lista) (mapa.get(r.matricula) || mapa.set(r.matricula, []).get(r.matricula)).push(r);
  return mapa;
};

async function cargarMateria(id) {
  const materia = await materias.findOne({ _id: normalizar(id) });
  if (!materia) throw fallo(404, 'La materia no existe.');
  return materia;
}
function exigirMateria(sesion, materia) {
  if (sesion.rol !== 'admin' && materia.maestro !== sesion.u) throw fallo(403, 'Esa materia es de otro maestro.');
}
async function materiaPropia(ctx) {
  const materia = await cargarMateria(ctx.params.id);
  exigirMateria(ctx.sesion, materia);
  return materia;
}

async function resolverAlumno(entrada) {
  const t = normalizar(entrada);
  if (!matriculaValida.test(t)) throw fallo(400, 'Escribe o escanea una matrícula válida.');
  const alumno = (await alumnos.findOne({ _id: t })) || (await alumnos.findOne({ codigo: t }));
  if (!alumno) throw fallo(404, 'El código ' + t + ' no corresponde a ningún alumno.');
  return alumno;
}

function fichaMateria(materia, listaClases, listaAsist, mapaAlumnos) {
  const registros = porMatricula(listaAsist);
  const resumenes = materia.inscritos.map(m => ({ matricula: m, nombre: (mapaAlumnos.get(m) || {}).nombre || m, resumen: R.resumen(materia, registros.get(m) || []) }));
  const hoy = ahora().fecha;
  const claseHoy = listaClases.find(c => c.fecha === hoy);
  return {
    id: materia._id, clave: materia.clave, nombre: materia.nombre, grupo: materia.grupo, maestro: materia.maestro,
    horaInicio: materia.horaInicio, clasesPlaneadas: materia.clasesPlaneadas, porcentajeFaltas: materia.porcentajeFaltas,
    permitidas: R.faltasPermitidas(materia.clasesPlaneadas, materia.porcentajeFaltas),
    inscritos: materia.inscritos.length,
    impartidas: listaClases.filter(c => c.estado === 'cerrada').length,
    enRiesgo: resumenes.filter(r => r.resumen.estado === 'riesgo' || r.resumen.estado === 'limite').length,
    sinDerecho: resumenes.filter(r => r.resumen.estado === 'sin_derecho').length,
    claseHoy: claseHoy ? { estado: claseHoy.estado, presentes: listaAsist.filter(a => a.fecha === hoy && a.estado !== 'falta').length } : null
  };
}

/* ---------- Avisos de WhatsApp (bandeja de salida que lee n8n) ---------- */
async function crearAviso({ id, tipo, materiaId, matricula, destinatario, telefono, texto: mensaje }) {
  const { iso } = ahora();
  return insertarSiNoExiste(avisos, {
    _id: id, tipo, materiaId, matricula, destinatario, telefono: telefono || '', texto: mensaje,
    estado: telefono ? 'pendiente' : 'omitido', intentos: 0, creado: iso, enviado: null, detalle: telefono ? '' : 'Sin teléfono registrado'
  });
}

/* Después de cerrar una clase: avisa al tutor de cada falta y al alumno cuando le quedan pocas (o ninguna). */
async function generarAvisos(materia, fecha, matriculas) {
  const todas = porMatricula(await asistencias.find({ materiaId: materia._id }).toArray());
  let creados = 0;
  for (const m of matriculas) {
    const alumno = await alumnos.findOne({ _id: m });
    if (!alumno) continue;
    const r = R.resumen(materia, todas.get(m) || []);
    const base = { materiaId: materia._id, matricula: m };
    const tutor = (alumno.tutor || {}).telefono;
    if (await crearAviso({ ...base, id: ['falta', materia._id, m, fecha].join('|'), tipo: 'falta', destinatario: 'tutor', telefono: tutor, texto: R.textoAvisoTutor(alumno, materia, fecha, r) })) creados++;
    if (r.crudo <= 3 && r.equivalentes > 0 &&
        await crearAviso({ ...base, id: ['restantes', materia._id, m, r.crudo].join('|'), tipo: 'restantes', destinatario: 'alumno', telefono: alumno.telefono, texto: R.textoAvisoAlumno(alumno, materia, r) })) creados++;
  }
  return creados;
}

/* ---------- Rutas ---------- */
const rutas = [];
const ruta = (metodo, patron, roles, fn) => rutas.push({ metodo, roles, fn, re: new RegExp('^' + patron.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });
const STAFF = ['admin', 'maestro'];

ruta('GET', '/healthz', null, async () => ({ estado: 200, datos: { msg: 'ok' } }));

ruta('POST', '/api/login', null, async ({ req, res, body }) => {
  const ip = ipDe(req);
  if (bloqueado(ip)) throw fallo(429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
  const d = await body();
  const entrada = texto(d.usuario), clave = typeof d.clave === 'string' ? d.clave : '';
  let sesion = null;
  if (entrada === usuarioAdmin) {
    if (claveAdmin && S.iguales(clave, claveAdmin)) sesion = { rol: 'admin', u: usuarioAdmin, nombre: 'Administrador' };
  } else {
    const maestro = await usuarios.findOne({ _id: entrada.toLowerCase() });
    if (maestro) {
      if (S.verificarClave(clave, maestro.hash)) sesion = { rol: 'maestro', u: maestro._id, nombre: maestro.nombre };
    } else {
      const alumno = await alumnos.findOne({ _id: normalizar(entrada) });
      if (alumno && S.verificarClave(clave, alumno.pinHash)) sesion = { rol: 'alumno', u: alumno._id, nombre: alumno.nombre };
    }
  }
  if (!sesion) { registrarFallo(ip); throw fallo(401, 'Usuario o contraseña incorrectos.'); }
  intentos.delete(ip);
  iniciarSesion(res, sesion);
  return { estado: 200, datos: { usuario: sesion.u, nombre: sesion.nombre, rol: sesion.rol } };
});

ruta('POST', '/api/logout', null, async ({ res }) => {
  res.setHeader('Set-Cookie', cookieSesion('', 0));
  return { estado: 200, datos: { msg: 'Sesión cerrada.' } };
});

ruta('GET', '/api/sesion', ['admin', 'maestro', 'alumno'], async ({ sesion }) =>
  ({ estado: 200, datos: { usuario: sesion.u, nombre: sesion.nombre, rol: sesion.rol } }));

/* --- Maestros (solo el administrador) --- */
ruta('GET', '/api/maestros', ['admin'], async () => {
  const lista = await usuarios.find({}).toArray();
  return { estado: 200, datos: { datos: lista.map(u => ({ usuario: u._id, nombre: u.nombre })) } };
});
ruta('POST', '/api/maestros', ['admin'], async ({ body }) => {
  const d = await body();
  const usuario = texto(d.usuario).toLowerCase(), nombre = texto(d.nombre), clave = typeof d.clave === 'string' ? d.clave : '';
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario) || usuario === usuarioAdmin.toLowerCase()) throw fallo(400, 'El usuario debe tener de 3 a 30 letras minúsculas, números, punto, guion o guion bajo.');
  if (!nombre || nombre.length > 100) throw fallo(400, 'Escribe el nombre del maestro.');
  if (clave.length < 8) throw fallo(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (!(await insertarSiNoExiste(usuarios, { _id: usuario, nombre, hash: S.hashClave(clave), rol: 'maestro' }))) throw fallo(409, 'Ese usuario ya existe.');
  return { estado: 201, datos: { msg: 'Maestro creado.' } };
});
ruta('DELETE', '/api/maestros/:usuario', ['admin'], async ({ params }) => {
  const propias = await materias.find({ maestro: params.usuario }).toArray();
  if (propias.length) throw fallo(409, 'Ese maestro todavía tiene ' + propias.length + ' materia(s). Elimínalas o reasígnalas antes.');
  await usuarios.deleteOne({ _id: params.usuario });
  return { estado: 200, datos: { msg: 'Maestro eliminado.' } };
});

/* --- Alumnos --- */
function validarAlumno(d, { esNuevo }) {
  const matricula = normalizar(d.matricula), generacion = normalizar(d.generacion), nombre = texto(d.nombre);
  if (esNuevo && !matriculaValida.test(matricula)) throw fallo(400, 'La matrícula debe tener de 4 a 15 letras o números, sin espacios.');
  if (!nombre || nombre.length > 150) throw fallo(400, 'Escribe un nombre de hasta 150 caracteres.');
  if (!/^\d{4}[A-Z]$/.test(generacion)) throw fallo(400, 'Escribe la generación con cuatro números y una letra, por ejemplo 2026B.');
  const tutorTel = R.normalizarTelefono((d.tutor || {}).telefono), telefono = R.normalizarTelefono(d.telefono);
  if (tutorTel === null || telefono === null) throw fallo(400, 'El teléfono debe tener 10 dígitos (por ejemplo 33 1234 5678).');
  return { matricula, nombre, generacion, telefono, tutor: { nombre: texto((d.tutor || {}).nombre).slice(0, 100), telefono: tutorTel } };
}
const fichaAlumno = a => ({ matricula: a._id, nombre: a.nombre, generacion: a.generacion, codigo: a.codigo, telefono: a.telefono || '', tutor: a.tutor || { nombre: '', telefono: '' }, demo: !!a.demo });

ruta('GET', '/api/alumnos', STAFF, async () => {
  const lista = await alumnos.find({}).toArray();
  for (const a of lista) if (!a.codigo) { a.codigo = S.codigoAleatorio(); await alumnos.updateOne({ _id: a._id }, { $set: { codigo: a.codigo } }); }
  lista.sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'));
  return { estado: 200, datos: { datos: lista.map(fichaAlumno) } };
});
ruta('POST', '/api/alumnos', STAFF, async ({ body }) => {
  const a = validarAlumno(await body(), { esNuevo: true });
  const pin = S.pinAleatorio();
  const doc = { _id: a.matricula, matricula: a.matricula, nombre: a.nombre, generacion: a.generacion, telefono: a.telefono, tutor: a.tutor, codigo: S.codigoAleatorio(), pinHash: S.hashClave(pin) };
  if (!(await insertarSiNoExiste(alumnos, doc))) throw fallo(409, 'La matrícula ya está registrada.');
  return { estado: 201, datos: { msg: 'Alumno registrado correctamente.', pin } };
});
ruta('PUT', '/api/alumnos/:matricula', STAFF, async ({ params, body }) => {
  const a = validarAlumno({ ...(await body()), matricula: params.matricula }, { esNuevo: false });
  const existente = await alumnos.findOne({ _id: normalizar(params.matricula) });
  if (!existente) throw fallo(404, 'El alumno no existe.');
  await alumnos.updateOne({ _id: existente._id }, { $set: { nombre: a.nombre, generacion: a.generacion, telefono: a.telefono, tutor: a.tutor } });
  return { estado: 200, datos: { msg: 'Datos del alumno actualizados.' } };
});
ruta('POST', '/api/alumnos/:matricula/pin', STAFF, async ({ params }) => {
  const existente = await alumnos.findOne({ _id: normalizar(params.matricula) });
  if (!existente) throw fallo(404, 'El alumno no existe.');
  const pin = S.pinAleatorio();
  await alumnos.updateOne({ _id: existente._id }, { $set: { pinHash: S.hashClave(pin) } });
  return { estado: 200, datos: { msg: 'PIN nuevo generado.', pin } };
});
ruta('DELETE', '/api/alumnos/:matricula', STAFF, async ({ params }) => {
  const m = normalizar(params.matricula);
  if (!matriculaValida.test(m)) throw fallo(400, 'Matrícula inválida.');
  for (const materia of await materias.find({ inscritos: m }).toArray()) await materias.updateOne({ _id: materia._id }, { $pull: { inscritos: m } });
  await asistencias.deleteMany({ matricula: m });
  await avisos.deleteMany({ matricula: m });
  await alumnos.deleteOne({ _id: m });
  return { estado: 200, datos: { msg: 'Alumno eliminado.' } };
});

/* --- Materias --- */
ruta('GET', '/api/materias', STAFF, async ({ sesion }) => {
  const lista = await materias.find(sesion.rol === 'admin' ? {} : { maestro: sesion.u }).toArray();
  const ids = lista.map(m => m._id);
  const [todasClases, todasAsist, todosAlumnos] = await Promise.all([
    clases.find({ materiaId: { $in: ids } }).toArray(), asistencias.find({ materiaId: { $in: ids } }).toArray(), alumnos.find({}).toArray()
  ]);
  const mapaAlumnos = new Map(todosAlumnos.map(a => [a._id, a]));
  const datos = lista.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')).map(m =>
    fichaMateria(m, todasClases.filter(c => c.materiaId === m._id), todasAsist.filter(a => a.materiaId === m._id), mapaAlumnos));
  return { estado: 200, datos: { datos } };
});

async function validarMateria(d, sesion, { esNueva, maestroActual }) {
  const clave = normalizar(d.clave), nombre = texto(d.nombre);
  if (esNueva && !/^[A-Z0-9-]{2,15}$/.test(clave)) throw fallo(400, 'La clave debe tener de 2 a 15 letras, números o guiones (por ejemplo PW-A).');
  if (nombre.length < 3 || nombre.length > 80) throw fallo(400, 'Escribe el nombre de la materia (3 a 80 caracteres).');
  const planeadas = Number(d.clasesPlaneadas ?? 40), porcentaje = Number(d.porcentajeFaltas ?? R.PORCENTAJE_FALTAS);
  if (!Number.isInteger(planeadas) || planeadas < 1 || planeadas > 200) throw fallo(400, 'Las clases planeadas deben ser un número entre 1 y 200.');
  if (!Number.isInteger(porcentaje) || porcentaje < 0 || porcentaje > 50) throw fallo(400, 'El porcentaje de faltas debe estar entre 0 y 50.');
  const horaInicio = texto(d.horaInicio);
  if (horaInicio && !horaValida.test(horaInicio)) throw fallo(400, 'La hora de inicio debe tener el formato HH:MM.');
  let maestro = maestroActual || sesion.u;
  if (sesion.rol === 'admin' && texto(d.maestro)) {
    maestro = texto(d.maestro).toLowerCase();
    if (maestro !== usuarioAdmin.toLowerCase() && !(await usuarios.findOne({ _id: maestro }))) throw fallo(400, 'El maestro «' + maestro + '» no existe.');
    if (maestro === usuarioAdmin.toLowerCase()) maestro = usuarioAdmin;
  }
  return { clave, nombre, grupo: texto(d.grupo).slice(0, 20), horaInicio, clasesPlaneadas: planeadas, porcentajeFaltas: porcentaje, maestro };
}
ruta('POST', '/api/materias', STAFF, async ({ sesion, body }) => {
  const m = await validarMateria(await body(), sesion, { esNueva: true });
  if (!(await insertarSiNoExiste(materias, { _id: m.clave, ...m, inscritos: [] }))) throw fallo(409, 'Ya existe una materia con esa clave.');
  return { estado: 201, datos: { msg: 'Materia creada.', id: m.clave } };
});
ruta('PUT', '/api/materias/:id', STAFF, async ctx => {
  const materia = await materiaPropia(ctx);
  const m = await validarMateria({ ...(await ctx.body()), clave: materia._id }, ctx.sesion, { esNueva: false, maestroActual: materia.maestro });
  const { clave, ...cambios } = m;
  await materias.updateOne({ _id: materia._id }, { $set: cambios });
  return { estado: 200, datos: { msg: 'Materia actualizada.' } };
});
ruta('DELETE', '/api/materias/:id', STAFF, async ctx => {
  const materia = await materiaPropia(ctx);
  await asistencias.deleteMany({ materiaId: materia._id });
  await clases.deleteMany({ materiaId: materia._id });
  await avisos.deleteMany({ materiaId: materia._id });
  await materias.deleteOne({ _id: materia._id });
  return { estado: 200, datos: { msg: 'Materia eliminada junto con sus clases y asistencias.' } };
});

ruta('POST', '/api/materias/:id/inscribir', STAFF, async ctx => {
  const materia = await materiaPropia(ctx);
  const { matriculas } = await ctx.body();
  if (!Array.isArray(matriculas) || !matriculas.length || matriculas.length > 500) throw fallo(400, 'Indica de 1 a 500 matrículas.');
  const validas = [...new Set(matriculas.map(normalizar))];
  const existentes = (await alumnos.find({ _id: { $in: validas } }).toArray()).map(a => a._id);
  const nuevos = existentes.filter(m => !materia.inscritos.includes(m));
  if (nuevos.length) await materias.updateOne({ _id: materia._id }, { $addToSet: { inscritos: { $each: nuevos } } });
  const noEncontradas = validas.filter(m => !existentes.includes(m));
  return { estado: 200, datos: { msg: nuevos.length + ' alumno(s) inscrito(s)' + (noEncontradas.length ? '; no existen: ' + noEncontradas.slice(0, 5).join(', ') : '.'), inscritos: nuevos.length, noEncontradas } };
});
ruta('DELETE', '/api/materias/:id/inscritos/:matricula', STAFF, async ctx => {
  const materia = await materiaPropia(ctx);
  const m = normalizar(ctx.params.matricula);
  await materias.updateOne({ _id: materia._id }, { $pull: { inscritos: m } });
  await asistencias.deleteMany({ materiaId: materia._id, matricula: m });
  return { estado: 200, datos: { msg: 'Alumno dado de baja de la materia.' } };
});

/* --- Clases y asistencia --- */
ruta('GET', '/api/materias/:id/clases', STAFF, async ctx => {
  const materia = await materiaPropia(ctx);
  const [lista, regs] = await Promise.all([clases.find({ materiaId: materia._id }).toArray(), asistencias.find({ materiaId: materia._id }).toArray()]);
  const datos = lista.sort((a, b) => b.fecha.localeCompare(a.fecha)).map(c => {
    const delDia = regs.filter(r => r.fecha === c.fecha);
    const n = e => delDia.filter(r => r.estado === e).length;
    return { fecha: c.fecha, estado: c.estado, presentes: n('presente'), retardos: n('retardo'), faltas: n('falta'), justificadas: n('justificada') };
  });
  return { estado: 200, datos: { datos } };
});

async function asegurarClase(materia, fecha, hora) {
  const id = materia._id + '|' + fecha;
  await insertarSiNoExiste(clases, { _id: id, materiaId: materia._id, fecha, estado: 'abierta', abierta: hora });
  return clases.findOne({ _id: id });
}

ruta('POST', '/api/materias/:id/clases', STAFF, async ctx => {
  const materia = await materiaPropia(ctx);
  const { fecha, hora } = ahora();
  const clase = await asegurarClase(materia, fecha, hora);
  return { estado: 200, datos: { msg: clase.estado === 'cerrada' ? 'La clase de hoy ya estaba cerrada.' : 'Clase de hoy abierta.', fecha, claseEstado: clase.estado } };
});

ruta('POST', '/api/materias/:id/asistencia', STAFF, async ctx => {
  const materia = await materiaPropia(ctx);
  const { texto: lectura } = await ctx.body();
  const alumno = await resolverAlumno(lectura);
  if (!materia.inscritos.includes(alumno._id)) throw fallo(403, alumno.nombre + ' no está inscrito en ' + materia.nombre + '.');
  const { fecha, hora, iso } = ahora();
  const clase = await asegurarClase(materia, fecha, hora);
  if (clase.estado === 'cerrada') throw fallo(409, 'La clase de hoy ya está cerrada.');
  const estado = R.estadoPorHora(materia.horaInicio, hora);
  const guardado = await insertarSiNoExiste(asistencias, { _id: [materia._id, fecha, alumno._id].join('|'), materiaId: materia._id, matricula: alumno._id, fecha, hora, estado, origen: 'qr', registrado: iso });
  if (!guardado) throw fallo(409, alumno.nombre + ' ya registró su asistencia hoy.');
  return { estado: 201, datos: { msg: (estado === 'retardo' ? 'Retardo registrado: ' : 'Asistencia registrada: ') + alumno.nombre + ' (' + hora + ')', alumno: alumno.nombre, claseEstado: estado, hora } };
});

ruta('POST', '/api/materias/:id/clases/hoy/cerrar', STAFF, async ctx => {
  const materia = await materiaPropia(ctx);
  const { fecha, hora } = ahora();
  const clase = await clases.findOne({ _id: materia._id + '|' + fecha });
  if (!clase) throw fallo(404, 'Hoy no se ha abierto ninguna clase de esta materia.');
  if (clase.estado === 'cerrada') throw fallo(409, 'La clase de hoy ya estaba cerrada.');
  const hechos = new Set((await asistencias.find({ materiaId: materia._id, fecha }).toArray()).map(r => r.matricula));
  const faltantes = materia.inscritos.filter(m => !hechos.has(m));
  for (const m of faltantes) await insertarSiNoExiste(asistencias, { _id: [materia._id, fecha, m].join('|'), materiaId: materia._id, matricula: m, fecha, hora, estado: 'falta', origen: 'cierre' });
  await clases.updateOne({ _id: clase._id }, { $set: { estado: 'cerrada', cierre: hora } });
  const creados = await generarAvisos(materia, fecha, faltantes);
  return { estado: 200, datos: { msg: 'Clase cerrada: ' + hechos.size + ' presente(s), ' + faltantes.length + ' falta(s).', presentes: hechos.size, faltas: faltantes.length, avisos: creados } };
});

ruta('PATCH', '/api/materias/:id/asistencia', STAFF, async ctx => {
  const materia = await materiaPropia(ctx);
  const d = await ctx.body();
  const matricula = normalizar(d.matricula), fecha = texto(d.fecha) || ahora().fecha, estado = texto(d.estado);
  if (!materia.inscritos.includes(matricula)) throw fallo(404, 'Ese alumno no está inscrito en la materia.');
  if (!fechaValida.test(fecha)) throw fallo(400, 'Fecha inválida.');
  if (!['presente', 'retardo', 'falta', 'justificada'].includes(estado)) throw fallo(400, 'Estado inválido.');
  const { hora, iso } = ahora();
  const clase = await asegurarClase(materia, fecha, hora);
  await asistencias.updateOne({ _id: [materia._id, fecha, matricula].join('|') },
    { $set: { materiaId: materia._id, matricula, fecha, hora, estado, origen: 'manual', registrado: iso } }, { upsert: true });
  if (estado === 'falta' && clase.estado === 'cerrada') await generarAvisos(materia, fecha, [matricula]);
  return { estado: 200, datos: { msg: 'Registro actualizado.' } };
});

ruta('GET', '/api/materias/:id/reporte', STAFF, async ctx => {
  const materia = await materiaPropia(ctx);
  const [listaClases, regs, todosAlumnos] = await Promise.all([clases.find({ materiaId: materia._id }).toArray(), asistencias.find({ materiaId: materia._id }).toArray(), alumnos.find({ _id: { $in: materia.inscritos } }).toArray()]);
  const mapaAlumnos = new Map(todosAlumnos.map(a => [a._id, a]));
  const fechas = listaClases.map(c => c.fecha).sort();
  const registros = porMatricula(regs);
  const filas = materia.inscritos.map(m => {
    const propios = registros.get(m) || [];
    return {
      matricula: m, nombre: (mapaAlumnos.get(m) || {}).nombre || m,
      dias: Object.fromEntries(propios.map(r => [r.fecha, r.estado])), resumen: R.resumen(materia, propios)
    };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  const ficha = fichaMateria(materia, listaClases, regs, mapaAlumnos);
  return { estado: 200, datos: { materia: ficha, fechas, alumnos: filas, hoy: ahora().fecha } };
});

/* --- Portal del alumno --- */
ruta('GET', '/api/yo', ['alumno'], async ({ sesion }) => {
  const alumno = await alumnos.findOne({ _id: sesion.u });
  if (!alumno) throw fallo(404, 'Tu registro ya no existe.');
  if (!alumno.codigo) { alumno.codigo = S.codigoAleatorio(); await alumnos.updateOne({ _id: alumno._id }, { $set: { codigo: alumno.codigo } }); }
  const lista = await materias.find({ inscritos: alumno._id }).toArray();
  const regs = await asistencias.find({ matricula: alumno._id }).toArray();
  const datos = lista.map(m => {
    const propios = regs.filter(r => r.materiaId === m._id).sort((a, b) => b.fecha.localeCompare(a.fecha));
    return { id: m._id, nombre: m.nombre, grupo: m.grupo, maestro: m.maestro, horaInicio: m.horaInicio, clasesPlaneadas: m.clasesPlaneadas, resumen: R.resumen(m, propios), recientes: propios.slice(0, 8).map(r => ({ fecha: r.fecha, estado: r.estado })) };
  });
  return { estado: 200, datos: { alumno: { matricula: alumno._id, nombre: alumno.nombre, generacion: alumno.generacion, codigo: alumno.codigo }, materias: datos } };
});

/* --- Avisos --- */
ruta('GET', '/api/avisos', STAFF, async ({ sesion }) => {
  let lista = await avisos.find({}).toArray();
  if (sesion.rol !== 'admin') {
    const propias = new Set((await materias.find({ maestro: sesion.u }).toArray()).map(m => m._id));
    lista = lista.filter(a => propias.has(a.materiaId));
  }
  lista.sort((a, b) => b.creado.localeCompare(a.creado));
  return { estado: 200, datos: { datos: lista.slice(0, 100).map(a => ({ id: a._id, tipo: a.tipo, destinatario: a.destinatario, matricula: a.matricula, materiaId: a.materiaId, telefono: a.telefono, texto: a.texto, estado: a.estado, creado: a.creado, enviado: a.enviado, detalle: a.detalle })) } };
});
ruta('GET', '/api/avisos/pendientes', ['admin', 'bot'], async () => {
  const lista = (await avisos.find({ estado: 'pendiente' }).toArray()).sort((a, b) => a.creado.localeCompare(b.creado)).slice(0, 20);
  return { estado: 200, datos: { datos: lista.map(a => ({ id: a._id, telefono: a.telefono, texto: a.texto, tipo: a.tipo, intentos: a.intentos })) } };
});
ruta('POST', '/api/avisos/:id/resultado', ['admin', 'bot'], async ({ params, body }) => {
  const d = await body();
  const aviso = await avisos.findOne({ _id: params.id });
  if (!aviso) throw fallo(404, 'El aviso no existe.');
  const intentosHechos = (aviso.intentos || 0) + 1;
  const estado = d.ok ? 'enviado' : intentosHechos >= 3 ? 'error' : 'pendiente';
  await avisos.updateOne({ _id: aviso._id }, { $set: { estado, intentos: intentosHechos, enviado: d.ok ? ahora().iso : null, detalle: texto(String(d.detalle ?? '')).slice(0, 300) } });
  return { estado: 200, datos: { msg: 'Resultado guardado.', estadoAviso: estado } };
});
ruta('POST', '/api/avisos/prueba', STAFF, async ({ body }) => {
  const d = await body();
  const telefono = R.normalizarTelefono(d.telefono);
  if (!telefono) throw fallo(400, 'Escribe un teléfono de 10 dígitos.');
  const id = 'prueba|' + Date.now();
  await crearAviso({ id, tipo: 'prueba', destinatario: 'prueba', telefono, texto: texto(d.texto).slice(0, 500) || 'Mensaje de prueba de Asistencia QR. Si lo lees, los avisos por WhatsApp funcionan.' });
  return { estado: 201, datos: { msg: 'Aviso de prueba en cola. n8n lo enviará en menos de un minuto.' } };
});

/* --- Datos de demostración (solo administrador) --- */
ruta('POST', '/api/demo', ['admin'], async ({ body }) => {
  const d = await body().catch(() => ({}));
  const telefono = R.normalizarTelefono(d.telefono);
  if (telefono === null) throw fallo(400, 'El teléfono debe tener 10 dígitos.');
  const demo = crearDatosDemo({ hoy: ahora().fecha, telefono, hash: S.hashClave, codigo: S.codigoAleatorio });
  // Se borra la demostración anterior para poder reiniciarla las veces que haga falta.
  const idsMaterias = (await materias.find({ demo: true }).toArray()).map(m => m._id);
  for (const id of idsMaterias) { await asistencias.deleteMany({ materiaId: id }); await clases.deleteMany({ materiaId: id }); await avisos.deleteMany({ materiaId: id }); await materias.deleteOne({ _id: id }); }
  for (const a of await alumnos.find({ demo: true }).toArray()) await alumnos.deleteOne({ _id: a._id });
  await usuarios.deleteOne({ _id: demo.maestro._id });
  await usuarios.insertOne(demo.maestro);
  for (const a of demo.alumnos) await alumnos.insertOne(a);
  for (const m of demo.materias) await materias.insertOne(m);
  for (const c of demo.clases) await clases.insertOne(c);
  for (const a of demo.asistencias) await asistencias.insertOne(a);
  return { estado: 201, datos: { msg: 'Datos de demostración cargados.', maestro: { usuario: demo.maestro._id, clave: demo.claveMaestro }, alumno: { usuario: 'D2024007', pin: demo.pin }, alumnos: demo.alumnos.length, materias: demo.materias.length } };
});

/* ---------- Servidor ---------- */
async function manejar(req, res) {
  const ruta_ = req.url.split('?')[0];
  const metodo = req.method;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; frame-ancestors 'none'");

  if (metodo === 'GET' && archivos.has(ruta_)) {
    const [archivo, tipo] = archivos.get(ruta_);
    const datos = await readFile(path.join(__dirname, archivo));
    // Las librerías de js/vendor no cambian: se pueden guardar un día. El resto se revalida siempre.
    const cache = archivo.startsWith('js/vendor/') ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': tipo + '; charset=utf-8', 'Cache-Control': cache });
    return res.end(datos);
  }
  if (metodo !== 'GET' && req.headers.origin && req.headers.origin !== (urlPublica || 'http://' + req.headers.host)) {
    return json(res, 403, { msg: 'Origen de solicitud inválido.' });
  }
  for (const r of rutas) {
    if (r.metodo !== metodo) continue;
    const encontrada = r.re.exec(ruta_);
    if (!encontrada) continue;
    const sesion = obtenerSesion(req);
    if (r.roles && (!sesion || !r.roles.includes(sesion.rol))) {
      return json(res, sesion ? 403 : 401, { msg: sesion ? 'No tienes permiso para esta acción.' : 'Inicia sesión para continuar.' });
    }
    const params = Object.fromEntries(Object.entries(encontrada.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    const resultado = await r.fn({ req, res, sesion, params, body: () => cuerpo(req) });
    return json(res, resultado.estado, resultado.datos);
  }
  return json(res, 404, { msg: 'Ruta no encontrada.' });
}

async function prepararIndices() {
  try {
    await asistencias.createIndex({ materiaId: 1, matricula: 1 });
    await asistencias.createIndex({ matricula: 1 });
    await clases.createIndex({ materiaId: 1 });
    await avisos.createIndex({ estado: 1, creado: 1 });
    await alumnos.createIndex({ codigo: 1 });
    await materias.createIndex({ inscritos: 1 });
  } catch (error) { console.error('No se pudieron crear los índices:', error.name); }
}

http.createServer((req, res) => {
  manejar(req, res).catch(error => {
    if (!error.estado) console.error('Error al procesar solicitud:', error.name, error.message);
    json(res, error.estado || 503, { msg: error.mensaje || 'No se pudo completar la operación. Verifica que MongoDB esté disponible.' });
  });
}).listen(puerto, enRender ? '0.0.0.0' : '127.0.0.1', () => {
  console.log('Asistencia QR: http://localhost:' + puerto);
  prepararIndices();
});
