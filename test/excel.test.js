import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { openDb } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { upsertUser } from '../src/server/auth.js';
import { HOUSE_COLS, WORKER_COLS } from '../src/server/excel.js';

process.env.ALOJ_LOGIN_MAX = '1000';
const PW = 'Teste-Aloj-2026!';
async function boot() {
  const db = await openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aloj-x-')), 't.sqlite'));
  await upsertUser(db, { email: 'g@t.pt', name: 'Gestor', password: PW, role: 'gestor' });
  await upsertUser(db, { email: 'a@t.pt', name: 'Coord Ast', password: PW, role: 'coordenador', delegation: 'asturias' });
  const server = http.createServer(createApp(db)); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (email) => {
    const l = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
    const cookie = l.headers.get('set-cookie').split(';')[0], csrf = (await l.json()).csrf;
    return async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
      const ct = r.headers.get('content-type') ?? '';
      return { status: r.status, json: /json/.test(ct) ? await r.json() : null, buf: /sheet/.test(ct) ? Buffer.from(await r.arrayBuffer()) : null, headers: r.headers };
    };
  };
  return { server, client };
}
/** Excel de teste: cabeçalhos (podem faltar ou mudar) e linhas como objetos { chave: valor }. */
async function xlsx({ houses = [], workers = [], houseHead = HOUSE_COLS.map((c) => c.label), workerHead = WORKER_COLS.map((c) => c.label) } = {}) {
  const wb = new ExcelJS.Workbook();
  const add = (name, head, cols, rows) => {
    const ws = wb.addWorksheet(name); ws.addRow(head);
    for (const r of rows) ws.addRow(head.map((hd) => r[cols.find((c) => c.label === hd)?.key ?? hd] ?? null));
  };
  add('Alojamentos', houseHead, HOUSE_COLS, houses);
  add('Funcionários', workerHead, WORKER_COLS, workers);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

test('excel: modelo e exportação descarregam-se e voltam a importar-se sem alterações', async () => {
  const { server, client } = await boot();
  try {
    const g = await client('g@t.pt');
    await g('PUT', '/api/houses', { name: 'Casa 1', delegation: 'asturias', capacity: 4, rent: 750.5, contract_start: '2026-01-15', code: 'AS-1' });
    await g('PUT', '/api/workers', { name: 'ANA LOPES', phone: '+351 900', profession: 'PEDREIRO', delegation: 'asturias' });
    const m = await g('GET', '/api/excel/modelo');
    assert.equal(m.status, 200); assert.match(m.headers.get('content-disposition'), /attachment/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(m.buf);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Alojamentos', 'Funcionários', 'Instruções']);
    assert.equal(wb.getWorksheet('Alojamentos').getCell('A1').value, 'Nome do piso*');
    const ex = await g('GET', '/api/excel/exportar?delegacao=asturias');
    const P = (await g('POST', '/api/excel/previsualizar', { delegation: 'asturias', file: ex.buf.toString('base64') })).json;
    assert.deepEqual(P.fatal, []);
    assert.deepEqual(P.houses.map((r) => r.action), ['same']);
    assert.deepEqual(P.workers.map((r) => r.action), ['same']);
  } finally { server.close(); }
});

test('excel: erros e avisos por linha; formato errado é fatal; pré-visualizar não grava; importa só as linhas válidas', async () => {
  const { server, client } = await boot();
  try {
    const g = await client('g@t.pt');
    let P = (await g('POST', '/api/excel/previsualizar', { delegation: 'asturias', file: Buffer.from('não é excel').toString('base64') })).json;
    assert.match(P.fatal[0], /não é um Excel/);
    P = (await g('POST', '/api/excel/previsualizar', { delegation: 'asturias', file: await xlsx({ houseHead: ['Nome', 'Delegação'] }) })).json;
    assert.match(P.fatal.join(' '), /falta a coluna obrigatória «Nome do piso»/);
    P = (await g('POST', '/api/excel/previsualizar', { delegation: 'asturias', file: await xlsx({
      houses: [
        { name: 'Boa', delegation: 'Astúrias', rent: '1.250,50', capacity: 4, contract_start: '15/01/2026', active: 'Sim' },
        { name: 'Sem delegação' },
        { name: 'Má', delegation: 'Lisboa', rent: 'muito', capacity: 2.5, contract_start: '31/02/2026', active: 'talvez' },
        { name: 'boa', delegation: 'Porto' },
        { name: 'Zero', delegation: 'AST', capacity: 0 },
      ],
      workers: [{ name: 'JOÃO SILVA', phone: 'abc', delegation: 'Pendente' }, { phone: '123' }, { name: 'joao silva', delegation: 'Porto' }],
    }) })).json;
    const [boa, semDel, ma, rep, zero] = P.houses;
    assert.equal(boa.action, 'create');
    assert.equal(semDel.action, 'create'); assert.equal(semDel.row.delegation, 'asturias'); // em branco = a delegação da importação
    assert.equal(ma.action, 'error'); assert.equal(ma.line, 4);
    for (const re of [/não é uma delegação/, /«muito» não é um número/, /número inteiro/, /não é uma data válida/, /Sim ou Não/]) assert.match(ma.errors.join(' '), re);
    assert.match(rep.errors.join(' '), /repetido no ficheiro \(já na linha 2\)/);
    assert.equal(zero.action, 'create'); assert.match(zero.warnings.join(' '), /Lotação 0/);
    const [joao, vazio, joao2] = P.workers;
    assert.equal(joao.action, 'create'); assert.match(joao.warnings.join(' '), /tem letras/);
    assert.equal(vazio.action, 'error'); assert.match(vazio.errors.join(' '), /Nome: obrigatório/);
    assert.match(joao2.errors.join(' '), /repetido no ficheiro/);
    assert.equal((await g('GET', '/api/data')).json.houses.length, 0); // pré-visualizar não grava
    const r = (await g('POST', '/api/excel/importar', { delegation: 'asturias', file: await xlsx({ houses: [{ name: 'Boa', delegation: 'Astúrias', rent: '1.250,50', contract_start: '15/01/2026' }, { name: 'Má', delegation: 'Lisboa' }], workers: [{ name: 'JOÃO SILVA', delegation: 'Pendente' }] }) })).json;
    assert.deepEqual(r.done, { houses: { create: 1, fill: 0 }, workers: { create: 1, fill: 0 } });
    assert.equal(r.skipped.houses, 1);
    const d = (await g('GET', '/api/data')).json;
    assert.deepEqual([d.houses[0].rent, d.houses[0].contract_start], [1250.5, '2026-01-15']);
    assert.equal(d.workers[0].delegation, null);
  } finally { server.close(); }
});

test('excel: existentes só preenchem vazios; diferenças são avisos; nomes parecidos não repetem; duvidosos não entram', async () => {
  const { server, client } = await boot();
  try {
    const g = await client('g@t.pt');
    const id = (await g('PUT', '/api/houses', { name: 'Casa X', delegation: 'asturias', rent: 900, code: 'AS-9' })).json.id;
    await g('PUT', '/api/houses', { name: 'Casa Y', delegation: 'asturias' });
    await g('PUT', '/api/workers', { name: 'RUBEN FERNANDO LIARTE TESTE', delegation: 'asturias', phone: '+351 1' });
    await g('PUT', '/api/workers', { name: 'CARLOS ADAO BARROSO CONGO', delegation: 'asturias' });
    const file = await xlsx({
      houses: [{ name: 'Casa X', delegation: 'Astúrias', rent: 600, capacity: 5, code: 'AS-9' }, { name: 'Casa Y', code: 'as-9', delegation: 'Astúrias' }],
      workers: [{ name: 'RUBEN FERNANDO LIJARTE TESTE', phone: '+351 2', profession: 'PEDREIRO' }, { name: 'CARLOS ADAO PEREZ CONGO', profession: 'X' }],
    });
    const P = (await g('POST', '/api/excel/previsualizar', { delegation: 'asturias', file })).json;
    assert.equal(P.houses[0].action, 'fill'); assert.deepEqual(P.houses[0].fillText, ['Lotação: 5']);
    assert.match(P.houses[0].warnings.join(' '), /Aluguer: no Excel «600», na aplicação «900» — mantém-se/);
    assert.equal(P.houses[1].action, 'error'); // código de uma casa e nome de outra (e código repetido no ficheiro)
    assert.equal(P.workers[0].action, 'fill'); assert.match(P.workers[0].warnings.join(' '), /Nome parecido/);
    assert.deepEqual(P.workers[0].fillText, ['Profissão: PEDREIRO']);
    assert.equal(P.workers[1].action, 'doubt');
    await g('POST', '/api/excel/importar', { delegation: 'asturias', file });
    const d = (await g('GET', '/api/data')).json;
    const x = d.houses.find((y) => y.id === id);
    assert.deepEqual([x.rent, x.capacity], [900, 5]); // aluguer mantido, lotação preenchida
    assert.equal(d.workers.length, 2); // ninguém repetido
    assert.equal(d.workers.find((w) => /RUBEN/.test(w.name)).phone, '+351 1');
    assert.ok((await g('GET', `/api/audit?house=${id}`)).json.some((r) => /campos vazios preenchidos \(importação Excel\)/.test(r.summary)));
  } finally { server.close(); }
});

test('excel: coordenador só na sua delegação; preencher casas existentes pede o código', async () => {
  const { server, client } = await boot();
  try {
    const g = await client('g@t.pt');
    const a = await client('a@t.pt');
    await g('PUT', '/api/settings/auth-code', { code: 'codigo-certo' });
    await g('PUT', '/api/houses', { name: 'Casa Ast', delegation: 'asturias' });
    await g('PUT', '/api/houses', { name: 'Casa Cat', delegation: 'catalunha' });
    const file = await xlsx({ houses: [{ name: 'Nova sem delegação' }, { name: 'Nova Cat', delegation: 'Catalunha' }, { name: 'Casa Ast', capacity: 3 }, { name: 'Casa Cat', capacity: 3 }],
      workers: [{ name: 'PESSOA A' }, { name: 'PESSOA B', delegation: 'Porto' }] });
    const P = (await a('POST', '/api/excel/previsualizar', { delegation: 'asturias', file })).json;
    assert.deepEqual(P.houses.map((r) => r.action), ['create', 'error', 'fill', 'error']);
    assert.match(P.houses[1].errors[0], /esta importação é só de Astúrias/);
    assert.match(P.houses[3].errors.join(' '), /noutra delegação/);
    assert.deepEqual(P.workers.map((r) => r.action), ['create', 'error']);
    assert.equal(P.needAuth, true);
    let r = await a('POST', '/api/excel/importar', { delegation: 'asturias', file });
    assert.equal(r.status, 403); assert.equal(r.json.needAuth, true);
    r = await a('POST', '/api/excel/importar', { delegation: 'asturias', file, auth_code: 'codigo-certo' });
    assert.equal(r.status, 200);
    const d = (await g('GET', '/api/data')).json;
    assert.equal(d.houses.find((x) => x.name === 'Nova sem delegação').delegation, 'asturias');
    assert.equal(d.houses.find((x) => x.name === 'Casa Ast').capacity, 3);
    assert.equal(d.houses.find((x) => x.name === 'Casa Cat').capacity, null);
    assert.equal(d.workers.find((w) => w.name === 'PESSOA A').delegation, 'asturias');
  } finally { server.close(); }
});

test('excel: códigos e nomes com números distinguem-se (AS-001 ≠ AS-002; Calle Mayor 7 ≠ Calle Mayor 11); Sim/Não aceita 1/0', async () => {
  const { server, client } = await boot();
  try {
    const g = await client('g@t.pt');
    await g('PUT', '/api/houses', { name: 'CALLE MAYOR 7', delegation: 'asturias', code: 'AS-001', address: 'Calle Mayor 7' });
    await g('PUT', '/api/houses', { name: 'CALLE MAYOR 11', delegation: 'asturias', code: 'AS-002', address: 'Calle Mayor 11' });
    const ex = await g('GET', '/api/excel/exportar?delegacao=asturias');
    let P = (await g('POST', '/api/excel/previsualizar', { delegation: 'asturias', file: ex.buf.toString('base64') })).json;
    assert.deepEqual(P.houses.map((r) => r.action), ['same', 'same']);
    P = (await g('POST', '/api/excel/previsualizar', { delegation: 'asturias', file: await xlsx({ houses: [
      { name: 'CALLE MAYOR 1', delegation: 'Astúrias', code: 'AS-003', active: '1', deposit_available: '0' },
      { name: 'CALLE MAYOR 7', delegation: 'Astúrias', code: 'AS-001', capacity: 5 },
    ] }) })).json;
    assert.deepEqual(P.houses.map((r) => r.action), ['create', 'fill']);
    assert.deepEqual(P.houses[1].fillText, ['Lotação: 5']);
  } finally { server.close(); }
});

test('excel por delegação: exporta só a delegação pedida; importa só nela; coordenador não usa outra; alojamento próprio', async () => {
  const { server, client } = await boot();
  try {
    const g = await client('g@t.pt');
    const a = await client('a@t.pt');
    await g('PUT', '/api/houses', { name: 'Casa Ast', delegation: 'asturias' });
    await g('PUT', '/api/houses', { name: 'Casa Cat', delegation: 'catalunha' });
    await g('PUT', '/api/workers', { name: 'TRAB AST', delegation: 'asturias' });
    await g('PUT', '/api/workers', { name: 'TRAB CAT', delegation: 'catalunha' });
    const ex = await g('GET', '/api/excel/exportar?delegacao=catalunha');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(ex.buf);
    assert.equal(wb.getWorksheet('Alojamentos').getCell('A2').value, 'Casa Cat');
    assert.equal(wb.getWorksheet('Alojamentos').rowCount, 2);
    assert.equal(wb.getWorksheet('Funcionários').getCell('A2').value, 'TRAB CAT');
    assert.equal(wb.getWorksheet('Funcionários').rowCount, 2);
    assert.equal((await g('GET', '/api/excel/exportar')).status, 422); // sem delegação: não
    assert.equal((await a('GET', '/api/excel/exportar?delegacao=catalunha')).status, 403);
    assert.equal((await a('POST', '/api/excel/previsualizar', { delegation: 'catalunha', file: await xlsx({}) })).status, 403);
    // gestor a importar para Catalunha: linha das Astúrias é erro; em branco fica Catalunha; funcionário com alojamento próprio
    const P = (await g('POST', '/api/excel/previsualizar', { delegation: 'catalunha', file: await xlsx({
      houses: [{ name: 'Nova', delegation: '' }, { name: 'Outra', delegation: 'Astúrias' }, { name: 'Casa Ast' }],
      workers: [{ name: 'NOVO PROPRIO', own_housing: 'Sim' }, { name: 'TRAB AST', phone: '1' }],
    }) })).json;
    assert.deepEqual(P.houses.map((r) => r.action), ['create', 'error', 'error']);
    assert.match(P.houses[1].errors[0], /esta importação é só de Catalunha/);
    assert.match(P.houses[2].errors.join(' '), /noutra delegação \(Astúrias\)/);
    assert.deepEqual(P.workers.map((r) => r.action), ['create', 'error']);
    await g('POST', '/api/excel/importar', { delegation: 'catalunha', file: await xlsx({ houses: [{ name: 'Nova' }], workers: [{ name: 'NOVO PROPRIO', own_housing: 'Sim' }] }) });
    const d = (await g('GET', '/api/data')).json;
    assert.equal(d.houses.find((x) => x.name === 'Nova').delegation, 'catalunha');
    const w = d.workers.find((x) => x.name === 'NOVO PROPRIO');
    assert.deepEqual([w.delegation, w.own_housing], ['catalunha', 1]);
  } finally { server.close(); }
});
