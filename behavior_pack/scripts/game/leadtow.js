// Towing a boat on a lead, on foot or on a horse, over ground a boat can't just be dragged across.
//
// How it is done (from the player who taught it, and `!bot test leadboat` / `leadsling`): go as fast as you like. What snaps a
// lead is the boat being stuck while you keep going. A boat on land is pulled in a straight line toward the leader, so it
// jams against the foot of any step you climbed. Then: stand above it, walk away along the line until the lead is stretched
// (not to snapping), and JUMP: the boat flies to you, faster the further the lead was stretched, up the step. So:
//   - the route is the bot's own land path search (water, drops and walls avoided), walked at full speed;
//   - a boat that has stopped while the lead is taut is stuck. Below us by a step: SLING it (stretch, jump, watch it come; if it
//     did not, stretch a little further and again; if the lead broke, remember where). Otherwise (something between us): go back
//     to it, round to a side with a clear line, and pull again, rerouting after three at one place;
//   - never past the guard distance (0.9 of the lead's max, lower once a snap has been seen): it stops and slings or flanks there.
// What the stretch should be per height of step is calibrated by `!bot test leadsling`, learned from the player (`!bot learn tow`:
// where they jumped and how far the boat flew), and kept in the world (leadCal). Everything it measures is returned, so how
// efficient it was (ideal walking time over actual) is a number.
import { system } from '@minecraft/server';
import { trace } from './bridge.js';
import { hold } from './inventory.js';

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

  /** How much higher the ground is 1.6 blocks from the boat toward `p` than where the boat is (a step it is jammed against). */
  riseAhead(boat, p) {
    const S = this.a.skills, b = boat.location;
    const dx = p.x - b.x, dz = p.z - b.z, len = Math.hypot(dx, dz) || 1;
    const top = S.groundTop(Math.floor(b.x + (dx / len) * 1.6), Math.floor(b.z + (dz / len) * 1.6));
    return Number.isFinite(top) ? Math.round((top + 1 - b.y) * 10) / 10 : 0;
  }

  /**
   * The sling: with the boat jammed below us, walk away from it along the line until the lead is stretched to `target`
   * (never past `guard`), then jump; the boat flies to us. Watches the next 2 s. Returns
   * { ok, snapped, stretch, peak (the boat's fastest, blocks/s), climbed (how much higher it ended than it began) }.
   */
  async sling(gen, boat, { ride = false, target, guard }) {
    const a = this.a, S = a.skills, sim = a.sim, subj = () => (ride ? (a.horses.mounted() ?? sim) : sim);
    const lim = this.limits(boat);
    const goal = Math.min(target, guard - 0.4, lim.max - 1);
    // Away from the boat until the lead is stretched.
    for (let i = 0; i < 100; i++) {
      S.check(gen);
      if (!boat.isValid || !this.isLeashed(boat)) return { ok: false, snapped: true, stretch: goal, peak: 0, climbed: 0 };
      const p = subj().location, b = boat.location, d = flat(p, b);
      if (d >= goal) break;
      const k = 2 / (d || 1);
      try { sim.moveToLocation({ x: p.x + (p.x - b.x) * k, y: p.y, z: p.z + (p.z - b.z) * k }, { speed: 1 }); } catch { /* */ }
      await S.wait(gen, 1);
    }
    try { sim.stopMoving(); } catch { /* */ }
    await S.wait(gen, 3);
    const stretch = flat(subj().location, boat.location), y0 = boat.location.y;
    try { sim.jump(); } catch { /* */ }
    let peak = 0, last = { ...boat.location }, snapped = false, best = y0;
    for (let i = 0; i < 40; i++) {
      S.check(gen);
      await S.wait(gen, 1);
      if (!boat.isValid || !this.isLeashed(boat)) { snapped = true; break; }
      peak = Math.max(peak, Math.hypot(boat.location.x - last.x, boat.location.y - last.y, boat.location.z - last.z) * 20);
      best = Math.max(best, boat.location.y);
      last = { ...boat.location };
    }
    const here = subj().location;
    const ok = !snapped && boat.isValid && (boat.location.y >= here.y - 0.7 || flat(here, boat.location) < Math.max(2.5, stretch - 4));
    return { ok, snapped, stretch: Math.round(stretch * 10) / 10, peak: Math.round(peak * 10) / 10, climbed: Math.round((best - y0) * 10) / 10 };
  }

  /**
   * Tow `boat` (on a lead from us) to within 2.5 blocks of goal. opts: { mount (the horse we're on), speed (1 = full), maxS }.
   * Returns the measurements.
   */
  async run(gen, boat, goal, opts = {}) {
    const a = this.a, S = a.skills, sim = a.sim, mount = opts.mount ?? null, subject = () => mount ?? sim;
    const lim = this.limits(boat);
    const cal = a.memory.data.leadCal;
    // What a player was watched doing and what the sling calibration found, over the guesses.
    const L = cal?.learned?.[mount ? 'ride' : 'walk'] ?? null, SL = cal?.sling ?? {};
    const lo = L?.pullAt ?? cal?.pullAt ?? 5;
    const guard = Math.min(SL.guard ?? lim.max * 0.9, lim.max * 0.95);
    const patience = Math.max(12, Math.min(90, Math.round(L?.patience ?? 20)));
    const stretchFor = (rise) => L?.sling?.stretch ?? SL.byRise?.[Math.min(3, Math.max(1, Math.ceil(rise)))] ?? Math.min(guard - 0.5, lim.max * 0.7);
    const m = { arrived: false, snapped: false, why: '', secs: 0, idealS: 0, efficiency: 0, holds: 0, tugs: 0, reroutes: 0, steps: 0, slings: 0, slingOk: 0, maxSep: 0, pullAt: null, boatMoved: 0, boatEnd: null, pathLen: 0, wet: false, ...lim, holdAt: guard };
    const t0 = system.currentTick, b0 = { ...boat.location };
    let route = null, wi = 0, lastBoat = { ...boat.location }, lastBoatMoveTick = t0, stuckAt = null, stuckCount = 0, lastJump = 0, replans = 0;
    const ride = !!mount;
    const move = (to, speed) => { try { sim.moveToLocation(to, { speed }); } catch { /* */ } };
    const sep = () => flat(subject().location, boat.location);

    const plan = async (target) => {
      const from = subject().location;
      const res = await a.plan(from, target, 1.5, 12000);
      S.check(gen);
      if (!res.path || res.path.length < 2) return null;
      m.pathLen += res.path.length;
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
      if (!route || wi >= route.length) {
        if (replans++ > 12) { m.why = 'could not find a way on'; break; }
        route = await plan(goal); wi = 0;
        if (!route) { m.why = 'no land route to the goal'; break; }
        if (!m.idealS) m.idealS = flat(pos, goal) / (ride ? RIDE_BPS : WALK_BPS);
      }
      const wp = route[wi];
      if (flat(pos, wp) < 1.1) { wi++; continue; }
      // Stuck: the boat hasn't moved while the lead is taut, or the lead is nearly at the guard distance.
      const jammed = d > lo + 0.5 && system.currentTick - lastBoatMoveTick > patience;
      if (jammed || d >= guard - 0.2) {
        try { sim.stopMoving(); } catch { /* */ }
        const rise = this.riseAhead(boat, pos);
        const here = `${Math.round(boat.location.x)},${Math.round(boat.location.z)}`;
        stuckCount = stuckAt === here ? stuckCount + 1 : 1; stuckAt = here;
        if (rise >= 0.4 && pos.y - boat.location.y >= 0.4 && stuckCount <= 4) {
          // Below us against a step: the sling, a little further stretched each time it fails.
          m.slings++;
          const r = await this.sling(gen, boat, { ride, target: stretchFor(rise) + (stuckCount - 1) * 1.0, guard });
          trace(`tow: sling at rise ${rise}: stretch ${r.stretch}, ${r.ok ? 'it came' : r.snapped ? 'LEAD BROKE' : 'it did not come'}, boat peaked ${r.peak} b/s, climbed ${r.climbed}`);
          if (r.ok) { m.slingOk++; stuckCount = 0; }
          if (r.snapped) { m.snapped = true; m.why = 'the lead broke in a sling'; break; }
          lastBoatMoveTick = system.currentTick;
          continue;
        }
        m.tugs++;
        // Something between us rather than a step below: back to the boat, round to a side with a clear line, on.
        await this.goTo(gen, { x: boat.location.x + 1.2, y: pos.y, z: boat.location.z + 1.2 }, ride, 3.5);
        const flank = this.flank(boat, wp, stuckCount, L?.flank ?? null);
        if (flank) await this.goTo(gen, flank, ride, 3.5);
        lastBoatMoveTick = system.currentTick;
        if (stuckCount >= 3) { m.reroutes++; route = null; stuckCount = 0; }
        continue;
      }
      // Full speed (what snaps a lead is being stuck, not going fast); a hop at a step up.
      move(wp, Math.max(0.2, Math.min(1, opts.speed ?? 1)));
      if (wp.y - pos.y > 0.6 && flat(pos, wp) < 1.7 && system.currentTick - lastJump > 8) { try { sim.jump(); m.steps++; lastJump = system.currentTick; } catch { /* */ } }
      await S.wait(gen, 1);
    }
    m.secs = Math.round((system.currentTick - t0) / 20);
    m.boatMoved = boat.isValid ? flat(boat.location, b0) : 0;
    m.boatEnd = boat.isValid ? { x: Math.round(boat.location.x), z: Math.round(boat.location.z) } : null;
    m.efficiency = m.arrived && m.secs ? Math.round((m.idealS / m.secs) * 100) / 100 : 0;
    try { sim.stopMoving(); } catch { /* */ }
    trace(`tow: ${m.arrived ? 'arrived' : `stopped (${m.why || 'time'})`} in ${m.secs}s, efficiency ${m.efficiency}, apart ${m.maxSep.toFixed(1)} at most, ${m.slingOk}/${m.slings} slings, ${m.tugs} unsticks, ${m.reroutes} reroutes${m.snapped ? ', LEAD BROKE' : ''}`);
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
