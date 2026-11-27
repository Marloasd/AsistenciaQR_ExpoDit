const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const puerto = 18000 + Math.floor(Math.random() * 1000);
const base = 'http://127.0.0.1:' + puerto;
const raiz = path.join(__dirname, '..');
let proceso;

async function api(ruta, metodo = 'GET', datos, cabeceras = {}) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { ...(datos ? { 'Content-Type': 'application/json' } : {}), ...cabeceras },
    body: datos ? JSON.stringify(datos) : undefined
  });
  return { estado: r.status, cuerpo: await r.json().catch(() => null), cabeceras: r.headers };
}

async function entrar(usuario, clave) {
  const r = await api('/api/login', 'POST', { usuario, clave });
  assert.equal(r.estado, 200, 'login de ' + usuario + ': ' + JSON.stringify(r.cuerpo));
  return { Cookie: r.cabeceras.get('set-cookie').split(';')[0] };
}

before(async () => {
  proceso = spawn(process.execPath, ['--require', './test/mongo-falso.js', 'server.js'], {
    cwd: raiz,
    env: { ...process.env, PORT: String(puerto), TZ: 'UTC', APP_TZ: 'America/Mexico_City', APP_PASSWORD: 'clave-de-prueba', N8N_TOKEN: 'token-n8n' }
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/healthz'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('El servidor no arrancó.');
});
after(() => proceso.kill());

const hoyMexico = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
let admin, maestro, otro, alumna, codigoAna, codigoBeto;

test('/healthz responde sin credenciales y la página carga sin sesión', async () => {
  assert.equal((await api('/healthz')).estado, 200);
  const pagina = await fetch(base + '/');
  assert.equal(pagina.status, 200);
  assert.equal(pagina.headers.get('x-content-type-options'), 'nosniff');
  assert.match(pagina.headers.get('content-security-policy'), /default-src 'self'/);
  const lib = await fetch(base + '/js/vendor/html5-qrcode.min.js');
  assert.match(lib.headers.get('cache-control'), /max-age/);
});

test('la API exige sesión y el login rechaza claves malas', async () => {
  assert.equal((await api('/api/alumnos')).estado, 401);
  assert.equal((await api('/api/login', 'POST', { usuario: 'admin', clave: 'mala' }, { 'X-Forwarded-For': '10.0.0.1' })).estado, 401);
  admin = await entrar('admin', 'clave-de-prueba');
  const s = await api('/api/sesion', 'GET', undefined, admin);
  assert.deepEqual([s.cuerpo.usuario, s.cuerpo.rol], ['admin', 'admin']);
});

test('el administrador crea maestros y se validan los datos', async () => {
  assert.equal((await api('/api/maestros', 'POST', { usuario: 'ab', nombre: 'X', clave: '12345678' }, admin)).estado, 400);
  assert.equal((await api('/api/maestros', 'POST', { usuario: 'maria', nombre: 'María', clave: 'corta' }, admin)).estado, 400);
  assert.equal((await api('/api/maestros', 'POST', { usuario: 'maria', nombre: 'María Soto', clave: 'clave-maria-1' }, admin)).estado, 201);
  assert.equal((await api('/api/maestros', 'POST', { usuario: 'maria', nombre: 'María Soto', clave: 'clave-maria-1' }, admin)).estado, 409);
  assert.equal((await api('/api/maestros', 'POST', { usuario: 'pedro', nombre: 'Pedro Gil', clave: 'clave-pedro-1' }, admin)).estado, 201);
  maestro = await entrar('maria', 'clave-maria-1');
  otro = await entrar('pedro', 'clave-pedro-1');
  assert.equal((await api('/api/maestros', 'GET', undefined, maestro)).estado, 403);
});

test('registra alumnos con tutor, rechaza duplicados y datos inválidos', async () => {
  const ana = { matricula: 'a1001', nombre: 'Ana Pérez', generacion: '2026b', telefono: '33 1111 2222', tutor: { nombre: 'Rosa Pérez', telefono: '33 3333 4444' } };
  const r = await api('/api/alumnos', 'POST', ana, maestro);
  assert.equal(r.estado, 201);
  assert.match(r.cuerpo.pin, /^\d{4}$/);
  alumna = { usuario: 'A1001', pin: r.cuerpo.pin };
  assert.equal((await api('/api/alumnos', 'POST', ana, maestro)).estado, 409);
  assert.equal((await api('/api/alumnos', 'POST', { matricula: 'B2002', nombre: 'Beto Ruiz', generacion: '2026B' }, maestro)).estado, 201);
  assert.equal((await api('/api/alumnos', 'POST', { matricula: 'C3', nombre: 'X', generacion: '2026B' }, maestro)).estado, 400);
  assert.equal((await api('/api/alumnos', 'POST', { matricula: 'C3003', nombre: 'X', generacion: '26B' }, maestro)).estado, 400);
  assert.equal((await api('/api/alumnos', 'POST', { matricula: 'C3003', nombre: 'X', generacion: '2026B', tutor: { telefono: '123' } }, maestro)).estado, 400);
  const lista = (await api('/api/alumnos', 'GET', undefined, maestro)).cuerpo.datos;
  assert.equal(lista.length, 2);
  const a = lista.find(x => x.matricula === 'A1001');
  assert.equal(a.tutor.telefono, '5213333334444');
  assert.ok(!('pinHash' in a));
  codigoAna = a.codigo;
  codigoBeto = lista.find(x => x.matricula === 'B2002').codigo;
  assert.notEqual(codigoAna, 'A1001');
});

test('materias: crear, validar, separar por maestro e inscribir', async () => {
  assert.equal((await api('/api/materias', 'POST', { clave: 'x', nombre: 'Redes' }, maestro)).estado, 400);
  assert.equal((await api('/api/materias', 'POST', { clave: 'RED-A', nombre: 'Redes', clasesPlaneadas: 0 }, maestro)).estado, 400);
  const c = await api('/api/materias', 'POST', { clave: 'red-a', nombre: 'Redes', grupo: '5A', clasesPlaneadas: 10 }, maestro);
  assert.equal(c.estado, 201);
  assert.equal((await api('/api/materias', 'POST', { clave: 'RED-A', nombre: 'Otra', clasesPlaneadas: 10 }, otro)).estado, 409);
  const i = await api('/api/materias/RED-A/inscribir', 'POST', { matriculas: ['a1001', 'B2002', 'ZZZ999'] }, maestro);
  assert.equal(i.cuerpo.inscritos, 2);
  assert.deepEqual(i.cuerpo.noEncontradas, ['ZZZ999']);
  const mia = (await api('/api/materias', 'GET', undefined, maestro)).cuerpo.datos;
  assert.equal(mia.length, 1);
  assert.equal(mia[0].permitidas, 2, '20 % de 10 clases');
  assert.equal(mia[0].inscritos, 2);
  assert.equal((await api('/api/materias', 'GET', undefined, otro)).cuerpo.datos.length, 0);
  assert.equal((await api('/api/materias/RED-A/clases', 'GET', undefined, otro)).estado, 403);
  assert.equal((await api('/api/materias', 'GET', undefined, admin)).cuerpo.datos.length, 1);
});

test('asistencia por QR: el código del alumno funciona, no se repite y exige inscripción', async () => {
  await api('/api/alumnos', 'POST', { matricula: 'D4004', nombre: 'Dana Luna', generacion: '2026B' }, maestro);
  const ok = await api('/api/materias/RED-A/asistencia', 'POST', { texto: codigoAna }, maestro);
  assert.equal(ok.estado, 201);
  assert.match(ok.cuerpo.msg, /Ana Pérez/);
  assert.equal((await api('/api/materias/RED-A/asistencia', 'POST', { texto: 'a1001' }, maestro)).estado, 409, 'la matrícula también sirve y no se repite');
  assert.equal((await api('/api/materias/RED-A/asistencia', 'POST', { texto: 'D4004' }, maestro)).estado, 403);
  assert.equal((await api('/api/materias/RED-A/asistencia', 'POST', { texto: 'QQQQ9999' }, maestro)).estado, 404);
  assert.equal((await api('/api/materias/RED-A/asistencia', 'POST', { texto: '!!' }, maestro)).estado, 400);
  assert.equal((await api('/api/materias/RED-A/asistencia', 'POST', { texto: codigoBeto }, otro)).estado, 403);
});

test('la clase usa la fecha de México aunque el servidor esté en UTC', async () => {
  const clases = (await api('/api/materias/RED-A/clases', 'GET', undefined, maestro)).cuerpo.datos;
  assert.equal(clases[0].fecha, hoyMexico());
  assert.equal(clases[0].estado, 'abierta');
});

test('cerrar la clase marca faltas y deja avisos en la bandeja para n8n', async () => {
  const cierre = await api('/api/materias/RED-A/clases/hoy/cerrar', 'POST', {}, maestro);
  assert.equal(cierre.estado, 200);
  assert.equal(cierre.cuerpo.faltas, 1);
  assert.equal((await api('/api/materias/RED-A/clases/hoy/cerrar', 'POST', {}, maestro)).estado, 409);
  assert.equal((await api('/api/materias/RED-A/asistencia', 'POST', { texto: codigoBeto }, maestro)).estado, 409, 'ya cerrada');

  assert.equal((await api('/api/avisos/pendientes', 'GET', undefined, maestro)).estado, 403, 'solo n8n o el administrador');
  assert.equal((await api('/api/avisos/pendientes', 'GET', undefined, { Authorization: 'Bearer mal' })).estado, 401);
  const bot = { Authorization: 'Bearer token-n8n' };
  const pendientes = (await api('/api/avisos/pendientes', 'GET', undefined, bot)).cuerpo.datos;
  // Beto faltó y no tiene teléfonos: sus avisos quedan «omitidos», así que no hay pendientes.
  assert.equal(pendientes.length, 0);
  const vistos = (await api('/api/avisos', 'GET', undefined, maestro)).cuerpo.datos;
  assert.ok(vistos.length >= 1 && vistos.every(a => a.estado === 'omitido'));
});

test('aviso al tutor y al alumno con teléfono; n8n confirma el envío y los fallos se reintentan', async () => {
  const bot = { Authorization: 'Bearer token-n8n' };
  await api('/api/materias/RED-A/asistencia', 'PATCH', { matricula: 'A1001', fecha: '2026-01-05', estado: 'falta' }, maestro);
  // Falta de Ana en una clase ya cerrada: genera aviso de inmediato.
  await api('/api/materias/RED-A/asistencia', 'PATCH', { matricula: 'A1001', fecha: hoyMexico(), estado: 'falta' }, maestro);
  const pendientes = (await api('/api/avisos/pendientes', 'GET', undefined, bot)).cuerpo.datos;
  const aTutor = pendientes.find(a => a.tipo === 'falta');
  assert.equal(aTutor.telefono, '5213333334444');
  assert.match(aTutor.texto, /Ana Pérez no asistió a Redes/);
  assert.match(aTutor.texto, /2 faltas de 2 permitidas/);
  const aAlumno = pendientes.find(a => a.tipo === 'restantes');
  assert.equal(aAlumno.telefono, '5213311112222');
  assert.match(aAlumno.texto, /ya no te quedan faltas disponibles/);

  assert.equal((await api('/api/avisos/' + encodeURIComponent(aTutor.id) + '/resultado', 'POST', { ok: true, detalle: 'PENDING' }, bot)).cuerpo.estadoAviso, 'enviado');
  for (let i = 1; i <= 3; i++) {
    const r = await api('/api/avisos/' + encodeURIComponent(aAlumno.id) + '/resultado', 'POST', { ok: false, detalle: 'sin conexión' }, bot);
    assert.equal(r.cuerpo.estadoAviso, i < 3 ? 'pendiente' : 'error');
  }
  assert.equal((await api('/api/avisos/pendientes', 'GET', undefined, bot)).cuerpo.datos.length, 0);
});

test('los avisos no se duplican al repetir la misma falta', async () => {
  const antes = (await api('/api/avisos', 'GET', undefined, maestro)).cuerpo.datos.length;
  await api('/api/materias/RED-A/asistencia', 'PATCH', { matricula: 'A1001', fecha: hoyMexico(), estado: 'falta' }, maestro);
  assert.equal((await api('/api/avisos', 'GET', undefined, maestro)).cuerpo.datos.length, antes);
});

test('portal del alumno: ve sus faltas y no puede usar la API de maestros', async () => {
  assert.equal((await api('/api/login', 'POST', { usuario: 'A1001', clave: '0000x' }, { 'X-Forwarded-For': '10.0.0.2' })).estado, 401);
  const sesion = await entrar(alumna.usuario, alumna.pin);
  const yo = await api('/api/yo', 'GET', undefined, sesion);
  assert.equal(yo.cuerpo.alumno.codigo, codigoAna);
  const m = yo.cuerpo.materias[0];
  assert.equal(m.id, 'RED-A');
  assert.equal(m.resumen.faltas, 2);
  assert.equal(m.resumen.restantes, 0);
  assert.equal(m.resumen.estado, 'limite');
  assert.equal((await api('/api/alumnos', 'GET', undefined, sesion)).estado, 403);
  assert.equal((await api('/api/materias', 'GET', undefined, sesion)).estado, 403);
  assert.equal((await api('/api/yo', 'GET', undefined, maestro)).estado, 403);
});

test('justificar una falta devuelve la falta disponible y el reporte la refleja', async () => {
  await api('/api/materias/RED-A/asistencia', 'PATCH', { matricula: 'A1001', fecha: '2026-01-05', estado: 'justificada' }, maestro);
  const reporte = (await api('/api/materias/RED-A/reporte', 'GET', undefined, maestro)).cuerpo;
  const ana = reporte.alumnos.find(a => a.matricula === 'A1001');
  assert.equal(ana.resumen.faltas, 1);
  assert.equal(ana.resumen.justificadas, 1);
  assert.equal(ana.resumen.restantes, 1);
  assert.equal(ana.dias['2026-01-05'], 'justificada');
  assert.ok(reporte.fechas.includes('2026-01-05'));
  assert.equal((await api('/api/materias/RED-A/asistencia', 'PATCH', { matricula: 'A1001', estado: 'otra' }, maestro)).estado, 400);
});

test('retardos: tres equivalen a una falta', async () => {
  await api('/api/materias', 'POST', { clave: 'MAT-1', nombre: 'Matemáticas', clasesPlaneadas: 10 }, maestro);
  await api('/api/materias/MAT-1/inscribir', 'POST', { matriculas: ['B2002'] }, maestro);
  for (const f of ['2026-02-02', '2026-02-03', '2026-02-04']) await api('/api/materias/MAT-1/asistencia', 'PATCH', { matricula: 'B2002', fecha: f, estado: 'retardo' }, maestro);
  const r = (await api('/api/materias/MAT-1/reporte', 'GET', undefined, maestro)).cuerpo.alumnos[0].resumen;
  assert.deepEqual([r.retardos, r.equivalentes, r.restantes], [3, 1, 1]);
});

test('editar alumno, regenerar PIN y dar de baja', async () => {
  const e = await api('/api/alumnos/B2002', 'PUT', { nombre: 'Beto Ruiz Díaz', generacion: '2026B', tutor: { nombre: 'Luz Díaz', telefono: '3322221111' } }, maestro);
  assert.equal(e.estado, 200);
  const pin = (await api('/api/alumnos/B2002/pin', 'POST', {}, maestro)).cuerpo.pin;
  await entrar('B2002', pin);
  assert.equal((await api('/api/materias/RED-A/inscritos/B2002', 'DELETE', undefined, maestro)).estado, 200);
  assert.equal((await api('/api/alumnos/D4004', 'DELETE', undefined, maestro)).estado, 200);
  assert.equal((await api('/api/alumnos', 'GET', undefined, maestro)).cuerpo.datos.length, 2);
});

test('datos de demostración: solo el administrador, con semáforo variado', async () => {
  assert.equal((await api('/api/demo', 'POST', {}, maestro)).estado, 403);
  const d = await api('/api/demo', 'POST', { telefono: '3312345678' }, admin);
  assert.equal(d.estado, 201);
  assert.equal(d.cuerpo.alumnos, 14);
  const prof = await entrar(d.cuerpo.maestro.usuario, d.cuerpo.maestro.clave);
  const materias = (await api('/api/materias', 'GET', undefined, prof)).cuerpo.datos;
  const pw = materias.find(m => m.id === 'PW-A');
  assert.equal(pw.permitidas, 4);
  assert.equal(pw.impartidas, 10);
  assert.equal(pw.sinDerecho, 1);
  assert.ok(pw.enRiesgo >= 2);
  const yo = (await api('/api/yo', 'GET', undefined, await entrar(d.cuerpo.alumno.usuario, d.cuerpo.alumno.pin))).cuerpo;
  assert.equal(yo.materias.find(x => x.id === 'PW-A').resumen.estado, 'riesgo');
  // Reiniciar la demostración no duplica nada.
  assert.equal((await api('/api/demo', 'POST', {}, admin)).estado, 201);
  assert.equal((await api('/api/materias', 'GET', undefined, prof)).cuerpo.datos.length, 2);
});

test('cerrar una clase de la demostración manda avisos al teléfono indicado', async () => {
  await api('/api/demo', 'POST', { telefono: '3312345678' }, admin);
  const prof = await entrar('prof.demo', 'demo1234');
  const alumnos = (await api('/api/alumnos', 'GET', undefined, prof)).cuerpo.datos.filter(a => a.demo);
  for (const a of alumnos.slice(0, 12)) await api('/api/materias/PW-A/asistencia', 'POST', { texto: a.codigo }, prof);
  const cierre = await api('/api/materias/PW-A/clases/hoy/cerrar', 'POST', {}, prof);
  assert.equal(cierre.cuerpo.faltas, 2);
  const pend = (await api('/api/avisos/pendientes', 'GET', undefined, { Authorization: 'Bearer token-n8n' })).cuerpo.datos;
  assert.ok(pend.length >= 2 && pend.every(a => a.telefono === '5213312345678'));
});

test('rechaza otro origen, cuerpos que no son JSON y frena la adivinación de claves', async () => {
  assert.equal((await api('/api/materias', 'POST', { clave: 'X1', nombre: 'Algo' }, { ...maestro, Origin: 'https://malo.example' })).estado, 403);
  const r = await fetch(base + '/api/alumnos', { method: 'POST', headers: { ...maestro, 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);
  const cabecera = { 'X-Forwarded-For': '10.9.9.9' };
  for (let i = 0; i < 8; i++) assert.equal((await api('/api/login', 'POST', { usuario: 'admin', clave: 'x' + i }, cabecera)).estado, 401);
  assert.equal((await api('/api/login', 'POST', { usuario: 'admin', clave: 'clave-de-prueba' }, cabecera)).estado, 429);
});

test('cerrar sesión borra la cookie', async () => {
  const r = await api('/api/logout', 'POST', {}, admin);
  assert.match(r.cabeceras.get('set-cookie'), /Max-Age=0/);
});

test('reabrir la clase: quita las faltas del cierre, deja registrar a quien llegó y exige ser el dueño', async () => {
  assert.equal((await api('/api/materias', 'POST', { clave: 'MAT-I', nombre: 'Matemáticas I', grupo: '1A', clasesPlaneadas: 10 }, maestro)).estado, 201);
  await api('/api/materias/MAT-I/inscribir', 'POST', { matriculas: ['A1001', 'B2002'] }, maestro);
  assert.equal((await api('/api/materias/MAT-I/clases/hoy/reabrir', 'POST', {}, maestro)).estado, 404, 'aún no hay clase de hoy');
  assert.equal((await api('/api/materias/MAT-I/asistencia', 'POST', { texto: 'A1001' }, maestro)).estado, 201);
  assert.equal((await api('/api/materias/MAT-I/clases/hoy/reabrir', 'POST', {}, maestro)).estado, 409, 'una clase abierta no se reabre');
  assert.equal((await api('/api/materias/MAT-I/clases/hoy/cerrar', 'POST', {}, maestro)).cuerpo.faltas, 1);
  const cerrada = await api('/api/materias/MAT-I/asistencia', 'POST', { texto: 'B2002' }, maestro);
  assert.equal(cerrada.estado, 409);
  assert.match(cerrada.cuerpo.msg, /Reabrir clase/);

  assert.equal((await api('/api/materias/MAT-I/clases/hoy/reabrir', 'POST', {}, otro)).estado, 403, 'solo el maestro de la materia');
  const re = await api('/api/materias/MAT-I/clases/hoy/reabrir', 'POST', {}, maestro);
  assert.equal(re.estado, 200);
  assert.equal(re.cuerpo.faltasQuitadas, 1);
  const avisosBeto = (await api('/api/avisos', 'GET', undefined, maestro)).cuerpo.datos.filter(a => a.materiaId === 'MAT-I' && a.matricula === 'B2002');
  assert.equal(avisosBeto.length, 0, 'los avisos que no salieron se retiran');

  assert.equal((await api('/api/materias/MAT-I/asistencia', 'POST', { texto: 'B2002' }, maestro)).estado, 201, 'ahora sí se puede registrar');
  const cierre2 = await api('/api/materias/MAT-I/clases/hoy/cerrar', 'POST', {}, maestro);
  assert.equal(cierre2.cuerpo.faltas, 0);
  const rep = (await api('/api/materias/MAT-I/reporte', 'GET', undefined, maestro)).cuerpo;
  assert.equal(rep.alumnos.find(a => a.matricula === 'B2002').dias[rep.hoy], 'presente');
  assert.equal(rep.materia.claseHoy.estado, 'cerrada');
});

test('eliminar una materia borra sus clases y asistencias', async () => {
  assert.equal((await api('/api/materias/RED-A', 'DELETE', undefined, maestro)).estado, 200);
  assert.equal((await api('/api/materias/RED-A/clases', 'GET', undefined, maestro)).estado, 404);
});
