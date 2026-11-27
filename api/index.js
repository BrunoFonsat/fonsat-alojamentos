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
    // pista segura (sem segredos) para quem configura o deploy
    const hint = e.hint || (/401|403|unauthori[sz]ed|forbidden|jwt|token/i.test(e.message) ? 'sem acesso à BD: verifique ALOJ_DB_TOKEN'
      : /ENOTFOUND|getaddrinfo|URL_INVALID|invalid url/i.test(e.message) ? 'endereço da BD inválido: verifique ALOJ_DB_URL' : 'erro ao ligar à BD');
    res.end(JSON.stringify({ error: `Serviço indisponível (${hint}).` }));
  }
}
