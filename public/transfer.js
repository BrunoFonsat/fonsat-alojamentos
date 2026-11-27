// Escolha da casa de destino numa transferência (lógica pura, sem DOM — testada em test/transfer.test.js).

/** Pessoas alojadas numa casa numa data (entrada ≤ data < saída, ou sem saída) — no dia da saída já não conta. */
export const occupiedAt = (stays, houseId, date) =>
  stays.filter((s) => s.house_id === houseId && s.start_date <= date && (!s.end_date || s.end_date > date)).length;

/** Dia seguinte (AAAA-MM-DD). A transferência é, no mínimo, no dia a seguir à entrada. */
export const dayAfter = (d) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };

export const regionKey = (x) => `${x.delegation}|${x.region || ''}`;

/**
 * Casas possíveis para transferir `origin` numa data: só ativas, nunca a própria casa de origem.
 * Devolve as regiões (com quantas casas têm camas livres nessa data) e, por região, três listas:
 *  - free: com camas livres (mais livres primeiro);
 *  - full: cheias ou acima da lotação (entrar aqui pede confirmação);
 *  - unknown: lotação por preencher ou ocupação desconhecida (nunca contam como disponíveis).
 */
export function transferOptions(houses, stays, origin, date) {
  const rows = houses.filter((x) => x.active && x.id !== origin.id).map((x) => {
    const used = occupiedAt(stays, x.id, date), cap = x.capacity ?? null;
    // ocupação desconhecida: nunca teve registos de ocupantes e ninguém confirmou que está vazia
    const occKnown = !!x.occ_checked || stays.some((s) => s.house_id === x.id);
    const known = cap !== null && occKnown;
    return { house: x, used, cap, known, free: known ? cap - used : null, after: used + 1, over: known && used + 1 > cap };
  });
  const regions = new Map();
  for (const r of rows) {
    const k = regionKey(r.house);
    const g = regions.get(k) ?? { key: k, delegation: r.house.delegation, region: r.house.region || '', total: 0, withFree: 0, rows: [] };
    g.total++; if (r.free !== null && r.free > 0) g.withFree++;
    g.rows.push(r); regions.set(k, g);
  }
  const byName = (a, b) => a.house.name.localeCompare(b.house.name, 'pt');
  const list = [...regions.values()].map((g) => ({
    ...g,
    free: g.rows.filter((r) => r.free !== null && r.free > 0).sort((a, b) => b.free - a.free || byName(a, b)),
    full: g.rows.filter((r) => r.free !== null && r.free <= 0).sort((a, b) => b.free - a.free || byName(a, b)),
    unknown: g.rows.filter((r) => r.free === null).sort(byName),
  }));
  // a região da casa de origem primeiro; depois as que têm camas livres; depois por nome
  const home = regionKey(origin);
  list.sort((a, b) => (b.key === home) - (a.key === home) || (b.withFree > 0) - (a.withFree > 0) || a.region.localeCompare(b.region, 'pt') || a.delegation.localeCompare(b.delegation));
  return list;
}
