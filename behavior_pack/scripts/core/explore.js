// Exploring without getting stuck. Pure (unit-tested).
//
//   wetCones     directions not to explore in: toward water we had to swim out of, but only water
//                close by (48) and lately (5 min). Kept for ever and from anywhere, a few swims in
//                different directions ruled out every way there was, and it stood still for good.
//   ExploreStall notices explore calls that don't get anywhere, and says what to do about it:
//                'ok' -> 'trek' (a long leg a fresh way) -> 'giveup' (stop looking for 10 minutes).

export const WET_RADIUS = 48;
export const WET_MAX_AGE = 6000; // ticks: 5 minutes
export const WET_CONE = Math.PI / 4; // +-45 degrees

/** The water directions that still count from p at tick `now`: [angle]. wet: [{x, z, t}] */
export function wetCones(wet, p, now) {
  return (wet ?? [])
    .filter((w) => Math.hypot(w.x - p.x, w.z - p.z) <= WET_RADIUS && now - (w.t ?? now) <= WET_MAX_AGE)
    .map((w) => Math.atan2(w.z - p.z, w.x - p.x));
}

/** Is angle `a` inside one of the cones? */
export function towardWet(a, cones) {
  return cones.some((w) => Math.abs(Math.atan2(Math.sin(a - w), Math.cos(a - w))) < WET_CONE);
}

/**
 * Explore calls that end where they began. start(pos, want) before each call, end(pos) after it;
 * verdict(): 'ok', 'trek' (3 in a row that got nowhere: a long leg a way not tried) or 'giveup' (6:
 * stop looking for this for a while). Moving 12+ blocks, or a different want, starts it over.
 */
export class ExploreStall {
  constructor() { this.n = 0; this.want = null; this.from = null; this.tried = []; }
  start(pos, want) {
    if (want !== this.want) { this.want = want; this.n = 0; this.tried = []; }
    this.from = { x: pos.x, z: pos.z };
  }
  end(pos) {
    if (!this.from) return;
    const moved = Math.hypot(pos.x - this.from.x, pos.z - this.from.z);
    if (moved >= 12) { this.n = 0; this.tried = []; } else this.n++;
  }
  verdict() { return this.n >= 6 ? 'giveup' : this.n >= 3 ? 'trek' : 'ok'; }
  /** A direction for the trek: away from the ones already tried (and from water, if we can). */
  trekAngle(rand, cones = []) {
    let best = 0, bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI + rand() * 0.2;
      const gap = this.tried.length ? Math.min(...this.tried.map((t) => Math.abs(Math.atan2(Math.sin(a - t), Math.cos(a - t))))) : Math.PI;
      const sc = gap - (towardWet(a, cones) ? 1.5 : 0) + rand() * 0.3;
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    this.tried.push(best);
    return best;
  }
}
