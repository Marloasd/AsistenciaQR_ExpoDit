/* Cliente de la API. Cada llamada devuelve { ok, estado, msg, ...datos } y nunca lanza. */
const DB = {
  alExpirar: null, // función que muestra la pantalla de acceso cuando el servidor responde 401

  hoy() { return new Date().toLocaleDateString('en-CA'); },

  async solicitud(ruta, metodo = 'GET', datos) {
    try {
      const respuesta = await fetch('/api/' + ruta, {
        method: metodo,
        headers: datos === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: datos === undefined ? undefined : JSON.stringify(datos)
      });
      const cuerpo = { ...(await respuesta.json()), estado: respuesta.status };
      if (respuesta.status === 401 && ruta !== 'login' && this.alExpirar) this.alExpirar();
      return cuerpo;
    } catch {
      return { ok: false, estado: 0, msg: 'No se pudo comunicar con el servidor de Asistencia QR.' };
    }
  },

  get(ruta) { return this.solicitud(ruta); },
  post(ruta, datos = {}) { return this.solicitud(ruta, 'POST', datos); },
  put(ruta, datos) { return this.solicitud(ruta, 'PUT', datos); },
  patch(ruta, datos) { return this.solicitud(ruta, 'PATCH', datos); },
  borrar(ruta) { return this.solicitud(ruta, 'DELETE'); }
};
