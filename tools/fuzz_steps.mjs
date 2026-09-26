// Step-up junctions with a real-width body: a 1-high step right next to a 2-high wall, approached
// from every angle, plus random terrain with steps. Run: node tools/fuzz_steps.mjs
import { MotorController } from '../behavior_pack/scripts/core/motor.js';
import { findPath, smoothPath } from '../behavior_pack/scripts/core/pathfinder.js';
import { makeRng } from '../behavior_pack/scripts/core/mathutil.js';
import { makeWorld, SimBody, runMotor } from '../tests/helpers.js';

async function walk(w, start, goal, seed, yaw) {
  const body = new SimBody(w, start, yaw, { hw: 0.3 });
  const m = new MotorController(body, {}, makeRng(seed));
  let res = null, replans = 0;
  for (; replans < 3; replans++) {
    const p = findPath(w.classify, body.pos, goal);
    if (!p.complete) return { status: 'nopath', replans, jumps: body.jumps };
    ({ result: res } = await runMotor(m, body, m.followPath(smoothPath(w.classify, p.path)), 1500));
    if (res?.status === "arrived") break;
    if (process.env.DEBUG) console.log("stuck", seed, res, body.pos);
  }
  return { status: res?.status, replans, jumps: body.jumps, at: body.pos };
}

let ok = 0, total = 0, replanned = 0, jumps = 0;
const bad = [];
// 1. Junctions: floor 64; the step column is 1 high, its neighbour 2 high, goal on top beyond.
for (let seed = 1; seed <= 150; seed++) {
  const r = makeRng(seed);
  const hm = new Map();
  // a ledge running along z at x=6..: some cells 65 (steps), others 66 (walls)
  for (let z = -6; z <= 6; z++) for (let x = 6; x <= 12; x++) hm.set(`${x},${z}`, 66);
  const steps = r.int(1, 3);
  for (let i = 0; i < steps; i++) hm.set(`6,${r.int(-4, 4)}`, 65);
  const w = makeWorld({ ground: (x, z) => hm.get(`${x},${z}`) ?? 64 });
  const start = { x: r.range(0.4, 3.6), y: 64, z: r.range(-5.6, 5.6) };
  const goal = { x: 9, y: 66, z: r.int(-5, 5) };
  const out = await walk(w, start, goal, seed, r.range(-180, 180));
  if (out.status === 'nopath') continue;
  total++; jumps += out.jumps; if (out.replans) { replanned++; bad.push(["replan", seed, out.replans]); }
  if (out.status === 'arrived') ok++; else bad.push(['junction', seed, out.status, out.at]);
}
// 2. Random bumpy terrain with 1-high steps and 2-high pillars.
for (let seed = 1; seed <= 150; seed++) {
  const r = makeRng(1000 + seed);
  const hm = new Map();
  for (let i = 0; i < 60; i++) hm.set(`${r.int(2, 18)},${r.int(-8, 8)}`, r() < 0.5 ? 65 : 66);
  const w = makeWorld({ ground: (x, z) => hm.get(`${x},${z}`) ?? 64 });
  const out = await walk(w, { x: 0.5, y: 64, z: 0.5 }, { x: 20, y: 64, z: r.int(-6, 6) }, seed, r.range(-180, 180));
  if (out.status === 'nopath') continue;
  total++; jumps += out.jumps; if (out.replans) { replanned++; bad.push(["replan", seed, out.replans]); }
  if (out.status === 'arrived') ok++; else bad.push(['bumpy', seed, out.status, out.at]);
}
// 3. Ditches: 1-wide trenches (some 2 deep: leapable; some deep: must go round), random steps.
for (let seed = 1; seed <= 100; seed++) {
  const r = makeRng(5000 + seed);
  const hm = new Map();
  for (let t = 0; t < 3; t++) {
    const x = r.int(3, 16), depth = r() < 0.7 ? 2 : 12, from = r.int(-8, 0), to = r.int(0, 8);
    for (let z = from; z <= to; z++) hm.set(`${x},${z}`, 64 - depth);
  }
  for (let i = 0; i < 12; i++) { const k = `${r.int(2, 18)},${r.int(-8, 8)}`; if (!hm.has(k)) hm.set(k, 65); }
  const w = makeWorld({ ground: (x, z) => hm.get(`${x},${z}`) ?? 64 });
  const out = await walk(w, { x: 0.5, y: 64, z: 0.5 }, { x: 20, y: 64, z: r.int(-6, 6) }, seed, r.range(-180, 180));
  if (out.status === 'nopath') continue;
  total++; jumps += out.jumps; if (out.replans) { replanned++; bad.push(['ditch', seed, out.replans]); }
  if (out.status === 'arrived') ok++; else bad.push(['ditch', seed, out.status, out.at]);
}
console.log(`${ok}/${total} arrived, ${replanned} needed a replan, ${jumps} jumps`);
if (bad.length) console.log(bad.slice(0, 15));
