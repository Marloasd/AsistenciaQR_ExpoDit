/* Reglas de negocio puras (sin base de datos): faltas permitidas, retardos, estado del alumno y textos de aviso. */

const PORCENTAJE_FALTAS = 20;      // máximo de faltas = 20 % de las clases planeadas
const RETARDOS_POR_FALTA = 3;      // 3 retardos equivalen a 1 falta
const TOLERANCIA_MINUTOS = 15;     // pasado este tiempo desde el inicio, la llegada cuenta como retardo
const VENTANA_MINUTOS = 90;        // después de esto ya no es una llegada tarde (se pasa lista fuera de horario): cuenta como presente

const faltasPermitidas = (clasesPlaneadas, porcentaje = PORCENTAJE_FALTAS) =>
  Math.floor(Number(clasesPlaneadas) * Number(porcentaje) / 100);

const minutos = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

function estadoPorHora(horaInicio, hora) {
  if (!/^\d{2}:\d{2}/.test(horaInicio || '') || !/^\d{2}:\d{2}/.test(hora || '')) return 'presente';
  const tarde = minutos(hora) - minutos(horaInicio);
  return tarde > TOLERANCIA_MINUTOS && tarde <= VENTANA_MINUTOS ? 'retardo' : 'presente';
}

/* registros: asistencias de UN alumno en UNA materia. */
function resumen(materia, registros) {
  const cuenta = estado => registros.filter(r => r.estado === estado).length;
  const presentes = cuenta('presente'), retardos = cuenta('retardo'), faltas = cuenta('falta'), justificadas = cuenta('justificada');
  const equivalentes = faltas + Math.floor(retardos / RETARDOS_POR_FALTA);
  const permitidas = faltasPermitidas(materia.clasesPlaneadas, materia.porcentajeFaltas);
  const crudo = permitidas - equivalentes;
  const estado = crudo < 0 ? 'sin_derecho' : crudo === 0 ? 'limite' : crudo <= Math.ceil(permitidas / 2) ? 'riesgo' : 'ok';
  const total = registros.length;
  return {
    presentes, retardos, faltas, justificadas, equivalentes, permitidas,
    restantes: Math.max(crudo, 0), excedidas: Math.max(-crudo, 0), crudo, estado,
    asistencia: total ? Math.round(100 * (presentes + retardos + justificadas) / total) : 100
  };
}

const fechaLarga = fecha => new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
  .format(new Date(fecha + 'T12:00:00Z'));
const plural = (n, uno, varios) => n + ' ' + (n === 1 ? uno : varios);
const primerNombre = nombre => String(nombre).trim().split(/\s+/)[0];

function textoAvisoTutor(alumno, materia, fecha, r) {
  const estado = r.crudo < 0 ? ' Ya superó el límite y pierde el derecho a evaluación ordinaria.'
    : r.crudo === 0 ? ' Ya no tiene faltas disponibles.'
    : ' Le ' + (r.restantes === 1 ? 'queda ' : 'quedan ') + plural(r.restantes, 'falta disponible', 'faltas disponibles') + '.';
  return 'Aviso de asistencia: ' + alumno.nombre + ' no asistió a ' + materia.nombre + ' el ' + fechaLarga(fecha) + '. '
    + 'Lleva ' + plural(r.equivalentes, 'falta', 'faltas') + ' de ' + r.permitidas + ' permitidas.' + estado + '\n— Asistencia QR';
}

function textoAvisoAlumno(alumno, materia, r) {
  const hola = 'Hola ' + primerNombre(alumno.nombre) + ', ';
  if (r.crudo < 0) return hola + 'en ' + materia.nombre + ' superaste el límite de ' + r.permitidas + ' faltas. Habla con tu maestro para revisar tu situación.\n— Asistencia QR';
  if (r.crudo === 0) return hola + 'en ' + materia.nombre + ' ya no te quedan faltas disponibles: una más y pierdes el derecho a evaluación ordinaria.\n— Asistencia QR';
  return hola + 'en ' + materia.nombre + ' te ' + (r.restantes === 1 ? 'queda ' : 'quedan ') + plural(r.restantes, 'falta disponible', 'faltas disponibles') + ' de ' + r.permitidas + '.\n— Asistencia QR';
}

/* Teléfono mexicano de 10 dígitos -> formato de WhatsApp (521 + 10 dígitos). Devuelve '' si no hay y null si es inválido. */
function normalizarTelefono(valor) {
  const d = String(valor ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return '521' + d;
  if (d.length === 12 && d.startsWith('52')) return '521' + d.slice(2);
  if (d.length === 13 && d.startsWith('521')) return d;
  return null;
}

module.exports = { PORCENTAJE_FALTAS, faltasPermitidas, estadoPorHora, resumen, textoAvisoTutor, textoAvisoAlumno, normalizarTelefono, fechaLarga };
