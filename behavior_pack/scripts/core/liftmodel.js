// How a holder who stands above a jammed boat brings it up by jumping, as one formula (u281). Pure (unit-tested).
//
// What the owner taught (and probelift / probewall measured): a lead pulls only once it is longer than about `pull` apart (counting the height difference). Standing ABOVE the boat
// a jump lifts the holder `jump` higher for a moment, which is what stretches the lead past that point: so what matters is the lead's length at the top of the jump,
//     s = hypot(d, h + jump)          d: how far out (flat), h: how far above the boat (negative: below it)
// and how far past `pull` that gets:  e = s - pull.   With e <= 0 a jump pulls nothing, however often you jump: one block up but only two blocks out is hopeless; so is going
// DOWN (h < 0), which only shortens the lead while the boat stays where it is. Each jump moves the boat in proportion to e, and a boat to be raised h needs more than one to be
// brought level:  jumps = ceil((need0 + needPerH * max(0, h)) / e).  A little past `pull` it takes two or three jumps, well past it one; elevation without length is made up by
// walking back (or building) until the lead is long enough: `minLength`.
//
// The numbers are calibrated: `!bot test probejumps` in the real game, then `node sim/fit_lift.mjs --apply` rewrites LIFT below. Until then they are the fit to probelift /
// probewall (a boat 1 high at 6.5 out does not come on one jump; at 7+ it does).

export const LIFT = { pull: 6.3, jump: 0.6, need0: 0.7, needPerH: 0.2, maxJumps: 4 };   // (LIFT: fitted, see sim/fit_lift.mjs)

const lift = (m) => ({ ...LIFT, ...(m ?? {}) });

/** The lead's length at the top of a jump from d out and h above the boat. */
export const apexLength = (h, d, m) => Math.hypot(d, h + lift(m).jump);

/** How far past the pull length the top of the jump gets (<= 0: it pulls nothing). */
export const excess = (h, d, m) => apexLength(h, d, m) - lift(m).pull;

/** Jumps it takes to bring a boat that is `h` below the holder when the holder is `d` out: Infinity if a jump pulls nothing, or it would take more than maxJumps. */
export function jumpsNeeded(h, d, m) {
  const M = lift(m), e = excess(h, d, M);
  if (!(e > 1e-6)) return Infinity;
  const n = Math.ceil((M.need0 + M.needPerH * Math.max(0, h)) / e - 1e-9);
  return n > M.maxJumps ? Infinity : Math.max(1, n);
}

/** The shortest flat distance out at which `jumps` jumps bring it (h above the boat): the lead's length at the top must reach pull + need / jumps. */
export function minLength(h, jumps, m) {
  const M = lift(m), s = M.pull + (M.need0 + M.needPerH * Math.max(0, h)) / Math.max(1, jumps), up = h + M.jump;
  const sq = s * s - up * up;
  return sq > 0 ? Math.sqrt(sq) : 0;
}

/**
 * What to do about a boat jammed below a step `h` high: stand `d` out and jump `jumps` times. `guard` is the longest the lead may be at the top of a jump (it breaks at about 10),
 * `room` the flat distance available out from the boat on the holder's side (omit when unknown). The fewest jumps that fit under the guard are chosen; if even the most does not
 * fit, or there is not the room, `extra` is how much longer the runway must be built. { feasible, jumps, d, extra }
 */
export function liftPlan({ h, guard = 8.8, room = Infinity, model } = {}) {
  const M = lift(model);
  const reach = (n) => Math.min(room, Math.sqrt(Math.max(0, (guard * guard) - (Math.max(0, h) + M.jump) ** 2)) - 0.0);   // how far out the guard allows at the top of the jump
  for (let n = 1; n <= M.maxJumps; n++) {
    const d = minLength(h, n, M);
    if (d <= reach(n) + 1e-9) return { feasible: true, jumps: n, d: Math.round(d * 10) / 10, extra: 0 };
  }
  const n = M.maxJumps, d = minLength(h, n, M);
  const guardReach = Math.sqrt(Math.max(0, guard * guard - (Math.max(0, h) + M.jump) ** 2));
  return { feasible: false, jumps: n, d: Math.round(Math.min(d, guardReach) * 10) / 10, extra: Math.max(0, Math.round((Math.min(d, guardReach) - (Number.isFinite(room) ? room : 0)) * 10) / 10) };
}

/**
 * Fit the constants to trials: [{ h, d, jumps }] where jumps is how many it really took (0 = it never came in the most tried). Grid search over pull / jump / need0 / needPerH
 * for the fewest wrong predictions (ties: the smallest summed error). Returns { model, wrong, total }.
 */
export function fitLift(trials, { maxTried = 4 } = {}) {
  const T = trials.filter((t) => Number.isFinite(t.h) && Number.isFinite(t.d) && Number.isFinite(t.jumps));
  let best = null;
  const range = (a, b, st) => { const o = []; for (let v = a; v <= b + 1e-9; v += st) o.push(Math.round(v * 100) / 100); return o; };
  for (const pull of range(4.8, 6.6, 0.1)) for (const jump of range(0.6, 1.4, 0.1)) for (const need0 of range(0.3, 2.5, 0.1)) for (const needPerH of range(0, 1.2, 0.1)) {
    const m = { pull, jump, need0, needPerH, maxJumps: maxTried };
    let wrong = 0, err = 0;
    for (const t of T) {
      const p = jumpsNeeded(t.h, t.d, m), pj = Number.isFinite(p) ? p : 0;
      if (pj !== t.jumps) { wrong++; err += Math.abs(pj - t.jumps); }
    }
    if (!best || wrong < best.wrong || (wrong === best.wrong && err < best.err)) best = { model: { pull, jump, need0, needPerH, maxJumps: LIFT.maxJumps }, wrong, err };
  }
  return best ? { model: best.model, wrong: best.wrong, total: T.length } : null;
}
