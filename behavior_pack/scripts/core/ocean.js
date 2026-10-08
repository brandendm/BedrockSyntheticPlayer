// Ocean courses for the tests oceandrop and oceandeep (u291): a deep pool cut into the test slab, the bot dropped far from any shore (or sunk to the bottom), with
// drowned about at the higher levels. It must swim to land (and, from the bottom, come up for air first). Pure, seeded, checked (`reachable` swims it).
// Coordinates as in core/caves.js: relative to the site, y 0 = the slab's grass layer, surface feet at y 1.
import { makeRng } from './mathutil.js';
import { CAVE_EXT } from './caves.js';

export const OCEAN_KINDS = ['oceandrop', 'oceandeep'];
/** The pool: x 6..50, z -14..14, water from the bottom (y -8) up to the grass layer (y 0). Everything else on the slab is land. */
export const POOL = { x1: 6, x2: 50, z1: -14, z2: 14, bottom: -8, top: 0 };
export const OCEAN_EXT = { ...CAVE_EXT };

export function oceanCourse(kind, seed = 1, level = 1) {
  if (!OCEAN_KINDS.includes(kind)) throw new Error(`no ocean course ${kind}`);
  const rng = makeRng(Math.floor(seed) * 6007 + level * 31337 + kind.length);
  const P = POOL;
  const sx = 24 + Math.floor(rng() * 9), sz = -3 + Math.floor(rng() * 7);     // near the middle: about 15 blocks from the nearest shore
  const fill = [{ x1: P.x1, y1: P.bottom, z1: P.z1, x2: P.x2, y2: P.top, z2: P.z2, block: 'water' }];
  const start = { x: sx, y: kind === 'oceandeep' ? P.bottom : P.top, z: sz };    // feet: at the surface (water block y 0: surface just under 1), or on the bottom
  const mobs = [];
  const n = level >= 2 ? level : 0;
  for (let i = 0; i < n; i++) mobs.push({ type: 'drowned', x: sx + 4 + 3 * i, y: P.top - 2, z: sz + (i % 2 ? 3 : -3) });
  const kit = [['stone_sword', 1], ['bread', 6], ['cobblestone', 16]];
  return { ext: { ...OCEAN_EXT }, fill, start, mobs, kit, pool: P,
    text: kind === 'oceandrop' ? 'You are dropped into the middle of an ocean, about 15 blocks from any shore. Swim to land and climb out.'
      : 'You are at the bottom of an ocean, 9 deep, far from any shore. Get to the surface, then to land.' };
}

/** Is the foot position on land (outside the pool, standing on the grass layer)? Pure; used by the test and its check. */
export function onLand(x, y, z, pool = POOL) {
  const inPool = x >= pool.x1 - 0.2 && x <= pool.x2 + 1.2 && z >= pool.z1 - 0.2 && z <= pool.z2 + 1.2;
  return !inPool && y >= 0.9;
}

/** The shortest swim (in blocks, 4-neighbour steps) from the start to the nearest land cell. */
export function swimDistance(course) {
  const P = course.pool, s = course.start;
  let best = Infinity;
  for (let x = P.x1 - 1; x <= P.x2 + 1; x++) for (let z = P.z1 - 1; z <= P.z2 + 1; z++) {
    if (x >= P.x1 && x <= P.x2 && z >= P.z1 && z <= P.z2) continue;
    best = Math.min(best, Math.abs(x - s.x) + Math.abs(z - s.z));
  }
  return best;
}

/** Commands that cut the pool. */
export function oceanCommands(course, x, gy, z) {
  return course.fill.map((b) => `fill ${x + b.x1} ${gy + b.y1} ${z + b.z1} ${x + b.x2} ${gy + b.y2} ${z + b.z2} ${b.block}`);
}
