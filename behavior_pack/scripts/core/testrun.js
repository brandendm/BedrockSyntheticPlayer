// How a test was done, as numbers, so the bot's run and a player's run of the same test can be set side by side. Pure (unit-tested).
//
// samples: [{ t (tick), x, y, z, g (on the ground), sn (sneaking), sp (sprinting), hp, yw (yaw), pt (pitch), w (in water), cl (climbing),
//             sl (hotbar slot), hd (what is held) }] every 2 ticks of whoever is doing the test.
// counts:  { placed, broken, inv: { gained, spent } } the blocks they placed and broke while it ran, and what the pack gained and lost.
// events:  [[seconds in, kind, ...]] p place (block, x, y, z, held) b break (block, x, y, z, held) h hit (what) d damage dealt (what, hp)
//          D damage taken (cause, hp, by) k kill (what) u item used (item) U use started (item) R use released (item) e eaten (item)
//          i block used (block, held) I entity used (what, held)
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const r1 = (v) => Math.round(v * 10) / 10;

export function summarise(samples, counts = {}, events = []) {
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
  const tech = technique(S, events);
  return {
    secs: r1(secs), path: r1(path), straight: r1(straight), directness: path > 0.5 ? r1(straight / path) : 1,
    jumps, climbed: r1(climbed), range: r1(maxY - minY), sprintS: r1(sprint), sneakS: r1(sneak), idleS: r1(idle), damage: r1(damage),
    ...tech, inv: counts.inv ?? null,
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
  if (Number.isFinite(bot.firstActionS) && Number.isFinite(human.firstActionS) && bot.firstActionS > human.firstActionS + 1.5) notes.push(`it took ${r1(bot.firstActionS - human.firstActionS)} s longer to start`);
  if (Number.isFinite(bot.stillNoActionS) && Number.isFinite(human.stillNoActionS) && bot.stillNoActionS > human.stillNoActionS + 3) notes.push(`it stood doing nothing ${r1(bot.stillNoActionS - human.stillNoActionS)} s more`);
  if (bot.avgSpeed && human.avgSpeed && bot.avgSpeed < human.avgSpeed * 0.8) notes.push(`it moved at ${bot.avgSpeed} blocks/s to your ${human.avgSpeed}`);
  if (bot.turnYawDeg > human.turnYawDeg * 1.6 + 90) notes.push('it turned its view far more');
  return `${name}: ${line('you', human)} | ${line('bot', bot)}${notes.length ? ` | ${notes.join('; ')}` : ''}`;
}

/** A path kept for drawing: at most `max` points [seconds since the start, x, y, z], always including the last. */
export function downsample(samples, max = 240) {
  if (!samples?.length) return [];
  const t0 = samples[0].t, step = Math.max(1, Math.ceil(samples.length / max));
  const pt = (s) => {
    const p = [r1((s.t - t0) / 20), r1(s.x), r1(s.y), r1(s.z)];
    if (Number.isFinite(s.yw)) {
      // + yaw, pitch, flags (1 ground, 2 sneak, 4 sprint, 8 water, 16 climbing), hotbar slot
      p.push(Math.round(s.yw), Math.round(s.pt ?? 0), (s.g ? 1 : 0) | (s.sn ? 2 : 0) | (s.sp ? 4 : 0) | (s.w ? 8 : 0) | (s.cl ? 16 : 0), s.sl ?? 0);
    }
    return p;
  };
  const out = [];
  for (let i = 0; i < samples.length; i += step) out.push(pt(samples[i]));
  const l = samples[samples.length - 1];
  if (out[out.length - 1][0] !== r1((l.t - t0) / 20)) out.push(pt(l));
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

/** Count one finished run into the lifetime stats: { <test>: { human?: {p, n, last}, bot?: {...} } }. Returns the stats. */
export function addStat(stats, name, who, pass, at = 0, build = '') {
  const s = ((stats[name] ??= {})[who] ??= { p: 0, n: 0, last: null });
  s.n++; if (pass) s.p++;
  s.last = { pass: !!pass, at, build };
  return stats;
}

/** Average pass rate over every counted run each side ever did: { human: {pass, total, pct}, bot: {...} }; omitted tests left out. */
export function avgRates(stats, omit = []) {
  const skip = new Set(omit);
  const out = { human: { pass: 0, total: 0, pct: null }, bot: { pass: 0, total: 0, pct: null } };
  for (const [name, r] of Object.entries(stats ?? {})) {
    if (skip.has(name)) continue;
    for (const who of /** @type {const} */ (['human', 'bot'])) if (r?.[who]) { out[who].pass += r[who].p; out[who].total += r[who].n; }
  }
  for (const who of /** @type {const} */ (['human', 'bot'])) out[who].pct = out[who].total ? Math.round((out[who].pass / out[who].total) * 100) : null;
  return out;
}

const wrap180 = (d) => ((d + 540) % 360) - 180;

/**
 * How it was done, beyond where it went: when the first action came, how fast and how far the view turned, how fast it moved
 * when it moved, what it held and for how long, hotbar changes, time in the air, in water and climbing, and what the events add up to.
 */
export function technique(S, events = []) {
  let turnYaw = 0, turnPitch = 0, maxTurn = 0, air = 0, water = 0, climb = 0, slotChanges = 0, moving = 0, movingSecs = 0, maxSpeed = 0, still = 0;
  const heldTime = {};
  let firstMove = null;
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1], b = S[i], dt = Math.max(0.05, (b.t - a.t) / 20);
    const sp = Math.hypot(b.x - a.x, b.z - a.z) / dt;
    if (sp > 0.3) { moving += sp * dt; movingSecs += dt; if (firstMove === null) firstMove = (b.t - S[0].t) / 20; }
    maxSpeed = Math.max(maxSpeed, sp);
    if (Number.isFinite(a.yw) && Number.isFinite(b.yw)) {
      const dy = Math.abs(wrap180(b.yw - a.yw)), dp = Math.abs((b.pt ?? 0) - (a.pt ?? 0));
      turnYaw += dy; turnPitch += dp; maxTurn = Math.max(maxTurn, Math.hypot(dy, dp) / dt);
    }
    if (!b.g && !b.w && !b.cl) air += dt;
    if (b.w) water += dt;
    if (b.cl) climb += dt;
    if (b.sl !== undefined && a.sl !== undefined && b.sl !== a.sl) slotChanges++;
    if (b.hd) heldTime[b.hd] = (heldTime[b.hd] ?? 0) + dt;
    if (sp <= 0.3 && !events.some((e) => e[0] >= (a.t - S[0].t) / 20 && e[0] <= (b.t - S[0].t) / 20)) still += dt;
  }
  const firstEvent = events.length ? events[0][0] : null;
  const firstAction = [firstMove, firstEvent].filter((v) => v !== null).sort((x, y) => x - y)[0] ?? null;
  const by = (kind) => { const o = {}; for (const e of events) if (e[1] === kind) o[e[2]] = (o[e[2]] ?? 0) + 1; return o; };
  const sum = (kind, idx) => events.filter((e) => e[1] === kind).reduce((a, e) => a + (Number(e[idx]) || 0), 0);
  const top = (o, n = 5) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, r1(v)]));
  return {
    firstActionS: firstAction === null ? null : r1(firstAction),
    avgSpeed: movingSecs > 0 ? r1(moving / movingSecs) : 0, maxSpeed: r1(maxSpeed), stillNoActionS: r1(still),
    turnYawDeg: Math.round(turnYaw), turnPitchDeg: Math.round(turnPitch), maxTurnDegS: Math.round(maxTurn),
    airS: r1(air), waterS: r1(water), climbS: r1(climb), slotChanges, held: top(heldTime),
    placedBy: top(by('p')), brokenBy: top(by('b')), hits: events.filter((e) => e[1] === 'h').length,
    dealt: r1(sum('d', 3)), taken: r1(sum('D', 3)), kills: events.filter((e) => e[1] === 'k').length,
    uses: events.filter((e) => 'uUR'.includes(e[1]) && e[1] !== 'U').length, interacts: events.filter((e) => e[1] === 'i' || e[1] === 'I').length,
    eaten: events.filter((e) => e[1] === 'e').length,
  };
}
