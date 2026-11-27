// Cria um utilizador (ou repõe a palavra-passe de um existente).
// Uso: npm run user:create -- <email> "<nome>" <gestor|coordenador|administrativo> [asturias|catalunha|porto]
// (administrativo sem delegação = vê todas)
// A palavra-passe é pedida pela variável ALOJ_PASSWORD (não fica no histórico da linha de comandos se usar um ficheiro .env).
import { openDb } from '../src/server/db.js';
import { upsertUser } from '../src/server/auth.js';

const [email, name, role, delegation] = process.argv.slice(2);
const password = process.env.ALOJ_PASSWORD;
if (!email || !name || !role || !password) {
  console.error('Uso: ALOJ_PASSWORD=... npm run user:create -- <email> "<nome>" <gestor|coordenador|administrativo> [asturias|catalunha|porto]');
  process.exit(1);
}
try {
  const db = await openDb();
  await upsertUser(db, { email, name, password, role, delegation });
  console.log(`Utilizador ${email} pronto (${role}${delegation ? `, ${delegation}` : ''}).`);
} catch (e) { console.error(e.message); process.exit(1); }
