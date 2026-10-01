// What the bot takes from watching you play (brain/learn.py works the numbers out of the recordings,
// the brain serves them at /profile). Pure (unit-tested): which learned numbers are good enough to
// use, and kept inside sane limits so a strange recording can't make the bot do something silly.
//
//   eat_at   the food level (out of 20) you eat at: it eats at 14 until it has seen you eat enough times
//   iron_y   the height you mine iron at: it digs down to 16 until it has seen enough iron come out

export const DEFAULTS = Object.freeze({ eat_at: 14, iron_y: 16 });
export const LIMITS = Object.freeze({ eat_at: [8, 18], iron_y: [-56, 40] });
/** Samples needed before a learned number replaces the default. */
export const MIN_SAMPLES = Object.freeze({ eat_at: 6, iron_y: 8 });

/**
 * profile: { params: { name: { value, n } } } (what /profile returns), or null.
 * Returns { params: { name: number }, notes: [what differs from the defaults] }.
 */
export function adopt(profile) {
  const params = { ...DEFAULTS };
  const notes = [];
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const p = profile?.params?.[k];
    if (!p || !Number.isFinite(p.value) || (p.n ?? 0) < MIN_SAMPLES[k]) continue;
    const [lo, hi] = LIMITS[k];
    const v = Math.round(Math.min(hi, Math.max(lo, p.value)));
    params[k] = v;
    if (v !== def) notes.push(`${k} ${def} -> ${v} (from ${p.n} samples of you${v !== Math.round(p.value) ? `, you: ${Math.round(p.value)}, kept within ${lo}..${hi}` : ''})`);
  }
  return { params, notes };
}
