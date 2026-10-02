// Towing a boat on a lead, on foot or on a horse, over ground a boat can't just be dragged across.
//
// What the game does (measured by `!bot test leadboat`, kept in the world as leadCal): the lead pulls a boat once the
// two are ~5 blocks apart, the game's limits are soft 2 / hard 4 / max 12, and at full speed the leader got to 10.4 apart
// (nearly snapping). A boat on land is pulled in a straight line toward the leader, so it snags on steps, trenches and
// anything between the two; water it floats on.
//
// The way it tows, then:
//   - the route is the bot's own land path search (water, drops and walls avoided: the old test walked a straight line into
//     a pond and the swim-out reflex took the task), walked a hop at a time so the tension can be watched between hops;
//   - speed follows the tension: full speed while the boat is close, easing off as the two part toward 60% of the lead's
//     max, standing still when they're further, so the lead never goes taut enough to snap;
//   - a boat that stops while the lead is taut is stuck: the bot goes back to it, then round to a side of it with a clear
//     line (an obstacle between boat and leader is what holds it) and pulls again from there; after three of those at one
//     place it routes round a wider berth;
//   - before a step up the bot waits for the boat to come up close, so the climb doesn't drag it into the step.
// Everything it measures is returned (and kept), so how efficient it was (ideal walking time over actual) is a number.
import { system } from '@minecraft/server';
import { trace } from './bridge.js';
import { hold } from './inventory.js';
import { speedFrac } from '../core/towlearn.js';

const flat = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
const WALK_BPS = 4.3, RIDE_BPS = 9; // blocks per second at full speed, on foot and on a horse (for the "ideal" time)

export class LeadTow {
  constructor(agent) { this.a = agent; }

  limits(boat) {
    try { const l = boat.getComponent('minecraft:leashable'); return { soft: l?.softDistance ?? 2, hard: l?.hardDistance ?? 4, max: l?.maxDistance ?? 12 }; } catch { return { soft: 2, hard: 4, max: 12 }; }
  }

  /** A lead from us to the boat: used on it like a player does, else the API's own. Returns how, or null. */
  attach(boat) {
    const sim = this.a.sim;
    if (this.isLeashed(boat)) return 'already on a lead';
    hold(sim, 'lead');
    try { sim.interactWithEntity(boat); } catch { /* */ }
    if (this.isLeashed(boat)) return 'lead used on it';
    try { boat.getComponent('minecraft:leashable')?.leashTo(sim); } catch { /* */ }
    return this.isLeashed(boat) ? 'leashTo' : null;
  }

  isLeashed(boat) { try { return !!boat.getComponent('minecraft:leashable')?.isLeashed; } catch { return false; } }

  /**
   * Tow `boat` (on a lead from us) to within 2.5 blocks of goal. opts: { mount (the horse we're on), speed (1 = full),
   * maxS (give up after), avoidBoatCells }. Returns the measurements.
   */
  async run(gen, boat, goal, opts = {}) {
    const a = this.a, S = a.skills, sim = a.sim, mount = opts.mount ?? null, subject = () => mount ?? sim;
    const lim = this.limits(boat);
    const cal = a.memory.data.leadCal;
    // What a player was watched doing (`!bot learn tow`, core/towlearn.js) over the guesses: where the boat starts to follow, where to ease off,
    // how fast at each separation, how long to wait on a stuck boat, where to go to free it.
    const L = cal?.learned?.[opts.mount ? 'ride' : 'walk'] ?? null;
    const lo = L?.pullAt ?? cal?.pullAt ?? 5, hi = Math.min(L?.holdAt ?? lim.max * 0.6, lim.max * 0.8), patience = Math.max(15, Math.min(90, Math.round((L?.patience ?? 30) / 1))), curve = L?.curve ?? null;
    const m = { arrived: false, snapped: false, why: '', secs: 0, idealS: 0, efficiency: 0, holds: 0, tugs: 0, reroutes: 0, steps: 0, maxSep: 0, pullAt: null, boatMoved: 0, boatEnd: null, pathLen: 0, wet: false, ...lim, holdAt: hi };
    const t0 = system.currentTick, b0 = { ...boat.location };
    let route = null, wi = 0, lastBoat = { ...boat.location }, lastBoatMoveTick = t0, stuckAt = null, stuckCount = 0, lastJump = 0, replans = 0;
    const ride = !!mount;
    const move = (to, speed) => { try { if (ride) subject().isValid && sim.moveToLocation(to, { speed }); else sim.moveToLocation(to, { speed }); } catch { /* */ } };
    const sep = () => flat(subject().location, boat.location);
    const ground = (p) => { const f = S.groundTop(Math.floor(p.x), Math.floor(p.z)); return Number.isFinite(f) ? f : p.y; };

    const plan = async (target) => {
      const from = subject().location;
      const res = await a.plan(from, target, 1.5, 12000);
      S.check(gen);
      if (!res.path || res.path.length < 2) return null;
      m.pathLen += res.path.length;
      // Thin straight runs to every other cell, keeping every change of height (those are the steps the boat meets).
      const pts = res.path.map((c) => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 }));
      const out = [];
      pts.forEach((p, i) => { if (i === pts.length - 1 || i === 0 || p.y !== pts[i - 1].y || (i + 1 < pts.length && pts[i + 1].y !== p.y) || i % 2 === 0) out.push(p); });
      return out;
    };

    for (let tick = 0; tick < (opts.maxS ?? 120) * 20; tick++) {
      S.check(gen);
      if (!boat.isValid || !this.isLeashed(boat)) { m.snapped = true; m.why = 'the lead broke'; break; }
      const pos = subject().location, d = sep();
      m.maxSep = Math.max(m.maxSep, d);
      if (flat(boat.location, lastBoat) > 0.05) { if (m.pullAt === null) m.pullAt = d; lastBoat = { ...boat.location }; lastBoatMoveTick = system.currentTick; }
      if (flat(pos, goal) < 2.5) { m.arrived = true; break; }
      if (sim.isInWater && !ride) { m.wet = true; m.why = 'in water (the route should never go there)'; break; }
      // The route, and where we are on it.
      if (!route || wi >= route.length) {
        if (replans++ > 12) { m.why = 'could not find a way on'; break; }
        route = await plan(goal); wi = 0;
        if (!route) { m.why = 'no land route to the goal'; break; }
        if (!m.idealS) m.idealS = flat(pos, goal) / (ride ? RIDE_BPS : WALK_BPS);
      }
      const wp = route[wi];
      if (flat(pos, wp) < 1.1) { wi++; continue; }
      // Stuck: the boat hasn't moved for 1.5 s while the lead is taut.
      if (d > lo + 0.5 && system.currentTick - lastBoatMoveTick > patience) {
        m.tugs++;
        const here = `${Math.round(boat.location.x)},${Math.round(boat.location.z)}`;
        stuckCount = stuckAt === here ? stuckCount + 1 : 1; stuckAt = here;
        try { sim.stopMoving(); } catch { /* */ }
        // Back to the boat (slack), then to a flank of it with a clear line, then on.
        await this.goTo(gen, { x: boat.location.x + 1.2, y: pos.y, z: boat.location.z + 1.2 }, ride, 3.5);
        const flank = this.flank(boat, wp, stuckCount, L?.flank ?? null);
        if (flank) await this.goTo(gen, flank, ride, 3.5);
        lastBoatMoveTick = system.currentTick;
        if (stuckCount >= 3) { m.reroutes++; route = null; stuckCount = 0; }
        continue;
      }
      // Speed follows tension: full below `lo`, easing to a standstill by `hi`.
      const speedCap = opts.speed ?? 1;
      let k = curve && L?.curve?.length >= 4 ? speedFrac(curve, d) : d <= lo ? 1 : Math.max(0, (hi - d) / (hi - lo));
      if (d > hi - 1.5) k = Math.min(k, Math.max(0, (hi - d) / 1.5)); // (easing to a stop at where the player held up, never past it)
      // A step up ahead: close the gap first so the climb doesn't drag the boat into the step.
      if (wp.y - pos.y > 0.6 && d > 2.5 && flat(pos, wp) < 2.5) k = 0;
      if (k < 0.12) {
        m.holds++;
        try { sim.stopMoving(); } catch { /* */ }
        await S.wait(gen, 2);
        continue;
      }
      move(wp, Math.max(0.2, Math.min(1, speedCap * k)));
      if (wp.y - pos.y > 0.6 && flat(pos, wp) < 1.7 && system.currentTick - lastJump > 8) { try { sim.jump(); m.steps++; lastJump = system.currentTick; } catch { /* */ } }
      await S.wait(gen, 1);
    }
    m.secs = Math.round((system.currentTick - t0) / 20);
    m.boatMoved = boat.isValid ? flat(boat.location, b0) : 0;
    m.boatEnd = boat.isValid ? { x: Math.round(boat.location.x), z: Math.round(boat.location.z) } : null;
    m.efficiency = m.arrived && m.secs ? Math.round((m.idealS / m.secs) * 100) / 100 : 0;
    try { sim.stopMoving(); } catch { /* */ }
    trace(`tow: ${m.arrived ? 'arrived' : `stopped (${m.why || 'time'})`} in ${m.secs}s, efficiency ${m.efficiency}, apart ${m.maxSep.toFixed(1)} at most, ${m.holds} holds, ${m.tugs} unsticks, ${m.reroutes} reroutes${m.snapped ? ', LEAD BROKE' : ''}`);
    const cal2 = a.memory.data.leadCal ?? {};
    a.memory.data.leadCal = { ...cal2, pullAt: m.pullAt ?? cal2.pullAt, lastTow: { ...m }, at: Date.now() };
    a.memory.save();
    return m;
  }

  /** Walk (or ride) straight to a near point, a few seconds at most. */
  async goTo(gen, to, ride, maxS) {
    const sim = this.a.sim, S = this.a.skills;
    const subj = () => (ride ? (this.a.horses.mounted() ?? sim) : sim);
    for (let i = 0; i < maxS * 20; i++) {
      S.check(gen);
      if (flat(subj().location, to) < 1.2) break;
      try { sim.moveToLocation(to, { speed: 0.5 }); } catch { /* */ }
      await S.wait(gen, 1);
    }
    try { sim.stopMoving(); } catch { /* */ }
  }

  /**
   * A spot 5 blocks from the boat to one side of the line to the next waypoint (alternating sides, wider each time),
   * standing room and nothing solid between it and the boat at boat height. Null if there's none.
   */
  flank(boat, wp, n, learned = null) {
    const S = this.a.skills, b = boat.location;
    const base = Math.atan2(wp.z - b.z, wp.x - b.x);
    const side = n % 2 ? 1 : -1, spread = ((learned?.angle ? Math.max(30, Math.min(120, learned.angle)) : 60) * Math.PI / 180) * (1 + Math.floor((n - 1) / 2) * 0.5);
    const reach = learned?.dist ? Math.max(3, Math.min(8, learned.dist)) : 5;
    for (const sgn of [side, -side]) {
      const ang = base + sgn * spread;
      const p = { x: b.x + Math.cos(ang) * reach, z: b.z + Math.sin(ang) * reach };
      const top = S.groundTop(Math.floor(p.x), Math.floor(p.z));
      if (!Number.isFinite(top) || Math.abs(top - b.y) > 2) continue;
      let clear = true;
      for (let t = 1; t <= 4 && clear; t++) {
        const q = { x: Math.floor(b.x + (p.x - b.x) * t / 5), y: Math.floor(b.y + 0.5), z: Math.floor(b.z + (p.z - b.z) * t / 5) }; // (4 points along the way)
        const id = S.blockAt(q) ?? 'air';
        if (!/^(air|cave_air|void_air|short_grass|tall_grass|fern|snow_layer)$/.test(id)) clear = false;
      }
      if (clear) return { x: p.x, y: top, z: p.z };
    }
    return null;
  }
}
