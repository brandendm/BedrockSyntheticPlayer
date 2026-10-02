// Crossing a large body of water in a boat, and keeping the boat for the next lake.
//   - A boat is in the pack, or is made (5 planks and a table: the planner's craft, a table put down if there is none, logs fetched if need be).
//   - At the shore it is put on the water with the item (what a player does), the bot gets in (interacts with it, else the game's own call), and
//     it is driven across to the far shore: steered with the movement the way a player does if that moves the boat, else pushed along its heading
//     (applyImpulse). What it did is in the result and the trace.
//   - Out at the far shore, the boat is hit until it breaks and the item is picked up again: it goes in the pack for next time.
// `cross` is called by Skills.travelToward when the way there runs through water 8 or more blocks wide (and from the boat test); `probe` finds the
// shore and the far shore along the straight line to a target when the walking search stops at the water.
import { system, Direction } from '@minecraft/server';
import { invCounts, hold, take, give } from './inventory.js';
import { isPlanks, isLog, count, has } from '../core/recipes.js';
import { trace } from './bridge.js';
import { isWatery } from './world.js';

const flat = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
const strip = (id) => String(id ?? '').replace(/^minecraft:/, '');
export const BOAT_ID = /^(?:[a-z_]+_)?(?:boat|raft)$/;

/** A boat (or raft) item in the pack: a plain one before a chest boat. */
export function boatIn(inv) {
  const ids = Object.keys(inv).filter((id) => BOAT_ID.test(id) && inv[id] > 0);
  return ids.find((id) => !/chest/.test(id)) ?? ids[0] ?? null;
}

/** The boat item for the planks used (oak_planks -> oak_boat; bamboo -> raft). */
export function boatForPlanks(planks) {
  const w = strip(planks).replace(/_planks$/, '') || 'oak';
  return w === 'bamboo' ? 'bamboo_raft' : `${w}_boat`;
}

export class Boating {
  constructor(agent) { this.a = agent; this.lastNotes = []; }

  have() { return boatIn(invCounts(this.a.sim)); }

  /** A boat in hand: the one in the pack, else made. gather: fetch logs for it if there are not enough. */
  async acquire(gen, { gather = false } = {}) {
    const S = this.a.skills;
    if (this.have()) return true;
    const inv = invCounts(this.a.sim);
    const planks = count(inv, isPlanks) + 4 * count(inv, isLog);
    const table = !!(await S.findTable(5)) || has(inv, 'crafting_table');
    const need = 5 + (table ? 0 : 4);
    if (planks < need) {
      if (!gather) { trace(`boat: ${planks} planks' worth of wood, ${need} needed`); return false; }
      const want = count(inv, isLog) + Math.ceil((need - planks) / 4);
      this.a.sayOnce('boat-wood', 'I need a boat to cross this: getting wood for one.', 120000);
      await S.gatherLogs(gen, want);
    }
    if (!table) {
      if (!(await S.craft(gen, ['crafting_table'], false, true))) return false;
      if (!(await S.place(gen, 'crafting_table'))) return false;
    }
    if (!(await S.craft(gen, ['boat'], true, true))) return false;
    return !!this.have();
  }

  /**
   * Shore and far shore along the straight line from `from` to `target`: stepping 2 blocks at a time, the first water after land that is at
   * least 8 blocks across, and the first land after it. { shore, far, width } or null. Reads the top block of each column (chunks must be loaded).
   */
  probe(from, target, maxD = 160) {
    const S = this.a.skills, dim = this.a.dim;
    const dx = target.x - from.x, dz = target.z - from.z, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len;
    const kind = (x, z) => {
      try {
        const t = dim.getTopmostBlock({ x: Math.floor(x), z: Math.floor(z) });
        if (!t || typeof t.typeId !== 'string' || t.location.y > 300) return null;
        if (isWatery(t.typeId)) return { k: 'water', y: t.location.y };
        if (/leaves|ice$/.test(t.typeId)) return { k: 'bad', y: t.location.y };
        return { k: 'land', y: t.location.y + 1 };
      } catch { return null; }
    };
    let lastLand = null, wetFrom = null;
    for (let d = 2; d <= Math.min(maxD, len); d += 2) {
      const x = from.x + ux * d, z = from.z + uz * d, c = kind(x, z);
      if (!c) return null;
      if (c.k === 'land') {
        if (wetFrom !== null && d - wetFrom >= 8 && lastLand) return { shore: lastLand, far: { x: Math.floor(x) + 0.5, y: c.y, z: Math.floor(z) + 0.5 }, width: Math.round(d - wetFrom) };
        wetFrom = null; lastLand = { x: Math.floor(x) + 0.5, y: c.y, z: Math.floor(z) + 0.5 };
      } else if (c.k === 'water' && wetFrom === null) wetFrom = d;
    }
    void S;
    return null;
  }

  /** The boat entity (any kind) nearest `at`, within r. */
  boatNear(at, r = 5) {
    try {
      const all = this.a.dim.getEntities({ location: at, maxDistance: r }).filter((e) => /^minecraft:(chest_)?boat$|raft$/.test(e.typeId));
      all.sort((p, q) => flat(p.location, at) - flat(q.location, at));
      return all[0] ?? null;
    } catch { return null; }
  }

  /**
   * From the shore cell `shore` (we stand at or by it) over the water to `far`: boat out, in, across, out, boat back in the pack. Returns
   * { ok, why, how: { placed, boarded, steered }, secs }. The pack keeps the boat (or says why not).
   */
  async cross(gen, shore, far) {
    const a = this.a, S = a.skills, sim = a.sim, dim = a.dim;
    const t0 = system.currentTick, how = { placed: '', boarded: '', steered: '', picked: '' };
    const out = (ok, why) => { const r = { ok, why, how, secs: Math.round((system.currentTick - t0) / 20) }; this.last = r; trace(`boat: ${ok ? 'crossed' : `stopped: ${why}`} in ${r.secs}s (${JSON.stringify(how)})`); return r; };
    if (!(await this.acquire(gen, { gather: true }))) return out(false, 'no boat and no wood for one');
    this.crossing = true;
    try { return await this.crossInner(gen, shore, far, t0, how, out); } finally { this.crossing = false; }
  }

  async crossInner(gen, shore, far, t0, how, out) {
    const a = this.a, S = a.skills, sim = a.sim, dim = a.dim;
    const id = this.have();
    // To the water's edge toward the far shore.
    await S.goNear(gen, { x: shore.x, y: shore.y, z: shore.z }, 1.2, 2).catch(() => false);
    S.check(gen);
    // The water block to put it on: the nearest source water cell with air above it, toward the far shore.
    const f = S.feet();
    const ux = (far.x - sim.location.x), uz = (far.z - sim.location.z), ul = Math.hypot(ux, uz) || 1;
    let cell = null, best = Infinity;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [-1, 0]) {
      const c = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
      const b = S.blockAt(c) ?? '';
      if (!isWatery(b) || !/air|cave_air/.test(S.blockAt({ x: c.x, y: c.y + 1, z: c.z }) ?? '')) continue;
      const score = Math.hypot(dx, dz) * 1.5 - ((dx * ux + dz * uz) / ul) * 0.7;
      if (score < best) { best = score; cell = c; }
    }
    if (!cell) return out(false, `no open water beside the shore at ${f.x} ${f.y} ${f.z}`);
    // Put it on the water: the item used on the water block (what a player does).
    let boat = null;
    const slot = hold(sim, id);
    for (let tryN = 0; tryN < 3 && !boat && slot >= 0; tryN++) {
      await S.useGap(gen);
      try { sim.lookAtLocation({ x: cell.x + 0.5, y: cell.y + 0.9, z: cell.z + 0.5 }); } catch { /* */ }
      await S.wait(gen, 3);
      try { /** @type {any} */ (sim).useItemInSlotOnBlock(slot, cell, Direction.Up); } catch { /* */ }
      S.lastUseTick = system.currentTick;
      await S.wait(gen, 6);
      boat = this.boatNear({ x: cell.x + 0.5, y: cell.y + 1, z: cell.z + 0.5 }, 4);
      if (!boat && tryN === 1) { try { /** @type {any} */ (sim).useItemInSlot(slot); } catch { /* */ } await S.wait(gen, 6); boat = this.boatNear({ x: cell.x + 0.5, y: cell.y + 1, z: cell.z + 0.5 }, 5); }
      if (boat) how.placed = tryN === 0 ? 'item on the water' : 'item in the air';
    }
    if (!boat) {
      // The game would not take it: put by command (and the item taken from the pack), said so.
      try { boat = dim.spawnEntity(/chest/.test(id) ? 'minecraft:chest_boat' : 'minecraft:boat', { x: cell.x + 0.5, y: cell.y + 0.9, z: cell.z + 0.5 }); take(sim, id, 1); how.placed = 'by command'; } catch (e) { return out(false, `could not put the boat down: ${e}`); }
      await S.wait(gen, 6);
    }
    a.restHands?.();
    // In.
    const seated = () => !!a.boatUnder(sim);
    for (let tryN = 0; tryN < 3 && !seated() && boat.isValid; tryN++) {
      try { sim.lookAtLocation({ x: boat.location.x, y: boat.location.y + 0.5, z: boat.location.z }); } catch { /* */ }
      await S.wait(gen, 4);
      try { hold(sim, null); sim.interactWithEntity(boat); } catch { /* */ }
      await S.wait(gen, 8);
      if (seated()) how.boarded = 'interacted with it';
    }
    if (!seated() && boat.isValid) { try { if (boat.getComponent('minecraft:rideable')?.addRider(sim)) how.boarded = 'by the game call'; } catch { /* */ } await S.wait(gen, 6); }
    if (!seated()) return out(false, 'could not get into the boat');
    // Across: steered with the movement first (a player's way); if the boat does not move for 2 s, pushed along its heading.
    const goal = { x: far.x, y: far.y, z: far.z };
    let pushed = false, movedCheckAt = system.currentTick + 40, p0 = { ...boat.location }, lastLoc = { ...boat.location }, stillTicks = 0;
    let arrived = false;
    for (let tick = 0; tick < 20 * 120 && boat.isValid; tick++) {
      S.check(gen);
      const bl = boat.location;
      if (flat(bl, goal) <= 4.5) { arrived = true; break; }
      const dx = goal.x - bl.x, dz = goal.z - bl.z, dl = Math.hypot(dx, dz) || 1;
      try { sim.lookAtLocation({ x: bl.x + (dx / dl) * 8, y: bl.y + 1.6, z: bl.z + (dz / dl) * 8 }); } catch { /* */ }
      if (!pushed) {
        try { sim.moveToLocation(goal, { speed: 1 }); } catch { /* */ }
        if (system.currentTick >= movedCheckAt) {
          if (flat(bl, p0) < 2.5) { pushed = true; how.steered = 'pushed along its heading (the movement did not drive it)'; try { sim.stopMoving(); } catch { /* */ } }
          else how.steered = 'by the movement, like a player';
        }
      }
      if (pushed) {
        const v = flat(bl, lastLoc) * 20;
        if (v < 5.5) { try { boat.applyImpulse({ x: (dx / dl) * 0.1, y: 0, z: (dz / dl) * 0.1 }); } catch { /* */ } }
      }
      // Stuck against something (the shore, an island) for 4 s: nudged sideways.
      stillTicks = flat(bl, lastLoc) < 0.02 ? stillTicks + 1 : 0;
      if (stillTicks > 80) { try { boat.applyImpulse({ x: -dz / dl * 0.3, y: 0.05, z: dx / dl * 0.3 }); } catch { /* */ } stillTicks = 0; }
      lastLoc = { ...bl };
      await S.wait(gen, 1);
    }
    try { sim.stopMoving(); } catch { /* */ }
    if (!arrived) { a.leaveBoat?.(); return out(false, boat.isValid ? 'did not reach the far shore in 2 minutes' : 'the boat was lost'); }
    // Out and ashore.
    a.leaveBoat?.();
    await S.wait(gen, 6);
    await S.goNear(gen, goal, 1.5, 3).catch(() => false);
    S.check(gen);
    // The boat back into the pack: hit until it breaks, the item picked up.
    let spot = null;
    if (boat.isValid) {
      spot = { ...boat.location };
      if (flat(sim.location, spot) > 3.5) await S.goNear(gen, { x: spot.x, y: sim.location.y, z: spot.z }, 3, 1).catch(() => false);
      for (let i = 0; i < 14 && boat.isValid; i++) {
        try { sim.lookAtEntity?.(boat); } catch { /* */ }
        try { hold(sim, null); sim.attackEntity(boat); } catch { /* */ }
        await S.wait(gen, 8);
        S.check(gen);
      }
      await S.sweep(gen, spot, 6, (it) => BOAT_ID.test(it), 8).catch(() => 0);
    }
    how.picked = this.have() ? 'back in the pack' : 'left behind';
    return out(true, '');
  }
}
