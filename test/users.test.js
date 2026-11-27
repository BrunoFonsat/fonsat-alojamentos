import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { upsertUser } from '../src/server/auth.js';

process.env.ALOJ_LOGIN_MAX = '1000';
const PW = 'Teste-Aloj-2026!';
async function boot() {
  const db = await openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aloj-u-')), 't.sqlite'));
  await upsertUser(db, { email: 'g@t.pt', name: 'Gestor', password: PW, role: 'gestor' });
  await upsertUser(db, { email: 'c@t.pt', name: 'Coord', password: PW, role: 'coordenador', delegation: 'asturias' });
  const server = http.createServer(createApp(db)); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password = PW) => {
    const l = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (l.status !== 200) return { status: l.status };
    const cookie = l.headers.get('set-cookie').split(';')[0], csrf = (await l.json()).csrf;
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: /json/.test(r.headers.get('content-type') ?? '') ? await r.json() : null };
    };
    call.status = 200;
    return call;
  };
  return { server, login, db };
}
/** Cria um utilizador pelo gestor, entra com a temporária e escolhe a palavra-passe definitiva. */
async function newUser(g, login, data) {
  const r = await g('POST', '/api/users', data);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const u = await login(data.email, r.json.tempPassword);
  assert.equal((await u('POST', '/api/auth/password', { current: r.json.tempPassword, password: PW })).status, 200);
  return u;
}

test('utilizadores: palavra-passe temporária obriga a escolher uma nova antes de usar a aplicação', async () => {
  const { server, login } = await boot();
  try {
    const g = await login('g@t.pt');
    const r = await g('POST', '/api/users', { name: 'Ana Admin', email: 'Ana@T.pt', role: 'administrativo', delegation: '' });
    assert.equal(r.status, 200); assert.match(r.json.tempPassword, /^\w{4}-\w{4}-\w{4}$/);
    const a = await login('ana@t.pt', r.json.tempPassword);
    assert.equal((await a('GET', '/api/auth/me')).json.user.mustChange, true);
    const blocked = await a('GET', '/api/data');
    assert.equal(blocked.status, 403); assert.equal(blocked.json.mustChange, true);
    assert.equal((await a('POST', '/api/auth/password', { current: 'errada', password: 'nova-palavra-passe' })).status, 403);
    assert.equal((await a('POST', '/api/auth/password', { current: r.json.tempPassword, password: 'curta' })).status, 422);
    assert.equal((await a('POST', '/api/auth/password', { current: r.json.tempPassword, password: r.json.tempPassword })).status, 422);
    assert.equal((await a('POST', '/api/auth/password', { current: r.json.tempPassword, password: 'nova-palavra-passe' })).status, 200);
    assert.equal((await a('GET', '/api/data')).status, 200);
    assert.equal((await login('ana@t.pt', r.json.tempPassword)).status, 401); // a temporária deixa de servir
    assert.equal((await login('ana@t.pt', 'nova-palavra-passe')).status, 200);
  } finally { server.close(); }
});

test('administrativo: só leitura (todas as delegações ou uma); exporta Excel; vê telefones; sem histórico', async () => {
  const { server, login } = await boot();
  try {
    const g = await login('g@t.pt');
    const hA = (await g('PUT', '/api/houses', { name: 'Casa Ast', delegation: 'asturias' })).json.id;
    await g('PUT', '/api/houses', { name: 'Casa Cat', delegation: 'catalunha' });
    await g('PUT', '/api/workers', { name: 'Pessoa', phone: '+351 911', delegation: 'asturias' });
    const all = await newUser(g, login, { name: 'Adm Todas', email: 'adm1@t.pt', role: 'administrativo' });
    const one = await newUser(g, login, { name: 'Adm Cat', email: 'adm2@t.pt', role: 'administrativo', delegation: 'catalunha' });
    const d = (await all('GET', '/api/data')).json;
    assert.equal(d.houses.length, 2);
    assert.equal(d.workers[0].phone, '+351 911');
    assert.deepEqual((await one('GET', '/api/data')).json.houses.map((x) => x.name), ['Casa Cat']);
    // nada de escrita, em nenhuma rota
    for (const [m, p, b] of [['PUT', '/api/houses', { name: 'X', delegation: 'asturias' }], ['PUT', '/api/houses', { id: hA, name: 'Casa Ast', delegation: 'asturias', rent: 1 }],
      ['POST', '/api/stays/enter', { house_id: hA, worker_id: 1, date: '2026-11-26', reason: 'x' }], ['PUT', '/api/workers', { name: 'Y' }],
      ['PUT', '/api/adjustments', { house_id: hA, month: '2026-11', value: 1 }], ['POST', `/api/houses/${hA}/confirm-empty`, {}], ['PUT', `/api/houses/${hA}/position`, { lat: 43, lng: -5 }],
      ['POST', '/api/excel/previsualizar', { file: '' }], ['POST', '/api/excel/importar', { file: '' }], ['DELETE', `/api/houses/${hA}`], ['PUT', '/api/settings/auth-code', { code: 'abcdefgh' }], ['GET', '/api/users']]) {
      const r = await all(m, p, b);
      assert.equal(r.status, 403, `${m} ${p}`);
    }
    assert.match((await all('PUT', '/api/houses', { name: 'X', delegation: 'asturias' })).json.error, /só permite visualizar/);
    assert.equal((await all('GET', '/api/audit')).status, 403);
    assert.equal((await all('GET', '/api/excel/exportar?delegacao=porto')).status, 200);
    assert.equal((await one('GET', '/api/excel/exportar?delegacao=asturias')).status, 403); // só a delegação que vê
    assert.equal((await one('GET', '/api/excel/exportar?delegacao=catalunha')).status, 200);
    assert.equal((await g('GET', '/api/data')).json.houses.length, 2); // nada mudou
  } finally { server.close(); }
});

test('gestão de utilizadores: só o gestor; validações; desativar e mudar perfil terminam as sessões; há sempre um gestor', async () => {
  const { server, login, db } = await boot();
  try {
    const g = await login('g@t.pt');
    const c = await login('c@t.pt');
    assert.equal((await c('GET', '/api/users')).status, 403);
    assert.equal((await c('POST', '/api/users', { name: 'X', email: 'x@t.pt', role: 'gestor' })).status, 403);
    assert.equal((await g('POST', '/api/users', { name: 'Sem del', email: 'sd@t.pt', role: 'coordenador' })).status, 422);
    assert.equal((await g('POST', '/api/users', { name: 'Rep', email: 'C@t.pt', role: 'administrativo' })).status, 422); // email repetido
    assert.equal((await g('POST', '/api/users', { name: 'Mau', email: 'nao-e-email', role: 'administrativo' })).status, 422);
    assert.equal((await g('POST', '/api/users', { name: 'Mau', email: 'm@t.pt', role: 'chefe' })).status, 422);
    const list = (await g('GET', '/api/users')).json;
    assert.ok(list.every((u) => !('pass_hash' in u)));
    const me = list.find((u) => u.email === 'g@t.pt'), coord = list.find((u) => u.email === 'c@t.pt');
    assert.equal((await g('PUT', `/api/users/${me.id}`, { active: 0 })).status, 422); // não se desativa a si próprio
    assert.equal((await g('PUT', `/api/users/${me.id}`, { role: 'administrativo' })).status, 422);
    // mudar perfil: a sessão aberta termina (as permissões novas valem já)
    assert.equal((await c('GET', '/api/data')).status, 200);
    assert.equal((await g('PUT', `/api/users/${coord.id}`, { role: 'administrativo', delegation: 'asturias' })).status, 200);
    assert.equal((await c('GET', '/api/data')).status, 401);
    const c2 = await login('c@t.pt');
    assert.equal((await c2('PUT', '/api/houses', { name: 'Z' })).status, 403); // agora só leitura
    // desativar: não entra mais
    assert.equal((await g('PUT', `/api/users/${coord.id}`, { active: 0 })).status, 200);
    assert.equal((await c2('GET', '/api/data')).status, 401);
    assert.equal((await login('c@t.pt')).status, 401);
    // há sempre pelo menos um gestor ativo
    const g2id = (await g('POST', '/api/users', { name: 'Gestor 2', email: 'g2@t.pt', role: 'gestor' })).json.id;
    assert.equal((await g('PUT', `/api/users/${g2id}`, { active: 0 })).status, 200);
    await db.run("UPDATE users SET active=0 WHERE email='g2@t.pt'");
    const audit = (await g('GET', '/api/audit')).json;
    assert.ok(audit.some((r) => /Utilizador «Coord» desativado/.test(r.summary)));
    assert.ok(audit.every((r) => !/pass_hash|scrypt/.test(r.changes ?? '')));
  } finally { server.close(); }
});

test('palavra-passe: o gestor repõe (temporária, só aparece uma vez, termina sessões); cada um muda a sua no menu', async () => {
  const { server, login } = await boot();
  try {
    const g = await login('g@t.pt');
    const c = await login('c@t.pt');
    const list = (await g('GET', '/api/users')).json;
    const coord = list.find((u) => u.email === 'c@t.pt'), me = list.find((u) => u.email === 'g@t.pt');
    assert.equal((await c('POST', `/api/users/${coord.id}/reset`, {})).status, 403); // só o gestor
    assert.equal((await g('POST', `/api/users/${me.id}/reset`, {})).status, 422); // a própria: usar «Mudar palavra-passe»
    const r = await g('POST', `/api/users/${coord.id}/reset`, {});
    assert.equal(r.status, 200); assert.match(r.json.tempPassword, /^\w{4}-\w{4}-\w{4}$/);
    assert.equal((await c('GET', '/api/data')).status, 401); // a sessão aberta terminou
    assert.equal((await login('c@t.pt', PW)).status, 401); // a antiga deixou de servir
    const c2 = await login('c@t.pt', r.json.tempPassword);
    assert.equal((await c2('GET', '/api/data')).json?.mustChange, true); // tem de escolher a sua
    assert.equal((await c2('POST', '/api/auth/password', { current: r.json.tempPassword, password: 'nova-do-coordenador' })).status, 200);
    // depois de entrar, muda a sua quando quiser (pede a atual)
    assert.equal((await c2('POST', '/api/auth/password', { current: 'errada', password: 'outra-palavra-passe' })).status, 403);
    assert.equal((await c2('POST', '/api/auth/password', { current: 'nova-do-coordenador', password: 'outra-palavra-passe' })).status, 200);
    assert.equal((await login('c@t.pt', 'outra-palavra-passe')).status, 200);
    assert.ok((await g('GET', '/api/audit')).json.some((x) => /Palavra-passe de «Coord» reposta/.test(x.summary)));
  } finally { server.close(); }
});
