// Dá entrada a funcionários JÁ EXISTENTES nas casas, a partir de uma lista «nome → alojamento» de outra origem
// (nomes podem vir escritos de outra forma). Ex.: data/import/catalunha-ocupantes.json (fora do git).
// Uso: node scripts/import-stays-by-name.js <ficheiro.json> [--simular]
// Formato: { delegation, date, reason, houses: { "<alojamento na origem>": "<código da casa>" }, aliases?: { "<nome na origem>": "<nome existente>" }, rows: [[nome, alojamento], …] }
// Regras (para não repetir nem inventar):
//  - só associa quando o nome corresponde SEM AMBIGUIDADE a um funcionário existente (igual, ou parecido com todas as palavras a bater
//    e um único candidato); duvidosos e desconhecidos ficam no relatório — não se criam pessoas;
//  - só casas mapeadas e da delegação indicada; alojamentos desconhecidos ficam no relatório — não se criam casas;
//  - quem já está alojado não é mexido (mesma casa: ignorado; outra casa: conflito no relatório);
//  - a data de entrada é `date` (a data do registo da origem), com o motivo `reason` — não se inventam datas;
//  - um pendente que entra numa casa passa a ter a delegação da casa.
import fs from 'node:fs';
import { openDb } from '../src/server/db.js';
import { DELEGATIONS, isDate } from '../src/server/schema.js';
import { norm, compareNames } from '../src/server/names.js';

const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dry = process.argv.includes('--simular');
if (!file) { console.error('Uso: node scripts/import-stays-by-name.js <ficheiro.json> [--simular]'); process.exit(1); }
const src = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!DELEGATIONS.some(([k]) => k === src.delegation)) { console.error(`Delegação inválida: ${src.delegation}`); process.exit(1); }
if (!isDate(src.date) || !src.reason) { console.error('Falta «date» (AAAA-MM-DD) ou «reason».'); process.exit(1); }

const db = await openDb();
if (db.remote && process.env.ALOJ_IMPORT_REMOTE !== 'sim') { console.error('BD remota: defina ALOJ_IMPORT_REMOTE=sim para confirmar.'); process.exit(1); }
const workers = await db.all('SELECT * FROM workers');
const houses = await db.all('SELECT * FROM houses');
const current = new Map((await db.all('SELECT s.worker_id, h.code, h.name FROM stays s JOIN houses h ON h.id=s.house_id WHERE s.end_date IS NULL OR s.end_date>?', [src.date])).map((r) => [r.worker_id, r]));

/** Funcionário existente para um nome da origem: só se não houver dúvida. */
function findWorker(name) {
  const target = src.aliases?.[name] ?? name;
  const exact = workers.filter((w) => norm(w.name) === norm(target));
  if (exact.length === 1) return { w: exact[0], how: src.aliases?.[name] ? 'alias' : 'igual' };
  if (exact.length > 1) return { doubt: `${exact.length} funcionários com o nome «${target}»` };
  const c = workers.map((w) => ({ w, ...compareNames(target, w.name) })).filter((x) => x.kind);
  const full = c.filter((x) => x.kind === 'full');
  if (full.length === 1) return { w: full[0].w, how: 'parecido' };
  if (full.length > 1) return { doubt: `parecido com vários: ${full.map((x) => x.w.name).join(' / ')}` };
  const maybe = c.filter((x) => x.kind === 'maybe');
  if (maybe.length) return { doubt: `talvez: ${maybe.map((x) => x.w.name).join(' / ')}` };
  return { none: true };
}

const plan = { enter: [], already: [], conflict: [], noHouse: [], doubt: [], unknown: [], dupRow: [] };
const seenW = new Set(), seenN = new Set();
for (const [name, where] of src.rows) {
  if (seenN.has(norm(name))) { plan.dupRow.push(`${name} (${where})`); continue; }
  seenN.add(norm(name));
  const code = src.houses[where];
  const h = code && houses.find((x) => x.code === code);
  if (!h || h.delegation !== src.delegation) { plan.noHouse.push(`${name} → «${where}»${code ? ` (${code} não encontrado ou de outra delegação)` : ''}`); continue; }
  const f = findWorker(name);
  if (f.doubt) { plan.doubt.push(`${name} → ${h.code}: ${f.doubt}`); continue; }
  if (f.none) { plan.unknown.push(`${name} → ${h.code}`); continue; }
  if (seenW.has(f.w.id)) { plan.dupRow.push(`${name} = ${f.w.name} (já usado noutra linha)`); continue; }
  seenW.add(f.w.id);
  const cur = current.get(f.w.id);
  if (cur) { (cur.code === h.code ? plan.already : plan.conflict).push(`${f.w.name}: ${cur.code === h.code ? 'já está' : `está em ${cur.code} «${cur.name}», a origem diz`} ${h.code}`); continue; }
  plan.enter.push({ name, w: f.w, h, how: f.how });
}

console.log(`${src.rows.length} linhas · a dar entrada: ${plan.enter.length} · já estavam: ${plan.already.length} · conflitos: ${plan.conflict.length} · sem casa: ${plan.noHouse.length} · duvidosos: ${plan.doubt.length} · desconhecidos: ${plan.unknown.length}`);
const show = (t, l) => { if (l.length) console.log(`\n${t} (${l.length}):\n  ${l.join('\n  ')}`); };
show('Nome diferente na origem (associado ao funcionário existente)', plan.enter.filter((x) => x.how !== 'igual').map((x) => `${x.name} = ${x.w.name}${x.how === 'alias' ? ' (confirmado à mão)' : ''}`));
show('Já estavam nessa casa', plan.already); show('Conflito: alojado noutra casa', plan.conflict);
show('Alojamento sem casa na aplicação', plan.noHouse); show('Duvidosos (não associados)', plan.doubt);
show('Não existem na lista de funcionários (não criados)', plan.unknown); show('Linhas repetidas', plan.dupRow);
if (dry) { console.log('\n(simulação: nada gravado)'); process.exit(0); }

const now = new Date().toISOString();
await db.tx(async (t) => {
  for (const { w, h } of plan.enter) {
    if (w.delegation == null) await t.run('UPDATE workers SET delegation=? WHERE id=?', [h.delegation, w.id]);
    const id = (await t.run('INSERT INTO stays(house_id,worker_id,start_date,entry_reason) VALUES(?,?,?,?)', [h.id, w.id, src.date, src.reason])).lastInsertRowid;
    await t.run('INSERT INTO audit(at,user_id,user_name,entity,entity_id,house_id,delegation,action,summary,changes) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [now, null, 'Importação', 'stay', id, h.id, h.delegation, 'create', `Entrada de «${w.name}» em «${h.name}» a ${src.date} — ${src.reason}`, JSON.stringify({ worker: w.name, start_date: src.date, entry_reason: src.reason, source: src.source ?? file })]);
  }
});
console.log(`\nGravado: ${plan.enter.length} entradas.`);
