// Head-to-head test arenas (game/arena.js builds and runs them): the pure part. Seeded layouts that
// are the same every time, and fair by construction: the forest is point-symmetric (turn it half a
// round and it is itself), every other course is built twice from one plan, side by side.
//
// Coordinates here are local to the thing being built: x/z from its west-north corner, y from the
// top of its floor (the floor's top block is y 0; the first block you stand IN is y 1).

/** A small seeded generator (mulberry32): same seed, same arena. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

/**
 * The log race: a square forest. Trees are put down in pairs, each with its twin on the opposite
 * side of the centre, so both corners (the starts) see exactly the same forest.
 * @returns {{ size: number, starts: Array<{x:number,z:number}>, trees: Array<{x:number,z:number,h:number}> }}
 */
export function forestPlan({ size = 36, seed = 11, want = 70, clear = 5, minGap = 3 } = {}) {
  const r = rng(seed);
  const last = size - 1;
  const starts = [{ x: 3, z: 3 }, { x: last - 3, z: last - 3 }];
  const twin = (p) => ({ x: last - p.x, z: last - p.z });
  const trees = [];
  for (let tries = 0; trees.length < want && tries < 6000; tries++) {
    const p = { x: 2 + Math.floor(r() * (size - 4)), z: 2 + Math.floor(r() * (size - 4)) };
    const q = twin(p);
    if (cheb(p, q) < minGap) continue; // (a tree at the centre would be its own twin)
    if (starts.some((s) => cheb(p, s) < clear || cheb(q, s) < clear)) continue;
    if (trees.some((t) => cheb(p, t) < minGap || cheb(q, t) < minGap)) continue;
    const h = 4 + Math.floor(r() * 3);
    trees.push({ ...p, h }, { ...q, h });
  }
  return { size, starts, trees };
}

/** The blocks of one oak as fills: leaves first (they never replace anything), then the trunk. */
export function treeFills(t, base = 0) {
  const { x, z, h } = t;
  return [
    { kind: 'leaves', box: [x - 2, base + h - 1, z - 2, x + 2, base + h, z + 2] },
    { kind: 'leaves', box: [x - 1, base + h + 1, z - 1, x + 1, base + h + 1, z + 1] },
    { kind: 'leaves', box: [x, base + h + 2, z, x, base + h + 2, z] },
    { kind: 'leaves', box: [x - 1, base + h + 2, z, x + 1, base + h + 2, z] },
    { kind: 'leaves', box: [x, base + h + 2, z - 1, x, base + h + 2, z + 1] },
    { kind: 'log', box: [x, base + 1, z, x, base + h, z] },
  ];
}

/** Points an ore is worth in the underwater mining race. */
export const ORE_POINTS = { coal_ore: 1, iron_ore: 2, gold_ore: 3, lapis_ore: 3, diamond_ore: 5 };

/**
 * Ore for a flooded tank's floor: two layers (what shows, and what mining the first one uncovers), the
 * same cells for both lanes. `size` x `size` columns; returns [{ x, z, layer: 0|1, kind }], layer 0 = top.
 */
export function oreLayout({ size = 14, seed = 5, top = { coal_ore: 16, iron_ore: 9, gold_ore: 5, lapis_ore: 4, diamond_ore: 3 }, hidden = { coal_ore: 12, iron_ore: 8, gold_ore: 5, diamond_ore: 4 }, keepOut = [] } = {}) {
  const r = rng(seed);
  const out = [];
  for (const [layer, counts] of [[0, top], [1, hidden]]) {
    const used = new Set();
    // The kinds worth most are put down first, so a crowded layer loses coal, not diamonds.
    for (const [kind, n] of Object.entries(counts).sort((a, b) => (ORE_POINTS[b[0]] ?? 0) - (ORE_POINTS[a[0]] ?? 0))) {
      for (let k = 0, tries = 0; k < n && tries < 2000; tries++) {
        const x = Math.floor(r() * size), z = Math.floor(r() * size);
        const key = `${x},${z}`;
        if (used.has(key) || keepOut.some((c) => c.x === x && c.z === z)) continue;
        used.add(key);
        out.push({ x, z, layer, kind });
        k++;
      }
    }
  }
  return out;
}

/**
 * The parkour course, one lane (the arena builds it twice side by side). Rows run along z from the start;
 * x is across (0..width-1). `h` of a row is the height of its top block above the start's floor.
 *
 *   start pad, a hill climbed in 1-high steps, a 7-high stone wall to be climbed by its vines, the top,
 *   a stepped descent (drops of 1-3), a dense tree field with husks about, two cave holes (a trench
 *   5 deep with a ramp out, zombies in it, a way round beside it), a lava pit crossed by two islands
 *   (two lava blocks between each stretch), and the gold pad.
 * @returns {{ W:number, L:number, h:number[], seg:Record<string,{z0:number,z1:number}>, vines:{z:number,xs:number[],y0:number,y1:number,bits:number},
 *   wall:{z0:number,z1:number,top:number}, trees:Array<{x:number,z:number,h:number}>, holes:Array<{x0:number,x1:number,z0:number,z1:number,depth:number[]}>,
 *   lava:{z0:number,z1:number,islands:Array<{x0:number,x1:number,z0:number,z1:number}>}, mobs:Array<{kind:string,x:number,z:number,h:number}>,
 *   route:Array<{x:number,z:number,h:number,tol:number}>, finishZ:number }}
 */
export function parkourPlan({ seed = 7, width = 9 } = {}) {
  const r = rng(seed);
  const W = width;
  const h = [];
  /** @type {Record<string,{z0:number,z1:number}>} */
  const seg = {};
  const add = (name, n, height) => { const z0 = h.length; for (let i = 0; i < n; i++) h.push(typeof height === 'function' ? height(i) : height); seg[name] = { z0, z1: h.length - 1 }; return seg[name]; };
  add('start', 5, 0);
  // The hill: nine steps of two rows.
  add('ascent', 18, (i) => 1 + Math.floor(i / 2));
  add('plateau', 2, 9);
  const wall = { ...add('wall', 3, 16), top: 16 };
  const vines = { z: seg.plateau.z1, xs: [3, 4, 5].map((x) => x + Math.floor((W - 9) / 2)), y0: 10, y1: 16, bits: 1 };
  add('top', 6, 16);
  // Down again: drops of 1 to 3, one or two rows between them.
  {
    const z0 = h.length;
    let cur = 16;
    while (cur > 0) {
      cur -= Math.min(cur, 1 + Math.floor(r() * 3));
      const n = 1 + Math.floor(r() * 2);
      for (let i = 0; i < n; i++) h.push(cur);
    }
    seg.descent = { z0, z1: h.length - 1 };
  }
  add('flat1', 2, 0);
  const tf = add('trees', 20, 0);
  add('flat2', 3, 0);
  // Trees, no two touching (so there is always a way between them), and husks among them.
  const trees = [];
  for (let tries = 0; trees.length < 22 && tries < 4000; tries++) {
    const x = 1 + Math.floor(r() * (W - 2)), z = tf.z0 + Math.floor(r() * (tf.z1 - tf.z0 + 1));
    if (trees.some((q) => cheb({ x, z }, q) < 2)) continue;
    trees.push({ x, z, h: 4 + Math.floor(r() * 3) });
  }
  const holes = [];
  const holeA = add('holeA', 7, 0), mid = add('mid', 1, 0), holeB = add('holeB', 7, 0);
  const depth = [5, 5, 4, 3, 2, 1, 0];
  holes.push({ x0: 1, x1: 3, z0: holeA.z0, z1: holeA.z1, depth }, { x0: W - 4, x1: W - 2, z0: holeB.z0, z1: holeB.z1, depth });
  add('flat3', 2, 0);
  const lz = add('lava', 10, 0);
  const lava = { ...lz, islands: [{ x0: 2, x1: W - 3, z0: lz.z0 + 2, z1: lz.z0 + 3 }, { x0: 2, x1: W - 3, z0: lz.z0 + 6, z1: lz.z0 + 7 }] };
  const fin = add('finish', 4, 0);
  // Who is about: husks in the open, zombies down the holes.
  const mobs = [];
  const free = trees.length ? Array.from({ length: (tf.z1 - tf.z0 + 1) * W }, (_, i) => ({ x: i % W, z: tf.z0 + Math.floor(i / W) })).filter((c) => !trees.some((q) => cheb(c, q) < 2)) : [];
  for (let k = 0; k < 4 && free.length; k++) { const c = free.splice(Math.floor(r() * free.length), 1)[0]; mobs.push({ kind: 'husk', x: c.x, z: c.z, h: 0 }); }
  for (const hl of holes) for (let k = 0; k < 2; k++) mobs.push({ kind: 'zombie', x: hl.x0 + 1, z: hl.z0 + 1 + k * 2, h: -hl.depth[1 + k * 2] });
  const mx = Math.floor(W / 2);
  const route = [
    { x: mx, z: seg.plateau.z1, h: 9, tol: 1.2 },                      // the foot of the vines
    { x: mx, z: wall.z0 + 1, h: 16, tol: 1.2 },                         // the top of the wall
    { x: mx, z: seg.top.z1, h: 16, tol: 1.5 },
    { x: mx, z: seg.descent.z1, h: 0, tol: 1.5 },                       // the bottom of the hill
    { x: mx, z: tf.z1 + 2, h: 0, tol: 2 },                              // through the trees
    { x: W - 3, z: holeA.z0 + 3, h: 0, tol: 1.5 },                      // round the first hole (hole A is on the left)
    { x: W - 3, z: mid.z0, h: 0, tol: 1.5 },
    { x: 2, z: holeB.z0 + 3, h: 0, tol: 1.5 },                          // and the second (on the right)
    { x: mx, z: seg.flat3.z1, h: 0, tol: 1.2 },
    { x: mx, z: lava.islands[0].z0, h: 0, tol: 1.1 },                   // across the lava, island to island
    { x: mx, z: lava.islands[1].z0, h: 0, tol: 1.1 },
    { x: mx, z: fin.z0 + 1, h: 0, tol: 1.1 },
  ];
  return { W, L: h.length, h, seg, vines, wall, trees, holes, lava, mobs, route, finishZ: fin.z0 };
}

/**
 * The boat course: a winding canal (three long legs side by side joined by turning basins), posts to
 * steer round, a gate at the start and a gold line to finish on. Local x/z from the west-north corner of
 * the box; the water is `depth` blocks over the floor.
 * @returns {{ w:number, d:number, depth:number, cw:number, rects:Array<{name:string,x0:number,x1:number,z0:number,z1:number}>,
 *   posts:Array<{x:number,z:number}>, gateZ:number, start:{x:number,z:number}, tow:{x:number,z:number}, finish:{x0:number,x1:number,z0:number,z1:number},
 *   watch:{x:number,z:number}, route:Array<{x:number,z:number}> }}
 */
export function boatPlan({ legLen = 61, cw = 5 } = {}) {
  const sep = 3;
  const x0 = (leg) => 1 + leg * (cw + sep);
  const zEnd = legLen; // the last water row of the legs
  const rects = [
    { name: 'leg1', x0: x0(0), x1: x0(0) + cw - 1, z0: 1, z1: zEnd },
    { name: 'leg2', x0: x0(1), x1: x0(1) + cw - 1, z0: 1, z1: zEnd },
    { name: 'leg3', x0: x0(2), x1: x0(2) + cw - 1, z0: 1, z1: zEnd },
    { name: 'far', x0: x0(0), x1: x0(1) + cw - 1, z0: zEnd - cw + 1, z1: zEnd },   // joins legs 1 and 2 at the far end
    { name: 'near', x0: x0(1), x1: x0(2) + cw - 1, z0: 1, z1: cw },                // joins legs 2 and 3 at the near end
  ];
  const l = [0, 1, 2].map((i) => x0(i));
  // Posts to go round: each leaves three clear columns of the five.
  const posts = [
    { x: l[0] + 1, z: 26 }, { x: l[0] + 3, z: 42 },
    { x: l[1] + 3, z: 46 }, { x: l[1] + 1, z: 34 }, { x: l[1] + 3, z: 18 },
    { x: l[2] + 1, z: 18 }, { x: l[2] + 3, z: 33 }, { x: l[2] + 1, z: 44 },
  ];
  const finish = { x0: l[2], x1: l[2] + cw - 1, z0: 52, z1: zEnd };
  const mid = (i) => l[i] + Math.floor(cw / 2);
  return {
    w: l[2] + cw + 1, d: zEnd + 2, depth: 2, cw, rects, posts, gateZ: 10,
    start: { x: mid(0), z: 7 }, tow: { x: mid(0), z: 3 }, finish,
    watch: { x: l[2] - 2, z: 57 }, // on the wall beside the gold, where the bot stands
    route: [{ x: mid(0), z: 40 }, { x: mid(0), z: zEnd - 2 }, { x: mid(1), z: zEnd - 2 }, { x: mid(1), z: 3 }, { x: mid(2), z: 3 }, { x: mid(2), z: finish.z0 + 2 }],
  };
}

/**
 * The line a boat takes round the canal (cell coordinates; the middle of cell x is x + 0.5): down the middle of
 * each leg, swung to the free side of every post, round the basins in half ellipses. `slow` marks the bends.
 * A boat is 1.4 across, so every point is checked to have room (see tests).
 * @returns {Array<{x:number,z:number,slow?:boolean}>}
 */
export function boatDrive(plan = boatPlan()) {
  const cw = plan.cw;
  const legs = plan.rects.filter((r) => /^leg/.test(r.name));
  const mid = legs.map((r) => r.x0 + cw / 2);
  /** @type {Array<{x:number,z:number,slow?:boolean}>} */
  const pts = [];
  const leg = (i, from, to) => {
    const r = legs[i], dir = Math.sign(to - from);
    const ps = plan.posts.filter((o) => o.x >= r.x0 && o.x <= r.x1).sort((a, b) => dir * (a.z - b.z));
    pts.push({ x: mid[i], z: from });
    for (const q of ps) {
      const x = mid[i] + (q.x + 0.5 < mid[i] ? 1.4 : -1.4); // the free side of the post
      pts.push({ x, z: q.z - dir * 4.5 }, { x, z: q.z + dir * 4.5 });
    }
    pts.push({ x: mid[i], z: to });
  };
  const half = (cx, cz, a, b, dz, n) => { const o = []; for (let k = 1; k < n; k++) { const th = Math.PI - Math.PI * k / n; o.push({ x: cx + a * Math.cos(th), z: cz + dz * b * Math.sin(th), slow: true }); } return o; };
  const zT = plan.rects[0].z1;                                  // far end of the legs
  const zFar = zT - 9, zNear = 1 + 6;                           // where the turns begin
  leg(0, plan.start.z + 0.5, zFar);
  pts.push(...half((mid[0] + mid[1]) / 2, zFar + 2.8, (mid[1] - mid[0]) / 2, 3.4, 1, 10));
  leg(1, zFar, zNear);
  pts.push(...half((mid[1] + mid[2]) / 2, zNear - 0.4, (mid[2] - mid[1]) / 2, 3.4, -1, 10));
  leg(2, zNear, plan.finish.z0 + 5);
  return pts.map((p) => ({ x: +p.x.toFixed(2), z: +p.z.toFixed(2), ...(p.slow ? { slow: true } : {}) }));
}

/** Which of `entries` ({ name, value, ... }) is ahead: highest value ('high') or lowest ('low'; null = never finished = last). */
export function rank(entries, better = 'high') {
  const v = (e) => (e.value === null || e.value === undefined || Number.isNaN(e.value) ? (better === 'high' ? -Infinity : Infinity) : e.value);
  return [...entries].sort((a, b) => (better === 'high' ? v(b) - v(a) : v(a) - v(b)));
}

/** Winner's name, or null on a tie (or when nobody scored). */
export function winnerOf(entries, better = 'high') {
  const r = rank(entries, better);
  if (r.length < 2) return r[0] && Number.isFinite(r[0].value) ? r[0].name : null;
  const a = r[0].value, b = r[1].value;
  const bad = (x) => x === null || x === undefined || Number.isNaN(x) || (better === 'high' ? x <= 0 : false);
  if (bad(a)) return null;
  return a === b ? null : r[0].name;
}

/** "1:05.3" from a number of ticks. */
export function clock(ticks) {
  const s = Math.max(0, ticks) / 20;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

/** Seconds left as "1:34" (rounded up), for the action bar. */
export function clockLeft(ticks) {
  const s = Math.max(0, Math.ceil(ticks / 20));
  return `${Math.floor(s / 60)}:${s % 60 < 10 ? '0' : ''}${s % 60}`;
}

/** Every arena the commands know, with a one-line description. */
export const ARENA_INFO = {
  forest: 'Log race: an artificial forest, an iron axe, one minute each (the bot, then you, never together); most logs wins',
  golem: 'Iron golem duel: sword, spear and blocks; a pen each, fastest kill wins',
  ender: 'Enderman duel: sword, spear and blocks; a pen each, fastest kill wins',
  dive: 'Underwater mining: a flooded tank each, aqua affinity, drowned about; most ore wins',
  parkour: 'Parkour: hills, vines, dense trees, cave holes, lava pits and zombies; first to the gold wins',
  boat: 'Boat race: a canal each with posts to steer round, towing the villagers\' boat on a lead; first on the gold with both boats wins',
};
export const ARENA_NAMES = Object.keys(ARENA_INFO);
