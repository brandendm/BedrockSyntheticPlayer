// The iron farm's plan as a grid of blocks, and the pure checks that can be made on one: what is solid, what a golem could spawn on (the
// Bedrock rule), where the water goes (it spreads, and pushes things downhill), what is lit. No game in here; core/ironfarm.js lays the plan out
// and checks it with these, the tests and tools/sim_ironfarm.mjs use them, game/ironfarm.js reads the real world with the same rules.

export const SPAWN_VOLUME = Object.freeze({ rx: 8, ry: 6, rz: 8 });

/** Apply the plan's ops to a map "x,y,z" -> { id, states } (anything not set is air). */
export function render(plan) {
  const g = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (const o of plan.ops) {
    if (o.op === 'fill') {
      for (let x = o.box.x1; x <= o.box.x2; x++) for (let y = o.box.y1; y <= o.box.y2; y++) for (let z = o.box.z1; z <= o.box.z2; z++) {
        if (o.id === 'air') g.delete(key(x, y, z)); else g.set(key(x, y, z), { id: o.id });
      }
    } else {
      g.set(key(o.x, o.y, o.z), { id: o.id, states: o.states });
      if (o.id === 'bed' && o.states?.head_piece_bit) g.set(key(o.x, o.y, o.z - 1), { id: 'bed', states: { direction: 0, head_piece_bit: false } });
    }
  }
  return { at: (x, y, z) => g.get(key(x, y, z)), id: (x, y, z) => g.get(key(x, y, z))?.id ?? 'air', cells: g };
}

/** What a golem (and anything else) walks through: no collision. Lava, slabs, doors, campfires are not. */
const FREE = new Set(['air', 'water', 'wall_sign', 'torch']);
/** Full blocks (and near enough): what a golem could be spawned on. Slabs and stairs are not: that is what the slabs are for. */
const SUPPORT = new Set(['cobblestone', 'glass', 'composter', 'hopper', 'chest', 'bed']);
/** Blocks that stop light (the torches' glow goes through glass, signs and air). */
const OPAQUE = new Set(['cobblestone', 'composter']);
export const passable = (id) => FREE.has(id);
export const solid = (id) => SUPPORT.has(id);
export const opaque = (id) => OPAQUE.has(id);

const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** The air outside the farm: everything reachable through air from beyond the bounds. */
export function outsideAir(grid, b) {
  const lo = { x: b.x1 - 1, y: b.y1 - 1, z: b.z1 - 1 }, hi = { x: b.x2 + 1, y: b.y2 + 1, z: b.z2 + 1 };
  const seen = new Set([`${lo.x},${lo.y},${lo.z}`]);
  const q = [[lo.x, lo.y, lo.z]];
  for (let i = 0; i < q.length; i++) {
    const [x, y, z] = q[i];
    for (const [dx, dy, dz] of DIRS6) {
      const nx = x + dx, ny = y + dy, nz = z + dz, k = `${nx},${ny},${nz}`;
      if (nx < lo.x || nx > hi.x || ny < lo.y || ny > hi.y || nz < lo.z || nz > hi.z || seen.has(k) || grid.id(nx, ny, nz) !== 'air') continue;
      seen.add(k); q.push([nx, ny, nz]);
    }
  }
  return seen;
}

/**
 * The air outside the farm that rests on a full block: a golem could spawn in it (given room above). `except(x, y, z)` says which tops are
 * meant to be bare (the platform's own floor, where the golems are meant to spawn).
 * @param {any} grid @param {any} b @param {(x: number, y: number, z: number) => boolean} [except]
 */
export function exposedTops(grid, b, except = () => false) {
  const out = outsideAir(grid, b);
  const tops = [];
  for (const [k, v] of grid.cells) {
    if (!solid(v.id)) continue;
    const [x, y, z] = k.split(',').map(Number);
    if (except(x, y, z)) continue;
    if (out.has(`${x},${y + 1},${z}`)) tops.push({ x, y: y + 1, z });
  }
  return tops;
}

/** Cells in x-runs, per level and row: [{ y, z, x1, x2 }]. */
export function runs(cells) {
  const by = new Map();
  for (const c of cells) { const k = `${c.y},${c.z}`; if (!by.has(k)) by.set(k, []); by.get(k).push(c.x); }
  const out = [];
  for (const [k, xs] of by) {
    const [y, z] = k.split(',').map(Number);
    xs.sort((a, b) => a - b);
    let s = xs[0], p = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === p + 1) { p = xs[i]; continue; }
      out.push({ y, z, x1: s, x2: p });
      s = xs[i]; p = xs[i];
    }
  }
  return out.sort((a, b) => a.y - b.y || a.z - b.z || a.x1 - b.x1);
}

/**
 * The spots where Bedrock could spawn an iron golem, inside the 17 x 13 x 17 volume round `centre` (a block): a full block underneath and, from
 * the feet up, a box 2 x 4 x 2 (one block back in x and z, three up) with nothing solid in it (water, signs and torches are fine).
 * `grid.id(x, y, z)` answers for any cell; the spots are the feet cells, [{ x, y, z }].
 */
export function golemSpots(grid, centre) {
  const out = [];
  const V = SPAWN_VOLUME;
  for (let x = centre.x - V.rx; x <= centre.x + V.rx; x++) for (let y = centre.y - V.ry; y <= centre.y + V.ry; y++) for (let z = centre.z - V.rz; z <= centre.z + V.rz; z++) {
    if (!solid(grid.id(x, y - 1, z))) continue;
    let free = true;
    for (let i = x - 1; free && i <= x; i++) for (let j = y; free && j <= y + 3; j++) for (let k = z - 1; free && k <= z; k++) if (!passable(grid.id(i, j, k))) free = false;
    if (free) out.push({ x, y, z });
  }
  return out;
}

/**
 * How water spreads from the sources over one layer: Map "x,z" -> level (0 = a source, up to 7), one level more with each step, through free
 * cells (a wall sign stops it: that is what holds the water out of the shaft).
 */
export function waterField(grid, sources, y) {
  const lv = new Map();
  const q = [];
  for (const s of sources) { lv.set(`${s.x},${s.z}`, 0); q.push([s.x, s.z, 0]); }
  for (let i = 0; i < q.length; i++) {
    const [x, z, l] = q[i];
    if (l >= 7) continue;
    for (const [dx, dz] of DIRS4) {
      const nx = x + dx, nz = z + dz, k = `${nx},${nz}`;
      const here = grid.id(nx, y, nz);
      if (lv.has(k) || !passable(here) || here === 'wall_sign') continue;
      lv.set(k, l + 1); q.push([nx, nz, l + 1]);
    }
  }
  return lv;
}

/** The height of the water at a level (a source is 8/9 of a block; each level is a ninth lower). */
const heightOf = (l) => (8 - l) / 9;

/** The push on something in the water at cell (x, z): toward lower neighbours, in proportion to the drop (the game's own sum). null: no water there. */
export function flowAt(lv, x, z) {
  const l = lv.get(`${x},${z}`);
  if (l === undefined) return null;
  const h = heightOf(l);
  let vx = 0, vz = 0;
  for (const [dx, dz] of DIRS4) {
    const n = lv.get(`${x + dx},${z + dz}`);
    if (n === undefined) continue;                       // a wall, or no water: no push from it
    const g = h - heightOf(n);
    vx += dx * g; vz += dz * g;
  }
  return { x: vx, z: vz };
}

/**
 * Let something drift with the water from (sx, sz) (block coordinates, fractions allowed): steps of 0.05 along the push, sliding along walls.
 * Arrives when it is within `tol` of (hx, hz), the middle of the hole; returns { arrived, x, z, steps }.
 */
export function drift(lv, sx, sz, hx, hz, tol = 0.3, maxSteps = 3000) {
  let x = sx, z = sz;
  for (let n = 0; n < maxSteps; n++) {
    if (Math.abs(x - hx) <= tol && Math.abs(z - hz) <= tol) return { arrived: true, x, z, steps: n };
    const f = flowAt(lv, Math.floor(x), Math.floor(z));
    if (!f) return { arrived: false, x, z, steps: n, why: 'out of the water' };
    const m = Math.hypot(f.x, f.z);
    if (m < 1e-9) return { arrived: false, x, z, steps: n, why: 'no push here' };
    const dx = (f.x / m) * 0.05, dz = (f.z / m) * 0.05;
    const inWater = (a, b) => lv.has(`${Math.floor(a)},${Math.floor(b)}`);
    if (inWater(x + dx, z + dz)) { x += dx; z += dz; }
    else if (inWater(x + dx, z)) x += dx;
    else if (inWater(x, z + dz)) z += dz;
    else return { arrived: false, x, z, steps: n, why: 'pushed into a wall' };
  }
  return { arrived: false, x, z, steps: maxSteps, why: 'going round in circles' };
}

/** Light from torches (14) and lava (15), one less per block through anything that lets it through: Map "x,y,z" -> level. A source is { x, y, z, level? }. */
export function lightField(grid, torches) {
  const lv = new Map();
  const q = [];
  for (const t of torches) { const l = t.level ?? 14; lv.set(`${t.x},${t.y},${t.z}`, l); q.push([t.x, t.y, t.z, l]); }
  for (let i = 0; i < q.length; i++) {
    const [x, y, z, l] = q[i];
    if (l <= 1) continue;
    for (const [dx, dy, dz] of DIRS6) {
      const nx = x + dx, ny = y + dy, nz = z + dz, k = `${nx},${ny},${nz}`;
      if (lv.has(k) || opaque(grid.id(nx, ny, nz))) continue;
      lv.set(k, l - 1); q.push([nx, ny, nz, l - 1]);
    }
  }
  return lv;
}

/** The cells a villager can walk to from `from` at one level (4-neighbour, through free cells): a Set of "x,z". */
export function walkable(grid, y, from) {
  const seen = new Set([`${from.x},${from.z}`]);
  const q = [[from.x, from.z]];
  for (let i = 0; i < q.length; i++) {
    const [x, z] = q[i];
    for (const [dx, dz] of DIRS4) {
      const nx = x + dx, nz = z + dz, k = `${nx},${nz}`;
      if (seen.has(k) || !passable(grid.id(nx, y, nz)) || !passable(grid.id(nx, y + 1, nz))) continue;
      seen.add(k); q.push([nx, nz]);
    }
  }
  return seen;
}

/** A block id with states as a setblock argument, or the bare id. */
export function blockArg(id, states) {
  if (!states) return id;
  const s = Object.entries(states).map(([k, v]) => `"${k}"=${typeof v === 'string' ? `"${v}"` : v}`).join(',');
  return `${id} [${s}]`;
}
