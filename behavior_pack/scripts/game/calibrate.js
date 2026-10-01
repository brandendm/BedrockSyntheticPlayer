// Measures, in the running game, the numbers core/calibrate.js lists, and adopts the ones it can.
//   head       at once at spawn (no movement needed): sets the eye height everything aims with
//   jump       first pass of the auto loop, standing still: apex and ticks in the air (reported only)
//   item use   the first time it holds a few plain blocks: the fewest ticks between two uses that
//              the game accepts, from placing a block in one spot and another beside it a few ticks
//              later (both taken away again, the blocks put back in the pack)
// What it finds goes to the trace and to the world (it survives a restart), and a drift from what
// the code was built on is said in chat once.
import { system, world, ItemStack, Direction } from '@minecraft/server';
import { setEyeHeight, EYE_HEIGHT } from '../core/motor.js';
import { EXPECTED, TUNING, judge } from '../core/calibrate.js';
import { trace } from './bridge.js';
import { CONFIG } from '../config.js';
import { Aborted } from './skills.js';

const KEY = 'agent:calib';
const PLAIN = /^minecraft:(cobblestone|dirt|stone|cobbled_deepslate|[a-z_]+_planks)$/;
const MAX_GAP = 16;

export class Calibration {
  constructor(agent) {
    this.a = agent;
    this.bodyDone = false;
    this.gapDone = false;
    this.gapTries = 0;
    this.nextGapTry = 0;
    this.measured = {};
    this.said = false;
    try {
      const raw = world.getDynamicProperty(KEY);
      const d = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (d?.adopt?.useGap) TUNING.useGap = d.adopt.useGap; // (last time's, until this run measures it)
    } catch {}
    this.measureHead();
  }

  /** Head height above the feet, standing: right away, it needs no movement. */
  measureHead() {
    const sim = this.a.sim;
    try {
      if (sim.isSneaking) return;
      const h = sim.getHeadLocation().y - sim.location.y;
      this.measured.head = Math.round(h * 1000) / 1000;
      this.apply();
    } catch (e) { trace(`calibration: head: ${e}`); }
  }

  /** Judge what's measured so far, adopt what can be, say what differs (once) and keep it. */
  apply() {
    const j = judge(this.measured);
    if (j.adopt.eyeHeight !== undefined && j.adopt.eyeHeight !== EYE_HEIGHT) setEyeHeight(j.adopt.eyeHeight);
    if (j.adopt.useGap !== undefined) TUNING.useGap = j.adopt.useGap;
    for (const n of j.notes) trace(`calibration: ${n}`);
    if (j.notes.length && !this.said) { this.said = true; this.a.say(`Calibration: ${j.notes[0]}`); }
    try { world.setDynamicProperty(KEY, JSON.stringify({ build: CONFIG.build, t: Date.now(), m: this.measured, adopt: j.adopt })); } catch {}
    return j;
  }

  summary() {
    const m = this.measured;
    const bits = [];
    if (m.head !== undefined) bits.push(`head ${m.head}`);
    if (m.apex !== undefined) bits.push(`jump ${m.apex} up, ${m.airTicks} ticks`);
    if (m.useGap !== undefined) bits.push(`item use every ${m.useGap} ticks (leaving ${TUNING.useGap})`);
    return bits.join(', ') || 'nothing measured yet';
  }

  /** Measure everything now, whatever was done before (the test, the debug command). */
  async runNow() {
    this.bodyDone = false; this.gapDone = false; this.gapTries = 0; this.nextGapTry = 0;
    this.measureHead();
    const gen = this.a.newTask({ kind: 'calibrate' });
    try { await this.step(gen); } finally { this.a.newTask(null); }
    return this.summary();
  }

  /** One pass from the auto loop: whatever isn't measured yet and can be now. Never throws out. */
  async step(gen) {
    if (this.bodyDone && this.gapDone) return;
    try {
      if (!this.bodyDone) { await this.measureJump(gen); this.bodyDone = true; }
      if (!this.gapDone && system.currentTick >= this.nextGapTry && this.a.skills && !this.a.threatsNow?.length) {
        const r = await this.measureUseGap(gen);
        if (r === 'done') this.gapDone = true;
        else if (r === 'later') { this.nextGapTry = system.currentTick + 20 * 60; }
        else if (++this.gapTries >= 3) { this.gapDone = true; trace('calibration: item use: gave up after 3 tries'); }
        else this.nextGapTry = system.currentTick + 20 * 30;
      }
    } catch (e) {
      if (e instanceof Aborted) throw e; // (the task was replaced: not ours to swallow)
      trace(`calibration: ${e}`);
    }
  }

  /** Standing jump: apex and ticks in the air. Needs room over its head and dry land. */
  async measureJump(gen) {
    const sim = this.a.sim, S = this.a.skills;
    const f = S.feet();
    for (let i = 0; i < 40 && !sim.isOnGround; i++) await system.waitTicks(1);
    const free = [1, 2, 3].every((dy) => { const b = S.blockAt({ x: f.x, y: f.y + dy, z: f.z }); return b === 'air'; });
    if (!sim.isOnGround || sim.isInWater || !free || sim.isSneaking) return;
    S.check(gen);
    await system.waitTicks(4);
    const y0 = sim.location.y;
    sim.jump();
    let apex = 0, left = false, ticks = 0;
    for (let t = 1; t <= 40; t++) {
      await system.waitTicks(1);
      const dy = sim.location.y - y0;
      apex = Math.max(apex, dy);
      if (dy > 0.05) left = true;
      if (left && sim.isOnGround && dy < 0.05) { ticks = t; break; }
    }
    if (!ticks) return;
    this.measured.apex = Math.round(apex * 1000) / 1000;
    this.measured.airTicks = ticks;
    this.apply();
    trace(`calibration: ${this.summary()}`);
  }

  /**
   * The fewest ticks between two item uses the game takes: a block onto the ground a few steps
   * off, then, with the head held still, a second one against the first block's face the crosshair
   * is on, `gap` ticks after the first. 'done', 'later' (nothing to place, or nowhere to do it
   * here: ask again in a minute) or 'failed' (the first use didn't take).
   */
  async measureUseGap(gen) {
    const a = this.a, sim = a.sim, S = a.skills, dim = a.dim;
    const inv = sim.getComponent('minecraft:inventory').container;
    let slot = -1;
    for (let i = 0; i < inv.size; i++) { const it = inv.getItem(i); if (it && it.amount >= 4 && PLAIN.test(it.typeId)) { slot = i; break; } }
    if (slot < 0 || !sim.isOnGround) return 'later';
    if (slot >= 9) { try { inv.swapItems(slot, 8, inv); slot = 8; } catch { return 'later'; } } // (the hotbar is slots 0-8: slot 9 threw every loop, 15:20 run)
    const stack = inv.getItem(slot), typeId = stack.typeId, count0 = stack.amount;
    const spot = this.findSpot();
    if (!spot) return 'later';
    const { cell: A, pt } = spot;
    const G = { x: A.x, y: A.y - 1, z: A.z };
    const solid = (c) => { const id = S.blockAt(c); return id !== null && id !== 'air' && !/water|lava|grass|fern|flower/.test(id); };
    const rel = (n) => ({ x: 0.5 + 0.5 * n.x, y: 0.5 + 0.5 * n.y, z: 0.5 + 0.5 * n.z });
    const dir = (n) => (n.y === 1 ? Direction.Up : n.y === -1 ? Direction.Down : n.x === 1 ? Direction.East : n.x === -1 ? Direction.West : n.z === 1 ? Direction.South : Direction.North);
    const use = (block, n) => { try { return sim.useItemInSlotOnBlock(slot, block, dir(n), rel(n)); } catch { return false; } };
    let B = null;
    const clear = () => {
      for (const c of [A, B]) { try { if (c && solid(c)) dim.getBlock(c)?.setType('minecraft:air'); } catch {} }
      try { if ((inv.getItem(slot)?.amount ?? 0) < count0) inv.setItem(slot, new ItemStack(typeId, count0)); } catch {}
      a.cellChanged?.();
    };
    let found = null, aborted = null;
    // One try: a block, then `g` ticks later another against it. True if the second went down.
    const trial = async (g) => {
      S.check(gen);
      B = null;
      for (let k = 0; k < 40 && S.aimError(pt) > 1.5; k++) await system.waitTicks(1);
      await system.waitTicks(12); // (well past any wait left from the last use)
      const okA = use(G, { x: 0, y: 1, z: 0 });
      const t0 = system.currentTick;
      await system.waitTicks(1);
      if (!solid(A)) { aborted = `first use didn't take (returned ${okA})`; return null; }
      while (system.currentTick < t0 + g) await system.waitTicks(1);
      const h = S.crosshair();
      if (!h || h.location.x !== A.x || h.location.y !== A.y || h.location.z !== A.z) { aborted = 'the crosshair was not on the first block'; return null; }
      B = { x: A.x + h.face.x, y: A.y + h.face.y, z: A.z + h.face.z };
      const okB = use(A, h.face);
      const gap = system.currentTick - t0;
      await system.waitTicks(2);
      const took = solid(B);
      clear();
      trace(`calibration: item use ${gap} ticks after the last: returned ${okB}, ${took ? 'placed' : 'refused'}`);
      return took;
    };
    const twice = async (g) => { const r = await trial(g); return r ? await trial(g) : r; };
    try {
      sim.selectedSlotIndex = slot;
      a.motor.setFocus(pt);
      // Where it was last (core/calibrate.js): one tick less should be refused, that many taken.
      // Only if that's not so is the range searched.
      const e = EXPECTED.useGap;
      const below = await trial(e - 1);
      if (below === true) { // sooner than expected: the least that works, upward
        for (let g = 1; g < e - 1 && found === null && !aborted; g++) if (await twice(g)) found = g;
        if (found === null && !aborted) found = e - 1;
      } else if (below === false) {
        if (await twice(e)) found = e;
        else if (!aborted) for (let g = e + 1; g <= MAX_GAP && found === null && !aborted; g++) if (await twice(g)) found = g;
      }
    } finally {
      clear();
      a.motor.setFocus(null);
      a.skills.restHands?.();
    }
    if (aborted) { trace(`calibration: item use: ${aborted}`); return 'failed'; }
    if (found === null) { trace('calibration: item use: none taken up to 10 ticks apart'); return 'failed'; }
    this.measured.useGap = found;
    this.apply();
    trace(`calibration: ${this.summary()}`);
    return 'done';
  }

  /** A cell 2.6-3.5 blocks off at ground level (open above solid ground) whose ground the crosshair can get onto. */
  findSpot() {
    const a = this.a, S = a.skills, sim = a.sim;
    const f = S.feet(), p = sim.location;
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      const x = f.x + dx, z = f.z + dz;
      const d = Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z);
      if (d < 2.6 || d > 3.5) continue;
      const cell = { x, y: f.y, z };
      const below = { x, y: f.y - 1, z };
      const bid = S.blockAt(below), here = S.blockAt(cell), above = S.blockAt({ x, y: f.y + 1, z });
      if (here !== 'air' || above !== 'air' || bid === null || bid === 'air' || /water|lava|leaves|snow|carpet|slab|stairs|fence|door|grass_block_path|farmland/.test(bid)) continue;
      const pp = S.placePoint(cell, below, S.eye());
      if (pp) return { cell, pt: pp.pt };
    }
    return null;
  }
}
