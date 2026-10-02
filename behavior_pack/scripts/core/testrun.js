// How a test was done, as numbers, so the bot's run and a player's run of the same test can be set side by side. Pure (unit-tested).
//
// samples: [{ t (tick), x, y, z, g (on the ground), sn (sneaking), sp (sprinting), hp }] every 5 ticks of whoever is doing the test.
// counts:  { placed, broken } the blocks they placed and broke while it ran.
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const r1 = (v) => Math.round(v * 10) / 10;

export function summarise(samples, counts = {}) {
  if (!samples || samples.length < 2) return null;
  const S = samples;
  let path = 0, jumps = 0, climbed = 0, sprint = 0, sneak = 0, idle = 0, damage = 0, maxY = S[0].y, minY = S[0].y, hops = 0;
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1], b = S[i], dt = Math.max(0.05, (b.t - a.t) / 20);
    const step = Math.hypot(b.x - a.x, b.z - a.z), v = step / dt;
    path += Math.hypot(step, b.y - a.y);
    if (a.g && !b.g && b.y - a.y > 0.1) jumps++;
    if (b.y - a.y > 0.5 && !b.g) hops++;
    if (b.y > a.y) climbed += b.y - a.y;
    if (b.sp) sprint += dt;
    if (b.sn) sneak += dt;
    if (v < 0.25) idle += dt;
    if (Number.isFinite(a.hp) && Number.isFinite(b.hp) && b.hp < a.hp) damage += a.hp - b.hp;
    maxY = Math.max(maxY, b.y); minY = Math.min(minY, b.y);
  }
  const secs = (S[S.length - 1].t - S[0].t) / 20;
  const straight = Math.hypot(flat(S[0], S[S.length - 1]), S[S.length - 1].y - S[0].y);
  return {
    secs: r1(secs), path: r1(path), straight: r1(straight), directness: path > 0.5 ? r1(straight / path) : 1,
    jumps, climbed: r1(climbed), range: r1(maxY - minY), sprintS: r1(sprint), sneakS: r1(sneak), idleS: r1(idle), damage: r1(damage),
    placed: counts.placed ?? 0, broken: counts.broken ?? 0, end: { x: r1(S[S.length - 1].x), y: r1(S[S.length - 1].y), z: r1(S[S.length - 1].z) },
  };
}

/** The two runs side by side, one line each and what differs most. */
export function compare(name, human, bot) {
  if (!human || !bot) return null;
  const line = (who, m) => `${who}: ${m.secs} s, ${m.path} blocks walked (${Math.round(m.directness * 100)}% direct), ${m.jumps} jumps, ${m.placed} placed, ${m.broken} broken, ${m.idleS} s standing still, ${m.damage} hp lost`;
  const notes = [];
  if (bot.secs > human.secs * 1.3) notes.push(`the bot took ${Math.round((bot.secs / Math.max(1, human.secs)) * 10) / 10}x as long`);
  if (bot.path > human.path * 1.3) notes.push(`it walked ${Math.round((bot.path / Math.max(1, human.path)) * 10) / 10}x as far`);
  if (bot.idleS > human.idleS + 3) notes.push(`it stood still ${r1(bot.idleS - human.idleS)} s more`);
  if (bot.broken > human.broken + 2) notes.push(`it broke ${bot.broken - human.broken} more blocks`);
  if (bot.placed > human.placed + 2) notes.push(`it placed ${bot.placed - human.placed} more blocks`);
  if (bot.jumps > human.jumps + 3) notes.push(`it jumped ${bot.jumps - human.jumps} more times`);
  if (human.secs > bot.secs * 1.3) notes.push('you were slower');
  return `${name}: ${line('you', human)} | ${line('bot', bot)}${notes.length ? ` | ${notes.join('; ')}` : ''}`;
}

/** A path kept for drawing: at most `max` points [seconds since the start, x, y, z], always including the last. */
export function downsample(samples, max = 240) {
  if (!samples?.length) return [];
  const t0 = samples[0].t, step = Math.max(1, Math.ceil(samples.length / max));
  const out = [];
  for (let i = 0; i < samples.length; i += step) { const s = samples[i]; out.push([r1((s.t - t0) / 20), r1(s.x), r1(s.y), r1(s.z)]); }
  const l = samples[samples.length - 1];
  if (out[out.length - 1][0] !== r1((l.t - t0) / 20)) out.push([r1((l.t - t0) / 20), r1(l.x), r1(l.y), r1(l.z)]);
  return out;
}

/**
 * Pass rate of each side over the last run of each test: { human: {pass, total, pct}, bot: {...} }.
 * runs: { <test>: { human?: {pass}, bot?: {pass} } }; `omit` tests are left out.
 */
export function passRates(runs, omit = []) {
  const skip = new Set(omit);
  const out = { human: { pass: 0, total: 0, pct: null }, bot: { pass: 0, total: 0, pct: null } };
  for (const [name, r] of Object.entries(runs ?? {})) {
    if (skip.has(name)) continue;
    for (const who of /** @type {const} */ (['human', 'bot'])) {
      if (!r?.[who] || r[who].skipped) continue;
      out[who].total++;
      if (r[who].pass) out[who].pass++;
    }
  }
  for (const who of /** @type {const} */ (['human', 'bot'])) out[who].pct = out[who].total ? Math.round((out[who].pass / out[who].total) * 100) : null;
  return out;
}
