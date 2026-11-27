import test from 'node:test';
import assert from 'node:assert/strict';
import { transferOptions, occupiedAt, dayAfter } from '../public/transfer.js';

const H = (id, name, region, capacity, extra = {}) => ({ id, name, region, capacity, delegation: 'asturias', active: 1, ...extra });
const S = (house_id, start_date, end_date = null) => ({ house_id, start_date, end_date });

test('transferência: exclui inativas e a casa de origem; separa livres, cheias e lotação desconhecida', () => {
  const origin = H(1, 'Origem', 'Langreo', 4);
  const houses = [origin,
    H(2, 'Livre 2', 'Langreo', 4), H(3, 'Livre 1', 'Langreo', 2), H(4, 'Cheia', 'Langreo', 1), H(5, 'Acima', 'Langreo', 1),
    H(6, 'Sem lotação', 'Langreo', null), H(7, 'Inativa', 'Langreo', 9, { active: 0 }), H(8, 'Oviedo', 'Oviedo', 3)];
  const stays = [S(2, '2026-01-01'), S(2, '2026-01-01'), S(3, '2026-01-01'), S(4, '2026-01-01'), S(5, '2026-01-01'), S(5, '2026-01-01'), S(6, '2026-01-01')];
  const g = transferOptions(houses, stays, origin, '2026-06-01');
  assert.equal(g[0].region, 'Langreo'); // região da casa de origem primeiro
  const lg = g[0];
  assert.deepEqual(lg.free.map((r) => r.house.name), ['Livre 2', 'Livre 1']); // mais camas livres primeiro
  assert.deepEqual(lg.full.map((r) => r.house.name), ['Cheia', 'Acima']);
  assert.deepEqual(lg.unknown.map((r) => r.house.name), ['Sem lotação']);
  assert.equal(lg.withFree, 2);
  const all = g.flatMap((x) => x.rows.map((r) => r.house.id));
  assert.ok(!all.includes(1) && !all.includes(7)); // nem a origem nem a inativa
  // ocupação resultante e aviso de lotação
  const cheia = lg.full.find((r) => r.house.id === 4);
  assert.deepEqual([cheia.used, cheia.after, cheia.over], [1, 2, true]);
  assert.equal(lg.unknown[0].over, false); // lotação desconhecida nunca é «acima»
});

test('transferência: disponibilidade calculada à data escolhida', () => {
  const origin = H(1, 'Origem', 'A', 2);
  const houses = [origin, H(2, 'Destino', 'A', 1)];
  const stays = [S(2, '2026-01-01', '2026-03-31'), S(2, '2026-06-01')]; // sai em março; outro entra em junho
  assert.equal(occupiedAt(stays, 2, '2026-03-30'), 1);
  assert.equal(occupiedAt(stays, 2, '2026-03-31'), 0); // no dia da saída já não conta
  assert.equal(transferOptions(houses, stays, origin, '2026-04-15')[0].free.length, 1); // livre em abril
  assert.equal(transferOptions(houses, stays, origin, '2026-02-01')[0].full.length, 1); // cheia em fevereiro
  assert.equal(transferOptions(houses, stays, origin, '2026-07-01')[0].full.length, 1); // cheia em julho
  assert.equal(dayAfter('2026-02-28'), '2026-03-01');
});

test('transferência: casa sem registos de ocupantes (ocupação desconhecida) não conta como disponível, até ser confirmada vazia', () => {
  const origin = H(1, 'Origem', 'A', 2);
  const nunca = H(2, 'Nunca registada', 'A', 6);
  const confirmada = H(3, 'Confirmada vazia', 'A', 6, { occ_checked: '2026-11-26' });
  const g = transferOptions([origin, nunca, confirmada], [S(1, '2026-01-01')], origin, '2026-12-01')[0];
  assert.deepEqual(g.free.map((r) => r.house.name), ['Confirmada vazia']);
  assert.deepEqual(g.unknown.map((r) => r.house.name), ['Nunca registada']);
  assert.equal(g.unknown[0].over, false);
  assert.equal(g.withFree, 1);
});
