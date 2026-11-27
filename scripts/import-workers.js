// Importa a lista de funcionários (nome | profissão | telefone) a partir de uma tabela Markdown (ex.: data/import/funcionarios-ativos.md, fora do git).
// Uso: node scripts/import-workers.js <ficheiro.md> [--simular] [--comparar-com=asturias,catalunha] [--duvidas=criar]
//   --comparar-com  só procura repetidos nos funcionários destas delegações (ex.: para não comparar com dados de teste)
//   --duvidas=criar depois de rever o relatório: as parecenças duvidosas são pessoas diferentes e são criadas
// - Quem já existe (mesmo nome, ou nome muito parecido: acentos, uma letra trocada, apelidos a mais) NÃO é repetido:
//   atualiza-se o nome para o da lista, a profissão e o telefone; a casa e a delegação mantêm-se.
// - Quem não existe é criado como PENDENTE: sem casa e sem delegação.
// - Parecenças duvidosas não são juntadas nem criadas: ficam no relatório para confirmar.
import fs from 'node:fs';
import { openDb } from '../src/server/db.js';
import { norm, toks, score } from '../src/server/names.js';

const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dry = process.argv.includes('--simular');
const onlyDels = (process.argv.find((a) => a.startsWith('--comparar-com=')) ?? '').split('=')[1]?.split(',').filter(Boolean) ?? [];
const createDoubts = process.argv.includes('--duvidas=criar');
if (!file) { console.error('Uso: node scripts/import-workers.js <ficheiro.md> [--simular]'); process.exit(1); }

const clean = (s) => String(s ?? '').replace(/\?+/g, '').replace(/\s+/g, ' ').trim();
const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('|')).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
  .filter((c) => c[0] && !/^Funcion/i.test(c[0]) && !/^-+$/.test(c[0]))
  .map(([name, prof, phone]) => ({ name: clean(name).toUpperCase(), profession: clean(prof).toUpperCase(), phone: clean(phone).slice(0, 40) }));

const db = await openDb();
if (db.remote && process.env.ALOJ_IMPORT_REMOTE !== 'sim') { console.error('BD remota: defina ALOJ_IMPORT_REMOTE=sim para confirmar.'); process.exit(1); }
const existing = (await db.all('SELECT * FROM workers')).filter((w) => !onlyDels.length || w.delegation == null || onlyDels.includes(w.delegation))
  .map((w) => ({ ...w, toks: toks(w.name) }));
const plan = { exact: [], similar: [], doubt: [], create: [], dupInList: [] };
// linhas únicas da lista
const seenList = new Set(), uniq = [];
for (const r of rows) { const k = norm(r.name); if (seenList.has(k)) plan.dupInList.push(r.name); else { seenList.add(k); uniq.push(r); } }
const takenW = new Set(), doneR = new Set();
// 1.ª fase: nomes iguais (sem acentos nem maiúsculas)
for (const r of uniq) {
  const w = existing.find((e) => !takenW.has(e.id) && norm(e.name) === norm(r.name));
  if (w) { takenW.add(w.id); doneR.add(r); plan.exact.push({ r, w }); }
}
// 2.ª fase: parecidos — todos os pares, do mais semelhante para o menos, cada pessoa usada uma só vez
const pairs = [];
for (const r of uniq) {
  if (doneR.has(r)) continue;
  const tk = toks(r.name);
  for (const w of existing) {
    if (takenW.has(w.id)) continue;
    const c = { r, w, ...score(tk, w.toks), long: Math.max(tk.length, w.toks.length) };
    if (c.m < 2 || (c.short === 2 && c.long > 3)) continue; // 2 nomes contra 4 ou mais: demasiado vago
    c.full = c.m === c.short; // todos os nomes do mais curto batem
    c.maybe = !c.full && c.m >= c.short - 1 && c.short >= 3;
    if (c.full || c.maybe) pairs.push(c);
  }
}
pairs.sort((a, b) => b.full - a.full || (b.m / b.long) - (a.m / a.long) || b.m - a.m);
for (const c of pairs) {
  if (doneR.has(c.r)) continue;
  if (c.full) { if (takenW.has(c.w.id)) continue; takenW.add(c.w.id); doneR.add(c.r); plan.similar.push(c); }
  else { doneR.add(c.r); plan.doubt.push(c); } // duvidoso: não junta nem cria (a não ser com --duvidas=criar)
}
for (const r of uniq) if (!doneR.has(r)) plan.create.push(r);
if (createDoubts) { plan.create.push(...plan.doubt.map((d) => d.r)); plan.doubt = []; }

console.log(`Lista: ${rows.length} linhas · já existem: ${plan.exact.length} iguais + ${plan.similar.length} parecidos · novos (pendentes): ${plan.create.length} · a confirmar: ${plan.doubt.length}`);
console.log('\nParecidos (juntados ao existente; o nome passa a ser o da lista):');
for (const { r, w } of plan.similar) console.log(`  ${w.name}  →  ${r.name}`);
console.log('\nA confirmar (não juntados nem criados):');
for (const { r, w } of plan.doubt) console.log(`  lista: ${r.name}  ~  existente: ${w.name}`);
const housed = await db.all('SELECT DISTINCT w.id, w.name FROM workers w JOIN stays s ON s.worker_id=w.id WHERE s.end_date IS NULL');
const matched = new Set([...plan.exact, ...plan.similar].map((x) => x.w.id));
const lonely = housed.filter((w) => !matched.has(w.id) && (!onlyDels.length || existing.some((e) => e.id === w.id)));
console.log(`
Alojados que não aparecem na lista (${lonely.length}): ${lonely.map((w) => w.name).join(', ') || '—'}`);
if (plan.dupInList.length) console.log(`\nRepetidos na lista (ignorados): ${plan.dupInList.join(', ')}`);
if (dry) { console.log(`\nNovos (pendentes):\n  ${plan.create.map((r) => r.name).join('\n  ')}`); console.log('\n(simulação: nada gravado)'); process.exit(0); }

const now = new Date().toISOString();
const log = (t, id, delegation, action, summary, changes) => t.run('INSERT INTO audit(at,user_id,user_name,entity,entity_id,house_id,delegation,action,summary,changes) VALUES(?,?,?,?,?,?,?,?,?,?)',
  [now, null, 'Importação', 'worker', id, null, delegation, action, summary, JSON.stringify(changes)]);
await db.tx(async (t) => {
  for (const { r, w } of [...plan.exact, ...plan.similar]) {
    const after = { name: r.name, profession: r.profession || w.profession, phone: r.phone || w.phone };
    const diff = Object.fromEntries(Object.entries(after).filter(([k, v]) => String(w[k] ?? '') !== String(v)).map(([k, v]) => [k, [w[k] ?? null, v]]));
    if (!Object.keys(diff).length) continue;
    await t.run('UPDATE workers SET name=?, profession=?, phone=? WHERE id=?', [after.name, after.profession, after.phone, w.id]);
    await log(t, w.id, w.delegation, 'update', `Funcionário «${after.name}» atualizado pela lista de ativos`, diff);
  }
  for (const r of plan.create) {
    const id = (await t.run('INSERT INTO workers(name,phone,company,profession,delegation) VALUES(?,?,?,?,NULL)', [r.name, r.phone, '', r.profession])).lastInsertRowid;
    await log(t, id, null, 'create', `Funcionário «${r.name}» criado como pendente (lista de ativos)`, r);
  }
});
console.log(`\nGravado: ${plan.exact.length + plan.similar.length} atualizados, ${plan.create.length} criados como pendentes.`);
