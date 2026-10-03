// Adapter between the motor controller and a SimulatedPlayer.
// All Script API calls for the body live here, so API changes between Bedrock
// versions get fixed in one file.
import { system } from '@minecraft/server';
import { LookDuration } from '@minecraft/server-gametest';
import { viewVector } from '../core/mathutil.js';
import { isWatery, CLIMBABLE } from './world.js';

export class SimBodyAdapter {
  constructor(sim) {
    this.sim = sim;
    // Axis sign for sim.move(). The docs say +westEast = east and +northSouth = south,
    // but "relative to the GameTest" is ambiguous for players spawned outside a test.
    // We watch commanded vs actual motion and flip if they disagree.
    this.axisSign = 1;
    this._probe = { votes: 0, agree: 0, locked: false, last: null, cmd: null, hurtAt: -1000, hp: null };
  }

  getPos() {
    const l = this.sim.location;
    return { x: l.x, y: l.y, z: l.z };
  }

  getRotation() {
    const r = this.sim.getRotation();
    return { yaw: r.y, pitch: r.x };
  }

  isOnGround() {
    return this.sim.isOnGround;
  }

  /**
   * On a ladder or vine: the yaw that pushes into the wall it hangs on (holding forward into it
   * is how you climb). null when not on one.
   */
  climbYaw() {
    const p = this.sim.location, dim = this.sim.dimension;
    const f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    let b;
    try { b = dim.getBlock(f); } catch { return null; }
    if (!b || !CLIMBABLE.test(b.typeId)) return null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let n;
      try { n = dim.getBlock({ x: f.x + dx, y: f.y, z: f.z + dz }); } catch { continue; }
      if (n && !n.isAir && !n.isLiquid && !CLIMBABLE.test(n.typeId)) return Math.atan2(-dx, dz) * 180 / Math.PI;
    }
    return null;
  }

  /** In a ladder or vine cell (whether or not a wall is beside it to push into: a vine hanging free is climbed by jumping). */
  onClimbable() {
    try { const b = this.sim.dimension.getBlock({ x: Math.floor(this.sim.location.x), y: Math.floor(this.sim.location.y), z: Math.floor(this.sim.location.z) }); return !!b && CLIMBABLE.test(b.typeId); } catch { return false; }
  }

  isInWater() {
    return this.sim.isInWater;
  }

  look(yaw, pitch) {
    const eye = this.sim.getHeadLocation();
    const v = viewVector(yaw, pitch);
    const target = { x: eye.x + v.x * 8, y: eye.y + v.y * 8, z: eye.z + v.z * 8 };
    try {
      this.sim.lookAtLocation(target, LookDuration.Instant);
    } catch {
      this.sim.setRotation({ x: pitch, y: yaw });
    }
  }

  move(dirX, dirZ, speed) {
    this.lastDir = { x: dirX * speed, z: dirZ * speed };
    this._checkAxes(dirX, dirZ);
    this.sim.move(dirX * this.axisSign, dirZ * this.axisSign, Math.max(0, Math.min(1, speed)));
  }

  stop() {
    this.sim.stopMoving();
    this._probe.cmd = null;
  }

  // Simulated players can't "hold space" in water: sim.jump() does nothing once afloat, and they
  // sink. Measured on BDS 1.26.51: a small upward knockback every 3 ticks while the head is under
  // water rises ~2 blocks/s and settles with the head just above the surface, like holding jump.
  /** Breath left, 0..1 (1 when not under water). */
  airRatio() {
    try {
      const br = this.sim.getComponent('minecraft:breathable');
      if (br && br.totalSupply > 0) return Math.max(0, br.airSupply) / br.totalSupply;
    } catch {}
    return 1;
  }

  headUnderwater() {
    // Losing air is the ground truth (works in kelp, under overhangs, anything); the head-block
    // check reacts a moment sooner in open water.
    try {
      const br = this.sim.getComponent('minecraft:breathable');
      if (br && br.airSupply < br.totalSupply) return true;
    } catch {}
    try {
      const h = this.sim.getHeadLocation();
      return isWatery(this.sim.dimension.getBlock({ x: Math.floor(h.x), y: Math.floor(h.y), z: Math.floor(h.z) }));
    } catch {
      return false;
    }
  }

  swimUp() {
    this.swimTick = (this.swimTick ?? 0) + 1;
    if (this.swimTick % 3 || !this.headUnderwater()) return;
    const d = this.lastDir ?? { x: 0, z: 0 };
    try { this.sim.applyKnockback({ x: d.x * 0.15, z: d.z * 0.15 }, 0.12); } catch {}
  }

  /** The other way: push down through water (a sim can't hold shift any more than it can hold space). */
  swimDown() {
    this.sinkTick = (this.sinkTick ?? 0) + 1;
    if (this.sinkTick % 2) return;
    try { this.sim.applyKnockback({ x: 0, z: 0 }, -0.25); } catch {}
  }

  jump() {
    if (this.sim.isInWater) {
      // Hop out onto a bank: forward + up, enough to clear one block from floating.
      const d = this.lastDir ?? { x: 0, z: 0 };
      try { this.sim.applyKnockback({ x: d.x * 0.3, z: d.z * 0.3 }, 0.42); } catch {}
      return;
    }
    try {
      this.sim.jump();
    } catch { /* mid-air */ }
  }

  setSprinting(v) {
    try {
      this.sim.isSprinting = v;
    } catch { /* not supported on this version */ }
  }

  /**
   * Is sim.move() mirrored on this version? Compare where we told it to go with where it went.
   * Only clean samples count: on the ground, out of water, not just hit (knockback shoves us
   * backwards), and a normal walking step (a teleport or a launch is a jump of blocks). One-way:
   * once 40 clean steps agree the sign is settled for good. Knockback in a fight or a current in
   * the sea used to "prove" the axes were inverted and flip them, and from then on the bot walked
   * one way while facing the other.
   */
  _checkAxes(dx, dz) {
    const p = this._probe;
    const pos = this.getPos();
    const tick = system.currentTick;
    let hp = null;
    try { hp = this.sim.getComponent('minecraft:health')?.currentValue ?? null; } catch {}
    if (hp !== null && p.hp !== null && hp < p.hp) p.hurtAt = tick;
    p.hp = hp;
    let clean = false;
    try { clean = this.sim.isOnGround && !this.sim.isInWater && tick - p.hurtAt > 30; } catch {}
    if (!p.locked && clean && p.cmd && p.last) {
      const mx = pos.x - p.last.x, mz = pos.z - p.last.z;
      const moved = Math.hypot(mx, mz);
      if (moved > 0.05 && moved < 0.45) {
        const dot = (mx * p.cmd.x + mz * p.cmd.z) / moved;
        if (dot < -0.7) p.votes++;
        else if (dot > 0.5) { p.votes = 0; if (++p.agree >= 40) p.locked = true; }
        if (p.votes >= 12) {
          this.axisSign *= -1;
          p.votes = 0;
          p.agree = 0;
          console.warn('[agent] sim.move axes look inverted on this version; flipped.');
        }
      }
    }
    p.last = pos;
    p.cmd = { x: dx * this.axisSign, z: dz * this.axisSign };
  }

  /** After a teleport: the last position means nothing any more. */
  resetProbe() {
    this._probe.last = null;
    this._probe.cmd = null;
    this._probe.votes = 0;
  }
}
