import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import url from 'node:url';
import { DELEGATIONS, ENTITIES, ROLE_LABEL, validate, isDate, coordsFromUrl } from './schema.js';
import { buildWorkbook, readWorkbook, planHouses, planWorkers, HOUSE_COLS } from './excel.js';
import { login, sessionFrom, rateLimit, attemptAllowed, authCodeHash, setAuthCode, verifyPassword, hashPassword, checkUser, tempPassword, MIN_PASSWORD } from './auth.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json' };
const SEC_HEADERS = {
  // os mosaicos do mapa vêm do OpenStreetMap, que exige saber a origem (Referer): envia-se só o domínio, nunca o caminho
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin', 'X-Frame-Options': 'DENY',
};
const TRUST_PROXY = process.env.ALOJ_TRUST_PROXY === 'true' || !!process.env.VERCEL;
export const clientIp = (req) => (TRUST_PROXY ? (req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) : '') || req.socket.remoteAddress;
export class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

async function readJson(req) {
  if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Apenas application/json.');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 5 * 1024 * 1024) throw new HttpError(413, 'Pedido demasiado grande.'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'JSON inválido.'); }
}
const send = (res, status, body, headers = {}) => {
  const isStr = typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...headers });
  res.end(isStr ? body : JSON.stringify(body));
};
const delLabel = (k) => DELEGATIONS.find(([v]) => v === k)?.[1] ?? k;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pesquisa de moradas (OpenStreetMap Nominatim): no máximo 1 pedido por segundo, identificado, só com a morada da casa.
const GEOCODER = 'https://nominatim.openstreetmap.org/search';
const GEO_FAIL = 'O serviço de mapas não respondeu. Tente mais tarde ou coloque o pino à mão.';
let nextGeo = 0;
async function geocode(address) {
  const wait = nextGeo - Date.now(); nextGeo = Math.max(Date.now(), nextGeo) + 1100;
  if (wait > 0) await sleep(wait);
  const u = new URL(process.env.ALOJ_GEOCODER_URL || GEOCODER); // ALOJ_GEOCODER_URL: só para testes
  u.search = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'es,pt', q: address }).toString();
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(u, { signal: ac.signal, headers: { 'User-Agent': 'fonsat-alojamentos/0.1 (ferramenta interna de alojamentos)', 'Accept-Language': 'pt,es' } });
    if (!r.ok) throw new HttpError(502, GEO_FAIL);
    const j = await r.json();
    const hit = Array.isArray(j) && j[0];
    if (!hit) return null;
    const lat = Number(hit.lat), lng = Number(hit.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, GEO_FAIL);
  } finally { clearTimeout(to); }
}
const dayBefore = (d) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

export function createApp(db, { secureCookies = process.env.ALOJ_COOKIE_SECURE === 'true' || !!process.env.VERCEL } = {}) {
  async function requireUser(req) {
    const s = await sessionFrom(db, req);
    if (!s) throw new HttpError(401, 'Sessão terminada. Entre de novo.');
    if (req.method !== 'GET') {
      if (req.headers['x-csrf-token'] !== s.csrf) throw new HttpError(403, 'Pedido recusado (CSRF).');
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origem inválida.');
    }
    return s;
  }
  const isGestor = (u) => u.role === 'gestor';
  /** Vê todas as delegações: o gestor e o administrativo sem delegação atribuída. */
  const seesAll = (u) => isGestor(u) || (u.role === 'administrativo' && !u.delegation);
  const readOnly = (u) => u.role === 'administrativo';
  const canDel = (u, d) => isGestor(u) || u.delegation === d;

  // ---------- histórico ----------
  /** Regista uma alteração: o que mudou (antes → depois), quem e quando. */
  async function audit(t, u, { entity, id, house_id = null, delegation = null, action, summary, before = null, after = null }) {
    let changes = null;
    if (action === 'update' && before && after) {
      const diff = {};
      for (const k of Object.keys(after)) if (k !== 'id' && String(before[k] ?? '') !== String(after[k] ?? '')) diff[k] = [before[k] ?? null, after[k] ?? null];
      if (!Object.keys(diff).length) return;
      changes = diff;
    } else if (action === 'create' && after) changes = after;
    else if (action === 'delete' && before) changes = before;
    await t.run('INSERT INTO audit(at,user_id,user_name,entity,entity_id,house_id,delegation,action,summary,changes) VALUES(?,?,?,?,?,?,?,?,?,?)',
      [new Date().toISOString(), u.id, u.name, entity, id, house_id, delegation, action, summary, changes ? JSON.stringify(changes) : null]);
  }

  // ---------- leitura (sempre limitada à delegação do utilizador) ----------
  async function data(u) {
    const g = seesAll(u);
    const houses = await db.all(`SELECT * FROM houses ${g ? '' : 'WHERE delegation=?'} ORDER BY name`, g ? [] : [u.delegation]);
    const ids = houses.map((x) => x.id);
    const inIds = ids.length ? `(${ids.join(',')})` : '(NULL)';
    const stays = await db.all(`SELECT * FROM stays WHERE house_id IN ${inIds} ORDER BY start_date DESC, id DESC`);
    const rooms = await db.all(`SELECT * FROM rooms WHERE house_id IN ${inIds} ORDER BY house_id, position, name`);
    const checkins = await db.all(`SELECT id,house_id,created_at,expires_at,sent_at,answered_at,answer,status,applied_at,applied_by,decision FROM checkins WHERE house_id IN ${inIds} AND created_at>=? ORDER BY id DESC`, [new Date(Date.now() - 60 * 864e5).toISOString()]);
    const adjustments = await db.all(`SELECT * FROM expense_adjustments WHERE house_id IN ${inIds} ORDER BY month DESC`);
    const workers = g ? await db.all('SELECT * FROM workers ORDER BY name')
      : await db.all(`SELECT * FROM workers WHERE delegation=? OR delegation IS NULL OR id IN (SELECT worker_id FROM stays WHERE house_id IN ${inIds}) ORDER BY name`, [u.delegation]);
    const authCodeSet = !!(await authCodeHash(db));
    return { me: { id: u.id, name: u.name, email: u.email, role: u.role, delegation: u.delegation }, delegations: DELEGATIONS, houses, stays, rooms, checkins, adjustments, workers, authCodeSet: isGestor(u) ? authCodeSet : undefined };
  }
  async function houseInScope(t, u, id) {
    const h = await t.get('SELECT * FROM houses WHERE id=?', [Number(id)]);
    if (!h || !canDel(u, h.delegation)) throw new HttpError(404, 'Alojamento inexistente.');
    return h;
  }
  async function workerInScope(t, u, id) {
    const w = await t.get('SELECT * FROM workers WHERE id=?', [Number(id)]);
    if (!w) throw new HttpError(404, 'Funcionário inexistente.');
    if (isGestor(u) || w.delegation === u.delegation || w.delegation == null) return w; // pendentes: qualquer coordenador
    const housed = await t.get('SELECT 1 FROM stays s JOIN houses h ON h.id=s.house_id WHERE s.worker_id=? AND h.delegation=?', [w.id, u.delegation]);
    if (!housed) throw new HttpError(404, 'Funcionário inexistente.');
    return w;
  }
  const check = (entity, body) => {
    const v = validate(entity, body);
    if (v.errors) throw new HttpError(422, Object.values(v.errors).join(' '), { errors: v.errors });
    return v.row;
  };
  /**
   * A mesma pessoa não pode estar em dois alojamentos ao mesmo tempo.
   * Datas: a saída (end_date) é o dia em que sai — nesse dia já não conta (como o check-out). Período = [entrada, saída).
   */
  async function assertNoOverlap(t, workerId, start, end, exceptId = 0) {
    const o = await t.get(`SELECT h.name, s.start_date FROM stays s JOIN houses h ON h.id=s.house_id
      WHERE s.worker_id=? AND s.id<>? AND s.start_date<? AND (s.end_date IS NULL OR s.end_date>?)`, [workerId, exceptId, end ?? '9999-12-31', start]);
    if (o) throw new HttpError(422, `Este funcionário já está alojado em «${o.name}» nessas datas (desde ${o.start_date.split('-').reverse().join('/')}). Dê primeiro saída ou use «Transferir».`);
  }

  /**
   * Coordenadores precisam do código de autorização do gestor para editar dados de uma casa, inativá-la, apagá-la,
   * mudar o pino de sítio ou corrigir/apagar registos de entradas e saídas. O gestor não precisa.
   * Devolve o texto a juntar ao histórico.
   * Corre fora de transações (o limite de tentativas escreve na BD).
   */
  async function requireAuthCode(u, body, what) {
    if (isGestor(u)) return '';
    const code = String(body?.auth_code ?? '');
    const hash = await authCodeHash(db);
    if (!hash) throw new HttpError(403, `${what} precisa do código de autorização, mas o gestor ainda não o definiu (Definições).`);
    if (!code) throw new HttpError(403, `${what} precisa do código de autorização do gestor.`, { needAuth: true });
    if (!(await attemptAllowed(db, `auth:${u.id}`, 8, 15 * 60 * 1000))) throw new HttpError(429, 'Demasiadas tentativas do código. Aguarde 15 minutos.');
    if (!verifyPassword(code, hash)) throw new HttpError(403, 'Código de autorização errado.', { needAuth: true });
    await db.run('DELETE FROM login_attempts WHERE key=?', [`auth:${u.id}`]);
    return ' (autorizado com o código do gestor)';
  }

  // ---------- casas ----------
  async function saveHouse(u, body) {
    if (!isGestor(u)) body = { ...body, delegation: body.delegation || u.delegation };
    const row = check('houses', body);
    // novo alojamento com quartos (cada um com as suas camas): a lotação passa a ser a soma
    const roomList = !body.id && Array.isArray(body.room_list) ? body.room_list.filter((r) => String(r?.name ?? '').trim()) : [];
    if (roomList.length > 300) throw new HttpError(422, 'Demasiados quartos (máx. 300).');
    const roomRows = roomList.map((r) => roomCheck(r.name, r.beds));
    const seenRooms = new Set();
    for (const r of roomRows) { const k = r.name.toLowerCase(); if (seenRooms.has(k)) throw new HttpError(422, `Quarto repetido: «${r.name}».`); seenRooms.add(k); }
    if (roomRows.length) { row.capacity = roomRows.reduce((a, r) => a + r.beds, 0); row.rooms = roomRows.length; }
    if (!canDel(u, row.delegation)) throw new HttpError(403, 'Só pode gerir alojamentos da sua delegação.');
    let authNote = '';
    if (body.id) { await houseInScope(db, u, body.id); authNote = await requireAuthCode(u, body, 'Editar os dados do alojamento'); }
    const cols = Object.keys(ENTITIES.houses.fields);
    return db.tx(async (t) => {
      const dup = await t.get('SELECT id FROM houses WHERE name=? AND id<>?', [row.name, Number(body.id) || 0]);
      if (body.id) {
        const rs = await t.get('SELECT COUNT(*) n, COALESCE(SUM(beds),0) b FROM rooms WHERE house_id=?', [Number(body.id)]);
        if (rs.n) { row.capacity = rs.b; row.rooms = rs.n; } // com quartos: lotação = soma das camas
      }
      if (dup) throw new HttpError(422, `Já existe um alojamento com o nome «${row.name}».`);
      if (row.code) {
        const dupc = await t.get('SELECT name FROM houses WHERE code=? COLLATE NOCASE AND id<>?', [row.code, Number(body.id) || 0]);
        if (dupc) throw new HttpError(422, `O código «${row.code}» já é usado por «${dupc.name}».`);
      }
      const link = coordsFromUrl(row.location_url);
      if (body.id) {
        const before = await houseInScope(t, u, body.id);
        // pino:
        // - colocado à mão: nunca é substituído; se a morada ou o link mudarem fica «por confirmar» (alerta)
        // - vindo do link: segue o link; sem link volta a ser procurado pela morada
        // - automático: mantém-se enquanto a morada for a mesma; com outra morada volta a ser procurado
        const before0 = { lat: before.lat, lng: before.lng, geo_source: before.geo_source, geo_review: before.geo_review };
        let geo = before0;
        const addressChanged = before.address !== row.address;
        const oldLink = coordsFromUrl(before.location_url);
        const linkChanged = !!link && (!oldLink || oldLink.lat !== link.lat || oldLink.lng !== link.lng);
        if (before.geo_source === 'manual') {
          if (addressChanged || linkChanged) geo = { ...before0, geo_review: 1 };
        } else if (link) geo = { ...link, geo_source: 'link', geo_review: 0 };
        else if (before.geo_source === 'link' || addressChanged) geo = { lat: null, lng: null, geo_source: null, geo_review: 0 };
        if (geo.lat == null && row.building) {
          const sib = await t.get('SELECT lat, lng, geo_source FROM houses WHERE building=? COLLATE NOCASE AND delegation=? AND id<>? AND lat IS NOT NULL LIMIT 1', [row.building, row.delegation, before.id]);
          if (sib) geo = { lat: sib.lat, lng: sib.lng, geo_source: sib.geo_source, geo_review: 0 };
        }
        await t.run(`UPDATE houses SET ${cols.map((c) => `${c}=?`).join(',')}, lat=?, lng=?, geo_source=?, geo_review=? WHERE id=?`, [...cols.map((c) => row[c]), geo.lat, geo.lng, geo.geo_source, geo.geo_review, before.id]);
        const pinNote = geo.geo_review && !before.geo_review ? ' — pino colocado à mão mantido, por confirmar' : '';
        await audit(t, u, { entity: 'house', id: before.id, house_id: before.id, delegation: row.delegation, action: 'update', summary: `Alojamento «${row.name}» alterado${!row.active && before.active ? ' — inativada' : ''}${pinNote}${authNote}`, before, after: row });
        return { id: before.id };
      }
      let pin = link ? { ...link, geo_source: 'link' } : null;
      if (!pin && row.building) pin = await t.get('SELECT lat, lng, geo_source FROM houses WHERE building=? COLLATE NOCASE AND delegation=? AND lat IS NOT NULL LIMIT 1', [row.building, row.delegation]);
      const id = (await t.run(`INSERT INTO houses(${cols.join(',')},lat,lng,geo_source) VALUES(${cols.map(() => '?').join(',')},?,?,?)`,
        [...cols.map((c) => row[c]), pin?.lat ?? null, pin?.lng ?? null, pin?.geo_source ?? null])).lastInsertRowid;
      roomRows.forEach((r, i) => { r.pos = i + 1; });
      for (const r of roomRows) await t.run('INSERT INTO rooms(house_id,name,beds,position) VALUES(?,?,?,?)', [id, r.name, r.beds, r.pos]);
      await audit(t, u, { entity: 'house', id, house_id: id, delegation: row.delegation, action: 'create', summary: `Alojamento «${row.name}» criado (${delLabel(row.delegation)})${roomRows.length ? ` com ${roomRows.length} quartos e ${row.capacity} camas` : ''}`, after: row });
      return { id };
    });
  }
  /** Casa com histórico (ocupantes ou despesas lançadas) não se apaga: inativa-se. Vale também para o gestor. */
  async function houseHistory(t, id) {
    const st = (await t.get('SELECT COUNT(*) n FROM stays WHERE house_id=?', [id])).n;
    const adj = (await t.get('SELECT COUNT(*) n FROM expense_adjustments WHERE house_id=?', [id])).n;
    return st || adj ? `${st} registo${st === 1 ? '' : 's'} de ocupantes e ${adj} mês${adj === 1 ? '' : 'es'} de despesas` : '';
  }
  const HISTORY_MSG = (name, what) => `«${name}» tem histórico (${what}) e não pode ser apagado. Para deixar de o usar, desmarque «Alojamento ativo» (inativar).`;
  async function deleteHouse(u, id, body) {
    const h0 = await houseInScope(db, u, id);
    const hist0 = await houseHistory(db, h0.id);
    if (hist0) throw new HttpError(409, HISTORY_MSG(h0.name, hist0), { hasHistory: true });
    const authNote = await requireAuthCode(u, body, 'Apagar o alojamento');
    return db.tx(async (t) => {
      const h = await houseInScope(t, u, id);
      const hist = await houseHistory(t, h.id); // pode ter mudado entretanto
      if (hist) throw new HttpError(409, HISTORY_MSG(h.name, hist), { hasHistory: true });
      await t.run('DELETE FROM houses WHERE id=?', [h.id]);
      await audit(t, u, { entity: 'house', id: h.id, house_id: h.id, delegation: h.delegation, action: 'delete', summary: `Alojamento «${h.name}» apagado (sem histórico)${authNote}`, before: h });
    });
  }

  /**
   * Procura a morada no mapa e guarda o pino — só quando a casa ainda não tem pino (nunca substitui um existente).
   * `preview`: só devolve as coordenadas encontradas, sem gravar (para «Procurar pela morada» ao editar a localização).
   */
  async function geocodeHouse(u, id, preview = false) {
    const h = await houseInScope(db, u, id);
    if (!preview && h.lat != null) return { lat: h.lat, lng: h.lng, geo_source: h.geo_source };
    if (!h.address) throw new HttpError(422, 'Sem morada: escreva a morada ou coloque o pino à mão.');
    const g = await geocode(h.address);
    if (!g) throw new HttpError(422, 'Morada não encontrada no mapa. Corrija a morada ou coloque o pino à mão.');
    if (preview) return { ...g, preview: true };
    const r = await db.run("UPDATE houses SET lat=?, lng=?, geo_source='auto', geo_review=0 WHERE id=? AND lat IS NULL", [g.lat, g.lng, h.id]);
    if (!r.changes) { const now = await houseInScope(db, u, id); return { lat: now.lat, lng: now.lng, geo_source: now.geo_source }; }
    return { ...g, geo_source: 'auto' };
  }
  /** Outros andares do mesmo edifício (mesma delegação). */
  const siblingsOf = (t, h) => (h.building ? t.all('SELECT * FROM houses WHERE building=? COLLATE NOCASE AND delegation=? AND id<>?', [h.building, h.delegation, h.id]) : Promise.resolve([]));
  /**
   * Pino colocado ou arrastado à mão (fica fixo). lat/lng a null apaga o pino.
   * A localização de um edifício é partilhada: mudar o pino de um andar move todos os andares.
   * Coordenadores precisam do código para mudar ou apagar um pino que já exista — do próprio andar OU de outro andar do edifício.
   * Confirmar o pino no mesmo sítio (alerta «por confirmar») não pede código: não muda nada.
   * Cada alojamento afetado recebe a sua linha no histórico.
   */
  async function setPosition(u, id, body) {
    const clear = body.lat === null && body.lng === null;
    const lat = Number(body.lat), lng = Number(body.lng);
    if (!clear && !(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw new HttpError(422, 'Posição inválida.');
    const cur = await houseInScope(db, u, id);
    const sibs0 = await siblingsOf(db, cur);
    const ref = cur.lat != null ? cur : sibs0.find((x) => x.lat != null); // pino atual do alojamento ou do edifício
    const same = !clear && ref && Math.abs(ref.lat - lat) < 1e-6 && Math.abs(ref.lng - lng) < 1e-6;
    const what = cur.building ? `Mudar a localização do edifício «${cur.building}»` : 'Mudar a localização';
    const authNote = ref && !same ? await requireAuthCode(u, body, what) : '';
    return db.tx(async (t) => {
      const h = await houseInScope(t, u, id);
      const all = [h, ...(await siblingsOf(t, h))];
      const after = clear ? { lat: null, lng: null, geo_source: null } : { lat, lng, geo_source: 'manual' };
      for (const x of all) {
        await t.run('UPDATE houses SET lat=?, lng=?, geo_source=?, geo_review=0 WHERE id=?', [after.lat, after.lng, after.geo_source, x.id]);
        const via = x.id === h.id ? '' : ` (edifício «${h.building}», alterado a partir de «${h.name}»)`;
        const summary = same ? `Localização de «${x.name}» confirmada${via}`
          : clear ? `Pino de «${x.name}» removido${via}`
          : x.lat != null ? `Localização de «${x.name}» alterada${via}` : `Pino de «${x.name}» colocado no mapa${via}`;
        const changed = same ? { geo_review: [x.geo_review, 0] } : { lat: [x.lat, after.lat], lng: [x.lng, after.lng] };
        if (same && !x.geo_review && x.geo_source === 'manual') continue; // nada mudou neste andar
        await t.run('INSERT INTO audit(at,user_id,user_name,entity,entity_id,house_id,delegation,action,summary,changes) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [new Date().toISOString(), u.id, u.name, 'house', x.id, x.id, x.delegation, 'update', summary + authNote, JSON.stringify(changed)]);
      }
      return { ...after, floors: all.length };
    });
  }

  /** Confirma que uma casa sem registos de ocupantes está mesmo vazia (deixa de ser «ocupação desconhecida»). Sem código: é um facto, não um valor. */
  async function confirmEmpty(u, id) {
    return db.tx(async (t) => {
      const h = await houseInScope(t, u, id);
      const today = new Date().toISOString().slice(0, 10);
      const n = (await t.get('SELECT COUNT(*) n FROM stays WHERE house_id=? AND start_date<=? AND (end_date IS NULL OR end_date>?)', [h.id, today, today])).n;
      if (n) throw new HttpError(422, `«${h.name}» tem ${n} pessoa${n === 1 ? '' : 's'} alojada${n === 1 ? '' : 's'} hoje: não está vazio.`);
      await t.run('UPDATE houses SET occ_checked=? WHERE id=?', [today, h.id]);
      await audit(t, u, { entity: 'house', id: h.id, house_id: h.id, delegation: h.delegation, action: 'update', summary: `Confirmado que «${h.name}» está vazio (a ${today})`, before: { occ_checked: h.occ_checked }, after: { occ_checked: today } });
      return { occ_checked: today };
    });
  }

  // ---------- quartos ----------
  /** Com quartos, a lotação e o n.º de quartos do alojamento são calculados (soma das camas). */
  async function syncCapacity(t, houseId) {
    const r = await t.get('SELECT COUNT(*) n, COALESCE(SUM(beds),0) b FROM rooms WHERE house_id=?', [houseId]);
    if (r.n) await t.run('UPDATE houses SET capacity=?, rooms=? WHERE id=?', [r.b, r.n, houseId]);
  }
  const roomCheck = (name, beds) => {
    name = String(name ?? '').trim();
    if (!name || name.length > 60) throw new HttpError(422, 'Nome do quarto: obrigatório (até 60 caracteres).');
    const b = Number(beds);
    if (!Number.isInteger(b) || b < 0 || b > 50) throw new HttpError(422, 'Camas: número inteiro de 0 a 50.');
    return { name, beds: b };
  };
  /** Criar ou alterar um quarto (muda a lotação: o coordenador precisa do código do gestor). */
  async function saveRoom(u, body) {
    const v = roomCheck(body.name, body.beds);
    await houseInScope(db, u, body.house_id);
    const authNote = await requireAuthCode(u, body, 'Alterar os quartos do alojamento');
    return db.tx(async (t) => {
      const h = await houseInScope(t, u, body.house_id);
      if (await t.get('SELECT 1 FROM rooms WHERE house_id=? AND name=? AND id<>?', [h.id, v.name, Number(body.id) || 0])) throw new HttpError(422, `Já existe o quarto «${v.name}».`);
      let id = Number(body.id) || 0, before = null;
      if (id) {
        before = await t.get('SELECT * FROM rooms WHERE id=? AND house_id=?', [id, h.id]);
        if (!before) throw new HttpError(404, 'Quarto inexistente.');
        await t.run('UPDATE rooms SET name=?, beds=? WHERE id=?', [v.name, v.beds, id]);
      } else {
        const pos = (await t.get('SELECT COALESCE(MAX(position),0)+1 p FROM rooms WHERE house_id=?', [h.id])).p;
        id = (await t.run('INSERT INTO rooms(house_id,name,beds,position) VALUES(?,?,?,?)', [h.id, v.name, v.beds, pos])).lastInsertRowid;
      }
      await syncCapacity(t, h.id);
      await audit(t, u, { entity: 'room', id, house_id: h.id, delegation: h.delegation, action: before ? 'update' : 'create', summary: `Quarto «${v.name}» ${before ? 'alterado' : 'criado'} em «${h.name}» (${v.beds} camas)${authNote}`, before, after: v });
      return { id };
    });
  }
  /** Vários quartos de uma vez: «Habitación 1» … «Habitación 14», N camas cada (os que já existem ficam como estão). */
  async function saveRoomsBulk(u, body) {
    const from = Number(body.from), to = Number(body.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to - from > 199) throw new HttpError(422, 'Números de quarto inválidos (até 200 de uma vez).');
    const prefix = String(body.prefix ?? '').replace(/\s+$/, '');
    const v = roomCheck(`${prefix} ${to}`, body.beds);
    await houseInScope(db, u, body.house_id);
    const authNote = await requireAuthCode(u, body, 'Alterar os quartos do alojamento');
    return db.tx(async (t) => {
      const h = await houseInScope(t, u, body.house_id);
      let pos = (await t.get('SELECT COALESCE(MAX(position),0) p FROM rooms WHERE house_id=?', [h.id])).p, created = 0;
      for (let n = from; n <= to; n++) {
        const name = `${prefix} ${n}`.trim();
        if (await t.get('SELECT 1 FROM rooms WHERE house_id=? AND name=?', [h.id, name])) continue;
        await t.run('INSERT INTO rooms(house_id,name,beds,position) VALUES(?,?,?,?)', [h.id, name, v.beds, ++pos]); created++;
      }
      await syncCapacity(t, h.id);
      if (created) await audit(t, u, { entity: 'room', id: null, house_id: h.id, delegation: h.delegation, action: 'create', summary: `${created} quartos criados em «${h.name}» (${prefix} ${from} a ${to}, ${v.beds} camas cada)${authNote}` });
      return { created };
    });
  }
  /** Apagar quarto: só sem histórico (ninguém lá esteve); pede código ao coordenador. */
  async function deleteRoom(u, id, body) {
    const r0 = await db.get('SELECT * FROM rooms WHERE id=?', [Number(id)]);
    if (!r0) throw new HttpError(404, 'Quarto inexistente.');
    await houseInScope(db, u, r0.house_id);
    const n = (await db.get('SELECT COUNT(*) n FROM stays WHERE room_id=?', [r0.id])).n;
    if (n) throw new HttpError(409, `O quarto «${r0.name}» tem ${n} registo${n === 1 ? '' : 's'} de ocupantes e não pode ser apagado. Mude primeiro as pessoas de quarto ou ponha 0 camas.`);
    const authNote = await requireAuthCode(u, body, 'Alterar os quartos do alojamento');
    return db.tx(async (t) => {
      const h = await houseInScope(t, u, r0.house_id);
      await t.run('DELETE FROM rooms WHERE id=?', [r0.id]);
      await syncCapacity(t, h.id);
      await audit(t, u, { entity: 'room', id: r0.id, house_id: h.id, delegation: h.delegation, action: 'delete', summary: `Quarto «${r0.name}» apagado em «${h.name}»${authNote}`, before: r0 });
    });
  }
  /** Mudar de quarto (dentro do mesmo alojamento): é um movimento, não pede código. */
  async function moveRoom(u, stayId, body) {
    return db.tx(async (t) => {
      const s = await t.get('SELECT * FROM stays WHERE id=?', [Number(stayId)]);
      if (!s) throw new HttpError(404, 'Registo inexistente.');
      const h = await houseInScope(t, u, s.house_id);
      const room = body.room_id ? await t.get('SELECT * FROM rooms WHERE id=? AND house_id=?', [Number(body.room_id), h.id]) : null;
      if (body.room_id && !room) throw new HttpError(422, 'Esse quarto não é deste alojamento.');
      const old = s.room_id ? await t.get('SELECT name FROM rooms WHERE id=?', [s.room_id]) : null;
      const w = await t.get('SELECT name FROM workers WHERE id=?', [s.worker_id]);
      await t.run('UPDATE stays SET room_id=? WHERE id=?', [room?.id ?? null, s.id]);
      await audit(t, u, { entity: 'stay', id: s.id, house_id: h.id, delegation: h.delegation, action: 'update', summary: `«${w?.name}» em «${h.name}»: ${old ? `«${old.name}»` : 'sem quarto'} → ${room ? `«${room.name}»` : 'sem quarto'}`, before: { room: old?.name ?? null }, after: { room: room?.name ?? null } });
      return { ok: true };
    });
  }

  // ---------- responsável e lista semanal ----------
  const today = () => new Date().toISOString().slice(0, 10);
  const currentStays = (t, houseId) => t.all(`SELECT s.id, s.worker_id, s.start_date, w.name FROM stays s JOIN workers w ON w.id=s.worker_id
    WHERE s.house_id=? AND s.start_date<=? AND (s.end_date IS NULL OR s.end_date>?) ORDER BY w.name`, [houseId, today(), today()]);
  /** Nomear o responsável (tem de estar alojado neste alojamento hoje). Movimento: não pede código. */
  async function setResponsible(u, id, body) {
    return db.tx(async (t) => {
      const h = await houseInScope(t, u, id);
      const wid = body.worker_id ? Number(body.worker_id) : null;
      let w = null;
      if (wid) {
        if (!(await currentStays(t, h.id)).some((s) => s.worker_id === wid)) throw new HttpError(422, 'O responsável tem de estar alojado neste alojamento.');
        w = await t.get('SELECT name FROM workers WHERE id=?', [wid]);
      }
      const old = h.responsible_id ? await t.get('SELECT name FROM workers WHERE id=?', [h.responsible_id]) : null;
      await t.run('UPDATE houses SET responsible_id=? WHERE id=?', [wid, h.id]);
      await audit(t, u, { entity: 'house', id: h.id, house_id: h.id, delegation: h.delegation, action: 'update', summary: w ? `«${w.name}» é o responsável de «${h.name}»` : `«${h.name}» ficou sem responsável`, before: { responsible: old?.name ?? null }, after: { responsible: w?.name ?? null } });
      return { ok: true };
    });
  }
  const hashToken = (tk) => crypto.createHash('sha256').update(tk).digest('hex');
  /** Pedido de lista ao responsável: link único, válido 7 dias, só deste alojamento. Devolve o link (o token não fica guardado). */
  async function createCheckin(u, id, base) {
    return db.tx(async (t) => {
      const h = await houseInScope(t, u, id);
      if (!h.responsible_id) throw new HttpError(422, 'Nomeie primeiro o responsável do alojamento.');
      const token = crypto.randomBytes(24).toString('base64url');
      const now = new Date(), exp = new Date(now.getTime() + 7 * 864e5);
      await t.run("UPDATE checkins SET status='arquivado' WHERE house_id=? AND status='aberto'", [h.id]); // um pedido aberto de cada vez
      const cid = (await t.run('INSERT INTO checkins(house_id,token_hash,created_at,created_by,expires_at) VALUES(?,?,?,?,?)', [h.id, hashToken(token), now.toISOString(), u.id, exp.toISOString()])).lastInsertRowid;
      await audit(t, u, { entity: 'checkin', id: cid, house_id: h.id, delegation: h.delegation, action: 'create', summary: `Pedido de lista semanal para «${h.name}» (válido até ${exp.toISOString().slice(0, 10).split('-').reverse().join('/')})` });
      return { id: cid, url: `${base}/lista/${token}`, expires_at: exp.toISOString() };
    });
  }
  /** Vários pedidos de uma vez (fila «Pedir a todos»): um link por alojamento; os que não têm responsável são ignorados. */
  async function createCheckins(u, body, base) {
    const ids = [...new Set((Array.isArray(body.house_ids) ? body.house_ids : []).map(Number))].slice(0, 200);
    const out = [];
    for (const id of ids) {
      try { out.push({ house_id: id, ...(await createCheckin(u, id, base)) }); }
      catch (e) { out.push({ house_id: id, error: e.message }); }
    }
    return { items: out };
  }
  async function markSent(u, cid) {
    const c = await db.get('SELECT * FROM checkins WHERE id=?', [Number(cid)]);
    if (!c) throw new HttpError(404, 'Pedido inexistente.');
    await houseInScope(db, u, c.house_id);
    await db.run('UPDATE checkins SET sent_at=COALESCE(sent_at,?) WHERE id=?', [new Date().toISOString(), c.id]);
    return { ok: true };
  }
  /** Página pública: dados mínimos (nomes dos ocupantes deste alojamento; sem telefones). */
  async function publicCheckin(token) {
    const c = await db.get('SELECT * FROM checkins WHERE token_hash=?', [hashToken(String(token))]);
    if (!c || c.status === 'arquivado' || c.status === 'aplicado' || c.expires_at < new Date().toISOString()) throw new HttpError(404, 'Este link já não é válido. Peça um novo ao seu coordenador.');
    const h = await db.get('SELECT id, name, responsible_id FROM houses WHERE id=?', [c.house_id]);
    const r = h.responsible_id ? await db.get('SELECT name, language FROM workers WHERE id=?', [h.responsible_id]) : null;
    return { c, h, r, occupants: (await currentStays(db, h.id)).map((s) => ({ id: s.worker_id, name: s.name })) };
  }
  async function answerCheckin(token, body) {
    const { c, occupants } = await publicCheckin(token);
    const ids = new Set(occupants.map((o) => o.id));
    const present = [...new Set((Array.isArray(body.present) ? body.present : []).map(Number).filter((x) => ids.has(x)))];
    const newNames = (Array.isArray(body.new_names) ? body.new_names : []).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30).map((x) => x.slice(0, 120));
    const note = String(body.note ?? '').trim().slice(0, 500);
    const answer = { present, left: occupants.filter((o) => !present.includes(o.id)).map((o) => o.id), new_names: newNames, note };
    await db.tx(async (t) => {
      await t.run("UPDATE checkins SET answered_at=?, answer=?, status='respondido' WHERE id=?", [new Date().toISOString(), JSON.stringify(answer), c.id]);
      const h = await t.get('SELECT * FROM houses WHERE id=?', [c.house_id]);
      await t.run('INSERT INTO audit(at,user_id,user_name,entity,entity_id,house_id,delegation,action,summary) VALUES(?,?,?,?,?,?,?,?,?)',
        [new Date().toISOString(), null, 'Responsável (link)', 'checkin', c.id, h.id, h.delegation, 'update', `Lista semanal de «${h.name}» recebida: ${present.length} confirmados, ${answer.left.length} saíram, ${newNames.length} novos`]);
    });
    return { ok: true };
  }
  /**
   * Decidir a resposta do responsável (coordenador/gestor). O responsável só informa: nada muda sem esta decisão.
   * Cada saída informada: aceitar (dá saída) ou recusar. Cada pessoa nova: associar a um funcionário existente,
   * criar um funcionário novo, ou recusar — é obrigatório decidir todas. Fica registado o que foi aceite e recusado.
   * body: { exits: [worker_id], entries: [{ name, worker_id } | { name, create: true } | { name, reject: true }], archive? }
   */
  async function applyCheckin(u, cid, body) {
    return db.tx(async (t) => {
      const c = await t.get('SELECT * FROM checkins WHERE id=?', [Number(cid)]);
      if (!c) throw new HttpError(404, 'Pedido inexistente.');
      const h = await houseInScope(t, u, c.house_id);
      if (c.status !== 'respondido') throw new HttpError(422, 'Este pedido não tem resposta por decidir.');
      const date = String(c.answered_at).slice(0, 10);
      const ans = JSON.parse(c.answer || '{}');
      const nowIso = new Date().toISOString();
      const decision = { exits: [], exits_rejected: [], entries: [], entries_rejected: [] };
      const nameOf = async (wid) => (await t.get('SELECT name FROM workers WHERE id=?', [wid]))?.name ?? `#${wid}`;
      if (body.archive) {
        for (const wid of ans.left ?? []) decision.exits_rejected.push(await nameOf(wid));
        decision.entries_rejected.push(...(ans.new_names ?? []));
      } else {
        // todas as pessoas novas têm de ter decisão
        const dec = new Map((Array.isArray(body.entries) ? body.entries : []).map((e) => [String(e.name ?? '').trim(), e]));
        const missing = (ans.new_names ?? []).filter((n) => { const e = dec.get(n); return !e || !(e.worker_id || e.create || e.reject); });
        if (missing.length) throw new HttpError(422, `Decida cada pessoa nova (associar, criar ou recusar): ${missing.map((n) => `«${n}»`).join(', ')}.`);
        const accepted = new Set((body.exits ?? []).map(Number));
        for (const wid of ans.left ?? []) {
          const s = (await currentStays(t, h.id)).find((x) => x.worker_id === wid);
          if (!accepted.has(wid) || !s) { decision.exits_rejected.push(await nameOf(wid)); continue; }
          const end = date < s.start_date ? s.start_date : date;
          await t.run('UPDATE stays SET end_date=?, exit_reason=? WHERE id=?', [end, 'Saída indicada pelo responsável (lista semanal)', s.id]);
          await dropResponsible(t, h.id, wid);
          await audit(t, u, { entity: 'stay', id: s.id, house_id: h.id, delegation: h.delegation, action: 'update', summary: `Saída de «${s.name}» de «${h.name}» a ${end} — indicada pelo responsável (lista semanal)` });
          decision.exits.push(s.name);
        }
        for (const n of ans.new_names ?? []) {
          const e = dec.get(n);
          if (e.reject) { decision.entries_rejected.push(n); continue; }
          let w;
          if (e.create) {
            const name = n.replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 120);
            const wid = (await t.run('INSERT INTO workers(name,delegation) VALUES(?,?)', [name, h.delegation])).lastInsertRowid;
            await audit(t, u, { entity: 'worker', id: wid, delegation: h.delegation, action: 'create', summary: `Funcionário «${name}» criado a partir da lista semanal de «${h.name}»`, after: { name, delegation: h.delegation } });
            w = { id: wid, name, delegation: h.delegation, own_housing: 0 };
          } else w = await workerInScope(t, u, Number(e.worker_id));
          // já está noutro alojamento? só com transferência confirmada (sai de lá e entra aqui hoje)
          const today0 = new Date().toISOString().slice(0, 10);
          const elsewhere = await t.get(`SELECT s.*, h2.name hname, h2.delegation hdel FROM stays s JOIN houses h2 ON h2.id=s.house_id
            WHERE s.worker_id=? AND s.start_date<=? AND (s.end_date IS NULL OR s.end_date>?) ORDER BY s.start_date DESC LIMIT 1`, [w.id, today0, today0]);
          if (elsewhere && elsewhere.house_id === h.id) { decision.entries_rejected.push(`${n} (já está neste alojamento)`); continue; }
          let entryDate = date, via = '';
          if (elsewhere) {
            if (!e.transfer) throw new HttpError(422, `«${w.name}» está no alojamento «${elsewhere.hname}». Confirme a transferência ou escolha outro funcionário.`, { needTransfer: true });
            if (!canDel(u, elsewhere.hdel)) throw new HttpError(403, `«${w.name}» está num alojamento de outra delegação («${elsewhere.hname}»). Peça a transferência ao gestor.`);
            entryDate = today0;
            const end = entryDate < elsewhere.start_date ? elsewhere.start_date : entryDate;
            await t.run('UPDATE stays SET end_date=?, exit_reason=? WHERE id=?', [end, `Transferência para «${h.name}» (lista semanal)`, elsewhere.id]);
            await dropResponsible(t, elsewhere.house_id, w.id);
            await audit(t, u, { entity: 'stay', id: elsewhere.id, house_id: elsewhere.house_id, delegation: elsewhere.hdel, action: 'update', summary: `Transferência de «${w.name}»: «${elsewhere.hname}» → «${h.name}» a ${end} — indicada pelo responsável de «${h.name}» (lista semanal)`, before: { end_date: null }, after: { end_date: end } });
            via = ` (transferido de «${elsewhere.hname}»)`;
          }
          await assertNoOverlap(t, w.id, entryDate, null);
          if (w.delegation == null) await t.run('UPDATE workers SET delegation=? WHERE id=?', [h.delegation, w.id]);
          if (w.own_housing) await t.run('UPDATE workers SET own_housing=0 WHERE id=?', [w.id]);
          const sid = (await t.run('INSERT INTO stays(house_id,worker_id,start_date,entry_reason) VALUES(?,?,?,?)', [h.id, w.id, entryDate, via ? `Transferência${via.replace(' (transferido', '').replace(')', '')} (lista semanal)` : 'Indicado pelo responsável (lista semanal)'])).lastInsertRowid;
          await audit(t, u, { entity: 'stay', id: sid, house_id: h.id, delegation: h.delegation, action: 'create', summary: `Entrada de «${w.name}» em «${h.name}» a ${entryDate}${via} — indicada pelo responsável (lista semanal${w.name !== n.toUpperCase() ? `, escrito «${n}»` : ''})` });
          decision.entries.push(`${w.name}${w.name === n.toUpperCase() ? '' : ` (escrito «${n}»)`}${via}`);
        }
      }
      const changed = decision.exits.length + decision.entries.length;
      const status = body.archive || !changed ? 'arquivado' : 'aplicado';
      await t.run('UPDATE checkins SET status=?, applied_at=?, applied_by=?, decision=? WHERE id=?', [status, nowIso, u.name, JSON.stringify(decision), c.id]);
      const parts = [decision.exits.length ? `saídas aceites: ${decision.exits.join(', ')}` : null, decision.entries.length ? `entradas aceites: ${decision.entries.join(', ')}` : null,
        decision.exits_rejected.length ? `saídas recusadas: ${decision.exits_rejected.join(', ')}` : null, decision.entries_rejected.length ? `novos recusados: ${decision.entries_rejected.map((n) => `«${n}»`).join(', ')}` : null].filter(Boolean);
      await audit(t, u, { entity: 'checkin', id: c.id, house_id: h.id, delegation: h.delegation, action: 'update', summary: `Lista semanal de «${h.name}» ${body.archive ? 'recusada (arquivada sem alterações)' : 'decidida'}${parts.length ? ` — ${parts.join('; ')}` : ' — sem alterações'}`, after: decision });
      return { exits: decision.exits.length, entries: decision.entries.length, rejected: decision.exits_rejected.length + decision.entries_rejected.length };
    });
  }

  // ---------- acertos de despesas ----------
  async function saveAdjustment(u, body) {
    const row = check('adjustments', body);
    return db.tx(async (t) => {
      const h = await houseInScope(t, u, row.house_id);
      const before = await t.get('SELECT * FROM expense_adjustments WHERE house_id=? AND month=?', [h.id, row.month]);
      await t.run('INSERT INTO expense_adjustments(house_id,month,value,note) VALUES(?,?,?,?) ON CONFLICT(house_id,month) DO UPDATE SET value=excluded.value, note=excluded.note', [h.id, row.month, row.value, row.note]);
      await audit(t, u, { entity: 'adjustment', id: before?.id ?? null, house_id: h.id, delegation: h.delegation, action: before ? 'update' : 'create', summary: `Despesas reais de ${row.month} em «${h.name}»: ${row.value} €`, before, after: row });
      return { ok: true };
    });
  }
  async function deleteAdjustment(u, id) {
    return db.tx(async (t) => {
      const a = await t.get('SELECT * FROM expense_adjustments WHERE id=?', [Number(id)]);
      if (!a) throw new HttpError(404, 'Registo inexistente.');
      const h = await houseInScope(t, u, a.house_id);
      await t.run('DELETE FROM expense_adjustments WHERE id=?', [a.id]);
      await audit(t, u, { entity: 'adjustment', id: a.id, house_id: h.id, delegation: h.delegation, action: 'delete', summary: `Acerto de ${a.month} em «${h.name}» apagado (volta ao valor fixo)`, before: a });
    });
  }

  // ---------- funcionários ----------
  async function saveWorker(u, body) {
    if (!isGestor(u) && !body.id) body = { ...body, delegation: body.delegation || u.delegation };
    const row = check('workers', body);
    // criar: na sua delegação; editar: o funcionário tem de estar no seu âmbito (workerInScope) e a delegação não muda
    if (!body.id && !canDel(u, row.delegation)) throw new HttpError(403, 'Só pode registar funcionários da sua delegação.');
    return db.tx(async (t) => {
      if (body.id) {
        const before = await workerInScope(t, u, body.id);
        if (!isGestor(u)) row.delegation = before.delegation; // só o gestor muda a delegação de um funcionário
        await t.run('UPDATE workers SET name=?, phone=?, company=?, profession=?, own_housing=?, language=?, delegation=? WHERE id=?', [row.name, row.phone, row.company, row.profession, row.own_housing, row.language ?? '', row.delegation, before.id]);
        await audit(t, u, { entity: 'worker', id: before.id, delegation: row.delegation, action: 'update', summary: `Funcionário «${row.name}» alterado`, before, after: row });
        return { id: before.id };
      }
      const id = (await t.run('INSERT INTO workers(name,phone,company,profession,own_housing,language,delegation) VALUES(?,?,?,?,?,?,?)', [row.name, row.phone, row.company, row.profession, row.own_housing, row.language ?? '', row.delegation])).lastInsertRowid;
      await audit(t, u, { entity: 'worker', id, delegation: row.delegation, action: 'create', summary: `Funcionário «${row.name}» criado`, after: row });
      return { id };
    });
  }
  async function deleteWorker(u, id) {
    return db.tx(async (t) => {
      const w = await workerInScope(t, u, id);
      if (!isGestor(u) && w.delegation !== u.delegation) throw new HttpError(403, 'Só o gestor pode apagar funcionários de outra delegação.');
      const n = (await t.get('SELECT COUNT(*) n FROM stays WHERE worker_id=?', [w.id])).n;
      if (n) throw new HttpError(409, `«${w.name}» tem ${n} registo${n === 1 ? '' : 's'} de alojamento e não pode ser apagado (o histórico dos alojamentos ficaria incompleto).`, { hasHistory: true });
      await t.run('DELETE FROM workers WHERE id=?', [w.id]);
      await audit(t, u, { entity: 'worker', id: w.id, delegation: w.delegation, action: 'delete', summary: `Funcionário «${w.name}» apagado (sem histórico)`, before: w });
    });
  }

  // ---------- entradas, saídas e transferências ----------
  async function enter(u, body) {
    const date = String(body.date ?? ''), reason = String(body.reason ?? '').trim();
    if (!isDate(date)) throw new HttpError(422, 'Data de entrada inválida.');
    if (!reason) throw new HttpError(422, 'Motivo da entrada: obrigatório.');
    if (reason.length > 120) throw new HttpError(422, 'Motivo: máximo 120 caracteres.');
    return db.tx(async (t) => {
      const h = await houseInScope(t, u, body.house_id);
      let w;
      // só funcionários que já existem: para criar alguém usa-se «Novo funcionário» (evita repetidos)
      if (!body.worker_id) throw new HttpError(422, 'Escolha um funcionário da lista. Se ainda não existir, crie-o primeiro em «Funcionários → Novo funcionário».');
      w = await workerInScope(t, u, body.worker_id);
      await assertNoOverlap(t, w.id, date, null);
      if (w.delegation == null) await t.run('UPDATE workers SET delegation=? WHERE id=?', [h.delegation, w.id]); // deixa de estar pendente
      if (w.own_housing) await t.run('UPDATE workers SET own_housing=0 WHERE id=?', [w.id]); // passa a ter alojamento da empresa
      const room = body.room_id ? await t.get('SELECT * FROM rooms WHERE id=? AND house_id=?', [Number(body.room_id), h.id]) : null;
      if (body.room_id && !room) throw new HttpError(422, 'Esse quarto não é deste alojamento.');
      const id = (await t.run('INSERT INTO stays(house_id,worker_id,start_date,entry_reason,room_id) VALUES(?,?,?,?,?)', [h.id, w.id, date, reason, room?.id ?? null])).lastInsertRowid;
      await audit(t, u, { entity: 'stay', id, house_id: h.id, delegation: h.delegation, action: 'create', summary: `Entrada de «${w.name}» em «${h.name}» a ${date} — ${reason}${w.delegation == null ? ` (deixa de estar pendente: passa para ${delLabel(h.delegation)})` : ''}`, after: { worker: w.name, start_date: date, entry_reason: reason } });
      return { id, worker_id: w.id };
    });
  }
  /** Saída (com motivo) na data indicada — nesse dia já não conta. Com `to_house_id`: transferência — sai e entra no alojamento novo no mesmo dia. */
  /** Quem sai de um alojamento deixa de ser o seu responsável. */
  const dropResponsible = (t, houseId, workerId) => t.run('UPDATE houses SET responsible_id=NULL WHERE id=? AND responsible_id=?', [houseId, workerId]);
  async function leave(u, body) {
    const date = String(body.date ?? ''), reason = String(body.reason ?? '').trim();
    if (!isDate(date)) throw new HttpError(422, 'Data inválida.');
    if (!reason) throw new HttpError(422, 'Motivo: obrigatório.');
    if (reason.length > 120) throw new HttpError(422, 'Motivo: máximo 120 caracteres.');
    return db.tx(async (t) => {
      const s = await t.get('SELECT * FROM stays WHERE id=?', [Number(body.stay_id)]);
      if (!s) throw new HttpError(404, 'Registo inexistente.');
      const h = await houseInScope(t, u, s.house_id);
      const w = await t.get('SELECT * FROM workers WHERE id=?', [s.worker_id]);
      if (s.end_date) throw new HttpError(422, 'Este funcionário já tem saída registada neste alojamento.');
      if (body.to_house_id) {
        const to = await houseInScope(t, u, body.to_house_id);
        if (to.id === h.id) throw new HttpError(422, 'Escolha um alojamento diferente.');
        if (!to.active) throw new HttpError(422, `«${to.name}» está inativo: não pode receber pessoas.`);
        const end = date; // sai de um e entra no outro no mesmo dia
        if (date <= s.start_date) throw new HttpError(422, 'A transferência tem de ser depois do dia de entrada. Para corrigir o alojamento, edite o registo.');
        // lotação à data da transferência: acima da lotação é permitido, mas só com confirmação explícita
        const usedAt = (await t.get('SELECT COUNT(*) n FROM stays WHERE house_id=? AND start_date<=? AND (end_date IS NULL OR end_date>?)', [to.id, date, date])).n;
        const overNote = to.capacity != null && usedAt + 1 > to.capacity ? ` (acima da lotação: ${usedAt + 1} pessoas para ${to.capacity} camas, confirmado)` : '';
        if (overNote && body.confirm_over !== true) {
          throw new HttpError(409, `«${to.name}» ficará com ${usedAt + 1} pessoas para ${to.capacity} camas a ${date.split('-').reverse().join('/')}. Confirme a transferência acima da lotação.`, { needConfirm: true, used: usedAt, cap: to.capacity });
        }
        await t.run('UPDATE stays SET end_date=?, exit_reason=? WHERE id=?', [end, reason, s.id]);
        await dropResponsible(t, h.id, s.worker_id);
        await assertNoOverlap(t, s.worker_id, date, null);
        const id = (await t.run('INSERT INTO stays(house_id,worker_id,start_date,entry_reason) VALUES(?,?,?,?)', [to.id, s.worker_id, date, reason])).lastInsertRowid;
        await audit(t, u, { entity: 'stay', id: s.id, house_id: h.id, delegation: h.delegation, action: 'update', summary: `Transferência de «${w.name}»: «${h.name}» → «${to.name}» a ${date} — ${reason}${overNote}`, before: { end_date: null }, after: { end_date: end, exit_reason: reason } });
        await audit(t, u, { entity: 'stay', id, house_id: to.id, delegation: to.delegation, action: 'create', summary: `Entrada de «${w.name}» em «${to.name}» (vindo de «${h.name}») a ${date} — ${reason}`, after: { worker: w.name, start_date: date, entry_reason: reason } });
        return { transferred: true, id };
      }
      if (date < s.start_date) throw new HttpError(422, 'Saída: não pode ser antes da entrada.');
      await t.run('UPDATE stays SET end_date=?, exit_reason=? WHERE id=?', [date, reason, s.id]);
      await dropResponsible(t, h.id, s.worker_id);
      await audit(t, u, { entity: 'stay', id: s.id, house_id: h.id, delegation: h.delegation, action: 'update', summary: `Saída de «${w.name}» de «${h.name}» a ${date} — ${reason}`, before: { end_date: null }, after: { end_date: date, exit_reason: reason } });
      return { transferred: false };
    });
  }
  /** Correção de um registo de estadia (datas, motivos, funcionário). */
  async function saveStay(u, body) {
    const row = check('stays', body);
    const s0 = await db.get('SELECT house_id FROM stays WHERE id=?', [Number(body.id)]);
    if (!s0) throw new HttpError(404, 'Registo inexistente.');
    await houseInScope(db, u, s0.house_id);
    const authNote = await requireAuthCode(u, body, 'Corrigir um registo de entrada/saída');
    return db.tx(async (t) => {
      const before = await t.get('SELECT * FROM stays WHERE id=?', [Number(body.id)]);
      if (!before) throw new HttpError(404, 'Registo inexistente.');
      await houseInScope(t, u, before.house_id);
      const h = await houseInScope(t, u, row.house_id);
      const w = await workerInScope(t, u, row.worker_id);
      await assertNoOverlap(t, w.id, row.start_date, row.end_date, before.id);
      await t.run('UPDATE stays SET house_id=?, worker_id=?, start_date=?, entry_reason=?, end_date=?, exit_reason=? WHERE id=?',
        [h.id, w.id, row.start_date, row.entry_reason, row.end_date, row.exit_reason, before.id]);
      await audit(t, u, { entity: 'stay', id: before.id, house_id: h.id, delegation: h.delegation, action: 'update', summary: `Registo de «${w.name}» em «${h.name}» corrigido${authNote}`, before, after: { ...row } });
      return { id: before.id };
    });
  }
  async function deleteStay(u, id, body = {}) {
    const s0 = await db.get('SELECT house_id FROM stays WHERE id=?', [Number(id)]);
    if (!s0) throw new HttpError(404, 'Registo inexistente.');
    await houseInScope(db, u, s0.house_id);
    const authNote = await requireAuthCode(u, body, 'Apagar um registo de entrada/saída');
    return db.tx(async (t) => {
      const s = await t.get('SELECT * FROM stays WHERE id=?', [Number(id)]);
      if (!s) throw new HttpError(404, 'Registo inexistente.');
      const h = await houseInScope(t, u, s.house_id);
      const w = await t.get('SELECT name FROM workers WHERE id=?', [s.worker_id]);
      await t.run('DELETE FROM stays WHERE id=?', [s.id]);
      await audit(t, u, { entity: 'stay', id: s.id, house_id: h.id, delegation: h.delegation, action: 'delete', summary: `Registo de «${w?.name}» em «${h.name}» apagado${authNote}`, before: s });
    });
  }

  // ---------- utilizadores (só o gestor) ----------
  const userAudit = (t, u, id, action, summary, before = null, after = null) => audit(t, u, { entity: 'user', id, action, summary, before, after });
  const describe = (x) => `${ROLE_LABEL[x.role]}${x.role === 'gestor' ? '' : x.delegation ? ` · ${delLabel(x.delegation)}` : ' · todas as delegações'}`;
  /** Cria um utilizador com palavra-passe temporária (mostrada uma única vez ao gestor; obrigatório mudar no 1.º login). */
  async function createUser(u, body) {
    let v; try { v = checkUser(body); } catch (e) { throw new HttpError(422, e.message); }
    const temp = tempPassword();
    return db.tx(async (t) => {
      if (await t.get('SELECT 1 FROM users WHERE email=?', [v.email])) throw new HttpError(422, `Já existe um utilizador com o email ${v.email}.`);
      const id = (await t.run('INSERT INTO users(email,name,pass_hash,role,delegation,created_at,must_change) VALUES(?,?,?,?,?,?,1)',
        [v.email, v.name, hashPassword(temp), v.role, v.delegation, new Date().toISOString()])).lastInsertRowid;
      await userAudit(t, u, id, 'create', `Utilizador «${v.name}» criado (${describe(v)})`, null, v);
      return { id, tempPassword: temp };
    });
  }
  /** Edita nome, email, perfil, delegação e ativo. Mudanças de acesso terminam as sessões dessa pessoa. */
  async function updateUser(u, id, body) {
    return db.tx(async (t) => {
      const before = await t.get('SELECT id,email,name,role,delegation,active FROM users WHERE id=?', [id]);
      if (!before) throw new HttpError(404, 'Utilizador inexistente.');
      let v; try { v = checkUser({ ...before, ...Object.fromEntries(Object.entries(body ?? {}).filter(([, val]) => val !== undefined)) }); } catch (e) { throw new HttpError(422, e.message); }
      const active = body.active === undefined ? before.active : (body.active ? 1 : 0);
      if (id === u.id && (active !== 1 || v.role !== 'gestor')) throw new HttpError(422, 'Não pode desativar nem tirar o perfil de gestor à sua própria conta.');
      if (before.role === 'gestor' && before.active && (v.role !== 'gestor' || !active)) {
        const others = (await t.get("SELECT COUNT(*) n FROM users WHERE role='gestor' AND active=1 AND id<>?", [id])).n;
        if (!others) throw new HttpError(422, 'Tem de existir pelo menos um gestor ativo.');
      }
      if (v.email !== before.email && await t.get('SELECT 1 FROM users WHERE email=? AND id<>?', [v.email, id])) throw new HttpError(422, `Já existe um utilizador com o email ${v.email}.`);
      await t.run('UPDATE users SET email=?, name=?, role=?, delegation=?, active=? WHERE id=?', [v.email, v.name, v.role, v.delegation, active, id]);
      const after = { ...v, active };
      const accessChanged = before.role !== v.role || (before.delegation ?? null) !== (v.delegation ?? null) || before.active !== active || before.email !== v.email;
      if (accessChanged) await t.run('DELETE FROM sessions WHERE user_id=?', [id]); // as permissões novas valem já
      const what = !active && before.active ? 'desativado' : active && !before.active ? 'reativado' : 'alterado';
      await userAudit(t, u, id, 'update', `Utilizador «${v.name}» ${what}${accessChanged && active ? ` (${describe(v)})` : ''}`, before, after);
      return { ok: true };
    });
  }
  /** Repor a palavra-passe de outro utilizador (gestor): nova temporária, mostrada uma vez; a pessoa escolhe a sua no próximo login. */
  async function resetPassword(u, id) {
    if (id === u.id) throw new HttpError(422, 'Para a sua própria conta use «Mudar palavra-passe» no menu.');
    const temp = tempPassword();
    return db.tx(async (t) => {
      const x = await t.get('SELECT id, name, email, active FROM users WHERE id=?', [id]);
      if (!x) throw new HttpError(404, 'Utilizador inexistente.');
      await t.run('UPDATE users SET pass_hash=?, must_change=1 WHERE id=?', [hashPassword(temp), id]); // não reativa: isso faz-se em «Ativo»
      await t.run('DELETE FROM sessions WHERE user_id=?', [id]); // quem estava com sessão aberta tem de entrar de novo
      await t.run('DELETE FROM login_attempts WHERE key=?', [`u:${String(x.email).toLowerCase()}`]); // desbloqueia as tentativas falhadas desta pessoa
      await userAudit(t, u, id, 'update', `Palavra-passe de «${x.name}» reposta (temporária)`);
      return { tempPassword: temp, inactive: !x.active };
    });
  }
  /** Mudar a própria palavra-passe (obrigatório depois de uma temporária). Termina as outras sessões. */
  async function changePassword(u, body) {
    const current = String(body?.current ?? ''), pw = String(body?.password ?? '');
    if (!(await attemptAllowed(db, `pw:${u.id}`, 8, 15 * 60 * 1000))) throw new HttpError(429, 'Demasiadas tentativas. Aguarde 15 minutos.');
    const row = await db.get('SELECT pass_hash FROM users WHERE id=?', [u.id]);
    if (!verifyPassword(current, row.pass_hash)) throw new HttpError(403, 'A palavra-passe atual está errada.');
    if (pw.length < MIN_PASSWORD) throw new HttpError(422, `A nova palavra-passe tem de ter pelo menos ${MIN_PASSWORD} caracteres.`);
    if (pw === current) throw new HttpError(422, 'A nova palavra-passe tem de ser diferente da atual.');
    await db.tx(async (t) => {
      await t.run('UPDATE users SET pass_hash=?, must_change=0 WHERE id=?', [hashPassword(pw), u.id]);
      await t.run('DELETE FROM sessions WHERE user_id=? AND id<>?', [u.id, u.sid]);
      await userAudit(t, u, u.id, 'update', `«${u.name}» mudou a sua palavra-passe`);
    });
    await db.run('DELETE FROM login_attempts WHERE key=?', [`pw:${u.id}`]);
    return { ok: true };
  }

  // ---------- Excel ----------
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  function sendFile(res, buf, name) {
    res.writeHead(200, { 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...SEC_HEADERS });
    res.end(buf);
  }
  /** Lê o Excel enviado (base64, máx. ~3,5 MB) e calcula o plano, sem gravar. */
  /** Delegação do Excel: obrigatória; o utilizador tem de a poder ver (exportar) ou alterar (importar). */
  function excelDelegation(u, del, write) {
    if (!DELEGATIONS.some(([k]) => k === del)) throw new HttpError(422, 'Escolha a delegação (o Excel é sempre de uma delegação).');
    if (!(write ? canDel(u, del) : seesAll(u) || u.delegation === del)) throw new HttpError(403, 'Só pode usar o Excel da sua delegação.');
    return del;
  }
  async function excelPlan(u, body) {
    const del = excelDelegation(u, body?.delegation, true);
    const b64 = String(body?.file ?? '');
    if (!b64) throw new HttpError(422, 'Escolha um ficheiro Excel (.xlsx).');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 3.5 * 1024 * 1024) throw new HttpError(413, 'Ficheiro demasiado grande (máx. 3,5 MB).');
    const wb = await readWorkbook(buf);
    const g = isGestor(u);
    const allHouses = await db.all('SELECT * FROM houses');
    const allWorkers = await db.all('SELECT * FROM workers');
    const mine = g ? null : new Set((await db.all('SELECT DISTINCT s.worker_id FROM stays s JOIN houses h ON h.id=s.house_id WHERE h.delegation=?', [u.delegation])).map((r) => r.worker_id));
    const visible = (w) => g || w.delegation === u.delegation || w.delegation == null || mine.has(w.id);
    const fatal = [...wb.fatal, ...wb.houses.fatal, ...wb.workers.fatal];
    const houses = fatal.length ? [] : planHouses(wb.houses, { user: u, houses: allHouses, delegation: del });
    const workers = fatal.length ? [] : planWorkers(wb.workers, { user: u, workers: allWorkers, visible, delegation: del });
    const count = (l) => Object.fromEntries(['create', 'fill', 'same', 'error', 'doubt'].map((k) => [k, l.filter((r) => r.action === k).length]));
    return {
      delegation: del, fatal, warnings: [...wb.houses.warnings, ...wb.workers.warnings],
      missing: { houses: !!wb.houses.missing, workers: !!wb.workers.missing },
      houses, workers, counts: { houses: count(houses), workers: count(workers) },
      needAuth: !g && houses.some((r) => r.action === 'fill'),
    };
  }
  /** Grava as linhas válidas do plano (recalculado aqui: nunca se confia na pré-visualização). */
  async function excelImport(u, body) {
    const plan = await excelPlan(u, body);
    if (plan.fatal.length) throw new HttpError(422, plan.fatal.join(' '));
    const authNote = plan.needAuth ? await requireAuthCode(u, body, 'Preencher dados de alojamentos que já existem') : '';
    const note = ` (importação Excel${authNote ? ', autorizado com o código do gestor' : ''})`;
    const cols = HOUSE_COLS.map((c) => c.key);
    const done = { houses: { create: 0, fill: 0 }, workers: { create: 0, fill: 0 } };
    await db.tx(async (t) => {
      for (const r of plan.houses) {
        if (r.action === 'create') {
          const row = r.row;
          if (await t.get('SELECT 1 FROM houses WHERE name=?', [row.name])) continue; // criada entretanto
          const link = coordsFromUrl(row.location_url);
          let pin = link ? { ...link, geo_source: 'link' } : null;
          if (!pin && row.building) pin = await t.get('SELECT lat, lng, geo_source FROM houses WHERE building=? COLLATE NOCASE AND delegation=? AND lat IS NOT NULL LIMIT 1', [row.building, row.delegation]);
          const id = (await t.run(`INSERT INTO houses(${cols.join(',')},lat,lng,geo_source) VALUES(${cols.map(() => '?').join(',')},?,?,?)`,
            [...cols.map((c) => row[c] ?? (c === 'active' ? 1 : c === 'deposit_available' ? 0 : ['region', 'address', 'location_url', 'owner_name', 'notes', 'code', 'building'].includes(c) ? '' : null)), pin?.lat ?? null, pin?.lng ?? null, pin?.geo_source ?? null])).lastInsertRowid;
          await audit(t, u, { entity: 'house', id, house_id: id, delegation: row.delegation, action: 'create', summary: `Alojamento «${row.name}» criado (${delLabel(row.delegation)})${note}`, after: row });
          done.houses.create++;
        } else if (r.action === 'fill') {
          const before = await t.get('SELECT * FROM houses WHERE id=?', [r.id]);
          const fills = Object.fromEntries(Object.entries(r.fills).filter(([k]) => before[k] == null || before[k] === '')); // só o que continua vazio
          if (!Object.keys(fills).length) continue;
          const set = Object.keys(fills);
          let pinSql = '', pinArgs = [];
          const link = fills.location_url && coordsFromUrl(fills.location_url);
          if (link && before.geo_source !== 'manual') { pinSql = ", lat=?, lng=?, geo_source='link'"; pinArgs = [link.lat, link.lng]; }
          await t.run(`UPDATE houses SET ${set.map((k) => `${k}=?`).join(',')}${pinSql} WHERE id=?`, [...set.map((k) => fills[k]), ...pinArgs, r.id]);
          await audit(t, u, { entity: 'house', id: r.id, house_id: r.id, delegation: before.delegation, action: 'update', summary: `Alojamento «${before.name}»: campos vazios preenchidos${note}`, before, after: { ...before, ...fills } });
          done.houses.fill++;
        }
      }
      for (const r of plan.workers) {
        if (r.action === 'create') {
          const w = r.row;
          const id = (await t.run('INSERT INTO workers(name,phone,company,profession,own_housing,delegation) VALUES(?,?,?,?,?,?)', [w.name, w.phone ?? '', w.company ?? '', w.profession ?? '', w.own_housing ?? 0, w.delegation])).lastInsertRowid;
          await audit(t, u, { entity: 'worker', id, delegation: w.delegation, action: 'create', summary: `Funcionário «${w.name}» criado${w.delegation ? '' : ' como pendente'}${note}`, after: w });
          done.workers.create++;
        } else if (r.action === 'fill') {
          const before = await t.get('SELECT * FROM workers WHERE id=?', [r.id]);
          const fills = Object.fromEntries(Object.entries(r.fills).filter(([k]) => before[k] == null || before[k] === '' || (k === 'own_housing' && !before[k])));
          if (!Object.keys(fills).length) continue;
          await t.run(`UPDATE workers SET ${Object.keys(fills).map((k) => `${k}=?`).join(',')} WHERE id=?`, [...Object.values(fills), r.id]);
          await audit(t, u, { entity: 'worker', id: r.id, delegation: fills.delegation ?? before.delegation, action: 'update', summary: `Funcionário «${before.name}»: campos vazios preenchidos${note}`, before, after: { ...before, ...fills } });
          done.workers.fill++;
        }
      }
    });
    return { done, skipped: { houses: plan.counts.houses.error, workers: plan.counts.workers.error + plan.counts.workers.doubt } };
  }

  async function auditList(u, q) {
    const where = [], args = [];
    if (!isGestor(u)) { where.push('delegation=?'); args.push(u.delegation); }
    if (q.get('house')) { where.push('house_id=?'); args.push(Number(q.get('house'))); }
    if (q.get('delegation') && isGestor(u)) { where.push('delegation=?'); args.push(q.get('delegation')); }
    return db.all(`SELECT id,at,user_name,entity,action,summary,changes,house_id,delegation FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 300`, args);
  }

  async function api(req, res, u0) {
    const p = u0.pathname; const m = req.method;
    if (m === 'POST' && p === '/api/auth/login') {
      const origin = req.headers.origin; if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origem inválida.');
      const r = await login(db, await readJson(req), clientIp(req));
      if (r.error) throw new HttpError(r.status, r.error);
      return send(res, 200, { csrf: r.csrf }, { 'Set-Cookie': `asid=${r.sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=36000${secureCookies ? '; Secure' : ''}` });
    }
    if (m === 'GET' && p === '/api/auth/me') {
      const s = await sessionFrom(db, req);
      return send(res, 200, s ? { user: { name: s.name, email: s.email, role: s.role, delegation: s.delegation, mustChange: !!s.must_change }, csrf: s.csrf } : { user: null });
    }
    // lista semanal: página pública do responsável (link com código único; sem sessão)
    const pub = /^\/api\/lista\/([A-Za-z0-9_-]{20,64})$/.exec(p);
    if (pub) {
      if (!rateLimit(`lista:${clientIp(req)}`, 60, 15 * 60_000)) throw new HttpError(429, 'Demasiados pedidos. Tente mais tarde.');
      if (m === 'GET') {
        const { c, h, r, occupants } = await publicCheckin(pub[1]);
        return send(res, 200, { house: h.name, responsible: r ? r.name.split(' ')[0] : '', language: r?.language === 'pt' ? 'pt' : 'es', occupants, expires_at: c.expires_at, answered_at: c.answered_at, answer: c.answer ? JSON.parse(c.answer) : null });
      }
      if (m === 'POST') {
        const origin = req.headers.origin; if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origem inválida.');
        return send(res, 200, await answerCheckin(pub[1], await readJson(req)));
      }
    }
    const u = await requireUser(req);
    // palavra-passe temporária: até a mudar, só pode mudar a palavra-passe ou sair
    if (u.must_change && !['/api/auth/logout', '/api/auth/password'].includes(p)) throw new HttpError(403, 'Tem de escolher uma palavra-passe nova antes de continuar.', { mustChange: true });
    // administrativo: só leitura (também no servidor) — pode exportar Excel (GET) e mudar a sua palavra-passe; não vê o histórico de edições
    if (readOnly(u)) {
      if (m !== 'GET' && !['/api/auth/logout', '/api/auth/password'].includes(p)) throw new HttpError(403, 'O seu perfil (administrativo) só permite visualizar.');
      if (p === '/api/audit') throw new HttpError(403, 'O seu perfil (administrativo) não tem acesso ao histórico de edições.');
    }
    if (m === 'POST' && p === '/api/auth/password') return send(res, 200, await changePassword(u, await readJson(req)));
    if (p === '/api/users' || p.startsWith('/api/users/')) {
      if (!isGestor(u)) throw new HttpError(403, 'Só o gestor gere os utilizadores.');
      if (m === 'GET' && p === '/api/users') return send(res, 200, await db.all('SELECT id,email,name,role,delegation,active,must_change,created_at FROM users ORDER BY active DESC, name'));
      if (m === 'POST' && p === '/api/users') return send(res, 200, await createUser(u, await readJson(req)));
      const um = /^\/api\/users\/(\d+)$/.exec(p);
      if (m === 'PUT' && um) return send(res, 200, await updateUser(u, Number(um[1]), await readJson(req)));
      const ur = /^\/api\/users\/(\d+)\/reset$/.exec(p);
      if (m === 'POST' && ur) { await readJson(req); return send(res, 200, await resetPassword(u, Number(ur[1]))); }
      throw new HttpError(404, 'Rota inexistente.');
    }
    if (m === 'POST' && p === '/api/auth/logout') {
      await db.run('DELETE FROM sessions WHERE id=?', [u.sid]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'asid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (m === 'GET' && p === '/api/data') return send(res, 200, await data(u));
    if (m === 'GET' && p === '/api/audit') return send(res, 200, await auditList(u, u0.searchParams));
    if (m === 'GET' && (p === '/api/excel/modelo' || p === '/api/excel/exportar')) {
      const day = new Date().toISOString().slice(0, 10);
      if (p.endsWith('modelo')) return sendFile(res, await buildWorkbook(), 'fonsat-alojamentos-modelo.xlsx');
      // exporta só a delegação pedida: os seus alojamentos e os funcionários dessa delegação
      const del = excelDelegation(u, u0.searchParams.get('delegacao'), false);
      const d = await data(u);
      return sendFile(res, await buildWorkbook({ houses: d.houses.filter((x) => x.delegation === del), workers: d.workers.filter((w) => w.delegation === del) }), `fonsat-alojamentos-${del}-${day}.xlsx`);
    }
    if (m === 'POST' && p === '/api/excel/previsualizar') return send(res, 200, await excelPlan(u, await readJson(req)));
    if (m === 'POST' && p === '/api/excel/importar') return send(res, 200, await excelImport(u, await readJson(req)));
    if (m === 'PUT' && p === '/api/houses') return send(res, 200, await saveHouse(u, await readJson(req)));
    if (m === 'POST' && /^\/api\/houses\/\d+\/delete$/.test(p)) { await deleteHouse(u, p.split('/')[3], await readJson(req)); return send(res, 200, { ok: true }); }
    if (m === 'PUT' && p === '/api/settings/auth-code') {
      if (!isGestor(u)) throw new HttpError(403, 'Só o gestor pode mudar o código de autorização.');
      try { await setAuthCode(db, (await readJson(req)).code); } catch (e) { throw new HttpError(422, e.message); }
      await audit(db, u, { entity: 'settings', id: null, action: 'update', summary: 'Código de autorização do gestor alterado' });
      return send(res, 200, { ok: true });
    }
    const rp = /^\/api\/houses\/(\d+)\/(responsible|checkin)$/.exec(p);
    if (rp && m === 'PUT' && rp[2] === 'responsible') return send(res, 200, await setResponsible(u, rp[1], await readJson(req)));
    if (rp && m === 'POST' && rp[2] === 'checkin') { await readJson(req); return send(res, 200, await createCheckin(u, rp[1], `${(TRUST_PROXY && req.headers['x-forwarded-proto']) || (secureCookies ? 'https' : 'http')}://${req.headers.host}`)); }
    if (m === 'POST' && p === '/api/checkins/bulk') return send(res, 200, await createCheckins(u, await readJson(req), `${(TRUST_PROXY && req.headers['x-forwarded-proto']) || (secureCookies ? 'https' : 'http')}://${req.headers.host}`));
    const ck = /^\/api\/checkins\/(\d+)\/(sent|apply)$/.exec(p);
    if (ck && m === 'POST' && ck[2] === 'sent') { await readJson(req); return send(res, 200, await markSent(u, ck[1])); }
    if (ck && m === 'POST' && ck[2] === 'apply') return send(res, 200, await applyCheckin(u, ck[1], await readJson(req)));
    if (m === 'PUT' && p === '/api/rooms') return send(res, 200, await saveRoom(u, await readJson(req)));
    if (m === 'POST' && p === '/api/rooms/bulk') return send(res, 200, await saveRoomsBulk(u, await readJson(req)));
    if (m === 'POST' && /^\/api\/rooms\/\d+\/delete$/.test(p)) { await deleteRoom(u, p.split('/')[3], await readJson(req)); return send(res, 200, { ok: true }); }
    if (m === 'POST' && /^\/api\/stays\/\d+\/room$/.test(p)) return send(res, 200, await moveRoom(u, p.split('/')[3], await readJson(req)));
    if (m === 'PUT' && p === '/api/adjustments') return send(res, 200, await saveAdjustment(u, await readJson(req)));
    if (m === 'PUT' && p === '/api/workers') return send(res, 200, await saveWorker(u, await readJson(req)));
    if (m === 'PUT' && p === '/api/stays') return send(res, 200, await saveStay(u, await readJson(req)));
    if (m === 'POST' && /^\/api\/stays\/\d+\/delete$/.test(p)) { await deleteStay(u, p.split('/')[3], await readJson(req)); return send(res, 200, { ok: true }); }
    if (m === 'POST' && p === '/api/stays/enter') return send(res, 200, await enter(u, await readJson(req)));
    if (m === 'POST' && p === '/api/stays/leave') return send(res, 200, await leave(u, await readJson(req)));
    const ce = /^\/api\/houses\/(\d+)\/confirm-empty$/.exec(p);
    if (ce && m === 'POST') return send(res, 200, await confirmEmpty(u, ce[1]));
    const geo = /^\/api\/houses\/(\d+)\/(geocode|position)$/.exec(p);
    if (geo && m === 'POST' && geo[2] === 'geocode') return send(res, 200, await geocodeHouse(u, geo[1], u0.searchParams.get('preview') === '1'));
    if (geo && m === 'PUT' && geo[2] === 'position') return send(res, 200, await setPosition(u, geo[1], await readJson(req)));
    const del = /^\/api\/(houses|adjustments|workers|stays)\/(\d+)$/.exec(p);
    if (m === 'DELETE' && del) {
      await ({ houses: (uu, id) => deleteHouse(uu, id, {}), adjustments: deleteAdjustment, workers: deleteWorker, stays: deleteStay })[del[1]](u, del[2]);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Rota inexistente.');
  }

  function serveStatic(req, res, u0) {
    let rel = decodeURIComponent(u0.pathname);
    if (/^\/lista\/[A-Za-z0-9_-]{20,64}$/.test(rel)) rel = '/lista.html'; // página do responsável (lista semanal)
    if (rel === '/') rel = '/index.html';
    const base = path.join(ROOT, 'public');
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep)) return send(res, 404, 'Não encontrado');
    let f = file;
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { if (path.extname(rel) === '') f = path.join(base, 'index.html'); else return send(res, 404, 'Não encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC_HEADERS });
    fs.createReadStream(f).pipe(res);
  }

  return async function handler(req, res) {
    const u0 = new URL(req.url, 'http://x');
    try {
      if (!rateLimit(`g:${clientIp(req)}`, 600, 60_000)) throw new HttpError(429, 'Demasiados pedidos.');
      if (u0.pathname.startsWith('/api/')) return await api(req, res, u0);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
      return serveStatic(req, res, u0);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra ?? {}) });
      if (/UNIQUE/.test(e.message)) return send(res, 422, { error: 'Registo repetido.' });
      log('error', 'unhandled', { route: u0.pathname, err: e.message });
      return send(res, 500, { error: 'Erro interno.' });
    }
  };
}
