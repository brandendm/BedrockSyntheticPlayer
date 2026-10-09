// Cooking on a campfire: no furnace, no fuel. A campfire (in the pack, or made: 3 sticks, a coal or charcoal, 3 logs) is put down, up to four raw
// items are put on it (the item used on the fire), and 30 s later each comes off cooked as a drop beside it, which is picked up.
// `cook(gen)` returns { ok, put, got, why, notes }. The game side is not known until it has been seen (does a simulated player's item-on-block
// reach the fire?): the three ways tried (useItemInSlotOnBlock, interactWithBlock with the item in hand, useItemOnBlock) are in the result.
import { system, Direction } from '@minecraft/server';
import { invCounts, hold } from './inventory.js';
import { trace } from './bridge.js';
import { RAW } from '../core/settle.js';
import { cookBatch, canMakeCampfire, COOK_TICKS } from '../core/angling.js';

const flat = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
const COOKED = new Set(Object.values(RAW));

export class Campfire {
  constructor(agent) { this.a = agent; this.last = null; }

  /** A campfire in the pack (made if the materials are there). */
  async acquire(gen) {
    const S = this.a.skills, inv = invCounts(this.a.sim);
    if ((inv.campfire ?? 0) > 0) return true;
    if (!canMakeCampfire(inv)) return false;
    const table = !!(await S.findTable(5)) || (inv.crafting_table ?? 0) > 0;
    if (!table) {
      if (!(await S.craft(gen, ['crafting_table'], false, true))) return false;
      if (!(await S.place(gen, 'crafting_table'))) return false;
    }
    if (!(await S.craft(gen, ['campfire'], true, true))) return false;
    return (invCounts(this.a.sim).campfire ?? 0) > 0;
  }

  /** A lit campfire within r of `at`: its block cell, or null. */
  fireNear(at, r = 6) {
    const S = this.a.skills, f = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -2; dy <= 2; dy++) {
      const c = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
      if (S.blockAt(c) === 'campfire') return c;
    }
    return null;
  }

  /** Put one raw item on the fire; true when the pack gave one up. */
  async putOn(gen, fire, id) {
    const S = this.a.skills, sim = this.a.sim;
    const n0 = invCounts(sim)[id] ?? 0;
    const tries = [
      (slot) => sim.useItemInSlotOnBlock(slot, fire, Direction.Up, { x: 0.5, y: 0.5, z: 0.5 }),
      (slot) => sim.interactWithBlock(fire, Direction.Up),
      (slot) => sim.useItemOnBlock(sim.getComponent?.('minecraft:inventory')?.container?.getItem(slot), fire, Direction.Up, { x: 0.5, y: 0.5, z: 0.5 }),
    ];
    for (let k = 0; k < tries.length; k++) {
      const slot = hold(sim, id);
      if (slot < 0) return false;
      try { sim.lookAtBlock(fire); } catch { /* */ }
      await S.wait(gen, 3);
      try { tries[k](slot); } catch { /* */ }
      await S.wait(gen, 5);
      if ((invCounts(sim)[id] ?? 0) < n0) { this.how ||= ['useItemInSlotOnBlock', 'interactWithBlock', 'useItemOnBlock'][k]; return true; }
    }
    return false;
  }

  /** Cook what raw food there is: fire down, food on, wait, pick up. */
  async cook(gen, { fire = null } = {}) {
    const a = this.a, S = a.skills, sim = a.sim;
    const res = { ok: false, put: 0, got: 0, why: '', notes: [], how: '' };
    const done = (why) => { res.why = why; res.how = this.how ?? ''; res.ok = res.put > 0 && res.got >= res.put; this.last = res; trace(`campfire: ${res.ok ? 'done' : `stopped (${why})`}: ${res.put} on, ${res.got} off cooked${res.how ? ` (via ${res.how})` : ''} ${res.notes.join('; ')}`); return res; };
    this.how = '';
    const batch = cookBatch(invCounts(sim));
    if (!batch.length) return done('nothing raw to cook');
    let cell = fire ?? this.fireNear(sim.location, 8);
    if (!cell) {
      if (!(await this.acquire(gen))) return done('no campfire and no materials for one');
      const p = await S.place(gen, 'campfire');
      if (!p) return done('could not put the campfire down');
      cell = p;
    }
    S.check(gen);
    a.sayOnce('campfire', 'Cooking the meat on a campfire.', 120000);
    if (flat(sim.location, cell) > 2.4) await S.goNear(gen, { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, 2.2, 2).catch(() => false);
    const before = invCounts(sim);
    for (const { id, n } of batch) for (let i = 0; i < n; i++) {
      S.check(gen);
      if (await this.putOn(gen, cell, id)) res.put++; else { res.notes.push(`${id} would not go on`); break; }
    }
    if (!res.put) return done('nothing would go on the fire');
    // 30 s of cooking; the pickup after. Stand off the fire (it burns).
    const t0 = system.currentTick;
    while (system.currentTick - t0 < COOK_TICKS + 40) { S.check(gen); await S.wait(gen, 10); }
    await S.sweep(gen, { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, 5, (it) => COOKED.has(it), 8).catch(() => 0);
    const after = invCounts(sim);
    for (const id of COOKED) res.got += Math.max(0, (after[id] ?? 0) - (before[id] ?? 0));
    try { a.restHands?.(); } catch { /* */ }
    return done(res.got >= res.put ? '' : 'not all came back off the fire');
  }
}
