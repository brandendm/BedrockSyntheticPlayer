// A fully drawn bow's arrow: speed 3 blocks/tick, drag 0.99, gravity 0.05 per tick. Pure (unit-tested).

/** Height of the arrow when it has flown `d` blocks along, shot `pitch` radians up (null if it never gets there). */
export function heightAt(pitch, d, v0 = 3, g = 0.05, drag = 0.99) {
  let x = 0, y = 0, vx = v0 * Math.cos(pitch), vy = v0 * Math.sin(pitch);
  for (let t = 0; t < 400; t++) {
    const nx = x + vx, ny = y + vy;
    if (nx >= d) return y + ((d - x) / Math.max(1e-9, nx - x)) * (ny - y);
    x = nx; y = ny; vx *= drag; vy = vy * drag - g;
    if (vx < 0.01) return null;
  }
  return null;
}

/** The (flat) pitch in radians that puts the arrow `dy` above where it was shot, `d` blocks away. */
export function solvePitch(d, dy, v0 = 3) {
  let best = 0, bestErr = Infinity;
  for (let th = -0.4; th <= 0.9; th += 0.002) {
    const h = heightAt(th, d, v0);
    if (h === null) continue;
    const e = Math.abs(h - dy);
    if (e < bestErr - 1e-9) { bestErr = e; best = th; }
  }
  return best;
}
