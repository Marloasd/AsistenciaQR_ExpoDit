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

  async dibujar(contenedor, texto, tam = 150) {
    await this.cargar();
    contenedor.innerHTML = '';
    new QRCode(contenedor, { text: texto, width: tam, height: tam, correctLevel: QRCode.CorrectLevel.M });
  },

  descargar(contenedor, nombre) {
    const canvas = contenedor.querySelector('canvas');
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'QR_' + nombre + '.png';
    a.click();
  },

  async iniciar(alLeer) {
    await this.cargar();
    await this.detener();
    this.scanner = new Html5Qrcode('lector');
    await this.scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 220 }, alLeer);
  },

  async detener() {
    if (this.scanner) {
      try { await this.scanner.stop(); this.scanner.clear(); } catch (e) { /* ya detenido */ }
      this.scanner = null;
    }
  }
};
