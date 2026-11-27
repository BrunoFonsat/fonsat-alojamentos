// Utilitários de UI: construtor DOM seguro (sem innerHTML), formatação e chamadas à API.
// replaceChildren escreveria «null» para elementos ausentes (ex.: cond ? h(...) : null): ignora null/false, como o h().
const nativeReplace = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function replaceChildren(...kids) { return nativeReplace.apply(this, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  } else if (attrs !== undefined && attrs !== null) kids.unshift(attrs);
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

const nf = (dg) => new Intl.NumberFormat('pt-PT', { minimumFractionDigits: dg, maximumFractionDigits: dg });
export const eur = (v, dg = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${nf(dg).format(v)} €`);
export const num = (v, dg = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : nf(dg).format(v));
export const pct = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${nf(0).format(v)} %`);
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const monthLabel = (m) => `${MONTHS[Number(m.slice(5)) - 1]}/${m.slice(0, 4)}`;
export const dateLabel = (s) => (s ? s.split('-').reverse().join('/') : '—');

export const alert = (kind, text) => h('div', { class: `alert ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, text);
export const field = (label, input, help) => h('label', { class: 'f' }, label, input, help ? h('span', { class: 'help' }, help) : null);
export function table(head, rows) {
  return h('div', { class: 'tw' }, h('table',
    h('thead', h('tr', head.map((c) => h('th', { class: c.n ? 'n' : '', scope: 'col' }, c.t ?? c)))),
    h('tbody', rows)));
}
export const td = (v, n = false) => h('td', { class: n ? 'n' : '' }, v);

export const session = { csrf: null };
export async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session.csrf ? { 'x-csrf-token': session.csrf } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Erro ${r.status}`); e.status = r.status; e.data = j; throw e; }
  return j;
}
