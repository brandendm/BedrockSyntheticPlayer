// Fishing: a rod in the pack (made, if the string is there), a shore cell by water, the rod cast out, the hook watched for the dip of a bite,
// the rod used again to reel in, the catch picked up. `fish(gen, { want, maxS })` fishes until `want` fish are in the pack or maxS seconds are
// up. Every stage is in the result and the trace: the hook entity's behaviour in the real game is not known until it has been seen
// (core/angling.js has the bite test; this logs the hook's samples when a cast shows nothing, `fishing.log`).
import { system } from '@minecraft/server';
import { invCounts, hold, findSlot } from './inventory.js';
import { trace } from './bridge.js';
import { isWatery } from './world.js';
import { newBite, biteStep, CAST_TIMEOUT, fishGained, CATCH, ROD_STRING } from '../core/angling.js';

const flat = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
const AIR = /^(air|cave_air)$/;

export class Fishing {
  constructor(agent) { this.a = agent; this.last = null; this.log = []; }

  hasRod() { return findSlot(this.a.sim, 'fishing_rod') >= 0; }

  /** A rod in hand: the pack's, else made when the string for it is there. */
  async acquire(gen) {
    if (this.hasRod()) return true;
    const S = this.a.skills, inv = invCounts(this.a.sim);
    if ((inv.string ?? 0) < ROD_STRING) { trace(`fishing: no rod and ${inv.string ?? 0} string (${ROD_STRING} needed)`); return false; }
    const table = !!(await S.findTable(5)) || (inv.crafting_table ?? 0) > 0;
    if (!table) {
      if (!(await S.craft(gen, ['crafting_table'], false, true))) return false;
      if (!(await S.place(gen, 'crafting_table'))) return false;
    }
    if (!(await S.craft(gen, ['fishing_rod'], true, true))) return false;
    return this.hasRod();
  }

  /** A shore: { stand, water } with a standable cell by open water (the surface at the level under our feet), the nearest to `from` within r. */
  findShore(from, r = 14) {
    const S = this.a.skills;
    const f = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) };
    let best = null, bd = Infinity;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const dy of [-1, 0, 1]) {
      const w = { x: f.x + dx, y: f.y - 1 + dy, z: f.z + dz };
      if (!/^water$/.test(S.blockAt(w) ?? '') || !AIR.test(S.blockAt({ x: w.x, y: w.y + 1, z: w.z }) ?? '')) continue;
      // the stand cell: a neighbour at the water's level+1 with ground under it, and more water out beyond (room to cast)
      for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const st = { x: w.x - ux, y: w.y + 1, z: w.z - uz };
        const under = S.blockAt({ x: st.x, y: st.y - 1, z: st.z }) ?? '';
        if (!AIR.test(S.blockAt(st) ?? '') || !AIR.test(S.blockAt({ x: st.x, y: st.y + 1, z: st.z }) ?? '')) continue;
        if (!under || AIR.test(under) || /water|lava|ice$/.test(under)) continue;
        let deep = 0;
        for (let k = 0; k < 4; k++) if (/^water$/.test(S.blockAt({ x: w.x + ux * k, y: w.y, z: w.z + uz * k }) ?? '')) deep++;
        if (deep < 3) continue;
        const d = Math.hypot(st.x - from.x, st.z - from.z) + Math.abs(st.y - from.y) * 2;
        if (d < bd) { bd = d; best = { stand: { x: st.x + 0.5, y: st.y, z: st.z + 0.5 }, water: { x: w.x + ux * 2 + 0.5, y: w.y + 1, z: w.z + uz * 2 + 0.5 } }; }
      }
    }
    return best;
  }

  hookNear(at, r = 24) {
    try {
      const hs = this.a.dim.getEntities({ type: 'minecraft:fishing_hook', location: at, maxDistance: r });
      hs.sort((p, q) => flat(p.location, at) - flat(q.location, at));
      return hs[0] ?? null;
    } catch { return null; }
  }

  /**
   * Fish until `want` more fish are in the pack or maxS seconds are up. { ok, caught (fish), casts, bites, why, notes }.
   * `shore` can be passed (a test sets one up); else the nearest water within 14 blocks is found.
   */
  async fish(gen, { want = 2, maxS = 120, shore = null } = {}) {
    const a = this.a, S = a.skills, sim = a.sim;
    const res = { ok: false, caught: 0, casts: 0, bites: 0, hooks: 0, why: '', notes: [] };
    const done = (why) => { res.why = why; res.ok = res.caught >= want; this.last = res; trace(`fishing: ${res.ok ? 'done' : `stopped (${why})`}: ${res.caught} fish, ${res.casts} casts, ${res.bites} bites, hook seen ${res.hooks}x ${res.notes.join('; ')}`); return res; };
    if (!(await this.acquire(gen))) return done('no rod');
    const spot = shore ?? this.findShore(sim.location);
    if (!spot) return done('no shore with water to cast into near here');
    a.sayOnce('fishing', 'Fishing for some food.', 120000);
    if (flat(sim.location, spot.stand) > 1.2) await S.goNear(gen, spot.stand, 0.8, 2).catch(() => false);
    S.check(gen);
    const t0 = system.currentTick;
    const baseline = invCounts(sim);
    while ((system.currentTick - t0) < maxS * 20 && res.caught < want) {
      S.check(gen);
      const slot = hold(sim, 'fishing_rod');
      if (slot < 0) return done('rod gone');
      try { sim.lookAtLocation(spot.water); } catch { /* */ }
      await S.wait(gen, 4);
      await S.useGap?.(gen);
      try { sim.useItemInSlot(slot); } catch (e) { res.notes.push(`cast threw ${e}`); }
      res.casts++;
      await S.wait(gen, 10);
      const hook = this.hookNear(sim.location);
      if (!hook) {
        res.notes.push('no hook entity after the cast');
        if (res.casts >= 3 && res.hooks === 0) return done('the cast puts no hook in the water (3 casts)');
        continue;
      }
      res.hooks++;
      const st = newBite(), before = invCounts(sim);
      let bit = false;
      const tCast = system.currentTick, samples = [];
      while (system.currentTick - tCast < CAST_TIMEOUT && hook.isValid && !bit) {
        S.check(gen);
        let y = 0, vy = 0, wet = false;
        try { const l = hook.location, v = hook.getVelocity(); y = l.y; vy = v.y; wet = hook.isInWater === true || isWatery(a.dim.getBlock({ x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z) })); } catch { break; }
        if ((system.currentTick - tCast) % 10 === 0 && samples.length < 40) samples.push([Math.round(y * 100) / 100, Math.round(vy * 1000) / 1000, wet ? 1 : 0]);
        bit = biteStep(st, { y, vy, wet });
        if (!bit) await S.wait(gen, 1);
      }
      if (bit) res.bites++;
      else if (!hook.isValid) res.notes.push('hook vanished');
      else { res.notes.push('no dip in 45 s: reeling anyway'); this.log.push(samples); }
      // Reel in (the rod used again), then the catch comes flying: pick it up.
      const hl = hook.isValid ? { ...hook.location } : { ...spot.water };
      try { hold(sim, 'fishing_rod'); sim.useItemInSlot(findSlot(sim, 'fishing_rod')); } catch (e) { res.notes.push(`reel threw ${e}`); }
      await S.wait(gen, 20);
      await S.sweep(gen, sim.location, 6, (it) => CATCH.test(it), 4).catch(() => 0);
      const g = fishGained(before, invCounts(sim));
      res.caught += g;
      if (bit && !g) res.notes.push('bite but nothing came');
    }
    try { a.restHands?.(); } catch { /* */ }
    const gained = fishGained(baseline, invCounts(sim));
    res.caught = Math.max(res.caught, gained);
    return done(res.caught >= want ? '' : 'out of time');
  }
}
