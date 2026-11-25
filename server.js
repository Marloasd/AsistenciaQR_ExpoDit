const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { MongoClient } = require('mongodb');

const puerto = Number(process.env.PORT || 8000);
const enRender = process.env.RENDER === 'true';
const urlPublica = process.env.RENDER_EXTERNAL_URL;
const usuario = process.env.APP_USER || 'admin';
const clave = process.env.APP_PASSWORD;
if (enRender && (!clave || !process.env.MONGODB_URI || !urlPublica)) {
  throw new Error('Configura APP_PASSWORD y MONGODB_URI para iniciar en Render.');
}
const accesoEsperado = clave && Buffer.from('Basic ' + Buffer.from(usuario + ':' + clave).toString('base64'));

function accesoValido(authorization) {
  if (!accesoEsperado) return true;
  const enviado = Buffer.from(authorization || '');
  return enviado.length === accesoEsperado.length && timingSafeEqual(enviado, accesoEsperado);
}
const cliente = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017', {
  serverSelectionTimeoutMS: 3000
});
const alumnos = cliente.db(process.env.MONGODB_DB || 'asistencia_qr').collection('alumnos');
const archivos = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/css/style.css', ['css/style.css', 'text/css']],
  ...['db.js', 'app.js', 'qr.js', 'vendor/qrcode.min.js', 'vendor/html5-qrcode.min.js']
    .map(nombre => ['/js/' + nombre, ['js/' + nombre, 'text/javascript']])
]);

function json(res, estado, datos) {
  res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: estado < 400, ...datos }));
}

async function cuerpo(req) {
  if (req.headers['content-type'] !== 'application/json') {
    throw Object.assign(new Error(), { estado: 415, mensaje: 'Se requiere un cuerpo JSON.' });
  }
  const partes = [];
  let bytes = 0;
  for await (const parte of req) {
    bytes += parte.length;
    if (bytes <= 8192) partes.push(parte);
  }
  if (bytes > 8192) throw Object.assign(new Error(), { estado: 413, mensaje: 'Solicitud demasiado grande.' });
  try {
    return JSON.parse(Buffer.concat(partes).toString('utf8')) || {};
  } catch {
    throw Object.assign(new Error(), { estado: 400, mensaje: 'JSON inválido.' });
  }
}

// Render corre en UTC: sin zona horaria explícita, las asistencias después de las 18:00 (hora de Guadalajara) caían en el día siguiente.
const zona = process.env.APP_TZ || 'America/Mexico_City';
const formatoFecha = new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' });
const formatoHora = new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

const normalizar = valor => typeof valor === 'string' ? valor.trim().toUpperCase() : '';
const matriculaValida = /^[A-Z0-9]{4,15}$/;

async function manejar(req, res) {
  const ruta = req.url.split('?')[0];
  const metodo = req.method;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self)');
  // Render consulta esta ruta sin credenciales para saber si el servicio está vivo.
  if (ruta === '/healthz' && metodo === 'GET') return json(res, 200, { msg: 'ok' });
  if (!accesoValido(req.headers.authorization)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Asistencia QR", charset="UTF-8"');
    return json(res, 401, { msg: 'Ingresa el usuario y la contraseña del sitio.' });
  }
  if (metodo === 'GET' && archivos.has(ruta)) {
    const [archivo, tipo] = archivos.get(ruta);
    const datos = await readFile(path.join(__dirname, archivo));
    // Las librerías de js/vendor no cambian: se pueden guardar un día. El resto se revalida siempre.
    const cache = archivo.startsWith('js/vendor/') ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': tipo + '; charset=utf-8', 'Cache-Control': cache });
    return res.end(datos);
  }
  if (metodo !== 'GET' && req.headers.origin && req.headers.origin !== (urlPublica || 'http://' + req.headers.host)) {
    return json(res, 403, { msg: 'Origen de solicitud inválido.' });
  }
  if (ruta === '/api/alumnos' && metodo === 'GET') {
    const datos = await alumnos.find({}, { projection: { _id: 0, matricula: 1, nombre: 1, generacion: 1 } }).toArray();
    return json(res, 200, { datos });
  }
  if (ruta === '/api/alumnos' && metodo === 'POST') {
    const datos = await cuerpo(req);
    const matricula = normalizar(datos.matricula);
    const generacion = normalizar(datos.generacion);
    const nombre = typeof datos.nombre === 'string' ? datos.nombre.trim() : '';
    if (!matriculaValida.test(matricula)) return json(res, 400, { msg: 'La matrícula debe tener de 4 a 15 letras o números, sin espacios.' });
    if (!nombre || nombre.length > 150) return json(res, 400, { msg: 'Escribe un nombre de hasta 150 caracteres.' });
    if (!/^\d{4}[A-Z]$/.test(generacion)) return json(res, 400, { msg: 'Escribe la generación con cuatro números y una letra, por ejemplo 2026B.' });
    try {
      await alumnos.insertOne({ _id: matricula, matricula, nombre, generacion, asistencias: [] });
    } catch (error) {
      if (error.code === 11000) return json(res, 409, { msg: 'La matrícula ya está registrada.' });
      throw error;
    }
    return json(res, 201, { msg: 'Alumno registrado correctamente.' });
  }
  if (metodo === 'DELETE' && ruta.startsWith('/api/alumnos/')) {
    const matricula = ruta.slice('/api/alumnos/'.length);
    if (!matriculaValida.test(matricula)) return json(res, 400, { msg: 'Matrícula inválida.' });
    await alumnos.deleteOne({ _id: matricula });
    return json(res, 200, { msg: 'Alumno eliminado.' });
  }
  if (ruta === '/api/asistencias' && metodo === 'GET') {
    const datos = await alumnos.aggregate([
      { $unwind: '$asistencias' },
      { $project: { _id: 0, matricula: 1, nombre: 1, generacion: 1, fecha: '$asistencias.fecha', hora: '$asistencias.hora' } },
      { $sort: { fecha: 1, hora: 1, matricula: 1 } }
    ]).toArray();
    return json(res, 200, { datos });
  }
  if (ruta === '/api/asistencias' && metodo === 'POST') {
    const { texto } = await cuerpo(req);
    const matricula = normalizar(texto);
    if (!matriculaValida.test(matricula)) return json(res, 400, { msg: 'Escribe o escanea una matrícula válida.' });
    const ahora = new Date();
    const fecha = formatoFecha.format(ahora);
    const hora = formatoHora.format(ahora);
    const alumno = await alumnos.findOneAndUpdate(
      { _id: matricula, 'asistencias.fecha': { $ne: fecha } },
      { $push: { asistencias: { fecha, hora } } },
      { projection: { nombre: 1 } }
    );
    if (alumno) return json(res, 201, { msg: 'Asistencia registrada: ' + alumno.nombre + ' (' + hora + ')' });
    const existente = await alumnos.findOne({ _id: matricula }, { projection: { nombre: 1 } });
    if (!existente) return json(res, 404, { msg: 'La matrícula ' + matricula + ' no está registrada.' });
    return json(res, 409, { msg: existente.nombre + ' ya registró su asistencia hoy.' });
  }
  if (ruta === '/api/asistencias' && metodo === 'DELETE') {
    await alumnos.updateMany({}, { $set: { asistencias: [] } });
    return json(res, 200, { msg: 'Asistencias borradas.' });
  }
  return json(res, 404, { msg: 'Ruta no encontrada.' });
}

http.createServer((req, res) => {
  manejar(req, res).catch(error => {
    if (!error.estado) console.error('Error al procesar solicitud:', error.name);
    json(res, error.estado || 503, { msg: error.mensaje || 'No se pudo completar la operación. Verifica que MongoDB esté disponible.' });
  });
}).listen(puerto, enRender ? '0.0.0.0' : '127.0.0.1', () => {
  console.log('Asistencia QR: http://localhost:' + puerto);
});
