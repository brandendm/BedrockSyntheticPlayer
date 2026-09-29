// A player's jump, with the game's movement numbers (the ones tests/helpers.js McBody uses): what
// the motor needs to jump a gap like a player does. Walk or sprint for it (the slowest that makes
// it: a sprint-jump onto a pillar just goes over it), and in the air, forward, nothing or back to
// come down on the landing block rather than past it.
//
// Per tick in the air: the horizontal speed gains 0.0196 (0.0255 sprinting) in the held direction
// and keeps 0.91 of itself; the vertical is (vy - 0.08) x 0.98. On the ground it keeps 0.546 and
// gains 0.098 walking / 0.1274 sprinting. A jump starts at 0.42 up; a sprint-jump adds 0.2 along.

export const AIR_KEEP = 0.91;
export const GROUND_KEEP = 0.546;
const AIR_PUSH = { walk: 0.0196, sprint: 0.02548 };
const GROUND_PUSH = { walk: 0.098, sprint: 0.1274 };

/**
 * Flying on from now: where along the way (blocks from here) the feet come down to `landDy` above
 * where they are, holding `hold` (1 forward, 0 nothing, -1 back) the whole way. v: the speed along
 * (blocks a tick, as moved last tick), vy: the last tick's rise. null if it never gets that high.
 */
export function landingAlong(v, vy, landDy, hold = 0, sprint = false, maxTicks = 80) {
  let x = 0, y = 0;
  let sv = v * AIR_KEEP, svy = (vy - 0.08) * 0.98; // (what's carried into the next tick)
  const a = AIR_PUSH[sprint ? 'sprint' : 'walk'] * hold;
  for (let t = 0; t < maxTicks; t++) {
    sv += a;
    const ny = y + svy;
    if (svy < 0 && ny <= landDy) {
      // Down onto it partway through this tick's move.
      const f = (y - landDy) / Math.max(1e-6, y - ny);
      return x + sv * f;
    }
    x += sv; y = ny;
    svy = (svy - 0.08) * 0.98;
    sv *= AIR_KEEP;
  }
  return null;
}

/** How far a jump from a steady walk or sprint carries before the feet are down at landDy (holding forward). */
export function jumpReach(gait, landDy) {
  // The take-off tick: on the ground (its push and its friction), then the air.
  const v0 = GROUND_PUSH[gait] * GROUND_KEEP / (1 - GROUND_KEEP); // the speed carried at a steady run
  const first = v0 + GROUND_PUSH[gait] + (gait === 'sprint' ? 0.2 : 0);
  const rest = landingAlong(first * GROUND_KEEP / AIR_KEEP, 0.42, landDy - 0.42, 1, gait === 'sprint');
  return rest === null ? 0 : first + rest;
}

/**
 * Walk or sprint for a gap of `gap` blocks landing `dy` up or down: the walk if it carries well onto
 * the landing block (its near half and a bit; the air control does the rest), else the sprint.
 * From the take-off edge the landing block's middle is gap + 0.5 on.
 */
const GAIT = new Map();
export function gaitFor(gap, dy) {
  const k = `${gap},${dy}`;
  if (!GAIT.has(k)) GAIT.set(k, jumpReach('walk', dy) >= gap + 0.55 ? 'walk' : 'sprint');
  return GAIT.get(k);
}

/**
 * How far a jump taken now carries (feet down at landDy), from the speed along we're moving at
 * (v: blocks moved along last tick, on the ground), holding forward.
 */
export function reachFrom(v, gait, landDy) {
  const first = Math.max(0, v) * GROUND_KEEP + GROUND_PUSH[gait] + (gait === 'sprint' ? 0.2 : 0);
  const rest = landingAlong(first * GROUND_KEEP / AIR_KEEP, 0.42, landDy - 0.42, 1, gait === 'sprint');
  return rest === null ? 0 : first + rest;
}
