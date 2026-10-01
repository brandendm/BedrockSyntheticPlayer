// Watching you play. `!bot learn on [name]` records one player (you): a sample every second (where,
// health, food, what's in hand, sprinting, sneaking) and, as they happen, what you break and place,
// what hurts you, what you hit and kill, what you eat, when you die. It goes to the brain in batches
// (brain/logs/demos/), which works your habits out of it (brain/learn.py). Nothing is sent anywhere
// else, and nothing is recorded unless you switch it on.
import { system, world } from '@minecraft/server';
import { sendEvent } from './bridge.js';
import { CONFIG } from '../config.js';

const FLUSH_EVERY = 200;   // ticks
const KEEP_ROWS = 3000;    // while the brain isn't reachable

const nm = (id) => String(id ?? '').replace(/^minecraft:/, '');

export class Demo {
  constructor(agent) {
    this.a = agent;
    this.name = null;
    this.session = null;
    this.buf = [];
    this.sent = 0;
    this.t0 = 0;
  }

  get on() { return !!this.name; }
  player() { return this.name ? world.getPlayers().find((p) => p.name === this.name) : null; }

  start(name) {
    this.name = name;
    this.session = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.t0 = system.currentTick;
    this.buf = [];
    this.sent = 0;
    this.row({ k: 'start', build: CONFIG.build });
    this.flush();
  }

  stop() {
    if (!this.name) return;
    this.row({ k: 'stop' });
    this.flush();
    this.name = null;
  }

  status() {
    return this.name ? `recording ${this.name}: ${this.sent + this.buf.length} rows, ${Math.round((system.currentTick - this.t0) / 1200)} min` : 'not recording';
  }

  row(r) {
    this.buf.push({ t: system.currentTick - this.t0, ...r });
    if (this.buf.length > KEEP_ROWS) this.buf.splice(0, this.buf.length - KEEP_ROWS);
  }

  /** Every tick (agent.tick). */
  tick(t) {
    if (!this.name) return;
    const p = this.player();
    if (!p || !p.isValid) { if (t % 100 === 0 && !p) this.stop(); return; }
    if (t % 20 === 0) this.sample(p);
    if (t % FLUSH_EVERY === 0) this.flush();
  }

  sample(p) {
    let hp = null, food = null, held = null;
    try { hp = Math.round((p.getComponent('minecraft:health')?.currentValue ?? 0) * 10) / 10; } catch {}
    try { food = p.getComponent('minecraft:player.hunger')?.currentValue ?? null; } catch {}
    try { held = nm(p.getComponent('minecraft:inventory')?.container?.getItem(p.selectedSlotIndex)?.typeId) || null; } catch {}
    const l = p.location;
    this.row({ k: 's', x: Math.round(l.x * 10) / 10, y: Math.round(l.y * 10) / 10, z: Math.round(l.z * 10) / 10, hp, food, h: held,
      sp: p.isSprinting ? 1 : 0, sn: p.isSneaking ? 1 : 0, g: p.isOnGround ? 1 : 0, d: nm(p.dimension?.id) });
  }

  // --- events (main.js hands them over) ---
  mine(ev) { return this.name && ev.player?.name === this.name; }
  onBreak(ev) {
    if (!this.mine(ev)) return;
    const l = ev.block.location;
    this.row({ k: 'b', id: nm(ev.brokenBlockPermutation?.type?.id), x: l.x, y: l.y, z: l.z, tool: nm(ev.itemStackBeforeBreak?.typeId) || null });
  }
  onPlace(ev) {
    if (!this.mine(ev)) return;
    const l = ev.block.location;
    this.row({ k: 'p', id: nm(ev.block.typeId), x: l.x, y: l.y, z: l.z });
  }
  onEat(ev) {
    if (!this.name || ev.source?.name !== this.name) return;
    this.row({ k: 'eat', item: nm(ev.itemStack?.typeId) });
  }
  onHurt(ev) {
    if (!this.name) return;
    const victim = ev.hurtEntity, by = ev.damageSource?.damagingEntity;
    if (victim?.name === this.name) this.row({ k: 'hurt', cause: ev.damageSource?.cause, amt: Math.round((ev.damage ?? 0) * 10) / 10, by: nm(by?.typeId) || null });
    else if (by?.name === this.name) this.row({ k: 'hit', target: nm(victim?.typeId), amt: Math.round((ev.damage ?? 0) * 10) / 10 });
  }
  onDie(ev) {
    if (!this.name) return;
    if (ev.deadEntity?.name === this.name) this.row({ k: 'die', cause: ev.damageSource?.cause });
    else if (ev.damageSource?.damagingEntity?.name === this.name) this.row({ k: 'kill', mob: nm(ev.deadEntity?.typeId) });
  }

  flush() {
    if (!this.buf.length || !this.name) { if (!this.buf.length) return; }
    const rows = this.buf.splice(0, this.buf.length);
    sendEvent({ type: 'demo', player: this.name ?? 'unknown', session: this.session, rows }).then((res) => {
      if (res === null) this.buf.unshift(...rows); // brain not reachable: keep them for the next try
      else this.sent += rows.length;
    }).catch(() => this.buf.unshift(...rows));
  }
}
