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

// ---------- --leave: getting out the way the game does, with the blocks it will spend ----------
// skills.leaveQuarry: back to the foot of the stairs, walkShaft up; broken: pastDamage (6 steps a
// hop; each hop goNear: a walk search, then within 24 one dig-and-build search whose block budget is
// skills.blockCount(): what it carries less the reserve: 27 cobblestone for the house until the
// house is up); the treads it passed put back (one block each, from the same budget). Failing
// that: skills.actionEscape (a dig-and-build search to anywhere on the surface: a new hole), then a
// staircase of its own (always works with a pickaxe, the least graceful).
// Short of blocks for a hop, it digs a few out of the quarry's wall first (it's stone; the house's
// cobblestone stays held back). LEAVE=old: without that (what the game did before).
if (process.argv.includes('--leave')) {
  const GATHER = !['old', 'noreserve'].includes(process.env.LEAVE ?? '');
  // LEAVE=noreserve: nothing held back for the house while down the quarry (stone all round).
  const NORESERVE = process.env.LEAVE === 'noreserve';
  const rngL = makeRng(777);
  const stats = { stairs: 0, escape: 0, dug: 0, fixed: 0, spent: 0, reserveOk: 0, gathered: 0, secs: 0 };
  const byCarry = {};
  for (let n = 0; n < N; n++) {
    const r = makeRng(rngL.int(1, 1e9));
    const w = quarryWorld();
    const booms = 1 + (r() < 0.4 ? 1 : 0) + (r() < 0.15 ? 1 : 0);
    for (let b = 0; b < booms; b++) {
      const st = stand(r.int(1, STEPS - 1));
      blast(w, { x: st.x + r.range(-1, 1), y: st.y + r.range(0, 1.5), z: r.range(-1, 1) }, r() < 0.3 ? r.range(2.0, 3.5) : r.range(R0, R1), r);
    }
    const carry = [6, 15, 30, 45, 64][r.int(0, 4)];
    const houseYet = r() < 0.5;
    const reserve = houseYet && !NORESERVE ? 27 : 0; // no house yet: its cobblestone is kept back
    let cobble = carry, secs = 0, gathered = 0;
    const spendable = () => Math.max(0, cobble - reserve);
    const walkS = (path) => path.length / 4.3;
    let i = STEPS, how = null;
    // Walk the stairs up; stuck: past the damage a hop at a time.
    i = walkSteps(w, STEPS, 0); secs += (STEPS - i) / 4.3;
    for (let hop = 0; hop < 16 && i !== 0 && !how; hop++) {
      const j = Math.max(0, i - 6);
      const from = stand(i), to = stand(j);
      const walk = findPath(w.classify, from, to, { tolerance: 0.8, maxNodes: 8000 });
      let path = walk.complete ? walk.path : null;
      if (!path) {
        if (GATHER && spendable() < 8) { const k = reserve + 8 - cobble; cobble += k; gathered += k; secs += k * 0.85; } // (to 8 over what's held back)
        const act = findPath(w.classify, from, to, { tolerance: 0.8, maxNodes: 6000, actions: ACTIONS(spendable()) });
        if (act.complete) path = act.path;
      }
      if (!path) { how = 'stuck'; break; }
      const breaks = path.reduce((a, p) => a + (p.move?.breaks?.length ?? 0), 0), places = path.filter((p) => p.move?.place).length;
      apply(w, path); cobble += breaks - places; secs += walkS(path) + breaks * 0.85 + places * 0.8;
      // repairShaft: the treads passed, one block each while there are blocks to spend.
      for (let s2 = j; s2 <= i; s2++) {
        const t = stand(s2);
        if (w.classify(t.x, t.y - 1, t.z) !== Cell.SOLID && spendable() > 0) { w.set(t.x, t.y - 1, t.z, Cell.SOLID); cobble--; stats.fixed++; secs += 0.8; }
      }
      i = walkSteps(w, j, 0); secs += (j - i) / 4.3;
    }
    if (i === 0) { stats.stairs++; how = 'stairs'; }
    else {
      // actionEscape: anywhere on the surface, digging and building (15000 nodes).
      const from = stand(i);
      const esc = findPath(w.classify, from, from, { maxNodes: 15000, actions: ACTIONS(spendable()), goalTest: (x, y, z) => y >= TOP && standable(w, { x, y, z }) });
      if (esc.complete) { stats.escape++; how = 'escape'; secs += walkS(esc.path) + esc.path.reduce((a, p) => a + (p.move?.breaks?.length ?? 0), 0) * 0.85; }
      else { stats.dug++; how = 'new staircase'; secs += (TOP - from.y) * 3 * 0.85; }
    }
    stats.spent += carry - cobble; stats.gathered += gathered; stats.secs += secs;
    if (houseYet && cobble < Math.min(carry, 27)) stats.reserveOk++; // (counts house cobblestone spent)
    const k = `${carry} cobblestone, ${houseYet ? 'no house yet (27 kept back)' : 'house built'}`;
    const o = (byCarry[k] ??= { n: 0, stairs: 0, escape: 0, dug: 0 });
    o.n++; o[how === 'stairs' ? 'stairs' : how === 'escape' ? 'escape' : 'dug']++;
    if (VERBOSE && how !== 'stairs') console.log(`#${n}: ${k}, ${booms} blast(s): ${how} (stuck at step ${i})`);
  }
  const pc = (x) => `${(100 * x / N).toFixed(0)}%`;
  console.log(`${N} damaged quarries, leaving from the bottom${GATHER ? ' (short of blocks: dig some out of the wall first)' : NORESERVE ? ' (nothing held back for the house down here)' : ''}:`);
  console.log(`  up its own stairs ${pc(stats.stairs)}, a new way dug to the surface ${pc(stats.escape)}, a staircase of its own ${pc(stats.dug)}`);
  console.log(`  treads put back ${(stats.fixed / N).toFixed(1)} a quarry, blocks spent ${(stats.spent / N).toFixed(1)}${GATHER ? `, dug out of the wall ${(stats.gathered / N).toFixed(1)}` : ''}, about ${(stats.secs / N).toFixed(0)} s, house's cobblestone used up getting out ${pc(stats.reserveOk)}`);
  for (const [k, o] of Object.entries(byCarry).sort()) console.log(`  ${k.padEnd(44)} ${String(o.n).padStart(3)}: stairs ${String(o.stairs).padStart(3)}, new way ${String(o.escape).padStart(2)}, own staircase ${o.dug}`);
  process.exit(0);
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
