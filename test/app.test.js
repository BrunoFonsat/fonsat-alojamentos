import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { upsertUser } from '../src/server/auth.js';

process.env.ALOJ_LOGIN_MAX = '1000';
const PW = 'Teste-Aloj-2026!';
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aloj-')), 't.sqlite');

async function boot() {
  const db = await openDb(tmpDb());
  await upsertUser(db, { email: 'gestor@t.pt', name: 'Gestor', password: PW, role: 'gestor' });
  await upsertUser(db, { email: 'ast@t.pt', name: 'Coord Ast', password: PW, role: 'coordenador', delegation: 'asturias' });
  await upsertUser(db, { email: 'cat@t.pt', name: 'Coord Cat', password: PW, role: 'coordenador', delegation: 'catalunha' });
  const server = http.createServer(createApp(db)); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '', csrf = '';
    const call = async (method, p, body) => {
      // entrada só com funcionário existente: nos testes, «worker_name» cria-o antes (como «Novo funcionário» na aplicação)
      if (method === 'POST' && p === '/api/stays/enter' && body?.worker_name && !body.worker_id) {
        const d = await call('GET', '/api/data');
        let w = d.json?.workers?.find((x) => x.name === body.worker_name);
        if (!w) w = { id: (await call('PUT', '/api/workers', { name: body.worker_name })).json?.id };
        const { worker_name: _n, ...rest } = body; body = { ...rest, worker_id: w.id };
      }
      const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    call.login = async (email) => { const r = await call('POST', '/api/auth/login', { email, password: PW }); csrf = r.json?.csrf; return r; };
    return call;
  };
  return { server, client, base, db };
}

test('login: palavra-passe errada recusada; sem sessão não há dados', async () => {
  const { server, client } = await boot();
  try {
    const c = client();
    assert.equal((await c('GET', '/api/data')).status, 401);
    assert.equal((await c.login('gestor@t.pt')).status, 200);
    const bad = client();
    assert.equal((await bad('POST', '/api/auth/login', { email: 'gestor@t.pt', password: 'errada' })).status, 401);
    const me = (await c('GET', '/api/auth/me')).json.user;
    assert.equal(me.role, 'gestor');
  } finally { server.close(); }
});

test('coordenador: só vê e altera a sua delegação; gestor vê tudo', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    const c = client(); await c.login('cat@t.pt');
    const hA = (await g('PUT', '/api/houses', { name: 'Oviedo 1', delegation: 'asturias', capacity: 2, rent: 500, fixed_expenses: 500 })).json.id;
    const hC = (await g('PUT', '/api/houses', { name: 'BCN 1', delegation: 'catalunha', capacity: 3 })).json.id;
    assert.equal((await g('PUT', '/api/houses', { name: 'oviedo 1', delegation: 'porto' })).status, 422); // nome repetido (sem distinguir maiúsculas)

    assert.deepEqual((await a('GET', '/api/data')).json.houses.map((x) => x.name), ['Oviedo 1']);
    assert.equal((await g('GET', '/api/data')).json.houses.length, 2);
    // coordenador das Astúrias não mexe na casa da Catalunha nem cria casas noutra delegação
    assert.ok([403, 404].includes((await a('PUT', '/api/houses', { id: hC, name: 'BCN 1', delegation: 'catalunha' })).status));
    assert.equal((await a('PUT', '/api/houses', { id: hC, name: 'BCN 1', delegation: 'asturias' })).status, 404); // nem «roubando» a casa para a sua delegação
    assert.equal((await a('DELETE', `/api/houses/${hC}`)).status, 404);
    assert.equal((await a('PUT', '/api/houses', { name: 'Intrusa', delegation: 'catalunha' })).status, 403);
    assert.equal((await a('POST', '/api/stays/enter', { house_id: hC, worker_name: 'X', date: '2026-01-01', reason: 'Obra' })).status, 404);
    // sem delegação no pedido, o coordenador cria na sua
    const hA2 = (await a('PUT', '/api/houses', { name: 'Gijón 1' })).json.id;
    assert.equal((await g('GET', '/api/data')).json.houses.find((x) => x.id === hA2).delegation, 'asturias');
    // transferência para outra delegação: o coordenador não pode
    const s = (await a('POST', '/api/stays/enter', { house_id: hA, worker_name: 'Ana', date: '2026-01-10', reason: 'Início de obra' })).json;
    assert.equal((await a('POST', '/api/stays/leave', { stay_id: s.id, date: '2026-02-01', reason: 'Transferência', to_house_id: hC })).status, 404);
    // o coordenador da Catalunha não vê a Ana nem a estadia
    const dc = (await c('GET', '/api/data')).json;
    assert.equal(dc.workers.length, 0); assert.equal(dc.stays.length, 0);
    // histórico também é filtrado
    assert.ok((await c('GET', '/api/audit')).json.every((r) => r.delegation === 'catalunha'));
  } finally { server.close(); }
});

test('entradas, saídas com motivo, transferência, sobreposição, acertos e histórico', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const h1 = (await g('PUT', '/api/houses', { name: 'Casa 1', delegation: 'asturias', capacity: 2, rent: 500, fixed_expenses: 500 })).json.id;
    const h2 = (await g('PUT', '/api/houses', { name: 'Casa 2', delegation: 'catalunha', capacity: 1 })).json.id;
    const E = (o) => g('POST', '/api/stays/enter', o);
    assert.equal((await E({ house_id: h1, worker_name: 'Ana', date: '2026-01-10', reason: '' })).status, 422); // motivo obrigatório
    const ana = (await E({ house_id: h1, worker_name: 'Ana', date: '2026-01-10', reason: 'Início de obra' })).json;
    const bruno = (await E({ house_id: h1, worker_name: 'Bruno', date: '2026-01-12', reason: 'Início de obra' })).json;
    const dup = await E({ house_id: h2, worker_id: ana.worker_id, date: '2026-02-01', reason: 'Obra' });
    assert.equal(dup.status, 422); assert.match(dup.json.error, /Casa 1/);
    // transferência: sai na véspera e entra na nova
    const L = (o) => g('POST', '/api/stays/leave', o);
    assert.equal((await L({ stay_id: ana.id, date: '2026-01-09', reason: 'X', to_house_id: h2 })).status, 422); // antes da entrada
    assert.equal((await L({ stay_id: ana.id, date: '2026-03-01', reason: 'Transferência', to_house_id: h2 })).json.transferred, true);
    let d = (await g('GET', '/api/data')).json;
    const old = d.stays.find((x) => x.id === ana.id), nw = d.stays.find((x) => x.worker_id === ana.worker_id && x.house_id === h2);
    assert.equal(old.end_date, '2026-03-01'); assert.equal(old.exit_reason, 'Transferência'); assert.equal(nw.start_date, '2026-03-01'); // sai e entra no mesmo dia
    assert.equal((await L({ stay_id: ana.id, date: '2026-04-01', reason: 'X' })).status, 422); // já saiu
    // transferência no próprio dia da entrada: sai logo do antigo (não conta lá nesse dia) e fica só no novo
    const h3 = (await g('PUT', '/api/houses', { name: 'Casa 3', delegation: 'asturias', capacity: 3 })).json.id;
    const carla = (await E({ house_id: h1, worker_name: 'Carla', date: '2026-06-01', reason: 'Início de obra' })).json;
    assert.equal((await L({ stay_id: carla.id, date: '2026-06-01', reason: 'Transferência', to_house_id: h3 })).json.transferred, true);
    d = (await g('GET', '/api/data')).json;
    const cs = d.stays.filter((x) => x.worker_id === carla.worker_id).sort((a, b) => a.id - b.id);
    assert.deepEqual(cs.map((x) => [x.house_id, x.start_date, x.end_date]), [[h1, '2026-06-01', '2026-06-01'], [h3, '2026-06-01', null]]);
    assert.equal((await L({ stay_id: bruno.id, date: '2026-01-01', reason: 'Fim' })).status, 422); // antes da entrada
    assert.equal((await L({ stay_id: bruno.id, date: '2026-05-31', reason: 'Fim de obra' })).json.transferred, false);
    // correção que criaria sobreposição é recusada
    assert.equal((await g('PUT', '/api/stays', { id: ana.id, house_id: h1, worker_id: ana.worker_id, start_date: '2026-01-10', entry_reason: 'Início', end_date: '2026-03-15', exit_reason: 'T' })).status, 422);
    // acerto de despesas (substitui o fixo nesse mês) e casa com campos inválidos
    assert.equal((await g('PUT', '/api/adjustments', { house_id: h1, month: '2026-03', value: '650,5' })).status, 200);
    assert.equal((await g('PUT', '/api/adjustments', { house_id: h1, month: '2026-03', value: '700' })).status, 200); // atualiza o mesmo mês
    d = (await g('GET', '/api/data')).json;
    assert.equal(d.adjustments.length, 1); assert.equal(d.adjustments[0].value, 700);
    assert.equal((await g('PUT', '/api/houses', { name: 'Má', delegation: 'porto', location_url: 'javascript:alert(1)' })).status, 422);
    assert.equal((await g('PUT', '/api/houses', { name: 'Má', delegation: 'porto', contract_start: '2026-05-01', contract_end: '2026-01-01' })).status, 422);
    // histórico regista quem fez e o que mudou
    await g('PUT', '/api/houses', { id: h1, name: 'Casa 1', delegation: 'asturias', capacity: 3, rent: 500, fixed_expenses: 500 });
    const au = (await g('GET', `/api/audit?house=${h1}`)).json;
    const upd = au.find((r) => r.entity === 'house' && r.action === 'update');
    assert.equal(upd.user_name, 'Gestor'); assert.deepEqual(JSON.parse(upd.changes).capacity, [2, 3]);
    assert.ok(au.some((r) => /Transferência de «Ana»/.test(r.summary)));
    // casa com histórico não se apaga (nem pelo gestor): inativa-se; nada do histórico se perde
    const del = await g('DELETE', `/api/houses/${h1}`);
    assert.equal(del.status, 409); assert.equal(del.json.hasHistory, true); assert.match(del.json.error, /inativar/);
    d = (await g('GET', '/api/data')).json;
    assert.ok(d.houses.some((x) => x.id === h1) && d.stays.some((x) => x.house_id === h1) && d.adjustments.length === 1);
  } finally { server.close(); }
});

test('pedidos de escrita sem CSRF são recusados; página e ficheiros servidos', async () => {
  const { server, client, base } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gestor@t.pt', password: PW }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await fetch(`${base}/api/houses`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'X', delegation: 'porto' }) });
    assert.equal(r.status, 403);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404); // ficheiros fora de public/ não são servidos
    assert.equal((await fetch(`${base}/nao-existe.js`)).status, 404);
  } finally { server.close(); }
});

test('mapa: coordenadas do link, pesquisa pela morada (serviço simulado), pino à mão manda', async () => {
  // serviço de moradas simulado: «Rua Encontrada» → coordenadas; o resto → sem resultado
  const queries = [];
  const geo = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('q'); queries.push(q);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(/Encontrada/.test(q) ? [{ lat: '43.36', lon: '-5.85' }] : []));
  });
  await new Promise((r) => geo.listen(0, '127.0.0.1', r));
  process.env.ALOJ_GEOCODER_URL = `http://127.0.0.1:${geo.address().port}/search`;
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    const H = async (o) => (await g('PUT', '/api/houses', o)).json.id;
    const get = async (id) => (await g('GET', '/api/data')).json.houses.find((x) => x.id === id);
    // link com coordenadas: pino imediato, sem pesquisa
    const h1 = await H({ name: 'Com link', delegation: 'asturias', location_url: 'https://www.google.com/maps/place/X/@43.5,-5.7,17z' });
    assert.deepEqual([(await get(h1)).lat, (await get(h1)).geo_source], [43.5, 'link']);
    // pela morada
    const h2 = await H({ name: 'Morada', delegation: 'asturias', address: 'Rua Encontrada 1' });
    const r = await g('POST', `/api/houses/${h2}/geocode`);
    assert.equal(r.status, 200); assert.equal(r.json.geo_source, 'auto'); assert.equal((await get(h2)).lat, 43.36);
    assert.deepEqual(queries, ['Rua Encontrada 1']); // só a morada sai para o serviço
    const h3 = await H({ name: 'Perdida', delegation: 'asturias', address: 'Rua Inexistente' });
    assert.equal((await g('POST', `/api/houses/${h3}/geocode`)).status, 422);
    // pino à mão: fica fixo, mesmo mudando a morada; outra delegação não pode mexer
    assert.equal((await g('PUT', `/api/houses/${h2}/position`, { lat: 91, lng: 0 })).status, 422);
    assert.equal((await g('PUT', `/api/houses/${h2}/position`, { lat: 43.4, lng: -5.9 })).json.geo_source, 'manual');
    await g('PUT', '/api/houses', { id: h2, name: 'Morada', delegation: 'asturias', address: 'Outra rua' });
    assert.deepEqual([(await get(h2)).lat, (await get(h2)).geo_source, (await get(h2)).geo_review], [43.4, 'manual', 1]); // mantido, mas por confirmar
    assert.equal((await g('POST', `/api/houses/${h2}/geocode`)).json.geo_source, 'manual'); // não pesquisa por cima do manual
    const hc = await H({ name: 'BCN', delegation: 'catalunha', address: 'Rua Encontrada 2' });
    assert.equal((await a('PUT', `/api/houses/${hc}/position`, { lat: 41, lng: 2 })).status, 404);
    assert.equal((await a('POST', `/api/houses/${hc}/geocode`)).status, 404);
    // pino automático: mudar a morada limpa-o para voltar a ser procurado
    await g('POST', `/api/houses/${hc}/geocode`);
    await g('PUT', '/api/houses', { id: hc, name: 'BCN', delegation: 'catalunha', address: 'Rua nova' });
    assert.equal((await get(hc)).lat, null);
    // remover pino
    assert.equal((await g('PUT', `/api/houses/${h2}/position`, { lat: null, lng: null })).json.lat, null);
  } finally { server.close(); geo.close(); delete process.env.ALOJ_GEOCODER_URL; }
});

test('código de autorização: coordenador edita/inativa/apaga/muda pino só com o código; cria sem código; gestor nunca precisa', async () => {
  const { server, client, db } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    // criar: coordenador sem código
    const id = (await a('PUT', '/api/houses', { name: 'Nova', capacity: 3 })).json.id;
    assert.ok(id);
    const edit = (c, extra) => c('PUT', '/api/houses', { id, name: 'Nova', delegation: 'asturias', capacity: 4, ...extra });
    // BD nova: não há código por omissão — nem o de teste serve até o gestor o definir
    assert.equal((await g('GET', '/api/data')).json.authCodeSet, false);
    const r0 = await edit(a, { auth_code: 'fonsat1234' });
    assert.equal(r0.status, 403); assert.match(r0.json.error, /ainda não o definiu/);
    assert.equal((await g('PUT', '/api/settings/auth-code', { code: 'fonsat1234' })).status, 200);
    assert.equal((await g('GET', '/api/data')).json.authCodeSet, true);
    // guardado em hash, nunca em texto
    const stored = (await db.get("SELECT value FROM settings WHERE key='auth_code'")).value;
    assert.ok(!stored.includes('fonsat1234') && stored.length > 40);
    // editar valores / inativar: precisa do código
    let r = await edit(a, {});
    assert.equal(r.status, 403); assert.equal(r.json.needAuth, true);
    assert.equal((await edit(a, { auth_code: 'errado' })).status, 403);
    assert.equal((await edit(a, { auth_code: 'fonsat1234', active: 0 })).status, 200);
    const au = (await g('GET', `/api/audit?house=${id}`)).json.find((x) => x.action === 'update');
    assert.match(au.summary, /inativada.*autorizado com o código do gestor/);
    // gestor edita sem código
    assert.equal((await edit(g, { active: 1 })).status, 200);
    // pino: o primeiro é livre; mudar pede código
    assert.equal((await a('PUT', `/api/houses/${id}/position`, { lat: 43.3, lng: -5.8 })).status, 200);
    assert.equal((await a('PUT', `/api/houses/${id}/position`, { lat: 43.4, lng: -5.8 })).status, 403);
    assert.equal((await a('PUT', `/api/houses/${id}/position`, { lat: 43.4, lng: -5.8, auth_code: 'fonsat1234' })).status, 200);
    assert.equal((await g('PUT', `/api/houses/${id}/position`, { lat: 43.5, lng: -5.8 })).status, 200);
    // gestor muda o código; o antigo deixa de servir; coordenador não pode mudar o código
    assert.equal((await a('PUT', '/api/settings/auth-code', { code: 'qualquer1' })).status, 403);
    assert.equal((await g('PUT', '/api/settings/auth-code', { code: '123' })).status, 422);
    assert.equal((await g('PUT', '/api/settings/auth-code', { code: 'novo-codigo' })).status, 200);
    assert.equal((await edit(a, { auth_code: 'fonsat1234' })).status, 403);
    // apagar: sem código não; com o código novo sim
    assert.equal((await a('DELETE', `/api/houses/${id}`)).status, 403);
    assert.equal((await a('POST', `/api/houses/${id}/delete`, { auth_code: 'novo-codigo' })).status, 200);
  } finally { server.close(); }
});

test('dados de teste: criam-se numa BD vazia e recusam BD com dados (sem --reset)', () => {
  const file = tmpDb();
  const env = { ...process.env, ALOJ_DB: file };
  const out = execFileSync(process.execPath, ['scripts/seed-demo.js'], { env, encoding: 'utf8' });
  assert.match(out, /13 casas/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/seed-demo.js'], { env, encoding: 'utf8', stdio: 'pipe' }));
  assert.match(execFileSync(process.execPath, ['scripts/seed-demo.js', '--reset'], { env, encoding: 'utf8' }), /13 casas/);
});

test('código: tentativas erradas limitadas (8 em 15 min), mesmo acertando depois', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    await g('PUT', '/api/settings/auth-code', { code: 'codigo-certo' });
    const id = (await a('PUT', '/api/houses', { name: 'Limite' })).json.id;
    const edit = (code) => a('PUT', '/api/houses', { id, name: 'Limite', delegation: 'asturias', auth_code: code });
    for (let i = 0; i < 8; i++) assert.equal((await edit(`errado-${i}`)).status, 403);
    assert.equal((await edit('codigo-certo')).status, 429); // bloqueado: o código certo também não passa
    assert.equal((await g('PUT', '/api/houses', { id, name: 'Limite', delegation: 'asturias', rent: 1 })).status, 200); // gestor não é afetado
  } finally { server.close(); }
});

test('movimentos: entradas, saídas, transferências e despesas sem código; correções e apagar registos com código', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    await g('PUT', '/api/settings/auth-code', { code: 'codigo-certo' });
    const h1 = (await a('PUT', '/api/houses', { name: 'M1', capacity: 2 })).json.id;
    const h2 = (await a('PUT', '/api/houses', { name: 'M2', capacity: 2 })).json.id;
    // sem código
    const s = await a('POST', '/api/stays/enter', { house_id: h1, worker_name: 'Teste Um', date: '2026-01-10', reason: 'Início de obra' });
    assert.equal(s.status, 200);
    assert.equal((await a('POST', '/api/stays/leave', { stay_id: s.json.id, date: '2026-02-01', reason: 'Transferência', to_house_id: h2 })).status, 200);
    assert.equal((await a('PUT', '/api/adjustments', { house_id: h1, month: '2026-01', value: 300 })).status, 200);
    // correção de um registo: código
    const fix = { id: s.json.id, house_id: h1, worker_id: s.json.worker_id, start_date: '2026-01-11', entry_reason: 'Início de obra', end_date: '2026-01-31', exit_reason: 'Transferência' };
    const r = await a('PUT', '/api/stays', fix);
    assert.equal(r.status, 403); assert.equal(r.json.needAuth, true);
    assert.equal((await a('PUT', '/api/stays', { ...fix, auth_code: 'errado' })).status, 403);
    assert.equal((await a('PUT', '/api/stays', { ...fix, auth_code: 'codigo-certo' })).status, 200);
    assert.equal((await g('PUT', '/api/stays', { ...fix, start_date: '2026-01-10' })).status, 200); // gestor sem código
    const au = (await g('GET', `/api/audit?house=${h1}`)).json;
    assert.ok(au.some((x) => /corrigido \(autorizado com o código do gestor\)/.test(x.summary)));
    // apagar registo: código (DELETE sem corpo é recusado ao coordenador; POST …/delete com código passa)
    assert.equal((await a('DELETE', `/api/stays/${s.json.id}`)).status, 403);
    assert.equal((await a('POST', `/api/stays/${s.json.id}/delete`, { auth_code: 'codigo-certo' })).status, 200);
    // funcionário com histórico não se apaga
    const d = (await g('GET', '/api/data')).json;
    const w = d.workers.find((x) => x.name === 'Teste Um');
    const dw = await g('DELETE', `/api/workers/${w.id}`);
    assert.equal(dw.status, 409); assert.equal(dw.json.hasHistory, true);
    // casa sem histórico apaga-se (coordenador com código); com histórico, nem com código
    const h3 = (await a('PUT', '/api/houses', { name: 'Sem histórico' })).json.id;
    assert.equal((await a('POST', `/api/houses/${h3}/delete`, { auth_code: 'codigo-certo' })).status, 200);
    const dh = await a('POST', `/api/houses/${h2}/delete`, { auth_code: 'codigo-certo' });
    assert.equal(dh.status, 409); assert.match(dh.json.error, /Alojamento ativo/);
    // inativar continua possível (com código)
    assert.equal((await a('PUT', '/api/houses', { id: h2, name: 'M2', delegation: 'asturias', capacity: 2, active: 0, auth_code: 'codigo-certo' })).status, 200);
  } finally { server.close(); }
});

test('pinos: coordenadas mantidas sem mudança de morada; pino manual nunca substituído; confirmar sem código', async () => {
  const queries = [];
  const geo = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('q'); queries.push(q);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(/Rua A/.test(q) ? [{ lat: '43.1', lon: '-5.1' }] : /Rua B/.test(q) ? [{ lat: '43.2', lon: '-5.2' }] : []));
  });
  await new Promise((r) => geo.listen(0, '127.0.0.1', r));
  process.env.ALOJ_GEOCODER_URL = `http://127.0.0.1:${geo.address().port}/search`;
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    await g('PUT', '/api/settings/auth-code', { code: 'codigo-certo' });
    const get = async (id) => (await g('GET', '/api/data')).json.houses.find((x) => x.id === id);
    const id = (await a('PUT', '/api/houses', { name: 'P1', address: 'Rua A 1' })).json.id;
    await a('POST', `/api/houses/${id}/geocode`);
    assert.deepEqual([(await get(id)).lat, (await get(id)).geo_source], [43.1, 'auto']);
    // editar outros campos (mesma morada): pino igual e sem nova pesquisa
    await g('PUT', '/api/houses', { id, name: 'P1', delegation: 'asturias', address: 'Rua A 1', rent: 700 });
    assert.equal((await get(id)).lat, 43.1);
    assert.equal((await g('POST', `/api/houses/${id}/geocode`)).json.lat, 43.1); // já tem pino: não volta a pesquisar
    assert.equal(queries.length, 1);
    // pino à mão (coordenador, já havia pino → código)
    assert.equal((await a('PUT', `/api/houses/${id}/position`, { lat: 43.15, lng: -5.15, auth_code: 'codigo-certo' })).status, 200);
    // mudar a morada: o pino manual fica onde está, marcado «por confirmar»; a pesquisa não o substitui
    await g('PUT', '/api/houses', { id, name: 'P1', delegation: 'asturias', address: 'Rua B 2' });
    let x = await get(id);
    assert.deepEqual([x.lat, x.lng, x.geo_source, x.geo_review], [43.15, -5.15, 'manual', 1]);
    assert.equal((await g('POST', `/api/houses/${id}/geocode`)).json.lat, 43.15);
    // «Procurar pela morada» só pré-visualiza: não grava
    assert.equal((await g('POST', `/api/houses/${id}/geocode?preview=1`)).json.lat, 43.2);
    assert.equal((await get(id)).lat, 43.15);
    // link novo com pino manual: também não substitui, fica por confirmar
    await g('PUT', `/api/houses/${id}/position`, { lat: 43.15, lng: -5.15 }); // gestor confirma
    assert.equal((await get(id)).geo_review, 0);
    await g('PUT', '/api/houses', { id, name: 'P1', delegation: 'asturias', address: 'Rua B 2', location_url: 'https://www.google.com/maps/@43.9,-5.9,17z' });
    x = await get(id);
    assert.deepEqual([x.lat, x.geo_source, x.geo_review], [43.15, 'manual', 1]);
    // coordenador confirma no mesmo sítio sem código; mudar de sítio continua a pedir código
    assert.equal((await a('PUT', `/api/houses/${id}/position`, { lat: 43.15, lng: -5.15 })).status, 200);
    assert.equal((await get(id)).geo_review, 0);
    assert.ok((await g('GET', `/api/audit?house=${id}`)).json.some((y) => /confirmada/.test(y.summary)));
    assert.equal((await a('PUT', `/api/houses/${id}/position`, { lat: 43.3, lng: -5.3 })).status, 403);
  } finally { server.close(); geo.close(); delete process.env.ALOJ_GEOCODER_URL; }
});

test('casa: código interno único e dia de vencimento entre 1 e 31', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const id = (await g('PUT', '/api/houses', { name: 'C1', delegation: 'asturias', code: 'AS-001', rent_due_day: 5 })).json.id;
    const x = (await g('GET', '/api/data')).json.houses.find((y) => y.id === id);
    assert.deepEqual([x.code, x.rent_due_day], ['AS-001', 5]);
    assert.equal((await g('PUT', '/api/houses', { name: 'C2', delegation: 'asturias', code: 'as-001' })).status, 422);
    assert.equal((await g('PUT', '/api/houses', { name: 'C3', delegation: 'asturias', rent_due_day: 32 })).status, 422);
    assert.equal((await g('PUT', '/api/houses', { name: 'C4', delegation: 'asturias', rent_due_day: 0 })).status, 422);
  } finally { server.close(); }
});

test('importação de casas: cria com código, vencimento e notas da origem; ignora repetidas; --substituir só apaga a delegação', async () => {
  const file = tmpDb();
  const env = { ...process.env, ALOJ_DB: file };
  execFileSync(process.execPath, ['scripts/seed-demo.js'], { env, encoding: 'utf8' });
  const json = path.join(path.dirname(file), 'imp.json');
  fs.writeFileSync(json, JSON.stringify({ source: 'teste', delegation: 'asturias', houses: [
    { code: 'AS-901', name: 'PISO TESTE', region: 'Langreo', address: 'Calle Falsa 1', capacity: 4, rent: 600, occ: 3, free: 1, due: 20, ref: 'X!A1', obs: 'Confirmar renda.' },
    { code: 'AS-902', name: 'HOTEL TESTE', region: 'Grado', address: '', capacity: null, rent: null, occ: null, free: null, due: null, ref: 'X!B1', obs: '' },
  ] }));
  const out = execFileSync(process.execPath, ['scripts/import-houses.js', json, '--substituir', '--sem-mapa'], { env, encoding: 'utf8' });
  assert.match(out, /2 casas importadas/);
  const db = await openDb(file);
  const ast = await db.all("SELECT * FROM houses WHERE delegation='asturias' ORDER BY code");
  assert.deepEqual(ast.map((x) => x.code), ['AS-901', 'AS-902']); // as casas de teste de Astúrias foram substituídas
  assert.deepEqual([ast[0].rent_due_day, ast[0].capacity, ast[0].lat], [20, 4, null]);
  assert.match(ast[0].notes, /3 ocupados, 1 livre.*Confirmar renda/);
  assert.equal((await db.get("SELECT COUNT(*) n FROM houses WHERE delegation<>'asturias'")).n, 8); // Catalunha e Porto intactas
  assert.equal((await db.get("SELECT COUNT(*) n FROM stays s JOIN houses h ON h.id=s.house_id WHERE h.delegation='asturias'")).n, 0);
  db.client.close();
  // segunda vez: nada novo
  assert.match(execFileSync(process.execPath, ['scripts/import-houses.js', json, '--sem-mapa'], { env, encoding: 'utf8' }), /0 casas importadas/);
});

test('importação de ocupantes: entra pelo código da casa, reutiliza funcionários e não aloja a mesma pessoa duas vezes', async () => {
  const file = tmpDb();
  const db = await openDb(file);
  await db.run("INSERT INTO houses(name,code,delegation) VALUES('A','AS-1','asturias'),('B','AS-2','asturias'),('C','CT-1','catalunha')");
  db.client.close();
  const json = path.join(path.dirname(file), 'occ.json');
  fs.writeFileSync(json, JSON.stringify({ delegation: 'asturias', date: '2026-11-26', reason: 'Situação inicial', dated_reason: 'Início de contrato',
    houses: { 'AS-1': ['PESSOA UM', ['PESSOA DOIS', '2026-09-09']], 'AS-2': ['pessoa um'], 'CT-1': ['PESSOA TRÊS'], 'AS-9': ['X'] } }));
  const env = { ...process.env, ALOJ_DB: file };
  let out = '';
  try { execFileSync(process.execPath, ['scripts/import-occupants.js', json], { env, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = e.stdout; }
  assert.match(out, /2 entradas registadas/);
  assert.match(out, /aparece em AS-1 e em AS-2/); assert.match(out, /CT-1: casa de outra delegação/); assert.match(out, /AS-9: casa inexistente/);
  const db2 = await openDb(file);
  const st = await db2.all('SELECT w.name, s.start_date, s.entry_reason FROM stays s JOIN workers w ON w.id=s.worker_id ORDER BY w.name');
  assert.deepEqual(st.map((x) => [x.name, x.start_date, x.entry_reason]), [['PESSOA DOIS', '2026-09-09', 'Início de contrato'], ['PESSOA UM', '2026-11-26', 'Situação inicial']]);
  db2.client.close();
  // segunda vez: já alojados, nada novo
  try { out = execFileSync(process.execPath, ['scripts/import-occupants.js', json], { env, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = e.stdout; }
  assert.match(out, /0 entradas registadas/);
});

test('transferência no servidor: destino inativo recusado; acima da lotação só com confirmação; lotação à data; coordenador sem código', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    const H = async (o) => (await a('PUT', '/api/houses', o)).json.id;
    const orig = await H({ name: 'T-orig', capacity: 3 });
    const full = await H({ name: 'T-cheia', capacity: 1 });
    const off = await H({ name: 'T-inativa', capacity: 5 });
    await g('PUT', '/api/houses', { id: off, name: 'T-inativa', delegation: 'asturias', capacity: 5, active: 0 });
    const E = async (house_id, worker_name, date) => (await a('POST', '/api/stays/enter', { house_id, worker_name, date, reason: 'Início de obra' })).json;
    const p = await E(orig, 'Pessoa T', '2026-01-10');
    await E(full, 'Ocupante', '2026-01-01');
    const L = (o) => a('POST', '/api/stays/leave', { stay_id: p.id, reason: 'Transferência', ...o });
    // inativa e a própria casa
    assert.match((await L({ date: '2026-02-01', to_house_id: off })).json.error, /inativo/);
    assert.equal((await L({ date: '2026-02-01', to_house_id: orig })).status, 422);
    // cheia: pede confirmação explícita, com a ocupação resultante
    const r = await L({ date: '2026-02-01', to_house_id: full });
    assert.equal(r.status, 409); assert.equal(r.json.needConfirm, true); assert.deepEqual([r.json.used, r.json.cap], [1, 1]);
    assert.match(r.json.error, /2 pessoas para 1 camas/);
    assert.equal((await L({ date: '2026-02-01', to_house_id: full, confirm_over: 'sim' })).status, 409); // só true conta
    // nada mudou enquanto não confirmou
    assert.equal((await g('GET', '/api/data')).json.stays.find((s) => s.id === p.id).end_date, null);
    const ok = await L({ date: '2026-02-01', to_house_id: full, confirm_over: true }); // coordenador, sem código do gestor
    assert.equal(ok.status, 200);
    const au = (await g('GET', `/api/audit?house=${orig}`)).json;
    assert.ok(au.some((x) => /acima da lotação: 2 pessoas para 1 camas, confirmado/.test(x.summary)));
    // lotação à data: quem já saiu antes da data não conta
    const p2 = await E(orig, 'Pessoa T2', '2026-01-10');
    const freeLater = await H({ name: 'T-livre-depois', capacity: 1 });
    const o2 = await E(freeLater, 'Sai em março', '2026-01-01');
    await a('POST', '/api/stays/leave', { stay_id: o2.id, date: '2026-03-31', reason: 'Fim de obra' });
    assert.equal((await a('POST', '/api/stays/leave', { stay_id: p2.id, date: '2026-04-15', reason: 'Transferência', to_house_id: freeLater })).status, 200);
  } finally { server.close(); }
});

test('funcionários pendentes: sem delegação, visíveis aos coordenadores; ao entrar numa casa ficam com a delegação dela', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    const c = client(); await c.login('cat@t.pt');
    const r = await g('PUT', '/api/workers', { name: 'PENDENTE UM', phone: '+351 900 000 000', profession: 'ENCONFRADOR', delegation: '' });
    assert.equal(r.status, 200);
    let w = (await g('GET', '/api/data')).json.workers.find((x) => x.id === r.json.id);
    assert.deepEqual([w.delegation, w.profession, w.phone], [null, 'ENCONFRADOR', '+351 900 000 000']);
    assert.ok((await a('GET', '/api/data')).json.workers.some((x) => x.id === w.id)); // coordenadores veem os pendentes
    assert.ok((await c('GET', '/api/data')).json.workers.some((x) => x.id === w.id));
    // coordenador não muda a delegação de ninguém
    await a('PUT', '/api/workers', { id: w.id, name: 'PENDENTE UM', delegation: 'asturias', profession: 'PEDREIRO - OF' });
    w = (await g('GET', '/api/data')).json.workers.find((x) => x.id === w.id);
    assert.deepEqual([w.delegation, w.profession], [null, 'PEDREIRO - OF']);
    // entrada numa casa das Astúrias: deixa de ser pendente; o coordenador da Catalunha deixa de o ver
    const h = (await a('PUT', '/api/houses', { name: 'Casa P', capacity: 2 })).json.id;
    assert.equal((await a('POST', '/api/stays/enter', { house_id: h, worker_id: w.id, date: '2026-11-26', reason: 'Início de obra' })).status, 200);
    assert.equal((await g('GET', '/api/data')).json.workers.find((x) => x.id === w.id).delegation, 'asturias');
    assert.ok(!(await c('GET', '/api/data')).json.workers.some((x) => x.id === w.id));
  } finally { server.close(); }
});

test('importação de funcionários: não repete (nomes iguais ou parecidos), atualiza telefone e profissão, cria o resto como pendente', async () => {
  const file = tmpDb();
  const db = await openDb(file);
  await db.run("INSERT INTO houses(name,code,delegation) VALUES('A','AS-1','asturias')");
  await db.run("INSERT INTO workers(name,delegation) VALUES('RUBEN FERNANDO LIARTE TESTE','asturias'),('JOEL ANTUNES','asturias'),('Pedro Santos','porto')");
  await db.run("INSERT INTO stays(house_id,worker_id,start_date,entry_reason) VALUES(1,1,'2026-11-26','x')");
  db.client.close();
  const md = path.join(path.dirname(file), 'w.md');
  fs.writeFileSync(md, ['| Funcionário | Profissão | Telefone |', '|---|---|---|',
    '| RUBEN FERNANDO LIJARTE TESTE | PEDREIRO - OF | +351 900 000 001 |', '| JOEL ANTUNES SERRA | ENCONFRADOR | |',
    '| GABRIEL TESTE DOS SANTOS PEDRO | PEDREIRO - OF | +34 624 |', '| NOVO NOME | Limpeza | 912?? |', '| NOVO NOME | Limpeza | 912 |'].join('\n'));
  const out = execFileSync(process.execPath, ['scripts/import-workers.js', md, '--comparar-com=asturias,catalunha'], { env: { ...process.env, ALOJ_DB: file }, encoding: 'utf8' });
  assert.match(out, /2 atualizados, 2 criados como pendentes/);
  const db2 = await openDb(file);
  const ws = await db2.all('SELECT name, delegation, profession, phone FROM workers ORDER BY id');
  assert.deepEqual(ws.map((w) => [w.name, w.delegation, w.profession, w.phone]), [
    ['RUBEN FERNANDO LIJARTE TESTE', 'asturias', 'PEDREIRO - OF', '+351 900 000 001'],
    ['JOEL ANTUNES SERRA', 'asturias', 'ENCONFRADOR', ''],
    ['Pedro Santos', 'porto', '', ''], // não comparado (outra delegação) nem juntado
    ['GABRIEL TESTE DOS SANTOS PEDRO', null, 'PEDREIRO - OF', '+34 624'],
    ['NOVO NOME', null, 'LIMPEZA', '912'], // repetido na lista: só uma vez
  ]);
  assert.equal((await db2.get('SELECT COUNT(*) n FROM stays WHERE worker_id=1')).n, 1); // continua alojado
  db2.client.close();
});

test('edifício: andares com o mesmo edifício partilham a localização (mudar um move os outros da mesma delegação)', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const H = async (o) => (await g('PUT', '/api/houses', { delegation: 'catalunha', ...o })).json.id;
    const f1 = await H({ name: 'V 1º', building: 'C/ Vallés 6' });
    const f2 = await H({ name: 'V 2º', building: 'c/ vallés 6' }); // sem distinguir maiúsculas
    const other = await H({ name: 'Outra', building: '' });
    const ast = (await g('PUT', '/api/houses', { name: 'Mesmo nome noutra delegação', delegation: 'asturias', building: 'C/ Vallés 6' })).json.id;
    assert.equal((await g('PUT', `/api/houses/${f1}/position`, { lat: 41.62, lng: 0.62 })).status, 200);
    const hs = (await g('GET', '/api/data')).json.houses;
    const at = (id) => { const x = hs.find((y) => y.id === id); return [x.lat, x.lng]; };
    assert.deepEqual(at(f1), [41.62, 0.62]);
    assert.deepEqual(at(f2), [41.62, 0.62]);
    assert.deepEqual(at(other), [null, null]);
    assert.deepEqual(at(ast), [null, null]);
    assert.equal(hs.find((y) => y.id === f1).building, 'C/ Vallés 6');
    assert.ok((await g('GET', `/api/audit?house=${f2}`)).json.some((r) => /edifício «C\/ Vallés 6», alterado a partir de «V 1º»/.test(r.summary))); // histórico também no outro andar
  } finally { server.close(); }
});

test('edifício e código: coordenador não move o edifício sem código, nem através de um andar novo sem pino; histórico em cada andar', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    await g('PUT', '/api/settings/auth-code', { code: 'codigo-certo' });
    const f1 = (await a('PUT', '/api/houses', { name: 'E 1º', building: 'Ed. Teste' })).json.id;
    // primeiro pino do edifício: livre
    assert.equal((await a('PUT', `/api/houses/${f1}/position`, { lat: 43.1, lng: -5.1 })).status, 200);
    // andar novo no mesmo edifício (criar não pede código): herda logo o pino do edifício
    const f2 = (await a('PUT', '/api/houses', { name: 'E 2º', building: 'ed. teste' })).json.id;
    let hs = (await g('GET', '/api/data')).json.houses;
    assert.deepEqual([hs.find((x) => x.id === f2).lat, hs.find((x) => x.id === f2).lng], [43.1, -5.1]);
    // a falha que se fecha: mover o edifício a partir de um andar (mesmo que esse andar ainda não tivesse pino) pede código
    await g('PUT', `/api/houses/${f2}/position`, { lat: null, lng: null }); // gestor limpa o edifício…
    await g('PUT', `/api/houses/${f1}/position`, { lat: 43.1, lng: -5.1 }); // …e volta a pôr o pino só a partir do 1.º (move os dois)
    const f3 = (await g('PUT', '/api/houses', { name: 'E 3º', delegation: 'asturias' })).json.id; // sem edifício e sem pino
    await g('PUT', '/api/houses', { id: f3, name: 'E 3º', delegation: 'asturias', building: 'Ed. Teste' }); // passa a andar do edifício
    hs = (await g('GET', '/api/data')).json.houses;
    assert.equal(hs.find((x) => x.id === f3).lat, 43.1); // herdou o pino ao entrar no edifício
    const r = await a('PUT', `/api/houses/${f3}/position`, { lat: 43.5, lng: -5.5 });
    assert.equal(r.status, 403); assert.equal(r.json.needAuth, true); assert.match(r.json.error, /edifício «Ed\. Teste»/);
    // confirmar no mesmo sítio: sem código
    assert.equal((await a('PUT', `/api/houses/${f3}/position`, { lat: 43.1, lng: -5.1 })).status, 200);
    // com código: move os três andares e cada um fica com o seu registo no histórico
    assert.equal((await a('PUT', `/api/houses/${f3}/position`, { lat: 43.5, lng: -5.5, auth_code: 'codigo-certo' })).status, 200);
    hs = (await g('GET', '/api/data')).json.houses;
    for (const id of [f1, f2, f3]) assert.deepEqual([hs.find((x) => x.id === id).lat, hs.find((x) => x.id === id).lng], [43.5, -5.5]);
    for (const id of [f1, f2]) {
      const au = (await g('GET', `/api/audit?house=${id}`)).json;
      assert.ok(au.some((x) => /alterada \(edifício «Ed\. Teste», alterado a partir de «E 3º»\) \(autorizado com o código do gestor\)/.test(x.summary)), `histórico do andar ${id}`);
    }
    // apagar o pino do edifício também pede código
    assert.equal((await a('PUT', `/api/houses/${f1}/position`, { lat: null, lng: null })).status, 403);
  } finally { server.close(); }
});

test('ocupação desconhecida: casa sem registos só deixa de estar «por confirmar» quando se confirma que está vazia', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    const id = (await a('PUT', '/api/houses', { name: 'Sem registos', capacity: 4 })).json.id;
    const get = async () => (await g('GET', '/api/data')).json.houses.find((x) => x.id === id);
    assert.equal((await get()).occ_checked, null);
    // coordenador confirma sem código; fica no histórico
    const r = await a('POST', `/api/houses/${id}/confirm-empty`, {});
    assert.equal(r.status, 200);
    assert.match((await get()).occ_checked, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok((await g('GET', `/api/audit?house=${id}`)).json.some((x) => /Confirmado que «Sem registos» está vazio/.test(x.summary)));
    // com alguém lá dentro, não se pode confirmar vazia
    const today = new Date().toISOString().slice(0, 10);
    await a('POST', '/api/stays/enter', { house_id: id, worker_name: 'Alguém', date: today, reason: 'Início de obra' });
    assert.equal((await a('POST', `/api/houses/${id}/confirm-empty`, {})).status, 422);
    // outra delegação não
    const c = client(); await c.login('cat@t.pt');
    assert.equal((await c('POST', `/api/houses/${id}/confirm-empty`, {})).status, 404);
  } finally { server.close(); }
});

test('entradas por nome de outra origem: só associa sem ambiguidade; não cria pessoas nem casas; não repete', async () => {
  const file = tmpDb();
  const db = await openDb(file);
  await db.run("INSERT INTO houses(name,code,delegation) VALUES('CASA A','CT-1','catalunha'),('CASA AST','AS-1','asturias')");
  await db.run("INSERT INTO workers(name,delegation) VALUES('TOMAS BELMIRO',NULL),('DAMIAO ROMEIRO GRACIOSO',NULL),('KEVIN MONTANHA PIRES DOS RAMALHOS',NULL),('JOSE SILVA',NULL),('JOSE SILVA',NULL),('JA ALOJADO',NULL)");
  await db.run("INSERT INTO stays(house_id,worker_id,start_date,entry_reason) VALUES(2,6,'2026-01-01','x')");
  db.client.close();
  const json = path.join(path.dirname(file), 's.json');
  fs.writeFileSync(json, JSON.stringify({ delegation: 'catalunha', date: '2026-11-23', reason: 'Controlo 23/11', houses: { 'CASA A ORIGEM': 'CT-1', 'CASA AST': 'AS-1' },
    aliases: { 'KEVIN MONTANHA': 'KEVIN MONTANHA PIRES DOS RAMALHOS' },
    rows: [['BELMIRO TOMAS', 'CASA A ORIGEM'], ['DAMIAO ROMEIRO GARCIOSO', 'CASA A ORIGEM'], ['KEVIN MONTANHA', 'CASA A ORIGEM'],
      ['JOSE SILVA', 'CASA A ORIGEM'], ['NINGUEM CONHECIDO', 'CASA A ORIGEM'], ['JA ALOJADO', 'CASA A ORIGEM'], ['TOMAS BELMIRO', 'CASA A ORIGEM'],
      ['DAMIAO ROMEIRO GRACIOSO', 'CASA AST'], ['OUTRO', 'CASA INEXISTENTE']] }));
  const env = { ...process.env, ALOJ_DB: file };
  const out = execFileSync(process.execPath, ['scripts/import-stays-by-name.js', json], { env, encoding: 'utf8' });
  assert.match(out, /a dar entrada: 3 /);
  assert.match(out, /2 funcionários com o nome «JOSE SILVA»/); // ambíguo: não associa
  assert.match(out, /NINGUEM CONHECIDO → CT-1/); // desconhecido: não cria
  assert.match(out, /JA ALOJADO: está em AS-1/); // conflito: não mexe
  assert.match(out, /CASA INEXISTENTE/); assert.match(out, /CASA AST/); // casa de outra delegação / inexistente
  const db2 = await openDb(file);
  assert.equal((await db2.get('SELECT COUNT(*) n FROM workers')).n, 6);
  const st = await db2.all("SELECT w.name, w.delegation, s.start_date FROM stays s JOIN workers w ON w.id=s.worker_id WHERE s.house_id=1 ORDER BY w.name");
  assert.deepEqual(st.map((x) => [x.name, x.delegation, x.start_date]), [
    ['DAMIAO ROMEIRO GRACIOSO', 'catalunha', '2026-11-23'], ['KEVIN MONTANHA PIRES DOS RAMALHOS', 'catalunha', '2026-11-23'], ['TOMAS BELMIRO', 'catalunha', '2026-11-23']]);
  db2.client.close();
  assert.match(execFileSync(process.execPath, ['scripts/import-stays-by-name.js', json], { env, encoding: 'utf8' }), /a dar entrada: 0 · já estavam: 3/);
});

test('dar entrada: só com funcionário existente (o nome sozinho não cria ninguém)', async () => {
  const { server, client, base } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const h = (await g('PUT', '/api/houses', { name: 'Casa E', delegation: 'asturias', capacity: 2 })).json.id;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gestor@t.pt', password: PW }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrf;
    const r = await fetch(`${base}/api/stays/enter`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: JSON.stringify({ house_id: h, worker_name: 'Ninguém Novo', date: '2026-11-26', reason: 'Início de obra' }) });
    assert.equal(r.status, 422); assert.match((await r.json()).error, /Novo funcionário/);
    assert.equal((await g('GET', '/api/data')).json.workers.length, 0);
  } finally { server.close(); }
});

test('alojamento próprio: marca-se no funcionário; dar entrada num alojamento tira-o', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const id = (await g('PUT', '/api/workers', { name: 'PESSOA PROPRIA', delegation: '', own_housing: 1 })).json.id;
    let w = (await g('GET', '/api/data')).json.workers.find((x) => x.id === id);
    assert.deepEqual([w.own_housing, w.delegation], [1, null]);
    await g('PUT', '/api/workers', { id, name: 'PESSOA PROPRIA', delegation: '', own_housing: 0 });
    assert.equal((await g('GET', '/api/data')).json.workers.find((x) => x.id === id).own_housing, 0);
    await g('PUT', '/api/workers', { id, name: 'PESSOA PROPRIA', delegation: '', own_housing: 1 });
    const h = (await g('PUT', '/api/houses', { name: 'Casa P', delegation: 'porto', capacity: 2 })).json.id;
    assert.equal((await g('POST', '/api/stays/enter', { house_id: h, worker_id: id, date: '2026-11-26', reason: 'Início de obra' })).status, 200);
    w = (await g('GET', '/api/data')).json.workers.find((x) => x.id === id);
    assert.deepEqual([w.own_housing, w.delegation], [0, 'porto']);
  } finally { server.close(); }
});

test('quartos: lotação = soma das camas; criar/alterar pede código ao coordenador; entrada e mudança de quarto sem código; não se apaga com histórico', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    await g('PUT', '/api/settings/auth-code', { code: 'codigo-certo' });
    const h = (await a('PUT', '/api/houses', { name: 'Hotel Q', capacity: 99 })).json.id;
    const cap = async () => (await g('GET', '/api/data')).json.houses.find((x) => x.id === h);
    // coordenador: quartos mudam a lotação → código
    let r = await a('PUT', '/api/rooms', { house_id: h, name: 'Habitación 1', beds: 3 });
    assert.equal(r.status, 403); assert.equal(r.json.needAuth, true);
    assert.equal((await a('PUT', '/api/rooms', { house_id: h, name: 'Habitación 1', beds: 3, auth_code: 'codigo-certo' })).status, 200);
    assert.equal((await g('POST', '/api/rooms/bulk', { house_id: h, prefix: 'Habitación', from: 1, to: 3, beds: 2 })).json.created, 2); // a 1 já existia
    assert.deepEqual([(await cap()).capacity, (await cap()).rooms], [7, 3]); // 3 + 2 + 2
    assert.equal((await g('PUT', '/api/rooms', { house_id: h, name: 'habitación 2', beds: 1 })).status, 422); // nome repetido
    // o formulário não muda a lotação de um alojamento com quartos
    await g('PUT', '/api/houses', { id: h, name: 'Hotel Q', delegation: 'asturias', capacity: 50 });
    assert.equal((await cap()).capacity, 7);
    const rooms = (await g('GET', '/api/data')).json.rooms.filter((x) => x.house_id === h);
    const r1 = rooms.find((x) => x.name === 'Habitación 1'), r2 = rooms.find((x) => x.name === 'Habitación 2');
    // entrada com quarto e mudança de quarto: sem código
    const s1 = (await a('POST', '/api/stays/enter', { house_id: h, worker_name: 'HOSPEDE UM', date: '2026-11-26', reason: 'Início de obra', room_id: r1.id })).json;
    assert.ok(s1.id);
    const other = (await g('PUT', '/api/houses', { name: 'Outro', delegation: 'asturias' })).json.id;
    const ro = (await g('PUT', '/api/rooms', { house_id: other, name: 'X', beds: 1 })).json.id;
    assert.equal((await a('POST', `/api/stays/${s1.id}/room`, { room_id: ro })).status, 422); // quarto de outro alojamento
    assert.equal((await a('POST', `/api/stays/${s1.id}/room`, { room_id: r2.id })).status, 200);
    assert.equal((await g('GET', '/api/data')).json.stays.find((x) => x.id === s1.id).room_id, r2.id);
    assert.ok((await g('GET', `/api/audit?house=${h}`)).json.some((x) => /«Habitación 1» → «Habitación 2»/.test(x.summary)));
    // apagar quarto com histórico: não; sem histórico: com código
    assert.equal((await g('POST', `/api/rooms/${r2.id}/delete`, {})).status, 409);
    assert.equal((await a('POST', `/api/rooms/${r1.id}/delete`, {})).status, 403); // r1 já não tem registos (a mudança fica no histórico): só pede o código
    const r3 = rooms.find((x) => x.name === 'Habitación 3');
    assert.equal((await a('POST', `/api/rooms/${r3.id}/delete`, {})).status, 403);
    assert.equal((await a('POST', `/api/rooms/${r3.id}/delete`, { auth_code: 'codigo-certo' })).status, 200);
    assert.equal((await cap()).capacity, 5);
    // outra delegação não mexe
    const c = client(); await c.login('cat@t.pt');
    assert.equal((await c('PUT', '/api/rooms', { house_id: h, name: 'Z', beds: 1 })).status, 404);
  } finally { server.close(); }
});

test('novo alojamento com quartos de camas diferentes: lotação = soma; nomes repetidos ou camas inválidas recusados', async () => {
  const { server, client } = await boot();
  try {
    const a = client(); await a.login('ast@t.pt');
    assert.equal((await a('PUT', '/api/houses', { name: 'Rep', room_list: [{ name: 'Q1', beds: 2 }, { name: 'q1', beds: 3 }] })).status, 422);
    assert.equal((await a('PUT', '/api/houses', { name: 'Mau', room_list: [{ name: 'Q1', beds: 99 }] })).status, 422);
    const id = (await a('PUT', '/api/houses', { name: 'Com quartos', capacity: 1, room_list: [{ name: 'Quarto 1', beds: 1 }, { name: 'Quarto 2', beds: 4 }, { name: '', beds: 9 }, { name: 'Quarto 3', beds: 2 }] })).json.id;
    const d = (await a('GET', '/api/data')).json;
    const x = d.houses.find((y) => y.id === id);
    assert.deepEqual([x.capacity, x.rooms], [7, 3]); // 1 + 4 + 2 (a linha sem nome é ignorada; a lotação escrita não conta)
    assert.deepEqual(d.rooms.filter((r) => r.house_id === id).map((r) => [r.name, r.beds, r.position]), [['Quarto 1', 1, 1], ['Quarto 2', 4, 2], ['Quarto 3', 2, 3]]);
  } finally { server.close(); }
});

test('responsável e lista semanal: link público só desse alojamento; resposta aplicada pelo coordenador; quem sai deixa de ser responsável', async () => {
  const { server, client, base } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    const h = (await a('PUT', '/api/houses', { name: 'Joecara', capacity: 4 })).json.id;
    const h2 = (await a('PUT', '/api/houses', { name: 'Outra', capacity: 4 })).json.id;
    const e1 = (await a('POST', '/api/stays/enter', { house_id: h, worker_name: 'ANA RESP', date: '2026-11-01', reason: 'Início de obra' })).json;
    const e2 = (await a('POST', '/api/stays/enter', { house_id: h, worker_name: 'BRUNO SAI', date: '2026-11-01', reason: 'Início de obra' })).json;
    const novo = (await a('PUT', '/api/workers', { name: 'CARLA NOVA' })).json.id; // existe, sem alojamento
    const fora = (await a('POST', '/api/stays/enter', { house_id: h2, worker_name: 'DIOGO FORA', date: '2026-11-01', reason: 'x' })).json;
    // responsável tem de estar alojado aqui
    assert.equal((await a('PUT', `/api/houses/${h}/responsible`, { worker_id: fora.worker_id })).status, 422);
    assert.equal((await a('POST', `/api/houses/${h}/checkin`, {})).status, 422); // sem responsável
    assert.equal((await a('PUT', `/api/houses/${h}/responsible`, { worker_id: e1.worker_id })).status, 200);
    // coordenador edita um funcionário sem enviar a delegação (o formulário não a mostra) — antes dava 403
    assert.equal((await a('PUT', '/api/workers', { id: e1.worker_id, name: 'ANA RESP', language: 'pt', phone: '+351 911 222 333' })).status, 200);
    assert.equal((await a('PUT', '/api/workers', { id: fora.worker_id, name: 'DIOGO FORA', delegation: 'catalunha' })).status, 200);
    assert.equal((await g('GET', '/api/data')).json.workers.find((w) => w.id === fora.worker_id).delegation, 'asturias'); // a delegação não muda
    const c = (await a('POST', `/api/houses/${h}/checkin`, {})).json;
    assert.match(c.url, /\/lista\/[A-Za-z0-9_-]{20,}$/);
    const token = c.url.split('/').pop();
    // página pública: sem sessão; só nomes deste alojamento; sem telefones
    const pg = await fetch(`${base}/lista/${token}`); assert.equal(pg.status, 200); assert.match(await pg.text(), /lista\.js/);
    let r = await fetch(`${base}/api/lista/${token}`); const d = await r.json();
    assert.equal(r.status, 200); assert.equal(d.house, 'Joecara'); assert.equal(d.language, 'pt');
    assert.deepEqual(d.occupants.map((o) => o.name).sort(), ['ANA RESP', 'BRUNO SAI']);
    assert.ok(!JSON.stringify(d).includes('DIOGO') && !('phone' in d.occupants[0]));
    assert.equal((await fetch(`${base}/api/lista/tokeninvalidotokeninvalido`)).status, 404);
    r = await fetch(`${base}/api/lista/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ present: [e1.worker_id, fora.worker_id], new_names: ['carla nova', 'Pessoa Desconhecida'], note: 'ok' }) });
    assert.equal(r.status, 200);
    const ck = (await a('GET', '/api/data')).json.checkins.find((x) => x.id === c.id);
    assert.equal(ck.status, 'respondido');
    const ans = JSON.parse(ck.answer);
    assert.deepEqual(ans.present, [e1.worker_id]); // o de outro alojamento é ignorado
    assert.deepEqual(ans.left, [e2.worker_id]);
    // aplicar (coordenador, sem código): saída do Bruno, entrada da Carla
    // cada pessoa nova tem de ter decisão: sem decidir a «Pessoa Desconhecida» não se aplica nada
    const semDecisao = await a('POST', `/api/checkins/${c.id}/apply`, { exits: [e2.worker_id], entries: [{ name: 'carla nova', worker_id: novo }] });
    assert.equal(semDecisao.status, 422); assert.match(semDecisao.json.error, /Pessoa Desconhecida/);
    assert.equal((await a('GET', '/api/data')).json.stays.find((x) => x.id === e2.id).end_date, null); // nada mudou
    const ap = await a('POST', `/api/checkins/${c.id}/apply`, { exits: [e2.worker_id], entries: [{ name: 'carla nova', worker_id: novo }, { name: 'Pessoa Desconhecida', reject: true }] });
    assert.equal(ap.status, 200); assert.deepEqual(ap.json, { exits: 1, entries: 1, rejected: 1 });
    const hist = (await a('GET', `/api/audit?house=${h}`)).json.find((x) => x.entity === 'checkin' && /decidida/.test(x.summary));
    assert.match(hist.summary, /saídas aceites: BRUNO SAI/); assert.match(hist.summary, /entradas aceites: CARLA NOVA/); assert.match(hist.summary, /novos recusados: «Pessoa Desconhecida»/);
    const dd = (await a('GET', '/api/data')).json;
    assert.ok(dd.stays.find((x) => x.id === e2.id).end_date);
    assert.ok(dd.stays.some((x) => x.worker_id === novo && x.house_id === h && !x.end_date));
    assert.equal(dd.checkins.find((x) => x.id === c.id).status, 'aplicado');
    assert.equal((await fetch(`${base}/api/lista/${token}`)).status, 404); // depois de aplicado o link deixa de servir
    // o responsável sai: o alojamento fica sem responsável
    await a('POST', '/api/stays/leave', { stay_id: e1.id, date: '2026-11-30', reason: 'Fim de obra' });
    assert.equal((await g('GET', '/api/data')).json.houses.find((x) => x.id === h).responsible_id, null);
    // outra delegação não pede listas
    const cc = client(); await cc.login('cat@t.pt');
    assert.equal((await cc('POST', `/api/houses/${h}/checkin`, {})).status, 404);
  } finally { server.close(); }
});

test('pedir a todos: vários links de uma vez; alojamentos sem responsável ou de outra delegação ficam de fora', async () => {
  const { server, client } = await boot();
  try {
    const a = client(); await a.login('ast@t.pt');
    const g = client(); await g.login('gestor@t.pt');
    const mk = async (name, person, resp) => {
      const id = (await a('PUT', '/api/houses', { name, capacity: 3 })).json.id;
      const e = (await a('POST', '/api/stays/enter', { house_id: id, worker_name: person, date: '2026-11-01', reason: 'Início de obra' })).json;
      if (resp) await a('PUT', `/api/houses/${id}/responsible`, { worker_id: e.worker_id });
      return id;
    };
    const h1 = await mk('Q1', 'P UM', true), h2 = await mk('Q2', 'P DOIS', true), h3 = await mk('Q3', 'P TRES', false);
    const hc = (await g('PUT', '/api/houses', { name: 'QC', delegation: 'catalunha' })).json.id;
    const r = await a('POST', '/api/checkins/bulk', { house_ids: [h1, h2, h3, hc] });
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.json.items.map((i) => [i.house_id, i]));
    assert.match(by[h1].url, /\/lista\//); assert.match(by[h2].url, /\/lista\//);
    assert.match(by[h3].error, /responsável/);
    assert.match(by[hc].error, /inexistente/); // outra delegação: não existe para este coordenador
    assert.notEqual(by[h1].url, by[h2].url);
    // pedir de novo arquiva o pedido aberto anterior (um aberto por alojamento)
    await a('POST', '/api/checkins/bulk', { house_ids: [h1] });
    const open = (await a('GET', '/api/data')).json.checkins.filter((c) => c.house_id === h1 && c.status === 'aberto');
    assert.equal(open.length, 1);
  } finally { server.close(); }
});

test('lista semanal: pessoas novas criadas ou recusadas; recusar tudo fica no histórico e não muda nada', async () => {
  const { server, client, base } = await boot();
  try {
    const a = client(); await a.login('ast@t.pt');
    const h = (await a('PUT', '/api/houses', { name: 'Casa D', capacity: 5 })).json.id;
    const e1 = (await a('POST', '/api/stays/enter', { house_id: h, worker_name: 'RESP D', date: '2026-11-01', reason: 'x' })).json;
    await a('PUT', `/api/houses/${h}/responsible`, { worker_id: e1.worker_id });
    const ask = async (names) => {
      const token = (await a('POST', `/api/houses/${h}/checkin`, {})).json.url.split('/').pop();
      await fetch(`${base}/api/lista/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ present: [e1.worker_id], new_names: names }) });
      return (await a('GET', '/api/data')).json.checkins.find((c) => c.status === 'respondido').id;
    };
    // «Toninho» e «jose mauricio» não existem: um criado, outro recusado
    let cid = await ask(['Toninho', 'jose mauricio']);
    const r = await a('POST', `/api/checkins/${cid}/apply`, { exits: [], entries: [{ name: 'Toninho', create: true }, { name: 'jose mauricio', reject: true }] });
    assert.deepEqual(r.json, { exits: 0, entries: 1, rejected: 1 });
    let d = (await a('GET', '/api/data')).json;
    const t = d.workers.find((w) => w.name === 'TONINHO');
    assert.ok(t); assert.equal(t.delegation, 'asturias');
    assert.ok(d.stays.some((s) => s.worker_id === t.id && s.house_id === h && !s.end_date));
    assert.ok(!d.workers.some((w) => /MAURICIO/i.test(w.name)));
    assert.deepEqual(JSON.parse(d.checkins.find((c) => c.id === cid).decision).entries_rejected, ['jose mauricio']);
    // recusar tudo: nada muda; fica registado como recusado
    cid = await ask(['Outro Nome']);
    await a('POST', `/api/checkins/${cid}/apply`, { archive: true });
    d = (await a('GET', '/api/data')).json;
    assert.equal(d.checkins.find((c) => c.id === cid).status, 'arquivado');
    assert.ok(!d.workers.some((w) => /OUTRO NOME/.test(w.name)));
    const sums = (await a('GET', `/api/audit?house=${h}`)).json.map((x) => x.summary);
    // o Toninho não veio na 2.ª resposta (= «saiu»), mas recusar tudo não lhe dá saída: fica registado como saída recusada
    assert.ok(sums.some((x) => /recusada \(arquivada sem alterações\) — saídas recusadas: TONINHO; novos recusados: «Outro Nome»/.test(x)), sums.join('\n'));
    assert.ok(d.stays.some((s) => s.worker_id === t.id && s.house_id === h && !s.end_date));
  } finally { server.close(); }
});

test('saída: no próprio dia já não conta e a pessoa fica disponível para outro alojamento no mesmo dia', async () => {
  const { server, client } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const today = new Date().toISOString().slice(0, 10);
    const h1 = (await g('PUT', '/api/houses', { name: 'Escritório', delegation: 'asturias', capacity: 2 })).json.id;
    const h2 = (await g('PUT', '/api/houses', { name: 'Outro', delegation: 'asturias', capacity: 2 })).json.id;
    const e = (await g('POST', '/api/stays/enter', { house_id: h1, worker_name: 'BRUNO TESTE', date: '2026-11-01', reason: 'x' })).json;
    assert.equal((await g('POST', '/api/stays/leave', { stay_id: e.id, date: today, reason: 'Fim de obra' })).status, 200);
    // segunda saída: recusada com mensagem clara (já saiu)
    assert.equal((await g('POST', '/api/stays/leave', { stay_id: e.id, date: today, reason: 'x' })).status, 422);
    // hoje já está livre: pode entrar noutro alojamento hoje
    const r = await g('POST', '/api/stays/enter', { house_id: h2, worker_id: e.worker_id, date: today, reason: 'Início de obra' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // e não pode estar em dois sítios: voltar ao primeiro hoje é recusado
    assert.equal((await g('POST', '/api/stays/enter', { house_id: h1, worker_id: e.worker_id, date: today, reason: 'x' })).status, 422);
  } finally { server.close(); }
});

test('lista semanal: associar a quem está noutro alojamento exige transferência confirmada', async () => {
  const { server, client, base } = await boot();
  try {
    const g = client(); await g.login('gestor@t.pt');
    const a = client(); await a.login('ast@t.pt');
    const today = new Date().toISOString().slice(0, 10);
    const hY = (await a('PUT', '/api/houses', { name: 'Y destino', capacity: 5 })).json.id;
    const hX = (await a('PUT', '/api/houses', { name: 'X origem', capacity: 5 })).json.id;
    const hC = (await g('PUT', '/api/houses', { name: 'C outra delegação', delegation: 'catalunha', capacity: 5 })).json.id;
    const r1 = (await a('POST', '/api/stays/enter', { house_id: hY, worker_name: 'RESP Y', date: '2026-11-01', reason: 'x' })).json;
    await a('PUT', `/api/houses/${hY}/responsible`, { worker_id: r1.worker_id });
    const jose = (await a('POST', '/api/stays/enter', { house_id: hX, worker_name: 'JOSE TOALHA', date: '2026-11-01', reason: 'x' })).json;
    const cat = (await g('POST', '/api/stays/enter', { house_id: hC, worker_name: 'PEDRO CAT', date: '2026-11-01', reason: 'x' })).json;
    const ask = async (names) => {
      const token = (await a('POST', `/api/houses/${hY}/checkin`, {})).json.url.split('/').pop();
      await fetch(`${base}/api/lista/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ present: [r1.worker_id], new_names: names }) });
      return (await a('GET', '/api/data')).json.checkins.find((c) => c.status === 'respondido').id;
    };
    let cid = await ask(['Jose toalha']);
    // sem confirmar a transferência: recusado, nada muda
    let r = await a('POST', `/api/checkins/${cid}/apply`, { entries: [{ name: 'Jose toalha', worker_id: jose.worker_id }] });
    assert.equal(r.status, 422); assert.equal(r.json.needTransfer, true); assert.match(r.json.error, /X origem/);
    assert.equal((await a('GET', '/api/data')).json.stays.find((s) => s.id === jose.id).end_date, null);
    // com confirmação: sai de X e entra em Y hoje
    r = await a('POST', `/api/checkins/${cid}/apply`, { entries: [{ name: 'Jose toalha', worker_id: jose.worker_id, transfer: true }] });
    assert.equal(r.status, 200);
    const d = (await a('GET', '/api/data')).json;
    assert.equal(d.stays.find((s) => s.id === jose.id).end_date, today);
    assert.ok(d.stays.some((s) => s.worker_id === jose.worker_id && s.house_id === hY && s.start_date === today && !s.end_date));
    assert.match(JSON.parse(d.checkins.find((c) => c.id === cid).decision).entries[0], /transferido de «X origem»/);
    // coordenador não transfere quem está num alojamento de outra delegação
    cid = await ask(['Pedro cat']);
    r = await a('POST', `/api/checkins/${cid}/apply`, { entries: [{ name: 'Pedro cat', worker_id: cat.worker_id, transfer: true }] });
    assert.ok([403, 404].includes(r.status));
    assert.equal((await g('GET', '/api/data')).json.stays.find((s) => s.id === cat.id).end_date, null);
  } finally { server.close(); }
});
