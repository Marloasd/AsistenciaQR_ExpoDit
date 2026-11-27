/* Utilidades de interfaz compartidas por las vistas. */
const $ = s => document.querySelector(s);

/* Crea un elemento: el('div', { class: 'x', onclick: fn }, 'texto', otroElemento). */
function el(etiqueta, props = {}, ...hijos) {
  const e = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e[k] = v;
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat(Infinity)) if (h != null && h !== false) e.append(h.nodeType ? h : document.createTextNode(h));
  return e;
}

function mensaje(nodo, texto, ok) { nodo.textContent = texto || ''; nodo.className = 'msg ' + (ok ? 'ok' : 'error'); }

let temporizadorToast;
function toast(texto, ok = true) {
  const t = $('#toast');
  t.textContent = texto;
  t.className = 'visible' + (ok ? '' : ' error');
  clearTimeout(temporizadorToast);
  temporizadorToast = setTimeout(() => { t.className = ''; }, 3200);
}

const ETIQUETA_ESTADO = { ok: 'Al corriente', riesgo: 'En riesgo', limite: 'En el límite', sin_derecho: 'Sin derecho' };
const ETIQUETA_ASISTENCIA = { presente: 'Presente', retardo: 'Retardo', falta: 'Falta', justificada: 'Justificada' };

function etiqueta(texto, clase) { return el('span', { class: 'etiqueta ' + clase }, texto); }
const etiquetaEstado = estado => etiqueta(ETIQUETA_ESTADO[estado] || estado, 'e-' + estado);

/* Barra de faltas: cuántas lleva respecto a las permitidas y cuántas le quedan. */
function barraFaltas(r) {
  const pct = r.permitidas ? Math.min(100, Math.round(100 * r.equivalentes / r.permitidas)) : 100;
  const texto = r.estado === 'sin_derecho' ? 'Superó el límite por ' + r.excedidas + ' falta' + (r.excedidas === 1 ? '' : 's')
    : r.restantes === 0 ? 'Sin faltas disponibles'
    : 'Te quedan ' + r.restantes + ' falta' + (r.restantes === 1 ? '' : 's') + ' disponible' + (r.restantes === 1 ? '' : 's');
  return el('div', { class: 'faltas' },
    el('div', { class: 'faltas-texto' }, el('strong', {}, r.equivalentes + ' de ' + r.permitidas + ' faltas'), el('span', {}, texto)),
    el('div', { class: 'barra-fondo', role: 'img', 'aria-label': pct + ' % del límite de faltas' }, el('div', { class: 'barra-relleno b-' + r.estado, style: 'width:' + pct + '%' })));
}

const fechaCorta = f => f.slice(8, 10) + '/' + f.slice(5, 7) + (f.includes('#') ? ' (clase ' + f.split('#')[1] + ')' : '');
const fechaHora = iso => iso ? new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }) : '';

function descargarTexto(nombre, contenido, tipo = 'text/csv;charset=utf-8') {
  const a = el('a', { href: URL.createObjectURL(new Blob(['﻿' + contenido], { type: tipo })), download: nombre });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const celdaCSV = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';

/* Cuadro de diálogo con un campo de texto largo o un mensaje; devuelve cuando se cierra. */
function aviso(titulo, contenido) {
  const d = $('#dlg-aviso');
  $('#dlg-aviso-titulo').textContent = titulo;
  const cuerpo = $('#dlg-aviso-cuerpo');
  cuerpo.replaceChildren(...[].concat(contenido).map(c => c.nodeType ? c : el('p', {}, c)));
  d.showModal();
}
