import test from 'node:test';
import assert from 'node:assert/strict';
import { fallDamage, ticksToLand, mlgNow } from '../behavior_pack/scripts/core/fall.js';
import { advanceStep } from '../behavior_pack/scripts/core/advance.js';

test('fall damage and landing time, Minecraft style', () => {
  assert.equal(fallDamage(3), 0);
  assert.equal(fallDamage(3.5), 1);
  assert.equal(fallDamage(20), 17);
  assert.equal(ticksToLand(20, 0, 0), 25); // 20 blocks from standing: 1.25 s
});

test('water bucket: only for a fall worth breaking, once the landing block is in reach, or on the last tick', () => {
  // 4 blocks: 1 damage, not worth it (unless it would kill us).
  assert.equal(mlgNow({ fallFrom: 4, y: 2, vy: -0.4, groundY: 0 }).place, false);
  assert.equal(mlgNow({ fallFrom: 4, y: 2, vy: -0.4, groundY: 0, health: 1 }).place, true);
  // 20 blocks: not yet at 10 up, yes at 3 up (eye 4.6 from the block's top).
  assert.equal(mlgNow({ fallFrom: 20, y: 10, vy: -1.2, groundY: 0 }).place, false);
  assert.equal(mlgNow({ fallFrom: 20, y: 3, vy: -1.5, groundY: 0 }).place, true);
  // Very fast: out of reach now but we'd hit the ground next tick: now or never.
  assert.equal(mlgNow({ fallFrom: 100, y: 3.6, vy: -3.9, groundY: 0 }).place, true);
});

test('a water bucket is kept filled, up top and not in the Nether', () => {
  const kit = { stone_pickaxe: 1, stone_sword: 1, iron_pickaxe: 1, bucket: 1, cooked_beef: 8 };
  const f = { inv: kit, worn: [], tableDist: 3, waterNearHouse: true, farm: { tiles: 8, planted: 8, ripe: 0 }, smelt: null, furnaceDist: 3 };
  assert.equal(advanceStep({ ...f, canFillBucket: true }).step, 'fill_bucket');
  assert.notEqual(advanceStep({ ...f, canFillBucket: false }).step, 'fill_bucket');
  assert.notEqual(advanceStep({ ...f, canFillBucket: true, underground: true }).step, 'fill_bucket');
  assert.notEqual(advanceStep({ ...f, canFillBucket: true, inv: { ...kit, bucket: 0, water_bucket: 1 } }).step, 'fill_bucket');
});
