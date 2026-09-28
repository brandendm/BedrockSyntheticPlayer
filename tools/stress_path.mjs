// Pathfinding stress: the real planner and motor, a player-width body with Minecraft's jump
// physics, over terrain that trips bots up. Each world is walked start to goal with up to 3
// replans from wherever we got stuck (what the agent does), and cells we got stuck at count as
// walls on the replan (the agent's badCells).
//
//   forest     dense trees (trunks and low leaves) on rough ground (1-3 block bumps)
//   ravine     a deep cut across the way, a 1-wide natural bridge or a way round somewhere
//   cave       an underground maze, 2-3 high, with steps in the floor
//   hills      steep ground: 2-high cliffs with the odd 1-high step up, and stairs
//   tunnel     2-high passages whose floor steps up (a step up under a low ceiling: no jump room)
//   rough      steep broken ground, 1-block steps everywhere and 2-block cliffs
//   jungle     2x2 trunks, bushes and leaves hanging at head height
//   holes      flat ground full of deep 1-wide shafts (jump or go round) and bumps
//   shore      a lake to go round or swim (planner only: the test body doesn't swim)
//   gaps       flat ground cut by trenches 1-3 wide, 3 deep, a long way round (MAXLEAP=1: only
//              1-block leaps, as before)
//   wedge      tight spots: 1-wide slots between posts, diagonal pinches (no corner cutting), a
//              zigzag 1-wide passage with a step up in a turn
//
// Run: node tools/stress_path.mjs [N per kind] [-v]
import { MotorController } from '../behavior_pack/scripts/core/motor.js';
import { findPath, smoothPath, Cell, DEFAULT_COSTS } from '../behavior_pack/scripts/core/pathfinder.js';
import { makeRng } from '../behavior_pack/scripts/core/mathutil.js';
import { SimBody, runMotor } from '../tests/helpers.js';
import { pathToFileURL } from 'node:url';

const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 60);
const VERBOSE = process.argv.includes('-v');

/** A world from a heightmap (top solid y + 1 per column) and extra blocks. */
function world(ground, extra = new Map(), stairs = new Map()) {
  const classify = (x, y, z) => {
    const e = extra.get(`${x},${y},${z}`);
    if (e !== undefined) return e;
    return y < ground(x, z) ? Cell.SOLID : Cell.AIR;
  };
  return { classify, stairFacing: (x, y, z) => stairs.get(`${x},${y},${z}`) };
}

/** Smooth-ish value noise: amplitude a, cell size s. */
function noise(r, a, s) {
  const g = new Map();
  const at = (i, j) => { const k = `${i},${j}`; if (!g.has(k)) g.set(k, r() * a); return g.get(k); };
  return (x, z) => {
    const i = Math.floor(x / s), j = Math.floor(z / s), fx = x / s - i, fz = z / s - j;
    const a0 = at(i, j) * (1 - fx) + at(i + 1, j) * fx, a1 = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx;
    return a0 * (1 - fz) + a1 * fz;
  };
}

export const KINDS = {
  forest(r) {
    const n = noise(r, 3.5, 5), h = new Map();
    const ground = (x, z) => { const k = `${x},${z}`; if (!h.has(k)) h.set(k, 64 + Math.round(n(x + 100, z + 100))); return h.get(k); };
    const extra = new Map();
    for (let x = -4; x <= 34; x++) for (let z = -12; z <= 12; z++) {
      if ((x <= 1 && Math.abs(z) <= 1) || (x >= 28 && Math.abs(z) <= 1)) continue;
      if (r() > 0.2) continue; // a dense forest: a trunk in one column of five
      const g = ground(x, z), top = g + r.int(4, 7);
      for (let y = g; y < top; y++) extra.set(`${x},${y},${z}`, Cell.SOLID);
      // Leaves from 2 up (low branches: bump the head), sometimes down to head height.
      const low = r() < 0.3 ? g + 2 : top - 2;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let y = low; y <= top; y++) {
        if (Math.abs(dx) + Math.abs(dz) > 3 || r() < 0.2) continue;
        const k = `${x + dx},${y},${z + dz}`;
        const clear = (x + dx <= 1 || x + dx >= 29) && Math.abs(z + dz) <= 1; // start and goal stay clear
        if (!clear && !extra.has(k) && y >= ground(x + dx, z + dz)) extra.set(k, Cell.SOLID);
      }
    }
    return { w: world(ground, extra), start: { x: 0.5, y: ground(0, 0), z: 0.5 }, goal: { x: 30, y: ground(30, 0), z: 0 }, tol: 1.5 };
  },
  ravine(r) {
    const n = noise(r, 2, 6);
    const x0 = r.int(8, 14), wide = r.int(2, 4), bridge = r() < 0.5 ? r.int(-8, 8) : null, end = r.int(10, 16);
    const ground = (x, z) => {
      if (x >= x0 && x < x0 + wide && Math.abs(z) < end && z !== bridge) return 40; // 24 deep
      return 64 + Math.round(n(x + 50, z + 50));
    };
    return { w: world(ground), start: { x: 0.5, y: ground(0, 0), z: 0.5 }, goal: { x: 24, y: ground(24, 0), z: 0 }, tol: 1.5, maxNodes: 20000 };
  },
  cave(r) {
    // A maze (cells two blocks apart, carved depth-first, a few walls knocked through for loops),
    // 2 or 3 high, the floor stepping up a block here and there.
    const W = 9, H = 7, carved = new Set(['0,0']), seen = new Set(['0,0']), stack = [[0, 0]];
    while (stack.length) {
      const [i, j] = stack[stack.length - 1];
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => [i + a, j + b]).filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H && !seen.has(`${a},${b}`));
      if (!nb.length) { stack.pop(); continue; }
      const [a, b] = nb[r.int(0, nb.length - 1)];
      seen.add(`${a},${b}`); stack.push([a, b]);
      carved.add(`${2 * a},${2 * b}`); carved.add(`${i + a},${j + b}`);
    }
    for (let k = 0; k < 5; k++) carved.add(`${2 * r.int(0, W - 2) + 1},${2 * r.int(0, H - 1)}`);
    const floor = new Map(), ceil = new Map();
    for (const k of carved) {
      floor.set(k, 20 + (r() < 0.25 ? 1 : 0));
      ceil.set(k, 23); // 2 high over a raised floor, 3 elsewhere: room to jump up the steps
    }
    floor.set('0,0', 20); ceil.set('0,0', 23);
    const classify = (bx, y, bz) => {
      const k = `${bx},${bz}`;
      if (!carved.has(k)) return Cell.SOLID;
      return y >= floor.get(k) && y < ceil.get(k) ? Cell.AIR : Cell.SOLID;
    };
    const gx = 2 * (W - 1), gz = 2 * (H - 1);
    return { w: { classify }, start: { x: 0.5, y: 20, z: 0.5 }, goal: { x: gx, y: floor.get(`${gx},${gz}`), z: gz }, tol: 0.5 };
  },
  hills(r) {
    // Terraces: every few blocks the ground steps up 1 (walkable) or 2 (a cliff), with a gap
    // somewhere in each cliff; some steps are stairs.
    const lines = [];
    let x = 3;
    while (x < 26) { lines.push({ x, up: r() < 0.5 ? 2 : 1, gap: r.int(-6, 6), stair: r() < 0.4 }); x += r.int(2, 4); }
    const stairs = new Map(), extra = new Map();
    const ground = (bx, bz) => {
      let h = 64;
      for (const l of lines) if (bx >= l.x) h += l.up === 2 && Math.abs(bz - l.gap) <= 0 ? 1 : l.up;
      return h;
    };
    // Stairs at the foot of a 1-high step (or at a cliff's gap), facing +x.
    for (const l of lines) {
      if (!l.stair) continue;
      for (let z = -10; z <= 10; z++) {
        if (l.up === 2 && z !== l.gap) continue;
        const y = ground(l.x - 1, z);
        extra.set(`${l.x - 1},${y},${z}`, Cell.STEP); stairs.set(`${l.x - 1},${y},${z}`, { x: 1, z: 0 });
      }
    }
    const w = world(ground, extra, stairs);
    return { w, start: { x: 0.5, y: ground(0, 0), z: 0.5 }, goal: { x: 28, y: ground(28, 0), z: r.int(-5, 5) }, tol: 1 };
  },
  tunnel(r) {
    // A 1-wide tunnel (branch mine), ceiling 2 above the floor, with 1-high steps up and down;
    // some steps have a block of headroom cut (as a player would), some don't (no way through).
    const floor = [], ceilCut = [];
    let f = 20;
    for (let x = 0; x <= 24; x++) {
      if (x > 2 && x < 22 && r() < 0.3) f += r() < 0.5 ? 1 : -1;
      floor.push(f); ceilCut.push(true);
    }
    const classify = (x, y, z) => {
      if (z !== 0 || x < 0 || x > 24) return Cell.SOLID;
      const fl = floor[x];
      // Headroom: 2 over the floor, and 3 where the floor steps up to the next (room for the jump).
      const top = fl + 2 + ((x < 24 && floor[x + 1] > fl) || (x > 0 && floor[x - 1] > fl) ? 1 : 0);
      return y >= fl && y < top ? Cell.AIR : Cell.SOLID;
    };
    void ceilCut;
    return { w: { classify }, start: { x: 0.5, y: floor[0], z: 0.5 }, goal: { x: 24, y: floor[24], z: 0 }, tol: 0.5 };
  },
  rough(r) {
    // Steep broken ground: 1-block steps everywhere, 2-block cliffs to go round.
    const n = noise(r, 9, 3), h = new Map();
    const ground = (x, z) => { const k = `${x},${z}`; if (!h.has(k)) h.set(k, 64 + Math.round(n(x + 300, z + 300))); return h.get(k); };
    return { w: world(ground), start: { x: 0.5, y: ground(0, 0), z: 0.5 }, goal: { x: 26, y: ground(26, 0), z: 0 }, tol: 1.5 };
  },
  jungle(r) {
    // 2x2 trunks, leaves hanging to head height, bushes (1-high leaf blocks) on the floor.
    const n = noise(r, 2, 4), h = new Map();
    const ground = (x, z) => { const k = `${x},${z}`; if (!h.has(k)) h.set(k, 64 + Math.round(n(x + 700, z + 700))); return h.get(k); };
    const extra = new Map();
    const clear = (x, z) => (x <= 1 || x >= 27) && Math.abs(z) <= 1;
    for (let i = 0; i < 26; i++) {
      const x = r.int(2, 25), z = r.int(-10, 9), g = ground(x, z);
      if (clear(x, z) || clear(x + 1, z + 1)) continue;
      for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) for (let y = g - 1; y < g + 10; y++) extra.set(`${x + a},${y},${z + b}`, Cell.SOLID);
    }
    for (let i = 0; i < 90; i++) {
      const x = r.int(0, 28), z = r.int(-10, 10);
      if (clear(x, z)) continue;
      const g = ground(x, z);
      extra.set(`${x},${r() < 0.5 ? g : g + 1},${z}`, Cell.SOLID); // a bush, or a leaf at head height
    }
    return { w: world(ground, extra), start: { x: 0.5, y: ground(0, 0), z: 0.5 }, goal: { x: 28, y: ground(28, 0), z: 0 }, tol: 1.5 };
  },
  holes(r) {
    // Flat ground peppered with 1-wide shafts (deep: jump them or go round) and 1-high bumps.
    const hm = new Map();
    for (let i = 0; i < 70; i++) hm.set(`${r.int(2, 22)},${r.int(-8, 8)}`, r() < 0.6 ? 40 : 65);
    const ground = (x, z) => hm.get(`${x},${z}`) ?? 64;
    return { w: world(ground), start: { x: 0.5, y: 64, z: 0.5 }, goal: { x: 24, y: 64, z: r.int(-6, 6) }, tol: 0.5 };
  },
  gaps(r) {
    // Trenches across the way, each 1-3 wide and 3 deep (a missed jump is a climb out, not a
    // death), the ends 12+ blocks off to either side.
    const cut = new Map();
    let x = 4;
    while (x < 24) { const wdt = r.int(1, 3); for (let k = 0; k < wdt; k++) cut.set(x + k, true); x += wdt + r.int(3, 5); }
    const ground = (gx, gz) => (cut.has(gx) && Math.abs(gz) <= 12 ? 61 : 64);
    return { w: world(ground), start: { x: 0.5, y: 64, z: 0.5 }, goal: { x: 27, y: 64, z: r.int(-2, 2) }, tol: 0.8 };
  },
  wedge(r) {
    // Posts two high making 1-wide slots and diagonal pinches; then a walled 1-wide zigzag.
    const extra = new Map();
    const put = (bx, bz, y0 = 64) => { extra.set(`${bx},${y0},${bz}`, Cell.SOLID); extra.set(`${bx},${y0 + 1},${bz}`, Cell.SOLID); };
    for (let i = 0; i < 26; i++) {
      const bx = r.int(3, 12), bz = r.int(-5, 5);
      put(bx, bz);
      if (r() < 0.5) put(bx + 1, bz + (r() < 0.5 ? 1 : -1)); // a diagonal pinch
      else put(bx, bz + 2); // a 1-wide slot
    }
    // The zigzag: walls along both sides of a 1-wide lane from x 16 to 26, turning at 20 and 23,
    // the floor one up after the second turn.
    const lane = [];
    for (let lx = 15; lx <= 20; lx++) lane.push([lx, 0]);
    for (let lz = 1; lz <= 3; lz++) lane.push([20, lz]);
    for (let lx = 21; lx <= 23; lx++) lane.push([lx, 3]);
    for (let lz = 2; lz >= 0; lz--) lane.push([23, lz]);
    for (let lx = 24; lx <= 27; lx++) lane.push([lx, 0]);
    const inLane = new Set(lane.map(([a, b]) => `${a},${b}`));
    for (let lx = 15; lx <= 28; lx++) for (let lz = -2; lz <= 5; lz++) if (!inLane.has(`${lx},${lz}`)) { extra.set(`${lx},64,${lz}`, Cell.SOLID); extra.set(`${lx},65,${lz}`, Cell.SOLID); extra.set(`${lx},66,${lz}`, Cell.SOLID); }
    const raised = (gx, gz) => gx >= 24 && gz === 0 && inLane.has(`${gx},${gz}`);
    const ground = (gx, gz) => (raised(gx, gz) ? 65 : 64);
    for (const [a, b] of lane) if (!raised(a, b)) extra.delete(`${a},64,${b}`);
    return { w: world(ground, extra), start: { x: 0.5, y: 64, z: 0.5 }, goal: { x: 27, y: 65, z: 0 }, tol: 0.5 };
  },
  shore(r) {
    const cx = r.int(10, 16), rad = r.int(4, 8);
    const water = new Map();
    const ground = (x, z) => (Math.hypot(x - cx, z) < rad ? 60 : 64 + (r() < 0.05 ? 1 : 0));
    const h = new Map();
    const g = (x, z) => { const k = `${x},${z}`; if (!h.has(k)) h.set(k, ground(x, z)); return h.get(k); };
    for (let x = cx - rad; x <= cx + rad; x++) for (let z = -rad; z <= rad; z++) {
      if (Math.hypot(x - cx, z) < rad) for (let y = 60; y < 64; y++) water.set(`${x},${y},${z}`, Cell.LIQUID);
    }
    return { w: world(g, water), start: { x: 0.5, y: 64, z: 0.5 }, goal: { x: 28, y: 64, z: 0 }, tol: 1, planOnly: true };
  },
};

const COSTS = process.env.MAXLEAP ? { ...DEFAULT_COSTS, maxLeap: Number(process.env.MAXLEAP) } : DEFAULT_COSTS;

async function walk(w, start, goal, tol, seed, maxNodes = 20000) {
  const body = new SimBody(w, start, makeRng(seed).range(-180, 180), { hw: 0.3 });
  const m = new MotorController(body, {}, makeRng(seed));
  const bad = new Set();
  const classify = (x, y, z) => (bad.has(`${x},${y},${z}`) ? Cell.DANGER : w.classify(x, y, z));
  let res = null, replans = 0, ticks = 0, expanded = 0, ms = 0;
  for (; replans <= 3; replans++) {
    const t0 = performance.now();
    const p = findPath(classify, body.pos, goal, { tolerance: tol, maxNodes, costs: COSTS });
    ms += performance.now() - t0; expanded += p.expanded ?? 0;
    if (!p.complete) return { status: replans ? 'lost' : 'nopath', replans, ticks, expanded, ms, at: body.pos };
    const out = await runMotor(m, body, m.followPath(smoothPath(classify, p.path)), 2500);
    res = out.result; ticks += out.ticks;
    if (res?.status === 'arrived') break;
    // Stuck: the cell we were headed into counts as a wall next time.
    const nx = res?.at ?? res?.next;
    if (nx) bad.add(`${Math.floor(nx.x)},${Math.floor(nx.y)},${Math.floor(nx.z)}`);
    if (VERBOSE) console.log('  stuck', seed, JSON.stringify(res), body.pos);
  }
  const d = Math.hypot(body.pos.x - goal.x - 0.5, body.pos.z - goal.z - 0.5);
  return { status: res?.status === 'arrived' || d <= tol + 1 ? 'arrived' : res?.status ?? 'timeout', replans, ticks, expanded, ms, at: body.pos };
}

// Run directly: every kind, N worlds each. (Imported, e.g. to debug one world: just the exports.)
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
const summary = [];
let failures = 0;
for (const [kind, make] of Object.entries(KINDS)) {
  let ok = 0, total = 0, nopath = 0, replanned = 0, ticks = 0, slowest = 0, nodes = 0;
  const bad = [];
  for (let seed = 1; seed <= N; seed++) {
    const r = makeRng(seed * 7919 + kind.length);
    const sc = make(r);
    if (sc.planOnly) {
      const t0 = performance.now();
      const p = findPath(sc.w.classify, sc.start, sc.goal, { tolerance: sc.tol, maxNodes: 20000 });
      slowest = Math.max(slowest, performance.now() - t0); nodes += p.expanded ?? 0;
      total++;
      if (p.complete) ok++; else bad.push([seed, 'nopath']);
      continue;
    }
    const out = await walk(sc.w, sc.start, sc.goal, sc.tol, seed, sc.maxNodes);
    if (out.status === 'nopath') { nopath++; continue; }
    total++; ticks += out.ticks; nodes += out.expanded; slowest = Math.max(slowest, out.ms);
    if (out.replans) replanned++;
    if (out.status === 'arrived') ok++;
    else bad.push([seed, out.status, `${out.at.x.toFixed(1)},${out.at.y.toFixed(1)},${out.at.z.toFixed(1)}`]);
  }
  failures += total - ok;
  summary.push(`${total - ok ? 'FAIL' : 'ok  '} ${kind.padEnd(7)} ${ok}/${total} arrived${nopath ? ` (${nopath} with no way through)` : ''}, ${replanned} replanned, avg ${(ticks / Math.max(1, total) / 20).toFixed(1)} s walking, ${Math.round(nodes / Math.max(1, total))} nodes/trip, slowest plan ${slowest.toFixed(0)} ms`);
  if (bad.length) summary.push(`       ${JSON.stringify(bad.slice(0, 8))}`);
}
console.log(summary.join('\n'));
process.exitCode = failures ? 1 : 0;
}
export { walk };
