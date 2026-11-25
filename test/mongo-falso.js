// Sustituto en memoria del paquete mongodb: permite probar server.js sin base de datos (node --require ./test/mongo-falso.js server.js).
const Module = require('node:module');
const orig = Module._load;
const datos = new Map();
const colec = {
  find() { return { toArray: async () => [...datos.values()].map(a => ({ matricula: a.matricula, nombre: a.nombre, generacion: a.generacion })) }; },
  async insertOne(d) { if (datos.has(d._id)) throw Object.assign(new Error('dup'), { code: 11000 }); datos.set(d._id, structuredClone(d)); },
  async deleteOne({ _id }) { datos.delete(_id); },
  aggregate() {
    return { toArray: async () => {
      const out = [];
      for (const a of datos.values()) for (const s of a.asistencias) out.push({ matricula: a.matricula, nombre: a.nombre, generacion: a.generacion, fecha: s.fecha, hora: s.hora });
      return out.sort((x, y) => (x.fecha + x.hora + x.matricula).localeCompare(y.fecha + y.hora + y.matricula));
    } };
  },
  async findOneAndUpdate({ _id, 'asistencias.fecha': cond }, { $push }) {
    const a = datos.get(_id); if (!a) return null;
    if (a.asistencias.some(s => s.fecha === cond.$ne)) return null;
    a.asistencias.push($push.asistencias); return { nombre: a.nombre };
  },
  async findOne({ _id }) { const a = datos.get(_id); return a ? { nombre: a.nombre } : null; },
  async updateMany() { for (const a of datos.values()) a.asistencias = []; }
};
class MongoClient { constructor() {} db() { return { collection: () => colec }; } }
Module._load = function (req, ...r) { return req === 'mongodb' ? { MongoClient } : orig.call(this, req, ...r); };
