// Função serverless (Vercel): todas as rotas /api/* passam por aqui. A BD é remota (Turso).
import { openDb } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';

let ready; // memoizado por instância; reinicia se a ligação falhar
export default async function handler(req, res) {
  try {
    ready ??= openDb().then((db) => createApp(db));
    return await (await ready)(req, res);
  } catch (e) {
    ready = undefined;
    console.log(JSON.stringify({ level: 'error', msg: 'init', err: e.message }));
    res.statusCode = 500; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Serviço indisponível.' }));
  }
}
