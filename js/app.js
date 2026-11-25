/* CONTROLADOR + VISTAS */
const $ = s => document.querySelector(s);

function mensaje(el, texto, ok) { el.textContent = texto; el.className = 'msg ' + (ok ? 'ok' : 'error'); }

let temporizadorToast;
function toast(texto, ok = true) {
  const t = $('#toast');
  t.textContent = texto;
  t.className = 'visible' + (ok ? '' : ' error');
  clearTimeout(temporizadorToast);
  temporizadorToast = setTimeout(() => { t.className = ''; }, 2600);
}

function fila(tbody, celdas, accion) {
  const tr = document.createElement('tr');
  celdas.forEach(t => {
    const td = document.createElement('td');
    if (t instanceof Node) td.appendChild(t); else td.textContent = t;
    tr.appendChild(td);
  });
  if (accion) {
    const td = document.createElement('td');
    td.className = 'acciones';
    [].concat(accion).forEach(a => {
      const b = document.createElement('button');
      b.textContent = a.texto; b.className = a.clase || 'danger'; b.onclick = a.fn;
      td.appendChild(b);
    });
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}

function etiqueta(texto, clase) {
  const s = document.createElement('span');
  s.className = 'etiqueta ' + clase; s.textContent = texto;
  return s;
}

/* ---------- Navegación ---------- */
function mostrar(vista) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + vista));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === vista));
  if (vista !== 'escaner') detenerCamara();
  if (vista === 'alumnos') renderAlumnos();
  if (vista === 'qr') renderQR();
  if (vista === 'asistencias') renderAsistencias();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => mostrar(b.dataset.view));

/* ---------- Alumnos ---------- */
let listaAlumnos = [];
let presentesHoy = new Set();

function pintarAlumnos() {
  const tbody = $('#tabla-alumnos');
  const q = $('#buscar').value.trim().toLowerCase();
  const soloFaltan = $('#solo-faltan').checked;
  const visibles = listaAlumnos.filter(a => (!q || a.nombre.toLowerCase().includes(q) || a.matricula.toLowerCase().includes(q)) && (!soloFaltan || !presentesHoy.has(a.matricula)));
  tbody.innerHTML = '';
  visibles.forEach(a => {
    const presente = presentesHoy.has(a.matricula);
    const acciones = [{
      texto: 'Eliminar',
      fn: async () => {
        if (!confirm('¿Eliminar a ' + a.nombre + ' y sus asistencias?')) return;
        const r = await DB.eliminarAlumno(a.matricula);
        mensaje($('#msg-alumno'), r.msg, r.ok);
        if (r.ok) renderAlumnos();
      }
    }];
    // Para quien olvidó su QR: se marca presente sin escanear.
    if (!presente) acciones.unshift({
      texto: 'Marcar presente', clase: 'secondary',
      fn: async () => {
        const r = await DB.registrarAsistencia(a.matricula);
        toast(r.msg, r.ok || r.estado === 409);
        renderAlumnos();
      }
    });
    fila(tbody, [a.matricula, a.nombre, a.generacion, presente ? etiqueta('Presente', 'ok') : etiqueta('Sin registro', 'no')], acciones);
  });
  const vacio = $('#vacio-alumnos');
  vacio.hidden = visibles.length > 0;
  vacio.textContent = !listaAlumnos.length ? 'Aún no hay alumnos. Registra el primero con el formulario de arriba.'
    : soloFaltan && !q ? '¡Todos los alumnos ya registraron su asistencia hoy!' : 'Ningún alumno coincide con la búsqueda.';
}

async function renderAlumnos() {
  const [respuesta, registros] = await Promise.all([DB.alumnos(), DB.registros()]);
  if (!respuesta.ok) return mensaje($('#msg-alumno'), respuesta.msg, false);
  listaAlumnos = respuesta.datos;
  const hoy = DB.hoy();
  presentesHoy = new Set(registros.ok ? registros.datos.filter(r => r.fecha === hoy).map(r => r.matricula) : []);
  const presentes = listaAlumnos.filter(a => presentesHoy.has(a.matricula)).length;
  $('#stat-alumnos').textContent = listaAlumnos.length;
  $('#stat-hoy').textContent = presentes;
  $('#stat-faltan').textContent = listaAlumnos.length - presentes;
  pintarAlumnos();
}
$('#buscar').oninput = pintarAlumnos;
$('#solo-faltan').onchange = pintarAlumnos;

/* Importar alumnos desde un CSV: matrícula,nombre,generación (con o sin fila de encabezado; separador coma o punto y coma). */
function leerCSV(texto) {
  return texto.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(linea => {
    const sep = linea.includes(';') && !linea.includes(',') ? ';' : ',';
    return linea.split(sep).map(c => c.trim().replace(/^"|"$/g, '').trim());
  }).filter(([m]) => !/^matr[ií]cula$/i.test(m));
}

$('#archivo-csv').onchange = async e => {
  const archivo = e.target.files[0];
  e.target.value = '';
  if (!archivo) return;
  const filas = leerCSV(await archivo.text());
  if (!filas.length) return mensaje($('#msg-alumno'), 'El archivo no tiene filas con alumnos.', false);
  if (filas.length > 500) return mensaje($('#msg-alumno'), 'Máximo 500 alumnos por archivo.', false);
  let creados = 0; const problemas = [];
  for (const [i, [matricula = '', nombre = '', generacion = '']] of filas.entries()) {
    mensaje($('#msg-alumno'), 'Importando ' + (i + 1) + ' de ' + filas.length + '…', true);
    const r = await DB.agregarAlumno({ matricula, nombre, generacion });
    if (r.ok) creados++; else problemas.push((matricula || '(vacía)') + ': ' + r.msg);
  }
  const resumen = creados + ' alumno(s) importado(s)' + (problemas.length ? ', ' + problemas.length + ' con error. ' + problemas.slice(0, 3).join(' · ') + (problemas.length > 3 ? ' …' : '') : '.');
  mensaje($('#msg-alumno'), resumen, !problemas.length);
  renderAlumnos();
};

$('#form-alumno').onsubmit = async e => {
  e.preventDefault();
  const r = await DB.agregarAlumno({ matricula: $('#matricula').value, nombre: $('#nombre').value, generacion: $('#generacion').value });
  mensaje($('#msg-alumno'), r.msg, r.ok);
  if (r.ok) { e.target.reset(); toast('Alumno registrado'); renderAlumnos(); $('#matricula').focus(); }
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
$('#btn-imprimir').onclick = () => window.print();

/* ---------- Escáner ---------- */
let ultimo = { texto: '', ts: 0 };
let audio;
let temporizadorResultado;

function pitido(ok) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = ok ? 880 : 300; g.gain.value = 0.08;
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + (ok ? 0.12 : 0.3));
  } catch { /* sin audio disponible */ }
  if (navigator.vibrate) navigator.vibrate(ok ? 60 : [80, 60, 80]);
}

function mostrarResultado(r) {
  const el = $('#resultado-escaneo');
  const tipo = r.ok ? 'ok' : (r.estado === 409 ? 'aviso' : 'error');
  el.textContent = (r.ok ? '✓ ' : r.estado === 409 ? 'ℹ ' : '✕ ') + r.msg;
  el.className = 'resultado ' + tipo;
  el.hidden = false;
  clearTimeout(temporizadorResultado);
  temporizadorResultado = setTimeout(() => { el.hidden = true; }, 3500);
  pitido(r.ok);
}

async function procesarLectura(texto) {
  const ahora = Date.now();
  if (texto === ultimo.texto && ahora - ultimo.ts < 3000) return; // evita lecturas repetidas
  ultimo = { texto, ts: ahora };
  const r = await DB.registrarAsistencia(texto);
  mostrarResultado(r);
  mensaje($('#msg-escaner'), r.msg, r.ok);
}

function estadoCamara(activa) {
  $('#btn-iniciar').disabled = activa; $('#btn-detener').disabled = !activa;
  if (!activa) { $('#btn-linterna').hidden = true; $('#btn-linterna').classList.remove('encendida'); }
}
async function detenerCamara() { await QR.detener(); estadoCamara(false); }

let apagarLinterna = null;
const camaraGuardada = () => { try { return localStorage.getItem('camaraId') || undefined; } catch { return undefined; } };

async function abrirCamara(camaraId) {
  estadoCamara(true);
  mensaje($('#msg-escaner'), 'Abriendo cámara… acepta el permiso si el navegador lo pide.', true);
  try {
    await QR.iniciar(procesarLectura, camaraId);
    mensaje($('#msg-escaner'), 'Cámara activa. Muestra el QR del alumno.', true);
    // Con el permiso ya concedido el navegador entrega los nombres de las cámaras.
    const camaras = await QR.camaras();
    const sel = $('#sel-camara');
    sel.hidden = camaras.length < 2;
    sel.innerHTML = '';
    camaras.forEach((c, i) => sel.add(new Option(c.label || 'Cámara ' + (i + 1), c.id)));
    if (camaraId && camaras.some(c => c.id === camaraId)) sel.value = camaraId;
    apagarLinterna = QR.linterna();
    $('#btn-linterna').hidden = !apagarLinterna;
  } catch (err) {
    estadoCamara(false);
    if (camaraId) { try { localStorage.removeItem('camaraId'); } catch { /* sin almacenamiento */ } }
    mensaje($('#msg-escaner'), 'No se pudo abrir la cámara: ' + (err.message || err) + ' Revisa el permiso del navegador, usa «Leer desde foto» o el registro manual.', false);
  }
}

$('#btn-iniciar').onclick = () => abrirCamara(camaraGuardada());
$('#btn-detener').onclick = detenerCamara;
$('#sel-camara').onchange = e => {
  try { localStorage.setItem('camaraId', e.target.value); } catch { /* sin almacenamiento */ }
  abrirCamara(e.target.value);
};
$('#btn-linterna').onclick = async e => {
  const encender = !e.target.classList.contains('encendida');
  try { await apagarLinterna(encender); e.target.classList.toggle('encendida', encender); }
  catch { toast('Este dispositivo no permite usar la linterna.', false); }
};
$('#archivo-qr').onchange = async e => {
  const archivo = e.target.files[0];
  e.target.value = '';
  if (!archivo) return;
  estadoCamara(false);
  mensaje($('#msg-escaner'), 'Leyendo la imagen…', true);
  try { await procesarLectura(await QR.leerImagen(archivo)); }
  catch { mensaje($('#msg-escaner'), 'No se encontró ningún QR en la imagen. Prueba con una foto más nítida y sin recortar los bordes.', false); }
};
$('#form-manual').onsubmit = async e => {
  e.preventDefault();
  const r = await DB.registrarAsistencia($('#manual').value);
  mostrarResultado(r);
  mensaje($('#msg-escaner'), r.msg, r.ok);
  if (r.ok) e.target.reset();
};

/* ---------- Asistencias ---------- */
async function renderAsistencias() {
  if (!$('#filtro-fecha').value && !renderAsistencias.iniciado) { $('#filtro-fecha').value = DB.hoy(); renderAsistencias.iniciado = true; }
  const fecha = $('#filtro-fecha').value;
  const respuesta = await DB.registros();
  if (fecha !== $('#filtro-fecha').value) return;
  if (!respuesta.ok) return mensaje($('#msg-asistencias'), respuesta.msg, false);
  const regs = respuesta.datos.filter(r => !fecha || r.fecha === fecha);
  const tbody = $('#tabla-asistencias');
  tbody.innerHTML = '';
  regs.slice().reverse().forEach(r => fila(tbody, [r.fecha, r.hora, r.matricula, r.nombre, r.generacion]));
  $('#vacio-asistencias').hidden = regs.length > 0;
  $('#total-asistencias').textContent = 'Total de registros: ' + regs.length;
}
$('#filtro-fecha').onchange = renderAsistencias;
$('#btn-hoy').onclick = () => { $('#filtro-fecha').value = DB.hoy(); renderAsistencias(); };
$('#btn-todas').onclick = () => { $('#filtro-fecha').value = ''; renderAsistencias(); };
$('#btn-limpiar').onclick = async () => { if (confirm('¿Borrar TODAS las asistencias?')) { const r = await DB.borrarAsistencias(); mensaje($("#msg-asistencias"), r.msg, r.ok); if (r.ok) renderAsistencias(); } };
$('#btn-csv').onclick = async () => {
  const respuesta = await DB.registros();
  if (!respuesta.ok) return mensaje($('#msg-asistencias'), respuesta.msg, false);
  const regs = respuesta.datos;
  const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
  const csv = ['Fecha,Hora,Matrícula,Nombre,Generación'].concat(regs.map(r => [r.fecha, r.hora, r.matricula, r.nombre, r.generacion].map(esc).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'asistencias_' + DB.hoy() + '.csv';
  a.click();
};

renderAlumnos();
