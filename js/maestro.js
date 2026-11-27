/* Vistas del maestro y del administrador: panel, clase, materias, alumnos, QR, reportes, avisos y administración. */

let materias = [];          // materias visibles para el usuario (con sus indicadores)
let materiaSel = null;      // materia elegida en «Clase» y «Reportes»
let listaAlumnos = [];

const esAdmin = () => SESION && SESION.rol === 'admin';

async function cargarMaterias() {
  const r = await DB.get('materias');
  if (!r.ok) { toast(r.msg, false); return false; }
  materias = r.datos;
  if (!materias.some(m => m.id === materiaSel)) materiaSel = materias.length ? materias[0].id : null;
  return true;
}

function llenarSelectMaterias(select) {
  select.replaceChildren(...materias.map(m => el('option', { value: m.id }, m.nombre + (m.grupo ? ' · ' + m.grupo : '') + (esAdmin() ? ' (' + m.maestro + ')' : ''))));
  if (materiaSel) select.value = materiaSel;
  select.disabled = !materias.length;
}

function irA(vista, materiaId) {
  if (materiaId) materiaSel = materiaId;
  mostrar(vista);
}

const cancelarSiVacio = (nodo, hay, texto) => { nodo.hidden = hay; if (texto) nodo.textContent = texto; };

/* ---------- Panel ---------- */
async function renderPanel() {
  if (!(await cargarMaterias())) return;
  const sum = campo => materias.reduce((t, m) => t + m[campo], 0);
  $('#panel-stats').replaceChildren(
    el('div', { class: 'stat' }, el('span', {}, materias.length), el('small', {}, 'Materias')),
    el('div', { class: 'stat' }, el('span', {}, sum('inscritos')), el('small', {}, 'Inscripciones')),
    el('div', { class: 'stat warn' }, el('span', {}, sum('enRiesgo')), el('small', {}, 'Alumnos en riesgo')),
    el('div', { class: 'stat bad' }, el('span', {}, sum('sinDerecho')), el('small', {}, 'Sin derecho a ordinario')));
  $('#panel-materias').replaceChildren(...materias.map(m => {
    const hoy = m.claseHoy ? (m.claseHoy.estado === 'cerrada' ? 'Clase de hoy cerrada' : 'Clase de hoy abierta · ' + m.claseHoy.presentes + ' presentes') : 'Hoy aún sin pase de lista';
    return el('article', { class: 'materia' },
      el('h3', {}, m.nombre),
      el('small', {}, m.clave + (m.grupo ? ' · ' + m.grupo : '') + (m.horaInicio ? ' · ' + m.horaInicio + ' h' : '') + (esAdmin() ? ' · ' + m.maestro : '')),
      el('div', { class: 'progreso' }, el('span', {}, 'Clases: ' + m.impartidas + ' de ' + m.clasesPlaneadas), el('div', { class: 'barra-fondo' }, el('div', { class: 'barra-relleno b-ok', style: 'width:' + Math.min(100, Math.round(100 * m.impartidas / m.clasesPlaneadas)) + '%' }))),
      el('div', { class: 'chips' }, etiqueta(m.inscritos + ' alumnos', 'e-neutro'), etiqueta(m.enRiesgo + ' en riesgo', m.enRiesgo ? 'e-riesgo' : 'e-neutro'), etiqueta(m.sinDerecho + ' sin derecho', m.sinDerecho ? 'e-sin_derecho' : 'e-neutro')),
      el('p', { class: 'hint' }, hoy + ' · máximo ' + m.permitidas + ' faltas'),
      el('div', { class: 'toolbar' }, el('button', { onclick: () => irA('clase', m.id) }, 'Tomar asistencia'), el('button', { class: 'secondary', onclick: () => irA('reportes', m.id) }, 'Ver reporte')));
  }));
  cancelarSiVacio($('#vacio-panel'), materias.length, esAdmin()
    ? 'Aún no hay materias. Crea una en «Materias» o carga los datos de demostración en «Administración».'
    : 'Aún no tienes materias. Crea la primera en «Materias».');
}

/* ---------- Clase: escáner y lista de hoy ---------- */
let ultimo = { texto: '', ts: 0 };
let audio, temporizadorResultado, apagarLinterna = null;
let datosClase = null;

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
  const nodo = $('#resultado-escaneo');
  const aviso_ = !r.ok && (r.estado === 409 || r.estado === 403);
  nodo.textContent = (r.ok ? '✓ ' : aviso_ ? 'ℹ ' : '✕ ') + r.msg;
  nodo.className = 'resultado ' + (r.ok ? 'ok' : aviso_ ? 'aviso' : 'error');
  nodo.hidden = false;
  clearTimeout(temporizadorResultado);
  temporizadorResultado = setTimeout(() => { nodo.hidden = true; }, 3500);
  pitido(r.ok);
}

async function registrarLectura(texto) {
  if (!materiaSel) return { ok: false, estado: 0, msg: 'Primero crea o elige una materia.' };
  const r = await DB.post('materias/' + encodeURIComponent(materiaSel) + '/asistencia', { texto });
  mostrarResultado(r);
  mensaje($('#msg-escaner'), r.msg, r.ok);
  if (r.ok) refrescarClase();
  return r;
}

async function procesarLectura(texto) {
  const ahora = Date.now();
  if (texto === ultimo.texto && ahora - ultimo.ts < 3000) return; // evita lecturas repetidas
  ultimo = { texto, ts: ahora };
  await registrarLectura(texto);
}

function estadoCamara(activa) {
  $('#btn-iniciar').disabled = activa; $('#btn-detener').disabled = !activa;
  if (!activa) { $('#btn-linterna').hidden = true; $('#btn-linterna').classList.remove('encendida'); }
}
async function detenerCamara() { await QR.detener(); estadoCamara(false); }

const camaraGuardada = () => { try { return localStorage.getItem('camaraId') || undefined; } catch { return undefined; } };

async function abrirCamara(camaraId) {
  estadoCamara(true);
  mensaje($('#msg-escaner'), 'Abriendo cámara… acepta el permiso si el navegador lo pide.', true);
  try {
    await QR.iniciar(procesarLectura, camaraId);
    mensaje($('#msg-escaner'), 'Cámara activa. Muestra el QR del alumno.', true);
    const camaras = await QR.camaras();
    const sel = $('#sel-camara');
    sel.hidden = camaras.length < 2;
    sel.replaceChildren(...camaras.map((c, i) => el('option', { value: c.id }, c.label || 'Cámara ' + (i + 1))));
    if (camaraId && camaras.some(c => c.id === camaraId)) sel.value = camaraId;
    apagarLinterna = QR.linterna();
    $('#btn-linterna').hidden = !apagarLinterna;
  } catch (err) {
    estadoCamara(false);
    if (camaraId) { try { localStorage.removeItem('camaraId'); } catch { /* sin almacenamiento */ } }
    mensaje($('#msg-escaner'), 'No se pudo abrir la cámara: ' + (err.message || err) + ' Revisa el permiso del navegador, usa «Leer desde foto» o escribe la matrícula.', false);
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
  const r = await registrarLectura($('#manual').value);
  if (r.ok) e.target.reset();
};

async function renderClase() {
  if (!(await cargarMaterias())) return;
  llenarSelectMaterias($('#clase-materia'));
  await refrescarClase();
}
$('#clase-materia').onchange = e => { materiaSel = e.target.value; refrescarClase(); };

const BOTONES_ESTADO = [['presente', '✓', 'Presente'], ['retardo', 'R', 'Retardo'], ['falta', 'F', 'Falta'], ['justificada', 'J', 'Justificada']];

async function cambiarEstado(matricula, estado) {
  const r = await DB.patch('materias/' + encodeURIComponent(materiaSel) + '/asistencia', { matricula, estado });
  if (!r.ok) toast(r.msg, false);
  refrescarClase();
}

async function refrescarClase() {
  const tbody = $('#tabla-clase');
  tbody.replaceChildren();
  $('#clase-resumen').replaceChildren();
  $('#btn-cerrar-clase').disabled = !materiaSel;
  if (!materiaSel) { $('#clase-info').textContent = 'No hay materias: créalas primero.'; $('#vacio-clase').hidden = true; return; }
  const r = await DB.get('materias/' + encodeURIComponent(materiaSel) + '/reporte');
  if (!r.ok) { mensaje($('#msg-escaner'), r.msg, false); return; }
  datosClase = r;
  const m = r.materia, cerrada = m.claseHoy && m.claseHoy.estado === 'cerrada';
  $('#clase-info').textContent = m.clave + ' · ' + m.inscritos + ' alumnos · máximo ' + m.permitidas + ' faltas' + (m.horaInicio ? ' · inicia ' + m.horaInicio : '');
  $('#btn-cerrar-clase').disabled = !cerrada && !m.inscritos;
  $('#btn-cerrar-clase').textContent = cerrada ? 'Reabrir clase' : 'Cerrar clase';
  $('#btn-cerrar-clase').className = cerrada ? 'secondary' : 'danger';
  $('#btn-siguiente-clase').hidden = !cerrada;
  const numeroClase = (m.claseHoy && m.claseHoy.numero) || 1;
  const textoClase = (numeroClase > 1 ? 'Clase ' + numeroClase + ' de hoy ' : 'Clase ') + (cerrada ? 'cerrada' : 'abierta');
  const estadoDe = a => a.dias[r.hoy] || null;
  const cuenta = e => r.alumnos.filter(a => estadoDe(a) === e).length;
  const pendientes = r.alumnos.filter(a => !estadoDe(a)).length;
  $('#clase-resumen').replaceChildren(
    etiqueta(cuenta('presente') + ' presentes', 'e-ok'), etiqueta(cuenta('retardo') + ' retardos', 'e-riesgo'),
    etiqueta(cuenta('falta') + ' faltas', cuenta('falta') ? 'e-sin_derecho' : 'e-neutro'), etiqueta(cuenta('justificada') + ' justificadas', 'e-neutro'),
    etiqueta(pendientes + ' sin registro', pendientes ? 'e-limite' : 'e-neutro'), etiqueta(textoClase, cerrada ? 'e-neutro' : 'e-ok'));
  $('#vacio-clase').hidden = r.alumnos.length > 0;
  r.alumnos.forEach(a => {
    const est = estadoDe(a);
    tbody.append(el('tr', {},
      el('td', {}, el('strong', {}, a.nombre), el('br'), el('small', {}, a.matricula)),
      el('td', {}, est ? etiqueta(ETIQUETA_ASISTENCIA[est], 'a-' + est) : etiqueta('Sin registro', 'e-neutro')),
      el('td', {}, etiquetaEstado(a.resumen.estado), el('br'), el('small', {}, a.resumen.equivalentes + '/' + a.resumen.permitidas)),
      el('td', { class: 'acciones' }, BOTONES_ESTADO.map(([valor, letra, nombre]) =>
        el('button', { class: 'mini ' + (est === valor ? 'activo' : 'secondary'), title: nombre, 'aria-label': nombre + ': ' + a.nombre, onclick: () => cambiarEstado(a.matricula, valor) }, letra)))));
  });
}

$('#btn-cerrar-clase').onclick = async () => {
  if (!datosClase) return;
  if (datosClase.materia.claseHoy && datosClase.materia.claseHoy.estado === 'cerrada') {
    if (!confirm('Se quitarán las faltas que se pusieron automáticamente al cerrar y podrás registrar a quien falte. Los avisos de WhatsApp que ya se enviaron no se pueden retirar. ¿Reabrir la clase?')) return;
    const re = await DB.post('materias/' + encodeURIComponent(materiaSel) + '/clases/hoy/reabrir');
    toast(re.msg, re.ok);
    refrescarClase();
    return;
  }
  const pendientes = datosClase.alumnos.filter(a => !a.dias[datosClase.hoy]).length;
  if (!confirm('Se marcará falta a ' + pendientes + ' alumno(s) sin registro y se enviarán los avisos por WhatsApp. ¿Cerrar la clase?')) return;
  await DB.post('materias/' + encodeURIComponent(materiaSel) + '/clases');
  const r = await DB.post('materias/' + encodeURIComponent(materiaSel) + '/clases/hoy/cerrar');
  toast(r.ok ? r.msg + (r.avisos ? ' · ' + r.avisos + ' aviso(s) en cola' : '') : r.msg, r.ok);
  await detenerCamara();
  refrescarClase();
};

$('#btn-siguiente-clase').onclick = async () => {
  if (!materiaSel) return;
  if (!confirm('Se empieza una clase nueva, sin registros. Lo registrado en la clase anterior (asistencias y faltas) se conserva. ¿Empezar la siguiente clase?')) return;
  const r = await DB.post('materias/' + encodeURIComponent(materiaSel) + '/clases/siguiente');
  toast(r.msg, r.ok);
  refrescarClase();
};

/* ---------- Materias ---------- */
let editandoMateria = null;

function limpiarFormMateria() {
  editandoMateria = null;
  $('#form-materia').reset();
  $('#mat-clave').disabled = false;
  $('#mat-clases').value = 40; $('#mat-porcentaje').value = 20;
  $('#titulo-form-materia').textContent = 'Nueva materia';
  $('#btn-guardar-materia').textContent = 'Crear materia';
  $('#btn-cancelar-materia').hidden = true;
}

async function renderMaterias() {
  $('#campo-maestro').hidden = !esAdmin();
  if (esAdmin()) {
    const r = await DB.get('maestros');
    const opciones = [[SESION.usuario, 'Administrador (yo)'], ...(r.ok ? r.datos.map(u => [u.usuario, u.nombre + ' (' + u.usuario + ')']) : [])];
    $('#mat-maestro').replaceChildren(...opciones.map(([v, t]) => el('option', { value: v }, t)));
  }
  if (!(await cargarMaterias())) return;
  const tbody = $('#tabla-materias');
  tbody.replaceChildren(...materias.map(m => el('tr', {},
    el('td', {}, m.clave), el('td', {}, el('strong', {}, m.nombre), esAdmin() ? el('br') : null, esAdmin() ? el('small', {}, m.maestro) : null),
    el('td', {}, m.grupo), el('td', {}, m.permitidas + ' de ' + m.clasesPlaneadas + ' (' + m.porcentajeFaltas + ' %)'), el('td', {}, m.inscritos),
    el('td', { class: 'acciones' },
      el('button', { onclick: () => abrirInscritos(m.id) }, 'Alumnos'),
      el('button', { class: 'secondary', onclick: () => editarMateria(m) }, 'Editar'),
      el('button', { class: 'danger', onclick: async () => {
        if (!confirm('¿Eliminar «' + m.nombre + '» con todas sus clases y asistencias? No se puede deshacer.')) return;
        const r2 = await DB.borrar('materias/' + encodeURIComponent(m.id));
        mensaje($('#msg-materia'), r2.msg, r2.ok);
        if (r2.ok) { $('#panel-inscritos').hidden = true; renderMaterias(); }
      } }, 'Eliminar')))));
  $('#vacio-materias').hidden = materias.length > 0;
}

function editarMateria(m) {
  editandoMateria = m.id;
  $('#mat-clave').value = m.clave; $('#mat-clave').disabled = true;
  $('#mat-nombre').value = m.nombre; $('#mat-grupo').value = m.grupo; $('#mat-hora').value = m.horaInicio;
  $('#mat-clases').value = m.clasesPlaneadas; $('#mat-porcentaje').value = m.porcentajeFaltas;
  if (esAdmin()) $('#mat-maestro').value = m.maestro;
  $('#titulo-form-materia').textContent = 'Editar materia';
  $('#btn-guardar-materia').textContent = 'Guardar cambios';
  $('#btn-cancelar-materia').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#btn-cancelar-materia').onclick = limpiarFormMateria;

$('#form-materia').onsubmit = async e => {
  e.preventDefault();
  const datos = {
    clave: $('#mat-clave').value, nombre: $('#mat-nombre').value, grupo: $('#mat-grupo').value, horaInicio: $('#mat-hora').value,
    clasesPlaneadas: Number($('#mat-clases').value), porcentajeFaltas: Number($('#mat-porcentaje').value)
  };
  if (esAdmin()) datos.maestro = $('#mat-maestro').value;
  const r = editandoMateria ? await DB.put('materias/' + encodeURIComponent(editandoMateria), datos) : await DB.post('materias', datos);
  mensaje($('#msg-materia'), r.msg, r.ok);
  if (r.ok) { toast(r.msg); limpiarFormMateria(); renderMaterias(); }
};

/* Panel para inscribir y dar de baja alumnos de una materia. */
let inscritosActual = null;

async function abrirInscritos(id) {
  inscritosActual = id;
  $('#panel-inscritos').hidden = false;
  await refrescarInscritos();
  $('#panel-inscritos').scrollIntoView({ behavior: 'smooth' });
}

async function refrescarInscritos() {
  const [rep, todos] = await Promise.all([DB.get('materias/' + encodeURIComponent(inscritosActual) + '/reporte'), DB.get('alumnos')]);
  if (!rep.ok || !todos.ok) return mensaje($('#msg-inscritos'), (rep.ok ? todos : rep).msg, false);
  listaAlumnos = todos.datos;
  $('#titulo-inscritos').textContent = 'Alumnos de ' + rep.materia.nombre + ' (' + rep.alumnos.length + ')';
  $('#lista-inscritos').replaceChildren(...rep.alumnos.map(a => el('li', {},
    el('span', {}, a.nombre, el('small', {}, ' ' + a.matricula)),
    el('button', { class: 'mini danger', title: 'Dar de baja', onclick: async () => {
      if (!confirm('¿Dar de baja a ' + a.nombre + ' de esta materia? Se borran sus asistencias en ella.')) return;
      const r = await DB.borrar('materias/' + encodeURIComponent(inscritosActual) + '/inscritos/' + encodeURIComponent(a.matricula));
      toast(r.msg, r.ok); refrescarInscritos();
    } }, '✕'))));
  const dentro = new Set(rep.alumnos.map(a => a.matricula));
  pintarDisponibles(dentro);
  $('#buscar-inscribir').oninput = () => pintarDisponibles(dentro);
}

function pintarDisponibles(dentro) {
  const q = $('#buscar-inscribir').value.trim().toLowerCase();
  const marcados = new Set([...document.querySelectorAll('#lista-disponibles input:checked')].map(i => i.value));
  const libres = listaAlumnos.filter(a => !dentro.has(a.matricula) && (!q || a.nombre.toLowerCase().includes(q) || a.matricula.toLowerCase().includes(q)));
  $('#lista-disponibles').replaceChildren(...(libres.length ? libres.map(a => el('li', {},
    el('label', {}, el('input', { type: 'checkbox', value: a.matricula, checked: marcados.has(a.matricula) }), ' ' + a.nombre, el('small', {}, ' ' + a.matricula))))
    : [el('li', { class: 'vacio' }, listaAlumnos.length ? 'No hay alumnos por inscribir.' : 'Primero registra alumnos en «Alumnos».')]));
}

$('#btn-inscribir').onclick = async () => {
  const matriculas = [...document.querySelectorAll('#lista-disponibles input:checked')].map(i => i.value);
  if (!matriculas.length) return mensaje($('#msg-inscritos'), 'Marca al menos un alumno.', false);
  const r = await DB.post('materias/' + encodeURIComponent(inscritosActual) + '/inscribir', { matriculas });
  mensaje($('#msg-inscritos'), r.msg, r.ok);
  refrescarInscritos();
};
$('#btn-cerrar-inscritos').onclick = () => { $('#panel-inscritos').hidden = true; renderMaterias(); };

/* ---------- Alumnos ---------- */
const tutorOk = a => a.tutor && a.tutor.telefono;

function pintarAlumnos() {
  const q = $('#buscar').value.trim().toLowerCase();
  const visibles = listaAlumnos.filter(a => !q || a.nombre.toLowerCase().includes(q) || a.matricula.toLowerCase().includes(q));
  $('#tabla-alumnos').replaceChildren(...visibles.map(a => el('tr', {},
    el('td', {}, a.matricula), el('td', {}, a.nombre, a.demo ? el('small', {}, ' · demo') : null), el('td', {}, a.generacion),
    el('td', {}, tutorOk(a) ? etiqueta('WhatsApp ✓', 'e-ok') : etiqueta('Sin teléfono', 'e-neutro')),
    el('td', { class: 'acciones' },
      el('button', { onclick: () => ampliar(a) }, 'Ver QR'),
      el('button', { class: 'secondary', onclick: () => abrirEdicion(a) }, 'Editar'),
      el('button', { class: 'secondary', onclick: async () => {
        if (!confirm('¿Generar un PIN nuevo para ' + a.nombre + '? El anterior dejará de servir.')) return;
        const r = await DB.post('alumnos/' + encodeURIComponent(a.matricula) + '/pin');
        if (r.ok) mostrarPin(a, r.pin); else toast(r.msg, false);
      } }, 'PIN'),
      el('button', { class: 'danger', onclick: async () => {
        if (!confirm('¿Eliminar a ' + a.nombre + ' y todas sus asistencias?')) return;
        const r = await DB.borrar('alumnos/' + encodeURIComponent(a.matricula));
        mensaje($('#msg-alumno'), r.msg, r.ok);
        if (r.ok) renderAlumnos();
      } }, 'Eliminar')))));
  $('#vacio-alumnos').hidden = visibles.length > 0;
  $('#vacio-alumnos').textContent = listaAlumnos.length ? 'Ningún alumno coincide con la búsqueda.' : 'Aún no hay alumnos. Registra el primero con el formulario de arriba.';
}

async function renderAlumnos() {
  const r = await DB.get('alumnos');
  if (!r.ok) return mensaje($('#msg-alumno'), r.msg, false);
  listaAlumnos = r.datos;
  pintarAlumnos();
}
$('#buscar').oninput = pintarAlumnos;

function mostrarPin(alumno, pin) {
  aviso('PIN de ' + alumno.nombre, [
    'El alumno entra con su matrícula (' + alumno.matricula + ') y este PIN:',
    el('p', { class: 'pin' }, pin),
    'Anótalo ahora: por seguridad no se vuelve a mostrar (si se pierde, genera uno nuevo).'
  ]);
}

$('#form-alumno').onsubmit = async e => {
  e.preventDefault();
  const a = { matricula: $('#matricula').value, nombre: $('#nombre').value, generacion: $('#generacion').value, telefono: $('#alumno-tel').value, tutor: { nombre: $('#tutor-nombre').value, telefono: $('#tutor-tel').value } };
  const r = await DB.post('alumnos', a);
  mensaje($('#msg-alumno'), r.msg, r.ok);
  if (r.ok) { e.target.reset(); mostrarPin({ nombre: a.nombre, matricula: a.matricula.trim().toUpperCase() }, r.pin); renderAlumnos(); $('#matricula').focus(); }
};

/* Edición en un cuadro de diálogo. */
let editandoAlumno = null;
function abrirEdicion(a) {
  editandoAlumno = a.matricula;
  $('#ed-matricula').value = a.matricula; $('#ed-nombre').value = a.nombre; $('#ed-generacion').value = a.generacion;
  $('#ed-tutor-nombre').value = a.tutor.nombre; $('#ed-tutor-tel').value = a.tutor.telefono ? a.tutor.telefono.slice(-10) : '';
  $('#ed-alumno-tel').value = a.telefono ? a.telefono.slice(-10) : '';
  $('#msg-editar').textContent = '';
  $('#dlg-alumno').showModal();
}
$('#ed-cancelar').onclick = () => $('#dlg-alumno').close();
$('#form-editar-alumno').onsubmit = async e => {
  e.preventDefault();
  const r = await DB.put('alumnos/' + encodeURIComponent(editandoAlumno), {
    nombre: $('#ed-nombre').value, generacion: $('#ed-generacion').value, telefono: $('#ed-alumno-tel').value,
    tutor: { nombre: $('#ed-tutor-nombre').value, telefono: $('#ed-tutor-tel').value }
  });
  mensaje($('#msg-editar'), r.msg, r.ok);
  if (r.ok) { $('#dlg-alumno').close(); toast(r.msg); renderAlumnos(); }
};

/* Importar alumnos desde CSV: matrícula,nombre,generación,tutor,WhatsApp tutor,WhatsApp alumno. */
function leerCSV(contenido) {
  return contenido.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(linea => {
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
  if (filas.length > 300) return mensaje($('#msg-alumno'), 'Máximo 300 alumnos por archivo.', false);
  const pines = [], problemas = [];
  for (const [i, [matricula = '', nombre = '', generacion = '', tutor = '', telTutor = '', telAlumno = '']] of filas.entries()) {
    mensaje($('#msg-alumno'), 'Importando ' + (i + 1) + ' de ' + filas.length + '…', true);
    const r = await DB.post('alumnos', { matricula, nombre, generacion, telefono: telAlumno, tutor: { nombre: tutor, telefono: telTutor } });
    if (r.ok) pines.push([matricula.toUpperCase(), nombre, r.pin]); else problemas.push((matricula || '(vacía)') + ': ' + r.msg);
  }
  mensaje($('#msg-alumno'), pines.length + ' importado(s)' + (problemas.length ? ', ' + problemas.length + ' con error.' : '.'), !problemas.length);
  renderAlumnos();
  if (pines.length) aviso('Alumnos importados', [
    pines.length + ' alumno(s) creados. Descarga la lista de PIN y repártela: no se vuelve a mostrar.',
    problemas.length ? 'Con error: ' + problemas.slice(0, 4).join(' · ') + (problemas.length > 4 ? ' …' : '') : '',
    el('button', { onclick: () => descargarTexto('pines_alumnos.csv', ['Matrícula,Nombre,PIN', ...pines.map(p => p.map(celdaCSV).join(','))].join('\n')) }, 'Descargar PIN (CSV)')
  ]);
};

/* ---------- Códigos QR ---------- */
async function ampliar(a) {
  const visor = $('#visor-qr');
  $('#visor-qr-nombre').textContent = a.nombre;
  $('#visor-qr-datos').textContent = a.matricula + (a.generacion ? ' · ' + a.generacion : '');
  $('#visor-qr-img').textContent = 'Generando…';
  if (!visor.open) visor.showModal();
  try { await QR.dibujar($('#visor-qr-img'), a.codigo, 520); }
  catch (err) { $('#visor-qr-img').textContent = err.message; }
}
$('#visor-qr-cerrar').onclick = () => $('#visor-qr').close();
$('#visor-qr').addEventListener('click', e => { if (e.target.id === 'visor-qr') e.target.close(); }); // clic fuera = cerrar
$('#dlg-aviso-cerrar').onclick = () => $('#dlg-aviso').close();

async function renderQR() {
  const cont = $('#lista-qr');
  cont.textContent = 'Cargando…';
  const r = await DB.get('alumnos');
  if (!r.ok) { cont.textContent = r.msg; return; }
  cont.replaceChildren();
  if (!r.datos.length) { cont.textContent = 'Aún no hay alumnos registrados.'; return; }
  for (const a of r.datos) {
    const qr = el('div', { class: 'qr', title: 'Toca para ampliar', onclick: () => ampliar(a) });
    cont.append(el('div', { class: 'card' }, qr, el('strong', {}, a.nombre), el('span', {}, a.matricula + ' · ' + a.generacion),
      el('button', { onclick: () => ampliar(a) }, 'Ampliar'), el('button', { class: 'secondary', onclick: () => QR.descargar(qr, a.matricula) }, 'Descargar PNG')));
    try { await QR.dibujar(qr, a.codigo); } catch (err) { qr.textContent = err.message; }
  }
}
$('#btn-imprimir').onclick = () => window.print();

/* ---------- Reportes ---------- */
let reporteActual = null;
const SIMBOLO = { presente: '✓', retardo: 'R', falta: 'F', justificada: 'J' };

async function renderReportes() {
  if (!(await cargarMaterias())) return;
  llenarSelectMaterias($('#reporte-materia'));
  await pintarReporte();
}
$('#reporte-materia').onchange = e => { materiaSel = e.target.value; pintarReporte(); };

async function pintarReporte() {
  const cab = $('#reporte-cabecera'), cuerpo = $('#reporte-cuerpo');
  cab.replaceChildren(); cuerpo.replaceChildren(); $('#reporte-resumen').replaceChildren();
  reporteActual = null;
  if (!materiaSel) { $('#vacio-reporte').hidden = false; $('#vacio-reporte').textContent = 'Aún no hay materias.'; return; }
  const r = await DB.get('materias/' + encodeURIComponent(materiaSel) + '/reporte');
  if (!r.ok) { $('#vacio-reporte').hidden = false; $('#vacio-reporte').textContent = r.msg; return; }
  reporteActual = r;
  $('#vacio-reporte').hidden = r.alumnos.length > 0;
  $('#vacio-reporte').textContent = 'Esta materia no tiene alumnos inscritos.';
  const m = r.materia;
  $('#reporte-resumen').replaceChildren(etiqueta(m.impartidas + ' de ' + m.clasesPlaneadas + ' clases impartidas', 'e-neutro'), etiqueta('Máximo ' + m.permitidas + ' faltas', 'e-neutro'),
    etiqueta(m.enRiesgo + ' en riesgo', m.enRiesgo ? 'e-riesgo' : 'e-neutro'), etiqueta(m.sinDerecho + ' sin derecho', m.sinDerecho ? 'e-sin_derecho' : 'e-neutro'));
  cab.append(el('tr', {}, el('th', { class: 'fija' }, 'Alumno'), r.fechas.map(f => el('th', { class: 'dia' }, fechaCorta(f))), el('th', {}, 'Faltas'), el('th', {}, 'Quedan'), el('th', {}, '% asist.'), el('th', {}, 'Estado')));
  r.alumnos.forEach(a => cuerpo.append(el('tr', {},
    el('td', { class: 'fija' }, a.nombre),
    r.fechas.map(f => { const e = a.dias[f]; return el('td', { class: 'dia c-' + (e || 'ninguno'), title: e ? ETIQUETA_ASISTENCIA[e] : 'Sin registro' }, e ? SIMBOLO[e] : '·'); }),
    el('td', {}, a.resumen.equivalentes + '/' + a.resumen.permitidas), el('td', {}, a.resumen.restantes), el('td', {}, a.resumen.asistencia + ' %'), el('td', {}, etiquetaEstado(a.resumen.estado)))));
}

$('#btn-csv').onclick = () => {
  if (!reporteActual) return toast('No hay reporte para exportar.', false);
  const r = reporteActual;
  const lineas = [['Matrícula', 'Nombre', ...r.fechas, 'Faltas', 'Faltas permitidas', 'Faltas disponibles', '% asistencia', 'Estado'],
    ...r.alumnos.map(a => [a.matricula, a.nombre, ...r.fechas.map(f => a.dias[f] ? ETIQUETA_ASISTENCIA[a.dias[f]] : ''), a.resumen.equivalentes, a.resumen.permitidas, a.resumen.restantes, a.resumen.asistencia, ETIQUETA_ESTADO[a.resumen.estado]])];
  descargarTexto('asistencia_' + r.materia.clave + '_' + DB.hoy() + '.csv', lineas.map(l => l.map(celdaCSV).join(',')).join('\n'));
};

/* ---------- Avisos ---------- */
async function renderAvisos() {
  const r = await DB.get('avisos');
  if (!r.ok) return mensaje($('#msg-avisos'), r.msg, false);
  $('#tabla-avisos').replaceChildren(...r.datos.map(a => el('tr', {},
    el('td', {}, fechaHora(a.creado)),
    el('td', {}, a.destinatario === 'tutor' ? 'Tutor' : a.destinatario === 'alumno' ? 'Alumno' : 'Prueba', a.matricula ? el('small', {}, ' ' + a.matricula) : null),
    el('td', { class: 'texto-aviso', title: a.texto }, a.texto.replace(/\n— Asistencia QR$/, '')),
    el('td', {}, etiqueta({ pendiente: 'En cola', enviado: 'Enviado', error: 'Error', omitido: 'Sin teléfono' }[a.estado] || a.estado, 'av-' + a.estado), a.detalle && a.estado !== 'enviado' ? el('small', { class: 'detalle' }, a.detalle) : null))));
  $('#vacio-avisos').hidden = r.datos.length > 0;
}
$('#btn-recargar-avisos').onclick = renderAvisos;
$('#form-prueba').onsubmit = async e => {
  e.preventDefault();
  const r = await DB.post('avisos/prueba', { telefono: $('#prueba-tel').value });
  mensaje($('#msg-avisos'), r.msg, r.ok);
  if (r.ok) renderAvisos();
};

/* ---------- Administración ---------- */
async function renderAdmin() {
  const r = await DB.get('maestros');
  if (!r.ok) return mensaje($('#msg-maestro'), r.msg, false);
  $('#tabla-maestros').replaceChildren(...r.datos.map(u => el('tr', {}, el('td', {}, u.usuario), el('td', {}, u.nombre),
    el('td', { class: 'acciones' }, el('button', { class: 'danger', onclick: async () => {
      if (!confirm('¿Eliminar al maestro ' + u.nombre + '?')) return;
      const r2 = await DB.borrar('maestros/' + encodeURIComponent(u.usuario));
      mensaje($('#msg-maestro'), r2.msg, r2.ok);
      renderAdmin();
    } }, 'Eliminar')))));
  $('#vacio-maestros').hidden = r.datos.length > 0;
}
$('#form-maestro').onsubmit = async e => {
  e.preventDefault();
  const r = await DB.post('maestros', { usuario: $('#maestro-usuario').value, nombre: $('#maestro-nombre').value, clave: $('#maestro-clave').value });
  mensaje($('#msg-maestro'), r.msg, r.ok);
  if (r.ok) { e.target.reset(); renderAdmin(); }
};
$('#form-demo').onsubmit = async e => {
  e.preventDefault();
  if (!confirm('Se borrará la demostración anterior (si la hay) y se cargará una nueva. ¿Continuar?')) return;
  mensaje($('#msg-demo'), 'Cargando datos…', true);
  const r = await DB.post('demo', { telefono: $('#demo-tel').value });
  mensaje($('#msg-demo'), r.msg, r.ok);
  if (r.ok) aviso('Demostración lista', [
    r.materias + ' materias y ' + r.alumnos + ' alumnos inventados.',
    'Maestro: usuario ' + r.maestro.usuario + ' · contraseña ' + r.maestro.clave,
    'Alumno con faltas en riesgo: matrícula ' + r.alumno.usuario + ' · PIN ' + r.alumno.pin,
    'Prueba: abre «Clase», registra a casi todos y pulsa «Cerrar clase»: a los demás se les marca falta y llegan los avisos.'
  ]);
};
