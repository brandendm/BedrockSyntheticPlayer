import test from 'node:test';
import assert from 'node:assert/strict';
import { findPath, smoothPath, Cell } from '../behavior_pack/scripts/core/pathfinder.js';
import { makeWorld } from './helpers.js';

const at = (p) => `${p.x},${p.y},${p.z}`;

test('straight line on flat ground', () => {
  const w = makeWorld();
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 });
  assert.equal(r.complete, true);
  assert.equal(r.path.length, 11);
});

test('detours around a 2-high wall and never cuts corners', () => {
  const solids = [];
  for (let z = -5; z <= 5; z++) solids.push([5, 64, z], [5, 65, z]);
  const w = makeWorld({ solids });
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 });
  assert.equal(r.complete, true);
  for (const p of r.path) assert.equal(w.classify(p.x, p.y, p.z), Cell.AIR, `inside wall at ${at(p)}`);
  for (let i = 1; i < r.path.length; i++) {
    const a = r.path[i - 1], b = r.path[i];
    if (a.x !== b.x && a.z !== b.z) {
      assert.equal(w.classify(b.x, a.y, a.z), Cell.AIR, 'diagonal clipped a corner');
      assert.equal(w.classify(a.x, a.y, b.z), Cell.AIR, 'diagonal clipped a corner');
    }
  }
});

test('steps up one block and drops down', () => {
  const w = makeWorld({ ground: (x) => (x >= 3 && x <= 5 ? 65 : 64) });
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 });
  assert.equal(r.complete, true);
  assert.ok(r.path.some((p) => p.y === 65), 'went over the bump');
});

test('cannot jump a 2-block ledge; returns best partial path', () => {
  const w = makeWorld({ ground: (x) => (x >= 3 ? 66 : 64) });
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 8, y: 66, z: 0 }, { maxNodes: 3000 });
  assert.equal(r.complete, false);
  assert.ok(r.path.length > 1);
});

test('avoids danger blocks', () => {
  const danger = [];
  for (let z = -1; z <= 1; z++) danger.push([4, 63, z]); // lava as floor
  const w = makeWorld({ danger });
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 });
  assert.equal(r.complete, true);
  for (const p of r.path) assert.notEqual(w.classify(p.x, p.y - 1, p.z), Cell.DANGER);
});

test('smoothing collapses a straight run and keeps height changes', () => {
  const w = makeWorld({ ground: (x) => (x >= 6 ? 65 : 64) });
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 12, y: 65, z: 0 });
  const s = smoothPath(w.classify, r.path);
  assert.ok(s.length < r.path.length);
  assert.ok(s.length <= 4, `expected few waypoints, got ${s.length}`);
  assert.ok(s.some((p) => p.y === 65));
});

// River: columns x=5..7 are water from y=61 to 63 (surface at 63), banks stand at y=64.
function river(width = 3, length = 40) {
  const water = [];
  for (let x = 5; x < 5 + width; x++) for (let z = -length; z <= length; z++) for (let y = 61; y <= 63; y++) water.push([x, y, z]);
  return makeWorld({ ground: (x, z) => (x >= 5 && x < 5 + width && Math.abs(z) <= length ? 61 : 64), water });
}

test('swims across a river it cannot walk around', () => {
  const w = river();
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 12, y: 64, z: 0 });
  assert.equal(r.complete, true);
  assert.ok(r.path.some((p) => w.classify(p.x, p.y, p.z) === Cell.LIQUID), 'went through water');
  assert.ok(r.path.every((p) => w.classify(p.x, p.y + 1, p.z) === Cell.AIR), 'head always above water');
});

test('prefers a slightly longer dry route over swimming', () => {
  const w = river(3, 3); // short pond: land route around it exists
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 12, y: 64, z: 0 });
  assert.equal(r.complete, true);
  assert.ok(!r.path.some((p) => w.classify(p.x, p.y, p.z) === Cell.LIQUID), 'walked around the pond');
});

test('gets out of water onto the nearest bank', () => {
  const w = river(5);
  const r = findPath(w.classify, { x: 7, y: 63, z: 0 }, { x: 2, y: 64, z: 0 });
  assert.equal(r.complete, true);
  assert.equal(r.path[r.path.length - 1].y, 64);
});

test('goalTest: nearest dry land from the middle of a lake', () => {
  const w = river(9);
  const r = findPath(w.classify, { x: 7, y: 63, z: 0 }, { x: 7, y: 63, z: 0 }, { goalTest: (x, y, z, v) => v.standable(x, y, z) });
  assert.equal(r.complete, true);
  const end = r.path[r.path.length - 1];
  assert.ok(end.x === 4 || end.x === 14, `ended at x=${end.x}`);
  assert.ok(r.path.length <= 5, 'took the short way out');
});

test('a partial path never stops in the water', () => {
  const w = river(30, 40); // lake too big for the node budget
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 60, y: 64, z: 0 }, { maxNodes: 400 });
  assert.equal(r.complete, false);
  const end = r.path[r.path.length - 1];
  assert.notEqual(w.classify(end.x, end.y, end.z), Cell.LIQUID);
});

test('never swims onto a sheet of water hanging over a drop', () => {
  // water at y=63 over x=5..7 but nothing under it down to y=40
  const water = [];
  for (let x = 5; x <= 7; x++) for (let z = -3; z <= 3; z++) water.push([x, 63, z]);
  const w = makeWorld({ ground: (x, z) => (x >= 5 && x <= 7 && Math.abs(z) <= 3 ? 40 : 64), water });
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 12, y: 64, z: 0 });
  assert.ok(r.path.every((p) => !(p.x >= 5 && p.x <= 7 && Math.abs(p.z) <= 3)), 'went around');
});

test('climbs a ladder up a 4-high cliff and steps off at the top', () => {
  const ladder = new Set([64, 65, 66, 67].map((y) => `2,${y},0`));
  const base = makeWorld({ ground: (x) => (x >= 3 ? 68 : 64) });
  const classify = (x, y, z) => (ladder.has(`${x},${y},${z}`) ? Cell.CLIMB : base.classify(x, y, z));
  const r = findPath(classify, { x: 0, y: 64, z: 0 }, { x: 6, y: 68, z: 0 });
  assert.equal(r.complete, true);
  assert.ok(r.path.some((p) => p.x === 2 && p.y === 66), 'went up the ladder');
  const noLadder = findPath(base.classify, { x: 0, y: 64, z: 0 }, { x: 6, y: 68, z: 0 }, { maxNodes: 3000 });
  assert.equal(noLadder.complete, false);
});

// ---------- digging and pillaring ----------
const digAll = (secs = 0.75) => ({ breakCost: () => secs, placeCost: 0.8, budget: 64, unitsPerSecond: 4.3 });

test('actions: digs out of a sealed 1x1 hole by pillaring up and back onto the ground', () => {
  // A hole two deep at x=0: floor at 61 (stand at 62), ground elsewhere stands at 64.
  const w = makeWorld({ ground: (x, z) => (x === 0 && z === 0 ? 62 : 64) });
  const plain = findPath(w.classify, { x: 0, y: 62, z: 0 }, { x: 5, y: 64, z: 0 }, { maxNodes: 2000 });
  assert.equal(plain.complete, false);
  const r = findPath(w.classify, { x: 0, y: 62, z: 0 }, { x: 5, y: 64, z: 0 }, { actions: digAll(), maxNodes: 5000 });
  assert.equal(r.complete, true);
  assert.ok(r.path.some((p) => p.move), 'used an action');
});

test('actions: never places more blocks than it has', () => {
  const w = makeWorld({ ground: (x) => (x >= 2 ? 70 : 64) }); // a 6-high cliff
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 4, y: 70, z: 0 }, { actions: { ...digAll(Infinity), budget: 3 }, maxNodes: 4000 });
  assert.equal(r.complete, false); // can't dig (infinite cost) and 3 blocks can't reach 6 up
  const r2 = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 4, y: 70, z: 0 }, { actions: { ...digAll(Infinity), budget: 8 }, maxNodes: 4000 });
  assert.equal(r2.complete, true);
  assert.ok(r2.path.filter((p) => p.move?.place).length <= 8);
});

test('actions: tunnels through a wall when walking round is far', () => {
  const solids = [];
  for (let z = -40; z <= 40; z++) for (const y of [64, 65, 66]) solids.push([5, y, z]);
  const w = makeWorld({ solids });
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, { actions: digAll(0.6), maxNodes: 6000 });
  assert.equal(r.complete, true);
  assert.ok(r.path.some((p) => p.move?.type === 'dig'), 'dug through');
  assert.ok(r.path.length < 20);
});

test('actions: bridges a gap too deep to climb down, then walks on from the bridge', () => {
  // A 3-wide chasm 30 deep across the whole map.
  const w = makeWorld({ ground: (x) => (x >= 3 && x <= 5 ? 34 : 64) });
  const plain = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 9, y: 64, z: 0 }, { maxNodes: 3000 });
  assert.equal(plain.complete, false);
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 9, y: 64, z: 0 }, { actions: { ...digAll(Infinity), budget: 5 }, maxNodes: 6000 });
  assert.equal(r.complete, true);
  const bridges = r.path.filter((p) => p.move?.type === 'bridge');
  assert.equal(bridges.length, 3, `bridged ${bridges.length} blocks`);
  assert.ok(r.path.every((p) => p.y === 64), 'stays level');
  const none = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 9, y: 64, z: 0 }, { actions: { ...digAll(Infinity), budget: 2 }, maxNodes: 6000 });
  assert.equal(none.complete, false, "can't bridge 3 with 2 blocks");
});

test('leap: plain walking search jumps a 1-wide ditch rather than climbing through it', () => {
  const w = makeWorld({ ground: (x) => (x === 3 ? 61 : 64) });
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 7, y: 64, z: 0 });
  assert.equal(r.complete, true);
  assert.equal(r.path.filter((p) => p.move?.type === 'leap').length, 1);
  assert.ok(smoothPath(w.classify, r.path).some((p) => p.leap), 'the motor is told to jump');
});

test('wetPartial: a crossing too long for one search still makes progress out over the water', () => {
  // Land at x <= 2, sea (surface at 63, floor 55) to x = 400.
  const water = [];
  for (let x = 3; x <= 60; x++) for (let z = -3; z <= 3; z++) for (let y = 55; y <= 63; y++) water.push([x, y, z]);
  const w = makeWorld({ ground: (x) => (x <= 2 ? 64 : 55), water });
  const dry = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 400, y: 64, z: 0 }, { maxNodes: 1500 });
  const wet = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 400, y: 64, z: 0 }, { maxNodes: 1500, wetPartial: true });
  const end = (r) => r.path[r.path.length - 1].x;
  assert.ok(end(dry) <= 2, 'default: stops on the shore');
  assert.ok(end(wet) > 20, `wetPartial: gets ${end(wet)} out`);
});

test('cost: breaking through a thin wall beats a long detour, not a short one', () => {
  // A 2-high wall of roots across x = 5, z -12..12 (long way round) vs z -1..1 (a step aside).
  const wall = (half) => { const s = []; for (let z = -half; z <= half; z++) s.push([5, 64, z], [5, 65, z]); return makeWorld({ solids: s }); };
  const roots = { breakCost: () => 0.7 * 1.5 / 2 + 0.25, placeCost: 0.8, budget: 0, unitsPerSecond: 4.3 }; // axe-ish
  const long = wall(12);
  const around = findPath(long.classify, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 });
  const through = findPath(long.classify, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, { actions: roots });
  assert.ok(around.complete && through.complete);
  assert.ok(through.cost < around.cost * 0.85, `through ${through.cost.toFixed(1)} vs around ${around.cost.toFixed(1)}`);
  const short = wall(1);
  const a2 = findPath(short.classify, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 });
  const t2 = findPath(short.classify, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, { actions: roots });
  assert.ok(!(t2.cost < a2.cost * 0.85), 'a step round is still better than digging');
});

test('a goal sealed off (a pocket in the rock, a pen): gives up early, not after the whole budget', () => {
  // A 3x3 room with walls and a roof, around x = 30; we're outside.
  const solids = [];
  for (let x = 28; x <= 32; x++) for (let z = -2; z <= 2; z++) for (let y = 64; y <= 68; y++) {
    if (Math.abs(x - 30) < 2 && Math.abs(z) < 2 && y < 67) continue;
    solids.push([x, y, z]);
  }
  const w = makeWorld({ solids });
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 30, y: 64, z: 0 }, { maxNodes: 20000 });
  assert.equal(r.complete, false);
  assert.equal(r.unreachable, true);
  assert.ok(r.expanded <= 1000, `expanded ${r.expanded}`);
});

test('the early give-up never gives up on a goal we can drop down to (a 3-deep pit)', () => {
  const pit = (x, z) => (Math.abs(x - 20) <= 1 && Math.abs(z) <= 1 ? 61 : 64);
  const w = makeWorld({ ground: pit });
  const r = findPath(w.classify, { x: 0, y: 64, z: 0 }, { x: 20, y: 61, z: 0 }, { maxNodes: 20000, probeAt: 5 });
  assert.equal(r.complete, true);
});
