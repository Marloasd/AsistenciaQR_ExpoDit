/* Cliente de la API de asistencia */
const DB = {
  hoy() { return new Date().toLocaleDateString('en-CA'); },

  async solicitud(ruta, method = 'GET', datos) {
    try {
      const respuesta = await fetch('/api/' + ruta, {
        method,
        headers: datos === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: datos === undefined ? undefined : JSON.stringify(datos)
      });
      return { ...(await respuesta.json()), estado: respuesta.status };
    } catch {
      return { ok: false, estado: 0, msg: 'No se pudo comunicar con el servidor de Asistencia QR.' };
    }
  },

  alumnos() { return this.solicitud('alumnos'); },
  registros() { return this.solicitud('asistencias'); },
  agregarAlumno(alumno) { return this.solicitud('alumnos', 'POST', alumno); },
  eliminarAlumno(matricula) { return this.solicitud('alumnos/' + encodeURIComponent(matricula), 'DELETE'); },
  registrarAsistencia(texto) { return this.solicitud('asistencias', 'POST', { texto }); },
  borrarAsistencias() { return this.solicitud('asistencias', 'DELETE'); }
};
