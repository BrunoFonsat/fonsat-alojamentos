// Dá entrada a funcionários nas casas, a partir de um JSON preparado (ex.: data/import/asturias-ocupantes.json, fora do git).
// Uso: node scripts/import-occupants.js <ficheiro.json>
// Formato: { delegation, date, reason, dated_reason?, houses: { "<código da casa>": ["NOME", ["NOME", "AAAA-MM-DD"], …] } }
//   - nome simples → entra na data `date` com o motivo `reason`;
//   - [nome, data] → entra nessa data (ex.: data de contrato) com `dated_reason`.
// Guarda só o nome (RGPD). Funcionário já existente (mesmo nome, sem distinguir maiúsculas) é reutilizado;
// quem já está alojado nessas datas é ignorado (a mesma pessoa não pode estar em duas casas).
import fs from 'node:fs';
import { openDb } from '../src/server/db.js';
import { DELEGATIONS, isDate } from '../src/server/schema.js';

const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!file) { console.error('Uso: node scripts/import-occupants.js <ficheiro.json>'); process.exit(1); }
const src = JSON.parse(fs.readFileSync(file, 'utf8'));
const del = src.delegation;
if (!DELEGATIONS.some(([k]) => k === del)) { console.error(`Delegação inválida: ${del}`); process.exit(1); }
if (!isDate(src.date) || !src.reason) { console.error('Falta «date» (AAAA-MM-DD) ou «reason».'); process.exit(1); }

const db = await openDb();
if (db.remote && process.env.ALOJ_IMPORT_REMOTE !== 'sim') { console.error('BD remota: defina ALOJ_IMPORT_REMOTE=sim para confirmar.'); process.exit(1); }

const errors = [], skipped = [];
let entered = 0, newWorkers = 0;
const seen = new Map();
for (const [code, list] of Object.entries(src.houses)) {
  const h = await db.get('SELECT id, name, delegation FROM houses WHERE code=? COLLATE NOCASE', [code]);
  if (!h) { errors.push(`${code}: casa inexistente`); continue; }
  if (h.delegation !== del) { errors.push(`${code}: casa de outra delegação`); continue; }
  for (const item of list) {
    const [name, date] = Array.isArray(item) ? item : [item, src.date];
    const reason = Array.isArray(item) ? (src.dated_reason || src.reason) : src.reason;
    const key = name.trim().toUpperCase();
    if (!name.trim() || !isDate(date)) { errors.push(`${code}: linha inválida ${JSON.stringify(item)}`); continue; }
    if (seen.has(key)) { errors.push(`${name}: aparece em ${seen.get(key)} e em ${code} — ignorado em ${code}`); continue; }
    seen.set(key, code);
    await db.tx(async (t) => {
      let w = await t.get('SELECT id FROM workers WHERE name=? COLLATE NOCASE ORDER BY id LIMIT 1', [name.trim()]);
      if (w) {
        const o = await t.get(`SELECT h.name FROM stays s JOIN houses h ON h.id=s.house_id WHERE s.worker_id=? AND (s.end_date IS NULL OR s.end_date>?)`, [w.id, date]);
        if (o) { skipped.push(`${name}: já alojado em «${o.name}»`); return; }
      } else {
        w = { id: (await t.run('INSERT INTO workers(name,phone,company,delegation) VALUES(?,?,?,?)', [name.trim(), '', '', del])).lastInsertRowid };
        newWorkers++;
      }
      const id = (await t.run('INSERT INTO stays(house_id,worker_id,start_date,entry_reason) VALUES(?,?,?,?)', [h.id, w.id, date, reason])).lastInsertRowid;
      await t.run('INSERT INTO audit(at,user_id,user_name,entity,entity_id,house_id,delegation,action,summary,changes) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [new Date().toISOString(), null, 'Importação', 'stay', id, h.id, del, 'create', `Entrada de «${name.trim()}» em «${h.name}» a ${date} — ${reason}`, JSON.stringify({ worker: name.trim(), start_date: date, entry_reason: reason, source: src.source ?? file })]);
      entered++;
    });
  }
}
console.log(`${entered} entradas registadas (${newWorkers} funcionários novos).`);
if (skipped.length) console.log(`\nIgnorados (${skipped.length}):\n  ${skipped.join('\n  ')}`);
if (errors.length) { console.log(`\nErros (${errors.length}):\n  ${errors.join('\n  ')}`); process.exitCode = 1; }
