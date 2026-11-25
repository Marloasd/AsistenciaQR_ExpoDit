/* SERVICIO QR: generar y escanear. Usa librerías locales (js/vendor) o, si no existen, las carga de cdnjs. */
function cargarScript(local, cdn) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = local;
    s.onload = ok;
    s.onerror = () => {
      const c = document.createElement('script');
      c.src = cdn;
      c.onload = ok;
      c.onerror = () => fail(new Error('No se pudo cargar ' + local + '. Revisa tu conexión o copia la librería en js/vendor/.'));
      document.head.appendChild(c);
    };
    document.head.appendChild(s);
  });
}

const QR = {
  _libs: null,
  scanner: null,

  cargar() {
    if (!this._libs) {
      this._libs = Promise.all([
        cargarScript('js/vendor/qrcode.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'),
        cargarScript('js/vendor/html5-qrcode.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js')
      ]).catch(e => { this._libs = null; throw e; });
    }
    return this._libs;
  },

  /* Dibuja el QR con fondo blanco y zona de silencio incluida (12 % por lado): sin ese margen, muchos lectores no lo detectan
     (comprobado con OpenCV) y depende del color de lo que haya alrededor. El canvas resultante mide tam + 2·margen. */
  async dibujar(contenedor, texto, tam = 240) {
    await this.cargar();
    const temporal = document.createElement('div');
    new QRCode(temporal, { text: texto, width: tam, height: tam, correctLevel: QRCode.CorrectLevel.M });
    const origen = temporal.querySelector('canvas');
    const margen = Math.round(tam * 0.12);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = tam + 2 * margen;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(origen, margen, margen);
    contenedor.innerHTML = '';
    contenedor.appendChild(canvas);
  },

  /* El PNG descargado es grande (600 px) y ya trae el margen blanco: se lee bien impreso o desde otra pantalla. */
  descargar(contenedor, nombre) {
    const canvas = contenedor.querySelector('canvas');
    if (!canvas) return;
    const lado = 600;
    const salida = document.createElement('canvas');
    salida.width = salida.height = lado;
    const ctx = salida.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, lado, lado);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, lado, lado);
    const a = document.createElement('a');
    a.href = salida.toDataURL('image/png');
    a.download = 'QR_' + nombre + '.png';
    a.click();
  },

  /* Recuadro de lectura proporcional al video (75 % del lado menor): antes era fijo de 220 px y no leía QR grandes o cercanos. */
  _config() {
    return {
      fps: 15,
      qrbox: (ancho, alto) => { const lado = Math.floor(Math.min(ancho, alto) * 0.75); return { width: lado, height: lado }; },
      formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    };
  },

  /* Lista de cámaras (solo hay etiquetas después de que el usuario concede el permiso). */
  async camaras() {
    await this.cargar();
    return Html5Qrcode.getCameras().catch(() => []);
  },

  /* Si se indica `camaraId` se usa esa cámara; si no, la trasera, y como último recurso la última de la lista. */
  async iniciar(alLeer, camaraId) {
    await this.cargar();
    await this.detener();
    this.scanner = new Html5Qrcode('lector', { verbose: false });
    const alFallar = () => {}; // ignora los fotogramas sin QR
    if (camaraId) return this.scanner.start(camaraId, this._config(), alLeer, alFallar);
    try {
      await this.scanner.start({ facingMode: 'environment' }, this._config(), alLeer, alFallar);
    } catch (primero) {
      // Algunos equipos no tienen cámara trasera: se prueba con la última cámara disponible.
      const camaras = await this.camaras();
      if (!camaras.length) throw primero;
      await this.scanner.start(camaras[camaras.length - 1].id, this._config(), alLeer, alFallar);
    }
  },

  /* Linterna: solo existe en algunos celulares. Devuelve una función para encender/apagar, o null si no hay. */
  linterna() {
    try {
      const f = this.scanner && this.scanner.getRunningTrackCameraCapabilities().torchFeature();
      if (!f || !f.isSupported()) return null;
      return encendida => f.apply(encendida);
    } catch { return null; }
  },

  /* Plan B sin cámara: lee el QR de una foto o captura de pantalla. */
  async leerImagen(archivo) {
    await this.cargar();
    await this.detener();
    const lector = new Html5Qrcode('lector-archivo', { verbose: false, formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE] });
    try { return await lector.scanFile(archivo, false); }
    finally { lector.clear(); }
  },

  async detener() {
    if (this.scanner) {
      try { await this.scanner.stop(); this.scanner.clear(); } catch (e) { /* ya detenido */ }
      this.scanner = null;
    }
  }
};
