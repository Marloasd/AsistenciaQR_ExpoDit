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

before(async () => {
  proceso = spawn(process.execPath, ['--require', './test/mongo-falso.js', 'server.js'], {
    cwd: raiz,
    env: { ...process.env, PORT: String(puerto), TZ: 'UTC', APP_TZ: 'America/Mexico_City', APP_PASSWORD: 'clave-de-prueba' }
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/healthz'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('El servidor no arrancó.');
});
after(() => proceso.kill());

const acceso = { Authorization: 'Basic ' + Buffer.from('admin:clave-de-prueba').toString('base64') };

test('/healthz responde sin credenciales', async () => {
  const r = await api('/healthz');
  assert.equal(r.estado, 200);
});

test('exige usuario y contraseña', async () => {
  assert.equal((await api('/api/alumnos')).estado, 401);
  assert.equal((await api('/api/alumnos', 'GET', undefined, { Authorization: 'Basic ' + Buffer.from('admin:mala').toString('base64') })).estado, 401);
  assert.equal((await api('/api/alumnos', 'GET', undefined, acceso)).estado, 200);
});

test('valida los datos del alumno', async () => {
  const mal = [
    { matricula: 'A1', nombre: 'Ana', generacion: '2026B' },
    { matricula: 'A1234', nombre: '', generacion: '2026B' },
    { matricula: 'A1234', nombre: 'Ana', generacion: '26B' }
  ];
  for (const d of mal) assert.equal((await api('/api/alumnos', 'POST', d, acceso)).estado, 400);
});

test('registra alumno, rechaza duplicado y toma asistencia una vez al día', async () => {
  const alumno = { matricula: 'a1234', nombre: 'Ana Pérez', generacion: '2026b' };
  assert.equal((await api('/api/alumnos', 'POST', alumno, acceso)).estado, 201);
  assert.equal((await api('/api/alumnos', 'POST', alumno, acceso)).estado, 409);

  const primera = await api('/api/asistencias', 'POST', { texto: ' a1234 ' }, acceso);
  assert.equal(primera.estado, 201);
  assert.match(primera.cuerpo.msg, /Ana Pérez/);
  assert.equal((await api('/api/asistencias', 'POST', { texto: 'A1234' }, acceso)).estado, 409);
  assert.equal((await api('/api/asistencias', 'POST', { texto: 'ZZZ999' }, acceso)).estado, 404);
  assert.equal((await api('/api/asistencias', 'POST', { texto: '!!' }, acceso)).estado, 400);

  const lista = await api('/api/asistencias', 'GET', undefined, acceso);
  assert.equal(lista.cuerpo.datos.length, 1);
});

test('la fecha y la hora usan la zona de México aunque el servidor esté en UTC', async () => {
  const [{ fecha, hora }] = (await api('/api/asistencias', 'GET', undefined, acceso)).cuerpo.datos;
  const esperada = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  assert.equal(fecha, esperada);
  assert.match(hora, /^\d{2}:\d{2}:\d{2}$/);
});

test('rechaza peticiones de otro origen y cuerpos que no son JSON', async () => {
  assert.equal((await api('/api/asistencias', 'POST', { texto: 'A1234' }, { ...acceso, Origin: 'https://malo.example' })).estado, 403);
  const r = await fetch(base + '/api/alumnos', { method: 'POST', headers: { ...acceso, 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);
});

test('sirve la página con cabeceras de seguridad y caché para las librerías', async () => {
  const pagina = await fetch(base + '/', { headers: acceso });
  assert.equal(pagina.status, 200);
  assert.equal(pagina.headers.get('x-content-type-options'), 'nosniff');
  const lib = await fetch(base + '/js/vendor/html5-qrcode.min.js', { headers: acceso });
  assert.match(lib.headers.get('cache-control'), /max-age/);
});

test('elimina alumno y borra asistencias', async () => {
  assert.equal((await api('/api/asistencias', 'DELETE', undefined, acceso)).estado, 200);
  assert.equal((await api('/api/asistencias', 'GET', undefined, acceso)).cuerpo.datos.length, 0);
  assert.equal((await api('/api/alumnos/A1234', 'DELETE', undefined, acceso)).estado, 200);
  assert.equal((await api('/api/alumnos', 'GET', undefined, acceso)).cuerpo.datos.length, 0);
});
