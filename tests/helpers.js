import { Cell } from '../behavior_pack/scripts/core/pathfinder.js';

/**
 * Tiny test world: a heightmap (top solid y per column, default 64 -> stand at y=64)
 * plus optional extra solid blocks and danger blocks.
 */
export function makeWorld({ ground = () => 64, solids = [], danger = [], water = [] } = {}) {
  const S = new Set(solids.map(([x, y, z]) => `${x},${y},${z}`));
  const D = new Set(danger.map(([x, y, z]) => `${x},${y},${z}`));
  const W = new Set(water.map(([x, y, z]) => `${x},${y},${z}`));
  const classify = (x, y, z) => {
    const k = `${x},${y},${z}`;
    if (D.has(k)) return Cell.DANGER;
    if (W.has(k)) return Cell.LIQUID;
    if (S.has(k)) return Cell.SOLID;
    return y < ground(x, z) ? Cell.SOLID : Cell.AIR;
  };
  // Height the bot stands at in column (x,z) given current feet y (lands on highest solid <= y+1).
  const floorAt = (x, z, fromY) => {
    for (let y = Math.floor(fromY) + 1; y > fromY - 20; y--) {
      if (classify(x, y - 1, z) === Cell.SOLID && classify(x, y, z) === Cell.AIR && classify(x, y + 1, z) === Cell.AIR) return y;
    }
    return -Infinity;
  };
  const blocked = (x, y, z) => classify(x, y, z) !== Cell.AIR || classify(x, y + 1, z) !== Cell.AIR;
  return { classify, floorAt, blocked };
}

/**
 * Kinematic player body for exercising the motor controller, with Minecraft's jump physics
 * (jump velocity 0.42, gravity 0.08, drag 0.98 per tick; ~1.25 blocks high, ~12 ticks in the air)
 * and a collision box: hw = half-width (0 = a point; a real player is 0.3), 1.8 tall.
 * Collisions resolve one axis at a time, so the body slides along walls like in the game, and a
 * box corner poking into a taller block stops it, which is what makes step-ups next to walls hard.
 */
export class SimBody {
  constructor(world, pos, yaw = 0, { hw = 0 } = {}) {
    this.w = world;
    this.pos = { ...pos };
    this.yaw = yaw;
    this.pitch = 0;
    this.cmd = null;
    this.sprint = false;
    this.vy = 0;
    this.onGround = true;
    this.jumps = 0;
    this.hw = hw;
    this.looks = [];
    this.moves = [];
  }
  getPos() { return { ...this.pos }; }
  getRotation() { return { yaw: this.yaw, pitch: this.pitch }; }
  isOnGround() { return this.onGround; }
  isInWater() { return false; }
  look(yaw, pitch) { this.yaw = yaw; this.pitch = pitch; this.looks.push({ yaw, pitch }); }
  move(dx, dz, s) { this.cmd = { dx, dz, s }; }
  stop() { this.cmd = null; }
  jump() { if (this.onGround) { this.vy = 0.42; this.onGround = false; this.jumps++; } }
  setSprinting(v) { this.sprint = v; }
  solid(x, y, z) {
    const c = this.w.classify(x, y, z);
    return c !== 0 && c !== 2 && c !== 5; // not air, water or ladder
  }
  /** The box with its feet at (x, y, z) overlaps no solid block. */
  fits(x, y, z) {
    const h = Math.max(this.hw, 1e-3), e = 1e-4;
    for (let bx = Math.floor(x - h + e); bx <= Math.floor(x + h - e); bx++)
      for (let bz = Math.floor(z - h + e); bz <= Math.floor(z + h - e); bz++)
        for (let by = Math.floor(y + e); by <= Math.floor(y + 1.8 - e); by++)
          if (this.solid(bx, by, bz)) return false;
    return true;
  }
  step() {
    const p = this.pos;
    if (this.cmd) {
      const sp = (this.sprint ? 0.28 : 0.216) * this.cmd.s;
      const nx = p.x + this.cmd.dx * sp, nz = p.z + this.cmd.dz * sp;
      // Walking into a knee-high lip auto-steps nothing (that's what jumping is for); slide per axis.
      if (this.fits(nx, p.y, p.z)) p.x = nx;
      if (this.fits(p.x, p.y, nz)) p.z = nz;
      this.moves.push({ ...this.cmd });
    }
    // Vertical: gravity, land on the first solid block below any part of the box.
    if (this.onGround && this.vy <= 0 && !this.fits(p.x, p.y - 0.01, p.z)) { this.vy = 0; return; }
    const vy = this.vy;
    this.vy = (this.vy - 0.08) * 0.98; // Minecraft: move by the velocity, then apply gravity
    const ny = p.y + vy;
    if (vy <= 0 && !this.fits(p.x, ny, p.z)) {
      p.y = Math.floor(ny) + 1; // land on top of the block
      if (!this.fits(p.x, p.y, p.z)) p.y = Math.ceil(ny);
      this.vy = 0;
      this.onGround = true;
    } else if (vy > 0 && !this.fits(p.x, ny, p.z)) {
      this.vy = 0; // bumped the head
    } else {
      p.y = ny;
      this.onGround = false;
    }
  }
}

export async function runMotor(motor, body, promise, maxTicks = 2000) {
  let result = null;
  promise.then((r) => { result = r; });
  let ticks = 0;
  for (; ticks < maxTicks && !result; ticks++) {
    motor.tick();
    body.step();
    await Promise.resolve(); // let the promise callback run
  }
  return { result, ticks };
}
