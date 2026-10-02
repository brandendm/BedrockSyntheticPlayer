// Nether portal frames: finding one in the world, what its inside is, where to stand in it. Pure (unit-tested).
//
// A frame is obsidian round an empty (or already lit) rectangle, 2..21 wide and 3..21 tall, standing in the x/y plane (axis
// 'x': it runs along x at one z) or the z/y plane (axis 'z'). The bot's own, one it found, or a ruined one (some of the
// obsidian gone: `missing` lists what a repair would have to put back). Getting through one is pathfinding to the floor of
// its inside and standing still there until the game moves us; nothing here assumes where the ground is.
const OBS = /^(minecraft:)?obsidian$/;
const INSIDE = /^(minecraft:)?(air|portal|fire|short_grass|tall_grass|snow_layer)$/;
export const isObsidian = (id) => OBS.test(String(id ?? ''));
export const isInside = (id) => INSIDE.test(String(id ?? ''));
const isLitBlock = (id) => /^(minecraft:)?portal$/.test(String(id ?? ''));

/**
 * get(x, y, z) -> block id or null (unloaded). Scans the box [cx +- r, cy +- ry] for frames; the nearest first.
 * Returns [{ axis, x0, y0, z0, w, h, lit, missing: [cells], dist }]; x0/y0/z0 is the inside's lowest corner (smallest x or z).
 */
export function findFrames(get, c, r = 16, ry = 8, { allowMissing = 0 } = {}) {
  const out = [], seen = new Set();
  const cx = Math.floor(c.x), cy = Math.floor(c.y), cz = Math.floor(c.z);
  for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++) for (let y = cy - ry; y <= cy + ry; y++) {
    if (!isInside(get(x, y, z)) || !isObsidian(get(x, y - 1, z))) continue; // (an inside cell with obsidian under it: a candidate bottom corner or edge)
    for (const axis of ['x', 'z']) {
      // The lowest-corner cell has obsidian to its low side as well.
      const lx = axis === 'x' ? x - 1 : x, lz = axis === 'z' ? z - 1 : z;
      if (!isObsidian(get(lx, y, lz)) && allowMissing === 0) continue;
      for (let w = 2; w <= 21; w++) {
        for (let h = 3; h <= 21; h++) {
          const f = check(get, axis, x, y, z, w, h, allowMissing);
          if (!f) continue;
          const key = `${axis},${x},${y},${z},${w},${h}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ axis, x0: x, y0: y, z0: z, w, h, ...f, dist: Math.hypot(x + (axis === 'x' ? w / 2 : 0.5) - c.x, z + (axis === 'z' ? w / 2 : 0.5) - c.z) });
        }
      }
    }
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/** Is there a frame with this inside? { lit, missing } or null. Corners are not part of a frame. */
function check(get, axis, x0, y0, z0, w, h, allowMissing) {
  const at = (i, j) => (axis === 'x' ? [x0 + i, y0 + j, z0] : [x0, y0 + j, z0 + i]);
  const missing = [];
  let lit = false;
  for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) {
    const id = get(...at(i, j));
    if (!isInside(id)) return null;
    if (isLitBlock(id)) lit = true;
  }
  const need = [];
  for (let i = 0; i < w; i++) { need.push(at(i, -1)); need.push(at(i, h)); }
  for (let j = 0; j < h; j++) { need.push(at(-1, j)); need.push(at(w, j)); }
  for (const p of need) {
    const id = get(...p);
    if (id === null) return null; // not loaded: can't say
    if (!isObsidian(id)) { missing.push({ x: p[0], y: p[1], z: p[2] }); if (missing.length > allowMissing) return null; }
  }
  return { lit, missing };
}

/** The cells of the inside's floor row, middle first: where to stand. */
export function floorCells(f) {
  const cells = [];
  for (let i = 0; i < f.w; i++) cells.push(f.axis === 'x' ? { x: f.x0 + i, y: f.y0, z: f.z0 } : { x: f.x0, y: f.y0, z: f.z0 + i });
  const mid = (f.w - 1) / 2;
  return cells.sort((a, b) => Math.abs((f.axis === 'x' ? a.x - f.x0 : a.z - f.z0) - mid) - Math.abs((f.axis === 'x' ? b.x - f.x0 : b.z - f.z0) - mid));
}

/** The centre of a floor cell, to stand on exactly. */
export const standPoint = (cell) => ({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 });

/** Which way across the frame the bot should come from: the side of the plane it is on (+1/-1 along the frame's normal). */
export function approachSide(f, p) {
  return f.axis === 'x' ? (p.z >= f.z0 + 0.5 ? 1 : -1) : (p.x >= f.x0 + 0.5 ? 1 : -1);
}
