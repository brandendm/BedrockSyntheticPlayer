// Records whoever is doing a test (the bot, or a player who said `!bot test <name> me`) in detail, so the two can be studied side by side:
//   - a sample every 2 ticks: position, view (yaw, pitch), on the ground, sneaking, sprinting, in water, climbing, hotbar slot, what is held, health
//   - every event of theirs: block placed / broken (with the block, where and what was held), hits and damage dealt, damage taken (and from what),
//     kills, items used (a bow drawn and released, food eaten), blocks and entities used
//   - what the pack gained and lost
// Summarised by core/testrun.js (technique included), kept in the world (testRuns) and sent to the brain (`test_run`, with the trace).
import { system, world } from '@minecraft/server';
import { summarise, downsample } from '../core/testrun.js';
import { invCounts } from './inventory.js';

const strip = (id) => String(id ?? '').replace(/^minecraft:/, '');
const MAX_EVENTS = 800;

export class TestRecorder {
  /** @param {import('@minecraft/server').Player} subject */
  constructor(subject) {
    this.subject = subject; this.samples = []; this.counts = { placed: 0, broken: 0 }; this.events = [];
    this.run = null; this.subs = []; this.inv0 = {};
  }

  held() {
    try {
      const s = this.subject, c = s.getComponent('minecraft:inventory')?.container;
      return { slot: s.selectedSlotIndex, id: strip(c?.getItem(s.selectedSlotIndex)?.typeId) };
    } catch { return { slot: 0, id: '' }; }
  }

  sample() {
    try {
      const s = this.subject, l = s.location;
      let hp = null; try { hp = s.getComponent('minecraft:health')?.currentValue ?? null; } catch { /* */ }
      let yw = 0, pt = 0; try { const r = s.getRotation(); yw = r.y; pt = r.x; } catch { /* */ }
      const h = this.held();
      this.samples.push({
        t: system.currentTick, x: l.x, y: l.y, z: l.z, g: s.isOnGround ? 1 : 0, sn: s.isSneaking ? 1 : 0, sp: s.isSprinting ? 1 : 0, hp,
        yw, pt, w: s.isInWater ? 1 : 0, cl: /** @type {any} */ (s).isClimbing ? 1 : 0, sl: h.slot, hd: h.id,
      });
    } catch { /* the subject is gone (died) */ }
  }

  /** One event, with the seconds since the start. */
  ev(kind, ...data) {
    if (this.events.length >= MAX_EVENTS) return;
    this.events.push([Math.round(((system.currentTick - (this.samples[0]?.t ?? system.currentTick)) / 20) * 10) / 10, kind, ...data]);
  }

  /** The path (downsampled), every event, and the block events apart (what the dashboard draws). */
  trace() {
    const blocks = this.events.filter((e) => e[1] === 'p' || e[1] === 'b').map((e) => [e[0], e[1], e[3], e[4], e[5]]);
    return { path: downsample(this.samples, 400), blocks, events: this.events };
  }

  /** Start the record again from now (the reading time before a turn is not part of it). */
  reset() { this.samples = []; this.events = []; this.counts = { placed: 0, broken: 0 }; this.inv0 = this.pack(); this.sample(); }

  /** The summary so far, the recording going on (one leg of a longer test). */
  snapshot() { this.sample(); return summarise(this.samples, { ...this.counts, inv: { gained: {}, spent: {} } }, this.events); }

  pack() { try { return invCounts(/** @type {any} */ (this.subject)); } catch { return {}; } }

  start() {
    this.inv0 = this.pack();
    this.sample();
    this.run = system.runInterval(() => this.sample(), 2);
    const id = this.subject.id;
    const mine = (e) => { try { return e?.id === id; } catch { return false; } };
    const wa = /** @type {any} */ (world.afterEvents);
    const on = (name, fn) => { try { const h = wa[name].subscribe(fn); this.subs.push(() => wa[name].unsubscribe(h)); } catch { /* this event is not in this version */ } };
    const at = (b) => [Math.round(b.location.x), Math.round(b.location.y), Math.round(b.location.z)];
    on('playerPlaceBlock', (e) => { if (mine(e.player)) { this.counts.placed++; this.ev('p', strip(e.block.typeId), ...at(e.block), this.held().id); } });
    on('playerBreakBlock', (e) => { if (mine(e.player)) { this.counts.broken++; this.ev('b', strip(e.brokenBlockPermutation?.type?.id), ...at(e.block), this.held().id); } });
    on('entityHitEntity', (e) => { if (mine(e.damagingEntity)) this.ev('h', strip(e.hitEntity?.typeId)); });
    on('entityHurt', (e) => {
      try {
        const by = e.damageSource?.damagingEntity;
        if (mine(by)) this.ev('d', strip(e.hurtEntity?.typeId), Math.round(e.damage * 10) / 10);
        if (mine(e.hurtEntity)) this.ev('D', String(e.damageSource?.cause ?? ''), Math.round(e.damage * 10) / 10, strip(by?.typeId));
      } catch { /* */ }
    });
    on('entityDie', (e) => { try { if (mine(e.damageSource?.damagingEntity)) this.ev('k', strip(e.deadEntity?.typeId)); } catch { /* */ } });
    on('itemUse', (e) => { if (mine(e.source)) this.ev('u', strip(e.itemStack?.typeId)); });
    on('itemStartUse', (e) => { if (mine(e.source)) this.ev('U', strip(e.itemStack?.typeId)); });
    on('itemReleaseUse', (e) => { if (mine(e.source)) this.ev('R', strip(e.itemStack?.typeId)); });
    on('itemCompleteUse', (e) => { if (mine(e.source)) this.ev('e', strip(e.itemStack?.typeId)); });
    on('playerInteractWithBlock', (e) => { if (mine(e.player)) this.ev('i', strip(e.block?.typeId), strip(e.itemStack?.typeId)); });
    on('playerInteractWithEntity', (e) => { if (mine(e.player)) this.ev('I', strip(e.target?.typeId), strip(e.itemStack?.typeId)); });
    return this;
  }

  stop() {
    if (this.run !== null) { try { system.clearRun(this.run); } catch { /* */ } this.run = null; }
    this.sample();
    for (const u of this.subs) { try { u(); } catch { /* */ } }
    this.subs = [];
    // What the pack gained and lost over the run.
    const end = this.pack(), gained = {}, spent = {};
    for (const k of new Set([...Object.keys(this.inv0), ...Object.keys(end)])) {
      const d = (end[k] ?? 0) - (this.inv0[k] ?? 0);
      if (d > 0) gained[k] = d; else if (d < 0) spent[k] = -d;
    }
    return summarise(this.samples, { ...this.counts, inv: { gained, spent } }, this.events);
  }
}
