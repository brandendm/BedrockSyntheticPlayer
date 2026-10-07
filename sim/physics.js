// The movement physics, in one place: an upright box (a player, a boat, a mob) moved through the world by a velocity, stopped by what it hits, stepping up what it can.
// Everything numeric comes from params.js (so the calibration moves it, and nothing is hidden in the code).

const EPS = 1e-6;

/** Does a box standing at (x, y, z) (feet centre), half-width hw, height h, overlap any solid block? */
export function fits(world, x, y, z, hw, h) {
  const x0 = Math.floor(x - hw + EPS), x1 = Math.floor(x + hw - EPS), z0 = Math.floor(z - hw + EPS), z1 = Math.floor(z + hw - EPS);
  const y0 = Math.floor(y + EPS), y1 = Math.floor(y + h - EPS);
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) for (let cy = y0 - 0; cy <= y1; cy++) {
    const top = world.height(cx, cy, cz);
    if (top > 0 && y < cy + top - EPS && y + h > cy + EPS) return false;
  }
  return true;
}

/** Is there something solid right under the box (within 0.02)? */
export function supported(world, e, hw) { return !fits(world, e.x, e.y - 0.02, e.z, hw, 0.1) || e.y <= -64; }

/**
 * Move the box e ({ x, y, z }) by (dx, dy, dz): y first, then x, then z, in sub-steps of at most 0.1. Walking into a block no higher than `step` above the feet climbs it
 * (when on the ground). Returns { hitX, hitZ, hitY, onGround, stepped }.
 */
export function move(world, e, dx, dy, dz, { hw, h, step = 0 }) {
  const out = { hitX: false, hitZ: false, hitY: false, onGround: false, stepped: 0 };
  // y
  if (dy !== 0) {
    const n = Math.max(1, Math.ceil(Math.abs(dy) / 0.1)), s = dy / n;
    for (let i = 0; i < n; i++) {
      if (fits(world, e.x, e.y + s, e.z, hw, h)) e.y += s;
      else {
        out.hitY = true;
        if (s < 0) { // land on the surface under us
          const top = world.surface(e.x, e.z, e.y + 0.5);
          let best = -Infinity;
          for (const ox of [-hw + EPS, hw - EPS]) for (const oz of [-hw + EPS, hw - EPS]) best = Math.max(best, world.surface(e.x + ox, e.z + oz, e.y + 0.5));
          e.y = Number.isFinite(best) ? Math.max(best, e.y + s) : e.y;
          void top;
        } else e.y = Math.floor(e.y + h + s + EPS) - h - EPS * 2;
        break;
      }
    }
  }
  const grounded = () => !fits(world, e.x, e.y - 0.03, e.z, hw, h);
  const horizontal = (axis, d) => {
    if (d === 0) return;
    const n = Math.max(1, Math.ceil(Math.abs(d) / 0.1)), s = d / n;
    for (let i = 0; i < n; i++) {
      const nx = e.x + (axis === 'x' ? s : 0), nz = e.z + (axis === 'z' ? s : 0);
      if (fits(world, nx, e.y, nz, hw, h)) { e.x = nx; e.z = nz; continue; }
      // a step: the lowest rise (to `step`) at which it fits, only when we stand on something
      let up = null;
      if (step > 0 && grounded()) for (let r = 0.0625; r <= step + EPS; r += 0.0625) if (fits(world, nx, e.y + r, nz, hw, h)) { up = r; break; }
      if (up !== null) {
        // the highest surface under the new spot, within the rise
        e.x = nx; e.z = nz; e.y += up; out.stepped = Math.max(out.stepped, up);
        continue;
      }
      if (axis === 'x') out.hitX = true; else out.hitZ = true;
      return;
    }
  };
  horizontal('x', dx);
  horizontal('z', dz);
  out.onGround = grounded();
  return out;
}
