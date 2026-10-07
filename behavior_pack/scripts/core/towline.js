// Where a boat on a lead goes, and where to stand to send it where we want. Pure (unit-tested).
//
// A boat dragged over land is pulled in a straight line at whoever holds the lead, and stopped by any step it meets (it takes a
// sling to lift it). So a route that is fine for the walker can be hopeless for the boat: the u204 villagerhaul run walked round a
// one-block rise (4 wide) while the boat, pulled straight at it, sat 1 block short of its face for 54 s (the unstick walked back to
// the boat and "flanked" along lines that crossed the same rise, so none was taken). Everything here takes `surf(x, z)`: the y of
// the surface a boat would sit on in that block column (-Infinity: none).

export const BOAT_CLIMB = 0.45;   // a step higher than this stops a boat (a snow layer does not)
export const BOAT_HALF = 0.55;    // half its width, the part of it that clips a corner
export const LEAD_SLACK = 4.2;    // a boat is pulled until it is about this near the holder (hardDistance 4, measured pullAt 4.7)

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * A boat at `level` (its y) pulled toward `to`, a step at a time, as the game moves it: straight at us, stopped by a step it cannot climb,
 * and where that is a face it meets at an angle it slides along it (an axis at a time) until it is past the corner. It follows the ground
 * down and up by less than BOAT_CLIMB, and has a width (a boat is 1.4 across: it clips corners a line would miss). It stops when `stop` from `to`
 * (the lead's slack: it comes no nearer). Returns { clear (it got there), x, z (where it ended), reach (how far it travelled), at ({ x, z } of
 * what blocked it, if it was stopped), rise (how much higher than where it sat), len (the straight distance) }.
 */
export function pullPath(surf, from, to, level, { climb = BOAT_CLIMB, half = BOAT_HALF, step = 0.1, stop = 0 } = {}) {
  const len = Math.hypot(to.x - from.x, to.z - from.z);
  let p = { x: from.x, z: from.z }, y = level, reach = 0;
  const free = (x, z) => {
    for (const [ox, oz] of [[0, 0], [-half, -half], [half, -half], [-half, half], [half, half]]) {
      const top = surf(Math.floor(x + ox), Math.floor(z + oz));
      if (!Number.isFinite(top) || top - y > climb) return false;
    }
    return true;
  };
  for (let i = 0; i < 700; i++) {
    const dx = to.x - p.x, dz = to.z - p.z, d = Math.hypot(dx, dz);
    if (d <= stop + 1e-6) return { clear: true, x: p.x, z: p.z, reach, at: null, rise: 0, len };
    const ux = dx / d, uz = dz / d, s = Math.min(step, d - stop);
    let nx = p.x + ux * s, nz = p.z + uz * s, moved = s;
    if (!free(nx, nz)) {
      // Along the face: the axis that is open, if the pull has a real part along it (a pull straight into the face does not slide).
      const okX = Math.abs(ux) >= 0.2 && free(p.x + Math.sign(ux) * s, p.z), okZ = Math.abs(uz) >= 0.2 && free(p.x, p.z + Math.sign(uz) * s);
      if (okX && (!okZ || Math.abs(ux) >= Math.abs(uz))) { nx = p.x + Math.sign(ux) * s; nz = p.z; }
      else if (okZ) { nx = p.x; nz = p.z + Math.sign(uz) * s; }
      else {
        const ax = p.x + ux * (half + 0.15), az = p.z + uz * (half + 0.15), top = surf(Math.floor(ax), Math.floor(az));
        return { clear: false, x: p.x, z: p.z, reach, at: { x: ax, z: az }, rise: Number.isFinite(top) ? Math.round((top - y) * 100) / 100 : Infinity, len };
      }
    }
    p = { x: nx, z: nz }; reach += moved;
    // (It sits on the highest block under it: half over an edge it is still on the high side. Only what it moves INTO can stop it.)
    let under = -Infinity;
    for (const [ox, oz] of [[0, 0], [-half, -half], [half, -half], [-half, half], [half, half]]) { const t = surf(Math.floor(p.x + ox), Math.floor(p.z + oz)); if (Number.isFinite(t) && t > under) under = t; }
    if (Number.isFinite(under)) y = under;
  }
  return { clear: false, x: p.x, z: p.z, reach, at: { x: p.x, z: p.z }, rise: 0, len };
}

/** Where the boat ends up when we stand at `p`: on the line to us, LEAD_SLACK short of us (it comes no nearer), or where a step stops it. */
export function boatEnd(surf, boat, p, level) {
  const r = pullPath(surf, boat, p, level, { stop: LEAD_SLACK });
  return { x: r.x, z: r.z, d: r.reach, clear: r.clear, at: r.at, rise: r.rise };
}

/**
 * Places to stand that free a jammed boat by going round what jams it: on rings round the boat, where the straight pull from the boat to
 * us is clear, we can stand (standable(x, z) -> y or null, within `maxDy` of the boat's level), and the boat would end nearer the way
 * on (`wp`) than it is. Best first (the boat ends nearest wp; ties: the shorter walk from `me`). [{ x, z, y, end ({ x, z }), gain }]
 */
export function flankSpots({ surf, standable, boat, level, wp, me, radii = [5, 5.8, 6.6, 7.4, 8.2], n = 72, maxDy = 1.5, min = 1.8 }) {
  const here = flat(boat, wp), out = [];
  for (const r of radii) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const p = { x: boat.x + Math.cos(a) * r, z: boat.z + Math.sin(a) * r };
      const y = standable(Math.floor(p.x), Math.floor(p.z));
      if (y == null || !Number.isFinite(y) || Math.abs(y - level) > maxDy) continue;
      const end = boatEnd(surf, boat, p, level);
      if (!end.clear) continue;                         // (the boat would end up stuck short of us again)
      const gain = here - flat(end, wp);
      if (gain < min) continue;
      out.push({ x: p.x, z: p.z, y, end: { x: end.x, z: end.z }, gain, walk: me ? flat(me, p) : 0 });
    }
  }
  // (Most gain first; within a block of the same gain, the shorter walk.)
  return out.sort((a, b) => (Math.abs(b.gain - a.gain) < 1 ? a.walk - b.walk : b.gain - a.gain));
}

/**
 * Up onto the step the boat is jammed against (when there is no way round it: a hill across the whole slab): a place on top of it, a little
 * past its edge on the line from the boat toward us. standable(x, z) -> y or null. Returns { x, z, y } or null.
 */
export function climbSpot({ surf, standable, boat, level, toward, maxUp = 3.5 }) {
  const pp = pullPath(surf, boat, toward, level, { stop: LEAD_SLACK });
  if (pp.clear || !pp.at || !Number.isFinite(pp.rise)) return null;
  const dx = toward.x - boat.x, dz = toward.z - boat.z, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len;
  // The blocking column and the ones just beyond it along the line.
  for (const k of [0.9, 1.4, 1.9, 2.4]) {
    const x = pp.at.x + ux * k, z = pp.at.z + uz * k;
    const y = standable(Math.floor(x), Math.floor(z));
    if (y != null && Number.isFinite(y) && y - level >= 0.4 && y - level <= maxUp) return { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5, y };
  }
  return null;
}

/**
 * Getting a boat to a mob by its lead (a villager into a boat): the boat is pulled straight at us, so we stand on the line from the boat
 * through the mob and `past` beyond it, but never further than `maxFrom` from the boat (a lead snaps at about 10). Walking there takes us past
 * the mob (not through it: it is shoved out of the line): `via` is a point to the side of it to go by first, on our side of the line.
 * Returns { stand, via, u ({ x, z } boat -> mob), d (boat to mob) }.
 */
export function boatToMob(boat, mob, me, { past = 5.2, maxFrom = 8.5, side = 3.4 } = {}) {
  const d = flat(boat, mob) || 1e-6, u = { x: (mob.x - boat.x) / d, z: (mob.z - boat.z) / d };
  const reach = Math.min(d + past, maxFrom);
  const stand = { x: boat.x + u.x * reach, z: boat.z + u.z * reach };
  // Which side of the line we are on (the cross product of the line with where we are).
  const cross = u.x * (me.z - boat.z) - u.z * (me.x - boat.x);
  const sg = cross >= 0 ? 1 : -1;
  const via = { x: mob.x - u.z * side * sg, z: mob.z + u.x * side * sg };
  return { stand, via, u, d };
}
