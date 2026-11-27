// Comparação de nomes de pessoas para não repetir funcionários entre listas com escritas diferentes
// (acentos, uma letra trocada, apelidos a mais ou a menos, ordem diferente). Usado pelos scripts de importação.

const PARTICLES = new Set(['DA', 'DE', 'DO', 'DOS', 'DAS', 'DEL', 'LA', 'Y', 'E']);

/** Maiúsculas, sem acentos nem pontuação. */
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Palavras do nome, sem partículas (da, de, dos…). */
export const toks = (s) => norm(s).split(' ').filter((t) => t && !PARTICLES.has(t));

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** Duas palavras «iguais»: iguais, ou com 4+ letras e no máximo ~30 % de diferença (GRACIANO/GARCIANO, WELITON/WELINTON). */
export const tokSim = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && 1 - lev(a, b) / Math.max(a.length, b.length) >= 0.7);

/** Quantas palavras do nome mais curto aparecem (iguais ou quase) no mais comprido, sem importar a ordem. */
export function score(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Set(); let m = 0;
  for (const t of s) { const k = l.findIndex((u, i) => !used.has(i) && tokSim(t, u)); if (k >= 0) { used.add(k); m++; } }
  return { m, short: s.length, long: l.length };
}

/**
 * Compara dois nomes: 'exact' (iguais sem acentos) · 'full' (todas as palavras do mais curto batem) ·
 * 'maybe' (falta uma palavra — duvidoso) · null (pessoas diferentes).
 * Dois nomes contra quatro ou mais nunca é 'full' (demasiado vago: «Pedro Santos»).
 */
export function compareNames(a, b) {
  if (norm(a) === norm(b)) return { kind: 'exact', m: 99, short: 1, long: 1 };
  const c = score(toks(a), toks(b));
  if (c.m < 2 || (c.short === 2 && c.long > 3)) return { kind: null, ...c };
  if (c.m === c.short) return { kind: 'full', ...c };
  if (c.m >= c.short - 1 && c.short >= 3) return { kind: 'maybe', ...c };
  return { kind: null, ...c };
}
