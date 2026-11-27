import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import { DDL, ADDED_COLUMNS, USERS_DDL } from './schema.js';

const rowObj = (rs, r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]]));
/** Interface mínima (get/all/run) sobre um cliente ou transação libSQL. */
function wrap(ex) {
  return {
    async all(sql, args = []) { const rs = await ex.execute({ sql, args }); return rs.rows.map((r) => rowObj(rs, r)); },
    async get(sql, args = []) { return (await this.all(sql, args))[0]; },
    async run(sql, args = []) { const rs = await ex.execute({ sql, args }); return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) }; },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Liga à BD. Alvo: URL libsql:// / https:// (Turso, com ALOJ_DB_TOKEN) ou caminho de ficheiro local.
 * Variáveis: ALOJ_DB_URL + ALOJ_DB_TOKEN (Turso) | ALOJ_DB (ficheiro, por omissão data/alojamentos.sqlite).
 */
export async function openDb(target = process.env.ALOJ_DB_URL || process.env.ALOJ_DB || 'data/alojamentos.sqlite') {
  const remote = /^(libsql|https?|wss?):/.test(target);
  const url = remote || target.startsWith('file:') ? target : `file:${target}`;
  if (!remote && !target.startsWith('file:')) fs.mkdirSync(path.dirname(target), { recursive: true });
  const client = createClient({ url, authToken: remote ? process.env.ALOJ_DB_TOKEN : undefined });
  const db = wrap(client);
  db.client = client; db.remote = remote;
  db.tx = async (fn) => {
    for (let attempt = 0; ; attempt++) {
      let t;
      try { t = await client.transaction('write'); }
      catch (e) { if (/BUSY|locked/i.test(e.message) && attempt < 40) { await sleep(50); continue; } throw e; }
      try { const r = await fn(wrap(t)); await t.commit(); return r; }
      catch (e) { try { await t.rollback(); } catch { /* já terminada */ } throw e; }
      finally { t.close(); }
    }
  };
  await client.executeMultiple(DDL);
  // migração: perfil «administrativo» e palavra-passe temporária — a tabela users tinha CHECKs antigos; SQLite obriga a recriá-la
  const usersSql = (await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"))?.sql ?? '';
  if (!usersSql.includes('administrativo')) {
    await client.executeMultiple(`PRAGMA foreign_keys=OFF;
      BEGIN;
      ${USERS_DDL}
      INSERT INTO users_mig(id,email,name,pass_hash,role,delegation,active,created_at) SELECT id,email,name,pass_hash,role,CASE WHEN role='gestor' THEN NULL ELSE delegation END,active,created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_mig RENAME TO users;
      COMMIT;
      PRAGMA foreign_keys=ON;`);
  }
  // migração: funcionários sem delegação (pendentes) — a coluna era NOT NULL; SQLite obriga a recriar a tabela
  const wcols = await db.all('PRAGMA table_info(workers)');
  if (wcols.find((c) => c.name === 'delegation')?.notnull) {
    await client.executeMultiple(`PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE workers_mig(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
        delegation TEXT CHECK(delegation IS NULL OR delegation IN ('asturias','catalunha','porto')), profession TEXT NOT NULL DEFAULT '');
      INSERT INTO workers_mig(id,name,phone,company,delegation) SELECT id,name,phone,company,delegation FROM workers;
      DROP TABLE workers;
      ALTER TABLE workers_mig RENAME TO workers;
      COMMIT;
      PRAGMA foreign_keys=ON;`);
  }
  for (const [t, add] of Object.entries(ADDED_COLUMNS)) {
    const have = (await db.all(`PRAGMA table_info(${t})`)).map((c) => c.name);
    for (const [c, def] of Object.entries(add)) if (!have.includes(c)) await db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
  }
  if (!remote) { try { await client.execute('PRAGMA busy_timeout = 5000'); } catch { /* opcional */ } }
  return db;
}
