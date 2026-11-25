/* Portal del alumno: sus materias con faltas disponibles y su código QR. */

let datosAlumno = null;

async function cargarYo() {
  const r = await DB.get('yo');
  if (!r.ok) { toast(r.msg, false); return false; }
  datosAlumno = r;
  return true;
}

async function renderResumenAlumno() {
  if (!(await cargarYo())) return;
  const { alumno, materias: lista } = datosAlumno;
  $('#saludo-alumno').textContent = 'Hola, ' + alumno.nombre.split(/\s+/)[0];
  $('#mis-materias').replaceChildren(...lista.map(m => {
    const r = m.resumen;
    return el('article', { class: 'materia e-borde-' + r.estado },
      el('div', { class: 'materia-cab' }, el('h3', {}, m.nombre), etiquetaEstado(r.estado)),
      el('small', {}, m.maestro + (m.grupo ? ' · ' + m.grupo : '') + (m.horaInicio ? ' · ' + m.horaInicio + ' h' : '')),
      barraFaltas(r),
      el('div', { class: 'chips' },
        etiqueta(r.presentes + ' asistencias', 'e-neutro'), etiqueta(r.retardos + ' retardos', r.retardos ? 'e-riesgo' : 'e-neutro'),
        etiqueta(r.faltas + ' faltas', r.faltas ? 'e-limite' : 'e-neutro'), etiqueta(r.justificadas + ' justificadas', 'e-neutro'),
        etiqueta(r.asistencia + ' % de asistencia', 'e-neutro')),
      r.retardos >= 2 ? el('p', { class: 'hint' }, 'Recuerda: 3 retardos cuentan como 1 falta.') : null,
      m.recientes.length ? el('div', { class: 'recientes' }, el('small', {}, 'Últimos registros'),
        el('div', { class: 'chips' }, m.recientes.map(x => etiqueta(fechaCorta(x.fecha) + ' · ' + ETIQUETA_ASISTENCIA[x.estado], 'a-' + x.estado)))) : null);
  }));
  $('#vacio-mis-materias').hidden = lista.length > 0;
}

async function renderMiQR() {
  if (!(await cargarYo())) return;
  const { alumno } = datosAlumno;
  $('#mi-qr-nombre').textContent = alumno.nombre;
  $('#mi-qr-datos').textContent = alumno.matricula + ' · ' + alumno.generacion;
  try { await QR.dibujar($('#mi-qr-img'), alumno.codigo, 320); }
  catch (err) { $('#mi-qr-img').textContent = err.message; }
}
$('#btn-mi-qr-ampliar').onclick = () => { if (datosAlumno) ampliar({ ...datosAlumno.alumno }); };
$('#btn-mi-qr-descargar').onclick = () => { if (datosAlumno) QR.descargar($('#mi-qr-img'), datosAlumno.alumno.matricula); };
