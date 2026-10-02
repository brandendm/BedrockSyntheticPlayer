import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFrames, floorCells, standPoint } from '../behavior_pack/scripts/core/portal.js';

// A frame in the x/y plane at z = 5: obsidian x 10..13, y 65..69 (inside x 11..12, y 66..68), standing on a ground of grass at y 64.
function world(extra = {}) {
  const m = new Map();
  const K = (x, y, z) => `${x},${y},${z}`;
  for (let x = 0; x < 30; x++) for (let z = 0; z < 12; z++) { m.set(K(x, 64, z), 'minecraft:grass_block'); for (let y = 65; y < 75; y++) m.set(K(x, y, z), 'minecraft:air'); }
  for (let x = 10; x <= 13; x++) { m.set(K(x, 65, 5), 'minecraft:obsidian'); m.set(K(x, 69, 5), 'minecraft:obsidian'); }
  for (let y = 65; y <= 69; y++) { m.set(K(10, y, 5), 'minecraft:obsidian'); m.set(K(13, y, 5), 'minecraft:obsidian'); }
  for (const [k, v] of Object.entries(extra)) m.set(k, v);
  return (x, y, z) => m.get(K(x, y, z)) ?? null;
}

test('a frame is found, with its inside and where to stand', () => {
  const [f] = findFrames(world(), { x: 15, y: 66, z: 8 }, 12);
  assert.ok(f);
  assert.equal(f.axis, 'x');
  assert.deepEqual([f.x0, f.y0, f.z0, f.w, f.h], [11, 66, 5, 2, 3]);
  assert.equal(f.lit, false);
  assert.equal(f.missing.length, 0);
  const cells = floorCells(f);
  assert.equal(cells.length, 2);
  assert.deepEqual(standPoint(cells[0]), { x: cells[0].x + 0.5, y: 66, z: 5.5 });
});

test('a lit frame says so, and a ruined one is found only when a repair is allowed', () => {
  const lit = world({ '11,66,5': 'minecraft:portal', '12,66,5': 'minecraft:portal', '11,67,5': 'minecraft:portal', '12,67,5': 'minecraft:portal', '11,68,5': 'minecraft:portal', '12,68,5': 'minecraft:portal' });
  assert.equal(findFrames(lit, { x: 15, y: 66, z: 8 }, 12)[0].lit, true);
  const ruined = world({ '13,67,5': 'minecraft:air' });
  assert.equal(findFrames(ruined, { x: 15, y: 66, z: 8 }, 12).length, 0);
  const [f] = findFrames(ruined, { x: 15, y: 66, z: 8 }, 12, 8, { allowMissing: 1 });
  assert.ok(f);
  assert.deepEqual(f.missing, [{ x: 13, y: 67, z: 5 }]);
});

test('no frame, no answer', () => assert.equal(findFrames(world(), { x: 25, y: 66, z: 10 }, 4).length, 0));
