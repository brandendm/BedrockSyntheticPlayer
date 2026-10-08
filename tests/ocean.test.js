import test from 'node:test';
import assert from 'node:assert/strict';
import { oceanCourse, onLand, swimDistance, oceanCommands, POOL, OCEAN_KINDS, OCEAN_EXT } from '../behavior_pack/scripts/core/ocean.js';

test('the bot starts in deep water far from shore, whatever the seed', () => {
  for (const kind of OCEAN_KINDS) for (let seed = 1; seed <= 40; seed++) for (const level of [1, 2, 3]) {
    const c = oceanCourse(kind, seed, level);
    assert.ok(c.start.x > POOL.x1 + 10 && c.start.x < POOL.x2 - 10, `${kind} ${seed}: x ${c.start.x}`);
    assert.ok(Math.abs(c.start.z) <= 3);
    assert.equal(c.start.y, kind === 'oceandeep' ? POOL.bottom : POOL.top);
    assert.ok(swimDistance(c) >= 12 && swimDistance(c) <= 22, `${kind} ${seed}: swim ${swimDistance(c)}`);
    assert.equal(c.mobs.length, level >= 2 ? level : 0);
    for (const m of c.mobs) assert.ok(m.x >= POOL.x1 && m.x <= POOL.x2 && Math.abs(m.z) <= POOL.z2 && m.y >= POOL.bottom && m.y <= POOL.top, `${kind}: ${m.type} is out of the water`);
  }
});
test('onLand: in the pool is not land, the grass beside it is', () => {
  assert.equal(onLand(30, 1, 0), false);
  assert.equal(onLand(2, 1, 0), true);
  assert.equal(onLand(60, 1, 0), true);
  assert.equal(onLand(30, 1, 15.5), true);
  assert.equal(onLand(2, 0.2, 0), false);
});
test('the pool and the commands fit the slab', () => {
  const c = oceanCourse('oceandrop', 3, 2);
  assert.ok(POOL.x2 <= OCEAN_EXT.e && POOL.z2 <= OCEAN_EXT.r && POOL.bottom >= -9);
  assert.deepEqual(oceanCommands(c, 100, 150, 200), ['fill 106 142 186 150 150 214 water']);
});
