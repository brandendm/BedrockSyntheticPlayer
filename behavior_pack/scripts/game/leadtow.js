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
import { isWalkMove } from '../core/pathfinder.js';

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
  async sling(gen, boat, { ride = false, target, guard, dir = null }) {
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
      // Along the runway if there is one (the way it was built), else straight away from the boat.
      const to = dir ? { x: p.x + dir[0] * 2, y: p.y, z: p.z + dir[1] * 2 } : { x: p.x + (p.x - b.x) * k, y: p.y, z: p.z + (p.z - b.z) * k };
      try { sim.moveToLocation(to, { speed: d > goal - 1.5 ? 0.4 : 1 }); } catch { /* */ }
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
   * A runway to stretch the lead along: what a player did who got the boat up steps and hills (a one-block-long elevation is no use: you
   * step off its far side before the lead is tight). Standing above the boat, the cells straight on from here, as far as the stretch
   * needs, at this level: any without a floor get one (a block placed against the last, the way a bridge is built), a wall stops it.
   * Returns { dir, built, ok }.
   */
  async runway(gen, boat, target, guard) {
    const S = this.a.skills, sim = this.a.sim;
    const p = sim.location, b = boat.location, d = flat(p, b);
    const dx = p.x - b.x, dz = p.z - b.z;
    const dir = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
    const out = { dir, built: 0, ok: true };
    const end = Math.min(target + 0.5, guard - 0.8);
    const need = Math.min(10, Math.max(0, Math.ceil(end - d)));
    const f = S.feet();
    const OPENISH = /^(air|cave_air|void_air|short_grass|tall_grass|fern|snow_layer|water|flowing_water|lava|flowing_lava)$/;
    let cur = { x: f.x, y: f.y, z: f.z };
    for (let k = 1; k <= need; k++) {
      S.check(gen);
      const nx = f.x + dir[0] * k, nz = f.z + dir[1] * k;
      const floor = S.blockAt({ x: nx, y: f.y - 1, z: nz }) ?? 'air';
      const body = S.blockAt({ x: nx, y: f.y, z: nz }) ?? 'air', head = S.blockAt({ x: nx, y: f.y + 1, z: nz }) ?? 'air';
      if (!OPENISH.test(body) || !OPENISH.test(head)) { out.ok = k > 2; break; }       // a wall: the runway ends here
      if (OPENISH.test(floor)) {
        if (S.blockCount() < 1) { out.ok = false; break; }
        if (!(await S.bridgeTo(gen, cur, { x: nx, y: f.y, z: nz }))) { out.ok = false; break; }
        out.built++;
      }
      cur = { x: nx, y: f.y, z: nz };
    }
    // Back to the near end so the stretch is made walking out along it.
    return out;
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
    // (A lead was seen to break at 10.1 blocks with the stated maximum 12: never past 8.8 unless a calibration in this world found better.)
    const guard = Math.min(SL.guard ?? 8.8, lim.max * 0.95, SL.snapAt ? SL.snapAt - 0.8 : 99);
    const patience = Math.max(12, Math.min(90, Math.round(L?.patience ?? 20)));
    const stretchFor = (rise) => L?.sling?.stretch ?? SL.byRise?.[Math.min(3, Math.max(1, Math.ceil(rise)))] ?? Math.min(guard - 0.5, lim.max * 0.7);
    const m = { arrived: false, snapped: false, why: '', secs: 0, idealS: 0, efficiency: 0, holds: 0, tugs: 0, reroutes: 0, steps: 0, slings: 0, slingOk: 0, maxSep: 0, pullAt: null, boatMoved: 0, boatEnd: null, pathLen: 0, wet: false, notes: [], built: 0, ...lim, holdAt: guard };
    const t0 = system.currentTick, b0 = { ...boat.location };
    let bestGoal = Infinity, bestAt = t0, noProg = 0, waitAct = -9999;
    let route = null, wi = 0, lastBoat = { ...boat.location }, lastBoatMoveTick = t0, stuckAt = null, stuckCount = 0, lastJump = 0, replans = 0;
    const ride = !!mount;
    const move = (to, speed) => { try { sim.moveToLocation(to, { speed }); } catch { /* */ } };
    const sep = () => flat(subject().location, boat.location);

    const note = (t) => { if (m.notes.length < 16) m.notes.push(`${Math.round((system.currentTick - t0) / 20)}s ${t}`); };
    // The route: the walking search first; where it cannot get there (a gap, a wall), the search that may also place and break blocks, its
    // building steps kept as `act` points the bot does together (the boat brought up close first) when it gets to them.
    const plan = async (target) => {
      const from = subject().location;
      let res = await a.plan(from, target, 1.5, 12000);
      S.check(gen);
      let built = false;
      const last = res.path?.[res.path.length - 1];
      const progress = last ? Math.hypot(last.x + 0.5 - from.x, last.z + 0.5 - from.z) : 0;
      // Only when walking gets no further (the edge of the gap): the walk to it is by the walking route, not a bridge across a pond.
      if (!res.complete && progress < 4 && !ride && opts.build !== false && S.blockCount() >= 2) {
        const ar = await a.plan(from, target, 1.5, 20000, null, { actions: S.actionOpts(), weight: 2 });
        S.check(gen);
        if (ar.complete && ar.path.length >= 2) { res = ar; built = true; note(`route with ${ar.path.filter((p) => !isWalkMove(p)).length} building steps`); }
      }
      if (!res.path || res.path.length < 2) return null;
      m.pathLen += res.path.length;
      const out = [];
      res.path.forEach((c, i) => {
        const pt = { x: c.x + 0.5, y: c.y, z: c.z + 0.5, node: c, act: built && i > 0 && !isWalkMove(c) };
        const prev = res.path[i - 1], next = res.path[i + 1];
        const keep = i === 0 || i === res.path.length - 1 || pt.act || (built && next && !isWalkMove(next)) || prev.y !== c.y || (next && next.y !== c.y) || i % 2 === 0;
        if (keep) out.push(pt);
      });
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
      // No progress: the boat no nearer the goal by 1.5 blocks in 25 s. The first time, a new route; the second, give up (said why).
      { const bd = flat(boat.location, goal); if (bd < bestGoal - 1.5) { bestGoal = bd; bestAt = system.currentTick; } else if (system.currentTick - bestAt > 500) {
        if (noProg++ >= 1) { m.why = `no progress for 25 s (boat ${bd.toFixed(0)} from the goal, ${d.toFixed(1)} from me)`; break; }
        note(`no progress: new route`); route = null; bestAt = system.currentTick; continue; } }
      const wp = route[wi];
      const jammed = d > lo + 0.5 && system.currentTick - lastBoatMoveTick > patience;
      const boatMoving = system.currentTick - lastBoatMoveTick <= 10;
      // The lead nearly at its limit with the boat coming along: stop and let it catch up (no tug). Slower from 2.5 short of it.
      if (d >= guard - 0.2 && boatMoving && !jammed) { try { sim.stopMoving(); } catch { /* */ } await S.wait(gen, 2); continue; }
      const stuck = jammed || d >= guard - 0.2;
      if (wp.act && !stuck) {
        // A building step (a bridge over a gap): the boat up close first, then all the steps in a row, with the blocks we carry.
        if (d > 5.5 && system.currentTick - waitAct < 160) { try { sim.stopMoving(); } catch { /* */ } await S.wait(gen, 2); continue; }
        const seg = [route[wi - 1]?.node ?? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }];
        let k = wi;
        while (k < route.length && route[k].act) { seg.push(route[k].node); k++; }
        note(`building ${seg.length - 1} steps at ${Math.round(pos.x)},${Math.round(pos.z)}`);
        const ok = await S.followActionPath(gen, seg, { sweep: false });
        m.built += seg.length - 1; waitAct = system.currentTick;
        if (!ok) { note('the building failed: new route'); route = null; continue; }
        wi = k; lastBoatMoveTick = system.currentTick;
        continue;
      }
      if (flat(pos, wp) < 1.1) { wi++; continue; }
      // Stuck: the boat hasn't moved while the lead is taut, or the lead is nearly at the guard distance.
      if (stuck) {
        try { sim.stopMoving(); } catch { /* */ }
        const rise = this.riseAhead(boat, pos);
        const here = `${Math.round(boat.location.x)},${Math.round(boat.location.z)}`;
        stuckCount = stuckAt === here ? stuckCount + 1 : 1; stuckAt = here;
        if (rise >= 0.4 && pos.y - boat.location.y >= 0.4 && stuckCount <= 4) {
          // Below us against a step: the sling, a little further stretched each time it fails.
          m.slings++;
          const target = stretchFor(rise) + (stuckCount - 1) * 1.0;
          const rw = ride ? null : await this.runway(gen, boat, target, guard);
          if (rw?.built) { note(`runway: ${rw.built} blocks`); m.built += rw.built; }
          const r = await this.sling(gen, boat, { ride, target, guard, dir: rw?.dir ?? null });
          trace(`tow: sling at rise ${rise}: stretch ${r.stretch}, ${r.ok ? 'it came' : r.snapped ? 'LEAD BROKE' : 'it did not come'}, boat peaked ${r.peak} b/s, climbed ${r.climbed}`);
          note(`sling at rise ${rise}: ${r.ok ? 'it came' : r.snapped ? 'LEAD BROKE' : 'did not come'}`);
          if (r.ok) { m.slingOk++; stuckCount = 0; }
          if (r.snapped) { m.snapped = true; m.why = 'the lead broke in a sling'; break; }
          lastBoatMoveTick = system.currentTick;
          continue;
        }
        m.tugs++;
        note(`unstick ${stuckCount} at ${here}`);
        // Something between us rather than a step below: back to the boat, round to a side with a clear line, on.
        await this.goTo(gen, { x: boat.location.x + 1.2, y: pos.y, z: boat.location.z + 1.2 }, ride, 3.5);
        const flank = this.flank(boat, wp, stuckCount, L?.flank ?? null);
        if (flank) await this.goTo(gen, flank, ride, 3.5);
        lastBoatMoveTick = system.currentTick;
        if (stuckCount >= 3) { m.reroutes++; route = null; stuckCount = 0; }
        continue;
      }
      // Full speed (what snaps a lead is being stuck, not going fast); a hop at a step up.
      move(wp, Math.max(0.2, Math.min(1, (opts.speed ?? 1) * (d > guard - 2.5 ? 0.5 : 1))));
      if (wp.y - pos.y > 0.6 && flat(pos, wp) < 1.7 && system.currentTick - lastJump > 8) { try { sim.jump(); m.steps++; lastJump = system.currentTick; } catch { /* */ } }
      await S.wait(gen, 1);
    }
    if (m.snapped && m.maxSep > 3) {
      // Where it broke is kept for the next tows in this world (and the guard stays under it).
      const c0 = a.memory.data.leadCal ?? {}, sl0 = c0.sling ?? {};
      const snapAt = Math.min(sl0.snapAt ?? 99, Math.round(m.maxSep * 10) / 10);
      a.memory.data.leadCal = { ...c0, sling: { ...sl0, snapAt, guard: Math.max(5, snapAt - 0.8) } };
      note(`the lead broke at ${snapAt}`);
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
