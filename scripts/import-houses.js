// Importa casas reais a partir de um ficheiro JSON preparado (ex.: data/import/asturias.json, fora do git).
// Uso: node scripts/import-houses.js <ficheiro.json> [--substituir] [--sem-mapa]
//   --substituir  apaga primeiro as casas, ocupantes, despesas e histórico DE TESTE dessa delegação (só BD local)
//   --sem-mapa    não procura as moradas no mapa
// Casas já existentes (mesmo nome ou código) são ignoradas. Os ocupados da origem não têm nomes:
// ficam nas notas, e dá-se entrada às pessoas reais depois.
// Pinos: procurados no OpenStreetMap (só a morada sai). Ao nível do número da porta ficam confirmados;
// ao nível da rua ou da localidade ficam «por confirmar» (alerta na ficha da casa).
import fs from 'node:fs';
import { openDb } from '../src/server/db.js';
import { DELEGATIONS, validate } from '../src/server/schema.js';

const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const replace = process.argv.includes('--substituir');
const noMap = process.argv.includes('--sem-mapa');
if (!file) { console.error('Uso: node scripts/import-houses.js <ficheiro.json> [--substituir] [--sem-mapa]'); process.exit(1); }
const src = JSON.parse(fs.readFileSync(file, 'utf8'));
const del = src.delegation;
if (!DELEGATIONS.some(([k]) => k === del)) { console.error(`Delegação inválida: ${del}`); process.exit(1); }

const db = await openDb();
if (db.remote && replace) { console.error('--substituir não é permitido numa BD remota.'); process.exit(1); }
if (db.remote && process.env.ALOJ_IMPORT_REMOTE !== 'sim') { console.error('BD remota: defina ALOJ_IMPORT_REMOTE=sim para confirmar.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function geocode(q) {
  const url = new URL(process.env.ALOJ_GEOCODER_URL || 'https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'es,pt', addressdetails: '1' }).toString();
  const r = await fetch(url, { headers: { 'User-Agent': 'fonsat-alojamentos/0.1 (ferramenta interna de alojamentos)', 'Accept-Language': 'es,pt' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`serviço de mapas: HTTP ${r.status}`);
  const [g] = await r.json();
  return g ? { lat: Number(g.lat), lng: Number(g.lon), number: !!g.address?.house_number, street: !!g.address?.road, label: g.display_name } : null;
}
/** Tenta as pesquisas por ordem (da mais exata à localidade). Exata = encontrou o número da porta. */
async function locate(queries) {
  for (const [i, q] of queries.entries()) {
    await sleep(1100); // limite do Nominatim: 1 pedido por segundo
    const g = await geocode(q);
    if (g) return { ...g, level: g.number ? 'porta' : g.street ? 'rua' : 'localidade', first: i === 0 };
  }
  return null;
}

const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
function notesFor(x) {
  const parts = [];
  if (x.occ != null) parts.push(`Origem: ${plural(x.occ, 'ocupado', 'ocupados')}, ${plural(x.free ?? 0, 'livre', 'livres')} (dar entrada aos ocupantes reais).`);
  if (x.obs) parts.push(x.obs);
  parts.push(`Ref.: ${x.ref}.`);
  return parts.join(' ');
}

const rows = src.houses.map((x) => {
  const v = validate('houses', { name: x.name, code: x.code, delegation: del, region: x.region, address: x.address, rent: x.rent, capacity: x.capacity, rent_due_day: x.due, notes: notesFor(x), active: 1 });
  if (v.errors) { console.error(`${x.code} ${x.name}: ${Object.values(v.errors).join(' ')}`); process.exit(1); }
  return { ...v.row, geo: x.geo ?? [] };
});

await db.tx(async (t) => {
  if (replace) {
    const ids = (await t.all('SELECT id FROM houses WHERE delegation=?', [del])).map((r) => r.id);
    const inIds = ids.length ? `(${ids.join(',')})` : '(NULL)';
    await t.run(`DELETE FROM stays WHERE house_id IN ${inIds}`);
    await t.run(`DELETE FROM expense_adjustments WHERE house_id IN ${inIds}`);
    await t.run(`DELETE FROM houses WHERE id IN ${inIds}`);
    await t.run('DELETE FROM workers WHERE delegation=? AND id NOT IN (SELECT worker_id FROM stays)', [del]);
    await t.run('DELETE FROM audit WHERE delegation=?', [del]);
    console.log(`Dados anteriores de ${del} apagados (${ids.length} casas).`);
  }
});

const cols = ['name', 'code', 'delegation', 'region', 'address', 'location_url', 'rent', 'fixed_expenses', 'capacity', 'rooms', 'owner_name', 'contract_start', 'contract_end', 'deposit_amount', 'deposit_available', 'active', 'notes', 'rent_due_day'];
const report = [];
let created = 0;
for (const x of rows) {
  const dup = await db.get('SELECT name FROM houses WHERE name=? OR (code<>\'\' AND code=? COLLATE NOCASE)', [x.name, x.code]);
  if (dup) { report.push([x.code, x.name, 'já existia — ignorada']); continue; }
  let g = null;
  if (!noMap && x.geo.length) {
    try { g = await locate(x.geo); } catch (e) { console.error(`${x.code}: ${e.message}`); }
  }
  const review = g ? (g.level === 'porta' ? 0 : 1) : 0;
  await db.tx(async (t) => {
    const id = (await t.run(`INSERT INTO houses(${cols.join(',')},lat,lng,geo_source,geo_review) VALUES(${cols.map(() => '?').join(',')},?,?,?,?)`,
      [...cols.map((c) => x[c] ?? null), g?.lat ?? null, g?.lng ?? null, g ? 'auto' : null, review])).lastInsertRowid;
    await t.run('INSERT INTO audit(at,user_id,user_name,entity,entity_id,house_id,delegation,action,summary,changes) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [new Date().toISOString(), null, 'Importação', 'house', id, id, del, 'create', `Casa «${x.name}» importada (${src.source ?? file})`, JSON.stringify(Object.fromEntries(cols.map((c) => [c, x[c] ?? null])))]);
  });
  created++;
  report.push([x.code, x.name, g ? `pino ao nível da ${g.level}${review ? ' (por confirmar)' : ''}` : 'sem pino', g?.label ?? '']);
}
console.log(`\n${created} casas importadas em ${del}.\n`);
for (const r of report) console.log(r.join(' | '));
