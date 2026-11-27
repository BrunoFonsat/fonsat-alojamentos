// Esquema da BD (libSQL/SQLite), constantes e validação no servidor.

/** Delegações que gerem as casas. A casa pode ficar noutra cidade/região; conta quem a gere. */
export const DELEGATIONS = [['asturias', 'Astúrias'], ['catalunha', 'Catalunha'], ['porto', 'Porto']];
const DEL_KEYS = DELEGATIONS.map(([k]) => k);
/**
 * Perfis: gestor (tudo, todas as delegações) · coordenador (ver e alterar a sua delegação) ·
 * administrativo (SÓ VER: todas as delegações ou uma; pode exportar Excel e ver telefones; não vê o histórico de edições).
 */
export const ROLES = ['gestor', 'coordenador', 'administrativo'];
export const ROLE_LABEL = { gestor: 'Gestor', coordenador: 'Coordenador', administrativo: 'Administrativo' };

export const USERS_DDL = `CREATE TABLE users_mig(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('gestor','coordenador','administrativo')), delegation TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0 CHECK(must_change IN (0,1)),
  CHECK(role<>'coordenador' OR delegation IS NOT NULL), CHECK(role<>'gestor' OR delegation IS NULL));`;
export const DDL = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('gestor','coordenador','administrativo')), delegation TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0 CHECK(must_change IN (0,1)),
  CHECK(role<>'coordenador' OR delegation IS NOT NULL), CHECK(role<>'gestor' OR delegation IS NULL));
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_attempts_key ON login_attempts(key);
CREATE TABLE IF NOT EXISTS houses(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  delegation TEXT NOT NULL CHECK(delegation IN ('asturias','catalunha','porto')),
  region TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', location_url TEXT NOT NULL DEFAULT '',
  rent REAL CHECK(rent IS NULL OR rent>=0), fixed_expenses REAL CHECK(fixed_expenses IS NULL OR fixed_expenses>=0),
  capacity INTEGER CHECK(capacity IS NULL OR capacity>=0), rooms INTEGER CHECK(rooms IS NULL OR rooms>=0),
  owner_name TEXT NOT NULL DEFAULT '', contract_start TEXT, contract_end TEXT,
  deposit_amount REAL CHECK(deposit_amount IS NULL OR deposit_amount>=0),
  deposit_available INTEGER NOT NULL DEFAULT 0 CHECK(deposit_available IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), notes TEXT NOT NULL DEFAULT '',
  lat REAL, lng REAL, geo_source TEXT, code TEXT NOT NULL DEFAULT '', rent_due_day INTEGER, geo_review INTEGER NOT NULL DEFAULT 0, building TEXT NOT NULL DEFAULT '', occ_checked TEXT);
CREATE TABLE IF NOT EXISTS expense_adjustments(
  id INTEGER PRIMARY KEY, house_id INTEGER NOT NULL REFERENCES houses(id),
  month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  value REAL NOT NULL CHECK(value>=0), note TEXT NOT NULL DEFAULT '', UNIQUE(house_id, month));
CREATE TABLE IF NOT EXISTS workers(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
  delegation TEXT CHECK(delegation IS NULL OR delegation IN ('asturias','catalunha','porto')),
  profession TEXT NOT NULL DEFAULT '', own_housing INTEGER NOT NULL DEFAULT 0 CHECK(own_housing IN (0,1)));
CREATE TABLE IF NOT EXISTS stays(
  id INTEGER PRIMARY KEY, house_id INTEGER NOT NULL REFERENCES houses(id), worker_id INTEGER NOT NULL REFERENCES workers(id),
  start_date TEXT NOT NULL CHECK(start_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'), entry_reason TEXT NOT NULL,
  end_date TEXT CHECK(end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'), exit_reason TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS stays_house ON stays(house_id);
CREATE TABLE IF NOT EXISTS checkins(
  id INTEGER PRIMARY KEY, house_id INTEGER NOT NULL REFERENCES houses(id), token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, created_by INTEGER, expires_at TEXT NOT NULL, sent_at TEXT, answered_at TEXT, answer TEXT,
  status TEXT NOT NULL DEFAULT 'aberto' CHECK(status IN ('aberto','respondido','aplicado','arquivado')), applied_at TEXT, applied_by TEXT);
CREATE INDEX IF NOT EXISTS checkins_house ON checkins(house_id);
CREATE TABLE IF NOT EXISTS rooms(
  id INTEGER PRIMARY KEY, house_id INTEGER NOT NULL REFERENCES houses(id), name TEXT NOT NULL COLLATE NOCASE,
  beds INTEGER NOT NULL CHECK(beds>=0 AND beds<=50), position INTEGER NOT NULL DEFAULT 0, UNIQUE(house_id, name));
CREATE INDEX IF NOT EXISTS rooms_house ON rooms(house_id);
CREATE INDEX IF NOT EXISTS stays_worker ON stays(worker_id);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, user_name TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id INTEGER, house_id INTEGER, delegation TEXT, action TEXT NOT NULL, summary TEXT NOT NULL, changes TEXT);
CREATE INDEX IF NOT EXISTS audit_house ON audit(house_id);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Colunas acrescentadas depois da primeira versão (BDs já criadas recebem-nas com ALTER TABLE). */
export const ADDED_COLUMNS = { checkins: { decision: 'TEXT' }, stays: { room_id: 'INTEGER REFERENCES rooms(id)' }, workers: { profession: "TEXT NOT NULL DEFAULT ''", own_housing: 'INTEGER NOT NULL DEFAULT 0', language: "TEXT NOT NULL DEFAULT ''" }, houses: {
  lat: 'REAL', lng: 'REAL', geo_source: 'TEXT',
  code: "TEXT NOT NULL DEFAULT ''",                // código interno (ex.: AS-001)
  rent_due_day: 'INTEGER',                         // dia do mês em que vence a renda
  geo_review: 'INTEGER NOT NULL DEFAULT 0',        // 1 = pino por confirmar (morada mudou com pino manual, ou pino aproximado)
  building: "TEXT NOT NULL DEFAULT ''",            // edifício: andares do mesmo prédio partilham um pino no mapa
  responsible_id: 'INTEGER',                       // funcionário responsável (alojado nesta casa): envia a lista semanal
  occ_checked: 'TEXT',                             // data em que se confirmou que a casa está vazia (sem registos, a ocupação é desconhecida)
} };

/** Coordenadas escritas num link do Google Maps (…/@43.36,-5.85,… · ?q=43.36,-5.85 · !3d43.36!4d-5.85). Links curtos não as têm. */
export function coordsFromUrl(url) {
  const s = String(url ?? '');
  const m = /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/.exec(s) || /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(s) || /[?&](?:q|query|ll|center)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i.exec(s);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// t: text | num | int | date | month | bool | enum | url
export const ENTITIES = {
  houses: { table: 'houses', label: 'Casa', fields: {
    name: { t: 'text', req: true, label: 'Nome do piso' },
    code: { t: 'text', def: '', max: 20, label: 'Código' },
    delegation: { t: 'enum', values: DEL_KEYS, req: true, label: 'Delegação' },
    region: { t: 'text', def: '', label: 'Região' },
    building: { t: 'text', def: '', label: 'Edifício' },
    address: { t: 'text', def: '', max: 200, label: 'Morada' },
    location_url: { t: 'url', def: '', label: 'Localização' },
    rent: { t: 'num', min: 0, label: 'Aluguer mensal' },
    rent_due_day: { t: 'int', min: 1, max: 31, label: 'Dia de vencimento da renda' },
    fixed_expenses: { t: 'num', min: 0, label: 'Despesas fixas mensais' },
    capacity: { t: 'int', min: 0, label: 'Lotação máxima' },
    rooms: { t: 'int', min: 0, label: 'N.º de quartos' },
    owner_name: { t: 'text', def: '', label: 'Proprietário' },
    contract_start: { t: 'date', label: 'Início do contrato' },
    contract_end: { t: 'date', label: 'Fim do contrato' },
    deposit_amount: { t: 'num', min: 0, label: 'Caução' },
    deposit_available: { t: 'bool', def: 0, label: 'Caução disponível' },
    active: { t: 'bool', def: 1, label: 'Ativa' },
    notes: { t: 'text', def: '', max: 500, label: 'Notas' } } },
  adjustments: { table: 'expense_adjustments', label: 'Acerto de despesas', fields: {
    house_id: { t: 'int', req: true, label: 'Casa' },
    month: { t: 'month', req: true, label: 'Mês' },
    value: { t: 'num', req: true, min: 0, label: 'Despesas reais do mês' },
    note: { t: 'text', def: '', label: 'Nota' } } },
  workers: { table: 'workers', label: 'Funcionário', fields: {
    name: { t: 'text', req: true, label: 'Nome' },
    phone: { t: 'text', def: '', max: 40, label: 'Telefone' },
    company: { t: 'text', def: '', label: 'Empresa / obra' },
    profession: { t: 'text', def: '', max: 60, label: 'Profissão' },
    // alojamento próprio: não precisa de alojamento da empresa (sai da lista «sem informação»)
    own_housing: { t: 'bool', def: 0, label: 'Alojamento próprio' },
    // idioma das mensagens: es (espanhol, por omissão) ou pt (português)
    language: { t: 'enum', values: ['es', 'pt'], def: '', label: 'Idioma' },
    // sem delegação = pendente (ainda sem alojamento atribuído); ao dar entrada numa casa fica com a delegação da casa
    delegation: { t: 'enum', values: DEL_KEYS, label: 'Delegação' } } },
  stays: { table: 'stays', label: 'Estadia', fields: {
    house_id: { t: 'int', req: true, label: 'Casa' },
    worker_id: { t: 'int', req: true, label: 'Funcionário' },
    start_date: { t: 'date', req: true, label: 'Entrada' },
    entry_reason: { t: 'text', req: true, label: 'Motivo da entrada' },
    end_date: { t: 'date', label: 'Saída' },
    exit_reason: { t: 'text', def: '', label: 'Motivo da saída' } } },
};

export const isDate = (v) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** Valida e normaliza o corpo de um pedido. Devolve { row } ou { errors: { campo: mensagem } }. */
export function validate(entity, body) {
  const E = ENTITIES[entity]; const row = {}; const errors = {};
  for (const [k, f] of Object.entries(E.fields)) {
    let v = body[k];
    if (typeof v === 'string') v = v.trim();
    if (f.t === 'bool') { row[k] = v === undefined || v === '' ? f.def : v === true || v === 1 || v === '1' || v === 'on' || v === 'Sim' ? 1 : 0; continue; }
    if (v === '' || v === undefined || v === null) {
      if (f.req) errors[k] = `${f.label}: obrigatório.`;
      row[k] = f.def ?? null; continue;
    }
    if (f.t === 'enum') { if (!f.values.includes(v)) errors[k] = `${f.label}: inválido.`; row[k] = v; continue; }
    if (f.t === 'text' || f.t === 'url') {
      const max = f.max ?? (f.t === 'url' ? 500 : 120);
      if (String(v).length > max) errors[k] = `${f.label}: máximo ${max} caracteres.`;
      if (f.t === 'url' && !/^https:\/\/[^\s]+$/i.test(v)) errors[k] = `${f.label}: tem de ser um link https:// (ex.: copiado do Google Maps).`;
      row[k] = String(v); continue;
    }
    if (f.t === 'month') { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) errors[k] = `${f.label}: formato AAAA-MM.`; row[k] = v; continue; }
    if (f.t === 'date') { if (!isDate(v)) errors[k] = `${f.label}: data inválida.`; row[k] = v; continue; }
    const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(n) || (f.t === 'int' && !Number.isInteger(n))) { errors[k] = `${f.label}: número inválido.`; continue; }
    if (f.min !== undefined && n < f.min) errors[k] = `${f.label}: mínimo ${f.min}.`;
    if (f.max !== undefined && n > f.max) errors[k] = `${f.label}: máximo ${f.max}.`;
    row[k] = n;
  }
  if (entity === 'houses' && row.contract_start && row.contract_end && row.contract_end < row.contract_start) errors.contract_end = 'Fim do contrato: não pode ser antes do início.';
  if (entity === 'stays') {
    if (row.end_date && row.start_date && row.end_date < row.start_date) errors.end_date = 'Saída: não pode ser antes da entrada.';
    else if (row.end_date && !row.exit_reason) errors.exit_reason = 'Motivo da saída: obrigatório.';
  }
  return Object.keys(errors).length ? { errors } : { row };
}
