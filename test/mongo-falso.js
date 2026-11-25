// Sustituto en memoria del paquete mongodb: permite probar server.js sin base de datos
// (node --require ./test/mongo-falso.js server.js). Implementa solo lo que usa la aplicación.
const Module = require('node:module');
const original = Module._load;
const colecciones = new Map();

const esObjeto = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function coincide(doc, filtro) {
  return Object.entries(filtro || {}).every(([clave, condicion]) => {
    const valor = doc[clave];
    if (esObjeto(condicion)) {
      if ('$in' in condicion) return condicion.$in.some(x => Array.isArray(valor) ? valor.includes(x) : valor === x);
      if ('$ne' in condicion) return valor !== condicion.$ne;
    }
    return Array.isArray(valor) ? valor.includes(condicion) : valor === condicion;
  });
}

function aplicar(doc, cambios) {
  for (const [op, campos] of Object.entries(cambios)) {
    for (const [campo, valor] of Object.entries(campos)) {
      if (op === '$set') doc[campo] = structuredClone(valor);
      else if (op === '$addToSet') {
        doc[campo] = doc[campo] || [];
        for (const x of (esObjeto(valor) && valor.$each) || [valor]) if (!doc[campo].includes(x)) doc[campo].push(x);
      } else if (op === '$pull') doc[campo] = (doc[campo] || []).filter(x => x !== valor);
      else throw new Error('Operador no soportado en el simulador: ' + op);
    }
  }
}

function coleccion(nombre) {
  if (!colecciones.has(nombre)) colecciones.set(nombre, new Map());
  const datos = colecciones.get(nombre);
  const copias = filtro => [...datos.values()].filter(d => coincide(d, filtro)).map(d => structuredClone(d));
  return {
    find(filtro) { return { toArray: async () => copias(filtro) }; },
    async findOne(filtro) { return copias(filtro)[0] || null; },
    async insertOne(doc) {
      if (datos.has(doc._id)) throw Object.assign(new Error('duplicado'), { code: 11000 });
      datos.set(doc._id, structuredClone(doc));
    },
    async updateOne(filtro, cambios, { upsert } = {}) {
      const doc = [...datos.values()].find(d => coincide(d, filtro));
      if (doc) return aplicar(doc, cambios);
      if (upsert) { const nuevo = { _id: filtro._id }; aplicar(nuevo, cambios); datos.set(nuevo._id, nuevo); }
    },
    async deleteOne(filtro) { const doc = [...datos.values()].find(d => coincide(d, filtro)); if (doc) datos.delete(doc._id); },
    async deleteMany(filtro) { for (const d of [...datos.values()]) if (coincide(d, filtro)) datos.delete(d._id); },
    async createIndex() {}
  };
}

class MongoClient { db() { return { collection: coleccion }; } }
Module._load = function (peticion, ...resto) { return peticion === 'mongodb' ? { MongoClient } : original.call(this, peticion, ...resto); };
