/* Datos de demostración 100 % inventados y deterministas: sirven para presentar el sistema sin datos reales.
   Si se indica `telefono`, todos los avisos de WhatsApp (de tutores y alumnos) llegan a ese número. */

const NOMBRES = [
  'Ana López Ruiz', 'Beto Ramírez Cruz', 'Carla Mendoza Soto', 'Diego Herrera Luna', 'Elena Vargas Pérez',
  'Fernando Ortiz Gil', 'Gabriela Núñez Rojas', 'Hugo Salazar Díaz', 'Irene Campos Vega', 'Jorge Medina Ríos',
  'Karen Aguilar Torres', 'Luis Fuentes Mora', 'Mariana Castillo Peña', 'Nicolás Rangel Soto'
];

/* [faltas, retardos, justificadas] por alumno y materia: reparte casos de cada color del semáforo. */
const PERFIL = {
  'PW-A': { D2024003: [5, 0, 0], D2024005: [4, 0, 0], D2024007: [3, 2, 0], D2024009: [1, 3, 0], D2024011: [1, 0, 0], D2024012: [0, 0, 1] },
  'RED-B': { D2024002: [3, 0, 0], D2024004: [2, 0, 0], D2024006: [1, 1, 0] }
};

const MATERIAS = [
  { clave: 'PW-A', nombre: 'Programación Web', grupo: '5A', horaInicio: '10:00', clasesPlaneadas: 20, impartidas: 10, inscritos: 14 },
  { clave: 'RED-B', nombre: 'Redes de Computadoras', grupo: '5B', horaInicio: '16:00', clasesPlaneadas: 16, impartidas: 8, inscritos: 10 }
];

function diasHabilesAntes(hoy, cantidad) {
  const fechas = [];
  const d = new Date(hoy + 'T12:00:00Z');
  while (fechas.length < cantidad) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (![0, 6].includes(d.getUTCDay())) fechas.push(d.toISOString().slice(0, 10));
  }
  return fechas.reverse();
}

const sumarMinutos = (hhmm, min) => {
  const total = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + min;
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0') + ':00';
};

function crearDatosDemo({ hoy, telefono = '', hash, codigo }) {
  const claveMaestro = 'demo1234', pin = '1234';
  const hashPin = hash(pin);
  const maestro = { _id: 'prof.demo', nombre: 'Profesor Demo', hash: hash(claveMaestro), rol: 'maestro', demo: true };

  const alumnos = NOMBRES.map((nombre, i) => {
    const matricula = 'D2024' + String(i + 1).padStart(3, '0');
    return {
      _id: matricula, matricula, nombre, generacion: '2026B', codigo: codigo(), pinHash: hashPin, demo: true,
      telefono, tutor: { nombre: 'Tutor de ' + nombre.split(' ')[0], telefono }
    };
  });

  const materias = [], clases = [], asistencias = [];
  for (const def of MATERIAS) {
    const inscritos = alumnos.slice(0, def.inscritos).map(a => a._id);
    materias.push({
      _id: def.clave, clave: def.clave, nombre: def.nombre, grupo: def.grupo, maestro: maestro._id, horaInicio: def.horaInicio,
      clasesPlaneadas: def.clasesPlaneadas, porcentajeFaltas: 20, inscritos, demo: true
    });
    const fechas = diasHabilesAntes(hoy, def.impartidas);
    fechas.forEach(fecha => clases.push({ _id: def.clave + '|' + fecha, materiaId: def.clave, fecha, estado: 'cerrada', abierta: def.horaInicio + ':00', cierre: sumarMinutos(def.horaInicio, 90), demo: true }));

    for (const matricula of inscritos) {
      const [faltas, retardos, justificadas] = (PERFIL[def.clave] || {})[matricula] || [0, 0, 0];
      // Reparte los días especiales empezando en una posición distinta por alumno para que no coincidan todos el mismo día.
      const desfase = Number(matricula.slice(-3)) * 3;
      const posiciones = fechas.map((_, i) => (i + desfase) % fechas.length);
      const especiales = new Map();
      posiciones.slice(0, faltas).forEach(i => especiales.set(i, 'falta'));
      posiciones.slice(faltas, faltas + retardos).forEach(i => especiales.set(i, 'retardo'));
      posiciones.slice(faltas + retardos, faltas + retardos + justificadas).forEach(i => especiales.set(i, 'justificada'));
      fechas.forEach((fecha, i) => {
        const estado = especiales.get(i) || 'presente';
        const hora = sumarMinutos(def.horaInicio, estado === 'retardo' ? 22 : estado === 'presente' ? 3 + (Number(matricula.slice(-3)) % 8) : 0);
        asistencias.push({ _id: [def.clave, fecha, matricula].join('|'), materiaId: def.clave, matricula, fecha, hora, estado, origen: 'demo' });
      });
    }
  }
  return { maestro, claveMaestro, pin, alumnos, materias, clases, asistencias };
}

module.exports = { crearDatosDemo };
