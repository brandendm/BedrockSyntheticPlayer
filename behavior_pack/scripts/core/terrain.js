// Harsh surface terrain courses (u292): dense forest, jungle, swamp, a labyrinth, a lava field, an ambush across open ground, a siege, a mine with plugs. Each has a goal
// (or a time to survive), hostile mobs, and in some a distraction (bait the bot should not stop for). Pure, seeded, and solvable by construction: the generator
// keeps a clean route (checked by `routeExists`, a 4-neighbour search over the block grid with the obstacles that cannot be walked through blocked).
// Coordinates relative to the site; y 0 = the slab's grass layer, feet on the surface at y 1. x runs east (the goal end), z across, -R..R.
import { makeRng } from './mathutil.js';
import { CAVE_EXT } from './caves.js';

export const TERRAIN_KINDS = ['thicket', 'jungle', 'swamp', 'ambush', 'siege', 'mobmaze', 'minecollapse', 'lavafield', 'raid', 'chasm'];
export const TERRAIN_EXT = { ...CAVE_EXT };
const R = 12;                        // half-width of the field
const OBSTACLES = new Set(['trunk', 'bush', 'lava', 'wall']);

/** Is there a walkable 4-neighbour route from (x0,z0) to (x1,z1) over `grid` (Map "x,z" -> cell type)? Cells not in the map are open. */
export function routeExists(grid, x0, z0, x1, z1, W, blocked = OBSTACLES) {
  const key = (x, z) => `${x},${z}`;
  const seen = new Set([key(x0, z0)]);
  const q = [[x0, z0]];
  while (q.length) {
    const [x, z] = q.pop();
    if (x === x1 && z === z1) return true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nx >= W || nz < -R || nz > R || seen.has(key(nx, nz))) continue;
      if (blocked.has(grid.get(key(nx, nz)))) continue;
      seen.add(key(nx, nz)); q.push([nx, nz]);
    }
  }
  return false;
}

/** Row-run merge: cells of one type in a row become one fill box. */
function runs(grid, W, type) {
  const out = [];
  for (let z = -R; z <= R; z++) {
    let s = null;
    for (let x = 0; x <= W; x++) {
      const on = x < W && grid.get(`${x},${z}`) === type;
      if (on && s === null) s = x;
      if (!on && s !== null) { out.push({ x1: s, x2: x - 1, z }); s = null; }
    }
  }
  return out;
}

export function terrainCourse(kind, seed = 1, level = 1) {
  if (!TERRAIN_KINDS.includes(kind)) throw new Error(`no terrain course ${kind}`);
  const rng = makeRng(Math.floor(seed) * 6151 + level * 99991 + kind.length * 17);
  const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const box = (x1, y1, z1, x2, y2, z2, block) => ({ x1: Math.min(x1, x2), y1: Math.min(y1, y2), z1: Math.min(z1, z2), x2: Math.max(x1, x2), y2: Math.max(y1, y2), z2: Math.max(z1, z2), block });
  const W = 40 + 4 * level;
  const cmds = [box(-3, 1, -R - 2, W + 3, 9, R + 2, 'air')];     // clear the air above the slab first
  const mobs = [], waves = [], bait = [];
  const kit = [['stone_sword', 1], ['stone_pickaxe', 1], ['bread', 8], ['cobblestone', 24], ['bow', 1], ['arrow', 24]];
  let start = { x: 1, y: 1, z: 0 }, goal = { x: W - 3, y: 1, z: ri(-6, 6) }, survive = null, text = '';
  const grid = new Map();
  const free = (x, z) => !grid.has(`${x},${z}`);
  const reserve = (x, z) => x < 6 || x > W - 6 || (Math.abs(z - goal.z) <= 2 && x > W - 8);     // start and goal areas stay open
  const place = (x, z, t) => { if (!reserve(x, z) && free(x, z)) grid.set(`${x},${z}`, t); };
  const mobSpots = (n, minX) => { const out = []; for (let i = 0; i < n * 20 && out.length < n; i++) { const x = ri(minX, W - 8), z = ri(-R + 1, R - 1); if (free(x, z) && !out.some((o) => Math.hypot(o.x - x, o.z - z) < 4)) out.push({ x, z }); } return out; };

  if (kind === 'thicket' || kind === 'jungle') {
    const jungle = kind === 'jungle';
    const log = jungle ? 'jungle_log' : 'oak_log', leaves = jungle ? 'jungle_leaves' : 'oak_leaves';
    for (let attempt = 0; attempt < 30; attempt++) {
      grid.clear();
      const dens = 0.07 + 0.025 * level, bushes = 0.10 + 0.04 * level;
      for (let x = 0; x < W; x++) for (let z = -R; z <= R; z++) { const r = rng(); if (r < dens) place(x, z, 'trunk'); else if (r < dens + bushes) place(x, z, 'bush'); else if (jungle && r < dens + bushes + 0.06) place(x, z, 'web'); }
      if (routeExists(grid, start.x, start.z, goal.x, goal.z, W)) break;
      if (attempt === 29) for (let x = 0; x < W; x++) for (let z = -1; z <= 1; z++) grid.delete(`${x},${z + (x < W / 2 ? 0 : goal.z)}`);
    }
    for (const r of runs(grid, W, 'bush')) cmds.push(box(r.x1, 1, r.z, r.x2, 2, r.z, leaves));
    for (const r of runs(grid, W, 'web')) cmds.push(box(r.x1, 1, r.z, r.x2, 1, r.z, 'web'));
    for (const [k, v] of grid) if (v === 'trunk') { const [x, z] = k.split(',').map(Number); cmds.push(box(x, 1, z, x, 4, z, log), box(x - 1, 5, z - 1, x + 1, 6, z + 1, leaves)); }
    const types = jungle ? ['spider', 'zombie', 'skeleton', 'cave_spider', 'zombie'] : ['zombie', 'skeleton', 'zombie', 'spider', 'creeper'];
    mobSpots(2 + 2 * level, 10).forEach((p, i) => mobs.push({ type: types[i % types.length], x: p.x, y: 1, z: p.z }));
    text = `A ${jungle ? 'jungle' : 'dense forest'} ${W} blocks across: trunks every few blocks, bushes, ${jungle ? 'cobwebs, ' : ''}and hostile mobs in it. Get to the gold block at the far end alive.`;
  } else if (kind === 'swamp') {
    for (let attempt = 0; attempt < 30; attempt++) {
      grid.clear();
      for (let x = 0; x < W; x++) for (let z = -R; z <= R; z++) { const r = rng(); if (r < 0.05 + 0.02 * level) place(x, z, 'trunk'); else if (r < 0.38 + 0.06 * level) place(x, z, 'water'); }
      if (routeExists(grid, start.x, start.z, goal.x, goal.z, W)) break;
    }
    for (const r of runs(grid, W, 'water')) cmds.push(box(r.x1, 0, r.z, r.x2, 0, r.z, 'water'));
    for (const [k, v] of grid) if (v === 'trunk') { const [x, z] = k.split(',').map(Number); cmds.push(box(x, 1, z, x, 4, z, 'mangrove_log'), box(x - 1, 5, z - 1, x + 1, 6, z + 1, 'mangrove_leaves')); }
    const wet = [...grid].filter(([, v]) => v === 'water').map(([k]) => k.split(',').map(Number)).filter(([x]) => x > 10);
    for (let i = 0; i < 1 + level && wet.length; i++) { const [x, z] = wet[Math.floor(rng() * wet.length)]; mobs.push({ type: 'drowned', x, y: 0, z }); }
    mobSpots(1 + level, 12).forEach((p, i) => mobs.push({ type: i === 2 ? 'witch' : 'zombie', x: p.x, y: 1, z: p.z }));
    text = 'A swamp: pools to wade through, drowned in the water, zombies on the banks. Get to the gold block.';
  } else if (kind === 'lavafield') {
    // lava pools with a guaranteed stone path; zombies knock you about, so the edge matters
    for (let attempt = 0; attempt < 40; attempt++) {
      grid.clear();
      for (let x = 0; x < W; x++) for (let z = -R; z <= R; z++) if (rng() < 0.22 + 0.06 * level) place(x, z, 'lava');
      if (routeExists(grid, start.x, start.z, goal.x, goal.z, W)) break;
      if (attempt === 39) for (let x = 0; x < W; x++) grid.delete(`${x},${goal.z}`);
    }
    for (const r of runs(grid, W, 'lava')) cmds.push(box(r.x1, 0, r.z, r.x2, 0, r.z, 'lava'));
    kit.push(['water_bucket', 1]);
    mobSpots(2 + level, 12).forEach((p, i) => mobs.push({ type: i % 3 === 2 ? 'skeleton' : 'zombie', x: p.x, y: 1, z: p.z }));
    text = 'A field of lava pools with ground between them, zombies and a skeleton about. Get to the gold block without burning.';
  } else if (kind === 'ambush') {
    for (let x = 0; x < W; x++) for (let z = -R; z <= R; z++) if (rng() < 0.03) place(x, z, 'trunk');
    for (const [k] of grid) { const [x, z] = k.split(',').map(Number); cmds.push(box(x, 1, z, x, 4, z, 'oak_log'), box(x - 1, 5, z - 1, x + 1, 6, z + 1, 'oak_leaves')); }
    // waves: when the bot passes atX, mobs appear ahead and to the sides; bait: cows and dropped items that are not the goal
    const n = 2 + level;
    for (let i = 1; i <= n; i++) {
      const atX = Math.round((W - 8) * i / (n + 1));
      waves.push({ atX, mobs: Array.from({ length: 1 + level }, (_, j) => ({ type: ['zombie', 'skeleton', 'zombie', 'creeper'][(i + j) % 4], x: atX + ri(6, 10), z: ri(-8, 8) })) });
    }
    for (let i = 0; i < 4 + level; i++) bait.push({ type: i % 2 ? 'cow' : 'sheep', x: ri(8, W - 8), z: ri(-10, 10) });
    text = 'Open ground with a few trees. Mobs appear ahead in waves as you go, and cows and sheep stand about to tempt you. Reach the gold block; do not stop for the animals.';
  } else if (kind === 'siege') {
    const hx = 12, half = 3;
    cmds.push(box(hx - half - 1, 1, -half - 1, hx + half + 1, 4, half + 1, 'cobblestone'), box(hx - half, 1, -half, hx + half, 3, half, 'air'));
    cmds.push(box(hx - half - 1, 1, 0, hx - half - 1, 2, 0, 'air'));       // a doorway on the west wall, no door: it is open
    start = { x: hx, y: 1, z: 0 }; goal = null;
    survive = [45, 75, 100][level - 1] ?? 75;
    kit.push(['shield', 0]);
    const ring = 6 + 2 * level;
    for (let i = 0; i < ring; i++) { const a = (i / ring) * Math.PI * 2, d = 9 + (i % 3); mobs.push({ type: ['zombie', 'zombie', 'skeleton', 'husk'][i % 4], x: Math.round(hx + Math.cos(a) * d), y: 1, z: Math.round(Math.sin(a) * d) }); }
    text = `You are in a small stone house with an open doorway on the west side, and ${ring} hostile mobs ring it. Stay alive for ${survive} seconds (fight from the doorway, wall it up, whatever works).`;
  } else if (kind === 'mobmaze') {
    // a labyrinth of one-block corridors (recursive backtracker on a cell grid), roofed so there is no walking over it
    const cols = 7 + level, rows = 3 + level, cell = (c, r) => ({ x: 1 + c * 2, z: -rows + r * 2 });
    const open = new Set(), vis = new Set(), key = (c, r) => `${c},${r}`;
    const stack = [[0, 0]]; vis.add('0,0'); open.add(JSON.stringify(cell(0, 0)));
    while (stack.length) {
      const [c, r] = stack[stack.length - 1];
      const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dc, dr]) => { const nc = c + dc, nr = r + dr; return nc >= 0 && nc < cols && nr >= 0 && nr < rows && !vis.has(key(nc, nr)); });
      if (!opts.length) { stack.pop(); continue; }
      const [dc, dr] = opts[Math.floor(rng() * opts.length)], nc = c + dc, nr = r + dr, a = cell(c, r), b = cell(nc, nr);
      open.add(JSON.stringify({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 })); open.add(JSON.stringify(b));
      vis.add(key(nc, nr)); stack.push([nc, nr]);
    }
    const xMax = 1 + (cols - 1) * 2, zMin = -rows, zMax = -rows + (rows - 1) * 2;
    cmds.push(box(0, 1, zMin - 1, xMax + 1, 4, zMax + 1, 'stone_bricks'));
    for (const o of open) { const p = JSON.parse(o); cmds.push(box(p.x, 1, p.z, p.x, 3, p.z, 'air')); }
    start = { x: 1, y: 1, z: zMin }; goal = { x: xMax, y: 1, z: zMax };
    // zombies in the dead ends: cells with exactly one open neighbour (other than start/goal)
    const isOpen = (x, z) => open.has(JSON.stringify({ x, z }));
    const dead = [];
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) { const p = cell(c, r); const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => isOpen(p.x + dx, p.z + dz)).length; if (nb === 1 && !(c === 0 && r === 0) && !(c === cols - 1 && r === rows - 1)) dead.push(p); }
    dead.sort(() => rng() - 0.5);
    dead.slice(0, 2 + 2 * level).forEach((p, i) => mobs.push({ type: ['zombie', 'skeleton', 'zombie', 'husk', 'zombie', 'spider'][i % 6], x: p.x, y: 1, z: p.z }));
    kit.push(['torch', 8]);
    text = `A stone labyrinth of one-block corridors with a roof, ${cols}x${rows} cells, zombies and skeletons in the dead ends. Find the gold block in the far corner.`;
    return { ext: { ...TERRAIN_EXT }, cmds, start, goal, mobs, waves, bait, kit, survive, text, grid: open, cols, rows };
  } else if (kind === 'raid') {
    // open ground, a pillager patrol and vindicators between you and the goal: the ones the bot should not duel (core/threat.js `never`), so it has to get round or away
    for (let x = 0; x < W; x++) for (let z = -R; z <= R; z++) if (rng() < 0.05) place(x, z, 'trunk');
    for (const [k] of grid) { const [x, z] = k.split(',').map(Number); cmds.push(box(x, 1, z, x, 4, z, 'oak_log'), box(x - 1, 5, z - 1, x + 1, 6, z + 1, 'oak_leaves')); }
    const kinds = ['pillager', 'pillager', 'vindicator', 'pillager', 'vindicator'];
    mobSpots(2 + level, 14).forEach((p, i) => mobs.push({ type: kinds[i % kinds.length], x: p.x, y: 1, z: p.z }));
    text = 'Open ground with a raid party between you and the gold block: pillagers with crossbows and vindicators with axes (not ones to duel). Get past them alive.';
  } else if (kind === 'chasm') {
    // a ravine 6 wide and 9 deep right across the field with one narrow bridge, skeletons waiting at the far end of it
    goal = { x: W - 3, y: 1, z: 0 };
    const cx0 = 16 + ri(0, 4), cw = 6;
    cmds.push(box(cx0, -9, -R - 2, cx0 + cw - 1, 0, R + 2, 'air'));
    cmds.push(box(cx0, 0, 0, cx0 + cw - 1, 0, 0, 'cobblestone'));
    const sk = 1 + level;
    for (let i = 0; i < sk; i++) mobs.push({ type: 'skeleton', x: cx0 + cw + 3 + 2 * i, y: 1, z: ri(-3, 3) });
    for (let i = 0; i < level; i++) mobs.push({ type: 'zombie', x: cx0 + cw + 8 + i, y: 1, z: ri(-3, 3) });
    text = 'A 9-deep ravine splits the field, crossed by a one-block bridge. Skeletons wait on the far side and zombies behind them. Cross and reach the gold block (a fall is nine blocks).';
  } else if (kind === 'minecollapse') {
    // a long roofed tunnel with chambers; plugs of gravel and cobwebs across it, mobs between the plugs
    const len = W - 4, plugs = 2 + level;
    cmds.push(box(0, 1, -2, len + 2, 4, 2, 'stone'), box(1, 1, 0, len + 1, 2, 0, 'air'));
    const chambers = [];
    for (let i = 1; i <= plugs; i++) {
      const px = Math.round(len * i / (plugs + 1));
      cmds.push(box(px - 4, 1, -1, px - 1, 3, 1, 'air'));                    // a chamber before the plug
      cmds.push(box(px, 1, 0, px + 1, 2, 0, i % 2 ? 'gravel' : 'web'));
      chambers.push(px - 3);
    }
    start = { x: 1, y: 1, z: 0 }; goal = { x: len + 1, y: 1, z: 0 };
    chambers.forEach((cx, i) => { mobs.push({ type: i % 2 ? 'skeleton' : 'zombie', x: cx, y: 1, z: 0 }); if (level >= 2) mobs.push({ type: 'zombie', x: cx + 1, y: 1, z: 1 }); });
    kit.push(['iron_pickaxe', 1], ['iron_shovel', 1], ['torch', 12], ['shears', 1]);
    text = `A roofed mine tunnel with ${plugs} plugs of gravel and cobweb across it and hostile mobs in the chambers between. Dig through and reach the gold block at the end.`;
  }

  if (goal) cmds.push(box(goal.x, 0, goal.z, goal.x, 0, goal.z, 'gold_block'));
  return { ext: { ...TERRAIN_EXT }, cmds, start, goal, mobs, waves, bait, kit, survive, text, grid, W };
}

/** The fill/setblock commands for a course placed at the site (x, gy, z). */
export function terrainCommands(course, x, gy, z) {
  return course.cmds.map((b) => `fill ${x + b.x1} ${gy + b.y1} ${z + b.z1} ${x + b.x2} ${gy + b.y2} ${z + b.z2} ${b.block}`);
}
