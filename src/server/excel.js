// Excel: modelo, exportação e importação (com pré-visualização) de alojamentos e funcionários.
// Um ficheiro com as folhas «Alojamentos», «Funcionários» e «Instruções». A exportação sai no mesmo formato,
// para completar e voltar a importar. A importação NUNCA apaga nem substitui: só cria e preenche campos vazios.
import ExcelJS from 'exceljs';
import { DELEGATIONS, validate, isDate } from './schema.js';
import { norm, compareNames } from './names.js';

export const SHEET_H = 'Alojamentos', SHEET_W = 'Funcionários', SHEET_I = 'Instruções';
export const MAX_ROWS = 2000;
const PENDING = 'Pendente';

/** Colunas da folha «Alojamentos» (ordem do modelo). kind: text | num | int | date | bool | deleg | url */
export const HOUSE_COLS = [
  { key: 'name', label: 'Nome do piso', req: true, w: 34 },
  { key: 'delegation', label: 'Delegação', req: true, kind: 'deleg', w: 13 },
  { key: 'region', label: 'Região', w: 16 },
  { key: 'address', label: 'Morada', w: 44 },
  { key: 'location_url', label: 'Localização (link)', kind: 'url', w: 30 },
  { key: 'rent', label: 'Aluguer', kind: 'num', w: 11 },
  { key: 'fixed_expenses', label: 'Despesas fixas', kind: 'num', w: 14 },
  { key: 'capacity', label: 'Lotação', kind: 'int', w: 9 },
  { key: 'rooms', label: 'Quartos', kind: 'int', w: 9 },
  { key: 'owner_name', label: 'Proprietário', w: 22 },
  { key: 'contract_start', label: 'Início do contrato', kind: 'date', w: 15 },
  { key: 'contract_end', label: 'Fim do contrato', kind: 'date', w: 15 },
  { key: 'deposit_amount', label: 'Caução', kind: 'num', w: 10 },
  { key: 'deposit_available', label: 'Caução disponível', kind: 'bool', w: 16 },
  { key: 'active', label: 'Ativa', kind: 'bool', w: 8 },
  { key: 'notes', label: 'Notas', w: 40 },
  { key: 'code', label: 'Código', w: 10 },
  { key: 'rent_due_day', label: 'Dia de vencimento', kind: 'int', w: 16 },
  { key: 'building', label: 'Edifício', w: 24 },
];
/** Colunas da folha «Funcionários» (só dados da pessoa; as entradas nas casas fazem-se na aplicação). */
export const WORKER_COLS = [
  { key: 'name', label: 'Nome', req: true, w: 38 },
  { key: 'profession', label: 'Profissão', w: 20 },
  { key: 'phone', label: 'Telefone', w: 20 },
  { key: 'delegation', label: 'Delegação', kind: 'deleg', pending: true, w: 13 },
  { key: 'company', label: 'Empresa / obra', w: 22 },
  { key: 'own_housing', label: 'Alojamento próprio', kind: 'bool', w: 18 },
];

const delLabel = (k) => (k == null ? PENDING : DELEGATIONS.find(([v]) => v === k)?.[1] ?? k);
const DEL_ALIASES = new Map(DELEGATIONS.flatMap(([k, l]) => [[norm(k), k], [norm(l), k]]).concat([['AST', 'asturias'], ['AS', 'asturias'], ['CAT', 'catalunha'], ['CT', 'catalunha'], ['POR', 'porto'], ['PT', 'porto'], ['ASTURIAS', 'asturias'], ['CATALUNA', 'catalunha'], ['CATALUNYA', 'catalunha'], ['CATALUNHA', 'catalunha']]));
const isoUTC = (d) => d.toISOString().slice(0, 10);
/** Chave de comparação que MANTÉM algarismos e pontuação (códigos «AS-001», moradas «Calle Mayor 7»): só tira acentos, maiúsculas e espaços a mais. */
const key = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const empty = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

// ---------------- modelo e exportação ----------------
function styleSheet(ws, cols) {
  ws.columns = cols.map((c) => ({ header: c.req ? `${c.label}*` : c.label, key: c.key, width: c.w ?? 14 }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D3557' } };
  head.alignment = { vertical: 'middle' };
  head.height = 20;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  const L = (i) => ws.getColumn(i + 1).letter;
  cols.forEach((c, i) => {
    const range = `${L(i)}2:${L(i)}${MAX_ROWS + 1}`;
    if (c.kind === 'deleg') ws.dataValidations.add(range, { type: 'list', allowBlank: !c.req, formulae: [`"${[...DELEGATIONS.map(([, l]) => l), ...(c.pending ? [PENDING] : [])].join(',')}"`], showErrorMessage: true, errorTitle: 'Delegação', error: 'Escolha uma delegação da lista.' });
    if (c.kind === 'bool') ws.dataValidations.add(range, { type: 'list', allowBlank: true, formulae: ['"Sim,Não"'], showErrorMessage: true, errorTitle: c.label, error: 'Escolha Sim ou Não.' });
    if (c.kind === 'date') ws.getColumn(i + 1).numFmt = 'dd/mm/yyyy';
    if (c.kind === 'num') ws.getColumn(i + 1).numFmt = '#,##0.00';
  });
}
const toDate = (s) => (s ? new Date(`${s}T00:00:00Z`) : null);
/** Modelo (sem linhas) ou exportação (com as casas e funcionários que o utilizador pode ver). */
export async function buildWorkbook({ houses = [], workers = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Fonsat · Alojamentos'; wb.created = new Date();
  const wh = wb.addWorksheet(SHEET_H); styleSheet(wh, HOUSE_COLS);
  for (const x of houses) {
    wh.addRow(Object.fromEntries(HOUSE_COLS.map((c) => [c.key,
      c.kind === 'deleg' ? delLabel(x.delegation) : c.kind === 'bool' ? (x[c.key] ? 'Sim' : 'Não') : c.kind === 'date' ? toDate(x[c.key]) : (x[c.key] ?? null)])));
  }
  const ww = wb.addWorksheet(SHEET_W); styleSheet(ww, WORKER_COLS);
  for (const w of workers) ww.addRow({ name: w.name, profession: w.profession || null, phone: w.phone || null, delegation: delLabel(w.delegation), company: w.company || null, own_housing: w.own_housing ? 'Sim' : 'Não' });
  const wi = wb.addWorksheet(SHEET_I);
  wi.getColumn(1).width = 110;
  [
    ['Fonsat · Alojamentos — como preencher', true],
    [''],
    ['• Não mude os nomes das colunas nem das folhas. Colunas com * são obrigatórias.'],
    ['• Uma linha por alojamento (folha «Alojamentos») ou por pessoa (folha «Funcionários»). Linhas vazias são ignoradas.'],
    ['• Alojamentos reconhecem-se pelo Código ou, sem código, pelo Nome do piso. Funcionários reconhecem-se pelo nome (também com pequenas diferenças de escrita).'],
    ['• Se já existir, a importação SÓ PREENCHE OS CAMPOS VAZIOS: nunca apaga nem substitui. As diferenças aparecem como aviso, para corrigir na aplicação.'],
    ['• Datas: dd/mm/aaaa. Valores: números (ex.: 750 ou 750,50). Lotação: deixe vazio se não souber (nunca 0).'],
    ['• Delegação: Astúrias, Catalunha ou Porto (lista de escolha). Funcionários: «Pendente» = sem delegação nem alojamento.'],
    ['• Cada ficheiro é de UMA delegação (exporta-se e importa-se dentro da delegação). Delegação em branco = a da importação; outra delegação = erro.'],
    ['• Coordenadores: preencher alojamentos que já existem pede o código do gestor.'],
    ['• Funcionários: «Alojamento próprio» = Sim quando a pessoa não precisa de alojamento da empresa.'],
    ['• Funcionários: só dados da pessoa (nome, profissão, telefone, delegação, obra). As entradas nos alojamentos fazem-se na aplicação.'],
    ['• Antes de gravar, a aplicação mostra uma pré-visualização com os erros e avisos por número de linha.'],
  ].forEach(([t, b], i) => { const c = wi.getCell(`A${i + 1}`); c.value = t; if (b) c.font = { bold: true, size: 14 }; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------- leitura ----------------
/** Valor «simples» de uma célula ExcelJS (texto rico, links, fórmulas). */
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v !== 'object') return v;
  if (v.error) return { error: v.error };
  if ('result' in v) return cellValue(v.result);
  if (v.richText) return v.richText.map((r) => r.text).join('');
  if (v.hyperlink) return v.hyperlink; // link: guarda o endereço
  if ('text' in v) return v.text;
  return String(v);
}
/** Número escrito à portuguesa/espanhola ou à inglesa: «1.250,50», «1250,5», «1,250.50», «750 €». */
function parseNumber(v) {
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[€\s]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  return s === '' ? null : Number(s);
}
function parseDate(v) {
  if (v instanceof Date) return isNaN(v) ? undefined : isoUTC(v);
  if (typeof v === 'number') return v > 20000 && v < 80000 ? isoUTC(new Date(Date.UTC(1899, 11, 30) + v * 86400000)) : undefined; // número de série do Excel
  const s = String(v).trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) { const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return isDate(d) ? d : undefined; }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m && isDate(`${m[1]}-${m[2]}-${m[3]}`)) return `${m[1]}-${m[2]}-${m[3]}`;
  return undefined;
}
function parseBool(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = key(v);
  if (['SIM', 'S', 'YES', 'Y', 'SI', '1', 'X', 'VERDADEIRO', 'TRUE'].includes(s)) return 1;
  if (['NAO', 'N', 'NO', '0', 'FALSO', 'FALSE'].includes(s)) return 0;
  return undefined;
}

/**
 * Lê uma folha: cabeçalhos pelo nome (a ordem pode mudar), linhas com o número da linha do Excel.
 * Devolve { rows: [{ line, values, errors, warnings }], fatal: [], warnings: [] }.
 */
function readSheet(ws, cols, sheetName) {
  const out = { rows: [], fatal: [], warnings: [] };
  if (!ws) { out.fatal.push(`Falta a folha «${sheetName}».`); return out; }
  const head = ws.getRow(1);
  const byHeader = new Map();
  head.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const h = norm(String(cellValue(cell.value) ?? '').replace(/\*/g, ''));
    if (h) byHeader.set(h, colNumber);
  });
  const colOf = {};
  for (const c of cols) {
    const n = byHeader.get(norm(c.label));
    if (n) colOf[c.key] = n;
    else if (c.req) out.fatal.push(`Folha «${sheetName}»: falta a coluna obrigatória «${c.label}» na linha 1.`);
    else out.warnings.push(`Folha «${sheetName}»: falta a coluna «${c.label}» (fica por preencher).`);
  }
  const known = new Set(cols.map((c) => norm(c.label)));
  for (const h of byHeader.keys()) if (!known.has(h)) out.warnings.push(`Folha «${sheetName}»: coluna «${h}» não faz parte do modelo e foi ignorada.`);
  if (out.fatal.length) return out;
  const last = ws.actualRowCount ? ws.rowCount : 0;
  if (last - 1 > MAX_ROWS) { out.fatal.push(`Folha «${sheetName}»: mais de ${MAX_ROWS} linhas. Divida o ficheiro.`); return out; }
  for (let r = 2; r <= last; r++) {
    const row = ws.getRow(r);
    const raw = Object.fromEntries(cols.filter((c) => colOf[c.key]).map((c) => [c.key, cellValue(row.getCell(colOf[c.key]).value)]));
    if (Object.values(raw).every(empty)) continue; // linha vazia
    const values = {}, errors = [], warnings = [];
    for (const c of cols) {
      if (!(c.key in raw)) continue;
      const v = raw[c.key];
      if (v && typeof v === 'object' && 'error' in v) { errors.push(`${c.label}: a célula tem um erro do Excel (${v.error}).`); continue; }
      if (empty(v)) { values[c.key] = null; continue; }
      const k = c.kind ?? 'text';
      if (k === 'num' || k === 'int') {
        const n = parseNumber(v);
        if (n === null || !Number.isFinite(n)) errors.push(`${c.label}: «${v}» não é um número.`);
        else if (k === 'int' && !Number.isInteger(n)) errors.push(`${c.label}: tem de ser um número inteiro (está ${v}).`);
        else values[c.key] = n;
      } else if (k === 'date') {
        const d = parseDate(v);
        if (d === undefined) errors.push(`${c.label}: «${v instanceof Date ? v.toISOString() : v}» não é uma data válida (use dd/mm/aaaa).`);
        else values[c.key] = d;
      } else if (k === 'bool') {
        const b = parseBool(v);
        if (b === undefined) errors.push(`${c.label}: escreva Sim ou Não (está «${v}»).`);
        else values[c.key] = b;
      } else if (k === 'deleg') {
        const s = norm(v);
        if (c.pending && s === norm(PENDING)) values[c.key] = PENDING;
        else if (DEL_ALIASES.has(s)) values[c.key] = DEL_ALIASES.get(s);
        else errors.push(`${c.label}: «${v}» não é uma delegação (Astúrias, Catalunha ou Porto${c.pending ? ' ou Pendente' : ''}).`);
      } else {
        const s = (v instanceof Date ? isoUTC(v) : String(v)).replace(/\s+/g, ' ').trim();
        values[c.key] = s;
      }
    }
    out.rows.push({ line: r, values, errors, warnings });
  }
  return out;
}

/** Lê o ficheiro (Buffer). Erros fatais: não é um Excel, folhas ou colunas obrigatórias em falta. */
export async function readWorkbook(buf) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { return { fatal: ['O ficheiro não é um Excel válido (.xlsx). Descarregue o modelo e use-o como base.'], houses: { rows: [], fatal: [], warnings: [] }, workers: { rows: [], fatal: [], warnings: [] } }; }
  const find = (name) => wb.worksheets.find((w) => norm(w.name) === norm(name));
  const hs = find(SHEET_H), ws = find(SHEET_W);
  const fatal = [];
  if (!hs && !ws) fatal.push(`O ficheiro não tem as folhas «${SHEET_H}» nem «${SHEET_W}». Descarregue o modelo e use-o como base.`);
  return {
    fatal,
    houses: hs ? readSheet(hs, HOUSE_COLS, SHEET_H) : { rows: [], fatal: [], warnings: [], missing: true },
    workers: ws ? readSheet(ws, WORKER_COLS, SHEET_W) : { rows: [], fatal: [], warnings: [], missing: true },
  };
}

// ---------------- planeamento (sem gravar) ----------------
const same = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : key(a) === key(b));
const show = (c, v) => (v == null || v === '' ? '—' : c.kind === 'bool' ? (v ? 'Sim' : 'Não') : c.kind === 'deleg' ? delLabel(v) : c.kind === 'date' ? v.split('-').reverse().join('/') : String(v));

/**
 * Plano para a folha «Alojamentos». ctx: { user, houses (todas, para detetar repetidos), canSee(house) }.
 * action: create | fill | same | error
 */
export function planHouses(sheet, ctx) {
  const { user, houses } = ctx;
  const gestor = user.role === 'gestor';
  const seenName = new Map(), seenCode = new Map();
  return sheet.rows.map((r) => {
    const p = { line: r.line, name: r.values.name ?? '', errors: [...r.errors], warnings: [...r.warnings], fills: {}, diffs: [] };
    const v = { ...r.values };
    const D = ctx.delegation ?? (gestor ? null : user.delegation); // delegação da importação
    if (D) {
      if (v.delegation == null) v.delegation = D;
      else if (v.delegation !== D) p.errors.push(`Delegação «${delLabel(v.delegation)}»: esta importação é só de ${delLabel(D)}.`);
    }
    if (v.capacity === 0) p.warnings.push('Lotação 0: se não sabe a lotação, deixe a célula vazia.');
    if (v.rent === 0) p.warnings.push('Aluguer 0: confirme (vazio = desconhecido).');
    // repetidos dentro do ficheiro
    const nk = key(v.name), ck = key(v.code);
    if (nk && seenName.has(nk)) p.errors.push(`Nome do piso repetido no ficheiro (já na linha ${seenName.get(nk)}).`);
    if (ck && seenCode.has(ck)) p.errors.push(`Código repetido no ficheiro (já na linha ${seenCode.get(ck)}).`);
    if (nk) seenName.set(nk, r.line); if (ck) seenCode.set(ck, r.line);
    // casa existente: pelo código, senão pelo nome
    const byCode = ck ? houses.find((x) => x.code && key(x.code) === ck) : null;
    const byName = nk ? houses.find((x) => key(x.name) === nk) : null;
    if (byCode && byName && byCode.id !== byName.id) p.errors.push(`O código «${v.code}» é de «${byCode.name}», mas o nome é de outro alojamento. Corrija o nome ou o código.`);
    const ex = byCode ?? byName;
    if (ex && D && ex.delegation !== D) p.errors.push(`Já existe um alojamento com este nome ou código noutra delegação${gestor ? ` (${delLabel(ex.delegation)})` : ''}.`);
    if (p.errors.length) return { ...p, action: 'error' };
    if (!ex) {
      const val = validate('houses', v);
      if (val.errors) { p.errors.push(...Object.values(val.errors)); return { ...p, action: 'error' }; }
      return { ...p, action: 'create', row: val.row };
    }
    // existente: só preenche o que está vazio; diferenças são avisos
    p.id = ex.id; p.name = ex.name;
    for (const c of HOUSE_COLS) {
      if (!(c.key in v) || v[c.key] == null) continue;
      const cur = ex[c.key];
      if (c.key === 'delegation' || c.kind === 'bool') { if (!same(cur, v[c.key])) p.diffs.push(`${c.label}: no Excel «${show(c, v[c.key])}», na aplicação «${show(c, cur)}» — mantém-se.`); continue; }
      if (cur == null || cur === '') p.fills[c.key] = v[c.key];
      else if (!same(cur, v[c.key])) p.diffs.push(`${c.label}: no Excel «${show(c, v[c.key])}», na aplicação «${show(c, cur)}» — mantém-se.`);
    }
    if (Object.keys(p.fills).length) {
      const val = validate('houses', { ...ex, ...p.fills });
      if (val.errors) { p.errors.push(...Object.values(val.errors)); return { ...p, action: 'error' }; }
      if (p.fills.code && houses.some((x) => x.id !== ex.id && x.code && key(x.code) === key(p.fills.code))) { p.errors.push(`O código «${p.fills.code}» já é usado por outro alojamento.`); return { ...p, action: 'error' }; }
    }
    p.warnings.push(...p.diffs);
    p.fillText = Object.entries(p.fills).map(([k, val]) => { const c = HOUSE_COLS.find((y) => y.key === k); return `${c.label}: ${show(c, val)}`; });
    return { ...p, action: Object.keys(p.fills).length ? 'fill' : 'same' };
  });
}

/**
 * Plano para a folha «Funcionários». ctx: { user, workers (todos, para não repetir), visible(worker) }.
 * action: create | fill | same | error | doubt (possível duplicado: não se importa)
 */
export function planWorkers(sheet, ctx) {
  const { user, workers, visible } = ctx;
  const gestor = user.role === 'gestor';
  const seen = new Map();
  return sheet.rows.map((r) => {
    const p = { line: r.line, name: r.values.name ?? '', errors: [...r.errors], warnings: [...r.warnings], fills: {} };
    const v = { ...r.values };
    // delegação: «Pendente» = sem delegação; em branco: gestor → pendente, coordenador → a sua
    const D = ctx.delegation ?? (gestor ? null : user.delegation); // delegação da importação
    let del = v.delegation === PENDING ? null : v.delegation;
    if (v.delegation == null) del = D;
    if (D && del != null && del !== D) p.errors.push(`Delegação «${delLabel(del)}»: esta importação é só de ${delLabel(D)} (ou Pendente).`);
    if (v.phone && /[a-z]/i.test(v.phone)) p.warnings.push(`Telefone «${v.phone}» tem letras: confirme.`);
    const k = norm(v.name);
    if (k && seen.has(k)) p.errors.push(`Nome repetido no ficheiro (já na linha ${seen.get(k)}).`);
    if (k) seen.set(k, r.line);
    const val = validate('workers', { ...v, delegation: del ?? '' });
    if (val.errors) p.errors.push(...Object.values(val.errors).filter((e) => !/^Delegação/.test(e)));
    if (p.errors.length) return { ...p, action: 'error' };
    // existente? igual (sem acentos) ou parecido (todas as palavras batem, um só candidato)
    const exact = workers.filter((w) => norm(w.name) === k);
    let ex = null;
    if (exact.length > 1) { p.errors.push(`Há ${exact.length} funcionários com este nome na aplicação: corrija à mão.`); return { ...p, action: 'error' }; }
    if (exact.length === 1) ex = exact[0];
    else {
      const c = workers.map((w) => ({ w, ...compareNames(v.name, w.name) })).filter((x) => x.kind);
      const full = c.filter((x) => x.kind === 'full');
      if (full.length === 1) { ex = full[0].w; p.warnings.push(`Nome parecido com «${ex.name}» (na aplicação): considerado a mesma pessoa.`); }
      else if (full.length > 1 || c.some((x) => x.kind === 'maybe')) {
        const names = (full.length > 1 ? full : c.filter((x) => x.kind === 'maybe')).map((x) => `«${x.w.name}»`).join(', ');
        p.warnings.push(`Possível duplicado de ${names}. Não importado: escreva o nome exatamente como está na aplicação ou, se for outra pessoa, crie-a na aplicação.`);
        return { ...p, action: 'doubt' };
      }
    }
    if (!ex) return { ...p, action: 'create', row: { ...val.row, delegation: del } };
    if (!visible(ex) || (D && ex.delegation && ex.delegation !== D)) { p.errors.push(`Já existe um funcionário com este nome noutra delegação${gestor && ex.delegation ? ` (${delLabel(ex.delegation)})` : ''}.`); return { ...p, action: 'error' }; }
    p.id = ex.id; p.name = ex.name;
    for (const key of ['profession', 'phone', 'company']) {
      const nv = val.row[key];
      if (!nv) continue;
      if (!ex[key]) p.fills[key] = nv;
      else if (!same(ex[key], nv)) p.warnings.push(`${WORKER_COLS.find((c) => c.key === key).label}: no Excel «${nv}», na aplicação «${ex[key]}» — mantém-se.`);
    }
    if (v.own_housing === 1 && !ex.own_housing) p.fills.own_housing = 1;
    else if (v.own_housing === 0 && ex.own_housing) p.warnings.push('Alojamento próprio: no Excel «Não», na aplicação «Sim» — mantém-se.');
    if (v.delegation != null && !same(ex.delegation ?? '', del ?? '')) {
      if (ex.delegation == null && del != null && gestor) p.fills.delegation = del;
      else p.warnings.push(`Delegação: no Excel «${delLabel(del)}», na aplicação «${delLabel(ex.delegation)}» — mantém-se${gestor ? '' : ' (só o gestor muda a delegação)'}.`);
    }
    p.fillText = Object.entries(p.fills).map(([k, val]) => { const c = WORKER_COLS.find((y) => y.key === k); return `${c.label}: ${show(c, val)}`; });
    return { ...p, action: Object.keys(p.fills).length ? 'fill' : 'same' };
  });
}
