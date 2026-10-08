// Cave courses for the tests cavewalk, cavemobs, cavedeep and caveescape (u290): a winding tunnel network cut into the test slab's rock, in the dark, with the things a
// real cave has: turns, a squeeze one block wide, a pool to swim, a drop to a lower level (or a stair down), lava along a ledge, and hostile mobs waiting. Pure, seeded
// and checked (`reachable` walks the cave the way a player can, so a generated course is known to be solvable; unit-tested for many seeds).
//
// Coordinates are relative to the site (x, gy, z) with y relative to the slab's grass layer (y 0 = grass, so a player's feet on the surface are at y 1). The slab is stone
// from y -10 to -4, dirt -3 to -1, grass 0. Two levels: UPPER, feet at y -4 (floor block -5, 3 high, ceiling -1) and LOWER, feet at -8 (floor -9, ceiling -5).
import { makeRng } from './mathutil.js';

export const CAVE_KINDS = ['cavewalk', 'cavemobs', 'cavedeep', 'caveescape'];
export const UP = -4, LOW = -8;
/** The slab every cave course is cut into (a backed-up structure is 64 across at most: 4 + 56 = 60). */
export const CAVE_EXT = { w: 4, e: 56, r: 16 };
const SLAB = { y1: -10, y2: 0 };

/** @typedef {{x1:number,y1:number,z1:number,x2:number,y2:number,z2:number}} Box */

/**
 * @param {string} kind one of CAVE_KINDS
 * @param {number} seed
 * @param {number} level 1 (easy) .. 3
 * @returns {{ ext: {w:number,e:number,r:number}, air: Box[], fill: Array<Box & {block:string}>, start: {x:number,y:number,z:number}, goal: {x:number,y:number,z:number},
 *   mobs: Array<{type:string,x:number,y:number,z:number}>, kit: Array<[string, number]>, exitFeetY: number|null, text: string }}
 */
export function caveCourse(kind, seed = 1, level = 1) {
  if (!CAVE_KINDS.includes(kind)) throw new Error(`no cave course ${kind}`);
  const rng = makeRng(Math.floor(seed) * 7919 + level * 104729 + kind.length);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  /** @type {Box[]} */ const air = [];
  /** @type {Array<Box & {block:string}>} */ const fill = [];
  /** @type {Array<{type:string,x:number,y:number,z:number}>} */ const mobs = [];
  const box = (x1, y1, z1, x2, y2, z2) => ({ x1: Math.min(x1, x2), y1: Math.min(y1, y2), z1: Math.min(z1, z2), x2: Math.max(x1, x2), y2: Math.max(y1, y2), z2: Math.max(z1, z2) });
  const kit = [['stone_pickaxe', 1], ['stone_sword', 1], ['torch', 12], ['cobblestone', 16], ['bread', 6]];
  if (kind === 'cavedeep') kit.push(['bucket', 0]);

  // ---- the walk: legs of tunnel, each 'x' (east) or 'z' (sideways); the cursor is where the last leg ended
  let cx = 1, cz = 0, fy = UP, sgn = rng() < 0.5 ? 1 : -1;
  const corridor = (dir, len, w) => {
    const hw = (w - 1) >> 1, hw2 = w - 1 - hw;
    if (dir === 'x') { air.push(box(cx, fy, cz - hw, cx + len, fy + 2, cz + hw2)); cx += len; }
    else { const nz = cz + sgn * len; air.push(box(cx - hw, fy, cz, cx + hw2, fy + 2, nz)); cz = nz; }
  };
  const turn = (len, w) => {
    if (Math.abs(cz + sgn * len) > 11) sgn = -sgn;
    corridor('z', len, w);
  };
  const mobAt = (type, dx = 0, dz = 0) => mobs.push({ type, x: cx + dx, y: fy, z: cz + dz });
  const start = { x: cx, y: fy, z: cz };
  const longLegs = 3 + level;

  if (kind === 'caveescape') {
    // the lower level, a dead end at the east, the way out a ramp up through the rock at the west; zombies and a creeper between
    fy = LOW; cx = 8; cz = 0;
    const len = 20 + level * 3;
    air.push(box(cx, fy, -1, cx + len, fy + 2, 1));
    const sx = cx + len;
    start.x = sx; start.y = LOW; start.z = 0;
    // a side pocket or two, so there is somewhere to turn
    air.push(box(cx + 10, fy, 2, cx + 13, fy + 2, 4));
    // the ramp, rising to the west: column i has its feet at LOW + i; the top column opens onto the surface
    const rx = 8;
    for (let i = 0; i <= 8; i++) air.push(box(rx - i, LOW + i, -1, rx - i, LOW + i + 2, 1));
    const exitX = rx - 9;
    for (const [type, dx] of [['zombie', 2 + level], ['zombie', 5 + level], ['creeper', 10], ['zombie', 14]].slice(0, 2 + level)) mobs.push({ type, x: rx + dx + ri(0, 2), y: LOW, z: ri(-1, 1) });
    return { ext: { ...CAVE_EXT }, air, fill, start, goal: { x: exitX, y: 1, z: 0 }, mobs, kit, exitFeetY: 1,
      text: `You are at the dead end of a cave 12 below the surface, ${len} long, with zombies and a creeper between you and the way out (a ramp up at the far end) . Get out onto the surface (your pickaxe works too).` };
  }

  // ---- the three walks: straight, a turn, straights with a squeeze / pool / lava, a drop (or stairs) to the lower level, straight, a turn, straight, the goal
  corridor('x', ri(6, 8), 3);
  if (kind === 'cavemobs') { mobAt('zombie', -3, 0); if (level >= 2) mobAt('zombie', -5, 1); }
  turn(ri(5, 8), level === 3 ? 2 : 3);
  corridor('x', ri(7, 9), 3);
  const lenSq = ri(3, 4);
  corridor('x', lenSq, 1);                                               // the squeeze: one wide
  if (kind === 'cavemobs') mobAt('skeleton', -1, 0);
  const poolX = cx;
  corridor('x', 7, 3);                                                   // a wide hall; the pool or lava runs through its middle
  if (kind === 'cavewalk' || kind === 'cavemobs') {
    // the pool: two deep, 4 long, wall to wall, filled to the floor's level
    fill.push({ ...box(poolX + 2, fy - 2, cz - 1, poolX + 5, fy - 1, cz + 1), block: 'water' });
  } else {
    // lava: the floor of the hall is lava on both sides of a 1-wide path, and across the far end a 1-deep trench
    fill.push({ ...box(poolX + 1, fy - 1, cz - 1, poolX + 7, fy - 1, cz - 1), block: 'lava' }, { ...box(poolX + 1, fy - 1, cz + 1, poolX + 7, fy - 1, cz + 1), block: 'lava' });
    mobAt('skeleton', -2, 0);
  }
  // down to the lower level: a sheer drop of 4 (one heart) or a stair of 5 steps
  const stair = rng() < 0.5;
  if (stair) {
    for (let j = 0; j <= 4; j++) air.push(box(cx + 1 + j, fy - j, cz - 1, cx + 1 + j, fy - j + 2, cz + 1));
    cx += 5;
  } else {
    air.push(box(cx + 1, LOW, cz - 1, cx + 2, UP + 2, cz + 1));          // the shaft
    cx += 2;
  }
  fy = LOW;
  corridor('x', ri(7, 9), 3);
  if (kind === 'cavemobs') mobAt('zombie', -4, 0);
  if (kind === 'cavemobs' && level >= 2) mobAt('creeper', 0, 0);
  turn(ri(4, 6), 3);
  corridor('x', ri(5, 7), 3);
  const goal = { x: cx, y: fy, z: cz };
  void longLegs;
  const ext = { ...CAVE_EXT };
  return { ext, air, fill, start, goal, mobs, kit, exitFeetY: null,
    text: kind === 'cavewalk' ? 'A dark cave network: turns, a squeeze one block wide, a pool to cross, and a drop to a lower level. Walk to the gold block at the far end.'
      : kind === 'cavemobs' ? 'The same sort of cave, with zombies, a skeleton and more waiting in it. Get through to the gold block at the far end alive.'
        : 'A cave with lava in the floor either side of a narrow path, and a skeleton. Get to the gold block at the far end without burning.' };
}

/** Everything inside the slab is rock except what was carved; water and lava fill carved cells. */
function world(course) {
  const key = (x, y, z) => `${x},${y},${z}`;
  const carved = new Set(), liquid = new Map();
  for (const b of course.air) for (let x = b.x1; x <= b.x2; x++) for (let y = b.y1; y <= b.y2; y++) for (let z = b.z1; z <= b.z2; z++) carved.add(key(x, y, z));
  for (const b of course.fill) for (let x = b.x1; x <= b.x2; x++) for (let y = b.y1; y <= b.y2; y++) for (let z = b.z1; z <= b.z2; z++) { carved.add(key(x, y, z)); liquid.set(key(x, y, z), b.block); }
  const inSlab = (x, y, z) => y >= SLAB.y1 && y <= SLAB.y2 && x >= -course.ext.w && x <= course.ext.e && z >= -course.ext.r && z <= course.ext.r;
  const open = (x, y, z) => y > SLAB.y2 || (inSlab(x, y, z) && carved.has(key(x, y, z)));
  const solid = (x, y, z) => inSlab(x, y, z) && !carved.has(key(x, y, z));
  const liq = (x, y, z) => liquid.get(key(x, y, z)) ?? null;
  return { open, solid, liq, carved, key };
}

/**
 * Walk the cave as a player can: one block at a time, up one, down up to 3 (more is a fall that hurts, allowed to 4 for the shaft), swimming through water, never onto lava.
 * Returns the shortest walk (list of cells) from the start to the goal, or null. Pure.
 */
export function reachable(course, from = course.start, to = course.goal) {
  const W = world(course), key = W.key;
  const standable = (x, y, z) => {
    const l = W.liq(x, y, z);
    if (l === 'lava') return false;
    if (!(W.open(x, y, z) && W.open(x, y + 1, z))) return false;
    if (l === 'water') return true;
    const under = W.liq(x, y - 1, z);
    return under === 'lava' ? false : (W.solid(x, y - 1, z) || under === 'water');
  };
  const start = [from.x, from.y, from.z], seen = new Map([[key(...start), null]]);
  const queue = [start];
  const goalKey = key(to.x, to.y, to.z);
  const near = (c) => key(...c) === goalKey;
  while (queue.length) {
    const c = queue.shift();
    if (near(c)) { const path = []; for (let k = key(...c); k; k = seen.get(k)?.from ?? null) { path.push(k.split(',').map(Number)); } return path.reverse(); }
    const [x, y, z] = c;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1, -1, -2, -3, -4]) {
        const n = [x + dx, y + dy, z + dz];
        if (dy === 1 && !W.open(x, y + 2, z)) continue;                       // a step up needs headroom where we stand
        if (dy < 0) { let clear = true; for (let k = 0; k >= dy; k--) if (!(W.open(n[0], y + k, n[2]) && W.open(n[0], y + k + 1, n[2]))) clear = false; if (!clear) continue; }
        if (!standable(...n)) continue;
        const k = key(...n);
        if (seen.has(k)) continue;
        seen.set(k, { from: key(x, y, z) });
        queue.push(n);
        break;
      }
    }
  }
  return null;
}

/** The commands that build a course at (x, gy, z): fill the air boxes, the liquids, and a gold block under the goal. */
export function caveCommands(course, x, gy, z) {
  const c = [];
  const at = (b) => `${x + b.x1} ${gy + b.y1} ${z + b.z1} ${x + b.x2} ${gy + b.y2} ${z + b.z2}`;
  for (const b of course.air) c.push(`fill ${at(b)} air`);
  for (const b of course.fill) c.push(`fill ${at(b)} ${b.block}`);
  if (course.exitFeetY === null) c.push(`setblock ${x + course.goal.x} ${gy + course.goal.y - 1} ${z + course.goal.z} gold_block`);
  return c;
}
