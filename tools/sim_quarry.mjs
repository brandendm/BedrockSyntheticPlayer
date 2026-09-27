// Creepers blowing up the quarry: the bot's 1-wide staircase from the surface (Y 64) down to the
// mine at Y 16, 48 steps, with one or two creeper blasts in it (Bedrock: power 3, a crater ~2-3.5
// blocks across, ragged). Can it still get in and out?
//
//   old      what the game did: walk the recorded stairs; stuck, one path search to the far end,
//            digging and building only if that end is within 24 blocks (goNear); three failed trips
//            down and the quarry is abandoned
//   new      stuck on the stairs: a few steps at a time past the damage (each hop close enough for
//            the dig-and-build search), then the treads that are gone put back (skills.repairShaft)
//
// Run: node tools/sim_quarry.mjs [N] [-v]
import { findPath, Cell } from '../behavior_pack/scripts/core/pathfinder.js';
import { makeRng } from '../behavior_pack/scripts/core/mathutil.js';

const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 300);
const VERBOSE = process.argv.includes('-v');
const TOP = 64, STEPS = 48;
// Crater radius: stone resists a creeper's blast (a small crater), dirt near the top doesn't. R=small|big.
const [R0, R1] = process.env.R === 'big' ? [2.0, 3.5] : [1.4, 2.4];
const stand = (i) => ({ x: i, y: TOP - i, z: 0 }); // step i: where the feet go

/** The quarry world: stone below 64 except the stairs (3 high) and the branch tunnel at the bottom. */
function quarryWorld() {
  const cells = new Map(); // "x,y,z" -> Cell override (carved air, craters, placed blocks)
  const k = (x, y, z) => `${x},${y},${z}`;
  for (let i = 0; i <= STEPS; i++) { const s = stand(i); for (let h = 0; h < 3; h++) cells.set(k(s.x, s.y + h, 0), Cell.AIR); }
  for (let x = STEPS + 1; x <= STEPS + 14; x++) for (const y of [TOP - STEPS, TOP - STEPS + 1]) cells.set(k(x, y, 0), Cell.AIR);
  const classify = (x, y, z) => cells.get(k(x, y, z)) ?? (y >= TOP ? Cell.AIR : Cell.SOLID);
  return { classify, set: (x, y, z, c) => cells.set(k(x, y, z), c) };
}

/** A creeper blast at c: solid blocks within ~r gone (ragged edge, like the game's rays). */
function blast(w, c, r, rng) {
  let n = 0;
  for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) {
    const d = Math.hypot(dx, dy, dz);
    if (d > r * (0.75 + rng() * 0.35)) continue;
    const x = Math.floor(c.x) + dx, y = Math.floor(c.y) + dy, z = Math.floor(c.z) + dz;
    if (y >= TOP) continue;
    if (w.classify(x, y, z) === Cell.SOLID) { w.set(x, y, z, Cell.AIR); n++; }
  }
  return n;
}

// The bot's dig-and-build search (skills.actionOpts): stone with a stone pickaxe ~0.6 s, and cobble
// to place (it carries 32+ going down the mine).
const ACTIONS = (blocks) => ({ breakCost: () => 0.85, placeCost: 0.8, budget: blocks, unitsPerSecond: 4.3 });
const standable = (w, p) => w.classify(p.x, p.y, p.z) === Cell.AIR && w.classify(p.x, p.y + 1, p.z) === Cell.AIR && w.classify(p.x, p.y - 1, p.z) === Cell.SOLID;

/** Walk the recorded steps from a to b; returns the last step index reached (stops at the damage). */
function walkSteps(w, a, b) {
  const dir = b > a ? 1 : -1;
  let i = a;
  while (i !== b) {
    const n = i + dir;
    // Next tread gone, or no plain walk from this one to it (a drop too deep, a gap): stuck.
    if (!standable(w, stand(n))) break;
    const r = findPath(w.classify, stand(i), stand(n), { maxNodes: 60 });
    if (!r.complete || r.path.length > 4) break;
    i = n;
  }
  return i;
}

/** Carry out an action path in the world: its breaks and the blocks it put down. */
function apply(w, path) {
  for (const p of path) {
    for (const [x, y, z] of p.move?.breaks ?? []) w.set(x, y, z, Cell.AIR);
    if (p.move?.place) w.set(p.x, p.y - 1, p.z, Cell.SOLID);
  }
}

/** The old way: stuck -> goNear(the far end): walk search; dig-and-build only within 24. */
function oldTrip(w, a, b) {
  const i = walkSteps(w, a, b);
  if (i === b) return { ok: true, how: 'walked' };
  const from = stand(i), to = stand(b);
  const walk = findPath(w.classify, from, to, { tolerance: 0.8, maxNodes: 8000 });
  if (walk.complete) return { ok: true, how: 'walked round' };
  if (Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z) > 24) return { ok: false, how: `stuck at step ${i}, the far end ${Math.round(Math.hypot(from.x - to.x, from.y - to.y))} away (no digging past 24)` };
  const act = findPath(w.classify, from, to, { tolerance: 0.8, maxNodes: 6000, actions: ACTIONS(32) });
  if (act.complete) { apply(w, act.path); return { ok: true, how: 'dug/built through' }; }
  return { ok: false, how: `stuck at step ${i}: no way even digging` };
}

/** The new way: past the damage a few steps at a time (dig and build allowed), then the treads back. */
function newTrip(w, a, b) {
  let i = walkSteps(w, a, b), hops = 0, placed = 0, rebuilt = 0;
  const dir = b > a ? 1 : -1;
  while (i !== b && hops < 12) {
    hops++;
    // The next step past the damage we can stand on (at most 6 on), else 6 on regardless.
    let j = i + dir * 6;
    if (dir > 0 ? j > b : j < b) j = b;
    const from = stand(i), to = stand(j);
    const act = findPath(w.classify, from, to, { tolerance: 0.8, maxNodes: 6000, actions: ACTIONS(32) });
    if (!act.complete) return { ok: false, how: `stuck at step ${i} (hop ${hops})`, hops };
    apply(w, act.path);
    placed += act.path.filter((p) => p.move?.place).length;
    // Put the treads we passed back: the stairs are the way in and out, every trip.
    for (let s = i; s !== j; s += dir) {
      const t = stand(s);
      if (w.classify(t.x, t.y - 1, t.z) !== Cell.SOLID) { w.set(t.x, t.y - 1, t.z, Cell.SOLID); rebuilt++; }
      for (const h of [0, 1, 2]) if (w.classify(t.x, t.y + h, t.z) === Cell.SOLID) w.set(t.x, t.y + h, t.z, Cell.AIR);
    }
    i = walkSteps(w, j, b);
  }
  return { ok: i === b, how: i === b ? (hops ? `through the damage in ${hops} hop${hops > 1 ? 's' : ''}` : 'walked') : 'gave up', hops, placed, rebuilt };
}

const rng = makeRng(20260927);
const stats = { old: { down: 0, up: 0 }, new: { down: 0, up: 0 }, again: 0 };
const bad = [];
let craters = 0, destroyed = 0;
for (let n = 0; n < N; n++) {
  const seed = rng.int(1, 1e9);
  const make = () => {
    const r = makeRng(seed);
    const w = quarryWorld();
    const booms = r() < 0.3 ? 2 : 1;
    for (let b = 0; b < booms; b++) {
      const s = stand(r.int(2, STEPS - 2));
      const c = { x: s.x + r.range(-1, 1), y: s.y + r.range(0, 1.5), z: r.range(-1, 1) };
      const n2 = blast(w, c, r.range(R0, R1), r);
          craters++; destroyed += n2;
    }
    return w;
  };
  // Old: down, then up (a fresh copy of the damage each time).
  const wo = make();
  const od = oldTrip(wo, 0, STEPS), ou = oldTrip(wo, STEPS, 0);
  if (od.ok) stats.old.down++;
  if (ou.ok) stats.old.up++;
  const wn = make();
  const nd = newTrip(wn, 0, STEPS), nu = newTrip(wn, STEPS, 0);
  if (nd.ok) stats.new.down++;
  if (nu.ok) stats.new.up++;
  // After the new way's repairs, the next trip is a plain walk both ways again?
  if (nd.ok && nu.ok && walkSteps(wn, 0, STEPS) === STEPS && walkSteps(wn, STEPS, 0) === 0) stats.again++;
  if (!nd.ok || !nu.ok) bad.push([seed, nd.how, nu.how]);
  if (VERBOSE && (!od.ok || !ou.ok)) console.log(`seed ${seed}: old down: ${od.how}; old up: ${ou.how}; new: ${nd.how} / ${nu.how}`);
}
const pc = (x) => `${x}/${N} (${(100 * x / N).toFixed(0)}%)`;
console.log(`${N} quarries, ${craters / 2} blasts, ${(destroyed / craters).toFixed(0)} blocks blown out each`);
console.log(`old way: got down ${pc(stats.old.down)}, got back up ${pc(stats.old.up)}`);
console.log(`new way: got down ${pc(stats.new.down)}, got back up ${pc(stats.new.up)}; stairs whole again after ${pc(stats.again)}`);
if (bad.length) console.log('new way failed:', JSON.stringify(bad.slice(0, 6)));
