// A long fall: water under us before we land (the water bucket), the way players break a fall.
// Pure (unit-tested; tools/sim_fall.mjs plays it against Minecraft's fall physics).
//
// Minecraft falling: each tick we move by our vertical speed, then it becomes (v - 0.08) x 0.98
// (terminal ~3.9 blocks a tick). Landing hurts 1 per block past the first 3; landing in water
// doesn't hurt at all. The water goes on top of the block we'll land on, from the bucket, as soon
// as that block is in reach (eye to its top face); if the drop's too fast to catch it there, on the
// last tick before we'd hit it. Never in the Nether (it boils away): the caller checks.

export const SAFE_FALL = 3;
export const EYE = 1.62;

/** Damage a fall of h blocks does (Minecraft: 1 a block past the first 3). */
export const fallDamage = (h) => Math.max(0, Math.ceil(h - SAFE_FALL - 1e-9));

/** Ticks until our feet reach groundY from y, falling at vy now (blocks a tick, negative is down). */
export function ticksToLand(y, vy, groundY, max = 400) {
  let t = 0;
  while (y > groundY && t < max) { y += vy; vy = (vy - 0.08) * 0.98; t++; }
  return t;
}

/**
 * Put the water down now? fallFrom: the highest our feet got since we left the ground; y, vy: our
 * feet and vertical speed now; groundY: the top of the block we'll land on; health.
 * Worth it for a fall that would cost 3 or more (6+ blocks) or all we have left.
 * reach: eye to the block's top face (Bedrock's survival reach ~5). lead: ticks our reading of y
 * and vy may be behind (projected forward: at 3.9 blocks a tick, one stale tick skips the window).
 * Returns { place, damage, inReach }.
 */
export function mlgNow({ fallFrom, y, vy, groundY, health = 20, reach = 5, lead = 0 }) {
  const damage = fallDamage(fallFrom - groundY);
  if (damage < 3 && damage < health) return { place: false, damage, inReach: false };
  // Where we are by the time the hand moves (what we read may be `lead` ticks old).
  for (let i = 0; i < lead && y > groundY; i++) { y += vy; vy = (vy - 0.08) * 0.98; }
  const d = y - groundY;
  const inReach = d >= 0 && d + EYE <= reach;
  const landsNextTick = y + vy <= groundY;
  return { place: inReach || landsNextTick, damage, inReach };
}
