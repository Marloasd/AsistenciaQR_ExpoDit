/* CONTROLADOR + VISTAS */
const $ = s => document.querySelector(s);

function mensaje(el, texto, ok) { el.textContent = texto; el.className = 'msg ' + (ok ? 'ok' : 'error'); }

function fila(tbody, celdas, accion) {
  const tr = document.createElement('tr');
  celdas.forEach(t => { const td = document.createElement('td'); td.textContent = t; tr.appendChild(td); });
  if (accion) {
    const td = document.createElement('td');
    const b = document.createElement('button');
    b.textContent = accion.texto; b.className = 'danger'; b.onclick = accion.fn;
    td.appendChild(b); tr.appendChild(td);
  }
  tbody.appendChild(tr);
}

/* ---------- Navegación ---------- */
function mostrar(vista) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + vista));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === vista));
  if (vista !== 'escaner') QR.detener();
  if (vista === 'alumnos') renderAlumnos();
  if (vista === 'qr') renderQR();
  if (vista === 'asistencias') renderAsistencias();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => mostrar(b.dataset.view));

/* ---------- Alumnos ---------- */
async function renderAlumnos() {
  const tbody = $('#tabla-alumnos');
  tbody.innerHTML = '';
  const respuesta = await DB.alumnos();
  if (!respuesta.ok) return mensaje($('#msg-alumno'), respuesta.msg, false);
  tbody.innerHTML = '';
  respuesta.datos.forEach(a => fila(tbody, [a.matricula, a.nombre, a.generacion], {
    texto: 'Eliminar',
    fn: async () => {
      if (!confirm('¿Eliminar a ' + a.nombre + ' y sus asistencias?')) return;
      const r = await DB.eliminarAlumno(a.matricula);
      mensaje($('#msg-alumno'), r.msg, r.ok);
      if (r.ok) renderAlumnos();
    }
  }));
}

$('#form-alumno').onsubmit = async e => {
  e.preventDefault();
  const r = await DB.agregarAlumno({ matricula: $('#matricula').value, nombre: $('#nombre').value, generacion: $('#generacion').value });
  mensaje($('#msg-alumno'), r.msg, r.ok);
  if (r.ok) { e.target.reset(); renderAlumnos(); }
};

/* ---------- Códigos QR ---------- */
async function renderQR() {
  const cont = $('#lista-qr');
  cont.innerHTML = '';
  const respuesta = await DB.alumnos();
  if (!respuesta.ok) { cont.textContent = respuesta.msg; return; }
  cont.innerHTML = '';
  const alumnos = respuesta.datos;
  if (!alumnos.length) { cont.textContent = 'Aún no hay alumnos registrados.'; return; }
  for (const a of alumnos) {
    const card = document.createElement('div'); card.className = 'card';
    const qr = document.createElement('div'); qr.className = 'qr';
    const n = document.createElement('strong'); n.textContent = a.nombre;
    const m = document.createElement('span'); m.textContent = a.matricula + ' · ' + a.generacion;
    const b = document.createElement('button'); b.textContent = 'Descargar PNG'; b.className = 'secondary';
    b.onclick = () => QR.descargar(qr, a.matricula);
    card.append(qr, n, m, b); cont.appendChild(card);
    try { await QR.dibujar(qr, a.matricula); }
    catch (err) { qr.textContent = err.message; }
  }
}

/* ---------- Escáner ---------- */
let ultimo = { texto: '', ts: 0 };
async function procesarLectura(texto) {
  const ahora = Date.now();
  if (texto === ultimo.texto && ahora - ultimo.ts < 3000) return; // evita lecturas repetidas
  ultimo = { texto, ts: ahora };
  const r = await DB.registrarAsistencia(texto);
  mensaje($('#msg-escaner'), r.msg, r.ok);
}

$('#btn-iniciar').onclick = async () => {
  try { await QR.iniciar(procesarLectura); mensaje($('#msg-escaner'), 'Cámara activa. Muestra el QR del alumno.', true); }
  catch (err) { mensaje($('#msg-escaner'), 'No se pudo abrir la cámara: ' + (err.message || err) + ' Usa el registro manual.', false); }
};
$('#btn-detener').onclick = () => QR.detener();
$('#form-manual').onsubmit = async e => {
  e.preventDefault();
  const r = await DB.registrarAsistencia($('#manual').value);
  mensaje($('#msg-escaner'), r.msg, r.ok);
  if (r.ok) e.target.reset();
};

/* ---------- Asistencias ---------- */
async function renderAsistencias() {
  const fecha = $('#filtro-fecha').value;
  const respuesta = await DB.registros();
  if (fecha !== $('#filtro-fecha').value) return;
  if (!respuesta.ok) return mensaje($('#msg-asistencias'), respuesta.msg, false);
  const regs = respuesta.datos.filter(r => !fecha || r.fecha === fecha);
  const tbody = $('#tabla-asistencias');
  tbody.innerHTML = '';
  regs.slice().reverse().forEach(r => fila(tbody, [r.fecha, r.hora, r.matricula, r.nombre, r.generacion]));
  $('#total-asistencias').textContent = 'Total de registros: ' + regs.length;
}
$('#filtro-fecha').onchange = renderAsistencias;
$('#btn-todas').onclick = () => { $('#filtro-fecha').value = ''; renderAsistencias(); };
$('#btn-limpiar').onclick = async () => { if (confirm('¿Borrar TODAS las asistencias?')) { const r = await DB.borrarAsistencias(); mensaje($("#msg-asistencias"), r.msg, r.ok); if (r.ok) renderAsistencias(); } };
$('#btn-csv').onclick = async () => {
  const respuesta = await DB.registros();
  if (!respuesta.ok) return mensaje($('#msg-asistencias'), respuesta.msg, false);
  const regs = respuesta.datos;
  const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
  const csv = ['Fecha,Hora,Matrícula,Nombre,Generación'].concat(regs.map(r => [r.fecha, r.hora, r.matricula, r.nombre, r.generacion].map(esc).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'asistencias_' + DB.hoy() + '.csv';
  a.click();
};

renderAlumnos();
