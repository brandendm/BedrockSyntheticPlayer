import test from 'node:test';
import assert from 'node:assert/strict';
import { goodSpawnColumn, spiral } from '../behavior_pack/scripts/core/spawnpick.js';
test('dry land at the surface is a good spawn, water, trees and bedrock level are not', () => {
  assert.equal(goodSpawnColumn('minecraft:grass_block', 70), true);
  assert.equal(goodSpawnColumn('minecraft:sand', 64), true);
  assert.equal(goodSpawnColumn('minecraft:water', 62), false);
  assert.equal(goodSpawnColumn('minecraft:oak_leaves', 80), false);
  assert.equal(goodSpawnColumn('minecraft:stone', 0), false);
  assert.equal(goodSpawnColumn('minecraft:grass_block', 40), false);
  assert.equal(goodSpawnColumn('minecraft:lava', 70), false);
  assert.equal(goodSpawnColumn(undefined, 70), false);
});
test('the spiral starts at the centre and grows outward without repeats', () => {
  const s = spiral(0, 0, 48, 50);
  assert.deepEqual(s[0], { x: 0, z: 0 });
  assert.equal(new Set(s.map((c) => `${c.x},${c.z}`)).size, 50);
  const d = s.map((c) => Math.max(Math.abs(c.x), Math.abs(c.z)));
  for (let i = 1; i < d.length; i++) assert.ok(d[i] >= d[i - 1]);
});
