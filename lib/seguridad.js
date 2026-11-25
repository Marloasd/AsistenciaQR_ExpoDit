/* Contraseñas, sesiones firmadas y códigos aleatorios. Solo usa node:crypto. */
const { scryptSync, randomBytes, randomInt, timingSafeEqual, createHmac, createHash } = require('node:crypto');

function hashClave(clave) {
  const sal = randomBytes(16).toString('hex');
  return 'scrypt$' + sal + '$' + scryptSync(String(clave), sal, 32).toString('hex');
}

function verificarClave(clave, guardado) {
  if (typeof guardado !== 'string') return false;
  const [tipo, sal, hash] = guardado.split('$');
  if (tipo !== 'scrypt' || !sal || !hash) return false;
  const calculado = scryptSync(String(clave), sal, 32);
  const esperado = Buffer.from(hash, 'hex');
  return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}

function iguales(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const base64 = datos => Buffer.from(datos).toString('base64url');
const firma = (cuerpo, secreto) => createHmac('sha256', secreto).update(cuerpo).digest('base64url');

function firmar(datos, secreto) {
  const cuerpo = base64(JSON.stringify(datos));
  return cuerpo + '.' + firma(cuerpo, secreto);
}

function leerFirmado(token, secreto) {
  if (typeof token !== 'string') return null;
  const [cuerpo, recibida] = token.split('.');
  if (!cuerpo || !recibida || !iguales(recibida, firma(cuerpo, secreto))) return null;
  try {
    const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    return datos.exp > Date.now() ? datos : null;
  } catch { return null; }
}

function leerCookie(cabecera, nombre) {
  for (const par of String(cabecera || '').split(';')) {
    const [k, ...v] = par.trim().split('=');
    if (k === nombre) return v.join('=');
  }
  return null;
}

/* Alfabeto sin 0/O/1/I para que el código se pueda dictar sin confusiones. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function codigoAleatorio(largo = 9) {
  let c = '';
  for (let i = 0; i < largo; i++) c += ALFABETO[randomInt(ALFABETO.length)];
  return c;
}
const pinAleatorio = () => String(randomInt(10000)).padStart(4, '0');

const derivarSecreto = semilla => createHash('sha256').update('sesion|' + semilla).digest('hex');

module.exports = { hashClave, verificarClave, iguales, firmar, leerFirmado, leerCookie, codigoAleatorio, pinAleatorio, derivarSecreto };
