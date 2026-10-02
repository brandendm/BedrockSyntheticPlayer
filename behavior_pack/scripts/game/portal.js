// Nether portals: find a frame (ours, a ruined one, someone else's) and go through it. The way in is pathfinding to the
// floor of the frame's inside, whatever it stands on (up a step, level, over rubble), and standing there, still, until the
// game moves us. (Repairing a ruined frame will use `missing` from core/portal.js findFrames.)
import { system } from '@minecraft/server';
import { findFrames, floorCells, standPoint } from '../core/portal.js';
import { portalWalk } from './world.js';
import { trace } from './bridge.js';

export class Portals {
  constructor(agent) { this.a = agent; }

  /** Frames within r of us, nearest first. */
  find(r = 16, opts = {}) {
    const dim = this.a.dim;
    const get = (x, y, z) => { try { const b = dim.getBlock({ x, y, z }); return b ? b.typeId : null; } catch { return null; } };
    return findFrames(get, this.a.sim.location, r, 8, opts);
  }

  /**
   * Go in: path to the inside's floor (the middle first), stand there until the dimension changes (up to waitS seconds).
   * Returns { ok, dimension, secs, why, tries }.
   */
  async enter(gen, frame, waitS = 20) {
    const a = this.a, S = a.skills, sim = a.sim;
    const startDim = sim.dimension.id, t0 = system.currentTick;
    const res = { ok: false, dimension: startDim, secs: 0, why: '', tries: 0 };
    portalWalk.on = true; a.cellChanged?.();
    try {
      const cells = floorCells(frame);
      const target = standPoint(cells[0]);
      for (res.tries = 1; res.tries <= 4 && sim.dimension.id === startDim; res.tries++) {
        S.check(gen);
        const plan = await a.plan(sim.location, target, 0.35, 4000);
        S.check(gen);
        if (!plan.path || plan.path.length < 1) { res.why = 'no way to the inside of the frame'; continue; }
        await a.motor.followPath(plan.path.map((c) => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 })));
        S.check(gen);
        // Stay: still, in the middle of the cell, until we're moved.
        for (let i = 0; i < waitS * 20 && sim.dimension.id === startDim; i++) {
          const dx = sim.location.x - target.x, dz = sim.location.z - target.z;
          if (Math.hypot(dx, dz) > 0.45) { try { sim.moveToLocation(target, { speed: 0.3 }); } catch { /* */ } } else { try { sim.stopMoving(); } catch { /* */ } }
          await system.waitTicks(1);
          if (i % 20 === 19) S.check(gen);
        }
      }
      res.ok = sim.dimension.id !== startDim;
      res.dimension = sim.dimension.id;
      if (!res.ok && !res.why) res.why = `stood in it ${waitS} s and was not moved (${frame.lit ? 'lit' : 'NOT lit'})`;
    } finally {
      portalWalk.on = false; a.cellChanged?.();
      try { sim.stopMoving(); } catch { /* */ }
    }
    res.secs = Math.round((system.currentTick - t0) / 20);
    trace(`portal: ${res.ok ? `through to ${res.dimension}` : `did not get through (${res.why})`} in ${res.secs} s`);
    return res;
  }
}
