import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSlot, partition, siteAt, minApart, queueOf } from '../behavior_pack/scripts/core/poolplan.js';

test('nextSlot skips busy sites, wraps, and says null when all eight are held', () => {
  assert.equal(nextSlot(3, new Set()), 3);
  assert.equal(nextSlot(3, new Set([3, 4])), 5);
  assert.equal(nextSlot(7, new Set([7])), 0);
  assert.equal(nextSlot(0, new Set([0, 1, 2, 3, 4, 5, 6, 7])), null);
});
test('partition keeps order and sends the unclassified to serial', () => {
  const p = partition(['a', 'b', 'c', 'd', 'e'], (n) => ({ a: 'calm', c: 'calm', d: 'combat' }[n] ?? null));
  assert.deepEqual(p, { calm: ['a', 'c'], combat: ['d'], serial: ['b', 'e'] });
});
test('sites on the 96-block ring are 73 apart: clear of mobs that notice within 35, items cleared within 30', () => {
  assert.ok(minApart(96) > 70);
  const a = siteAt({ x: 100, z: 100, r: 96 }, 0), b = siteAt({ x: 100, z: 100, r: 96 }, 1);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 70);
  assert.equal(a.x, 196);
});
test('queueOf hands out each job once', () => {
  const next = queueOf([1, 2]);
  assert.deepEqual([next(), next(), next()], [1, 2, undefined]);
});
