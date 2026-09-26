// Pure math helpers. No Minecraft imports, so everything here is unit-testable in Node.
//
// Minecraft rotation conventions:
//   yaw   0 = facing +Z (south), 90 = -X (west), -90 = +X (east), ±180 = -Z (north)
//   pitch positive = looking down, negative = looking up

export const DEG = Math.PI / 180;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDeg(a) {
  a = (((a + 180) % 360) + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}

/** Shortest signed difference target - current, in degrees. */
export function angleDiff(target, current) {
  return wrapDeg(target - current);
}

export function yawTo(from, to) {
  return Math.atan2(-(to.x - from.x), to.z - from.z) / DEG;
}

export function pitchTo(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z, dy = to.y - from.y;
  return -Math.atan2(dy, Math.hypot(dx, dz)) / DEG;
}

/** Unit XZ direction for a yaw. */
export function dirFromYaw(yaw) {
  return { x: -Math.sin(yaw * DEG), z: Math.cos(yaw * DEG) };
}

/** Unit 3D view vector for yaw/pitch. */
export function viewVector(yaw, pitch) {
  const cp = Math.cos(pitch * DEG);
  return { x: -Math.sin(yaw * DEG) * cp, y: -Math.sin(pitch * DEG), z: Math.cos(yaw * DEG) * cp };
}

export function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function dist3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * One step of a damped spring on an angle (degrees).
 * zeta = 1 is critically damped (no overshoot); < 1 overshoots slightly, like a mouse flick.
 * Returns [newAngle, newVelocity]. Velocity is capped at maxVel deg/s.
 */
export function springAngle(x, v, target, omega, zeta, dt, maxVel, wrap = true) {
  const err = wrap ? angleDiff(target, x) : target - x;
  const a = omega * omega * err - 2 * zeta * omega * v;
  v = clamp(v + a * dt, -maxVel, maxVel);
  x = x + v * dt;
  return [wrap ? wrapDeg(x) : x, v];
}

/** Seedable PRNG (mulberry32) so behaviour is reproducible in tests. */
export function makeRng(seed = (Math.random() * 2 ** 32) >>> 0) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.int = (lo, hi) => Math.floor(lo + next() * (hi - lo + 1));
  return next;
}

/** Smooth, low-frequency noise in [-1, 1] from a few summed sines with random phases. */
export class SmoothNoise {
  constructor(rng, baseFreq = 0.3) {
    this.parts = [1, 2.3, 4.7].map((m, i) => ({
      f: baseFreq * m * rng.range(0.8, 1.2),
      p: rng.range(0, Math.PI * 2),
      w: 1 / (i + 1),
    }));
    this.norm = this.parts.reduce((s, p) => s + p.w, 0);
  }
  at(t) {
    let s = 0;
    for (const p of this.parts) s += p.w * Math.sin(p.f * t * Math.PI * 2 + p.p);
    return s / this.norm;
  }
}
