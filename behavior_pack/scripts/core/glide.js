// Gliding with elytra, planned: the pitch to fly each tick so that the glide ends on its feet on the landing spot, as fast as it can.
// Pure (unit-tested; tools/sim_glide.mjs flies it against a model of the game, with the view lagging the command as the motor's does).
//
// The model is the game's elytra step (the Java source's, which Bedrock follows) in the vertical plane along the heading, with the two
// drags fitted to the u204 report: the owner's dive (34 down to 18 deg, up to 22 b/s) and the bot's level glide come out within a few blocks
// over 3 s (tests/glide.test.js replays the owner's). The bot's own run was 8.6 s against his 4: its view was overwritten every tick by the
// idle camera (pitch 0 in the trace for the whole glide), so it flew level, then had to turn back at the far end and sink 8 blocks.
// Pitch is in degrees, positive = nose down; speeds are blocks per tick, vx along the heading toward the landing, vy up.

export const GLIDE = Object.freeze({ g: 0.08, dragX: 0.985, dragY: 0.978 });

/** One tick of a glide at `pitch`: [vx, vy] after it. */
export function glideTick(vx, vy, pitch) {
  const r = (pitch * Math.PI) / 180, c2 = Math.cos(r) ** 2;
  let x = vx, y = vy + GLIDE.g * (-1 + c2 * 0.75);
  if (y < 0) { const d = y * -0.1 * c2; x += d; y += d; }                       // sinking turns into speed along the nose
  if (pitch < 0) { const d = Math.abs(vx) * Math.sin(-r) * 0.04; x -= d; y += d * 3.2; }   // nose up: speed turns into height
  return [x * GLIDE.dragX, y * GLIDE.dragY];
}

/**
 * The pull-out the planner assumes after the dive: nose to `up` until the sink is down to `vl` blocks/tick (0.2 = 4 b/s), then `level`
 * (a shallow descent the last blocks into the ground: about 3.5 b/s down, which is a landing that costs no hearts).
 */
export const FLARE = Object.freeze({ up: -10, vl: 0.2, level: 10 });

/**
 * Where a glide ends if this tick is flown at `first` (null: as the flare would) and the flare follows: { x (blocks on from here), vy
 * (blocks/tick at the ground), ticks }. h = feet above the landing level. The nose stays at `first` for `hold` ticks.
 */
export function touchdown(h, vx, vy, first, F = FLARE, hold = 1) {
  let x = 0, up = true;
  for (let t = 0; t < 400; t++) {
    let p;
    if (first != null && t < hold) p = first;
    else { if (up && vy >= -F.vl) up = false; p = up ? F.up : F.level; }
    [vx, vy] = glideTick(vx, vy, p);
    if (h + vy <= 0) return { x: x + (vy < 0 ? vx * (h / -vy) : 0), vy, ticks: t + 1 };
    h += vy; x += vx;
  }
  return { x, vy, ticks: 400 };
}

/**
 * The pitch for this tick. st: { h, d (flat distance to the landing spot), vx, vy }. Dive as steeply as lets the pull-out still end on the aim
 * point (`aim` short of the spot: the slide after touching down is a block or two) with the sink at the ground no more than `vyTd` blocks/tick
 * (0.3 = 6 b/s); as the dive has to end, the pitch comes up just enough (the touchdown is held at the aim point); too far for that: flat out for
 * range. { pitch, mode: dive | bend | reach | pull, land (the predicted touchdown, blocks on), vyTd }.
 * o: { flare, dive (steepest pitch), aim, vyTd, lag (ticks the view takes to follow a command: the pitch is held that long in the prediction) }.
 */
export function planGlide(st, o = {}) {
  const F = o.flare ?? FLARE, lo = F.up, hi0 = o.dive ?? 40, vMax = o.vyTd ?? 0.25, hold = Math.max(1, o.lag ?? 3);
  const T = st.d - (o.aim ?? 1.5);
  const td = (p) => touchdown(st.h, st.vx, st.vy, p, F, hold);
  const out = (pitch, mode, r) => ({ pitch, mode, land: r.x, vyTd: r.vy });
  let hi = hi0, a = td(hi);
  if (a.vy < -vMax) {                                   // the steepest dive ends in too hard a landing: the steepest that does not
    const b = td(lo);
    if (b.vy < -vMax) return out(lo, 'pull', b);          // too low and too fast to be saved by anything: pull up
    let l = lo, u = hi;
    for (let i = 0; i < 7; i++) { const m = (l + u) / 2; if (td(m).vy >= -vMax) l = m; else u = m; }
    hi = l; a = td(hi);
  }
  if (a.x >= T) return out(hi, hi === hi0 ? 'dive' : 'bend', a);
  const b = td(lo);
  if (b.x <= T) return out(lo, 'reach', b);
  let l = lo, u = hi;                                   // L(l) > T >= L(u): the pitch between that lands on T
  for (let i = 0; i < 7; i++) { const m = (l + u) / 2; if (td(m).x > T) l = m; else u = m; }
  const p = (l + u) / 2;
  return out(p, 'bend', td(p));
}

/** The view's pitch following a command (the motor's critically damped spring, stepped finely): [pitch, rate]. For the simulator and the tests. */
export function followPitch(pitch, rate, target, omega = 11, dt = 0.05) {
  const n = 20, h = dt / n;
  for (let i = 0; i < n; i++) {
    rate += (-2 * omega * rate - omega * omega * (pitch - target)) * h;
    pitch += rate * h;
  }
  return [pitch, rate];
}
