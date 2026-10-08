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
import { towTune } from '../core/towtune.js';
import { hold } from './inventory.js';
import { isWalkMove } from '../core/pathfinder.js';
import { slingCame, stuckTrack, learnedStretch } from '../core/towlearn.js';
import { liftPlan } from '../core/liftmodel.js';
import { pullPath, flankSpots, climbSpot, LEAD_SLACK } from '../core/towline.js';

const pt3 = (p) => (p ? [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10] : null);
const flat = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
const WALK_BPS = 4.3, RIDE_BPS = 9; // blocks per second at full speed, on foot and on a horse (for the "ideal" time)

export class LeadTow {
  constructor(agent) { this.a = agent; }

  /** A trace note; a hired bot's (game/crew.js) carries its name, since several tows write to the one log at once. */
  tr(msg) { trace(this.a.worker ? `[${this.a.sim.name}] ${msg}` : msg); }

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
   * surf(x, z) for core/towline.js: the y a boat sits at in a block column near `y0` (the top of the first block that is not open going down
   * from 4 above, water counts: it floats), -Infinity if there is none. Real blocks, not natural ground: a bridge we built is a floor. Cached
   * for the life of the returned function (made fresh for each question: blocks get placed).
   */
  surface(y0) {
    const S = this.a.skills, cache = new Map();
    const OPEN = /^(air|cave_air|void_air|short_grass|tall_grass|fern|snow_layer|vine|torch|sapling|poppy|dandelion)$/;
    const surf = (x, z) => {
      const k = `${x},${z}`;
      if (cache.has(k)) return cache.get(k);
      let top = -Infinity;
      for (let yy = Math.floor(y0) + 4; yy >= Math.floor(y0) - 8; yy--) {
        const id = S.blockAt({ x, y: yy, z });
        if (id == null) continue;
        if (OPEN.test(id)) continue;
        top = /^(water|flowing_water)$/.test(id) ? yy + 0.9 : yy + 1;
        break;
      }
      cache.set(k, top);
      return top;
    };
    return surf;
  }

  /** The surface we can stand on in a column near `y0` (a floor with two open blocks over it), else null; for core/towline.js. */
  standableAt(y0) {
    const S = this.a.skills, surf = this.surface(y0);
    return (x, z) => {
      const top = surf(x, z);
      if (!Number.isFinite(top) || Math.abs(top - y0) > 4) return null;
      const OPENISH = /^(air|cave_air|void_air|short_grass|tall_grass|fern|snow_layer)$/;
      const a = S.blockAt({ x, y: Math.ceil(top), z }) ?? 'air', b = S.blockAt({ x, y: Math.ceil(top) + 1, z }) ?? 'air';
      return OPENISH.test(a) && OPENISH.test(b) ? top : null;
    };
  }

  /**
   * The sling: with the boat jammed below us, walk away from it along the line until the lead is stretched to `target`
   * (never past `guard`), then jump; the boat flies to us. Watches the next 2 s. Returns
   * { ok, snapped, stretch, peak (the boat's fastest, blocks/s), climbed (how much higher it ended than it began) }.
   */
  async sling(gen, boat, { ride = false, target, guard, dir = null, jumps = 1 }) {
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
      // (u267, found by the simulator: on a runway that was one block short the walk away from the boat carried on past its end and the bot fell in the pit)
      if (!ride) {
        const ux = to.x - p.x, uz = to.z - p.z, ul = Math.hypot(ux, uz) || 1;
        const under = S.blockAt({ x: p.x + (ux / ul) * 0.9, y: Math.floor(p.y + 0.01) - 1, z: p.z + (uz / ul) * 0.9 }) ?? 'air';
        if (/^(air|cave_air|void_air|water|flowing_water|lava|flowing_lava)$/.test(under)) break;
      }
      try { sim.moveToLocation(to, { speed: d > goal - 1.5 ? 0.4 : 1 }); } catch { /* */ }
      await S.wait(gen, 1);
    }
    try { sim.stopMoving(); } catch { /* */ }
    await S.wait(gen, 3);
    const stretch = flat(subj().location, boat.location), y0 = boat.location.y, start = { ...boat.location };
    let peak = 0, last = { ...boat.location }, snapped = false, best = y0;
    // (u281, core/liftmodel.js: with the lead only a little past its pull length a jump moves the boat a little: jump again, up to `jumps` times, from where we stand.)
    for (let j = 0; j < Math.max(1, jumps) && !snapped; j++) {
      try { sim.jump(); } catch { /* */ }
      let came = false;
      for (let i = 0; i < (j + 1 < jumps ? 22 : 40); i++) {
        S.check(gen);
        await S.wait(gen, 1);
        if (!boat.isValid || !this.isLeashed(boat)) { snapped = true; break; }
        peak = Math.max(peak, Math.hypot(boat.location.x - last.x, boat.location.y - last.y, boat.location.z - last.z) * 20);
        best = Math.max(best, boat.location.y);
        last = { ...boat.location };
        // (u258: it is clear it came once it has climbed or travelled toward us: no need to watch the other two seconds)
        if (i >= 10 && (best - y0 >= 0.8 || flat(boat.location, start) >= 2.5)) { came = true; break; }
      }
      if (came) break;
    }
    // It came if it travelled toward us, or went up (see slingCame): not "it is level with us / near", which a boat that never moved can be.
    const ok = slingCame({ snapped, valid: boat.isValid, moved: boat.isValid ? flat(boat.location, start) : 0, closer: boat.isValid ? stretch - flat(subj().location, boat.location) : 0, climbed: best - y0 });
    return { ok, snapped, stretch: Math.round(stretch * 10) / 10, peak: Math.round(peak * 10) / 10, climbed: Math.round((best - y0) * 10) / 10 };
  }

  /**
   * A gap straight on from the lip we stand at (the walking route ends there): how wide, and if the blocks and the lead allow, a bridge across it,
   * a cell at a time, the boat brought up close first (a lead left behind while the bot builds breaks at 10). Returns { built, width, why }.
   */
  async bridgeGap(gen, boat, goal, guard) {
    const S = this.a.skills, sim = this.a.sim;
    const OPENISH = /^(air|cave_air|void_air|short_grass|tall_grass|fern|snow_layer|water|flowing_water|lava|flowing_lava)$/;
    const f = S.feet();
    const dx = goal.x - (f.x + 0.5), dz = goal.z - (f.z + 0.5);
    const dir = Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
    const at = (k, dy = 0) => S.blockAt({ x: f.x + dir[0] * k, y: f.y + dy, z: f.z + dir[1] * k }) ?? 'air';
    if (!OPENISH.test(at(1, -1)) || !OPENISH.test(at(1)) || !OPENISH.test(at(1, 1))) return { built: 0, width: 0, why: 'no gap straight on' };
    // The far side: the first cell with a floor at this level (or one up: a step), clear above it.
    let land = 0;
    for (let k = 2; k <= 10 && !land; k++) if (!OPENISH.test(at(k, -1)) && OPENISH.test(at(k)) && OPENISH.test(at(k, 1))) land = k;
    const width = land ? land - 1 : 0;
    if (!land) return { built: 0, width: 0, why: 'no far side within 10' };
    if (S.blockCount() < width) return { built: 0, width, why: `${S.blockCount()} blocks for a gap ${width} wide` };
    // (u259 live, leadledge: the bridge was begun with the boat still below the wall, climbing it; it jammed after five cells and no sling would come across the half bridge.
    // Sling it up from solid ground first: it is the loop's jam handling that does that, with nothing built yet.)
    if (f.y - boat.location.y >= 0.9 && flat(sim.location, boat.location) > 2) return { built: 0, width, why: 'the boat is still below the lip', jam: true };
    let cur = { x: f.x, y: f.y, z: f.z }, built = 0;
    for (let k = 1; k <= land; k++) {
      S.check(gen);
      // The boat close enough that the next cell will not stretch the lead past the guard.
      // (u251 live, leadledge: the boat sat jammed at the wall's foot 8 away and the bot stood at the lip of the pit for 20 s waiting for it to
      // come, before the first block: a boat that does not move in 2 s is jammed, and is for the sling to free, not for waiting on)
      const b0 = { x: boat.location.x, z: boat.location.z };
      for (let w = 0; w < 100; w++) {
        const sepNow = flat(sim.location, boat.location);
        if (sepNow <= guard - 2 || !boat.isValid) break;
        if (w >= 20 && flat(boat.location, b0) < 0.4) return { built, width, why: 'the boat is jammed', jam: true };
        if (flat(boat.location, b0) >= 0.4) { b0.x = boat.location.x; b0.z = boat.location.z; w = Math.min(w, 10); }
        try { sim.stopMoving(); } catch { /* */ }
        await S.wait(gen, 2);
      }
      const next = { x: f.x + dir[0] * k, y: f.y, z: f.z + dir[1] * k };
      if (!(await S.bridgeTo(gen, cur, next))) return { built, width, why: `the block would not go at cell ${k}` };
      if (OPENISH.test(S.blockAt({ x: next.x, y: next.y - 1, z: next.z }) ?? 'air') === false || k < land) built++;
      cur = next;
    }
    return { built, width, why: '' };
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
    // (u268 live: a player's "it follows from 5 apart" was taken for the engine's: the lead does not pull before about 5.6, so a boat sitting still at 5.5 was "jammed" a second after the
    // start and yanked at 4.7, which pulls nothing: 7 s lost on every course. Never below 5.4.)
    const TT = towTune(a.memory.data.leadTune);
    const lo = Math.max(L?.pullAt ?? cal?.pullAt ?? 5, TT.loFloor);
    // (A lead was seen to break at 10.1 blocks with the stated maximum 12: never past 8.8 unless a calibration in this world found better.)
    const guard = Math.min(Math.min(TT.guardMax, SL.guard ?? TT.guardMax), lim.max * 0.95, SL.snapAt ? SL.snapAt - 0.8 : 99);
    const patience = Math.max(TT.patienceMin, Math.min(90, Math.round(L?.patience ?? TT.patienceDef)));
    // (u241: the player's own jump at this height of step first, from the tow courses; then the calibration; then a guess)
    const stretchFor = (rise) => learnedStretch(L?.sling, rise) ?? SL.byRise?.[Math.min(3, Math.max(1, Math.ceil(rise)))] ?? Math.min(guard - 0.5, lim.max * TT.stretchFrac);
    const m = { arrived: false, snapped: false, why: '', secs: 0, idealS: 0, efficiency: 0, holds: 0, tugs: 0, reroutes: 0, steps: 0, slings: 0, slingOk: 0, maxSep: 0, pullAt: null, boatMoved: 0, boatEnd: null, pathLen: 0, wet: false, notes: [], built: 0, ...lim, holdAt: guard };
    const t0 = system.currentTick, b0 = { ...boat.location };
    let bestGoal = Infinity, bestAt = t0, noProg = 0, waitAct = -9999;
    let route = null, wi = 0, lastBoat = { ...boat.location }, lastBoatMoveTick = t0, stuckAt = null, stuckCount = 0, lastJump = 0, replans = 0;
    const ride = !!mount;
    const walkTo = opts.walkTo ?? goal;   // where the walker's route ends (the boat's goal is `goal`)
    const move = (to, speed) => { try { sim.moveToLocation(to, { speed }); } catch { /* */ } };
    const sep = () => flat(subject().location, boat.location);

    // (u252) Where the time goes: the seconds in each state, said in the closing line and in the test's result, so "slow" says why.
    const led = {}; let ledL = 'walk', ledT = system.currentTick;
    const mark = (l) => { const n = system.currentTick; led[ledL] = (led[ledL] ?? 0) + (n - ledT); ledL = l; ledT = n; };
    const note = (t) => { if (m.notes.length < 16) m.notes.push(`${Math.round((system.currentTick - t0) / 20)}s ${t}`); };
    // (u281/u282) Lift the jammed boat from above: the formula (core/liftmodel.js) says how far out and how many jumps for the height we stand above it; a player's taught stretch first; each failure
    // goes further out and one jump more. Elevation without the length (a hill only two across at the top) is made up by the runway: blocks built out along the top.
    const liftFrom = async (rise, up) => {
      m.slings++; mark('sling');
      const hAbove = Math.round(Math.max(rise, up) * 2) / 2;
      const lp = liftPlan({ h: hAbove, guard });
      const learnedD = learnedStretch(L?.sling, rise);
      const target = (learnedD ?? lp.d) + (stuckCount - 1) * TT.slingStep;
      const nJumps = Math.min(4, (learnedD != null ? 1 : lp.jumps) + (stuckCount - 1));
      note(`lift: ${hAbove} up -> ${learnedD != null ? 'as taught' : lp.feasible ? 'formula' : 'formula (not enough length under the guard)'}: ${target.toFixed(1)} out, ${nJumps} jump${nJumps > 1 ? 's' : ''}`);
      const rw = ride ? null : await this.runway(gen, boat, target, guard);
      if (rw?.built) { note(`runway: ${rw.built} blocks`); m.built += rw.built; }
      const r = await this.sling(gen, boat, { ride, target, guard, dir: rw?.dir ?? null, jumps: nJumps });
      this.tr(`tow: sling at rise ${rise}: ${hAbove} up, ${target.toFixed(1)} out, ${nJumps} jumps: stretch ${r.stretch}, ${r.ok ? 'it came' : r.snapped ? 'LEAD BROKE' : 'it did not come'}, boat peaked ${r.peak} b/s, climbed ${r.climbed}`);
      note(`sling at rise ${rise}: ${r.ok ? 'it came' : r.snapped ? 'LEAD BROKE' : 'did not come'}`);
      if (r.ok) { m.slingOk++; stuckCount = 0; }
      return r;
    };
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
        // At the lip of a gap: a bridge across it, built a cell at a time with the boat kept close (the u186 run went down into the gap
        // with the boat left behind, and the lead broke at 11.6 apart); the building search is only for what that does not cover, and
        // only bridging and pillaring (never a drop, a dig).
        const bg = await this.bridgeGap(gen, boat, target, guard);
        // (u255 live, leadledge: the boat jammed after 5 of the 6 cells, and the half bridge was taken for a whole one: a new route was planned from its end, the walker
        // stepped off the missing 6th cell into the pit. A jam means a stop, whatever was built.)
        if (bg.built) { m.built += bg.built; note(`bridged ${bg.jam ? 'part of ' : ''}a gap ${bg.width} wide${bg.jam ? ` (${bg.built})` : ''}`); if (!bg.jam) return plan(target); }
        // (the boat is jammed behind us: stand and let the loop's own jam handling sling it free, with a runway if need be, then take a new route)
        // (u258 live, leadledge: the half bridge was held on, and the loop's jam handling then walked the bot off it into the pit (a straight walk to a flank spot or a step): 40 s.
        // With a bridge begun, the sling is done HERE, on the bridge, as often as it takes, and the bridging goes on from where it stopped.)
        if (bg.jam && (bg.built || bg.why === 'the boat is still below the lip')) {
          for (let t = 0; t < 3; t++) {
            m.slings++; mark('sling');
            // (nothing built yet: a runway out over the gap for the room to stretch the lead, as the loop's own sling has)
            const rw = bg.built ? null : await this.runway(gen, boat, stretchFor(3) + t * 0.8, guard);
            if (rw?.built) { note(`runway: ${rw.built} blocks`); m.built += rw.built; }
            const r = await this.sling(gen, boat, { ride: false, target: stretchFor(3) + t * 0.8, guard, dir: rw?.dir ?? null });
            this.tr(`tow: sling on the half bridge: stretch ${r.stretch}, ${r.ok ? 'it came' : r.snapped ? 'LEAD BROKE' : 'it did not come'}, boat peaked ${r.peak} b/s, climbed ${r.climbed}`);
            if (r.snapped) { m.snapped = true; m.why = 'the lead broke in a sling'; return null; }
            if (r.ok) {
              m.slingOk++; mark('plan');
              // (u260 live: the runway took us 5 cells over a 6-wide pit and the route search then called the one cell left walkable (a jump), so the walker stepped into it: the
              // bridge is finished first)
              const b2 = await this.bridgeGap(gen, boat, target, guard);
              if (b2.built) { m.built += b2.built; note(`bridged the rest of the gap (${b2.built})`); }
              // (u267, found by the simulator: the "came" was the boat creeping up the wall face, still jammed below the lip, and the bridge stopped one cell short: the route
              // search then took the one cell as a jump and the walker fell. A bridge that stopped on a jammed boat is slung again, not walked.)
              if (b2.jam) { note('the boat is still jammed: sling again'); continue; }
              return plan(target);
            }
          }
        }
        if (bg.jam) { note('the boat is jammed: sling it before bridging'); { const at = subject().location; return [{ x: at.x, y: at.y, z: at.z, hold: true, fresh: true }]; } }
        if (bg.why && bg.why !== 'no gap straight on') note(`gap: ${bg.why}`);
        const ar = await a.plan(from, target, 1.5, 20000, null, { actions: S.actionOpts(), weight: 2 });
        S.check(gen);
        const tame = ar.path?.every((c, i) => i === 0 || isWalkMove(c) || ['bridge', 'pillar'].includes(c.move?.type) ) && ar.path.every((c, i) => i === 0 || ar.path[i - 1].y - c.y <= 2);
        if (ar.complete && ar.path.length >= 2 && tame) { res = ar; built = true; note(`route with ${ar.path.filter((p) => !isWalkMove(p)).length} building steps`); }
        else if (ar.complete) note('a building route was found but it drops or digs: not taken');
      }
      if (!res.path || res.path.length < 2) return null;
      m.pathLen += res.path.length;
      // (u241: so the report says where it meant to go: the u241 ledge run stood at the foot of the wall for a minute)
      { const a0 = res.path[0], a1 = res.path[res.path.length - 1]; this.tr(`tow: route ${res.path.length} cells from ${a0.x},${a0.y},${a0.z} to ${a1.x},${a1.y},${a1.z} (${res.complete ? 'complete' : 'partial'}${built ? ', with building steps' : ''}), aimed at ${target.x.toFixed(0)},${target.y.toFixed(0)},${target.z.toFixed(0)}`); }
      const out = [];
      res.path.forEach((c, i) => {
        const pt = { x: c.x + 0.5, y: c.y, z: c.z + 0.5, node: c, act: built && i > 0 && !isWalkMove(c) };
        const prev = res.path[i - 1], next = res.path[i + 1];
        const keep = i === 0 || i === res.path.length - 1 || pt.act || (built && next && !isWalkMove(next)) || prev.y !== c.y || (next && next.y !== c.y) || (next && ((c.x - prev.x) !== (next.x - c.x) || (c.z - prev.z) !== (next.z - c.z))) || i % 2 === 0; // (u248: every corner is a waypoint: the walk is a straight line between them, and cut a corner of a gate's wall)
        if (keep) out.push(pt);
      });
      return out;
    };

    try { a.capsule.towOn = true; } catch { /* */ }
    let wetTicks = 0, stopErr = null, lastPos = { ...subject().location }, stillSince = system.currentTick, stillSaid = 0; a.towLast = null;
    // (u244: a run stopped by hand, or replaced, is recorded like any other: what it did so far, and where the boat and we were)
    try {
    for (let tick = 0; tick < (opts.maxS ?? 120) * 20; tick++) {
      S.check(gen);
      if (!boat.isValid || !this.isLeashed(boat)) { m.snapped = true; m.why = 'the lead broke'; break; }
      const pos = subject().location, d = sep();
      m.maxSep = Math.max(m.maxSep, d);
      // (u242 live, leadstair: a boat rocking at a step moved more than 0.05 every tick, so it was always "moving" and the bot waited 43 s at the guard distance: it has moved when it is 0.4 from where it was last counted)
      if (flat(boat.location, lastBoat) > 0.4) { if (m.pullAt === null) m.pullAt = d; lastBoat = { ...boat.location }; lastBoatMoveTick = system.currentTick; }
      // (u241 live: the walker reached the gold block with the boat left jammed 5.5 short, and that was "arrived". With `boatZone` the tow is
      // over only when the boat is in the zone; the walker then waits at its end of the route, slinging and unsticking as ever.)
      const walkerThere = flat(pos, walkTo) < 2.5;
      if (opts.boatZone) { if (flat(boat.location, goal) <= opts.boatZone && boat.location.y >= goal.y - 1.3) { m.arrived = true; break; } }
      else if (walkerThere) { m.arrived = true; break; }
      // (A pond is part of the leadboat course, and a lead drags the boat into it: swum out of, not given up on at the first stroke; the u204 bot
      // went in after the boat it had dragged there and the test was lost to the swim-out reflex. Ten seconds in all ends the tow.)
      if (sim.isInWater && !ride) { m.wet = true; if (++wetTicks > 200) { m.why = 'in water for 10 s (the route should never go there)'; break; } }
      if (!route || wi >= route.length) {
        try { sim.stopMoving(); } catch { /* */ }
        if (replans++ > 12) { m.why = 'could not find a way on'; break; }
        // (u244 live, leadstep: it held 1.8 short of the end of its walk, so the lead's slack left the boat 4.5 from the gold block, outside the zone, and it waited there 20 s: it holds at the very end)
        if (opts.boatZone && walkerThere) { route = [{ x: walkTo.x, y: pos.y, z: walkTo.z, hold: true }]; wi = 0; } else { mark('plan'); route = await plan(walkTo); mark('walk'); wi = 0; stillSince = system.currentTick; lastPos = { ...subject().location }; /* (u255: planning, a bridge in it, took seconds: that is not standing still) */ }
        if (!route) { m.why = 'no land route to the goal'; break; }
        if (!m.idealS) m.idealS = flat(pos, goal) / (ride ? RIDE_BPS : WALK_BPS);
      }
      // No progress: the boat no nearer the goal by 1.5 blocks in 25 s. The first time, a new route; the second, give up (said why).
      { const bd = flat(boat.location, goal); if (bd < bestGoal - 1.5) { bestGoal = bd; bestAt = system.currentTick; } else if (system.currentTick - bestAt > 500) {
        // (What it was doing, so the next report says why: where we are, the waypoint, how far along the route, whether the boat counts as jammed.)
        const wpn = route?.[wi], dbg = `me ${pos.x.toFixed(0)},${pos.z.toFixed(0)} y${pos.y.toFixed(1)}, waypoint ${route ? `${wi}/${route.length}` : 'none'}${wpn ? ` at ${wpn.x.toFixed(0)},${wpn.z.toFixed(0)} y${wpn.y.toFixed(1)}` : ''}, jam over ${(lo + 0.5).toFixed(1)} apart, boat still ${Math.round((system.currentTick - lastBoatMoveTick) / 20)}s`;
        if (noProg >= 1) { try { a.capsule.snap('tow: no progress for 25 s'); } catch { /* */ } }
        if (noProg++ >= 1) { m.why = `no progress for 25 s (boat ${bd.toFixed(0)} from the goal, ${d.toFixed(1)} from me; ${dbg})`; break; }
        note(`no progress: new route (${dbg})`); route = null; bestAt = system.currentTick; continue; } }
      const wp = route[wi];
      try { a.capsule.watch = { tick: system.currentTick, boat, goal: pt3(goal), wp: pt3(wp), wi, n: route.length, d: Math.round(d * 10) / 10, guard: Math.round(guard * 10) / 10, stuck: stuckCount, still: Math.round((system.currentTick - lastBoatMoveTick) / 20), act: !!wp.act, hold: !!wp.hold }; } catch { /* */ }
      // (u247 live, leadledge: the bot stood on the first step for 20 s, nothing logged, the boat 4.1 behind, and the run was stopped by hand. A walker that has not moved
      // for 4 s, while not waiting for the boat at the end of its route, says where it is and why it might be, hops, and after 8 s takes a new route.)
      if (flat(pos, lastPos) > 0.4) { lastPos = { ...pos }; stillSince = system.currentTick; }
      else if (!(wp.hold && flat(pos, wp) < 1.1) && system.currentTick - stillSince > 80 && system.currentTick - stillSaid > 80) {
        stillSaid = system.currentTick;
        this.tr(`tow: standing still ${Math.round((system.currentTick - stillSince) / 20)}s at ${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}: waypoint ${wi}/${route.length} at ${wp.x.toFixed(1)},${wp.y.toFixed(1)},${wp.z.toFixed(1)}${wp.act ? ' (a building step)' : ''}, boat ${d.toFixed(1)} away and ${system.currentTick - lastBoatMoveTick > 10 ? 'still' : 'moving'}, guard ${guard.toFixed(1)}`);
        try { a.capsule.snap('tow: standing still'); } catch { /* */ }
        try { a.body.jump(); } catch { /* */ }
        if (system.currentTick - stillSince > 160) { note('standing still: new route'); route = null; stillSince = system.currentTick; continue; }
      }
      const jammed = d > lo + 0.5 && system.currentTick - lastBoatMoveTick > patience;
      const boatMoving = system.currentTick - lastBoatMoveTick <= 10;
      // The lead nearly at its limit with the boat coming along: stop and let it catch up (no tug). Slower from 2.5 short of it.
      if (d >= guard - 0.2 && boatMoving && !jammed) { mark('wait for the boat'); try { sim.stopMoving(); } catch { /* */ } await S.wait(gen, 2); continue; }
      const stuck = jammed || d >= guard - 0.2;
      if (wp.act && !stuck) {
        // A building step (a bridge over a gap): the boat up close first, then all the steps in a row, with the blocks we carry.
        if (d > 5.5 && system.currentTick - waitAct < 160) { mark('wait for the boat'); try { sim.stopMoving(); } catch { /* */ } await S.wait(gen, 2); continue; }
        mark('build');
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
      // (the end of the route, with the boat still short of its zone: wait here, unless the boat is stuck, which is handled below)
      if (wp.hold && flat(pos, wp) < 1.1 && !stuck) { mark('hold at the end'); await S.wait(gen, 2); continue; }
      // (u248 live, leadledge: the first step counted as reached from beside it, and the next waypoint, 2 up, was then walked at without a hop: a waypoint above us counts only once we are up on it)
      if (!wp.hold && flat(pos, wp) < 1.1 && pos.y >= wp.y - 0.6) { wi++; continue; }
      // Stuck: the boat hasn't moved while the lead is taut, or the lead is nearly at the guard distance.
      if (stuck) {
        mark('jam');
        try { sim.stopMoving(); } catch { /* */ }
        const here = `${Math.round(boat.location.x)},${Math.round(boat.location.z)}`;
        // The same place = within 1.5 of where the count began (a boat that rocks a little is still stuck).
        const tr = stuckTrack(stuckAt ? { anchor: stuckAt, count: stuckCount } : null, boat.location); stuckCount = tr.count; stuckAt = tr.anchor;
        // Where the pull of the lead sends the boat from here (a straight line at us, stopped by a step, sliding along a face it meets
        // at an angle: core/towline.js), so the report says what it was jammed against. The u204 villagerhaul run: the walker went round a
        // one-block rise, the boat was pulled into its face and stayed there 54 s, and every "flank" line crossed the same rise.
        const bl = boat.location, level = bl.y, surf = this.surface(level);
        const pp = pullPath(surf, bl, pos, level, { stop: LEAD_SLACK });
        const stepRise = !pp.clear && Number.isFinite(pp.rise) ? pp.rise : 0;
        const rise = Math.max(this.riseAhead(boat, pos), stepRise);
        const above = pos.y - bl.y >= 0.4;
        this.tr(`tow: stuck #${stuckCount}: boat ${bl.x.toFixed(1)},${bl.y.toFixed(1)},${bl.z.toFixed(1)}, me ${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)} (${d.toFixed(1)} apart); the pull ${pp.clear ? 'is clear' : pp.at ? `stops at ${pp.at.x.toFixed(1)},${pp.at.z.toFixed(1)} against ${Number.isFinite(pp.rise) ? `a step of ${pp.rise}` : 'no floor'}` : 'is stuck'}${above ? ', we are above it' : ''}`);
        // (u242 live, leadturn/leadgate: a boat clipping the inside of a corner is stopped by a wall, not a step (rise 0): the same way round: stand where the pull clears it)
        if (!ride && !above && !pp.clear && stuckCount <= 6) {
          // A step in the boat's way and we are level with it (we went round, or are on the far side): not a sling (that is lifted from
          // above). Round it by standing where the pull clears it, else up onto it, and pull again.
          const standable = this.standableAt(level);
          const spots = stuckCount <= 3 ? flankSpots({ surf, standable, boat: bl, level, wp, me: pos }) : [];
          if (spots.length) {
            const sp = spots[Math.min(spots.length - 1, stuckCount - 1)];
            m.tugs++;
            mark('flank'); note(`round the step: to ${sp.x.toFixed(0)},${sp.z.toFixed(0)} so the boat comes to ${sp.end.x.toFixed(0)},${sp.end.z.toFixed(0)}`);
            await S.goNear(gen, { x: sp.x, y: sp.y, z: sp.z }, 1.2, 1).catch(() => false);
            lastBoatMoveTick = system.currentTick;
            if (flat(subject().location, wp) > 8) route = null;
            continue;
          }
          // (u270/u273: one jump with the lead taut from where we stand, before climbing. probewall in the real game: past a WALL 1-2 high this never lifts the boat over (six tries at 7-9.5, it peaked 1.2-1.5 and
          // never passed the face), but on a STAIR it is 4 s quicker (sim 8 s vs 12.8, real ~10 vs 14). So one try, then the climb.)
          if (stepRise >= 0.4 && stuckCount <= 1 && d >= 3) {
            m.slings++; mark('sling');
            const r = await this.sling(gen, boat, { ride, target: Math.min(guard - 0.3, TT.groundTarget), guard });
            this.tr(`tow: sling from the ground, rise ${stepRise}: stretch ${r.stretch}, ${r.ok ? 'it came' : r.snapped ? 'LEAD BROKE' : 'it did not come'}, boat peaked ${r.peak} b/s, climbed ${r.climbed}`);
            note(`sling from level ground at rise ${stepRise}: ${r.ok ? 'it came' : r.snapped ? 'LEAD BROKE' : 'did not come'}`);
            if (r.ok) { m.slingOk++; stuckCount = 0; }
            if (r.snapped) { m.snapped = true; m.why = 'the lead broke in a sling'; break; }
            continue;
          }
          const cs = stepRise >= 0.4 ? climbSpot({ surf, standable, boat: bl, level, toward: pos }) : null;
          if (cs) {
            m.tugs++;
            mark('flank'); note(`up onto the step at ${cs.x.toFixed(0)},${cs.z.toFixed(0)} (${(cs.y - level).toFixed(1)} up)`);
            await S.goNear(gen, { x: cs.x, y: cs.y, z: cs.z }, 1, 2).catch(() => false);
            lastBoatMoveTick = system.currentTick;
            // (u282, live villagerhaul: up on the step the bot stood 1.4 from the boat, the lead slack, and the route took it off down the far side: the boat never came. Up here the lift is done NOW.)
            { const p2 = subject().location, b2 = boat.location;
              if (!ride && boat.isValid && this.isLeashed(boat) && p2.y - b2.y >= 0.4) {
                const r2 = await liftFrom(stepRise, p2.y - b2.y);
                if (r2.snapped) { m.snapped = true; m.why = 'the lead broke in a sling'; break; }
                lastBoatMoveTick = system.currentTick;
              } }
            continue;
          }
          note('a step in the way: no way round, none to climb onto');
        }
        if (rise >= 0.4 && above && stuckCount <= 4) {
          // Below us against a step: the sling, a little further stretched each time it fails.
          const r = await liftFrom(rise, pos.y - bl.y);
          if (r.snapped) { m.snapped = true; m.why = 'the lead broke in a sling'; break; }
          lastBoatMoveTick = system.currentTick;
          if (wp.fresh) route = null; // (a stand-and-sling waypoint: on with a new route)
          continue;
        }
        // (u241) Jammed with no step to lift it over (a corner, the edge of a gate), and the player was seen to jump and yank the boat free at
        // such a place (the tow courses): stretch the lead the way they did and jump, before going back to it.
        if (!ride && L?.sling?.flat && rise < 0.4 && stuckCount <= 2 && d >= 3 && !this.wallBetween(boat, pos)) {
          m.slings++; mark('sling');
          const target = Math.max(L.sling.flat.stretch, lo + TT.yankMargin) + (stuckCount - 1) * 0.8;
          const r = await this.sling(gen, boat, { ride, target, guard });
          this.tr(`tow: yank on the flat: stretch ${r.stretch}, ${r.ok ? 'it came' : r.snapped ? 'LEAD BROKE' : 'it did not come'}, boat peaked ${r.peak} b/s`);
          note(`yank (jump with the lead stretched, as you did) at ${here}: ${r.ok ? 'it came' : r.snapped ? 'LEAD BROKE' : 'did not come'}`);
          if (r.ok) { m.slingOk++; stuckCount = 0; }
          if (r.snapped) { m.snapped = true; m.why = 'the lead broke in a yank'; break; }
          lastBoatMoveTick = system.currentTick;
          continue;
        }
        m.tugs++;
        mark('unstick'); note(`unstick ${stuckCount} at ${here}`);
        // Something between us rather than a step below: back to the boat, round to a side with a clear line, on.
        await this.goTo(gen, { x: boat.location.x + 1.2, y: pos.y, z: boat.location.z + 1.2 }, ride, 3.5);
        const flank = this.flank(boat, wp, stuckCount, L?.flank ?? null);
        if (flank) await this.goTo(gen, flank, ride, 3.5);
        lastBoatMoveTick = system.currentTick;
        if (stuckCount >= 3) { m.reroutes++; route = null; stuckCount = 0; }
        continue;
      }
      // Full speed (what snaps a lead is being stuck, not going fast); a hop at a step up.
      mark('walk');
      move(wp, Math.max(0.2, Math.min(1, (opts.speed ?? 1) * (d > guard - 2.5 ? 0.5 : 1))));
      if (wp.y - pos.y > 0.6 && flat(pos, wp) < 1.7 && system.currentTick - lastJump > 8) { try { a.body.jump(); m.steps++; lastJump = system.currentTick; } catch { /* */ } } // (body.jump: afloat, a hop out onto the bank, where sim.jump does nothing)
      await S.wait(gen, 1);
    }
    } catch (e) { stopErr = e; m.why = m.why || 'the run was stopped'; }
    if (m.snapped && m.maxSep > 3) {
      // Where it broke is kept for the next tows in this world (and the guard stays under it).
      const c0 = a.memory.data.leadCal ?? {}, sl0 = c0.sling ?? {};
      const snapAt = Math.min(sl0.snapAt ?? 99, Math.round(m.maxSep * 10) / 10);
      a.memory.data.leadCal = { ...c0, sling: { ...sl0, snapAt, guard: Math.max(5, snapAt - 0.8) } };
      note(`the lead broke at ${snapAt}`);
    }
    try { if (stopErr && boat.isValid) note(`stopped with the boat ${flat(boat.location, goal).toFixed(1)} from the goal (y ${boat.location.y.toFixed(1)}), us ${flat(subject().location, goal).toFixed(1)} from it, ${sep().toFixed(1)} apart`); } catch { /* */ }
    try { a.capsule.towOn = false; } catch { /* */ }
    mark('end'); delete led.end;
    m.ledger = Object.fromEntries(Object.entries(led).map(([k, v]) => [k, Math.round(v / 2) / 10]).filter(([, v]) => v >= 0.1));
    this.tr(`tow: time ledger ${Object.entries(m.ledger).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}s`).join(', ')}`);
    m.secs = Math.round((system.currentTick - t0) / 20);
    m.boatMoved = boat.isValid ? flat(boat.location, b0) : 0;
    m.boatEnd = boat.isValid ? { x: Math.round(boat.location.x), z: Math.round(boat.location.z) } : null;
    m.efficiency = m.arrived && m.secs ? Math.round((m.idealS / m.secs) * 100) / 100 : 0;
    try { sim.stopMoving(); } catch { /* */ }
    this.tr(`tow: ${m.arrived ? 'arrived' : `stopped (${m.why || 'time'})`} in ${m.secs}s, efficiency ${m.efficiency}, apart ${m.maxSep.toFixed(1)} at most, ${m.slingOk}/${m.slings} slings, ${m.tugs} unsticks, ${m.reroutes} reroutes${m.snapped ? ', LEAD BROKE' : ''}`);
    const cal2 = a.memory.data.leadCal ?? {};
    a.memory.data.leadCal = { ...cal2, pullAt: m.pullAt ?? cal2.pullAt, lastTow: { ...m }, at: Date.now() };
    a.memory.save();
    a.towLast = m;
    if (stopErr) throw stopErr;
    return m;
  }

  /** (u241) Is there a solid block on the straight line from the boat to us (at the boat's height)? A jump cannot pull a boat through a wall. */
  wallBetween(boat, p) {
    const S = this.a.skills, b = boat.location, n = Math.max(2, Math.ceil(flat(b, p) / 0.5));
    const OPEN = /^(air|cave_air|void_air|short_grass|tall_grass|fern|snow_layer|water|flowing_water)$/;
    for (let i = 1; i < n; i++) {
      const x = b.x + (p.x - b.x) * i / n, z = b.z + (p.z - b.z) * i / n;
      for (const dy of [0.5, 1.2]) { const id = S.blockAt({ x: Math.floor(x), y: Math.floor(b.y + dy), z: Math.floor(z) }); if (id && !OPEN.test(id)) return true; }
    }
    return false;
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
