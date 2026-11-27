// Dados de TESTE (fictícios) para experimentar a aplicação antes de entrar com dados reais.
// Uso: npm run seed:demo            → só numa BD vazia
//      npm run seed:demo -- --reset → apaga TODOS os dados da BD local e volta a criar os de teste
// Por segurança não corre numa BD remota (Turso) sem ALOJ_SEED_REMOTE=sim.
import { openDb } from '../src/server/db.js';
import { upsertUser, setAuthCode, TEST_AUTH_CODE } from '../src/server/auth.js';

const reset = process.argv.includes('--reset');
const db = await openDb();
if (db.remote && process.env.ALOJ_SEED_REMOTE !== 'sim') { console.error('BD remota: dados de teste recusados (defina ALOJ_SEED_REMOTE=sim se for mesmo uma BD de testes).'); process.exit(1); }
if (db.remote && reset) { console.error('--reset não é permitido numa BD remota.'); process.exit(1); }
const n = (await db.get('SELECT COUNT(*) n FROM houses')).n;
if (n && !reset) { console.error(`A BD já tem ${n} casas. Use --reset para apagar tudo e recriar os dados de teste.`); process.exit(1); }
if (reset) for (const t of ['settings', 'audit', 'stays', 'expense_adjustments', 'workers', 'houses', 'sessions', 'users', 'login_attempts']) await db.run(`DELETE FROM ${t}`);

// ---------- datas relativas a hoje ----------
const pad = (x) => String(x).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return iso(d); };
const month = (offset) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset); return iso(d).slice(0, 7); };
const maps = (addr) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;

// ---------- utilizadores de teste ----------
const PW = 'fonsat1234';
const users = [
  { email: 'gerencia@fonsat.pt', name: 'Gestor (teste)', role: 'gestor' },
  { email: 'coord.asturias@teste.local', name: 'Coordenador Astúrias (teste)', role: 'coordenador', delegation: 'asturias' },
  { email: 'coord.catalunha@teste.local', name: 'Coordenador Catalunha (teste)', role: 'coordenador', delegation: 'catalunha' },
  { email: 'coord.porto@teste.local', name: 'Coordenador Porto (teste)', role: 'coordenador', delegation: 'porto' },
];
for (const u of users) await upsertUser(db, { ...u, password: PW });
// código de autorização SÓ de teste (numa BD real não há código até o gestor o definir em «Definições»)
await setAuthCode(db, TEST_AUTH_CODE);

// ---------- casas (fictícias) ----------
// [nome, delegação, região, morada, aluguer, despesas fixas, lotação, quartos, proprietário, início contrato, fim contrato, caução, caução disponível, ativa]
const H = [
  ['Oviedo Uría 2ºB', 'asturias', 'Oviedo', 'Calle Uría 20, 2ºB, 33003 Oviedo', 750, 220, 4, 2, 'Propietario Ejemplo 1', day(-400), day(330), 1500, 1, 1],
  ['Oviedo Pumarín 1ºA', 'asturias', 'Oviedo', 'Calle Pumarín 5, 1ºA, 33011 Oviedo', 600, 180, 3, 2, 'Propietario Ejemplo 2', day(-300), day(40), 1200, 1, 1],
  ['Gijón Calzada 3ºD', 'asturias', 'Gijón', 'Avenida de la Argentina 40, 3ºD, 33213 Gijón', 650, 200, 4, 2, 'Propietario Ejemplo 3', day(-200), day(500), 1300, 0, 1],
  ['Avilés Centro 4ºC', 'asturias', 'Avilés', 'Calle La Cámara 15, 4ºC, 33402 Avilés', 520, 160, 3, 2, 'Propietario Ejemplo 4', day(-500), day(-15), 1000, 1, 1],
  ['Santander Castilla 2ºA', 'asturias', 'Santander', 'Calle Castilla 30, 2ºA, 39009 Santander', 800, 240, 5, 3, 'Propietario Ejemplo 5', day(-120), day(600), null, 0, 1],
  ['Barcelona Sants 1º2ª', 'catalunha', 'Barcelona', 'Carrer de Sants 100, 1º 2ª, 08014 Barcelona', 1100, 300, 4, 2, 'Propietari Exemple 1', day(-250), day(480), 2200, 1, 1],
  ["L'Hospitalet Collblanc 3º1ª", 'catalunha', "L'Hospitalet de Llobregat", 'Carrer de Collblanc 50, 3º 1ª, 08904 L\'Hospitalet de Llobregat', 950, 260, 4, 3, 'Propietari Exemple 2', day(-180), day(25), 1900, 1, 1],
  ['Tarragona Rambla 2ºB', 'catalunha', 'Tarragona', 'Rambla Nova 60, 2ºB, 43001 Tarragona', 700, 200, 3, 2, 'Propietari Exemple 3', day(-90), day(640), 1400, 0, 1],
  ['Lleida Pardinyes 1ºA', 'catalunha', 'Lleida', 'Carrer del Bisbe Ruano 12, 1ºA, 25005 Lleida', 550, 170, 3, 2, 'Propietari Exemple 4', day(-60), null, null, 0, 1],
  ['Girona Santa Eugènia 2º', 'catalunha', 'Girona', 'Carrer de Santa Eugènia 80, 2º, 17005 Girona', 680, 190, 3, 2, 'Propietari Exemple 5', day(-700), day(-100), 1300, 0, 0],
  ['Porto Bonfim 2º Esq', 'porto', 'Porto', 'Rua do Bonfim 150, 2º Esq, 4300-069 Porto', 900, 210, 4, 2, 'Proprietário Exemplo 1', day(-365), day(365), 1800, 1, 1],
  ['Gaia Mafamude R/C', 'porto', 'Vila Nova de Gaia', 'Avenida da República 900, R/C, 4430-190 Vila Nova de Gaia', 750, 180, 3, 2, 'Proprietário Exemplo 2', day(-150), day(215), 1500, 1, 1],
  ['Matosinhos Sr.ª da Hora 1º Dto', 'porto', 'Matosinhos', 'Rua Dr. Afonso Cordeiro 300, 1º Dto, 4450-007 Matosinhos', 820, 200, 4, 3, 'Proprietário Exemplo 3', day(-30), day(700), 1640, 1, 1],
];
const houseId = {};
for (const [name, delegation, region, address, rent, fixed, cap, rooms, owner, cs, ce, dep, depAv, active] of H) {
  houseId[name] = (await db.run(`INSERT INTO houses(name,delegation,region,address,location_url,rent,fixed_expenses,capacity,rooms,owner_name,contract_start,contract_end,deposit_amount,deposit_available,active,notes)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [name, delegation, region, address, maps(address), rent, fixed, cap, rooms, owner, cs, ce, dep, depAv, active, 'Dados de teste'])).lastInsertRowid;
}

// ---------- funcionários (nomes inventados) ----------
const W = {
  asturias: ['Adrián Fernández', 'Pablo Menéndez', 'Javier Álvarez', 'Diego Suárez', 'Marcos García', 'Iván Rodríguez', 'Sergio Martínez', 'Rubén López', 'Hugo Pérez', 'Álvaro González', 'Daniel Sánchez', 'Carlos Díaz', 'Mario Gutiérrez', 'Óscar Iglesias'],
  catalunha: ['Jordi Puig', 'Marc Soler', 'Pau Ferrer', 'Arnau Vidal', 'Pol Serra', 'Oriol Roca', 'Joan Pujol', 'Albert Mas', 'Xavier Font', 'Enric Sala', 'David Ruiz', 'Gerard Costa'],
  porto: ['João Silva', 'Pedro Santos', 'Tiago Ferreira', 'Rui Oliveira', 'Nuno Costa', 'Bruno Pereira', 'André Martins', 'Hugo Sousa', 'Filipe Rocha', 'Ricardo Lopes'],
};
const companies = ['Obra Oviedo Norte', 'Obra Gijón Puerto', 'Obra Barcelona Diagonal', 'Obra Tarragona Industrial', 'Obra Porto Campanhã', 'Obra Gaia Marginal'];
const workerId = {};
let k = 0;
for (const [del, names] of Object.entries(W)) for (const name of names) {
  workerId[name] = (await db.run('INSERT INTO workers(name,phone,company,delegation) VALUES(?,?,?,?)', [name, '', companies[k++ % companies.length], del])).lastInsertRowid;
}

// ---------- estadias: [funcionário, casa, entrada (dias a partir de hoje), motivo, saída?, motivo saída?] ----------
const S = [
  // Oviedo Uría: 4 de 4 (cheia)
  ['Adrián Fernández', 'Oviedo Uría 2ºB', -200, 'Início de obra'], ['Pablo Menéndez', 'Oviedo Uría 2ºB', -150, 'Início de obra'],
  ['Javier Álvarez', 'Oviedo Uría 2ºB', -60, 'Novo colaborador'], ['Diego Suárez', 'Oviedo Uría 2ºB', -10, 'Transferência'],
  // Diego veio de Pumarín (transferência)
  ['Diego Suárez', 'Oviedo Pumarín 1ºA', -120, 'Início de obra', -11, 'Transferência'],
  // Pumarín: 2 de 3
  ['Marcos García', 'Oviedo Pumarín 1ºA', -90, 'Início de obra'], ['Iván Rodríguez', 'Oviedo Pumarín 1ºA', -45, 'Novo colaborador'],
  // Gijón: 5 de 4 (acima da lotação)
  ['Sergio Martínez', 'Gijón Calzada 3ºD', -180, 'Início de obra'], ['Rubén López', 'Gijón Calzada 3ºD', -170, 'Início de obra'],
  ['Hugo Pérez', 'Gijón Calzada 3ºD', -100, 'Início de obra'], ['Álvaro González', 'Gijón Calzada 3ºD', -30, 'Reforço de equipa'],
  ['Daniel Sánchez', 'Gijón Calzada 3ºD', -5, 'Reforço de equipa'],
  // Avilés: contrato terminado, 1 pessoa ainda lá
  ['Carlos Díaz', 'Avilés Centro 4ºC', -300, 'Início de obra'],
  ['Mario Gutiérrez', 'Avilés Centro 4ºC', -300, 'Início de obra', -40, 'Fim de obra'],
  // Santander: 1 de 5
  ['Óscar Iglesias', 'Santander Castilla 2ºA', -20, 'Início de obra'],
  // Barcelona: 3 de 4
  ['Jordi Puig', 'Barcelona Sants 1º2ª', -240, 'Início de obra'], ['Marc Soler', 'Barcelona Sants 1º2ª', -200, 'Início de obra'],
  ['Pau Ferrer', 'Barcelona Sants 1º2ª', -50, 'Novo colaborador'],
  ['Arnau Vidal', 'Barcelona Sants 1º2ª', -230, 'Início de obra', -70, 'Fim de contrato'],
  // L'Hospitalet: 4 de 4, contrato a acabar em 25 dias
  ['Pol Serra', "L'Hospitalet Collblanc 3º1ª", -170, 'Início de obra'], ['Oriol Roca', "L'Hospitalet Collblanc 3º1ª", -160, 'Início de obra'],
  ['Joan Pujol', "L'Hospitalet Collblanc 3º1ª", -80, 'Início de obra'], ['Albert Mas', "L'Hospitalet Collblanc 3º1ª", -15, 'Transferência'],
  ['Albert Mas', 'Tarragona Rambla 2ºB', -85, 'Início de obra', -16, 'Transferência'],
  // Tarragona: 2 de 3
  ['Xavier Font', 'Tarragona Rambla 2ºB', -80, 'Início de obra'], ['Enric Sala', 'Tarragona Rambla 2ºB', -40, 'Novo colaborador'],
  // Lleida: vazia (David e Gerard saíram)
  ['David Ruiz', 'Lleida Pardinyes 1ºA', -55, 'Início de obra', -8, 'Fim de obra'],
  ['Gerard Costa', 'Lleida Pardinyes 1ºA', -55, 'Início de obra', -8, 'Fim de obra'],
  // Girona (inativa): histórico antigo
  ['Gerard Costa', 'Girona Santa Eugènia 2º', -400, 'Início de obra', -120, 'Fim de contrato da casa'],
  // Porto Bonfim: 4 de 4
  ['João Silva', 'Porto Bonfim 2º Esq', -330, 'Início de obra'], ['Pedro Santos', 'Porto Bonfim 2º Esq', -300, 'Início de obra'],
  ['Tiago Ferreira', 'Porto Bonfim 2º Esq', -120, 'Novo colaborador'], ['Rui Oliveira', 'Porto Bonfim 2º Esq', -25, 'Regresso de férias'],
  ['Rui Oliveira', 'Porto Bonfim 2º Esq', -320, 'Início de obra', -60, 'Férias'],
  // Gaia: 2 de 3
  ['Nuno Costa', 'Gaia Mafamude R/C', -140, 'Início de obra'], ['Bruno Pereira', 'Gaia Mafamude R/C', -100, 'Início de obra'],
  ['André Martins', 'Gaia Mafamude R/C', -140, 'Início de obra', -30, 'Despedimento'],
  // Matosinhos: 1 de 4 (Hugo Sousa; Filipe e Ricardo sem casa)
  ['Hugo Sousa', 'Matosinhos Sr.ª da Hora 1º Dto', -28, 'Início de obra'],
];
for (const [w, h, start, reason, end, exitReason] of S) {
  await db.run('INSERT INTO stays(house_id,worker_id,start_date,entry_reason,end_date,exit_reason) VALUES(?,?,?,?,?,?)',
    [houseId[h], workerId[w], day(start), reason, end === undefined ? null : day(end), exitReason ?? '']);
}

// ---------- acertos de despesas (valor real de alguns meses) ----------
const A = [
  ['Oviedo Uría 2ºB', 0, 260, 'Luz mais alta (aquecimento)'], ['Oviedo Uría 2ºB', -1, 235, ''],
  ['Gijón Calzada 3ºD', 0, 310, 'Mais pessoas, mais consumos'], ['Barcelona Sants 1º2ª', -1, 280, ''],
  ['Porto Bonfim 2º Esq', 0, 240, 'Reparação do esquentador'],
];
for (const [h, m, v, note] of A) await db.run('INSERT INTO expense_adjustments(house_id,month,value,note) VALUES(?,?,?,?)', [houseId[h], month(m), v, note]);

await db.run(`INSERT INTO audit(at,user_id,user_name,entity,action,summary) VALUES(?,?,?,?,?,?)`, [new Date().toISOString(), null, 'Sistema', 'seed', 'create', 'Dados de teste criados']);
console.log(`Dados de teste criados: ${H.length} casas, ${Object.keys(workerId).length} funcionários, ${S.length} estadias.\n`);
console.log('Utilizadores de teste (palavra-passe de todos: %s):', PW);
for (const u of users) console.log(`  ${u.role === 'gestor' ? 'Gestor     ' : 'Coordenador'}  ${u.email}`);
console.log('\nCódigo de autorização do gestor (para os coordenadores editarem casas): fonsat1234');
console.log('\nATENÇÃO: antes de usar com dados reais, apague estes dados e troque a palavra-passe do gestor e o código de autorização.');
