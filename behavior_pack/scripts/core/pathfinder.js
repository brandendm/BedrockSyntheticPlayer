// Grid A* over block positions, Baritone-style but minimal for milestone 1.
// Pure: talks to the world only through `classify(x, y, z) -> Cell`.
//
// A node is the block the bot's FEET occupy. A node is standable when the block
// below is solid and the feet + head blocks are open.
//
// Moves:  walk (8 directions, no corner cutting), step up 1 (cardinal),
//         drop 1-3 (cardinal, 3 is the max without fall damage),
//         leap a 1-block gap (cardinal, same level; only over a gap we'd survive falling into),
//         swim along the water surface (feet in water, head in air), climb out onto a bank,
//         climb ladders and vines up and down (and step off them onto a ledge).
// Actions (actionNeighbors): dig through, dig a step up, pillar, bridge, dig down. Each is just
//         another move generator with a cost, so they slot in without touching the search.

export const Cell = Object.freeze({
  AIR: 0,      // open, walk through
  SOLID: 1,    // can stand on, blocks movement
  LIQUID: 2,   // water: swimmable at the surface, costed so land routes win when they're not much longer
  DANGER: 3,   // lava, fire, cactus, magma... never enter, never stand on
  UNKNOWN: 4,  // unloaded chunk: treat as impassable
  CLIMB: 5,    // ladder, vines: open to walk into, and you can go up and down in it
  STEP: 6,     // stairs the right way up: stood on like ground, and walked up onto from the level
               // below without a jump (the front half is half a block; Bedrock steps up 0.5625)
  SLAB: 7,     // a bottom slab: ground half a block high. Walked onto from full-height ground; but
               // standing on it we're half a block low, so the next level up is out of a jump's reach
  FLOW: 8,     // flowing water (not a source, not falling): swum like water, but its current pushes
               // a body along it (off quarry steps, back down a slope), so routes keep out of it
});

/** Water of either kind (still or flowing). */
export const isWet = (c) => c === Cell.LIQUID || c === Cell.FLOW;

/** Something to stand on: a full block, stairs, a bottom slab. */
export const isGround = (c) => c === Cell.SOLID || c === Cell.STEP || c === Cell.SLAB;
const isHalf = (c) => c === Cell.STEP || c === Cell.SLAB;

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];
const SQRT2 = Math.SQRT2;

export const DEFAULT_COSTS = Object.freeze({
  walk: 1,
  diagonal: SQRT2,
  stepUp: 0.8,      // extra on top of walk (the jump)
  dropPerBlock: 0.3,
  maxDrop: 3,
  swim: 2.5,        // extra per block: swimming is ~2x slower and mobs get free hits
  climb: 1.8,       // per block up or down a ladder (~2.4 blocks/s vs 4.3 walking)
  leap: 0.9,        // extra for jumping a gap, per block of it (on top of the blocks walked)
  maxLeap: 3,       // widest gap jumped: 1 walking, 2-3 with a sprint-jump
  stair: 0.15,      // extra for walking up a stair or onto a slab (no jump)
  flow: 6,          // extra per block of flowing water swum (its current pushes: a route keeps out of it if it can)
  dive: 0,          // extra per block under water (0: never dive; game/agent.js turns it on with air to spare)
  bucketDrop: 0,    // with a water bucket: drops this deep are fine too (the fall's broken with water, game/agent.js fallTick); 0: off
  bucketDropCost: 3, // extra for one (putting the water down and scooping it back up)
});

/**
 * Numeric key for a block near `o` (within 65k blocks sideways, any build height): a string key
 * per lookup was a good part of every search's time (the engine's JS is far slower than Node's).
 */
export const cellKey = (o, x, y, z) => ((x - o.x + 65536) * 131072 + (z - o.z + 65536)) * 1024 + (y + 512);

/** Memoises classify() for the duration of one search. */
export class WorldView {
  constructor(classify, origin = { x: 0, y: 0, z: 0 }) {
    this.classify = classify;
    this.o = { x: Math.floor(origin.x), y: 0, z: Math.floor(origin.z) };
    this.cache = new Map();
    /** @type {(x: number, y: number, z: number) => number} seconds to break a block (actions searches) */
    this.breakCost = () => Infinity;
  }
  k(x, y, z) { return cellKey(this.o, x, y, z); }
  get(x, y, z) {
    const k = cellKey(this.o, x, y, z);
    let c = this.cache.get(k);
    if (c === undefined) {
      c = this.classify(x, y, z);
      this.cache.set(k, c);
    }
    return c;
  }
  open(x, y, z) {
    const c = this.get(x, y, z);
    return c === Cell.AIR || c === Cell.CLIMB;
  }
  standable(x, y, z) {
    return isGround(this.get(x, y - 1, z)) && this.open(x, y, z) && this.open(x, y + 1, z);
  }
  /** Holding on to a ladder or vine. */
  climbable(x, y, z) {
    return this.get(x, y, z) === Cell.CLIMB && this.open(x, y + 1, z);
  }
  /** Floating at the surface: feet in water, head in air. */
  swimmable(x, y, z) {
    // Water with something under it (more water or ground): never a thin sheet over a drop.
    return isWet(this.get(x, y, z)) && this.open(x, y + 1, z) && this.get(x, y - 1, z) !== Cell.AIR;
  }
  /**
   * Under water, head and all (a dive): air never far. The surface within 5 blocks up, straight
   * above or one block over (under a short overhang, a wall we're swimming under).
   */
  submerged(x, y, z) {
    if (!isWet(this.get(x, y, z)) || !isWet(this.get(x, y + 1, z))) return false;
    const upToAir = (cx, cz, from) => {
      for (let k = from; k <= 6; k++) {
        const c = this.get(cx, y + k, cz);
        if (c === Cell.AIR) return true;
        if (!isWet(c)) return false;
      }
      return false;
    };
    if (upToAir(x, z, 2)) return true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isWet(this.get(x + dx, y + 1, z + dz)) && upToAir(x + dx, z + dz, 1)) return true;
    return false;
  }
  occupiable(x, y, z) {
    return this.standable(x, y, z) || this.swimmable(x, y, z) || this.climbable(x, y, z);
  }
  /** Can a body pass through this cell sideways (air or water, not solid/danger)? */
  passable(x, y, z) {
    const c = this.get(x, y, z);
    return c === Cell.AIR || c === Cell.LIQUID || c === Cell.FLOW || c === Cell.CLIMB;
  }
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(n) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Yields [nx, ny, nz, cost] for every legal move from (x, y, z). */
export function* neighbors(w, x, y, z, costs = DEFAULT_COSTS) {
  const inWater = w.swimmable(x, y, z);
  // Into water: the swim's extra; into a current, far more (it pushes: off steps, back down).
  const enter = (nx, ny, nz, base) => [nx, ny, nz, base + (w.swimmable(nx, ny, nz) ? costs.swim + (w.get(nx, ny, nz) === Cell.FLOW ? (costs.flow ?? 6) : 0) : 0)];
  // Under water (costs.dive: off unless asked for, and then only where the surface is close above).
  if (costs.dive && (inWater || w.submerged(x, y, z))) {
    const sub = (nx, ny, nz) => w.submerged(nx, ny, nz) && w.get(nx, ny, nz) !== Cell.FLOW;
    for (const [dx, dz] of DIRS.slice(0, 4)) if (sub(x + dx, y, z + dz)) yield [x + dx, y, z + dz, costs.walk + costs.swim + costs.dive, { type: 'dive', breaks: [], place: false }];
    if (sub(x, y - 1, z)) yield [x, y - 1, z, costs.swim + costs.dive, { type: 'dive', breaks: [], place: false }];
    if (!inWater && (sub(x, y + 1, z) || w.swimmable(x, y + 1, z))) yield [x, y + 1, z, costs.swim + (w.swimmable(x, y + 1, z) ? 0 : costs.dive), { type: 'dive', breaks: [], place: false }];
    if (!inWater) return; // (under water: only these, and up to the surface)
  }
  // On a ladder: straight up or down it.
  if (w.climbable(x, y, z)) {
    if (w.climbable(x, y + 1, z)) yield [x, y + 1, z, costs.climb];
    if (w.climbable(x, y - 1, z) || w.standable(x, y - 1, z)) yield [x, y - 1, z, costs.climb * 0.6];
  }
  for (const [dx, dz] of DIRS) {
    const nx = x + dx, nz = z + dz;
    const diag = dx !== 0 && dz !== 0;

    if (diag) {
      // No corner cutting: both orthogonal neighbours must be clear for feet and head.
      if (!(w.passable(x + dx, y, z) && w.open(x + dx, y + 1, z) &&
            w.passable(x, y, z + dz) && w.open(x, y + 1, z + dz))) continue;
      if (w.occupiable(nx, y, nz)) yield enter(nx, y, nz, costs.diagonal);
      continue;
    }

    // Flat walk or swim
    if (w.occupiable(nx, y, nz)) {
      yield enter(nx, y, nz, costs.walk);
      continue;
    }
    // Up a stair or onto a slab: walked, not jumped, and hardly slower than the flat. It still wants
    // a block of room over where we stand: the body rises half a block while it's still here.
    const below = w.get(x, y - 1, z);
    if (!inWater && below !== Cell.SLAB && isHalf(w.get(nx, y, nz)) && w.open(x, y + 2, z) && w.standable(nx, y + 1, nz)) {
      yield [nx, y + 1, nz, costs.walk + costs.stair, { type: 'stair', breaks: [], place: false }];
      continue;
    }
    // Step up (a jump, or climbing out of water onto the bank): needs headroom above us. Not from on
    // top of a slab: that's a 1.5 block climb.
    if (below !== Cell.SLAB && w.open(x, y + 2, z) && w.standable(nx, y + 1, nz)) {
      yield [nx, y + 1, nz, costs.walk + costs.stepUp + (inWater ? 0.5 : 0)];
      continue;
    }
    // Leap a 1-block gap: running jump from the edge onto the block beyond, same level. Needs
    // headroom all the way (the arc peaks ~1.25 up), and only over a gap we'd survive falling
    // into (ground or water within 3 blocks): a missed jump costs a climb, never a life.
    // Wider gaps (2 or 3 blocks: a trench, a stream bed, a gap in a ridge): a sprint-jump, with a
    // block of run-up behind us for the 3. The same rule: only over a drop we'd survive.
    if (!inWater && costs.leap != null && w.open(nx, y, nz) && w.open(nx, y + 1, nz) && w.open(nx, y + 2, nz) &&
        w.open(x, y + 2, z) && !w.occupiable(nx, y - 1, nz) && !isGround(w.get(nx, y - 1, nz))) {
      for (let gap = 1; gap <= (costs.maxLeap ?? 3); gap++) {
        const gx = x + gap * dx, gz = z + gap * dz;
        // Every block of the gap open all the way up (the arc) and nothing to land on in it.
        if (!(w.open(gx, y, gz) && w.open(gx, y + 1, gz) && w.open(gx, y + 2, gz)) || isGround(w.get(gx, y - 1, gz)) || !safeGap(w, gx, y, gz)) break;
        const lx = x + (gap + 1) * dx, lz = z + (gap + 1) * dz;
        if (!(w.standable(lx, y, lz) && w.open(lx, y + 2, lz))) continue;
        if (gap === 3 && !w.standable(x - dx, y, z - dz)) break; // (no run-up: no sprint)
        yield [lx, y, lz, (gap + 1) * costs.walk + costs.leap * gap, { type: 'leap', gap, breaks: [], place: false }];
        break;
      }
    }
    // Drop: walk off the edge and fall straight down (into water is fine too)
    // With a water bucket, much further: off a pillar or a cliff and down in one go, the water put
    // down just before landing (only onto solid ground, the whole way down open).
    if (w.open(nx, y, nz) && w.open(nx, y + 1, nz)) {
      const deepest = Math.max(costs.maxDrop, costs.bucketDrop ?? 0);
      for (let d = 1; d <= deepest; d++) {
        const ny = y - d;
        if (w.occupiable(nx, ny, nz)) {
          if (d <= costs.maxDrop) yield enter(nx, ny, nz, costs.walk + costs.dropPerBlock * d);
          else if (w.standable(nx, ny, nz)) yield [nx, ny, nz, costs.walk + costs.dropPerBlock * costs.maxDrop + (d - costs.maxDrop) * 0.1 + costs.bucketDropCost, { type: 'bucketDrop', breaks: [], place: false }];
          break;
        }
        if (!w.open(nx, ny, nz)) break; // landed on something we can't stand on
      }
    }
  }
}

/** Falling into this gap would be survivable: ground or water within 3 blocks, no lava or fire. */
function safeGap(w, x, y, z) {
  for (let d = 1; d <= 4; d++) {
    const c = w.get(x, y - d, z);
    if (isWet(c)) return true;
    if (isGround(c)) return d <= 4; // landing on top of it: a fall of d-1 blocks
    if (c !== Cell.AIR) return false;    // lava, fire, unloaded...
  }
  return false;
}

/**
 * Moves that change the world, Baritone-style: dig through (forward, or a step up), pillar up
 * (jump and put a block under us), bridge (a block in front, over a gap or water), dig straight
 * down onto solid ground. Costs are in the same
 * units as walking (1 = one block walked, ~0.23 s): seconds * act.unitsPerSecond.
 *
 * act: {
 *   breakCost(x, y, z) -> seconds to break that block, Infinity if we mustn't (liquid next to it,
 *                         someone's build, bedrock, sand hanging over it...). Open cells cost 0.
 *   placeCost          seconds per block placed (jump + place + what the block is worth to us)
 *   budget             how many blocks we can place along the whole path
 *   unitsPerSecond     4.3 (walking speed)
 * }
 * Yields [nx, ny, nz, cost, move] with move = { type, breaks: [[x,y,z]...], place: bool }.
 */
export function* actionNeighbors(w, x, y, z, act, placed, onPlaced = false) {
  const u = act.unitsPerSecond ?? 4.3;
  const cellCost = (cx, cy, cz) => {
    const c = w.get(cx, cy, cz);
    if (c === Cell.AIR || c === Cell.CLIMB) return 0;
    // Solid blocks, and "danger" ones the game side says can be broken (leaves: never walked
    // through, but cut through when that's the way out of a tree top).
    if (c !== Cell.SOLID && c !== Cell.DANGER && !isHalf(c)) return Infinity;
    return w.breakCost(cx, cy, cz);
  };
  // Standing on ground, or on the block we just put down (the world view doesn't know about it).
  // onPlaced: true, or the move that put it there ({type: 'pillar'|'bridge', ...}).
  const onGround = !!onPlaced || isGround(w.get(x, y - 1, z));
  const lastType = /** @type {any} */ (onPlaced)?.type ?? null;
  if (!onGround) return;
  for (const [dx, dz] of DIRS.slice(0, 4)) {
    const nx = x + dx, nz = z + dz;
    // Dig through to the next block on the same level.
    if (isGround(w.get(nx, y - 1, nz))) {
      const a = cellCost(nx, y, nz), b = cellCost(nx, y + 1, nz);
      if (a + b > 0 && a + b < Infinity) {
        const breaks = [];
        if (a > 0) breaks.push([nx, y, nz]);
        if (b > 0) breaks.push([nx, y + 1, nz]);
        yield [nx, y, nz, 1 + (a + b) * u, { type: 'dig', breaks, place: false }];
      }
    }
    // Dig a step up: headroom above us, then the two blocks in front, one level up.
    const floorUp = w.get(nx, y, nz);
    if (isGround(floorUp)) {
      const h = cellCost(x, y + 2, z), a = cellCost(nx, y + 1, nz), b = cellCost(nx, y + 2, nz);
      if (h + a + b > 0 && h + a + b < Infinity) {
        const breaks = [];
        if (h > 0) breaks.push([x, y + 2, z]);
        if (a > 0) breaks.push([nx, y + 1, nz]);
        if (b > 0) breaks.push([nx, y + 2, nz]);
        yield [nx, y + 1, nz, 1.8 + (h + a + b) * u, { type: 'digUp', breaks, place: false }];
      }
    }
  }
  // Bridge: put a block down in front, against the side of the one we stand on, and walk onto it
  // (over a gap, or over water instead of swimming). Only across a real gap (2+ deep, or water),
  // and never off the top of a pillar: bridges through the air over walkable ground would blow
  // the search up and are never worth it.
  if (placed < (act.budget ?? 0) && act.bridge !== false && lastType !== 'pillar') {
    for (const [dx, dz] of DIRS.slice(0, 4)) {
      const nx = x + dx, nz = z + dz;
      const below = w.get(nx, y - 1, nz);
      const gap = isWet(below) || (below === Cell.AIR && !isGround(w.get(nx, y - 2, nz)));
      if (gap && w.open(nx, y, nz) && w.open(nx, y + 1, nz)) {
        yield [nx, y, nz, 1 + (act.placeCost + 0.5) * u, { type: 'bridge', breaks: [], place: true }];
      }
    }
  }
  // Pillar: jump and place a block where our feet were. (pillar: false: stairs only, a way to keep)
  if (placed < (act.budget ?? 0) && act.pillar !== false) {
    const h = cellCost(x, y + 2, z);
    if (h < Infinity && !isWet(w.get(x, y, z)) && w.get(x, y, z) !== Cell.CLIMB) {
      yield [x, y + 1, z, (act.placeCost + h) * u, { type: 'pillar', breaks: h > 0 ? [[x, y + 2, z]] : [], place: true }];
    }
  }
  // Dig straight down onto solid ground (never into a drop, never onto lava).
  if (act.digDown !== false) {
    const f = cellCost(x, y - 1, z);
    if (f > 0 && f < Infinity && isGround(w.get(x, y - 2, z))) {
      yield [x, y - 1, z, 0.5 + f * u, { type: 'digDown', breaks: [[x, y - 1, z]], place: false }];
    }
  }
}

function octileHeuristic(x, y, z, g) {
  const dx = Math.abs(x - g.x), dz = Math.abs(z - g.z);
  const octile = Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
  if (g.y <= y) return octile + (y - g.y) * 0.3; // down: a drop's 0.3 a block
  // Up: every block up is a step-up's 0.8 at least, and each one more than there is ground to walk
  // while climbing is a move straight up (a ladder, a pillar: 1.8 or more), so a full block extra.
  // (It never overestimates. At 0.3 a block up, a 25-high climb searched 52,000 nodes before building.)
  const up = g.y - y;
  return octile + up * 0.8 + Math.max(0, up - octile);
}

/**
 * Incremental A*. It's a generator so the game can spread it across ticks
 * (system.runJob). Yields every `yieldEvery` expansions; the return value is the result.
 *
 * opts:
 *   tolerance   finish when within this 3D distance of goal (default 0 = exact block)
 *   maxNodes    expansion budget; if exhausted we return the best partial path
 *   weight      >1 makes it greedier/faster, slightly less optimal
 *
 * result: { path: [{x,y,z}], complete, expanded, cost } (cost in walking-block units, like every move)
 */
export function* searchJob(classify, start, goal, opts = {}) {
  const {
    tolerance = 0,
    maxNodes = 20000,
    weight = 1.15,
    yieldEvery = 400,
    costs = DEFAULT_COSTS,
    goalTest = null,   // optional (x, y, z, worldView) => bool: search for the nearest cell that passes (Dijkstra)
    actions = null,    // optional: allow digging and pillaring (see actionNeighbors)
    heuristicFn = null, // optional (x, y, z) => estimated remaining cost (goalTest searches)
    wetPartial = false, // a partial path may end out in the water (crossing to land further than one search reaches)
    probeAt = 1000,     // after this many nodes without reaching it, check the goal isn't sealed off (0: never)
  } = opts;
  const w = new WorldView(classify, start);
  if (actions) {
    const bc = new Map();
    w.breakCost = (x, y, z) => {
      const k = w.k(x, y, z);
      let c = bc.get(k);
      if (c === undefined) { c = actions.breakCost(x, y, z); bc.set(k, c); }
      return c;
    };
  }
  const s = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  // Standing on a slab or a stair's low half: our feet are inside its cell; the search's node is
  // the cell above it (what we stand on is the STEP).
  if (isHalf(w.get(s.x, s.y, s.z)) && w.open(s.x, s.y + 1, s.z)) s.y++;
  const g = { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) };
  const key = (x, y, z) => w.k(x, y, z);
  const heuristic = heuristicFn ?? (goalTest ? () => 0 : octileHeuristic);

  const open = new MinHeap();
  const nodes = new Map();
  const h0 = heuristic(s.x, s.y, s.z, g);
  const startNode = { x: s.x, y: s.y, z: s.z, g: 0, h: h0, f: h0 * weight, parent: null, closed: false, move: null, placed: 0 };
  nodes.set(key(s.x, s.y, s.z), startNode);
  open.push(startNode);

  let best = startNode;
  let expanded = 0;

  while (open.size) {
    const cur = open.pop();
    if (cur.closed) continue;
    cur.closed = true;
    const done = goalTest ? goalTest(cur.x, cur.y, cur.z, w) : Math.hypot(cur.x - g.x, cur.y - g.y, cur.z - g.z) <= tolerance;
    if (done) return { path: rebuild(cur), complete: true, expanded, cost: cur.g };
    // Partial results must end on dry land: stopping mid-lake is worse than stopping short.
    if (cur.h < best.h && (wetPartial || (!w.swimmable(cur.x, cur.y, cur.z) && !w.submerged(cur.x, cur.y, cur.z)))) best = cur;

    if (++expanded >= maxNodes) break;
    // Taking a while: is the goal somewhere we can't get to at all (an item behind a wall, a cow
    // in a pen, ore inside the rock)? Then say so now, instead of searching the whole budget first
    // (8,000-30,000 nodes and tens of thousands of block reads for a "no").
    if (expanded === probeAt && !goalTest && !actions && sealedOff(w, g, tolerance, s)) {
      return { path: rebuild(best), complete: false, expanded, cost: best.g, unreachable: true };
    }
    // Standing on a block the plan put down (pillar, bridge): the world view doesn't have it, so
    // lay it in while we look at this node (walking on from a bridge needs ground under it).
    const pk = cur.move?.place ? key(cur.x, cur.y - 1, cur.z) : null;
    const saved = pk ? w.cache.get(pk) : undefined;
    if (pk) w.cache.set(pk, Cell.SOLID);

    const restore = () => { if (pk) { if (saved === undefined) w.cache.delete(pk); else w.cache.set(pk, saved); } };

    const moves = actions
      ? [...neighbors(w, cur.x, cur.y, cur.z, costs), ...actionNeighbors(w, cur.x, cur.y, cur.z, actions, cur.placed, cur.move?.place ? cur.move : false)]
      : [...neighbors(w, cur.x, cur.y, cur.z, costs)];
    restore();
    if (expanded % yieldEvery === 0) yield; // hand control back to the game (system.runJob)
    for (const [nx, ny, nz, c, move = null] of moves) {
      const k = key(nx, ny, nz);
      const ng = cur.g + c;
      let n = nodes.get(k);
      if (n && (n.closed || ng >= n.g)) continue;
      if (!n) {
        const h = heuristic(nx, ny, nz, g);
        n = { x: nx, y: ny, z: nz, g: ng, h, f: 0, parent: cur, closed: false, move: null, placed: 0 };
        nodes.set(k, n);
      }
      n.g = ng;
      n.parent = cur;
      n.move = move;
      n.placed = cur.placed + (move?.place ? 1 : 0);
      n.f = ng + n.h * weight;
      open.push(n); // lazy decrease-key: stale entries are skipped via `closed`
    }
  }
  return { path: rebuild(best), complete: false, expanded, cost: best.g };
}

/**
 * Is the goal (every cell we could finish on, within `tolerance`) in a pocket the start isn't in?
 * A flood fill out from the goal over a looser set of moves than the search's own (any occupiable
 * cell next door or two along, up to 3 up or down, either way), so if even that can't get out of
 * the pocket in `limit` cells, no real route gets in. Too big to tell (or it reaches the start):
 * false, and the search carries on as usual.
 */
export function sealedOff(w, g, tolerance, s, limit = 400) {
  const r = Math.min(3, Math.ceil(tolerance));
  const seen = new Set(), queue = [];
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) {
    const x = g.x + dx, y = g.y + dy, z = g.z + dz;
    if (Math.hypot(dx, dy, dz) > tolerance + 1e-9) continue;
    if (!w.occupiable(x, y, z)) continue;
    const k = w.k(x, y, z);
    if (!seen.has(k)) { seen.add(k); queue.push([x, y, z]); }
  }
  // Nowhere to stand right there (a point in mid-air, a far travel target, an unloaded chunk):
  // can't tell. The search's partial path toward it is what the caller is after.
  if (!queue.length) return false;
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [-3, 0], [0, 3], [0, -3], [4, 0], [-4, 0], [0, 4], [0, -4], [0, 0]];
  for (let i = 0; i < queue.length; i++) {
    const [x, y, z] = queue[i];
    if (x === s.x && y === s.y && z === s.z) return false;
    for (const [dx, dz] of steps) {
      // Two to four along is a leap over a gap: only through an open gap, never through a wall.
      const far = Math.max(Math.abs(dx), Math.abs(dz));
      if (far >= 2) {
        const ux = Math.sign(dx), uz = Math.sign(dz);
        let clear = true;
        for (let k = 1; k < far && clear; k++) clear = w.open(x + ux * k, y, z + uz * k) && w.open(x + ux * k, y + 1, z + uz * k);
        if (!clear) continue;
      }
      for (let dy = -3; dy <= 3; dy++) {
        if (!dx && !dz && !dy) continue;
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const k = w.k(nx, ny, nz);
        if (seen.has(k) || !w.occupiable(nx, ny, nz)) continue;
        seen.add(k);
        queue.push([nx, ny, nz]);
        if (queue.length > limit) return false;
      }
    }
  }
  return true;
}

function rebuild(n) {
  const out = [];
  for (; n; n = n.parent) out.push(n.move ? { x: n.x, y: n.y, z: n.z, move: n.move } : { x: n.x, y: n.y, z: n.z });
  return out.reverse();
}

/** Run the search to completion synchronously (tests, short paths). */
export function findPath(classify, start, goal, opts) {
  const it = searchJob(classify, start, goal, opts);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/**
 * String pulling: collapse runs of block-to-block steps into straight segments,
 * as long as a player-width body can walk the straight line on the same Y level.
 * Height changes always keep their waypoints (they need a jump or a drop).
 * Output waypoints are block-centre floats.
 */
export function smoothPath(classify, path, halfWidth = 0.3) {
  if (path.length <= 2) return path.map(center);
  const w = new WorldView(classify, path[0]);
  const out = [center(path[0])];
  let i = 0;
  while (i < path.length - 1) {
    let j = i + 1;
    // Extend j as far as a straight walk from i stays legal.
    for (let k = path.length - 1; k > i + 1; k--) {
      if (sameLevelRun(path, i, k) && walkableLine(w, center(path[i]), center(path[k]), halfWidth)) {
        j = k;
        break;
      }
    }
    out.push(center(path[j]));
    i = j;
  }
  // Tight waypoints, which the motor steers at exactly instead of cutting the corner past them:
  //  - beside a drop we wouldn't walk away from (deeper than a safe fall, or into lava);
  //  - a corner that can't be cut: the straight line on from where the motor would start turning
  //    (0.7 short of it) clips something the line from the waypoint itself clears (round a trunk,
  //    a bush), and cutting it pinned the body against that.
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c.leap) continue;
    if (besideDrop(w, Math.floor(c.x), c.y, Math.floor(c.z))) { c.tight = true; continue; }
    const a = out[k - 1], b = out[k + 1];
    if (!a || !b || a.y !== c.y || b.y !== c.y) continue;
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    if (len < 1e-6) continue;
    const s = Math.min(0.7, len) / len;
    const early = { x: c.x - (c.x - a.x) * s, y: c.y, z: c.z - (c.z - a.z) * s };
    if (!walkableLine(w, early, b, halfWidth)) c.tight = true;
  }
  return out;
}

/** An open neighbour column (any of 8) with no ground within a safe fall below it. */
function besideDrop(w, x, y, z) {
  for (const [dx, dz] of DIRS) {
    const nx = x + dx, nz = z + dz;
    if (!w.open(nx, y, nz)) continue;
    let safe = false;
    for (let d = 1; d <= DEFAULT_COSTS.maxDrop + 1; d++) {
      const c = w.get(nx, y - d, nz);
      if (c === Cell.DANGER) break;
      if (c !== Cell.AIR && c !== Cell.CLIMB) { safe = c !== Cell.UNKNOWN; break; }
    }
    if (!safe) return true;
  }
  return false;
}

function center(p) {
  const c = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
  if (p.move?.type === 'leap') c.leap = p.move.gap ?? 1; // the motor runs (sprints, past 1) and jumps for this one
  if (p.move?.type === 'stair') c.stair = true; // the motor walks up this one, no jump
  if (p.move?.type === 'dive') c.dive = true; // under water: the motor doesn't swim up for air on the way to it
  return c;
}

/** A path step the motor walks (plain moves and gap leaps), as opposed to one that digs or builds. */
export const isWalkMove = (p) => !p.move || ['leap', 'stair', 'bucketDrop', 'dive'].includes(p.move.type);

function sameLevelRun(path, i, k) {
  for (let m = i + 1; m <= k; m++) if (path[m].y !== path[i].y) return false;
  return true;
}

function walkableLine(w, a, b, hw) {
  const swim = w.swimmable(Math.floor(a.x), a.y, Math.floor(a.z)) && w.swimmable(Math.floor(b.x), b.y, Math.floor(b.z));
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(len / 0.2));
  const offsets = [[0, 0], [hw, hw], [hw, -hw], [-hw, hw], [-hw, -hw]];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    for (const [ox, oz] of offsets) {
      const bx = Math.floor(x + ox), bz = Math.floor(z + oz);
      // Straight lines only over one kind of surface: all land or all water.
      if (!(w.standable(bx, a.y, bz) || (swim && w.swimmable(bx, a.y, bz)))) return false;
      if (!swim && w.swimmable(bx, a.y, bz)) return false;
    }
  }
  return true;
}
