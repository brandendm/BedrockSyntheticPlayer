import test from 'node:test';
import assert from 'node:assert/strict';
import { tunnelCheck, cutOrder, stepTicks, TUNNEL_MIN } from '../behavior_pack/scripts/core/trunk.js';

const col = (n, y0 = 64) => Array.from({ length: n }, (_, i) => ({ x: 10, y: y0 + i, z: 5 }));
const world = (over = {}) => (x, y, z) => over[`${x},${y},${z}`] ?? (y < 64 ? 'grass_block' : x === 10 && z === 5 && y >= 64 && y < 70 ? 'oak_log' : 'air');

test('a plain trunk on grass, we stand level with its foot: yes', () => {
  assert.deepEqual(tunnelCheck(world(), col(5), 64), { ok: true, why: '' });
});

test('a stump of one or two logs is not worth stepping into', () => {
  assert.equal(tunnelCheck(world(), col(TUNNEL_MIN - 1), 64).ok, false);
  assert.equal(tunnelCheck(world(), col(TUNNEL_MIN), 64).ok, true);
});

test('not level with the foot of the trunk (a mound, a ledge): no', () => {
  assert.equal(tunnelCheck(world(), col(5), 63).ok, false);
  assert.equal(tunnelCheck(world(), col(5), 65).ok, false);
  assert.equal(tunnelCheck(world(), col(5), 64.2).ok, true);
});

test('nothing to stand on under it, or something that hurts: no', () => {
  for (const floor of ['air', 'water', 'lava', 'oak_leaves', 'magma', 'cactus', 'campfire', 'powder_snow', 'oak_slab', 'sweet_berry_bush']) {
    const r = tunnelCheck(world({ '10,63,5': floor }), col(5), 64);
    assert.equal(r.ok, false, `${floor} should not do`);
    assert.match(r.why, new RegExp(floor.split('_')[0]));
  }
  for (const floor of ['dirt', 'grass_block', 'podzol', 'stone', 'netherrack', 'mud', 'sand', 'gravel', 'crimson_nylium', 'mangrove_roots', 'moss_block']) {
    assert.equal(tunnelCheck(world({ '10,63,5': floor }), col(5), 64).ok, true, `${floor} should do`);
  }
});

test('something else in the cells we would stand in: no (leaves, a sign, a vine); a gap already cleared: yes', () => {
  assert.equal(tunnelCheck(world({ '10,65,5': 'oak_leaves' }), col(5), 64).ok, false);
  assert.equal(tunnelCheck(world({ '10,64,5': 'vine' }), col(5), 64).ok, false);
  assert.equal(tunnelCheck(world({ '10,65,5': 'air' }), col(5), 64).ok, true);
});

test('the order: eye height first (the crosshair is level there), then the foot, then up the column', () => {
  const o = cutOrder(col(6));
  assert.deepEqual(o.side.map((b) => b.y), [65, 64]);
  assert.deepEqual(o.up.map((b) => b.y), [66, 67, 68, 69]);
  // (A trunk with its second log already gone: the foot, then up.)
  const gap = col(6).filter((b) => b.y !== 65);
  const g = cutOrder(gap);
  assert.deepEqual(g.side.map((b) => b.y), [64]);
  assert.deepEqual(g.up.map((b) => b.y), [66, 67, 68, 69]);
});

test('the slide into the cell takes about as many ticks as the walk', () => {
  assert.equal(stepTicks(1.0), 6);
  assert.equal(stepTicks(0.1), 2);
  assert.ok(stepTicks(1.4) > stepTicks(1.0));
});
