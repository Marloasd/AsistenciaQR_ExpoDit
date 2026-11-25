const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/reglas');

const materia = { clasesPlaneadas: 20, porcentajeFaltas: 20 };
const registros = (faltas, retardos = 0, justificadas = 0, presentes = 0) => [
  ...Array(faltas).fill({ estado: 'falta' }), ...Array(retardos).fill({ estado: 'retardo' }),
  ...Array(justificadas).fill({ estado: 'justificada' }), ...Array(presentes).fill({ estado: 'presente' })
];

test('el máximo de faltas es el 20 % de las clases planeadas, redondeado hacia abajo', () => {
  assert.equal(R.faltasPermitidas(20), 4);
  assert.equal(R.faltasPermitidas(40), 8);
  assert.equal(R.faltasPermitidas(16), 3);
  assert.equal(R.faltasPermitidas(10, 30), 3);
});

test('el semáforo cambia según las faltas disponibles', () => {
  const estado = n => R.resumen(materia, registros(n)).estado;
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(estado), ['ok', 'ok', 'riesgo', 'riesgo', 'limite', 'sin_derecho']);
  const r = R.resumen(materia, registros(5));
  assert.deepEqual([r.restantes, r.excedidas], [0, 1]);
});

test('tres retardos valen una falta y las justificadas no cuentan', () => {
  const r = R.resumen(materia, registros(1, 7, 3));
  assert.equal(r.equivalentes, 3);
  assert.equal(r.restantes, 1);
  assert.equal(r.justificadas, 3);
});

test('el retardo depende de la hora de inicio de la clase', () => {
  assert.equal(R.estadoPorHora('10:00', '10:15:00'), 'presente');
  assert.equal(R.estadoPorHora('10:00', '10:16:00'), 'retardo');
  assert.equal(R.estadoPorHora('10:00', '11:30:00'), 'retardo');
  assert.equal(R.estadoPorHora('10:00', '11:31:00'), 'presente', 'fuera de horario ya no es llegar tarde');
  assert.equal(R.estadoPorHora('10:00', '09:50:00'), 'presente');
  assert.equal(R.estadoPorHora('', '23:00:00'), 'presente');
});

test('normaliza teléfonos mexicanos al formato de WhatsApp', () => {
  assert.equal(R.normalizarTelefono('33 2492 8629'), '5213324928629');
  assert.equal(R.normalizarTelefono('+52 33 2492 8629'), '5213324928629');
  assert.equal(R.normalizarTelefono('5213324928629'), '5213324928629');
  assert.equal(R.normalizarTelefono(''), '');
  assert.equal(R.normalizarTelefono('123'), null);
});

test('los textos de aviso dicen cuántas faltas quedan', () => {
  const alumno = { nombre: 'Ana López' };
  const tutor = R.textoAvisoTutor(alumno, { nombre: 'Redes' }, '2026-11-25', R.resumen(materia, registros(3)));
  assert.match(tutor, /Ana López no asistió a Redes el miércoles, 25 de noviembre/);
  assert.match(tutor, /Lleva 3 faltas de 4 permitidas\. Le queda 1 falta disponible/);
  assert.match(R.textoAvisoAlumno(alumno, { nombre: 'Redes' }, R.resumen(materia, registros(2))), /Hola Ana, en Redes te quedan 2 faltas disponibles de 4/);
  assert.match(R.textoAvisoAlumno(alumno, { nombre: 'Redes' }, R.resumen(materia, registros(5))), /superaste el límite/);
});
