// Where tree hunting's thinking time goes: the path searches (they run as a game job, ~400 nodes a
// tick) on the way to each tree, in a forest where some trees stand on cliff tops it can't get up
// (5 high, no way round, no blocks to pillar with). The real planner, the game's search budgets
// (a walk 8000, a dig-and-build 6000, two tries each way, and mine()'s two goNear calls a try).
//   old   an unreachable tree stays the nearest, picked again: 3 tries before it goes exploring
//   new   the first failed try writes it off (5 minutes), on to the next
//
//   node tools/sim_think.mjs [N]
import { findPath, Cell } from '../behavior_pack/scripts/core/pathfinder.js';
import { makeRng } from '../behavior_pack/scripts/core/mathutil.js';

const N = Number(process.argv[2] ?? 100);
const PER_TICK = 400;

function forest(r) {
  // Rough ground, trees; a few trees up on 5-high plateaus.
  const cliffs = [], trees = [];
  for (let i = 0; i < 12; i++) {
    const x = r.int(-20, 20), z = r.int(-20, 20);
    if (Math.hypot(x, z) < 4) continue;
    const onCliff = r() < 0.35;
    if (onCliff) cliffs.push({ x, z, r: 2 });
    trees.push({ x, z, onCliff });
  }
  const ground = (x, z) => 64 + (cliffs.some((c) => Math.abs(x - c.x) <= c.r && Math.abs(z - c.z) <= c.r) ? 5 : 0);
  const trunk = new Set(trees.map((t) => `${t.x},${t.z}`));
  const classify = (x, y, z) => (y < ground(x, z) ? Cell.SOLID : trunk.has(`${x},${z}`) && y < ground(x, z) + 5 ? Cell.SOLID : Cell.AIR);
  return { classify, trees: trees.map((t) => ({ ...t, y: ground(t.x, t.z) })) };
}

function run(policy, seed) {
  const r = makeRng(seed);
  const { classify, trees } = forest(r);
  let at = { x: 0.5, y: 64, z: 0.5 }, nodes = 0, searches = 0, chopped = 0;
  const writtenOff = new Set();
  const failsOn = new Map();
  const acts = { breakCost: () => 0.85, placeCost: 0.8, budget: 0, unitsPerSecond: 4.3 }; // no blocks to pillar with
  for (let round = 0; round < 40 && chopped < 4; round++) {
    const left = trees.filter((t) => !t.done && !writtenOff.has(t)).sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z));
    if (!left.length) break;
    const t = left[0];
    const goal = { x: t.x + 0.5, y: t.y, z: t.z + 0.5 };
    // mine()'s two goNear calls, each: a walk search (8000), then within 24 one dig-and-build (6000).
    let got = false;
    for (let g = 0; g < (policy === 'new' ? 1 : 2) && !got; g++) {
      const w = findPath(classify, at, goal, { tolerance: 2.5, maxNodes: 8000 }); nodes += w.expanded; searches++;
      if (w.complete) { got = true; break; }
      if (Math.hypot(goal.x - at.x, goal.z - at.z) <= 24) { const a = findPath(classify, at, goal, { tolerance: 2.5, maxNodes: 6000, actions: acts }); nodes += a.expanded; searches++; if (a.complete) got = true; }
    }
    if (got) { t.done = true; chopped++; at = { x: t.x + 1.5, y: t.y, z: t.z + 0.5 }; continue; }
    const f = (failsOn.get(t) ?? 0) + 1;
    failsOn.set(t, f);
    if (policy === 'new' || f >= 3) writtenOff.add(t);
  }
  return { nodes, searches, chopped };
}

for (const policy of ['old', 'new']) {
  let nodes = 0, searches = 0, chopped = 0;
  for (let i = 0; i < N; i++) { const r = run(policy, 1000 + i); nodes += r.nodes; searches += r.searches; chopped += r.chopped; }
  console.log(`${policy}: ${(searches / N).toFixed(1)} searches and ${(nodes / N).toFixed(0)} nodes to reach 4 trees, ~${(nodes / N / PER_TICK / 20).toFixed(1)} s of searching (at ${PER_TICK} nodes a tick); ${(chopped / N).toFixed(1)} trees reached`);
}
