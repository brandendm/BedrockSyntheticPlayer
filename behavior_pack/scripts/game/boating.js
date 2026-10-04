// Crossing a large body of water in a boat, and keeping the boat for the next lake.
//   - A boat is in the pack, or is made (5 planks and a table: the planner's craft, a table put down if there is none, logs fetched if need be).
//   - At the shore it is put on the water with the item (what a player does), the bot gets in (interacts with it, else the game's own call, else
//     the ride command), and it is driven across to the far shore by pushing the boat along its heading (applyImpulse). What it did is in the
//     result and the trace.
//   - Out at the far shore, the boat is hit until it breaks and the item is picked up again: it goes in the pack for next time.
// `cross` is called by Skills.travelToward when the way there runs through water 8 or more blocks wide (and from the boat test); `probe` finds the
// shore and the far shore along the straight line to a target when the walking search stops at the water or ends in it.
// Driving is the push the boat arena proved (core/boating.js): a simulated player's movement does not steer a boat, so there is no 2 s try of it
// first (u204's boatcross spent its first 2 s of rowing finding that out, with a human at 8.5 s for the whole lake).
import { system, Direction } from '@minecraft/server';
import { invCounts, hold, take, give, findSlot } from './inventory.js';
import { isPlanks, isLog, count, has } from '../core/recipes.js';
import { trace } from './bridge.js';
import { isWatery } from './world.js';
import { shoreFromSamples, pushImpulse, driveSpeed, boatArrived, BOAT_VMAX } from '../core/boating.js';

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
    const dim = this.a.dim;
    const dx = target.x - from.x, dz = target.z - from.z, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len;
    const kind = (x, z) => {
      try {
        const t = dim.getTopmostBlock({ x: Math.floor(x), z: Math.floor(z) });
        if (!t || typeof t.typeId !== 'string' || t.location.y > 300) return null;
        if (isWatery(t)) return { k: 'water', y: t.location.y }; // (the block itself: isWatery(typeId) is always false, and the first probe saw land everywhere)
        if (/leaves|ice$/.test(t.typeId)) return { k: 'bad', y: t.location.y };
        return { k: 'land', y: t.location.y + 1 };
      } catch { return null; }
    };
    const samples = [];
    for (let d = 2; d <= Math.min(maxD, len); d += 2) {
      const x = from.x + ux * d, z = from.z + uz * d, c = kind(x, z);
      if (!c) return null;
      samples.push(c.k === 'land' ? { k: 'land', x: Math.floor(x) + 0.5, y: c.y, z: Math.floor(z) + 0.5 } : { k: c.k });
    }
    // (`from` counts as land: asked from the water's edge, as the crossing is, the old scan saw water first and had no shore to leave from.)
    const r = shoreFromSamples({ x: Math.floor(from.x) + 0.5, y: from.y, z: Math.floor(from.z) + 0.5 }, samples);
    return r ? { shore: r.shore, far: r.far, width: r.width } : null;
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
   * { ok, why, how: { placed, boarded, steered, picked, t: seconds at each stage, top: fastest b/s }, secs }. The pack keeps the boat (or says why not).
   * `arrivedAt` is the tick we stood ashore (before the boat is fetched back), for a test that times the crossing and not the tidying up.
   */
  async cross(gen, shore, far) {
    const t0 = system.currentTick, how = { placed: '', boarded: '', steered: '', picked: '', t: {}, top: 0 };
    const out = (ok, why) => {
      const r = { ok, why, how, secs: Math.round((system.currentTick - t0) / 2) / 10 };
      this.last = r;
      trace(`boat: ${ok ? 'crossed' : `stopped: ${why}`} in ${r.secs}s (${JSON.stringify(how)})`);
      return r;
    };
    this.arrivedAt = null;
    if (!(await this.acquire(gen, { gather: true }))) return out(false, 'no boat and no wood for one');
    this.crossing = true;
    try { return await this.crossInner(gen, shore, far, t0, how, out); } finally { this.crossing = false; }
  }

  async crossInner(gen, shore, far, t0, how, out) {
    const a = this.a, S = a.skills, sim = a.sim, dim = a.dim;
    const id = this.have();
    const at = () => Math.round((system.currentTick - t0) / 2) / 10;
    const stage = (name) => { how.t[name] = at(); };
    trace(`boat: crossing ${Math.round(flat(shore, far))} blocks from ${Math.round(shore.x)} ${Math.round(shore.z)} to ${Math.round(far.x)} ${Math.round(far.z)} with ${id}`);
    // To the water's edge toward the far shore (the walk that brought us here already ends on it).
    if (flat(sim.location, shore) > 1.8) await S.goNear(gen, { x: shore.x, y: shore.y, z: shore.z }, 1.2, 2).catch(() => false);
    S.check(gen);
    // The water block to put it on: the nearest source water cell with air above it, toward the far shore.
    const f = S.feet();
    const ux = (far.x - sim.location.x), uz = (far.z - sim.location.z), ul = Math.hypot(ux, uz) || 1;
    let cell = null, best = Infinity;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (const dy of [-1, 0]) {
      const c = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
      // (plain water with air above it; the first version handed isWatery the block's name, which is never water, so no cell was ever found)
      if (!/^(flowing_)?water$/.test(S.blockAt(c) ?? '') || !/^(air|cave_air)$/.test(S.blockAt({ x: c.x, y: c.y + 1, z: c.z }) ?? '')) continue;
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
      await S.wait(gen, 4);
      boat = this.boatNear({ x: cell.x + 0.5, y: cell.y + 1, z: cell.z + 0.5 }, 4);
      if (!boat && tryN === 1) { try { /** @type {any} */ (sim).useItemInSlot(slot); } catch { /* */ } await S.wait(gen, 4); boat = this.boatNear({ x: cell.x + 0.5, y: cell.y + 1, z: cell.z + 0.5 }, 5); }
      if (boat) how.placed = tryN === 0 ? 'item on the water' : 'item in the air';
    }
    if (!boat) {
      // The game would not take it: put by command (and the item taken from the pack), said so.
      try { boat = dim.spawnEntity(/chest/.test(id) ? 'minecraft:chest_boat' : 'minecraft:boat', { x: cell.x + 0.5, y: cell.y + 0.9, z: cell.z + 0.5 }); take(sim, id, 1); how.placed = 'by command'; } catch (e) { return out(false, `could not put the boat down: ${e}`); }
      await S.wait(gen, 3);
    }
    stage('placed');
    a.restHands?.();
    // In: interacted with (a player's way), else the game's call, else the ride command the boat arena sat its bot down with.
    const seated = () => !!a.boatUnder(sim);
    const board = async () => {
      for (let tryN = 0; tryN < 5 && !seated() && boat.isValid; tryN++) {
        try { sim.lookAtLocation({ x: boat.location.x, y: boat.location.y + 0.5, z: boat.location.z }); } catch { /* */ }
        await S.wait(gen, tryN ? 3 : 2);
        const how1 = tryN < 2 ? 'interacted with it' : tryN === 2 ? 'by the game call' : 'by command';
        if (tryN < 2) { try { hold(sim, null); sim.interactWithEntity(boat); } catch { /* */ } }
        else if (tryN === 2) { try { boat.getComponent('minecraft:rideable')?.addRider(sim); } catch { /* */ } }
        else { const l = boat.location; try { sim.runCommand(`ride @s start_riding @e[type=boat,x=${l.x},y=${l.y},z=${l.z},c=1] teleport_rider`); } catch { /* */ } }
        for (let k = 0; k < 8 && !seated(); k++) await S.wait(gen, 1);
        if (seated()) { how.boarded ||= how1; return true; }
      }
      return seated();
    };
    if (!(await board())) return out(false, 'could not get into the boat');
    stage('aboard');
    // Across: the boat's own velocity steered toward the far shore (core/boating.js pushImpulse), the boat pointed at it. A simulated player's
    // movement does not drive a boat (the u202 boat arena), so there is no try of that first.
    const goal = { x: far.x, y: far.y, z: far.z };
    how.steered = `pushed along its heading (up to ${BOAT_VMAX} b/s)`;
    let still = 0, last = { ...boat.location }, arrived = false, reseats = 0, nudges = 0;
    const tDrive = system.currentTick;
    for (let tick = 0; tick < 20 * 120 && boat.isValid; tick++) {
      S.check(gen);
      const bl = boat.location, v = boat.getVelocity(), spd = Math.hypot(v.x, v.z) * 20;
      how.top = Math.max(how.top, Math.round(spd * 10) / 10);
      const dx = goal.x - bl.x, dz = goal.z - bl.z, d = Math.hypot(dx, dz) || 1;
      still = flat(bl, last) < 0.02 ? still + 1 : 0;
      if (boatArrived({ d, speed: spd, stillTicks: still })) { arrived = true; break; }
      if (!seated()) {
        // Out of the seat (knocked, or the game let go): back in, a few times at most.
        if (reseats++ >= 4) return out(false, 'lost the seat on the way');
        trace(`boat: out of the seat ${d.toFixed(0)} blocks short: getting back in`);
        if (!(await board())) return out(false, 'could not get back into the boat');
        continue;
      }
      const imp = pushImpulse(v, dx / d, dz / d, driveSpeed(d, BOAT_VMAX, spd) / 20);
      try { boat.applyImpulse({ x: imp.x, y: 0, z: imp.z }); } catch { /* */ }
      try { boat.setRotation({ x: 0, y: Math.atan2(-dx, dz) * 180 / Math.PI }); } catch { /* */ }
      if (tick % 6 === 0) { try { sim.lookAtLocation({ x: bl.x + (dx / d) * 8, y: bl.y + 1.6, z: bl.z + (dz / d) * 8 }); } catch { /* */ } }
      // Stuck against something (the shore it was put down against, an island) for 1.5 s: shoved clear, along and a little sideways.
      if (still > 30 && d > 5) { try { boat.applyImpulse({ x: (dx / d) * 0.25 - (dz / d) * 0.1 * (nudges % 2 ? 1 : -1), y: 0.04, z: (dz / d) * 0.25 + (dx / d) * 0.1 * (nudges % 2 ? 1 : -1) }); } catch { /* */ } still = 0; nudges++; }
      if ((tick + 1) % 40 === 0) trace(`boat: ${at()}s at ${bl.x.toFixed(0)} ${bl.z.toFixed(0)}, ${d.toFixed(0)} to go, ${spd.toFixed(1)} b/s${nudges ? `, ${nudges} nudges` : ''}`);
      last = { ...bl };
      await S.wait(gen, 1);
    }
    try { sim.stopMoving(); } catch { /* */ }
    how.rowS = Math.round((system.currentTick - tDrive) / 2) / 10;
    if (!arrived) { a.leaveBoat?.(); return out(false, boat.isValid ? 'did not reach the far shore in 2 minutes' : 'the boat was lost'); }
    stage('across');
    // Out and ashore.
    a.leaveBoat?.();
    await S.wait(gen, 2);
    if (seated()) { try { sim.runCommand('ride @s stop_riding'); } catch { /* */ } await S.wait(gen, 2); } // (the eject did not take)
    await S.goNear(gen, goal, 1.2, 3).catch(() => false);
    S.check(gen);
    stage('ashore');
    this.arrivedAt = system.currentTick;
    // The boat back into the pack: hit until it breaks (a sword takes it in a hit or two, a bare hand in five), the item picked up.
    let spot = null;
    if (boat.isValid) {
      spot = { ...boat.location };
      if (flat(sim.location, spot) > 3.2) await S.goNear(gen, { x: spot.x, y: sim.location.y, z: spot.z }, 2.6, 1).catch(() => false);
      for (let i = 0; i < 14 && boat.isValid; i++) {
        try { sim.lookAtEntity?.(boat); } catch { /* */ }
        try { hold(sim, a.weaponId && findSlot(sim, a.weaponId) >= 0 ? a.weaponId : null); sim.attackEntity(boat); } catch { /* */ }
        await S.wait(gen, 8);
        S.check(gen);
      }
      await S.sweep(gen, spot, 6, (it) => BOAT_ID.test(it), 8).catch(() => 0);
      a.restHands?.();
    }
    how.picked = this.have() ? 'back in the pack' : 'left behind';
    stage('done');
    return out(true, '');
  }
}
