/* Arranque: acceso, menú según el rol y navegación entre vistas. */
let SESION = null;

const MENU = {
  admin: [['panel', 'Panel'], ['clase', 'Clase'], ['materias', 'Materias'], ['alumnos', 'Alumnos'], ['qr', 'Códigos QR'], ['reportes', 'Reportes'], ['avisos', 'Avisos'], ['admin', 'Administración']],
  maestro: [['panel', 'Panel'], ['clase', 'Clase'], ['materias', 'Materias'], ['alumnos', 'Alumnos'], ['qr', 'Códigos QR'], ['reportes', 'Reportes'], ['avisos', 'Avisos']],
  alumno: [['resumen', 'Mis materias'], ['miqr', 'Mi QR']]
};
const PINTAR = {
  panel: renderPanel, clase: renderClase, materias: renderMaterias, alumnos: renderAlumnos, qr: renderQR,
  reportes: renderReportes, avisos: renderAvisos, admin: renderAdmin, resumen: renderResumenAlumno, miqr: renderMiQR
};

function mostrar(vista) {
  document.querySelectorAll('main > .view').forEach(v => v.classList.toggle('active', v.id === 'view-' + vista));
  document.querySelectorAll('#menu button').forEach(b => b.classList.toggle('active', b.dataset.view === vista));
  if (vista !== 'clase') QR.detener().then(() => estadoCamara(false));
  try { sessionStorage.setItem('vista', vista); } catch { /* sin almacenamiento */ }
  if (PINTAR[vista]) PINTAR[vista]();
}

function mostrarLogin() {
  SESION = null;
  QR.detener();
  $('#menu').hidden = true; $('#usuario-actual').hidden = true;
  document.querySelectorAll('main > .view').forEach(v => v.classList.toggle('active', v.id === 'pantalla-login'));
  $('#pantalla-login').hidden = false;
  $('#login-clave').value = '';
}

function entrar(sesion) {
  SESION = sesion;
  $('#pantalla-login').hidden = true;
  $('#usuario-nombre').textContent = sesion.nombre + (sesion.rol === 'maestro' ? ' · maestro' : '');
  $('#usuario-actual').hidden = false;
  const opciones = MENU[sesion.rol];
  const menu = $('#menu');
  menu.replaceChildren(...opciones.map(([v, texto]) => el('button', { 'data-view': v, onclick: () => mostrar(v) }, texto)));
  menu.hidden = false;
  let inicial = opciones[0][0];
  try { const guardada = sessionStorage.getItem('vista'); if (opciones.some(([v]) => v === guardada)) inicial = guardada; } catch { /* sin almacenamiento */ }
  mostrar(inicial);
}

$('#form-login').onsubmit = async e => {
  e.preventDefault();
  const r = await DB.post('login', { usuario: $('#login-usuario').value, clave: $('#login-clave').value });
  mensaje($('#msg-login'), r.ok ? '' : r.msg, false);
  if (r.ok) { $('#login-usuario').value = ''; entrar({ usuario: r.usuario, nombre: r.nombre, rol: r.rol }); }
  else $('#login-clave').select();
};

$('#btn-salir').onclick = async () => {
  await DB.post('logout');
  try { sessionStorage.removeItem('vista'); } catch { /* sin almacenamiento */ }
  mostrarLogin();
};

DB.alExpirar = () => { if (SESION) { mostrarLogin(); mensaje($('#msg-login'), 'Tu sesión terminó. Inicia sesión de nuevo.', false); } };

(async function iniciar() {
  const r = await DB.get('sesion');
  if (r.ok) entrar({ usuario: r.usuario, nombre: r.nombre, rol: r.rol });
  else mostrarLogin();
})();
