// Where to get something: what it can see now, somewhere it remembers, items lying on the ground,
// or a fallback (explore, dig down). Every option is priced in seconds and the cheapest wins.
// Pure: no game calls, so the trade-offs are unit-tested.

export const WALK_SPEED = 4.3;   // blocks/s
export const EXPLORE_S = 45;     // expected time to find a new source by wandering
export const DIG_DOWN_S = 25;    // staircase from the surface to stone (~12 dirt blocks + steps)
export const PICKUP_S = 1;       // walking over an item stack

/**
 * candidate: { kind: 'visible'|'memory'|'item'|'dig'|'explore', dist, units, perUnitS, fixedS, ... }
 *   dist      blocks to get there (Infinity if unknown)
 *   units     how many it can supply (Infinity if unlimited, e.g. digging)
 *   perUnitS  seconds to collect one unit once there (0 for items on the ground)
 *   fixedS    one-off extra cost (e.g. digging down before the first stone)
 *   trust     0..1 chance it's still there (memories fade: blocks get mined, items despawn)
 * Shortfall (units < need) is priced as the remainder via exploring.
 */
export function costOf(c, need) {
  const travel = Number.isFinite(c.dist) ? c.dist / WALK_SPEED : Infinity;
  const units = c.units ?? Infinity;
  const got = Math.min(need, units);
  const collect = c.kind === 'item' ? PICKUP_S : got * (c.perUnitS ?? 0);
  const shortfall = need > units ? EXPLORE_S * 0.5 + (need - units) * (c.perUnitS ?? 1) : 0;
  const base = travel + (c.fixedS ?? 0) + collect + shortfall;
  // A memory that may be gone: expected cost includes a wasted trip and then the fallback.
  const trust = c.trust ?? 1;
  return trust >= 1 ? base : trust * base + (1 - trust) * (travel + EXPLORE_S);
}

export const NEAR = 8; // blocks: something we can see this close is taken first, whatever else we know of

/**
 * Cheapest candidate. A source that can't cover the whole need has its remainder priced by the
 * next best other source (not by exploring), so a small tree next to us isn't beaten by a big
 * remembered forest just because it doesn't have enough on its own. And anything real we can
 * see within NEAR blocks wins outright: take what's in reach, then go for the rest.
 */
export function chooseSource(candidates, need) {
  const near = candidates.filter((c) => c.kind === 'visible' && c.dist <= NEAR && (c.units ?? 1) > 0).sort((a, b) => a.dist - b.dist)[0];
  if (near) return { ...near, cost: costOf(near, need) };
  // Exploring is what we do when we know of nothing: it never beats a source we do know of.
  const known = candidates.some((c) => c.kind !== 'explore' && (c.units ?? 1) > 0);
  let best = null;
  for (const c of candidates) {
    if (known && c.kind === 'explore') continue;
    const cost = costWithRest(c, need, candidates);
    if (!best || cost < best.cost) best = { ...c, cost };
  }
  return best;
}

/** costOf, with any shortfall priced by the best other candidate rather than by exploring. */
function costWithRest(c, need, candidates) {
  const units = c.units ?? Infinity;
  if (units >= need) return costOf(c, need);
  const rest = need - units;
  let restCost = Infinity;
  for (const o of candidates) if (o !== c) restCost = Math.min(restCost, costOf(o, rest));
  const own = costOf({ ...c, units: Infinity }, units);
  return Number.isFinite(restCost) ? own + restCost : costOf(c, need);
}

/** How much to trust a memory of this kind after `ageMs`. Items despawn after 5 minutes. */
export function trustFor(kind, ageMs) {
  if (kind === 'item') return ageMs > 5 * 60_000 ? 0 : 1 - ageMs / (5 * 60_000) * 0.5;
  // Blocks mostly stay put; knock a little off per hour for other players and creepers.
  return Math.max(0.5, 1 - ageMs / 3_600_000 * 0.2);
}

/** A stable name for a candidate, so we can tell whether a new choice is really a different one. */
export function sourceKey(c) {
  const p = c.target ?? c.entry?.pos;
  return p ? `${c.kind}:${Math.floor(p.x)},${Math.floor(p.z)}` : c.kind;
}

/**
 * chooseSource with commitment (AltoClef-style): keep going for what we picked last time unless
 * something else is now at least `ratio` times cheaper. Stops the dithering between two trees (or
 * a tree and a memory) as distances shift a little with every step.
 */
const FALLBACK = new Set(['explore', 'dig']);

export function chooseSourceSticky(candidates, need, prevKey, ratio = 2) {
  const best = chooseSource(candidates, need);
  if (!best || !prevKey) return best;
  if (best.kind === 'visible' && best.dist <= NEAR) return best; // in reach beats any commitment
  const prev = candidates.find((c) => sourceKey(c) === prevKey);
  // Commitment is for real sources only. Exploring or digging down is what we do while nothing
  // better is known: the moment a tree or stone turns up, take it (sticking to "explore" walked us
  // straight past trees, since a tree is never 2x cheaper than wandering on).
  if (!prev || FALLBACK.has(prev.kind)) return best;
  const prevCost = costWithRest(prev, need, candidates);
  return prevCost <= best.cost * ratio ? { ...prev, cost: prevCost } : best;
}
