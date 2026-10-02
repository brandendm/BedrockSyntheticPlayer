// Records whoever is doing a test (the bot, or a player who said `!bot test <name> me`): a sample every 5 ticks and the blocks
// they place and break, summarised by core/testrun.js, kept in the world (testRuns) and sent to the brain (`test_run`).
import { system, world } from '@minecraft/server';
import { summarise } from '../core/testrun.js';

export class TestRecorder {
  /** @param {import('@minecraft/server').Player} subject */
  constructor(subject) {
    this.subject = subject; this.samples = []; this.counts = { placed: 0, broken: 0 };
    this.run = null; this.subs = [];
  }

  sample() {
    try {
      const s = this.subject, l = s.location;
      let hp = null; try { hp = s.getComponent('minecraft:health')?.currentValue ?? null; } catch { /* */ }
      this.samples.push({ t: system.currentTick, x: l.x, y: l.y, z: l.z, g: s.isOnGround ? 1 : 0, sn: s.isSneaking ? 1 : 0, sp: s.isSprinting ? 1 : 0, hp });
    } catch { /* the subject is gone (died) */ }
  }

  start() {
    this.sample();
    this.run = system.runInterval(() => this.sample(), 5);
    try {
      const id = this.subject.id;
      const p = world.afterEvents.playerPlaceBlock.subscribe((ev) => { if (ev.player.id === id) this.counts.placed++; });
      const b = world.afterEvents.playerBreakBlock.subscribe((ev) => { if (ev.player.id === id) this.counts.broken++; });
      this.subs = [() => world.afterEvents.playerPlaceBlock.unsubscribe(p), () => world.afterEvents.playerBreakBlock.unsubscribe(b)];
    } catch { /* events not available: the counts stay 0 */ }
    return this;
  }

  stop() {
    if (this.run !== null) { try { system.clearRun(this.run); } catch { /* */ } this.run = null; }
    this.sample();
    for (const u of this.subs) { try { u(); } catch { /* */ } }
    this.subs = [];
    return summarise(this.samples, this.counts);
  }
}
