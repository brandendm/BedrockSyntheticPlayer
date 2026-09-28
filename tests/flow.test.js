import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepOrder, sweepLength } from '../behavior_pack/scripts/core/flow.js';
import { makeRng } from '../behavior_pack/scripts/core/mathutil.js';

const eye = { x: 0.5, y: 65.62, z: 0.5 };
const look = { yaw: 0, pitch: 0 }; // looking along +x

test('a wall face is swept block to block, not back and forth', () => {
  // A 5 wide, 3 high wall 3 blocks ahead.
  const wall = [];
  for (let z = -2; z <= 2; z++) for (let y = 64; y <= 66; y++) wall.push({ x: 3, y, z });
  const r = makeRng(1);
  const shuffled = [...wall].sort(() => r() - 0.5);
  const swept = sweepOrder(eye, look, shuffled, { mode: 'place', supported: () => true });
  assert.equal(swept.length, wall.length);
  assert.ok(sweepLength(eye, look, swept) < sweepLength(eye, look, shuffled) * 0.6, 'much less turning than any old order');
  // Every move is to a neighbouring block (at most one step each way).
  for (let i = 1; i < swept.length; i++) {
    const a = swept[i - 1], b = swept[i];
    assert.ok(Math.abs(a.y - b.y) <= 1 && Math.abs(a.z - b.z) <= 1, `jump from ${JSON.stringify(a)} to ${JSON.stringify(b)}`);
  }
});

test('breaking: a tunnel step is head then feet; placing: feet then head', () => {
  const head = { x: 1, y: 66, z: 0 }, feet = { x: 1, y: 65, z: 0 };
  assert.deepEqual(sweepOrder(eye, look, [feet, head], { mode: 'break' }), [head, feet]);
  assert.deepEqual(sweepOrder(eye, look, [head, feet], { mode: 'place', supported: () => true }), [feet, head]);
});

test('placing only goes where there is something to put it against', () => {
  // A column over a gap: only the bottom one touches the ground at first; each one placed supports the next.
  const col = [{ x: 2, y: 66, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 2, y: 65, z: 0 }];
  const supported = (c, placed) => c.y === 64 || placed.has(`${c.x},${c.y - 1},${c.z}`);
  assert.deepEqual(sweepOrder(eye, look, col, { mode: 'place', supported }).map((c) => c.y), [64, 65, 66]);
  const floating = [{ x: 2, y: 70, z: 0 }];
  assert.deepEqual(sweepOrder(eye, look, floating, { mode: 'place', supported: () => false }), [], 'never one in mid-air');
});

test('a route through a patch: nearest first, each stop covering what is near it', async () => {
  const { tourStops } = await import('../behavior_pack/scripts/core/flow.js');
  const cells = [];
  for (let x = 3; x <= 12; x++) for (let z = -1; z <= 1; z++) cells.push({ x, y: 64, z });
  const stops = tourStops({ x: 0.5, y: 64, z: 0.5 }, cells, 2.5);
  assert.ok(stops.length >= 3 && stops.length <= 5, `${stops.length} stops`);
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i].x > stops[i - 1].x, 'onward, not back and forth');
  for (const c of cells) assert.ok(stops.some((s) => Math.hypot(c.x - s.x, c.z - s.z) <= 2.5), `${c.x},${c.z} passed within reach`);
});
