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
  /**
   * The block's collision boxes, [x0, y0, z0, x1, y1, z1] relative to its corner: a full cube, a
   * bottom slab (SLAB, 7), or stairs (STEP, 6): a slab plus the back half on top, the back being the
   * way the world's stairFacing(x, y, z) says the stairs go up ({x, z}; +x if it doesn't say).
   */
  shapes(x, y, z) {
    const c = this.w.classify(x, y, z);
    if (c === 7) return [[0, 0, 0, 1, 0.5, 1]];
    if (c === 6) {
      const f = this.w.stairFacing?.(x, y, z) ?? { x: 1, z: 0 };
      const back = f.x > 0 ? [0.5, 0.5, 0, 1, 1, 1] : f.x < 0 ? [0, 0.5, 0, 0.5, 1, 1] : f.z > 0 ? [0, 0.5, 0.5, 1, 1, 1] : [0, 0.5, 0, 1, 1, 0.5];
      return [[0, 0, 0, 1, 0.5, 1], back];
    }
    return this.solid(x, y, z) ? [[0, 0, 0, 1, 1, 1]] : [];
  }
  /** The box with its feet at (x, y, z) overlaps no solid block. */
  fits(x, y, z) {
    const h = Math.max(this.hw, 1e-3), e = 1e-4;
    const x0 = x - h + e, x1 = x + h - e, z0 = z - h + e, z1 = z + h - e, y0 = y + e, y1 = y + 1.8 - e;
    for (let bx = Math.floor(x0); bx <= Math.floor(x1); bx++)
      for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++)
        for (let by = Math.floor(y0) - 1; by <= Math.floor(y1); by++)
          for (const [a, b, c, d, f, g] of this.shapes(bx, by, bz)) {
            if (x0 < bx + d && x1 > bx + a && y0 < by + f && y1 > by + b && z0 < bz + g && z1 > bz + c) return false;
          }
    return true;
  }
  /** Lowest height at or above y (within `up`) where the box fits: for landing and stepping up. */
  settle(x, y, z, up) {
    for (const c of [y, Math.floor(y) + 0.5, Math.floor(y) + 1, Math.floor(y) + 1.5].filter((v) => v >= y - 1e-9 && v - y <= up + 1e-9).sort((a, b) => a - b)) {
      if (this.fits(x, c, z)) return c;
    }
    return null;
  }
  step() {
    const p = this.pos;
    if (this.cmd) {
      const sp = (this.sprint ? 0.28 : 0.216) * this.cmd.s;
      const nx = p.x + this.cmd.dx * sp, nz = p.z + this.cmd.dz * sp;
      // Slide per axis. On the ground, a lip up to 0.5625 high (a slab, a stair) is stepped up onto,
      // as the game does; a full block needs a jump.
      const stepTo = (tx, tz) => {
        if (this.fits(tx, p.y, tz)) return p.y;
        return this.onGround ? this.settle(tx, p.y, tz, 0.5625) : null;
      };
      let ny0 = stepTo(nx, p.z);
      if (ny0 != null) { p.x = nx; p.y = ny0; }
      ny0 = stepTo(p.x, nz);
      if (ny0 != null) { p.z = nz; p.y = ny0; }
      this.moves.push({ ...this.cmd });
    }
    // Vertical: gravity, land on the first solid block below any part of the box.
    if (this.onGround && this.vy <= 0 && !this.fits(p.x, p.y - 0.01, p.z)) { this.vy = 0; return; }
    const vy = this.vy;
    this.vy = (this.vy - 0.08) * 0.98; // Minecraft: move by the velocity, then apply gravity
    const ny = p.y + vy;
    if (vy <= 0 && !this.fits(p.x, ny, p.z)) {
      p.y = this.settle(p.x, ny, p.z, 1.5) ?? Math.floor(ny) + 1; // land on top of the block (or half block)
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

/**
 * A player body with Minecraft's movement physics (the numbers Bedrock's player uses too), for
 * parkour: velocity carried tick to tick. On the ground each tick keeps 0.546 of it (block
 * friction 0.6 x 0.91) and adds 0.098 walking / 0.1274 sprinting in the input direction (so 4.3
 * and 5.6 blocks a second flat out); in the air it keeps 0.91 and adds only 0.0196 / 0.0255, so a
 * jump carries the speed it took off with. Jump: 0.42 up, and a sprint-jump adds 0.2 along the
 * facing. Gravity: (vy - 0.08) x 0.98. Steps up 0.6 on the ground. Box 0.6 x 1.8.
 */
export class McBody extends SimBody {
  constructor(world, pos, yaw = 0, opts = {}) {
    super(world, pos, yaw, { hw: 0.3, ...opts });
    this.vx = 0; this.vz = 0;
    this.airTicks = 0;
  }
  jump() {
    if (!this.onGround || this.vy > 0) return;
    // (Still on the ground for this tick's friction and push, as in the game: off it once it moves.)
    this.vy = 0.42; this.jumps++;
    if (this.sprint) { const r = this.yaw * Math.PI / 180; this.vx += -Math.sin(r) * 0.2; this.vz += Math.cos(r) * 0.2; }
  }
  speed2D() { return Math.hypot(this.vx, this.vz); }
  step() {
    const p = this.pos;
    const ground = this.onGround;
    const f = ground ? 0.546 : 0.91;
    if (this.cmd && this.cmd.s > 0) {
      const l = Math.hypot(this.cmd.dx, this.cmd.dz) || 1;
      const a = (ground ? (this.sprint ? 0.13 : 0.1) : (this.sprint ? 0.026 : 0.02)) * 0.98 * Math.min(1, this.cmd.s);
      this.vx += this.cmd.dx / l * a; this.vz += this.cmd.dz / l * a;
      this.moves.push({ ...this.cmd });
    }
    // Y first, then X, then Z (the game's order), each stopped by what it runs into.
    let vy = this.vy;
    const ny = p.y + vy;
    if (vy <= 0 && !this.fits(p.x, ny, p.z)) {
      p.y = this.settle(p.x, ny, p.z, 1.5) ?? Math.floor(ny) + 1;
      this.onGround = true; vy = 0;
    } else if (vy > 0 && !this.fits(p.x, ny, p.z)) { vy = 0; this.onGround = false; }
    else { p.y = ny; this.onGround = !this.fits(p.x, p.y - 0.01, p.z) && vy <= 0 ? true : false; }
    const slide = (tx, tz) => {
      if (this.fits(tx, p.y, tz)) return p.y;
      return this.onGround ? this.settle(tx, p.y, tz, 0.6) : null;
    };
    let y1 = slide(p.x + this.vx, p.z);
    if (y1 != null) { p.x += this.vx; p.y = y1; } else this.vx = 0;
    y1 = slide(p.x, p.z + this.vz);
    if (y1 != null) { p.z += this.vz; p.y = y1; } else this.vz = 0;
    if (this.onGround && this.fits(p.x, p.y - 0.01, p.z)) this.onGround = false; // walked off an edge
    this.vy = this.onGround ? 0 : (vy - 0.08) * 0.98;
    this.vx *= f; this.vz *= f;
    this.airTicks = this.onGround ? 0 : this.airTicks + 1;
  }
}
