// Crossing water by boat: the pure rules behind game/boating.js and Skills.travelToward (unit-tested, tests/boating.test.js).
//
// The u204 boatcross run (bot 46 s and "boat: not used", you 8.5 s): the lake was not the whole width of the slab (a strip of grass
// was left each side, the glass wall cut away), so the walking search found a way round and never met water; and even with the water
// in the way, the search is told to finish within 8 blocks of a target that is 4 past the far shore, so its path ENDED IN THE LAKE:
// the "water ahead" check wanted a dry cell after the water and found none. Everything here is what that needed.

/** Wet cells in a row it takes before a walk is crossed by boat instead (a pond is swum). */
export const MIN_WET_RUN = 8;

/**
 * The first stretch of `minRun` or more wet cells in a path: { a: index of its first wet cell, b: index of the first dry cell after it, or
 * -1 when the path ENDS in the water (the search stopped within its tolerance of a far target, out in the lake) }. null: no such stretch.
 * @param {boolean[]} wet one flag per path cell
 */
export function wetRun(wet, minRun = MIN_WET_RUN) {
  let run = 0, found = null;
  for (let i = 0; i < wet.length; i++) {
    if (wet[i]) { run++; if (run >= minRun && !found) found = { a: i - run + 1, b: -1 }; }
    else { if (found && found.b < 0) { found.b = i; break; } run = 0; }
  }
  return found;
}

/**
 * Shore and far shore from samples taken along a straight line, `step` blocks apart, starting at `from` (a dry place: the line's start counts as
 * land, which it did not before: standing AT the water's edge, the probe saw water first and never had a shore to leave from, so it found
 * nothing). Each sample { k: 'land' | 'water' | 'bad', ...position }; the far shore is the first land after at least `minWidth` blocks of water.
 * Returns { shore, far, width } (shore and far are the samples' own objects) or null.
 */
export function shoreFromSamples(from, samples, { step = 2, minWidth = 8 } = {}) {
  let lastLand = from, wetFrom = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], d = (i + 1) * step;
    if (s.k === 'land') {
      if (wetFrom !== null && d - wetFrom >= minWidth) return { shore: lastLand, far: s, width: Math.round(d - wetFrom) };
      wetFrom = null; lastLand = s;
    } else if (s.k === 'water' && wetFrom === null) wetFrom = d; // ('bad': ice, leaves: neither, passed over)
  }
  return null;
}

// ---- driving ----
// A simulated player's movement does not steer a boat (the u202 boat arena: "a boat's controls don't answer a simulated player"), so the
// bot drives it the way that arena did and was seen to (43 s round a canal): steer the boat's velocity toward where it should go with a
// small impulse each tick, and point the boat at it.

export const BOAT_VMAX = 7.6;     // blocks a second on the straight (a person rowing: 7.3 over the 39 blocks of the u204 lake)
export const BOAT_PUSH_CAP = 0.09; // blocks a tick the velocity is moved by at most before the gain (a harder shove skips the boat along)
export const BOAT_PUSH_GAIN = 0.6;

/**
 * The impulse (blocks a tick) to apply to a boat moving at v ({x, z} blocks a tick) so that it goes `want` blocks a tick along the unit
 * vector (ux, uz).
 */
export function pushImpulse(v, ux, uz, want, cap = BOAT_PUSH_CAP, gain = BOAT_PUSH_GAIN) {
  let ix = ux * want - v.x, iz = uz * want - v.z;
  const m = Math.hypot(ix, iz);
  if (m > cap) { ix = ix / m * cap; iz = iz / m * cap; }
  return { x: ix * gain, z: iz * gain };
}

/**
 * Blocks a second to aim for with `d` blocks to go: flat out, easing off only for the last few (the bank stops it anyway). With the boat's
 * measured speed `spd` (b/s) more than a quarter under that, ask for a fifth more: the water's drag eats part of every push, so a P-controller
 * aimed at the cruising speed settles under it (a person rowing did 7.3 over the same lake); the push per tick stays capped, the extra only
 * keeps it from tapering off, and the aim drops back to the cruising speed the moment the boat is there.
 */
export function driveSpeed(d, vmax = BOAT_VMAX, spd = null) {
  const base = Math.max(2, Math.min(vmax, 2 + d * 1.6));
  return spd !== null && spd < base - 0.25 ? base * 1.2 : base;
}

/**
 * The boat is as far as it will get: close to the far shore (`d` from the first dry cell's middle: a boat is 1.4 wide, so against the bank it
 * is 2.2 from it), or it has stopped against it (8 ticks without moving).
 */
export function boatArrived({ d, speed, stillTicks = 0 }, near = 2.7, bank = 4.5) {
  return d <= near || (d <= bank && speed < 1.2 && stillTicks >= 8);
}
