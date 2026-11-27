// Fonsat · Alojamentos — painel por delegação, casas (cards/lista), mapa, ocupantes (entradas/saídas com motivo), custos e histórico.
import { transferOptions } from './transfer.js';
import { h, eur, num, pct, monthLabel, dateLabel, alert, field, table, td, api, session } from '/ui.js';

let D = null;          // dados do servidor (/api/data), já limitados à delegação do utilizador
let user = null;       // utilizador com sessão
let flash = null;
let mounts = [];       // funções a correr depois de desenhar (mapas precisam do elemento já na página)
let maps = [];         // mapas Leaflet abertos (removidos a cada desenho)
const geoFailed = new Map(); // casas cuja morada não foi encontrada nesta sessão (não insistir)

const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const thisMonth = () => today().slice(0, 7);
const addMonths = (m, k) => { const [y, x] = m.split('-').map(Number); const d = new Date(y, x - 1 + k, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const daysUntil = (d) => Math.round((new Date(`${d}T00:00:00`) - new Date(`${today()}T00:00:00`)) / 86400000);
const CONTRACT_WARN_DAYS = 60;
const DEL_CENTER = { asturias: [43.36, -5.85], catalunha: [41.39, 2.17], porto: [41.15, -8.61] };
const DEL_SHORT = { asturias: 'AST', catalunha: 'CAT', porto: 'POR' };

// preferências (filtros, vista cards/lista, separador), lembradas no navegador
const MEM = 'aloj.prefs';
const mem = (() => { try { return JSON.parse(localStorage.getItem(MEM) || '{}'); } catch { return {}; } })();
const remember = () => { try { localStorage.setItem(MEM, JSON.stringify(mem)); } catch { /* sem armazenamento */ } };
mem.view ??= 'cards'; mem.filter ??= 'ativas'; mem.region ??= ''; mem.q ??= ''; mem.tab ??= 'ocupantes'; mem.wfree ??= false;
// os filtros do mapa não se guardam entre visitas: ao abrir a aplicação o mapa mostra sempre todas as alojamentos ativos
Object.assign(mem, { mapDel: '', mapRegion: '', mapState: 'ativas', mapOcc: '' });

const ENTRY_REASONS = ['Início de obra', 'Novo colaborador', 'Transferência', 'Reforço de equipa', 'Regresso de férias', 'Regresso de baixa'];
const EXIT_REASONS = ['Fim de obra', 'Transferência', 'Fim de contrato', 'Férias', 'Baixa médica', 'Despedimento', 'Saída voluntária'];

// ---------- ícones (SVG simples) ----------
const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  building: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
  auto: 'M3 4h18v12H3zM8 20h8M12 16v4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  pin: 'M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
  bed: 'M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8M2 16h20M6 10V7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  euro: 'M18 7a7 7 0 1 0 0 10M4 10h10M4 14h10',
  plus: 'M12 5v14M5 12h14',
  ext: 'M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  back: 'M19 12H5M12 19l-7-7 7-7',
  x: 'M18 6 6 18M6 6l12 12',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  enter: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
};
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', ICONS[name]); s.append(p);
  return s;
}

// ---------- dados derivados ----------
const isGestor = () => user?.role === 'gestor';
/** Administrativo: só leitura (o servidor também bloqueia). */
const RO = () => user?.role === 'administrativo';
/** Vê todas as delegações: gestor, ou administrativo sem delegação. */
const seesAll = () => isGestor() || (RO() && !user.delegation);
/** Controlo de alteração: escondido no perfil só de leitura. */
const W = (node) => (RO() ? null : node);
const ROLE_LABEL = { gestor: 'Gestor', coordenador: 'Coordenador', administrativo: 'Administrativo' };
const roleText = (u) => `${ROLE_LABEL[u.role] ?? u.role}${u.role === 'gestor' ? '' : u.delegation ? ` · ${delLabel(u.delegation)}` : ' · todas as delegações'}`;
const house = (id) => D.houses.find((x) => x.id === id);
const worker = (id) => D.workers.find((x) => x.id === id);
const workerName = (id) => worker(id)?.name ?? '—';
const delLabel = (k) => (k == null ? 'Pendente' : D.delegations.find(([v]) => v === k)?.[1] ?? k);
const telLink = (p) => (p ? h('a', { href: `tel:${p.replace(/[^\d+]/g, '')}`, onclick: (e) => e.stopPropagation() }, p) : null);
const hasHistory = (id) => D.stays.some((s) => s.house_id === id) || D.adjustments.some((a) => a.house_id === id);
/** Alojado no dia d: já entrou e ainda não saiu (no dia da saída já não conta — como o check-out). */
const isCurrent = (s, d = today()) => s.start_date <= d && (!s.end_date || s.end_date > d);
/** Quartos de um alojamento (ordem definida). */
const roomsOf = (houseId) => (D.rooms ?? []).filter((r) => r.house_id === houseId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'pt', { numeric: true }));
const roomName = (id) => (D.rooms ?? []).find((r) => r.id === id)?.name ?? null;
const roomUsed = (roomId) => D.stays.filter((s) => s.room_id === roomId && isCurrent(s)).length;
const occupantsNow = (houseId) => D.stays.filter((s) => s.house_id === houseId && isCurrent(s));
/** Situação de alojamento: alojado (com estadia hoje) · próprio · pendente de rever (sem delegação nem alojamento) · sem alojamento. */
const housingOf = (w) => (currentStay(w.id) ? 'alojado' : w.own_housing ? 'proprio' : w.delegation == null ? 'rever' : 'sem');
const toReview = () => D.workers.filter((w) => housingOf(w) === 'rever');
function reviewAlert() {
  const n = toReview().length;
  return n ? h('div', { class: 'alert warn' }, `${n} funcionário${n === 1 ? '' : 's'} por rever: sem delegação e sem alojamento (nem próprio). `,
    h('a', { class: 'btn sm', href: '#/funcionarios', onclick: () => { mem.wfree = 'rever'; mem.wdel = ''; mem.wprof = ''; remember(); } }, 'Rever')) : null;
}
const currentStay = (workerId) => D.stays.find((s) => s.worker_id === workerId && isCurrent(s));
const mapUrl = (x) => x.location_url || (x.lat != null ? `https://www.google.com/maps/search/?api=1&query=${x.lat},${x.lng}` : x.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(x.address)}` : null);
const initials = (n) => String(n ?? '').split(/\s+/).map((p) => p.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';

/** Custo de um mês: aluguer + despesas (o acerto do mês, se existir; senão as despesas fixas). */
function monthCost(x, m) {
  const adj = D.adjustments.find((a) => a.house_id === x.id && a.month === m);
  const exp = adj ? adj.value : x.fixed_expenses;
  if (x.rent == null && exp == null) return null;
  return { rent: x.rent ?? 0, expenses: exp ?? 0, total: (x.rent ?? 0) + (exp ?? 0), adjusted: !!adj, adj };
}
/** Situação de hoje: lotação, ocupação, custo do mês e custo por pessoa (custo ÷ quem lá está hoje). */
/** Ocupação desconhecida: a casa nunca teve registos de ocupantes e ninguém confirmou que está vazia. */
const occUnknown = (x) => !x.occ_checked && !D.stays.some((s) => s.house_id === x.id);
function stats(x) {
  const used = occupantsNow(x.id).length, cap = x.capacity ?? null, cost = monthCost(x, thisMonth());
  const known = cap !== null && !occUnknown(x); // só com lotação E ocupação conhecidas se fala em camas livres
  return { cap, used, known, free: known ? cap - used : null, cost: cost?.total ?? null, perPerson: cost && used ? cost.total / used : null };
}
function totals(list) {
  const st = list.map(stats);
  const sum = (f) => st.reduce((a, s) => a + (f(s) ?? 0), 0);
  const used = sum((s) => s.used), cost = sum((s) => s.cost);
  // a ocupação compara-se só com as casas que têm lotação: quem está em casas sem lotação conta à parte
  const usedKnown = sum((s) => (s.known ? s.used : 0)), usedUnknown = used - usedKnown;
  return { n: list.length, cap: sum((s) => (s.known ? s.cap : 0)), used, usedKnown, usedUnknown, nUnknown: st.filter((s) => !s.known).length,
    free: sum((s) => (s.free === null ? null : Math.max(s.free, 0))), over: sum((s) => (s.free !== null && s.free < 0 ? -s.free : 0)), cost, perPerson: used ? cost / used : null };
}
/** Estado pela ocupação: ok (camas livres) · full (cheia) · over (acima da lotação) · empty (vazia) · off (inativa). */
function statusOf(x) {
  if (!x.active) return 'off';
  const s = stats(x);
  if (!s.known) return 'unknown'; // lotação ou ocupação desconhecida: nem vazia nem com camas livres
  if (!s.used) return 'empty';
  if (s.free > 0) return 'ok';
  return s.free === 0 ? 'full' : 'over';
}
const STATUS = { ok: 'Com camas livres', full: 'Cheio', over: 'Acima da lotação', empty: 'Vazio', unknown: 'Por confirmar', off: 'Inativo' };
function contractInfo(x) {
  if (!x.contract_end) return { text: x.contract_start ? `desde ${dateLabel(x.contract_start)}, sem fim` : '—', level: '' };
  const n = daysUntil(x.contract_end);
  if (n < 0) return { text: `terminou a ${dateLabel(x.contract_end)}`, level: 'bad' };
  return { text: `até ${dateLabel(x.contract_end)} (${n} dias)`, level: n <= CONTRACT_WARN_DAYS ? 'warn' : '' };
}
const depositInfo = (x) => (x.deposit_amount == null ? 'sem caução' : `${eur(x.deposit_amount)} · ${x.deposit_available ? 'disponível' : 'não disponível'}`);
/** Alertas de uma casa ativa. */
function houseAlerts(x) {
  if (!x.active) return [];
  const s = stats(x), c = contractInfo(x), out = [];
  if (s.free !== null && s.free < 0) out.push({ level: 'bad', text: `Acima da lotação: ${s.used} pessoas para ${s.cap} camas` });
  if (c.level === 'bad') out.push({ level: 'bad', text: `Contrato ${c.text}` });
  else if (c.level === 'warn') out.push({ level: 'warn', text: `Contrato ${c.text}` });
  if (statusOf(x) === 'empty') out.push({ level: 'warn', text: 'Alojamento vazio' });
  if (x.capacity == null) out.push({ level: 'warn', text: 'Lotação por preencher' });
  const occ = occupantsNow(x.id);
  if (occ.length) {
    const r = x.responsible_id ? worker(x.responsible_id) : null;
    if (!r) out.push({ level: 'warn', text: 'Sem responsável' });
    else if (!r.phone) out.push({ level: 'warn', text: 'Responsável sem telefone' });
    const noPhone = occ.filter((st) => !worker(st.worker_id)?.phone).length;
    if (noPhone) out.push({ level: 'warn', text: `${noPhone} ocupante${noPhone === 1 ? '' : 's'} sem telefone` });
  }
  const missing = [x.rent == null ? 'renda' : null, !x.address ? 'morada' : null, /FALTA INFORMA/i.test(x.notes ?? '') ? 'ver notas' : null].filter(Boolean);
  if (missing.length) out.push({ level: 'warn', text: `Falta informação: ${missing.join(', ')}` });
  if (occUnknown(x)) out.push({ level: 'warn', text: 'Ocupação por registar (sem registos de ocupantes)' });
  if (x.lat == null) out.push({ level: 'warn', text: 'Sem localização no mapa' });
  else if (x.geo_review) out.push({ level: 'warn', text: 'Localização por confirmar' });
  return out;
}

async function reload() { D = await api('GET', '/api/data'); }

/** Executa uma alteração, recarrega e redesenha. Erro: mostra em `box` (ex.: dentro do diálogo) e devolve false. */
async function act(fn, okText, box = null) {
  try {
    const res = await fn(); await reload();
    const text = typeof okText === 'function' ? okText(res) : okText;
    flash = text ? { kind: 'ok', text, at: Date.now() } : null;
  } catch (e) {
    if (e.status === 401) { user = null; flash = { kind: 'bad', text: e.message, at: Date.now() }; render(); return false; }
    const msg = alert('bad', e.message);
    if (box) box.replaceChildren(msg);
    else { const main = document.getElementById('main'); main.querySelector(':scope > .alert.bad')?.remove(); main.prepend(msg); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    return false;
  }
  render();
  return true;
}

// ---------- componentes ----------
const kpi = (label, value, sub, cls = '', extra = null) => h('div', { class: `kpi ${cls}` }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), extra, sub ? h('div', { class: 's' }, sub) : null);
const houseLink = (x) => h('a', { href: `#/casa/${x.id}` }, x.name);
const datalist = (id, opts) => h('datalist', { id }, opts.map((o) => h('option', { value: o })));
const chip = (cls, ...kids) => h('span', { class: `chip ${cls}` }, ...kids);
const statusChip = (x) => { const st = statusOf(x); return chip(`s-${st}`, h('span', { class: `dot s-${st}` }), STATUS[st]); };
function occBar(used, cap) {
  if (!cap) return h('div', { class: 'bar' });
  return h('div', { class: `bar${used > cap ? ' over' : used === cap ? ' full' : ''}`, role: 'img', 'aria-label': `${used} de ${cap} camas ocupadas` }, h('span', { style: `width:${Math.min(100, (used / cap) * 100)}%` }));
}
function alertChip(list) {
  if (!list.length) return null;
  const bad = list.some((a) => a.level === 'bad');
  return chip(bad ? 'bad' : 'warn', icon('alert'), String(list.length));
}
function seg(options, value, onpick, cls = '') {
  return h('div', { class: `seg ${cls}`, role: 'group' }, options.map(([v, label, ic]) => h('button', { type: 'button', 'aria-pressed': String(v === value), title: label, onclick: () => onpick(v) }, ic ? icon(ic) : null, h('span', { class: 'lbl' }, label))));
}
/** Janela modal; fecha-se com Esc, com o X ou depois de guardar. */
function dialog(title, body) {
  const d = h('dialog', { class: 'dlg' },
    h('div', { class: 'dh' }, h('h2', title), h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Fechar', onclick: () => d.close() }, icon('x'))),
    h('div', { class: 'db' }, body));
  d.addEventListener('close', () => d.remove());
  document.body.append(d); d.showModal();
  return d;
}
const msgBox = () => h('div', { class: 'full', 'aria-live': 'polite' });

// ---------- mapa (OpenStreetMap + Leaflet) ----------
function makeMap(el, center, zoom) {
  const m = L.map(el, { scrollWheelZoom: true }).setView(center, zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
  maps.push(m);
  return m;
}
/** Pino redondo na cor da ocupação, com a sigla da delegação (AS, CT, PT). */
const pinIcon = (x) => L.divIcon({ html: h('div', { class: `pin s-${statusOf(x)}`, title: x.name }, DEL_SHORT[x.delegation] ?? '?'), className: 'pin-wrap', iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16] });
function popupFor(x) {
  const s = stats(x), st = statusOf(x);
  const line = (l, v) => h('div', { class: 'pl' }, h('span', l), h('b', v));
  return h('div', { class: 'pop' }, h('div', { class: 'pt' }, x.name), h('div', { class: 'muted' }, [delLabel(x.delegation), x.region].filter(Boolean).join(' · ')),
    h('div', { class: 'ps' }, h('span', { class: `dot s-${st}` }), STATUS[st]),
    line('Ocupação', `${s.used}${s.cap != null ? ` / ${s.cap}` : ''} camas`), line('Camas livres', s.free ?? '—'),
    line('Custo mensal', eur(s.cost, 0)), line('Custo por pessoa', eur(s.perPerson, 0)),
    h('a', { class: 'btn pri sm', href: `#/casa/${x.id}` }, 'Abrir ficha'));
}
const pinFor = (x) => L.marker([x.lat, x.lng], { icon: pinIcon(x), title: x.name, riseOnHover: true, st: statusOf(x), houseIds: [x.id], dels: [x.delegation] }).bindPopup(popupFor(x));
const bldKey = (x) => `${x.delegation}|${x.building.trim().toUpperCase()}`;
/** Andares do mesmo edifício (mesma delegação) */
const floorsOf = (x) => (x.building ? D.houses.filter((y) => y.building && bldKey(y) === bldKey(x)).sort((a, b) => a.name.localeCompare(b.name, 'pt', { numeric: true })) : [x]);
/** Um pino por edifício: mostra a sigla e quantos andares; o popup lista cada andar. */
function buildingPin(xs) {
  const worst = ST_RANK.find((k) => xs.some((x) => statusOf(x) === k)) ?? 'off';
  const T = totals(xs), x0 = xs[0];
  const ic = L.divIcon({ html: h('div', { class: `pin bld s-${worst}`, title: `${x0.building} · ${xs.length} andares` }, DEL_SHORT[x0.delegation] ?? '?', h('span', { class: 'fl' }, String(xs.length))),
    className: 'pin-wrap', iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -18] });
  const line = (l, v) => h('div', { class: 'pl' }, h('span', l), h('b', v));
  const pop = h('div', { class: 'pop' }, h('div', { class: 'pt' }, icon('building'), ' ', x0.building), h('div', { class: 'muted' }, [delLabel(x0.delegation), x0.region, `${xs.length} andares`].filter(Boolean).join(' · ')),
    line('Ocupação', `${T.used}${T.cap ? ` / ${T.cap}` : ''} camas`), line('Custo mensal', eur(T.cost, 0)), line('Custo por pessoa', eur(T.perPerson, 0)),
    h('ul', { class: 'floors' }, xs.map((x) => { const s = stats(x), st = statusOf(x);
      return h('li', h('span', { class: `dot s-${st}`, title: STATUS[st] }), h('a', { href: `#/casa/${x.id}` }, x.name), h('span', { class: 'muted' }, `${s.used}${s.cap != null ? `/${s.cap}` : ''}`)); })));
  return L.marker([x0.lat, x0.lng], { icon: ic, title: x0.building, riseOnHover: true, st: worst, houseIds: xs.map((x) => x.id), dels: [x0.delegation] }).bindPopup(pop, { maxWidth: 320 });
}
/** Pinos para uma lista de casas com coordenadas: andares do mesmo edifício juntam-se num só. */
function pinsFor(list) {
  const out = [], seen = new Map();
  for (const x of list) {
    if (x.lat == null) continue;
    if (!x.building) { out.push(pinFor(x)); continue; }
    const k = bldKey(x); if (!seen.has(k)) seen.set(k, []); seen.get(k).push(x);
  }
  for (const xs of seen.values()) out.push(xs.length > 1 ? buildingPin(xs) : pinFor(xs[0]));
  return out;
}
const ST_COLOR = { ok: '#1f9d55', full: '#e0a100', over: '#d64545', unknown: '#7c6fd6', empty: '#8a96a3', off: '#8a96a3' };
/** Grupo de pinos: casas próximas juntam-se num círculo com o número; ao aproximar separam-se (as do mesmo prédio abrem em leque). */
const ST_RANK = ['over', 'full', 'ok', 'unknown', 'empty', 'off'];
function pinGroup() {
  if (!L.markerClusterGroup) return L.featureGroup(); // plugin não carregou: pinos soltos
  return L.markerClusterGroup({
    maxClusterRadius: 45, showCoverageOnHover: false, spiderfyOnMaxZoom: true, zoomToBoundsOnClick: true, spiderfyDistanceMultiplier: 1.4,
    iconCreateFunction: (c) => {
      const kids = c.getAllChildMarkers();
      const n = kids.reduce((a, mk) => a + (mk.options.houseIds?.length ?? 1), 0);
      const dels = [...new Set(kids.flatMap((mk) => mk.options.dels ?? []))].map((d) => DEL_SHORT[d] ?? '?').join('·');
      // anel dividido pelas cores das casas do grupo (verde livres, amarelo cheias, vermelho acima, cinzento vazias/inativas)
      let acc = 0;
      const stops = ST_RANK.map((k) => [k, kids.filter((mk) => mk.options.st === k).length]).filter(([, q]) => q)
        .map(([k, q]) => { const a = (acc / n) * 360, b = ((acc += q) / n) * 360; return `${ST_COLOR[k]} ${a}deg ${b}deg`; });
      const worst = ST_RANK.find((k) => kids.some((mk) => mk.options.st === k)) ?? 'off';
      return L.divIcon({ html: h('div', { class: `cluster s-${worst}`, style: `background:conic-gradient(${stops.join(',')})`, title: `${n} alojamentos (${dels}) — clique para ver a lista` },
          h('span', { class: 'cn' }, h('b', String(n)), h('small', { class: dels.includes('·') ? 'mix' : '' }, dels))),
        className: 'pin-wrap', iconSize: [50, 50], iconAnchor: [25, 25] });
    },
  });
}
/** Procura no mapa (pela morada) as casas ainda sem pino, uma de cada vez. */
async function geocodeMissing(list, onFound, onProgress, alive) {
  const todo = list.filter((x) => x.lat == null && x.address && !x.geo_source && !geoFailed.has(x.id));
  let i = 0;
  for (const x of todo) {
    if (!alive()) return;
    onProgress(++i, todo.length);
    try { const g = await api('POST', `/api/houses/${x.id}/geocode`); Object.assign(x, g); onFound(x); }
    catch (e) { geoFailed.set(x.id, e.message); if (e.status === 502) break; }
  }
  if (alive()) onProgress(0, 0);
}

// ---------- formulários ----------
/** Editor de quartos do novo alojamento: cada quarto com as suas camas (uns com mais, outros com menos). */
function roomsEditor(onChange) {
  const list = h('div', { class: 'redit' });
  const total = h('p', { class: 'help' });
  const rows = () => [...list.querySelectorAll('.rrow')].map((r) => ({ name: r.querySelector('[data-k=name]').value.trim(), beds: Number(r.querySelector('[data-k=beds]').value) }));
  const sync = () => {
    const rs = rows().filter((r) => r.name);
    total.textContent = rs.length ? `${rs.length} quarto${rs.length === 1 ? '' : 's'} · ${rs.reduce((a, r) => a + (r.beds || 0), 0)} camas no total (lotação do alojamento)` : 'Sem quartos: escreva a lotação acima, ou acrescente quartos.';
    onChange(rs);
  };
  const add = (name = '', beds = 2) => {
    const row = h('div', { class: 'rrow' },
      h('input', { 'data-k': 'name', value: name, maxlength: 60, placeholder: 'Quarto (ex.: Habitación 1)', 'aria-label': 'Nome do quarto', oninput: sync }),
      h('div', { class: 'stepper' },
        h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': 'Menos uma cama', onclick: () => { const i = row.querySelector('[data-k=beds]'); i.value = Math.max(0, Number(i.value) - 1); sync(); } }, '−'),
        h('input', { 'data-k': 'beds', type: 'number', min: 0, max: 50, value: beds, class: 'num-in', 'aria-label': 'Camas', oninput: sync }),
        h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': 'Mais uma cama', onclick: () => { const i = row.querySelector('[data-k=beds]'); i.value = Math.min(50, Number(i.value) + 1); sync(); } }, '+')),
      h('span', { class: 'muted small' }, 'camas'),
      h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': 'Tirar quarto', title: 'Tirar quarto', onclick: () => { row.remove(); sync(); } }, icon('x')));
    list.append(row); sync();
    if (!name) row.querySelector('[data-k=name]').focus();
  };
  const next = () => `Quarto ${list.querySelectorAll('.rrow').length + 1}`;
  const nMany = h('input', { type: 'number', min: 1, max: 100, value: 4, class: 'num-in', 'aria-label': 'Quantos quartos' });
  const bMany = h('input', { type: 'number', min: 0, max: 50, value: 2, class: 'num-in', 'aria-label': 'Camas por quarto' });
  const el = h('div', { class: 'full rooms-new' },
    h('h3', 'Quartos (opcional)'),
    h('p', { class: 'help' }, 'Acrescente os quartos e as camas de cada um — cada quarto pode ter um número diferente. Depois de criado, os quartos gerem-se no separador «Dados».'),
    list,
    h('div', { class: 'inl wrap' },
      h('button', { type: 'button', class: 'btn sm', onclick: () => add(next(), 2) }, icon('plus'), 'Quarto'),
      h('span', { class: 'muted small' }, 'ou'),
      h('span', { class: 'inl' }, nMany, h('span', { class: 'muted small' }, 'quartos de'), bMany, h('span', { class: 'muted small' }, 'camas'),
        h('button', { type: 'button', class: 'btn sm', onclick: () => { const n = Math.min(100, Number(nMany.value) || 0); for (let i = 0; i < n; i++) add(next(), Number(bMany.value) || 0); } }, 'Acrescentar'))),
    total);
  sync();
  return { el, rows: () => rows().filter((r) => r.name) };
}
function houseForm(x, delegation, d) {
  const v = (k, def = '') => x?.[k] ?? def;
  const box = msgBox();
  const capIn = h('input', { name: 'capacity', inputmode: 'numeric', value: v('capacity'), readonly: !!(x && roomsOf(x.id).length) });
  const roomsIn = h('input', { name: 'rooms', inputmode: 'numeric', value: v('rooms'), readonly: !!(x && roomsOf(x.id).length) });
  // novo alojamento: com quartos, a lotação e o n.º de quartos são calculados
  const editor = x ? null : roomsEditor((rs) => {
    capIn.readOnly = roomsIn.readOnly = rs.length > 0;
    if (rs.length) { capIn.value = rs.reduce((a, r) => a + (r.beds || 0), 0); roomsIn.value = rs.length; }
  });
  const needCode = !!x && !isGestor();
  const f = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(f));
    for (const k of ['deposit_available', 'active']) b[k] = f.querySelector(`[name=${k}]`).checked ? 1 : 0;
    let r;
    try { r = await api('PUT', '/api/houses', { ...(x ? { id: x.id } : {}), ...b, ...(editor ? { room_list: editor.rows() } : {}) }); }
    catch (err) { if (err.status === 401) { user = null; render(); return; } box.replaceChildren(alert('bad', err.message)); return; }
    // tenta logo pôr o pino pela morada (se a casa ainda não tiver)
    await reload();
    const hx = house(x?.id ?? r.id); let geo = '';
    if (hx && hx.lat == null && hx.address) {
      try { Object.assign(hx, await api('POST', `/api/houses/${hx.id}/geocode`)); geoFailed.delete(hx.id); geo = ' Localizada no mapa pela morada.'; }
      catch (err) { geoFailed.set(hx.id, err.message); geo = ` ${err.message}`; }
    }
    flash = { kind: 'ok', text: `${x ? 'Alojamento guardado.' : 'Alojamento criado.'}${geo}`, at: Date.now() };
    d?.close();
    if (!x) location.hash = `#/casa/${r.id}`; else render();
  } },
  h('h3', 'Identificação'),
  field('Nome do piso *', h('input', { name: 'name', value: v('name'), required: true, maxlength: 120 }), 'Único. A importação de Excel reconhece o alojamento por este nome.'),
  field('Código', h('input', { name: 'code', value: v('code'), maxlength: 20, placeholder: 'ex.: AS-001' }), 'Opcional. Único.'),
  isGestor() ? field('Delegação *', h('select', { name: 'delegation', required: true }, D.delegations.map(([k, l]) => h('option', { value: k, selected: v('delegation', delegation) === k }, l))))
    : h('input', { type: 'hidden', name: 'delegation', value: v('delegation', user.delegation) }),
  field('Região (cidade)', h('input', { name: 'region', value: v('region'), list: 'regions', maxlength: 120, placeholder: 'ex.: Oviedo' })),
  field('Edifício', h('input', { name: 'building', value: v('building'), list: 'buildings', maxlength: 120, placeholder: 'ex.: C/ Vallés 6' }), 'Opcional. Andares do mesmo prédio: escreva o mesmo edifício — ficam num só pino no mapa.'),
  datalist('buildings', [...new Set(D.houses.map((y) => y.building).filter(Boolean))].sort()),
  h('label', { class: 'f full' }, 'Morada', h('input', { name: 'address', value: v('address'), maxlength: 200, placeholder: 'Rua, número, andar, código postal, localidade' }), h('span', { class: 'help' }, 'O pino no mapa é colocado a partir da morada.')),
  h('label', { class: 'f full' }, 'Localização (link Google Maps)', h('input', { name: 'location_url', type: 'url', value: v('location_url'), maxlength: 500, placeholder: 'https://maps.app.goo.gl/…' }), h('span', { class: 'help' }, 'Opcional. No Google Maps: Partilhar → Copiar link.')),
  h('h3', 'Lotação e custos'),
  field('Lotação máxima (camas)', capIn, x && roomsOf(x.id).length ? 'Calculada pelos quartos (separador Dados).' : x ? null : 'Com quartos (abaixo), é a soma das camas.'),
  field('N.º de quartos', roomsIn),
  editor ? editor.el : null,
  field('Aluguer mensal (€)', h('input', { name: 'rent', inputmode: 'decimal', value: v('rent') })),
  field('Dia de vencimento da renda', h('input', { name: 'rent_due_day', inputmode: 'numeric', value: v('rent_due_day'), placeholder: '1 a 31' })),
  field('Despesas fixas mensais (€)', h('input', { name: 'fixed_expenses', inputmode: 'decimal', value: v('fixed_expenses') }), 'Valor habitual de luz, água, gás…'),
  h('h3', 'Contrato'),
  field('Proprietário', h('input', { name: 'owner_name', value: v('owner_name'), maxlength: 120 })),
  field('Início do contrato', h('input', { name: 'contract_start', type: 'date', value: v('contract_start') })),
  field('Fim do contrato', h('input', { name: 'contract_end', type: 'date', value: v('contract_end') })),
  field('Caução (€)', h('input', { name: 'deposit_amount', inputmode: 'decimal', value: v('deposit_amount') }), 'Em branco = sem caução.'),
  h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'deposit_available', checked: !!v('deposit_available', 0) }), 'Caução disponível (a recuperar)'),
  h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: !!v('active', 1) }), 'Alojamento ativo'),
  h('label', { class: 'f full' }, 'Notas', h('input', { name: 'notes', value: v('notes'), maxlength: 500 })),
  needCode ? h('label', { class: 'f full code' }, h('span', icon('lock'), ' Código de autorização do gestor *'), h('input', { name: 'auth_code', type: 'password', autocomplete: 'off', required: true }),
    h('span', { class: 'help' }, 'Para alterar um alojamento já criado (valores, inativar ou apagar) é preciso o código do gestor.')) : null,
  x && hasHistory(x.id) ? h('p', { class: 'help full' }, 'Este alojamento tem histórico (ocupantes ou despesas) e não pode ser apagada. Para deixar de a usar, desmarque «Alojamento ativo».') : null,
  box,
  h('div', { class: 'acts' },
    x && !hasHistory(x.id) ? h('button', { class: 'btn dng', type: 'button', onclick: async () => {
      const code = f.querySelector('[name=auth_code]')?.value ?? '';
      if (needCode && !code) { box.replaceChildren(alert('bad', 'Escreva o código de autorização do gestor para apagar o alojamento.')); return; }
      if (!confirm(`Apagar «${x.name}» definitivamente? Só é possível porque ainda não tem ocupantes nem despesas lançadas.`)) return;
      if (await act(async () => { await api('POST', `/api/houses/${x.id}/delete`, { auth_code: code }); location.hash = `#/d/${x.delegation}`; }, 'Alojamento apagado.', box)) d?.close();
    } }, 'Apagar alojamento') : h('span'),
    h('button', { class: 'btn pri', type: 'submit' }, x ? 'Guardar' : 'Criar alojamento')));
  return f;
}
const openHouseForm = (x, delegation) => { const d = dialog(x ? `Editar «${x.name}»` : 'Novo alojamento', h('div')); d.querySelector('.db').replaceChildren(houseForm(x, delegation, d)); };

const fold = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Dar entrada: escolhe-se um funcionário que JÁ EXISTE e está sem casa (pesquisa por nome, profissão ou telefone). Criar faz-se em «Novo funcionário». */
function openEnter(x) {
  const s = stats(x);
  const free = D.workers.filter((w) => !currentStay(w.id))
    .sort((a, b) => (a.delegation !== x.delegation) - (b.delegation !== x.delegation) || a.name.localeCompare(b.name));
  const box = msgBox();
  const d = dialog(`Dar entrada em «${x.name}»`, h('div'));
  let picked = null;
  const results = h('div', { class: 'full tpick wpick', role: 'listbox', 'aria-label': 'Funcionários sem alojamento' });
  const chosen = h('div', { class: 'full' });
  const q = h('input', { type: 'search', placeholder: 'Escreva parte do nome, profissão ou telefone…', 'aria-label': 'Procurar funcionário', autocomplete: 'off', oninput: () => draw() });
  const draw = () => {
    const t = fold(q.value).trim();
    const list = t ? free.filter((w) => fold(`${w.name} ${w.profession} ${w.phone}`).includes(t)) : free;
    results.replaceChildren(
      ...list.slice(0, 40).map((w) => h('label', { class: `topt${picked === w.id ? ' sel' : ''}` },
        h('input', { type: 'radio', name: 'worker_id', value: w.id, checked: picked === w.id, onchange: () => { picked = w.id; draw(); } }),
        h('span', { class: 'avatar sm' }, initials(w.name)),
        h('span', { class: 'tn' }, h('b', w.name), h('span', { class: 'muted small' }, [w.profession, w.phone].filter(Boolean).join(' · ') || '—')),
        h('span', { class: `tag${w.delegation == null ? ' warn-t' : ''}` }, delLabel(w.delegation), w.own_housing ? ' · alojamento próprio' : ''))),
      list.length > 40 ? h('p', { class: 'muted small' }, `+${list.length - 40} — escreva mais letras para afinar.`) : null,
      list.length ? null : h('div', alert('warn', t ? `Nenhum funcionário sem alojamento com «${q.value}».` : 'Não há funcionários sem alojamento.'),
        h('p', { class: 'help' }, 'Se a pessoa ainda não existe, crie-a primeiro: ', h('button', { type: 'button', class: 'btn sm', onclick: () => { d.close(); openWorker(null); } }, icon('plus'), 'Novo funcionário'))));
    const w = worker(picked);
    chosen.replaceChildren(w ? h('p', { class: 'help' }, 'Escolhido: ', h('b', w.name), w.delegation == null ? ' (pendente — passa para esta delegação)' : '') : '');
  };
  const f = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault(); const b = Object.fromEntries(new FormData(f));
    if (!picked) { box.replaceChildren(alert('bad', 'Escolha um funcionário da lista. Se não existir, crie-o em «Novo funcionário».')); return; }
    if (s.free !== null && s.free <= 0 && !confirm(`«${x.name}» já tem ${s.used} pessoas para ${s.cap} camas. Dar entrada mesmo assim?`)) return;
    const rm = (D.rooms ?? []).find((r) => r.id === Number(b.room_id));
    if (rm && roomUsed(rm.id) >= rm.beds && !confirm(`«${rm.name}» já está completo (${rm.beds} camas). Dar entrada mesmo assim?`)) return;
    const ok = await act(() => api('POST', '/api/stays/enter', { house_id: x.id, worker_id: picked, date: b.date, reason: b.reason, room_id: b.room_id ? Number(b.room_id) : null }), () => `Entrada registada: ${workerName(picked)}${rm ? ` (${rm.name})` : ''}.`, box);
    if (ok) d.close();
  } },
  h('label', { class: 'f full' }, `Procurar funcionário (${free.length} sem alojamento)`, q),
  results, chosen,
  roomsOf(x.id).length ? field('Quarto', h('select', { name: 'room_id' }, h('option', { value: '' }, '— escolher depois —'),
    roomsOf(x.id).map((r) => { const free = r.beds - roomUsed(r.id); return h('option', { value: r.id, selected: false }, `${r.name} · ${free > 0 ? `${free} livre${free === 1 ? '' : 's'}` : 'completo'}`); })), 'Os quartos com camas livres aparecem com «livre».') : null,
  field('Data de entrada', h('input', { name: 'date', type: 'date', value: today(), required: true })),
  field('Motivo', h('input', { name: 'reason', list: 'entry-reasons', required: true, maxlength: 120, placeholder: 'ex.: Início de obra' })),
  s.free !== null && s.free <= 0 ? h('div', { class: 'full' }, alert('warn', `Alojamento cheio (${s.used}/${s.cap}). Pode dar entrada, mas fica acima da lotação.`)) : null,
  box, h('div', { class: 'acts' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => { d.close(); openWorker(null); } }, icon('plus'), 'Novo funcionário'), h('button', { class: 'btn pri', type: 'submit' }, 'Dar entrada')));
  draw();
  d.querySelector('.db').replaceChildren(f);
  setTimeout(() => q.focus(), 50);
}
/** Mudar de quarto dentro do mesmo alojamento (movimento: não pede código). */
function openMoveRoom(st, x) {
  const box = msgBox();
  const d = dialog(`Quarto de ${workerName(st.worker_id)}`, h('div'));
  const sel = h('select', { name: 'room_id' }, h('option', { value: '' }, '— sem quarto —'),
    roomsOf(x.id).map((r) => { const free = r.beds - roomUsed(r.id) + (st.room_id === r.id ? 1 : 0);
      return h('option', { value: r.id, selected: st.room_id === r.id }, `${r.name} · ${free > 0 ? `${free} livre${free === 1 ? '' : 's'}` : 'completo'}`); }));
  const f = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const r = (D.rooms ?? []).find((y) => y.id === Number(sel.value));
    if (r && r.id !== st.room_id && roomUsed(r.id) >= r.beds && !confirm(`«${r.name}» já está completo (${r.beds} camas). Mudar mesmo assim?`)) return;
    if (await act(() => api('POST', `/api/stays/${st.id}/room`, { room_id: sel.value ? Number(sel.value) : null }), `${workerName(st.worker_id)}: ${r ? r.name : 'sem quarto'}.`, box)) d.close();
  } }, field('Quarto', sel), box, h('div', { class: 'acts' }, h('span'), h('button', { class: 'btn pri', type: 'submit' }, 'Guardar')));
  d.querySelector('.db').replaceChildren(f);
}
/** Saída ou transferência de um ocupante. `mode`: 'saida' | 'transferir'. */
function openLeave(st, mode = 'saida') {
  const x = house(st.house_id), name = workerName(st.worker_id);
  const d = dialog(name, h('div'));
  const body = d.querySelector('.db');
  const draw = (md) => body.replaceChildren(h('div', { class: 'leave' },
    seg([['saida', 'Dar saída', 'logout'], ['transferir', 'Transferir', 'enter']], md, draw, 'full'),
    md === 'saida' ? leaveForm(st, x, d) : transferForm(st, x, d)));
  draw(mode);
}
function leaveForm(st, x, d) {
  const box = msgBox();
  const f = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault(); const b = Object.fromEntries(new FormData(f));
    if (await act(() => api('POST', '/api/stays/leave', { stay_id: st.id, date: b.date, reason: b.reason }), `Saída registada: ${workerName(st.worker_id)}.`, box)) d.close();
  } },
  h('p', { class: 'help full' }, `Sai de «${x.name}» (desde ${dateLabel(st.start_date)}).`),
  field('Data de saída *', h('input', { name: 'date', type: 'date', value: today(), min: st.start_date, required: true }), 'Neste dia já não conta no alojamento e fica disponível para outro.'),
  field('Motivo *', h('input', { name: 'reason', list: 'exit-reasons', required: true, maxlength: 120, placeholder: 'ex.: Fim de obra' })),
  box, h('div', { class: 'acts' }, h('span'), h('button', { class: 'btn pri', type: 'submit' }, 'Confirmar saída')));
  return f;
}
function transferForm(st, x, d) {
  const minDate = st.start_date; // pode ser no próprio dia da entrada
  const box = msgBox();
  const state = { date: today() < minDate ? minDate : today(), region: null, to: null, confirmed: false };
  const regionSel = h('select', { 'aria-label': 'Região ou zona', required: true });
  const listBox = h('div', { class: 'full tpick' });
  const warn = h('div', { class: 'full' });
  const regionName = (g) => `${g.region || 'Sem região'}${seesAll() ? ` · ${DEL_SHORT[g.delegation]}` : ''}`;
  const optRow = (r) => {
    const st2 = r.free === null ? 'off' : r.free > 0 ? 'ok' : r.free === 0 ? 'full' : 'over';
    const tag = r.free === null ? `${r.used} pessoa${r.used === 1 ? '' : 's'} · ${r.cap === null ? 'lotação por preencher' : 'ocupação por registar'}`
      : r.free > 0 ? `${r.used}/${r.cap} · ${r.free} livre${r.free === 1 ? '' : 's'}` : `${r.used}/${r.cap} · ${r.free === 0 ? 'cheia' : `${-r.free} acima`}`;
    return h('label', { class: `topt${state.to === r.house.id ? ' sel' : ''}` },
      h('input', { type: 'radio', name: 'to_house_id', value: r.house.id, checked: state.to === r.house.id, onchange: () => { state.to = r.house.id; state.confirmed = false; drawList(); } }),
      h('span', { class: `dot s-${st2}` }),
      h('span', { class: 'tn' }, h('b', r.house.name), r.house.code ? h('span', { class: 'muted small' }, r.house.code) : null),
      h('span', { class: `tag${r.free !== null && r.free <= 0 ? ' bad-t' : ''}` }, tag));
  };
  const drawList = () => {
    const groups = transferOptions(D.houses, D.stays, x, state.date);
    if (!groups.length) { regionSel.replaceChildren(); listBox.replaceChildren(alert('warn', 'Não há outros alojamentos ativos para onde transferir.')); return; }
    if (!groups.some((g) => g.key === state.region)) state.region = groups[0].key; // começa na região da casa atual
    regionSel.replaceChildren(...groups.map((g) => h('option', { value: g.key, selected: g.key === state.region }, `${regionName(g)} — ${g.withFree ? `${g.withFree} com camas livres` : 'sem camas livres'}`)));
    const g = groups.find((y) => y.key === state.region);
    const all = [...g.free, ...g.full, ...g.unknown];
    if (!all.some((r) => r.house.id === state.to)) state.to = null;
    const picked = all.find((r) => r.house.id === state.to);
    listBox.replaceChildren(
      h('div', { class: 'tsec' }, h('div', { class: 'tsh' }, `Com camas livres a ${dateLabel(state.date)}`, chip('', String(g.free.length))),
        g.free.length ? g.free.map(optRow) : h('p', { class: 'muted small' }, 'Nenhum alojamento com camas livres nesta região.')),
      g.full.length ? h('details', { class: 'fold tsec', open: !!picked?.over && g.full.includes(picked) },
        h('summary', h('span', 'Cheios ou acima da lotação ', chip('warn', String(g.full.length)))), g.full.map(optRow)) : null,
      g.unknown.length ? h('details', { class: 'fold tsec', open: !!picked && g.unknown.includes(picked) },
        h('summary', h('span', 'Lotação ou ocupação desconhecida ', chip('', String(g.unknown.length)))), h('p', { class: 'help' }, 'Sem lotação preenchida ou sem registos de ocupantes: não contam como disponíveis.'), g.unknown.map(optRow)) : null);
    // destino cheio: alerta com a ocupação resultante e confirmação explícita
    warn.replaceChildren(picked?.over ? h('div', { class: 'alert warn', role: 'status' },
      h('div', h('b', `«${picked.house.name}» ficará com ${picked.after} pessoas para ${picked.cap} camas`), ` (${picked.after - picked.cap} acima da lotação) a ${dateLabel(state.date)}.`),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: state.confirmed, onchange: (e) => { state.confirmed = e.target.checked; } }), 'Confirmo a transferência acima da lotação')) : '');
  };
  regionSel.addEventListener('change', () => { state.region = regionSel.value; state.to = null; state.confirmed = false; drawList(); });
  const f = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const reason = f.querySelector('[name=reason]').value.trim();
    const to = house(state.to);
    if (!to) { box.replaceChildren(alert('bad', 'Escolha o alojamento de destino.')); return; }
    const pick = transferOptions(D.houses, D.stays, x, state.date).flatMap((g) => [...g.free, ...g.full, ...g.unknown]).find((r) => r.house.id === to.id);
    if (pick?.over && !state.confirmed) { box.replaceChildren(alert('bad', 'Confirme a transferência acima da lotação (caixa acima).')); return; }
    try {
      await api('POST', '/api/stays/leave', { stay_id: st.id, date: state.date, reason, to_house_id: to.id, confirm_over: state.confirmed });
    } catch (err) {
      if (err.status === 401) { user = null; render(); return; }
      if (err.data?.needConfirm) { await reload(); state.confirmed = false; drawList(); } // a ocupação mudou entretanto: volta a pedir confirmação
      box.replaceChildren(alert('bad', err.message)); return;
    }
    await reload();
    flash = { kind: 'ok', text: `${workerName(st.worker_id)} transferido de «${x.name}» para «${to.name}» a ${dateLabel(state.date)}.`, at: Date.now() };
    d.close(); render();
  } },
  h('p', { class: 'help full' }, `Sai de «${x.name}» e entra no novo alojamento no mesmo dia (a data indicada).`),
  field('Data de entrada no novo alojamento *', h('input', { type: 'date', value: state.date, min: minDate, required: true, onchange: (e) => { if (e.target.value) { state.date = e.target.value; state.confirmed = false; drawList(); } } }),
    'A disponibilidade é calculada para esta data.'),
  field('Região / zona *', regionSel),
  listBox, warn,
  field('Motivo *', h('input', { name: 'reason', list: 'exit-reasons', required: true, maxlength: 120, value: 'Transferência' })),
  box, h('div', { class: 'acts' }, h('span'), h('button', { class: 'btn pri', type: 'submit' }, 'Transferir')));
  drawList();
  return f;
}
function openStayEdit(st) {
  const box = msgBox();
  const needCode = !isGestor();
  const d = dialog(`Corrigir registo de ${workerName(st.worker_id)}`, h('div'));
  const f = h('form', { class: 'form', onsubmit: async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(f)); if (await act(() => api('PUT', '/api/stays', { id: st.id, house_id: st.house_id, worker_id: st.worker_id, ...b }), 'Registo corrigido.', box)) d.close(); } },
    field('Entrada', h('input', { name: 'start_date', type: 'date', value: st.start_date, required: true })),
    field('Motivo da entrada', h('input', { name: 'entry_reason', value: st.entry_reason, list: 'entry-reasons', required: true, maxlength: 120 })),
    field('Saída', h('input', { name: 'end_date', type: 'date', value: st.end_date ?? '' })),
    field('Motivo da saída', h('input', { name: 'exit_reason', value: st.exit_reason, list: 'exit-reasons', maxlength: 120 })),
    h('p', { class: 'help full' }, 'Use só para corrigir enganos. Uma saída normal regista-se em «Saída / transferir».'),
    needCode ? h('label', { class: 'f full code' }, h('span', icon('lock'), ' Código de autorização do gestor *'), h('input', { name: 'auth_code', type: 'password', autocomplete: 'off', required: true }),
      h('span', { class: 'help' }, 'Corrigir ou apagar um registo de entrada/saída pede o código do gestor.')) : null,
    box, h('div', { class: 'acts' },
      h('button', { class: 'btn dng', type: 'button', onclick: async () => {
        const code = f.querySelector('[name=auth_code]')?.value ?? '';
        if (needCode && !code) { box.replaceChildren(alert('bad', 'Escreva o código de autorização do gestor para apagar o registo.')); return; }
        if (confirm('Apagar este registo? Use só se foi criado por engano.') && await act(() => api('POST', `/api/stays/${st.id}/delete`, { auth_code: code }), 'Registo apagado.', box)) d.close();
      } }, 'Apagar registo'),
      h('button', { class: 'btn pri', type: 'submit' }, 'Guardar')));
  d.querySelector('.db').replaceChildren(f);
}
function openWorker(w) {
  const box = msgBox();
  const d = dialog(w ? w.name : 'Novo funcionário', h('div'));
  const f = h('form', { class: 'form', onsubmit: async (e) => { e.preventDefault(); if (await act(() => api('PUT', '/api/workers', { ...(w ? { id: w.id } : {}), ...Object.fromEntries(new FormData(f)), own_housing: f.querySelector('[name=own_housing]').checked ? 1 : 0 }), w ? 'Funcionário guardado.' : 'Funcionário criado.', box)) d.close(); } },
    field('Nome *', h('input', { name: 'name', value: w?.name ?? '', required: true, maxlength: 120 })),
    field('Empresa / obra', h('input', { name: 'company', value: w?.company ?? '', maxlength: 120 })),
    field('Idioma das mensagens', h('select', { name: 'language' }, [['', '— por definir (espanhol) —'], ['es', 'Espanhol'], ['pt', 'Português']].map(([k, l]) => h('option', { value: k, selected: (w?.language ?? '') === k }, l)))),
    field('Telefone', h('input', { name: 'phone', type: 'tel', value: w?.phone ?? '', maxlength: 40, placeholder: '+351 …' })),
    h('label', { class: 'chk full' }, h('input', { type: 'checkbox', name: 'own_housing', checked: !!w?.own_housing }), 'Alojamento próprio (não precisa de alojamento da empresa)'),
    field('Profissão', h('input', { name: 'profession', value: w?.profession ?? '', maxlength: 60, list: 'professions', placeholder: 'ex.: Encofrador' })),
    datalist('professions', [...new Set(D.workers.map((y) => y.profession).filter(Boolean))].sort()),
    isGestor() ? field('Delegação', h('select', { name: 'delegation' }, h('option', { value: '', selected: w ? w.delegation == null : false }, '— Pendente (sem delegação) —'), D.delegations.map(([k, l]) => h('option', { value: k, selected: (w?.delegation ?? '') === k }, l))), 'Pendente: ainda sem alojamento. Ao dar entrada num alojamento, fica com a delegação do alojamento.') : null,
    h('p', { class: 'help full' }, 'Guarde só o necessário (RGPD): nome e, se útil, telefone e obra.'),
    box, h('div', { class: 'acts' },
      w && !D.stays.some((s) => s.worker_id === w.id) ? h('button', { class: 'btn dng', type: 'button', onclick: async () => { if (confirm(`Apagar «${w.name}»? (ainda não tem registos de alojamento)`) && await act(() => api('DELETE', `/api/workers/${w.id}`), 'Funcionário apagado.', box)) d.close(); } }, 'Apagar') : h('span'),
      h('button', { class: 'btn pri', type: 'submit' }, w ? 'Guardar' : 'Adicionar')));
  d.querySelector('.db').replaceChildren(f);
}

// ---------- login ----------
function viewLogin() {
  const f = h('form', { class: 'panel login', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/auth/login', Object.fromEntries(new FormData(f)));
      session.csrf = r.csrf;
      // só marca a sessão depois de ter os dados (evita desenhar o ecrã a meio, sem dados)
      const me = (await api('GET', '/api/auth/me')).user;
      if (!me.mustChange) await reload();
      user = me; location.hash = '#/'; render();
    } catch (err) { f.querySelector('.msg').replaceChildren(alert('bad', err.message)); }
  } },
  h('div', { class: 'brand' }, h('img', { src: '/logo.jpg', alt: '', width: 36, height: 36 }), h('span', 'Fonsat', h('small', 'Alojamentos'))),
  field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true })),
  field('Palavra-passe', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
  h('div', { class: 'msg' }),
  h('button', { class: 'btn pri', type: 'submit' }, 'Entrar'));
  return f;
}

// ---------- painel (gestor) ----------
function kpiRow(T, sub, all = null) {
  const inactive = all ? all.filter((x) => !x.active).length : 0;
  return h('div', { class: 'kpis' },
    kpi(h('span', icon('building'), ' Alojamentos'), num(T.n), [inactive ? `${inactive} inativo${inactive === 1 ? '' : 's'}` : 'ativos', T.nUnknown ? `${T.nUnknown} por confirmar` : null].filter(Boolean).join(' · ')),
    kpi(h('span', icon('bed'), 'Ocupação'), h('span', num(T.usedKnown), h('small', ` / ${num(T.cap)} camas`)),
      [T.cap ? `${pct((T.usedKnown / T.cap) * 100)} da lotação` : null, T.nUnknown ? `+${num(T.usedUnknown)} em ${T.nUnknown} por confirmar · ${num(T.used)} alojados` : null].filter(Boolean).join(' · ') || null,
      '', occBar(T.usedKnown, T.cap)),
    kpi('Camas livres', num(T.free), T.over ? `+${T.over} acima da lotação` : 'nos alojamentos com lotação conhecida', T.over ? 'bad' : ''),
    kpi('Custo mensal', eur(T.cost, 0), sub),
    kpi('Custo por pessoa', eur(T.perPerson, 0), 'custo ÷ alojados hoje', 'main'));
}
/** Pedidos de lista desta semana (alojamentos com ocupantes). */
function weeklyPanel(active) {
  const list = active.filter((x) => occupantsNow(x.id).length).map((x) => ({ x, cs: checkinState(x), r: x.responsible_id ? worker(x.responsible_id) : null }));
  if (!list.length) return null;
  const n = (k) => list.filter((i) => i.cs.key === k).length;
  const todo = list.filter((i) => i.cs.key !== 'ok').sort((a, b) => ['responder', 'pedir', 'enviado'].indexOf(a.cs.key) - ['responder', 'pedir', 'enviado'].indexOf(b.cs.key));
  // sempre fechado: o resumo (chips) chega; o pormenor abre ao clicar
  return h('details', { class: 'panel fold weekly' },
    h('summary', h('span', 'Listas semanais (responsáveis) ',
      chip('s-ok', `${n('ok')} aplicadas`), ' ', n('responder') ? h('a', { href: '#/correcoes', onclick: (e) => e.stopPropagation() }, chip('warn', `${n('responder')} por aplicar →`)) : null, ' ', chip('', `${n('enviado')} à espera`), ' ', chip('', `${n('pedir')} por pedir`),
      list.some((i) => !i.r) ? [' ', chip('bad', `${list.filter((i) => !i.r).length} sem responsável`)] : null),
      W(h('button', { class: 'btn pri sm', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openCheckinQueue(null); } }, icon('list'), `Pedir a todos (${list.filter((i) => i.r && i.cs.key === 'pedir').length})`))),
    h('ul', { class: 'alerts' }, todo.map(({ x, cs, r }) => h('li',
      h('span', { class: `dot ${cs.key === 'responder' ? 's-full' : cs.key === 'enviado' ? 's-ok' : 's-unknown'}` }), houseLink(x),
      h('span', { class: 'muted' }, `${delLabel(x.delegation)} · ${r ? `${r.name.split(' ')[0]} · ${cs.text}` : 'sem responsável'}`),
      W(r && cs.key === 'pedir' ? h('button', { class: 'btn sm', onclick: () => openCheckin(x) }, 'Pedir') : null)))));
}
function viewDashboard() {
  const active = D.houses.filter((x) => x.active);
  const T = totals(active);
  const alerts = active.flatMap((x) => houseAlerts(x).map((a) => ({ ...a, x }))).sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
  const cards = D.delegations.map(([k, l]) => {
    const list = active.filter((x) => x.delegation === k), t = totals(list);
    return h('a', { class: 'card del', href: `#/d/${k}` },
      h('div', { class: 't' }, h('div', h('div', { class: 'name' }, l), h('div', { class: 'reg' }, `${t.n} alojamento${t.n === 1 ? '' : 's'}`)), alertChip(list.flatMap(houseAlerts))),
      h('div', { class: 'big' }, `${num(t.usedKnown)}/${num(t.cap)}`, h('small', 'camas ocupadas')), occBar(t.usedKnown, t.cap),
      t.nUnknown ? h('div', { class: 'row' }, h('span', `${t.nUnknown} por confirmar`), h('b', `${num(t.usedUnknown)} pessoa${t.usedUnknown === 1 ? '' : 's'}`)) : null,
      h('div', { class: 'row' }, h('span', 'Livres'), h('b', t.over ? `${num(t.free)} (+${t.over} a mais)` : num(t.free))),
      h('div', { class: 'row' }, h('span', 'Custo mensal'), h('b', eur(t.cost, 0))),
      h('div', { class: 'row' }, h('span', 'Por pessoa'), h('b', eur(t.perPerson, 0))));
  });
  return h('div',
    h('div', { class: 'head' }, h('div', h('h1', 'Painel'), h('div', { class: 'sub' }, `Todas as delegações · hoje, ${dateLabel(today())}`)),
      h('div', { class: 'acts' }, h('a', { class: 'btn', href: '#/mapa', onclick: () => { mem.mapDel = ''; remember(); } }, icon('map'), 'Mapa'))),
    kpiRow(T, monthLabel(thisMonth()), D.houses),
    reviewAlert(),
    weeklyPanel(active),
    h('div', { class: 'grid' }, cards),
    h('details', { class: 'panel fold' }, h('summary', h('span', 'Alertas ', alertChip(alerts) ?? chip('s-ok', 'nenhum'))),
      alerts.length ? h('ul', { class: 'alerts' }, alerts.map((a) => h('li', h('span', { class: `dot ${a.level === 'bad' ? 's-over' : 's-full'}` }), houseLink(a.x), h('span', { class: 'muted' }, delLabel(a.x.delegation)), h('span', a.text)))) : h('p', { class: 'muted' }, 'Sem alertas.')));
}

// ---------- delegação: casas em cards ou lista ----------
const FILTERS = [['ativas', 'Ativos'], ['livres', 'Com camas livres'], ['cheias', 'Cheios'], ['excedidas', 'Acima da lotação'], ['vazias', 'Vazios'], ['porconfirmar', 'Por confirmar'], ['inativas', 'Inativos'], ['todas', 'Todos']];
function passFilter(x) {
  const st = statusOf(x);
  return { ativas: x.active, livres: st === 'ok', cheias: st === 'full', excedidas: st === 'over', vazias: st === 'empty', porconfirmar: st === 'unknown', inativas: !x.active, todas: true }[mem.filter] ?? true;
}
const searchKey = (x) => `${x.code} ${x.name} ${x.building} ${x.region} ${x.address}`.toLowerCase();
function houseCard(x) {
  const s = stats(x), st = statusOf(x);
  return h('a', { class: `card s-${st}`, href: `#/casa/${x.id}`, 'data-q': searchKey(x) },
    h('div', { class: 't' }, h('div', h('div', { class: 'name' }, x.name), h('div', { class: 'reg' }, [x.code, x.building ? `Ed. ${x.building}` : null, x.region || '—'].filter(Boolean).join(' · '))), alertChip(houseAlerts(x))),
    h('div', { class: 'big' }, `${s.used}${s.cap != null ? `/${s.cap}` : ''}`, h('small', 'camas')), occBar(s.used, s.cap),
    h('div', { class: 'row' }, h('span', STATUS[st]), h('b', s.perPerson != null ? `${eur(s.perPerson, 0)}/pessoa` : eur(s.cost, 0))));
}
/** Itens da lista: uma casa, ou um edifício com os seus andares (2+ andares do mesmo edifício na lista). */
function groupByBuilding(list) {
  const out = [], bld = new Map();
  for (const x of list) {
    if (!x.building) { out.push({ house: x }); continue; }
    const k = bldKey(x);
    if (!bld.has(k)) { const it = { building: x.building, floors: [] }; bld.set(k, it); out.push(it); }
    bld.get(k).floors.push(x);
  }
  return out.map((it) => (it.floors?.length === 1 ? { house: it.floors[0] } : it))
    .map((it) => (it.floors ? { ...it, floors: it.floors.sort((a, b) => a.name.localeCompare(b.name, 'pt', { numeric: true })) } : it));
}
const worstOf = (xs) => ST_RANK.find((k) => xs.some((x) => statusOf(x) === k)) ?? 'off';
/** Cartão do edifício: totais somados e cada andar com a sua ocupação e acesso à ficha. */
function buildingCard(it) {
  const xs = it.floors, T = totals(xs.filter((x) => x.active)), st = worstOf(xs);
  return h('div', { class: `card bldcard s-${st}`, 'data-q': xs.map(searchKey).join(' ') },
    h('div', { class: 't' }, h('div', h('div', { class: 'name' }, icon('building'), ' ', it.building), h('div', { class: 'reg' }, [`${xs.length} andares`, xs[0].region].filter(Boolean).join(' · '))), alertChip(xs.flatMap(houseAlerts))),
    h('div', { class: 'big' }, `${T.usedKnown}${T.cap ? `/${T.cap}` : ''}`, h('small', 'camas no edifício')), occBar(T.usedKnown, T.cap),
    T.nUnknown ? h('div', { class: 'row' }, h('span', `${T.nUnknown} andar${T.nUnknown === 1 ? '' : 'es'} por confirmar`), h('b', `${T.usedUnknown} pessoas`)) : null,
    h('ul', { class: 'floors' }, xs.map((x) => { const fs = stats(x), fst = statusOf(x);
      return h('li', h('span', { class: `dot s-${fst}`, title: STATUS[fst] }), h('a', { href: `#/casa/${x.id}` }, x.name),
        h('span', { class: 'muted small' }, `${fs.used}${fs.cap != null ? `/${fs.cap}` : ''}${fs.free != null && fs.free > 0 ? ` · ${fs.free} livre${fs.free === 1 ? '' : 's'}` : ''}`)); })),
    h('div', { class: 'row' }, h('span', 'Custo mensal'), h('b', `${eur(T.cost, 0)}${T.perPerson != null ? ` · ${eur(T.perPerson, 0)}/pessoa` : ''}`)));
}
function houseTable(list) {
  return table([{ t: '' }, 'Alojamento', 'Região', { t: 'Ocupação', n: true }, { t: 'Livres', n: true }, { t: 'Custo mensal', n: true }, { t: '€/pessoa', n: true }, ''],
    groupByBuilding(list).flatMap((it) => (it.floors ? [buildingRow(it), ...it.floors.map((x) => houseRow(x, true))] : [houseRow(it.house)])));
}
function buildingRow(it) {
  const T = totals(it.floors.filter((x) => x.active)), st = worstOf(it.floors);
  return h('tr', { class: 'bldrow', 'data-q': it.floors.map(searchKey).join(' ') },
    h('td', h('span', { class: `dot s-${st}`, title: STATUS[st] })), h('td', h('b', icon('building'), ' ', it.building), h('span', { class: 'muted small' }, ` · ${it.floors.length} andares`)),
    td(it.floors[0].region || '—'), td(`${T.usedKnown}${T.cap ? `/${T.cap}` : ''}`, true), td(T.free || '—', true), td(eur(T.cost, 0), true), td(eur(T.perPerson, 0), true), h('td'));
}
function houseRow(x, floor = false) {
  { const s = stats(x), st = statusOf(x);
      return h('tr', { class: `link${x.active ? '' : ' off'}${floor ? ' floor' : ''}`, 'data-q': searchKey(x), onclick: () => { location.hash = `#/casa/${x.id}`; } },
        h('td', h('span', { class: `dot s-${st}`, title: STATUS[st] })), h('td', floor ? h('span', { class: 'muted' }, '↳ ') : null, h('b', x.name)), td(x.region || '—'), td(`${s.used}${s.cap != null ? `/${s.cap}` : ''}`, true),
        h('td', { class: `n${s.free !== null && s.free < 0 ? ' bad-t' : ''}` }, s.free ?? '—'), td(eur(s.cost, 0), true), td(eur(s.perPerson, 0), true), h('td', alertChip(houseAlerts(x))));
  }
}
/** Botão «Ações ▾» com um menu (fecha ao escolher, ao clicar fora ou com Esc). */
function actionsMenu(items) {
  const menu = h('details', { class: 'menu' },
    h('summary', { class: 'btn', 'aria-haspopup': 'menu' }, icon('gear'), 'Ações', h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾')),
    h('div', { class: 'menu-pop', role: 'menu' }, items));
  menu.addEventListener('click', (e) => { if (e.target.closest('.menu-pop a, .menu-pop button')) menu.open = false; });
  return menu;
}
document.addEventListener('click', (e) => { document.querySelectorAll('details.menu[open]').forEach((m) => { if (!m.contains(e.target)) m.open = false; }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('details.menu[open]').forEach((m) => { m.open = false; }); });
function viewDelegation(del) {
  const all = D.houses.filter((x) => x.delegation === del);
  const regions = [...new Set(all.map((x) => x.region).filter(Boolean))].sort();
  if (mem.region && !regions.includes(mem.region)) mem.region = '';
  const list = all.filter((x) => passFilter(x) && (!mem.region || x.region === mem.region));
  const T = totals(all.filter((x) => x.active));
  const inactiveN = all.filter((x) => !x.active).length;
  const content = h('div', mem.view === 'list' ? (list.length ? houseTable(list) : null) : h('div', { class: 'grid' }, groupByBuilding(list).map((it) => (it.floors ? buildingCard(it) : houseCard(it.house)))),
    list.length ? null : h('p', { class: 'muted' }, 'Nenhum alojamento com estes filtros.'));
  const applySearch = () => { const q = mem.q.trim().toLowerCase(); content.querySelectorAll('[data-q]').forEach((el) => { el.hidden = !!q && !el.dataset.q.includes(q); }); };
  const search = h('input', { type: 'search', value: mem.q, placeholder: 'Procurar alojamento, região ou morada', 'aria-label': 'Procurar', oninput: (e) => { mem.q = e.target.value; remember(); applySearch(); } });
  mounts.push(applySearch);
  const sel = (key, opts, label) => h('select', { 'aria-label': label, onchange: (e) => { mem[key] = e.target.value; remember(); render(); } }, opts.map(([v, l]) => h('option', { value: v, selected: mem[key] === v }, l)));
  return h('div',
    h('div', { class: 'head' }, h('div', h('h1', delLabel(del)), h('div', { class: 'sub' }, `${T.n} alojamento${T.n === 1 ? '' : 's'} ativo${T.n === 1 ? '' : 's'}${inactiveN ? ` · ${inactiveN} inativo${inactiveN === 1 ? '' : 's'}` : ''}`)),
      h('div', { class: 'acts' },
        h('a', { class: 'btn', href: '#/mapa', onclick: () => { mem.mapDel = del; remember(); } }, icon('map'), 'Mapa'),
        actionsMenu([
          h('a', { href: `/api/excel/exportar?delegacao=${del}`, download: '', role: 'menuitem' }, icon('list'), h('span', h('b', 'Exportar Excel'), h('small', `Alojamentos e funcionários de ${delLabel(del)}`))),
          W(h('button', { type: 'button', role: 'menuitem', onclick: () => openExcelImport(del) }, icon('enter'), h('span', h('b', 'Importar Excel'), h('small', `Só dados de ${delLabel(del)}, com pré-visualização`)))),
          W(h('button', { type: 'button', role: 'menuitem', onclick: () => openCheckinQueue(del) }, icon('users'), h('span', h('b', 'Pedir listas aos responsáveis'), h('small', `WhatsApp em sequência · ${checkinTargets(del).length} por pedir esta semana`)))),
        ]),
        W(h('button', { class: 'btn pri', onclick: () => openHouseForm(null, del) }, icon('plus'), 'Novo alojamento')))),
    kpiRow(T, monthLabel(thisMonth()), all),
    h('div', { class: 'toolbar' },
      h('div', { class: 'grow' }, icon('search'), search),
      regions.length > 1 ? sel('region', [['', 'Todas as regiões'], ...regions.map((r) => [r, r])], 'Região') : null,
      sel('filter', FILTERS, 'Estado'),
      seg([['cards', 'Cards', 'grid'], ['list', 'Lista', 'list']], mem.view, (v) => { mem.view = v; remember(); render(); })),
    content);
}

// ---------- mapa geral ----------
const MAP_OCC = [['', 'Toda a ocupação'], ['ok', 'Com camas livres'], ['full', 'Cheios'], ['over', 'Acima da lotação'], ['empty', 'Vazios'], ['unknown', 'Por confirmar']];
function viewMap() {
  const del = seesAll() ? mem.mapDel : user.delegation;
  const scope = D.houses.filter((x) => !del || x.delegation === del);
  const regions = [...new Set(scope.map((x) => x.region).filter(Boolean))].sort();
  if (mem.mapRegion && !regions.includes(mem.mapRegion)) mem.mapRegion = '';
  const list = scope.filter((x) => (mem.mapState === 'todas' || (mem.mapState === 'ativas' ? x.active : !x.active))
    && (!mem.mapRegion || x.region === mem.mapRegion) && (!mem.mapOcc || statusOf(x) === mem.mapOcc));
  const sel = (key, opts, label) => h('select', { 'aria-label': label, onchange: (e) => { mem[key] = e.target.value; remember(); render(); } }, opts.map(([v, l]) => h('option', { value: v, selected: mem[key] === v }, l)));
  const el = h('div', { class: 'map' });
  const panel = h('aside', { class: 'panel mapside', hidden: true, 'aria-live': 'polite' });
  const wrap = h('div', { class: 'mapwrap' }, el, panel);
  const status = h('div', { class: 'small muted', 'aria-live': 'polite' });
  const missing = h('div');
  const showMissing = () => {
    const miss = list.filter((x) => x.lat == null);
    missing.replaceChildren(miss.length ? h('details', { class: 'panel fold' }, h('summary', h('span', 'Alojamentos sem pino no mapa ', chip('warn', String(miss.length)))),
      h('ul', { class: 'alerts' }, miss.map((x) => h('li', houseLink(x), h('span', { class: 'muted' }, geoFailed.get(x.id) ?? (x.address ? 'à espera de pesquisa' : 'sem morada')), h('span', { class: 'muted small' }, '→ abra a ficha e use «Definir localização»'))))) : '');
  };
  mounts.push(() => {
    if (!window.L) { el.replaceChildren(alert('bad', 'Não foi possível carregar o mapa.')); return; }
    const m = makeMap(el, del ? DEL_CENTER[del] : [41.9, -4.5], del ? 8 : 6);
    const group = pinGroup().addTo(m);
    const closePanel = () => { panel.hidden = true; wrap.classList.remove('open'); m.invalidateSize(); };
    // clique num grupo: o mapa aproxima-se e abre ao lado a lista das casas desse grupo
    group.on('clusterclick', (e) => {
      const houses = e.layer.getAllChildMarkers().flatMap((mk) => (mk.options.houseIds ?? []).map((id) => [mk, house(id)])).filter(([, x]) => x)
        .sort(([, a], [, b]) => ST_RANK.indexOf(statusOf(a)) - ST_RANK.indexOf(statusOf(b)) || a.name.localeCompare(b.name));
      const T = totals(houses.map(([, x]) => x));
      panel.replaceChildren(
        h('div', { class: 'head' }, h('div', h('h2', `${houses.length} alojamentos neste grupo`), h('div', { class: 'small muted' }, `${T.used} pessoas · ${T.cap ? `${T.usedKnown}/${T.cap} camas · ` : ''}${eur(T.cost, 0)}/mês`)),
          h('button', { class: 'btn sm ghost', 'aria-label': 'Fechar lista', onclick: closePanel }, '✕')),
        h('ul', { class: 'clist' }, houses.map(([mk, x]) => { const s = stats(x), st = statusOf(x);
          return h('li', { tabindex: 0, onclick: () => group.zoomToShowLayer(mk, () => mk.openPopup()), onkeydown: (ev) => { if (ev.key === 'Enter') group.zoomToShowLayer(mk, () => mk.openPopup()); } },
            h('span', { class: `dot s-${st}`, title: STATUS[st] }),
            h('div', { class: 'ci' }, h('b', x.name), h('span', { class: 'muted small' }, [x.code, x.region].filter(Boolean).join(' · '))),
            h('div', { class: 'cn2' }, h('b', `${s.used}${s.cap != null ? `/${s.cap}` : ''}`), h('span', { class: 'muted small' }, s.perPerson != null ? `${eur(s.perPerson, 0)}/p.` : eur(s.cost, 0))),
            h('a', { class: 'btn sm', href: `#/casa/${x.id}`, onclick: (ev) => ev.stopPropagation() }, 'Ficha')); })));
      panel.hidden = false; wrap.classList.add('open');
      m.invalidateSize();
    });
    group.addLayers ? group.addLayers(pinsFor(list)) : pinsFor(list).forEach((mk) => mk.addTo(group));
    if (group.getLayers().length) m.fitBounds(group.getBounds().pad(0.15), { maxZoom: 14 });
    showMissing();
    const alive = () => maps.includes(m);
    geocodeMissing(list, (x) => { group.addLayer(pinFor(x)); m.fitBounds(group.getBounds().pad(0.15), { maxZoom: 14 }); },
      (i, n) => { status.textContent = n ? `A localizar alojamentos no mapa pela morada… ${i} de ${n}` : ''; if (!n) showMissing(); }, alive);
  });
  return h('div',
    h('div', { class: 'head' }, h('div', h('h1', 'Mapa'), h('div', { class: 'sub' }, `${list.length} de ${scope.length} alojamentos${del ? ` · ${delLabel(del)}` : ''}`))),
    // aviso bem visível quando há filtros que escondem casas
    (() => {
      const active = [seesAll() && mem.mapDel ? `só ${delLabel(mem.mapDel)}` : null, mem.mapRegion ? `região ${mem.mapRegion}` : null,
        mem.mapState !== 'ativas' ? (mem.mapState === 'todas' ? 'ativos e inativos' : 'só inativos') : null, mem.mapOcc ? `só «${STATUS[mem.mapOcc]}»` : null].filter(Boolean);
      if (!seesAll() && !active.length) return h('div', { class: 'alert info' }, `Vê apenas os alojamentos da sua delegação (${delLabel(user.delegation)}).`);
      return active.length ? h('div', { class: 'alert warn' }, `Filtros ativos: ${active.join(' · ')} — ${D.houses.filter((x) => x.active).length - list.filter((x) => x.active).length} alojamentos ativos escondidos. `,
        h('button', { class: 'btn sm', onclick: () => { Object.assign(mem, { mapDel: seesAll() ? '' : mem.mapDel, mapRegion: '', mapState: 'ativas', mapOcc: '' }); remember(); render(); } }, 'Mostrar todas')) : null;
    })(),
    h('div', { class: 'toolbar' },
      seesAll() ? seg([['', 'Todas', null], ...D.delegations.map(([k, l]) => [k, `${DEL_SHORT[k]} · ${l}`, null])], mem.mapDel, (v) => { mem.mapDel = v; remember(); render(); }) : null,
      regions.length > 1 ? sel('mapRegion', [['', 'Todas as regiões'], ...regions.map((r) => [r, r])], 'Região') : null,
      sel('mapState', [['ativas', 'Ativos'], ['inativas', 'Inativos'], ['todas', 'Ativos e inativos']], 'Estado'),
      sel('mapOcc', MAP_OCC, 'Ocupação')),
    h('div', { class: 'toolbar' }, h('div', { class: 'legend' }, ...['ok', 'full', 'over', 'empty', 'unknown'].map((k) => h('span', { title: k === 'unknown' ? 'Lotação ou ocupação desconhecida' : '' }, h('span', { class: `dot s-${k}` }), STATUS[k])), h('span', 'AST Astúrias · CAT Catalunha · POR Porto'), h('span', h('span', { class: 'cluster mini', style: `background:conic-gradient(${ST_COLOR.ok} 0deg 180deg,${ST_COLOR.full} 180deg 270deg,${ST_COLOR.over} 270deg 360deg)` }, h('span', { class: 'cn' }, '3')), 'grupo: clique para ver a lista')), status),
    wrap, missing);
}

// ---------- ficha da casa ----------
const TABS = [['ocupantes', 'Ocupantes'], ['custos', 'Custos'], ['dados', 'Dados'], ['historico', 'Histórico']];
function viewHouse(id) {
  const x = house(id);
  if (!x) return h('div', alert('bad', 'Alojamento inexistente ou fora da sua delegação.'), h('a', { href: '#/' }, '← Voltar'));
  const s = stats(x), occ = occupantsNow(x.id), url = mapUrl(x);
  const tab = TABS.some(([k]) => k === mem.tab) ? mem.tab : 'ocupantes';
  const body = { ocupantes: tabOccupants, custos: tabCosts, dados: tabData, historico: tabHistory }[tab](x, s, occ);
  return h('div',
    h('a', { href: `#/d/${x.delegation}`, class: 'back' }, icon('back'), delLabel(x.delegation)),
    h('div', { class: 'head' },
      h('div', h('h1', x.name), h('div', { class: 'sub' }, statusChip(x), h('span', [x.code, x.building ? `Edifício ${x.building}` : null, x.region, delLabel(x.delegation)].filter(Boolean).join(' · ')))),
      h('div', { class: 'acts' },
        url ? h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('pin'), 'Ver no mapa', icon('ext')) : null,
        W(h('button', { class: 'btn', onclick: () => openHouseForm(x), title: isGestor() ? '' : 'Pede o código de autorização do gestor' }, icon(isGestor() ? 'edit' : 'lock'), 'Editar')))),
    ...houseAlerts(x).map((a) => alert(a.level === 'bad' ? 'bad' : 'warn', a.text + '.')),
    h('div', { class: 'kpis' },
      kpi(h('span', icon('bed'), 'Ocupação'), h('span', num(s.used), s.cap != null ? h('small', ` / ${s.cap}`) : null), x.rooms != null ? `${x.rooms} quartos` : null, '', occBar(s.used, s.cap)),
      kpi('Camas livres', s.free ?? '—', s.free !== null && s.free < 0 ? 'acima da lotação' : null, s.free !== null && s.free < 0 ? 'bad' : ''),
      kpi('Custo mensal', eur(s.cost, 0), monthLabel(thisMonth())),
      kpi('Custo por pessoa', eur(s.perPerson, 0), 'custo ÷ alojados hoje', 'main')),
    locationBlock(x),
    h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => { mem.tab = k; remember(); render(); } }, l))),
    body);
}
/** Número para o WhatsApp: só algarismos com indicativo; sem indicativo, o do país da delegação (Porto 351, resto 34). */
function waNumber(phone, delegation) {
  let d = String(phone ?? '').split('/')[0].trim();
  const plus = d.startsWith('+') || d.startsWith('00');
  d = d.replace(/\D/g, '').replace(/^00/, '');
  if (!d) return null;
  if (!plus && d.length === 9) d = (delegation === 'porto' ? '351' : '34') + d;
  return d.length >= 8 ? d : null;
}
const weekStart = () => { const t = new Date(); const k = (t.getDay() + 6) % 7; t.setDate(t.getDate() - k); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
/** Último pedido de lista de um alojamento e o seu estado nesta semana. */
function checkinState(x) {
  const c = (D.checkins ?? []).filter((k) => k.house_id === x.id && k.status !== 'arquivado').sort((a, b) => b.id - a.id)[0];
  const ws = weekStart();
  if (c?.status === 'respondido') return { key: 'responder', c, text: `Resposta por aplicar (${dateLabel(c.answered_at.slice(0, 10))})` };
  if (c && (c.applied_at ?? c.answered_at ?? '') >= ws && c.status === 'aplicado') return { key: 'ok', c, text: `Lista desta semana aplicada (${dateLabel(c.applied_at.slice(0, 10))})` };
  if (c && c.status === 'aberto' && c.created_at.slice(0, 10) >= ws && c.expires_at > new Date().toISOString()) return { key: 'enviado', c, text: c.sent_at ? `Pedido enviado a ${dateLabel(c.sent_at.slice(0, 10))}, à espera de resposta` : 'Pedido criado, por enviar' };
  return { key: 'pedir', c, text: 'Lista desta semana por pedir' };
}
function personRow(x, s, st, rooms) {
  const w = worker(st.worker_id), resp = x.responsible_id === st.worker_id;
  return h('div', { class: `person${resp ? ' resp' : ''}` }, h('div', { class: 'avatar' }, initials(w?.name ?? '?')),
    h('div', { class: 'info' }, h('b', w?.name ?? '—', resp ? h('span', { class: 'chip s-ok badge' }, '★ Responsável') : null),
      h('span', [w?.profession, `desde ${dateLabel(st.start_date)}`, st.entry_reason, w?.company].filter(Boolean).join(' · ')),
      h('span', { class: 'small' }, w?.phone ? telLink(w.phone) : h('span', { class: 'chip warn' }, 'Sem telefone'), w?.language ? h('span', { class: 'muted' }, ` · ${w.language === 'pt' ? 'português' : 'espanhol'}`) : null)),
    h('span', { class: 'muted small' }, s.perPerson != null ? `${eur(s.perPerson, 0)}/mês` : ''),
    W(h('span', { class: 'inl' },
      resp ? null : h('button', { class: 'btn sm ghost', title: 'Nomear responsável deste alojamento', onclick: () => act(() => api('PUT', `/api/houses/${x.id}/responsible`, { worker_id: st.worker_id }), `${w?.name} é agora o responsável.`) }, '★'),
      rooms.length ? h('button', { class: 'btn sm', onclick: () => openMoveRoom(st, x) }, 'Quarto') : null,
      h('button', { class: 'btn sm', onclick: () => openLeave(st, 'saida') }, 'Saída'), h('button', { class: 'btn sm', onclick: () => openLeave(st, 'transferir') }, 'Transferir'))));
}
/** Responsável primeiro; depois por nome. */
const byResp = (x) => (a, b) => (b.worker_id === x.responsible_id) - (a.worker_id === x.responsible_id) || workerName(a.worker_id).localeCompare(workerName(b.worker_id));
/** Barra do responsável e da lista semanal. */
function responsibleBar(x, occ) {
  const r = x.responsible_id ? worker(x.responsible_id) : null, cs = checkinState(x);
  return h('div', { class: 'respbar' },
    h('div', h('b', r ? `Responsável: ${r.name}` : 'Sem responsável'), h('span', { class: 'muted small' }, r ? ` · ${r.phone || 'sem telefone'} · ${cs.text}` : ' · nomeie um dos ocupantes com ★ — é quem confirma a lista toda a semana')),
    W(r && occ.length ? h('button', { class: `btn ${cs.key === 'pedir' ? 'pri' : ''}`, onclick: () => openCheckin(x) }, icon('list'), 'Pedir lista (WhatsApp)') : null));
}
function tabOccupants(x, s, occ) {
  occ = [...occ].sort(byResp(x));
  const rooms = roomsOf(x.id);
  const review = checkinReview(x);
  const head = h('div', { class: 'head' }, h('h2', `Alojados hoje · ${occ.length}${s.cap != null ? `/${s.cap}` : ''}${rooms.length ? ` · ${rooms.length} quartos` : ''}`), W(h('button', { class: 'btn pri', onclick: () => openEnter(x) }, icon('enter'), 'Dar entrada')));
  if (rooms.length) {
    const none = occ.filter((st) => !st.room_id || !rooms.some((r) => r.id === st.room_id));
    return h('div', review, h('section', { class: 'panel' }, head, occ.length ? responsibleBar(x, occ) : null,
      h('div', { class: 'roomgrid' }, rooms.map((r) => {
        const inRoom = occ.filter((st) => st.room_id === r.id), free = r.beds - inRoom.length;
        const st = free < 0 ? 'over' : free === 0 ? (r.beds ? 'full' : 'off') : 'ok';
        return h('div', { class: `room s-${st}` },
          h('div', { class: 'rh' }, h('b', r.name), h('span', { class: `chip s-${st}` }, `${inRoom.length}/${r.beds}${free > 0 ? ` · ${free} livre${free === 1 ? '' : 's'}` : free < 0 ? ` · ${-free} a mais` : ' · completo'}`)),
          inRoom.length ? h('div', { class: 'people' }, inRoom.map((o) => personRow(x, s, o, rooms))) : h('p', { class: 'muted small' }, r.beds ? 'Vazio' : 'Sem camas'));
      })),
      none.length ? h('div', { class: 'room s-unknown' }, h('div', { class: 'rh' }, h('b', 'Sem quarto atribuído'), chip('warn', String(none.length))),
        h('div', { class: 'people' }, none.map((o) => personRow(x, s, o, rooms)))) : null));
  }
  return h('div', review, h('section', { class: 'panel' }, head,
    occ.length ? [responsibleBar(x, occ), h('div', { class: 'people' }, occ.map((st) => personRow(x, s, st, rooms)))]
      : occUnknown(x) ? h('div', alert('warn', 'Ocupação por registar: este alojamento nunca teve entradas registadas, por isso não se sabe se está vazio.'),
          RO() ? null : h('div', { class: 'sp' }, h('button', { class: 'btn', onclick: () => confirm(`Confirma que «${x.name}» está vazio hoje?`) && act(() => api('POST', `/api/houses/${x.id}/confirm-empty`, {}), 'Confirmado: alojamento vazio.') }, 'Confirmar que está vazio'),
            h('span', { class: 'muted small' }, ' ou dê entrada a quem lá está.')))
      : h('p', { class: 'muted' }, 'Ninguém alojado.')));
}
/** Mensagem do pedido de lista (no idioma do responsável; «bom dia» até às 12h, depois «boa tarde»). */
function checkinMessage(x, r, url) {
  const am = new Date().getHours() < 12, first = (r.name || '').split(' ')[0];
  const nm = first ? first.charAt(0) + first.slice(1).toLowerCase() : '';
  return r.language === 'pt'
    ? `${am ? 'Bom dia' : 'Boa tarde'}${nm ? `, ${nm}` : ''}. Clica no link e confirma quem está contigo no alojamento «${x.name}»:\n${url}\n\nSe o link não abrir, guarda o meu contacto ou copia o link e cola no navegador.`
    : `${am ? 'Buenos días' : 'Buenas tardes'}${nm ? `, ${nm}` : ''}. Haz clic en el enlace y confirma quién está contigo en el alojamiento «${x.name}»:\n${url}\n\nSi el enlace no se abre, guarda mi contacto o copia el enlace y pégalo en el navegador.`;
}
/** Pedir a lista ao responsável: cria um link único (7 dias) e abre o WhatsApp com a mensagem escrita. */
async function openCheckin(x) {
  const r = worker(x.responsible_id);
  const box = msgBox();
  const d = dialog(`Pedir lista · ${x.name}`, h('p', { class: 'muted' }, 'A preparar o link…'));
  let c;
  try { c = await api('POST', `/api/houses/${x.id}/checkin`, {}); } catch (e) { d.querySelector('.db').replaceChildren(alert('bad', e.message)); return; }
  const text = h('textarea', { rows: 6, 'aria-label': 'Mensagem' }); text.value = checkinMessage(x, r, c.url);
  const num = waNumber(r.phone, x.delegation);
  const wa = () => `https://wa.me/${num}?text=${encodeURIComponent(text.value)}`;
  const sent = () => api('POST', `/api/checkins/${c.id}/sent`, {}).then(reload).then(() => render()).catch(() => {});
  d.querySelector('.db').replaceChildren(h('div', { class: 'form' },
    h('p', { class: 'help full' }, `Para ${r.name}${r.phone ? ` (${r.phone})` : ''} · ${r.language === 'pt' ? 'português' : 'espanhol'}${r.language ? '' : ' (idioma por definir: espanhol)'}. O link é só deste alojamento e vale 7 dias; a resposta aparece na ficha para aplicar.`),
    num ? null : h('div', { class: 'full' }, alert('warn', 'O responsável não tem telefone válido: copie a mensagem e envie por outro meio, ou acrescente o telefone na ficha do funcionário.')),
    h('label', { class: 'f full' }, 'Mensagem (pode alterar)', text),
    box,
    h('div', { class: 'acts' },
      h('button', { type: 'button', class: 'btn', onclick: async (e) => { try { await navigator.clipboard.writeText(text.value); e.target.textContent = 'Copiada'; sent(); } catch { box.replaceChildren(alert('bad', 'Não foi possível copiar: selecione o texto e copie à mão.')); } } }, 'Copiar mensagem'),
      num ? h('a', { class: 'btn pri', href: wa(), target: '_blank', rel: 'noopener noreferrer', onclick: (e) => { e.currentTarget.href = wa(); sent(); } }, 'Abrir WhatsApp') : h('span'))));
}
/** Alojamentos a quem pedir a lista: ocupados, com responsável; por omissão só os que ainda não têm pedido esta semana. */
function checkinTargets(del, resend = false) {
  return D.houses.filter((x) => x.active && (!del || x.delegation === del) && x.responsible_id && occupantsNow(x.id).length)
    .filter((x) => { const k = checkinState(x).key; return k === 'pedir' || (resend && k === 'enviado'); })
    .sort((a, b) => a.delegation.localeCompare(b.delegation) || a.name.localeCompare(b.name, 'pt', { numeric: true }));
}
/**
 * «Pedir a todos»: fila em sequência. Cria todos os links no início (o WhatsApp tem de abrir logo no clique,
 * senão o navegador bloqueia) e depois: «Abrir WhatsApp e seguinte» → o utilizador carrega em Enviar no WhatsApp → volta e continua.
 */
function openCheckinQueue(del = null) {
  const d = dialog(`Pedir listas aos responsáveis${del ? ` · ${delLabel(del)}` : ''}`, h('div'));
  d.classList.add('wide');
  const body = d.querySelector('.db');
  let resend = false;
  const noResp = D.houses.filter((x) => x.active && (!del || x.delegation === del) && !x.responsible_id && occupantsNow(x.id).length);
  const intro = () => {
    const list = checkinTargets(del, resend);
    const noPhone = list.filter((x) => !waNumber(worker(x.responsible_id)?.phone, x.delegation));
    body.replaceChildren(h('div', { class: 'form' },
      h('p', { class: 'help full' }, `Vai pedir a lista a ${list.length} responsáve${list.length === 1 ? 'l' : 'is'}. Para cada um: carregue em «Abrir WhatsApp e seguinte», envie a mensagem no WhatsApp e volte aqui — a fila avança sozinha. Cada link é só desse alojamento e vale 7 dias.`),
      h('label', { class: 'chk full' }, h('input', { type: 'checkbox', checked: resend, onchange: (e) => { resend = e.target.checked; intro(); } }), 'Incluir também quem já recebeu esta semana e ainda não respondeu (reenviar)'),
      noPhone.length ? h('div', { class: 'full' }, alert('warn', `${noPhone.length} sem telefone válido: ficam no fim, com «Copiar mensagem».`)) : null,
      noResp.length ? h('div', { class: 'full' }, alert('info', `${noResp.length} alojamento${noResp.length === 1 ? '' : 's'} ocupado${noResp.length === 1 ? '' : 's'} sem responsável (não entram): nomeie-o com ★ na ficha.`)) : null,
      list.length ? h('ul', { class: 'qlist full' }, list.map((x) => { const r = worker(x.responsible_id);
        return h('li', h('b', x.name), h('span', { class: 'muted small' }, `${delLabel(x.delegation)} · ${r.name} · ${r.phone || 'sem telefone'} · ${r.language === 'pt' ? 'PT' : 'ES'}`)); }))
        : h('p', { class: 'muted full' }, 'Não há pedidos por fazer esta semana. 🎉'),
      h('div', { class: 'acts' }, h('span'), list.length ? h('button', { class: 'btn pri', onclick: () => start(list) }, `Começar (${list.length})`) : null)));
  };
  const start = async (list) => {
    body.replaceChildren(h('p', { class: 'muted' }, `A preparar ${list.length} links…`));
    let res;
    try { res = await api('POST', '/api/checkins/bulk', { house_ids: list.map((x) => x.id) }); } catch (e) { body.replaceChildren(alert('bad', e.message)); return; }
    const items = res.items.map((it) => { const x = house(it.house_id), r = worker(x?.responsible_id);
      return { ...it, x, r, num: r ? waNumber(r.phone, x.delegation) : null, msg: r && it.url ? checkinMessage(x, r, it.url) : '', state: it.error ? 'erro' : 'pendente' }; });
    items.sort((a, b) => (!a.num) - (!b.num)); // os sem telefone no fim
    let i = 0;
    const markSent = (it) => { it.state = 'enviado'; api('POST', `/api/checkins/${it.id}/sent`, {}).catch(() => {}); };
    const nextIdx = () => items.findIndex((it) => it.state === 'pendente');
    const step = () => {
      i = nextIdx();
      const done = items.filter((it) => it.state === 'enviado').length, total = items.length;
      const bar = h('div', { class: 'bar qbar' }, h('span', { style: `width:${Math.round((items.filter((it) => it.state !== 'pendente').length / total) * 100)}%` }));
      const listEl = h('ul', { class: 'qlist' }, items.map((it, k) => h('li', { class: `q-${it.state}${k === i ? ' cur' : ''}` },
        h('span', { class: 'qs' }, it.state === 'enviado' ? '✓' : it.state === 'saltado' ? '–' : it.state === 'erro' ? '!' : k === i ? '›' : '·'),
        h('b', it.x?.name ?? '?'), h('span', { class: 'muted small' }, it.error ?? `${it.r?.name ?? ''}${it.num ? '' : ' · sem telefone'}`))));
      if (i < 0) {
        body.replaceChildren(h('div', { class: 'form' }, h('div', { class: 'full' }, alert('ok', `Feito: ${done} pedido${done === 1 ? '' : 's'} enviado${done === 1 ? '' : 's'}${items.some((it) => it.state === 'saltado') ? `, ${items.filter((it) => it.state === 'saltado').length} saltado(s)` : ''}. As respostas aparecem no painel em «Listas semanais».`)), h('div', { class: 'full' }, listEl),
          h('div', { class: 'acts' }, h('span'), h('button', { class: 'btn pri', onclick: () => d.close() }, 'Fechar'))));
        return;
      }
      const it = items[i];
      const text = h('textarea', { rows: 5, 'aria-label': 'Mensagem' }); text.value = it.msg;
      const waHref = () => `https://wa.me/${it.num}?text=${encodeURIComponent(text.value)}`;
      body.replaceChildren(h('div', { class: 'qwrap' },
        h('div', { class: 'qmain' },
          h('div', { class: 'qhead' }, h('b', `${i + 1} de ${total}`), h('span', { class: 'muted small' }, `${done} enviado${done === 1 ? '' : 's'}`)), bar,
          h('h3', it.x.name), h('p', { class: 'help' }, `${it.r.name} · ${it.r.phone || 'sem telefone'} · ${it.r.language === 'pt' ? 'português' : 'espanhol'}`),
          h('label', { class: 'f' }, 'Mensagem (pode alterar)', text),
          h('div', { class: 'acts' },
            h('button', { class: 'btn ghost', onclick: () => { it.state = 'saltado'; step(); } }, 'Saltar'),
            h('span', { class: 'inl' },
              h('button', { class: 'btn', onclick: async (e) => { try { await navigator.clipboard.writeText(text.value); e.target.textContent = 'Copiada'; if (!it.num) { markSent(it); setTimeout(step, 400); } } catch { e.target.textContent = 'Copie à mão'; } } }, it.num ? 'Copiar' : 'Copiar e seguinte'),
              it.num ? h('a', { class: 'btn pri', href: waHref(), target: '_blank', rel: 'noopener noreferrer', onclick: (e) => { e.currentTarget.href = waHref(); markSent(it); setTimeout(step, 300); } }, 'Abrir WhatsApp e seguinte') : null))),
        h('div', { class: 'qside' }, listEl)));
    };
    d.addEventListener('close', () => { reload().then(render).catch(() => {}); });
    step();
  };
  intro();
}
/** Resposta do responsável por aplicar: saídas propostas e pessoas novas (só funcionários que já existem entram). */
function checkinReview(x) {
  const cs = checkinState(x);
  if (cs.key !== 'responder' || RO()) return null;
  return reviewCard(x, cs.c);
}
/** Pedidos com resposta por aplicar (no âmbito do utilizador). */
const pendingReviews = () => (D.checkins ?? []).filter((c) => c.status === 'respondido' && house(c.house_id)).sort((a, b) => a.answered_at.localeCompare(b.answered_at));
/** Cartão de revisão de uma resposta do responsável: o funcionário só informa — nada muda até alguém aplicar aqui. */
function reviewCard(x, c, showHouse = false) {
  const ans = JSON.parse(c.answer || '{}');
  const box = msgBox();
  const occ = occupantsNow(x.id);
  // candidatos: todos os funcionários que não estão já neste alojamento (os que estão noutro pedem transferência)
  const freeW = D.workers.filter((w) => currentStay(w.id)?.house_id !== x.id).sort((a, b) => a.name.localeCompare(b.name));
  const listId = `wl-${c.id}`;
  const where = (w) => { const st = currentStay(w.id); return st ? { st, h: house(st.house_id) } : null; };
  const applyBtn = h('button', { class: 'btn pri' }, 'Aplicar decisões');
  const state = { exits: new Map(), entries: new Map() }; // decisão por item
  const refresh = () => {
    const pendingN = [...state.entries.values()].filter((e) => !e.kind || (e.kind === 'assoc' && (!e.worker_id || (e.elsewhere && !e.transfer)))).length;
    applyBtn.disabled = pendingN > 0;
    applyBtn.textContent = pendingN ? `Decida ${pendingN} pessoa${pendingN === 1 ? '' : 's'} nova${pendingN === 1 ? '' : 's'}` : 'Aplicar decisões';
  };
  // saídas informadas: aceitar ou recusar
  const exitRows = (ans.left ?? []).filter((id) => occ.some((st) => st.worker_id === id)).map((id) => {
    state.exits.set(id, true);
    return h('div', { class: 'decide' }, h('span', h('b', workerName(id)), h('span', { class: 'muted small' }, ' · o responsável diz que já não está')),
      (() => { // aceitar ou recusar a saída (botões que mudam de estado sem redesenhar a página)
        const yes = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Dar saída'), no = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Recusar');
        const set = (v) => { state.exits.set(id, v); yes.setAttribute('aria-pressed', String(v)); no.setAttribute('aria-pressed', String(!v)); };
        yes.addEventListener('click', () => set(true)); no.addEventListener('click', () => set(false));
        return h('div', { class: 'seg', role: 'group', 'aria-label': `Saída de ${workerName(id)}` }, yes, no);
      })());
  });
  // pessoas novas: associar a um funcionário, criar, ou recusar (obrigatório)
  const entryRows = (ans.new_names ?? []).map((n) => {
    const k = fold(n).replace(/\s+/g, ' ').trim(), toks = k.split(' ');
    const sugg = freeW.filter((w) => fold(w.name) === k || toks.every((t) => fold(w.name).split(' ').some((p) => p.startsWith(t)))).slice(0, 5);
    const e = { kind: sugg.length === 1 ? 'assoc' : null, worker_id: sugg.length === 1 ? sugg[0].id : null, transfer: false, elsewhere: null };
    if (e.worker_id) e.elsewhere = where(worker(e.worker_id));
    state.entries.set(n, e);
    const search = h('input', { list: listId, placeholder: 'Procurar funcionário…', value: sugg.length === 1 ? sugg[0].name : '', 'aria-label': `Funcionário para «${n}»`,
      oninput: () => { const w = freeW.find((y) => y.name === search.value.trim()); e.worker_id = w?.id ?? null; e.kind = 'assoc'; e.elsewhere = w ? where(w) : null; e.transfer = false; sync(); } });
    const radios = [['assoc', 'Associar a'], ['create', `Criar funcionário «${n.toUpperCase()}»`], ['reject', 'Recusar']].map(([kk, label]) =>
      h('label', { class: 'chk' }, h('input', { type: 'radio', name: `d-${c.id}-${n}`, checked: e.kind === kk, onchange: () => { e.kind = kk; sync(); } }), label));
    const hint = h('span', { class: 'small' });
    const sync = () => {
      search.disabled = e.kind !== 'assoc';
      radios.forEach((r, i) => { r.querySelector('input').checked = e.kind === ['assoc', 'create', 'reject'][i]; });
      hint.replaceChildren(e.kind === 'assoc' ? (!e.worker_id ? h('span', { class: 'warn-t' }, 'escolha um funcionário da lista')
        : e.elsewhere ? h('div', { class: `xfer${e.transfer ? ' ok' : ''}` },
          h('span', e.transfer ? '✓ ' : '', h('b', worker(e.worker_id).name), ` está no alojamento «${e.elsewhere.h?.name ?? '?'}» (desde ${dateLabel(e.elsewhere.st.start_date)}). `,
            e.transfer ? `Será transferido para «${x.name}» hoje.` : `Deseja transferi-lo para «${x.name}»?`),
          e.transfer ? h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { e.transfer = false; sync(); } }, 'Anular')
            : h('span', { class: 'inl' }, h('button', { type: 'button', class: 'btn sm pri', onclick: () => { e.transfer = true; sync(); } }, 'Sim, transferir'),
              h('button', { type: 'button', class: 'btn sm', onclick: () => { e.worker_id = null; e.elsewhere = null; search.value = ''; sync(); search.focus(); } }, 'Não, escolher outro')))
        : h('span', { class: 'ok-t' }, '✓ funcionário escolhido (sem alojamento)')) : e.kind === 'create' ? h('span', { class: 'muted' }, 'fica pendente de completar (telefone, profissão…)') : e.kind === 'reject' ? h('span', { class: 'muted' }, 'não entra; fica registado como recusado') : h('span', { class: 'warn-t' }, 'por decidir'));
      refresh();
    };
    const row = h('div', { class: 'decide newp' },
      h('div', h('b', `«${n}»`), h('span', { class: 'muted small' }, ' · pessoa nova indicada pelo responsável'), sugg.length > 1 ? h('span', { class: 'muted small' }, ` · parecidos: ${sugg.map((w) => w.name).join(', ')}`) : null),
      h('div', { class: 'opts' }, h('span', { class: 'inl' }, radios[0], search), radios[1], radios[2]), hint);
    sync();
    return row;
  });
  refresh();
  applyBtn.addEventListener('click', () => {
    const exits = [...state.exits].filter(([, v]) => v).map(([k]) => k);
    const entries = [...state.entries].map(([name, e]) => (e.kind === 'assoc' ? { name, worker_id: e.worker_id, transfer: !!e.transfer } : e.kind === 'create' ? { name, create: true } : { name, reject: true }));
    // segunda confirmação para as transferências
    const xfers = [...state.entries.values()].filter((e) => e.kind === 'assoc' && e.transfer && e.elsewhere);
    if (xfers.length && !confirm(`Confirma ${xfers.length === 1 ? 'a transferência' : 'as transferências'}?\n\n${xfers.map((e) => `• ${worker(e.worker_id).name} será transferido de «${e.elsewhere.h?.name}» para «${x.name}» hoje (${dateLabel(today())}).`).join('\n')}`)) return;
    act(() => api('POST', `/api/checkins/${c.id}/apply`, { exits, entries }), (r) => `Decidido: ${r.exits} saída(s), ${r.entries} entrada(s)${r.rejected ? `, ${r.rejected} recusado(s)` : ''}.`, box);
  });
  const r = x.responsible_id ? worker(x.responsible_id) : null;
  return h('section', { class: 'panel review' },
    h('h2', showHouse ? [houseLink(x), h('span', { class: 'muted small' }, ` · ${delLabel(x.delegation)}`)] : `Lista enviada pelo responsável · ${dateLabel(c.answered_at.slice(0, 10))}`),
    showHouse ? h('p', { class: 'muted small' }, `Informado por ${r?.name ?? 'responsável'} a ${dateLabel(c.answered_at.slice(0, 10))} às ${c.answered_at.slice(11, 16)} (UTC)`) : null,
    h('p', { class: 'help' }, `${(ans.present ?? []).length} confirmados${(ans.left ?? []).length ? `, ${ans.left.length} já não estão` : ''}${(ans.new_names ?? []).length ? `, ${ans.new_names.length} novos` : ''}.${ans.note ? ` Comentário: «${ans.note}»` : ''} O responsável só informa: nada muda até decidir aqui.`),
    exitRows.length || entryRows.length ? h('div', { class: 'reviewlist' }, exitRows, entryRows) : h('p', { class: 'muted' }, 'Sem alterações: a lista está igual.'),
    h('datalist', { id: listId }, freeW.map((w) => { const at = where(w); return h('option', { value: w.name, label: at ? `está em ${at.h?.name ?? '?'}` : 'sem alojamento' }); })),
    box,
    h('div', { class: 'acts' },
      h('button', { class: 'btn', onclick: () => confirm('Recusar esta lista inteira? Nada muda e fica registado como recusado.') && act(() => api('POST', `/api/checkins/${c.id}/apply`, { archive: true }), 'Lista recusada (registada no histórico).', box) }, 'Recusar tudo'),
      exitRows.length || entryRows.length ? applyBtn : h('button', { class: 'btn pri', onclick: () => act(() => api('POST', `/api/checkins/${c.id}/apply`, { exits: [], entries: [] }), 'Lista confirmada sem alterações.', box) }, 'Confirmar (sem alterações)')));
}
function tabCosts(x) {
  const months = Array.from({ length: 7 }, (_, i) => addMonths(thisMonth(), 1 - i));
  const rows = months.map((m) => { const mc = monthCost(x, m);
    return h('tr', { class: m === thisMonth() ? 'cur' : '' }, td(monthLabel(m)), td(eur(mc?.rent), true),
      td(mc ? [eur(mc.expenses), ' ', h('span', { class: 'muted small' }, mc.adjusted ? 'real' : 'fixo')] : '—', true), td(eur(mc?.total), true),
      h('td', { class: 'acts' }, mc?.adjusted && !RO() ? h('button', { class: 'btn sm dng', title: mc.adj.note || '', onclick: () => confirm(`Apagar o valor real de ${monthLabel(m)}? Volta ao valor fixo.`) && act(() => api('DELETE', `/api/adjustments/${mc.adj.id}`), 'Valor real apagado.') }, 'Repor fixo') : null)); });
  const box = h('div');
  const f = h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); act(() => api('PUT', '/api/adjustments', { house_id: x.id, ...Object.fromEntries(new FormData(f)) }), 'Despesas do mês guardadas.', box); } },
    field('Mês', h('input', { name: 'month', type: 'month', value: thisMonth(), required: true })),
    field('Despesas reais (€)', h('input', { name: 'value', inputmode: 'decimal', required: true })),
    field('Nota', h('input', { name: 'note', maxlength: 120, placeholder: 'ex.: luz mais alta' })),
    box, h('div', { class: 'acts' }, h('span'), h('button', { class: 'btn', type: 'submit' }, 'Guardar')));
  return h('div', { class: 'cols' },
    h('section', { class: 'panel' }, h('h2', 'Custos por mês'), h('p', { class: 'help' }, 'Aluguer + despesas. As despesas são o valor fixo, a não ser que lance o valor real do mês.'),
      table(['Mês', { t: 'Aluguer', n: true }, { t: 'Despesas', n: true }, { t: 'Total', n: true }, ''], rows)),
    RO() ? null : h('section', { class: 'panel' }, h('h2', 'Mês diferente do habitual?'), h('p', { class: 'help' }, `Despesas fixas: ${eur(x.fixed_expenses)}. Lance o valor real e substitui o fixo só nesse mês.`), f));
}
/** Mini-mapa da casa (sempre visível) com «Editar localização». Mudar um pino existente pede o código ao coordenador. */
function locationBlock(x) {
  const el = h('div', { class: 'map mini' });
  const info = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const acts = h('div', { class: 'acts' });
  const msg = h('div');
  const SRC = { manual: 'colocado à mão', link: 'do link do Google Maps', auto: 'encontrado pela morada' };
  const setInfo = () => { info.textContent = x.lat != null ? `Pino ${SRC[x.geo_source] ?? ''}.${x.geo_review ? ' Por confirmar: verifique se está no sítio certo.' : ''}` : geoFailed.get(x.id) ?? 'Sem localização definida.'; };
  let m = null, marker = null, editing = false, draft = null;
  const place = (ll) => { if (marker) marker.setLatLng(ll); else marker = L.marker(ll, { icon: pinIcon(x), title: x.name }).addTo(m); };
  const view = () => {
    editing = false; draft = null; msg.replaceChildren(); setInfo();
    if (marker) { marker.dragging?.disable(); if (x.lat != null) marker.setLatLng([x.lat, x.lng]); else { marker.remove(); marker = null; } }
    if (RO()) { acts.replaceChildren(); return; }
    acts.replaceChildren(
      x.lat != null && x.geo_review ? h('button', { class: 'btn sm pri', title: 'O pino está no sítio certo (não pede código)', onclick: () => act(() => api('PUT', `/api/houses/${x.id}/position`, { lat: x.lat, lng: x.lng }), 'Localização confirmada.', msg) }, 'Confirmar localização') : null,
      h('button', { class: 'btn sm', onclick: edit }, icon('pin'), x.lat != null ? 'Editar localização' : 'Definir localização'));
  };
  const edit = () => {
    editing = true;
    const hadPin = x.lat != null, needCode = hadPin && !isGestor();
    info.textContent = 'Arraste o pino ou clique no mapa no sítio certo.';
    if (marker) { marker.dragging.enable(); marker.on('dragend', () => { draft = marker.getLatLng(); }); }
    const code = needCode ? h('input', { type: 'password', autocomplete: 'off', placeholder: 'Código do gestor', 'aria-label': 'Código de autorização do gestor', class: 'code-in' }) : null;
    acts.replaceChildren(
      x.address ? h('button', { class: 'btn sm', onclick: async (e) => {
        e.target.disabled = true; info.textContent = 'A procurar a morada…';
        try { const g = await api('POST', `/api/houses/${x.id}/geocode?preview=1`); draft = { lat: g.lat, lng: g.lng }; place(draft); marker.dragging.enable(); m.setView(draft, 16); info.textContent = 'Encontrada. Confirme e guarde.'; }
        catch (err) { info.textContent = err.message; }
        e.target.disabled = false;
      } }, icon('search'), 'Procurar pela morada') : null,
      needCode ? h('span', { class: 'inl' }, icon('lock'), code) : null,
      h('button', { class: 'btn sm ghost', onclick: view }, 'Cancelar'),
      h('button', { class: 'btn sm pri', onclick: async () => {
        const ll = marker ? marker.getLatLng() : draft; // posição atual do pino (clique, procura ou arrasto)
        if (!ll) { msg.replaceChildren(alert('bad', 'Clique no mapa para colocar o pino.')); return; }
        if (needCode && !code.value) { msg.replaceChildren(alert('bad', 'Para mudar a localização escreva o código de autorização do gestor.')); return; }
        await act(() => api('PUT', `/api/houses/${x.id}/position`, { lat: +(+ll.lat).toFixed(6), lng: +(+ll.lng).toFixed(6), auth_code: code?.value ?? '' }), 'Localização guardada.', msg);
      } }, 'Guardar localização'));
  };
  mounts.push(() => {
    if (!window.L) { el.replaceChildren(alert('bad', 'Não foi possível carregar o mapa.')); return; }
    m = makeMap(el, x.lat != null ? [x.lat, x.lng] : DEL_CENTER[x.delegation], x.lat != null ? 16 : 9);
    if (x.lat != null) place([x.lat, x.lng]);
    m.on('click', (e) => { if (!editing) return; draft = e.latlng; place(e.latlng); marker.dragging.enable(); });
    view();
    if (x.lat == null && x.address && !x.geo_source && !geoFailed.has(x.id)) {
      info.textContent = 'A procurar a morada no mapa…';
      geocodeMissing([x], (y) => { place([y.lat, y.lng]); m.setView([y.lat, y.lng], 16); view(); }, () => {}, () => maps.includes(m)).then(() => { if (!editing) view(); });
    }
  });
  return h('section', { class: 'panel loc' }, el, h('div', { class: 'locbar' }, h('span', icon('pin'), ' ', x.address || 'Sem morada'), info, acts), msg);
}
function roomsPanel(x) {
  const rooms = roomsOf(x.id);
  const needCode = !isGestor();
  const box = msgBox();
  const code = () => box.parentElement?.querySelector('[name=room_code]')?.value ?? '';
  const send = async (fn, ok) => { if (needCode && !code()) { box.replaceChildren(alert('bad', 'Alterar quartos muda a lotação: escreva o código de autorização do gestor.')); return; } await act(fn, ok, box); };
  const one = h('form', { class: 'inl wrap', onsubmit: (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(one)); send(() => api('PUT', '/api/rooms', { house_id: x.id, name: b.name, beds: Number(b.beds), auth_code: code() }), `Quarto «${b.name}» criado.`); } },
    h('input', { name: 'name', required: true, maxlength: 60, placeholder: 'Nome (ex.: Habitación 1)', 'aria-label': 'Nome do quarto' }),
    h('input', { name: 'beds', type: 'number', min: 0, max: 50, required: true, value: 2, class: 'num-in', 'aria-label': 'Camas' }), h('span', { class: 'muted small' }, 'camas'),
    h('button', { class: 'btn sm', type: 'submit' }, icon('plus'), 'Quarto'));
  const many = h('form', { class: 'inl wrap', onsubmit: (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(many)); send(() => api('POST', '/api/rooms/bulk', { house_id: x.id, prefix: b.prefix, from: Number(b.from), to: Number(b.to), beds: Number(b.beds), auth_code: code() }), (r) => `${r.created} quartos criados.`); } },
    h('input', { name: 'prefix', value: 'Habitación', maxlength: 40, 'aria-label': 'Prefixo' }),
    h('input', { name: 'from', type: 'number', min: 0, value: 1, class: 'num-in', 'aria-label': 'Do número' }), h('span', { class: 'muted small' }, 'a'),
    h('input', { name: 'to', type: 'number', min: 0, value: 10, class: 'num-in', 'aria-label': 'Até ao número' }),
    h('input', { name: 'beds', type: 'number', min: 0, max: 50, value: 2, class: 'num-in', 'aria-label': 'Camas por quarto' }), h('span', { class: 'muted small' }, 'camas cada'),
    h('button', { class: 'btn sm', type: 'submit' }, 'Criar vários'));
  return h('section', { class: 'panel' }, h('h2', `Quartos${rooms.length ? ` · ${rooms.length} · ${rooms.reduce((a, r) => a + r.beds, 0)} camas` : ''}`),
    h('p', { class: 'help' }, rooms.length ? 'A lotação do alojamento é a soma das camas dos quartos.' : 'Sem quartos: a lotação é a do formulário. Com quartos, passa a ser a soma das camas e cada ocupante pode ficar num quarto.'),
    rooms.length ? table(['Quarto', { t: 'Camas', n: true }, { t: 'Ocupadas', n: true }, ''], rooms.map((r) => h('tr',
      h('td', h('b', r.name)), td(String(r.beds), true), td(String(roomUsed(r.id)), true),
      h('td', { class: 'acts' }, W(h('span', { class: 'inl' },
        h('button', { class: 'btn sm', onclick: () => { const v = prompt(`Camas de «${r.name}»:`, r.beds); if (v !== null) send(() => api('PUT', '/api/rooms', { id: r.id, house_id: x.id, name: r.name, beds: Number(v), auth_code: code() }), 'Quarto alterado.'); } }, 'Camas'),
        h('button', { class: 'btn sm dng', onclick: () => confirm(`Apagar «${r.name}»?`) && send(() => api('POST', `/api/rooms/${r.id}/delete`, { auth_code: code() }), 'Quarto apagado.') }, 'Apagar'))))))) : null,
    W(h('div', { class: 'roomforms' }, one, many,
      needCode ? h('label', { class: 'inl' }, icon('lock'), h('input', { name: 'room_code', type: 'password', autocomplete: 'off', placeholder: 'Código do gestor', class: 'code-in', 'aria-label': 'Código de autorização do gestor' })) : null,
      box)));
}
function tabData(x) {
  const c = contractInfo(x);
  return h('div', tabDataMain(x, c), roomsPanel(x));
}
function tabDataMain(x, c) {
  return h('section', { class: 'panel' }, h('h2', 'Dados do alojamento'),
    h('dl', { class: 'facts' },
      h('dt', 'Morada'), h('dd', x.address || '—'),
      h('dt', 'Região'), h('dd', x.region || '—'),
      h('dt', 'Proprietário'), h('dd', x.owner_name || '—'),
      h('dt', 'Contrato'), h('dd', { class: c.level ? `${c.level}-t` : '' }, x.contract_start ? `${dateLabel(x.contract_start)} → ` : '', c.text),
      h('dt', 'Caução'), h('dd', depositInfo(x)),
      x.code ? [h('dt', 'Código'), h('dd', x.code)] : null,
      x.building ? [h('dt', 'Edifício'), h('dd', x.building, ...floorsOf(x).filter((y) => y.id !== x.id).flatMap((y, i) => [i ? ', ' : ' · outros andares: ', h('a', { href: `#/casa/${y.id}` }, y.name)]))] : null,
      h('dt', 'Aluguer'), h('dd', eur(x.rent), x.rent_due_day ? h('span', { class: 'muted' }, ` · vence a dia ${x.rent_due_day}`) : null), h('dt', 'Despesas fixas'), h('dd', eur(x.fixed_expenses)),
      h('dt', 'Lotação'), h('dd', `${x.capacity ?? '—'} camas${x.rooms != null ? ` · ${x.rooms} quartos` : ''}${roomsOf(x.id).length ? ' (soma dos quartos)' : ''}`),
      x.notes ? [h('dt', 'Notas'), h('dd', x.notes)] : null),
    W(h('div', { class: 'sp' }, h('button', { class: 'btn', onclick: () => openHouseForm(x) }, icon(isGestor() ? 'edit' : 'lock'), 'Editar dados'))));
}
function tabHistory(x) {
  const history = D.stays.filter((st) => st.house_id === x.id);
  const box = h('div', h('p', { class: 'muted' }, 'A carregar…'));
  if (!RO()) mounts.push(async () => box.replaceChildren(await auditTable({ house: x.id })));
  return h('div',
    h('section', { class: 'panel' }, h('h2', 'Entradas e saídas'),
      history.length ? table(['Funcionário', 'Entrada', 'Motivo', 'Saída', 'Motivo', ''], history.map((st) => h('tr', { class: isCurrent(st) ? '' : 'off' },
        td(workerName(st.worker_id)), td(dateLabel(st.start_date)), td(st.entry_reason), td(dateLabel(st.end_date)), td(st.exit_reason || '—'),
        h('td', { class: 'acts' }, W(h('button', { class: 'btn sm ghost', onclick: () => openStayEdit(st) }, 'Corrigir')))))) : h('p', { class: 'muted' }, 'Sem registos.')),
    RO() ? null : h('section', { class: 'panel' }, h('h2', 'Edições'), box));
}

// ---------- correções informadas pelos responsáveis ----------
function viewCorrections() {
  if (RO()) return alert('bad', 'O seu perfil (administrativo) só permite visualizar.');
  const pend = pendingReviews();
  const done = (D.checkins ?? []).filter((c) => ['aplicado', 'arquivado'].includes(c.status) && c.applied_at && house(c.house_id)).sort((a, b) => b.applied_at.localeCompare(a.applied_at)).slice(0, 40);
  return h('div',
    h('div', { class: 'head' }, h('div', h('h1', 'Correções'), h('div', { class: 'sub' }, 'O que os responsáveis informaram (quem entrou e quem saiu). Nada muda até alguém aplicar aqui.'))),
    pend.length ? pend.map((c) => reviewCard(house(c.house_id), c, true))
      : h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'Não há correções por aplicar. Quando um responsável enviar a lista, aparece aqui.')),
    done.length ? h('details', { class: 'panel fold' }, h('summary', h('span', 'Tratadas recentemente ', chip('', String(done.length)))),
      table(['Alojamento', 'Resposta', 'Tratada', 'Por', 'Resultado'], done.map((c) => { const a = JSON.parse(c.answer || '{}');
        return h('tr', h('td', houseLink(house(c.house_id))), td(c.answered_at ? dateLabel(c.answered_at.slice(0, 10)) : '—'), td(dateLabel(c.applied_at.slice(0, 10))), td(c.applied_by || '—'),
          h('td', (() => { const dd = c.decision ? JSON.parse(c.decision) : null;
            if (!dd) return c.status === 'arquivado' ? 'Arquivada sem alterações' : `${(a.left ?? []).length} saída(s) / ${(a.new_names ?? []).length} novo(s) informados`;
            const L = (t, l, cls) => (l.length ? h('div', { class: `small ${cls}` }, `${t}: ${l.join(', ')}`) : null);
            return [L('Saídas aceites', dd.exits, ''), L('Entradas aceites', dd.entries, ''), L('Saídas recusadas', dd.exits_rejected, 'bad-t'), L('Novos recusados', dd.entries_rejected.map((n) => `«${n}»`), 'bad-t'),
              !dd.exits.length && !dd.entries.length && !dd.exits_rejected.length && !dd.entries_rejected.length ? 'Sem alterações' : null]; })())); }))) : null);
}

// ---------- funcionários ----------
function viewWorkers() {
  // filtros: delegação ('' todas · 'pendente' · chave), profissão, só sem alojamento
  const profs = [...new Set(D.workers.map((w) => w.profession).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt'));
  if (mem.wprof && !profs.includes(mem.wprof)) mem.wprof = '';
  const dels = [...new Set(D.workers.map((w) => w.delegation ?? 'pendente'))];
  if (mem.wdel && !dels.includes(mem.wdel)) mem.wdel = '';
  const HF = { sem: (w) => ['sem', 'rever'].includes(housingOf(w)), rever: (w) => housingOf(w) === 'rever', proprio: (w) => housingOf(w) === 'proprio' };
  if (mem.wfree === true) mem.wfree = 'sem';
  const list = D.workers.filter((w) => (!mem.wfree || HF[mem.wfree]?.(w) !== false)
    && (!mem.wdel || (mem.wdel === 'pendente' ? w.delegation == null : w.delegation === mem.wdel))
    && (!mem.wprof || w.profession === mem.wprof));
  const tbody = list.map((w) => { const st = currentStay(w.id), x = st && house(st.house_id);
    return h('tr', { class: 'link', 'data-q': `${w.name} ${w.company} ${w.profession} ${w.phone}`.toLowerCase(), onclick: (e) => { if (e.target.closest('a') || RO()) return; openWorker(w); } },
      h('td', h('div', { class: 'person', style: 'padding:0;border:0' }, h('div', { class: 'avatar' }, initials(w.name)), h('b', w.name))),
      td(w.profession || '—'), h('td', telLink(w.phone) ?? '—'),
      h('td', w.delegation == null ? h('span', { class: 'chip warn' }, 'Pendente') : delLabel(w.delegation)),
      h('td', x ? houseLink(x) : w.own_housing ? h('span', { class: 'chip s-ok' }, 'Alojamento próprio') : w.delegation == null ? h('span', { class: 'chip warn' }, 'Por rever') : h('span', { class: 'chip' }, 'sem alojamento')), td(st ? dateLabel(st.start_date) : '—')); });
  const content = h('div', list.length ? table(['Nome', 'Profissão', 'Telefone', 'Delegação', 'Alojamento atual', 'Desde'], tbody) : h('p', { class: 'muted' }, 'Nenhum funcionário com estes filtros.'));
  const count = h('span', { class: 'muted small', 'aria-live': 'polite' });
  const applySearch = () => {
    const q = (mem.wq ?? '').trim().toLowerCase(); let n = 0;
    content.querySelectorAll('[data-q]').forEach((el) => { el.hidden = !!q && !el.dataset.q.includes(q); if (!el.hidden) n++; });
    count.textContent = `${n} de ${D.workers.length}`;
  };
  mounts.push(applySearch);
  const sel = (key, opts, label) => h('select', { 'aria-label': label, onchange: (e) => { mem[key] = e.target.value; remember(); render(); } }, opts.map(([v, l]) => h('option', { value: v, selected: (mem[key] ?? '') === v }, l)));
  const pend = D.workers.filter((w) => w.delegation == null).length;
  return h('div',
    h('div', { class: 'head' }, h('div', h('h1', 'Funcionários'), h('div', { class: 'sub' }, `${D.workers.length} registados · ${D.workers.filter((w) => housingOf(w) === 'alojado').length} alojados · ${D.workers.filter((w) => housingOf(w) === 'proprio').length} com alojamento próprio · ${D.workers.filter((w) => ['sem', 'rever'].includes(housingOf(w))).length} sem alojamento${pend ? ` · ${pend} pendentes` : ''}`)),
      W(h('button', { class: 'btn pri', onclick: () => openWorker(null) }, icon('plus'), 'Novo funcionário'))),
    h('div', { class: 'toolbar' },
      h('div', { class: 'grow' }, icon('search'), h('input', { type: 'search', value: mem.wq ?? '', placeholder: 'Procurar nome, profissão ou telefone', 'aria-label': 'Procurar', oninput: (e) => { mem.wq = e.target.value; remember(); applySearch(); } })),
      sel('wdel', [['', 'Todas as delegações'], ...D.delegations.filter(([k]) => dels.includes(k)).map(([k, l]) => [k, l]), ...(dels.includes('pendente') ? [['pendente', 'Pendentes (sem delegação)']] : [])], 'Delegação'),
      profs.length ? sel('wprof', [['', 'Todas as profissões'], ...profs.map((p) => [p, p])], 'Profissão') : null,
      seg([['', 'Todos'], ['sem', 'Sem alojamento'], ['proprio', 'Alojamento próprio'], ['rever', `Por rever (${toReview().length})`]], mem.wfree || '', (v) => { mem.wfree = v; remember(); render(); }), count),
    mem.wfree === 'rever' ? null : reviewAlert(),
    content);
}

// ---------- Excel: importar e exportar ----------
const ACTION = { create: ['ok', 'Nova'], fill: ['s-unknown', 'Preenche vazios'], same: ['', 'Sem alterações'], error: ['bad', 'Erro'], doubt: ['warn', 'Possível duplicado'] };
/** Importar Excel para UMA delegação (janela aberta a partir das ações da delegação). */
function openExcelImport(del) {
  const d = dialog(`Importar Excel · ${delLabel(del)}`, h('div'));
  d.classList.add('wide');
  const out = h('div');
  let file = null, fileName = '';
  const fileIn = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'aria-label': 'Ficheiro Excel', onchange: async (e) => {
    const f0 = e.target.files[0]; if (!f0) return;
    if (!/\.xlsx$/i.test(f0.name)) { out.replaceChildren(alert('bad', 'Escolha um ficheiro .xlsx (Excel). Descarregue o modelo e use-o como base.')); return; }
    if (f0.size > 3.5 * 1024 * 1024) { out.replaceChildren(alert('bad', 'Ficheiro demasiado grande (máx. 3,5 MB).')); return; }
    fileName = f0.name;
    file = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f0); });
    await preview();
  } });
  const preview = async () => {
    out.replaceChildren(h('p', { class: 'muted' }, 'A verificar o ficheiro…'));
    let P;
    try { P = await api('POST', '/api/excel/previsualizar', { file, delegation: del }); }
    catch (err) { if (err.status === 401) { user = null; render(); return; } out.replaceChildren(alert('bad', err.message)); return; }
    out.replaceChildren(previewView(P));
  };
  const sheetBlock = (title, rows, counts, missing) => {
    if (missing) return h('section', { class: 'panel' }, h('h2', title), h('p', { class: 'muted' }, 'Folha não incluída no ficheiro.'));
    const shown = rows.filter((r) => r.action !== 'same');
    return h('section', { class: 'panel' },
      h('div', { class: 'head' }, h('h2', `${title} · ${rows.length} linhas`),
        h('div', { class: 'inl' }, ...Object.entries(counts).filter(([, n]) => n).map(([k, n]) => chip(ACTION[k][0], `${n} ${ACTION[k][1].toLowerCase()}`)))),
      shown.length ? table(['Linha', 'Nome', 'Resultado', 'Detalhes'], shown.map((r) => h('tr', { class: r.action === 'error' ? 'err' : '' },
        td(String(r.line), true), h('td', h('b', r.name || '—')), h('td', chip(ACTION[r.action][0], ACTION[r.action][1])),
        h('td', h('ul', { class: 'issues' },
          ...r.errors.map((t) => h('li', { class: 'bad-t' }, t)),
          ...(r.fillText ?? []).map((t) => h('li', `Preenche ${t}`)),
          ...r.warnings.map((t) => h('li', { class: 'warn-t' }, t)),
          r.action === 'create' ? h('li', { class: 'muted' }, 'Será criado.') : null)))))
        : h('p', { class: 'muted' }, rows.length ? 'Todas as linhas já estão iguais na aplicação.' : 'Sem linhas.'));
  };
  const previewView = (P) => {
    if (P.fatal.length) return h('div', alert('bad', h('div', h('b', 'O ficheiro não está no formato do modelo:'), h('ul', P.fatal.map((t) => h('li', t))))),
      h('p', { class: 'help' }, 'Descarregue o modelo (ou exporte os dados) e use-o como base, sem mudar os nomes das folhas nem das colunas.'));
    const ok = P.counts.houses.create + P.counts.houses.fill + P.counts.workers.create + P.counts.workers.fill;
    const bad = P.counts.houses.error + P.counts.workers.error + P.counts.workers.doubt;
    const code = P.needAuth ? h('input', { type: 'password', autocomplete: 'off', placeholder: 'Código do gestor', 'aria-label': 'Código de autorização do gestor', class: 'code-in' }) : null;
    const res = h('div');
    return h('div',
      h('p', { class: 'help' }, `Ficheiro: ${fileName}. Nada foi gravado ainda.`),
      P.warnings.length ? alert('warn', h('div', h('b', 'Avisos sobre o formato:'), h('ul', P.warnings.map((t) => h('li', t))))) : null,
      sheetBlock('Alojamentos', P.houses, P.counts.houses, P.missing.houses),
      sheetBlock('Funcionários', P.workers, P.counts.workers, P.missing.workers),
      h('section', { class: 'panel' },
        bad ? alert('warn', `${bad} linha${bad === 1 ? '' : 's'} com erro ou possível duplicado fica${bad === 1 ? '' : 'm'} de fora. Corrija no Excel e volte a importar.`) : null,
        P.needAuth ? h('p', { class: 'help' }, icon('lock'), ' Preencher alojamentos que já existem pede o código de autorização do gestor: ', code) : null,
        h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: preview }, 'Verificar de novo'),
          h('button', { class: 'btn pri', disabled: !ok, onclick: async (e) => {
            if (P.needAuth && !code.value) { res.replaceChildren(alert('bad', 'Escreva o código de autorização do gestor.')); return; }
            e.target.disabled = true;
            try {
              const r = await api('POST', '/api/excel/importar', { file, delegation: del, auth_code: code?.value ?? '' });
              await reload();
              flash = { kind: 'ok', text: `Importado: ${r.done.houses.create} alojamentos novos, ${r.done.houses.fill} alojamentos completados, ${r.done.workers.create} funcionários novos, ${r.done.workers.fill} completados.${r.skipped.houses + r.skipped.workers ? ` ${r.skipped.houses + r.skipped.workers} linhas ficaram de fora.` : ''}`, at: Date.now() };
              file = null; d.close(); render();
            } catch (err) { e.target.disabled = false; if (err.status === 401) { user = null; render(); return; } res.replaceChildren(alert('bad', err.message)); }
          } }, ok ? `Importar ${ok} linha${ok === 1 ? '' : 's'}` : 'Nada para importar')), res));
  };
  d.querySelector('.db').replaceChildren(h('div',
    h('p', { class: 'help' }, `Ficheiro só com dados de ${delLabel(del)}: linhas de outra delegação dão erro; delegação em branco = ${delLabel(del)}. Primeiro aparece uma pré-visualização com os erros e avisos por linha; só grava quando carregar em «Importar». O que já existe: só se preenchem campos vazios.`),
    h('div', { class: 'acts' }, h('a', { class: 'btn sm', href: `/api/excel/exportar?delegacao=${del}`, download: '' }, 'Descarregar os dados atuais (para completar)'), h('a', { class: 'btn sm ghost', href: '/api/excel/modelo', download: '' }, 'Modelo vazio')),
    h('p', fileIn), out));
}

// ---------- histórico de edições ----------
async function auditTable(params = {}) {
  try {
    const rows = await api('GET', `/api/audit?${new URLSearchParams(params)}`);
    if (!rows.length) return h('p', { class: 'muted' }, 'Sem registos.');
    return table(['Quando', 'Quem', 'O quê', ''], rows.map((r) => {
      const ch = r.changes ? JSON.parse(r.changes) : null;
      const detail = ch && r.action === 'update' ? h('details', h('summary', { class: 'small' }, 'alterações'), h('ul', { class: 'small' }, Object.entries(ch).map(([k, [a, b]]) => h('li', `${k}: ${a ?? '—'} → ${b ?? '—'}`)))) : null;
      return h('tr', td(new Date(r.at).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' })), td(r.user_name), h('td', { class: 'wrap' }, r.summary), h('td', detail));
    }));
  } catch (e) { return alert('bad', e.message); }
}
function viewAudit() {
  const box = h('div', h('p', { class: 'muted' }, 'A carregar…'));
  mounts.push(async () => box.replaceChildren(await auditTable()));
  return h('div', h('div', { class: 'head' }, h('div', h('h1', 'Histórico'), h('div', { class: 'sub' }, 'Todas as alterações: quem fez, quando e o que mudou (últimas 300).'))), box);
}

// ---------- definições (gestor) ----------
function viewSettings() {
  if (!isGestor()) return alert('bad', 'Só o gestor tem acesso às definições.');
  const box = h('div');
  const f = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault(); const b = Object.fromEntries(new FormData(f));
    if (b.code !== b.code2) { box.replaceChildren(alert('bad', 'Os dois códigos não são iguais.')); return; }
    if (await act(() => api('PUT', '/api/settings/auth-code', { code: b.code }), 'Código de autorização alterado.', box)) f.reset();
  } },
  field('Novo código', h('input', { name: 'code', type: 'password', autocomplete: 'new-password', minlength: 6, required: true }), 'Pelo menos 6 caracteres.'),
  field('Repetir o novo código', h('input', { name: 'code2', type: 'password', autocomplete: 'new-password', minlength: 6, required: true })),
  box, h('div', { class: 'acts' }, h('span'), h('button', { class: 'btn pri', type: 'submit' }, 'Guardar código')));
  return h('div', h('div', { class: 'head' }, h('div', h('h1', 'Definições'))),
    h('section', { class: 'panel' }, h('h2', h('span', icon('lock'), ' Código de autorização do gestor')),
      D.authCodeSet ? null : alert('warn', 'Ainda não há código definido: os coordenadores não conseguem editar alojamentos, mudar pinos nem corrigir registos até o definir.'),
      h('p', { class: 'help' }, 'Os coordenadores escrevem este código para editar um alojamento já criado (valores, inativar, apagar), mudar a localização ou corrigir/apagar registos de entradas e saídas. Criar alojamentos, dar entradas, saídas e transferências e lançar despesas do mês não pede código. O gestor nunca precisa dele.'),
      f));
}

// ---------- palavra-passe nova (obrigatória depois de uma temporária) ----------
function viewNewPassword() {
  const msg = h('div', { class: 'msg' });
  const f = h('form', { class: 'panel login', onsubmit: async (e) => {
    e.preventDefault(); const b = Object.fromEntries(new FormData(f));
    if (b.password !== b.password2) { msg.replaceChildren(alert('bad', 'As duas palavras-passe novas não são iguais.')); return; }
    try {
      await api('POST', '/api/auth/password', { current: b.current, password: b.password });
      user.mustChange = false; await reload();
      flash = { kind: 'ok', text: 'Palavra-passe guardada. Bem-vindo(a)!', at: Date.now() };
      location.hash = '#/'; render();
    } catch (err) { msg.replaceChildren(alert('bad', err.message)); }
  } },
  h('h1', 'Escolha a sua palavra-passe'),
  h('p', { class: 'help' }, `Olá, ${user.name}. Entrou com uma palavra-passe temporária: escolha agora a sua (pelo menos 10 caracteres).`),
  field('Palavra-passe temporária', h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
  field('Nova palavra-passe', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: 10, required: true })),
  field('Repetir a nova palavra-passe', h('input', { name: 'password2', type: 'password', autocomplete: 'new-password', minlength: 10, required: true })),
  msg,
  h('div', { class: 'acts' }, h('button', { type: 'button', class: 'btn ghost', onclick: async () => { await api('POST', '/api/auth/logout', {}).catch(() => {}); user = null; session.csrf = null; render(); } }, 'Sair'), h('button', { class: 'btn pri', type: 'submit' }, 'Guardar')));
  return f;
}

// ---------- utilizadores (gestor) ----------
function viewUsers() {
  if (!isGestor()) return alert('bad', 'Só o gestor gere os utilizadores.');
  const box = h('div', h('p', { class: 'muted' }, 'A carregar…'));
  const load = async () => {
    let list;
    try { list = await api('GET', '/api/users'); } catch (e) { box.replaceChildren(alert('bad', e.message)); return; }
    box.replaceChildren(table(['Nome', 'Email', 'Perfil', 'Estado', ''], list.map((x) => h('tr', { class: x.active ? '' : 'off' },
      h('td', h('b', x.name)), td(x.email), td(roleText(x)),
      h('td', x.active ? (x.must_change ? chip('warn', 'Por ativar (palavra-passe temporária)') : chip('s-ok', 'Ativo')) : chip('', 'Desativado')),
      h('td', { class: 'acts' }, h('button', { class: 'btn sm', onclick: () => openUser(x, load) }, icon('edit'), 'Editar'))))));
  };
  mounts.push(load);
  return h('div',
    h('div', { class: 'head' }, h('div', h('h1', 'Utilizadores'), h('div', { class: 'sub' }, 'Quem entra na aplicação e o que pode fazer')),
      h('button', { class: 'btn pri', onclick: () => openUser(null, load) }, icon('plus'), 'Novo utilizador')),
    h('section', { class: 'panel' }, h('dl', { class: 'facts' },
      h('dt', 'Gestor'), h('dd', 'Tudo, em todas as delegações. Gere os utilizadores e o código de autorização.'),
      h('dt', 'Coordenador'), h('dd', 'Vê e altera só a sua delegação (alterar alojamentos já criados pede o código do gestor).'),
      h('dt', 'Administrativo'), h('dd', 'Só vê: todas as delegações ou uma. Pode exportar Excel e ver telefones; não vê o histórico de edições.'))),
    h('section', { class: 'panel' }, box));
}
/** Mostra (uma única vez) a palavra-passe temporária para enviar à pessoa. */
function showTemp(d, name, email, temp, title) {
  d.querySelector('.db').replaceChildren(h('div', { class: 'form' },
    alert('ok', `${title}: «${name}».`),
    h('div', { class: 'full' }, h('p', `Envie a ${name} o email (${email}) e esta palavra-passe temporária — só aparece agora. No próximo login terá de escolher a sua:`),
      h('p', { class: 'temp-pw' }, h('code', temp), ' ', h('button', { type: 'button', class: 'btn sm', onclick: (ev) => { navigator.clipboard?.writeText(`Email: ${email}\nPalavra-passe temporária: ${temp}`); ev.target.textContent = 'Copiado'; } }, 'Copiar email e palavra-passe'))),
    h('div', { class: 'acts' }, h('span'), h('button', { type: 'button', class: 'btn pri', onclick: () => d.close() }, 'Fechar'))));
}
/** Mudar a própria palavra-passe (qualquer perfil). */
function openOwnPassword() {
  const box = msgBox();
  const d = dialog('Mudar palavra-passe', h('div'));
  const f = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault(); const b = Object.fromEntries(new FormData(f));
    if (b.password !== b.password2) { box.replaceChildren(alert('bad', 'As duas palavras-passe novas não são iguais.')); return; }
    try { await api('POST', '/api/auth/password', { current: b.current, password: b.password }); d.close(); flash = { kind: 'ok', text: 'Palavra-passe alterada. As outras sessões abertas foram terminadas.', at: Date.now() }; render(); }
    catch (err) { box.replaceChildren(alert('bad', err.message)); }
  } },
  field('Palavra-passe atual', h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
  field('Nova palavra-passe', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: 10, required: true }), 'Pelo menos 10 caracteres.'),
  field('Repetir a nova', h('input', { name: 'password2', type: 'password', autocomplete: 'new-password', minlength: 10, required: true })),
  box, h('div', { class: 'acts' }, h('span'), h('button', { class: 'btn pri', type: 'submit' }, 'Guardar')));
  d.querySelector('.db').replaceChildren(f);
}
function openUser(x, done) {
  const box = msgBox();
  const d = dialog(x ? `Editar «${x.name}»` : 'Novo utilizador', h('div'));
  const role = h('select', { name: 'role', required: true, onchange: () => syncDel(false) }, Object.entries(ROLE_LABEL).map(([k, l]) => h('option', { value: k, selected: (x?.role ?? 'coordenador') === k }, l)));
  const del = h('select', { name: 'delegation' });
  const delHelp = h('span', { class: 'help' });
  const syncDel = (initial) => {
    // ao mudar de perfil: administrativo começa em «Todas»; coordenador mantém a escolhida (ou a primeira)
    const r = role.value, cur = initial ? (x?.delegation ?? '') : r === 'administrativo' ? '' : del.value;
    del.replaceChildren(...(r === 'administrativo' ? [h('option', { value: '' }, 'Todas as delegações')] : r === 'gestor' ? [h('option', { value: '' }, 'Todas (gestor)')] : []),
      ...(r === 'gestor' ? [] : D.delegations.map(([k, l]) => h('option', { value: k, selected: cur === k }, l))));
    del.disabled = r === 'gestor';
    delHelp.textContent = r === 'coordenador' ? 'Obrigatória: vê e altera só esta delegação.' : r === 'administrativo' ? 'Só leitura: todas as delegações ou só uma.' : 'O gestor vê sempre todas.';
  };
  syncDel(true);
  const self = x && x.email === user.email;
  const f = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault(); const b = Object.fromEntries(new FormData(f));
    const body = { name: b.name, email: b.email, role: b.role || x?.role, delegation: b.delegation || null, ...(x ? { active: f.querySelector('[name=active]').checked ? 1 : 0 } : {}) };
    try {
      const r = x ? await api('PUT', `/api/users/${x.id}`, body) : await api('POST', '/api/users', body);
      await done();
      if (x) { d.close(); return; }
      showTemp(d, b.name, b.email, r.tempPassword, 'Utilizador criado');
    } catch (err) { box.replaceChildren(alert('bad', err.message)); }
  } },
  field('Nome *', h('input', { name: 'name', value: x?.name ?? '', required: true, maxlength: 120 })),
  field('Email *', h('input', { name: 'email', type: 'email', value: x?.email ?? '', required: true, maxlength: 120, autocomplete: 'off' }), 'É o nome de utilizador para entrar.'),
  field('Perfil *', role),
  h('label', { class: 'f' }, 'Delegação', del, delHelp),
  x ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'active', checked: !!x.active, disabled: self }), 'Ativo (pode entrar)') : null,
  x ? h('p', { class: 'help full' }, self ? 'Não pode desativar nem mudar o perfil da sua própria conta.' : 'Desativar em vez de apagar: o histórico mantém o nome. Mudar o perfil, a delegação ou desativar termina as sessões abertas desta pessoa.') : h('p', { class: 'help full' }, 'É gerada uma palavra-passe temporária, que a pessoa muda no primeiro login.'),
  box, h('div', { class: 'acts' },
    x && !self ? h('button', { type: 'button', class: 'btn', onclick: async () => {
      if (!confirm(`Repor a palavra-passe de «${x.name}»? É gerada uma temporária nova; a pessoa escolhe a sua no próximo login e as sessões abertas terminam.`)) return;
      try { const r = await api('POST', `/api/users/${x.id}/reset`, {}); await done(); showTemp(d, x.name, x.email, r.tempPassword, r.inactive ? 'Palavra-passe reposta — ATENÇÃO: a conta está desativada; abra «Editar» e marque «Ativo» para poder entrar' : 'Palavra-passe reposta'); }
      catch (err) { box.replaceChildren(alert('bad', err.message)); }
    } }, icon('lock'), 'Repor palavra-passe') : h('span'),
    h('button', { class: 'btn pri', type: 'submit' }, x ? 'Guardar' : 'Criar utilizador')));
  if (self) role.disabled = true;
  d.querySelector('.db').replaceChildren(f);
}

// ---------- menu lateral ----------
function side(route) {
  const el = document.getElementById('side'); el.replaceChildren();
  if (!user) return;
  const curHouse = /^casa\/(\d+)$/.exec(route); const hd = curHouse && house(Number(curHouse[1]))?.delegation;
  const link = (r, label, ic) => h('a', { href: `#/${r}`, 'aria-current': route === r || (hd && r === `d/${hd}`) ? 'page' : null }, icon(ic), h('span', { class: 'lbl' }, label));
  const pref = document.documentElement.dataset.themePref || 'auto';
  el.append(
    h('a', { class: 'brand', href: '#/' }, h('img', { src: '/logo.jpg', alt: '', width: 32, height: 32 }), h('span', 'Fonsat', h('small', 'Alojamentos'))),
    h('nav', { 'aria-label': 'Principal' },
      seesAll() ? link('', 'Painel', 'home') : null,
      h('div', { class: 'sec' }, seesAll() ? 'Delegações' : 'Delegação'),
      ...(seesAll() ? D.delegations.map(([k, l]) => link(`d/${k}`, l, 'building')) : [link(`d/${user.delegation}`, delLabel(user.delegation), 'building')]),
      h('div', { class: 'sec' }, 'Geral'),
      link('mapa', 'Mapa', 'map'), link('funcionarios', 'Funcionários', 'users'), RO() ? null : link('historico', 'Histórico', 'clock'),
      RO() ? null : (() => { const n = pendingReviews().length; const a = link('correcoes', 'Correções', 'list'); if (n) a.append(h('span', { class: 'navbadge', title: `${n} por aplicar` }, String(n))); return a; })(),
      isGestor() ? link('utilizadores', 'Utilizadores', 'users') : null,
      isGestor() ? link('definicoes', 'Definições', 'gear') : null),
    h('div', { class: 'foot' },
      h('div', { class: 'theme' }, h('span', { class: 'lbl' }, 'Tema'), seg([['light', 'Claro', 'sun'], ['dark', 'Escuro', 'moon'], ['auto', 'Automático', 'auto']], pref, (v) => window.setTheme(v), 'icons')),
      h('div', { class: 'me' },
        h('div', { class: 'avatar sm' }, initials(user.name)),
        h('div', { class: 'who' }, h('b', user.name), h('span', roleText(user)), RO() ? h('span', { class: 'chip' }, 'Só leitura') : null),
        h('button', { class: 'btn ghost icon-btn', title: 'Mudar palavra-passe', 'aria-label': 'Mudar palavra-passe', onclick: () => openOwnPassword() }, icon('lock')),
        h('button', { class: 'btn ghost icon-btn', title: 'Sair', 'aria-label': 'Sair', onclick: async () => { await api('POST', '/api/auth/logout', {}).catch(() => {}); user = null; session.csrf = null; location.hash = '#/'; render(); } }, icon('logout')))));
}

let lastRoute = null;
function render() {
  for (const m of maps) m.remove();
  maps = []; mounts = [];
  let route = location.hash.replace(/^#\/?/, '');
  const main = document.getElementById('main');
  document.body.classList.toggle('anon', !user);
  if (!user) { lastRoute = null; side(route); main.replaceChildren(viewLogin()); return; }
  if (!D && !user.mustChange) { main.replaceChildren(h('p', { class: 'muted' }, 'A carregar…')); return; }
  if (user.mustChange) { document.getElementById('side').replaceChildren(); document.body.classList.add('anon'); main.replaceChildren(viewNewPassword()); return; }
  if (route === 'utilizadores' && !isGestor()) route = '';
  if (!seesAll() && (route === '' || (/^d\//.test(route) && route !== `d/${user.delegation}`))) { route = `d/${user.delegation}`; history.replaceState(null, '', `#/${route}`); }
  side(route);
  const mh = /^casa\/(\d+)$/.exec(route), md = /^d\/(\w+)$/.exec(route);
  const node = mh ? viewHouse(Number(mh[1])) : md && D.delegations.some(([k]) => k === md[1]) ? viewDelegation(md[1])
    : route === 'mapa' ? viewMap() : route === 'funcionarios' ? viewWorkers() : route === 'historico' ? viewAudit() :  route === 'definicoes' ? viewSettings() : route === 'utilizadores' ? viewUsers() : route === 'correcoes' ? viewCorrections() : viewDashboard();
  // animação de entrada só quando muda de página; mensagens de confirmação só animam a primeira vez
  const routeChanged = route !== lastRoute; lastRoute = route;
  node.classList?.toggle('enter', routeChanged);
  const flashNode = flash && Date.now() - flash.at < 4000 ? alert(flash.kind, flash.text) : null;
  if (flashNode && !flash.shown) { flashNode.classList.add('pop'); flash.shown = true; }
  main.replaceChildren(flashNode, node,
    datalist('entry-reasons', ENTRY_REASONS), datalist('exit-reasons', EXIT_REASONS),
    datalist('regions', [...new Set(D.houses.map((x) => x.region).filter(Boolean))].sort()));
  for (const f of mounts) f();
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
document.addEventListener('themechange', () => render());
try {
  const r = await api('GET', '/api/auth/me');
  user = r.user; session.csrf = r.csrf ?? null;
  if (user && !user.mustChange) await reload();
} catch (e) { user = null; console.error(e.message); }
render();
