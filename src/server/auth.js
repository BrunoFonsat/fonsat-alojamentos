// Autenticação: scrypt + sessões no servidor + CSRF + limite de tentativas.
// Perfis: gestor (tudo) · coordenador (a sua delegação) · administrativo (só leitura; todas as delegações ou uma).
import crypto from 'node:crypto';
import { DELEGATIONS, ROLES } from './schema.js';

const SESSION_MS = 10 * 3600 * 1000;
export const MIN_PASSWORD = 10;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}

/** Valida email, nome, perfil e delegação de um utilizador. Devolve os valores normalizados. */
export function checkUser({ email, name, role, delegation }) {
  email = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new Error('Email inválido.');
  name = String(name ?? '').trim();
  if (!name || name.length > 120) throw new Error('Nome obrigatório (até 120 caracteres).');
  if (!ROLES.includes(role)) throw new Error('Perfil: gestor, coordenador ou administrativo.');
  delegation = delegation || null;
  if (delegation && !DELEGATIONS.some(([k]) => k === delegation)) throw new Error('Delegação inválida.');
  if (role === 'coordenador' && !delegation) throw new Error('O coordenador precisa de uma delegação.');
  if (role === 'gestor') delegation = null; // o gestor vê sempre todas
  return { email, name, role, delegation };
}
/** Palavra-passe temporária legível (14 caracteres, sem letras confundíveis): ex. «Kx7m-p4Qr-9tWz». */
export function tempPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(12);
  const s = [...b].map((x) => A[x % A.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** Cria (ou substitui a palavra-passe de) um utilizador. Usado pelos scripts (a palavra-passe é escolhida por quem os corre). */
export async function upsertUser(db, { email, name, password, role, delegation = null }) {
  ({ email, name, role, delegation } = checkUser({ email, name, role, delegation }));
  if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`Palavra-passe com pelo menos ${MIN_PASSWORD} caracteres.`);
  const del = delegation;
  const cur = await db.get('SELECT id FROM users WHERE email=?', [email]);
  if (cur) {
    await db.run('UPDATE users SET name=?, pass_hash=?, role=?, delegation=?, active=1 WHERE id=?', [name.trim(), hashPassword(password), role, del, cur.id]);
    await db.run('DELETE FROM sessions WHERE user_id=?', [cur.id]);
    return cur.id;
  }
  return (await db.run('INSERT INTO users(email,name,pass_hash,role,delegation,created_at) VALUES(?,?,?,?,?,?)',
    [email, name.trim(), hashPassword(password), role, del, new Date().toISOString()])).lastInsertRowid;
}

const hits = new Map();
/** true = permitido. Janela deslizante simples por chave (em memória). */
export function rateLimit(key, max, windowMs) {
  const now = Date.now(); const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v.at(-1) > windowMs) hits.delete(k);
  return arr.length <= max;
}
/** Limite de tentativas persistido na BD (funciona em serverless, onde a memória não é partilhada). */
export async function attemptAllowed(db, key, max, windowMs) {
  const now = Date.now();
  await db.run('DELETE FROM login_attempts WHERE at<?', [now - windowMs]);
  const n = (await db.get('SELECT COUNT(*) n FROM login_attempts WHERE key=?', [key])).n;
  if (n >= max) return false;
  await db.run('INSERT INTO login_attempts(key,at) VALUES(?,?)', [key, now]);
  return true;
}
export async function login(db, { email, password }, ip) {
  const max = Number(process.env.ALOJ_LOGIN_MAX || 8);
  const mail = String(email ?? '').trim().toLowerCase();
  if (!(await attemptAllowed(db, `ip:${ip}`, max * 3, 15 * 60 * 1000)) || !(await attemptAllowed(db, `u:${mail}`, max, 15 * 60 * 1000))) return { error: 'Demasiadas tentativas. Aguarde 15 minutos.', status: 429 };
  const u = await db.get('SELECT * FROM users WHERE email=? AND active=1', [mail]);
  const ok = u ? verifyPassword(String(password ?? ''), u.pass_hash) : (verifyPassword('x', hashPassword('y')), false);
  if (!u || !ok) return { error: 'Email ou palavra-passe errados.', status: 401 };
  await db.run('DELETE FROM login_attempts WHERE key=?', [`u:${mail}`]);
  const id = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  await db.run('INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES(?,?,?,?)', [id, u.id, csrf, Date.now() + SESSION_MS]);
  return { sid: id, csrf };
}
export async function sessionFrom(db, req) {
  const m = /(?:^|;\s*)asid=([a-f0-9]{64})/.exec(req.headers.cookie ?? '');
  if (!m) return null;
  const s = await db.get(`SELECT s.id sid, s.csrf, s.expires_at, u.id, u.email, u.name, u.role, u.delegation, u.must_change
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.active=1`, [m[1]]);
  if (!s || s.expires_at < Date.now()) { if (s) await db.run('DELETE FROM sessions WHERE id=?', [s.sid]); return null; }
  return s;
}

/**
 * Código de autorização do gestor: os coordenadores escrevem-no para editar dados de uma casa. Guardado em hash (scrypt).
 * Não há código por omissão: numa BD nova nada fica autorizado até o gestor o definir em «Definições».
 * TEST_AUTH_CODE só é gravado pelos dados de teste (scripts/seed-demo.js).
 */
export const TEST_AUTH_CODE = 'fonsat1234';
export const MIN_AUTH_CODE = 6;
export async function authCodeHash(db) {
  return (await db.get("SELECT value FROM settings WHERE key='auth_code'"))?.value ?? null;
}
export async function setAuthCode(db, code) {
  if (String(code ?? '').length < MIN_AUTH_CODE) throw new Error(`O código tem de ter pelo menos ${MIN_AUTH_CODE} caracteres.`);
  await db.run("INSERT INTO settings(key,value) VALUES('auth_code',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [hashPassword(String(code))]);
}
