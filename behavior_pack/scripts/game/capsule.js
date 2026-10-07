// (u250) The repro capsule, game side: a ring of what the bot and the boat it watches were doing (every 5 ticks), the trace lines, and on a
// trigger (a tow standing still, a bridge that would not go, a test stopped or failed) a slice of the world around the bot and the
// entities near it, sent to the brain (type 'capsule') and shown in the full report. core/capsule.js holds the format.
import { system } from '@minecraft/server';
import { CONFIG } from '../config.js';
import { Ring, encodeSlice, makeCapsule, capsuleLines, pt, r1 } from '../core/capsule.js';
import { onTrace, sendEvent } from './bridge.js';
import { container } from './inventory.js';

const MAX_PER_SESSION = 8, MIN_GAP_TICKS = 300;

export class Capsules {
  constructor(agent) {
    this.a = agent;
    this.ring = new Ring(400);
    /** @type {{tick:number,msg:string}[]} */ this.traces = [];
    this.count = 0; this.lastTick = -1e9; this.last = null;
    /** What the tow is watching right now (set by game/leadtow.js each tick it runs): the boat, the goal, the waypoint. */
    this.watch = null;
    onTrace((tick, msg) => { this.traces.push({ tick, msg: String(msg) }); if (this.traces.length > 120) this.traces.splice(0, this.traces.length - 120); });
  }

  /** Every 5 ticks, from the agent's tick. Cheap: a few reads. */
  sample(t) {
    const sim = this.a.sim;
    let p, held = null;
    try { p = sim.location; } catch { return; }
    try { held = container(sim)?.getItem(sim.selectedSlotIndex)?.typeId?.replace('minecraft:', '') ?? null; } catch { /* */ }
    const w = this.watch && t - this.watch.tick < 40 ? this.watch : null;
    let boat = null;
    try { if (w?.boat?.isValid) boat = pt(w.boat.location); } catch { /* */ }
    this.ring.push({ tick: t, p: pt(p), held, ...(boat ? { boat } : {}), ...(w?.note ? { note: w.note } : {}) });
  }

  /** The world and everything near, as a capsule, sent to the brain. Rate limited; returns it (or null). */
  snap(why, { force = false } = {}) {
    const t = system.currentTick;
    if (!force && (this.count >= MAX_PER_SESSION || t - this.lastTick < MIN_GAP_TICKS)) return null;
    try {
      const a = this.a, p = a.sim.location, dim = a.dim;
      const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
      const box = { x1: fx - 10, y1: Math.max(-64, fy - 8), z1: fz - 10, x2: fx + 10, y2: Math.min(319, fy + 6), z2: fz + 10 };
      const slice = encodeSlice(box, (x, y, z) => { try { const b = dim.getBlock({ x, y, z }); return b ? b.typeId.replace('minecraft:', '') : null; } catch { return null; } });
      const entities = [];
      try {
        for (const e of dim.getEntities({ location: p, maxDistance: 24 })) {
          if (e.id === a.sim.id) continue;
          let leashed = false, v = null;
          try { leashed = !!e.getComponent('minecraft:leashable')?.leashHolder; } catch { /* */ }
          try { const vel = e.getVelocity(); v = r1(Math.hypot(vel.x, vel.y, vel.z)); } catch { /* */ }
          entities.push({ type: e.typeId.replace('minecraft:', ''), p: pt(e.location), ...(leashed ? { leashed } : {}), ...(v ? { v } : {}) });
          if (entities.length >= 40) break;
        }
      } catch { /* */ }
      const inv = {};
      try { const c = container(a.sim); for (let i = 0; i < c.size; i++) { const it = c.getItem(i); if (it) inv[it.typeId.replace('minecraft:', '')] = (inv[it.typeId.replace('minecraft:', '')] ?? 0) + it.amount; } } catch { /* */ }
      let w = null;
      try { if (this.watch && t - this.watch.tick < 40) { const { boat, tick, ...rest } = this.watch; w = { ...rest, boat: boat?.isValid ? pt(boat.location) : null }; } } catch { /* */ }
      const cap = makeCapsule({
        why, build: CONFIG.build, tick: t, at: p,
        bot: { hp: a.health?.(), task: a.task?.kind ?? 'idle', step: a.autoStep, mode: a.mode, yaw: r1(a.sim.getRotation().y), vel: (() => { try { const v = a.sim.getVelocity(); return [r1(v.x), r1(v.y), r1(v.z)]; } catch { return null; } })(), inv },
        ring: this.ring, traces: this.traces, slice, entities, watch: w,
      });
      this.count++; this.lastTick = t; this.last = cap;
      sendEvent({ type: 'capsule', capsule: cap, lines: capsuleLines(cap, { json: false }) }).catch(() => {});
      return cap;
    } catch (e) { try { console.warn(`[capsule] ${e}`); } catch { /* */ } return null; }
  }
}
