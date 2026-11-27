// Cria os quartos de alojamentos e põe os ocupantes ATUAIS no seu quarto, a partir de um JSON (ex.: data/import/quartos.json, fora do git).
// Uso: node scripts/import-rooms.js <ficheiro.json> [--simular]
// Formato: { houses: { "<código>": { rooms: [ { name, beds, people: ["NOME", …] }, … ] } } }
// Regras: quartos já existentes não se duplicam (atualiza só as camas); a lotação passa a ser a soma das camas;
// só se atribui quarto a quem JÁ está alojado nesse alojamento (nome igual ou parecido, sem ambiguidade);
// a mesma pessoa em dois quartos da origem não é atribuída (fica no relatório); não se cria nem se tira ninguém.
import fs from 'node:fs';
import { openDb } from '../src/server/db.js';
import { norm, compareNames } from '../src/server/names.js';

const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dry = process.argv.includes('--simular');
if (!file) { console.error('Uso: node scripts/import-rooms.js <ficheiro.json> [--simular]'); process.exit(1); }
const src = JSON.parse(fs.readFileSync(file, 'utf8'));
const db = await openDb();
if (db.remote && process.env.ALOJ_IMPORT_REMOTE !== 'sim') { console.error('BD remota: defina ALOJ_IMPORT_REMOTE=sim para confirmar.'); process.exit(1); }
const now = new Date().toISOString();
const log = (t, entity, id, h, summary) => t.run('INSERT INTO audit(at,user_id,user_name,entity,entity_id,house_id,delegation,action,summary) VALUES(?,?,?,?,?,?,?,?,?)', [now, null, 'Importação', entity, id, h.id, h.delegation, 'update', summary]);

for (const [code, spec] of Object.entries(src.houses)) {
  const h = await db.get('SELECT * FROM houses WHERE code=?', [code]);
  if (!h) { console.log(`\n${code}: alojamento inexistente — ignorado.`); continue; }
  const occ = await db.all(`SELECT s.id sid, s.room_id, w.id wid, w.name FROM stays s JOIN workers w ON w.id=s.worker_id
    WHERE s.house_id=? AND s.start_date<=date('now') AND (s.end_date IS NULL OR s.end_date>date('now'))`, [h.id]);
  // quem aparece em mais de um quarto na origem
  const count = new Map();
  for (const r of spec.rooms) for (const n of r.people ?? []) count.set(norm(n), (count.get(norm(n)) ?? 0) + 1);
  const assign = [], dup = new Set(), unknown = [];
  for (const r of spec.rooms) for (const n of r.people ?? []) {
    if (count.get(norm(n)) > 1) { dup.add(n); continue; }
    const exact = occ.filter((o) => norm(o.name) === norm(n));
    const full = exact.length ? exact : occ.filter((o) => compareNames(n, o.name).kind === 'full');
    if (full.length === 1) assign.push({ room: r.name, o: full[0], as: n }); else unknown.push(`${n} (${r.name})${full.length > 1 ? ' — ambíguo' : ''}`);
  }
  const beds = spec.rooms.reduce((a, r) => a + r.beds, 0);
  console.log(`\n${code} «${h.name}»: ${spec.rooms.length} quartos, ${beds} camas (lotação atual: ${h.capacity ?? '—'}) · ${assign.length} pessoas com quarto · ${occ.length} alojados hoje`);
  if (dup.size) console.log(`  Em dois quartos na origem (sem quarto atribuído): ${[...dup].join(', ')}`);
  if (unknown.length) console.log(`  Não estão alojados aqui na aplicação (ignorados): ${unknown.join(', ')}`);
  const without = occ.filter((o) => !assign.some((a) => a.o.sid === o.sid)).map((o) => o.name);
  if (without.length) console.log(`  Alojados sem quarto na origem: ${without.join(', ')}`);
  if (dry) continue;
  await db.tx(async (t) => {
    let pos = (await t.get('SELECT COALESCE(MAX(position),0) p FROM rooms WHERE house_id=?', [h.id])).p;
    const ids = {};
    for (const r of spec.rooms) {
      const ex = await t.get('SELECT * FROM rooms WHERE house_id=? AND name=?', [h.id, r.name]);
      if (ex) { if (ex.beds !== r.beds) await t.run('UPDATE rooms SET beds=? WHERE id=?', [r.beds, ex.id]); ids[r.name] = ex.id; }
      else ids[r.name] = (await t.run('INSERT INTO rooms(house_id,name,beds,position) VALUES(?,?,?,?)', [h.id, r.name, r.beds, ++pos])).lastInsertRowid;
    }
    const tot = await t.get('SELECT COUNT(*) n, SUM(beds) b FROM rooms WHERE house_id=?', [h.id]);
    await t.run('UPDATE houses SET capacity=?, rooms=? WHERE id=?', [tot.b, tot.n, h.id]);
    await log(t, 'room', null, h, `Quartos de «${h.name}»: ${tot.n} quartos, ${tot.b} camas (lotação = soma das camas) — ${src.source ?? file}`);
    for (const a of assign) {
      if (a.o.room_id === ids[a.room]) continue;
      await t.run('UPDATE stays SET room_id=? WHERE id=?', [ids[a.room], a.o.sid]);
      await log(t, 'stay', a.o.sid, h, `«${a.o.name}» em «${h.name}»: quarto «${a.room}» (${src.source ?? file})`);
    }
  });
}
console.log(dry ? '\n(simulação: nada gravado)' : '\nGravado.');
