import test from 'node:test';
import assert from 'node:assert/strict';
import { saplingFor, plantProblem, needs2x2, plantsOn } from '../behavior_pack/scripts/core/saplings.js';

const world = (blocks) => (p) => blocks[`${p.x},${p.y},${p.z}`] ?? 'air';

test('the sapling for each log; none for nether stems', () => {
  assert.equal(saplingFor('oak_log'), 'oak_sapling');
  assert.equal(saplingFor('stripped_birch_log'), 'birch_sapling');
  assert.equal(saplingFor('mangrove_log'), 'mangrove_propagule');
  assert.equal(saplingFor('crimson_stem'), null);
  assert.ok(needs2x2('dark_oak_sapling'));
  assert.ok(!needs2x2('spruce_sapling'));
});

test('ground: dirt types; propagules also on clay', () => {
  assert.ok(plantsOn('grass_block', 'oak_sapling'));
  assert.ok(!plantsOn('stone', 'oak_sapling'));
  assert.ok(!plantsOn('sand', 'oak_sapling'));
  assert.ok(plantsOn('clay', 'mangrove_propagule'));
  assert.ok(!plantsOn('clay', 'oak_sapling'));
});

test('a good stump spot, and the reasons a spot is refused', () => {
  const cell = { x: 0, y: 64, z: 0 };
  const at = world({ '0,63,0': 'grass_block' });
  assert.equal(plantProblem(cell, 'oak_sapling', { at }), null);
  assert.match(plantProblem(cell, 'oak_sapling', { at: world({ '0,63,0': 'stone' }) }), /ground/);
  assert.match(plantProblem(cell, 'oak_sapling', { at: world({ '0,63,0': 'dirt', '0,67,0': 'oak_log' }) }), /oak_log 3 up/);
  assert.equal(plantProblem(cell, 'oak_sapling', { at: world({ '0,63,0': 'dirt', '0,67,0': 'oak_leaves' }) }), null); // leaves decay
  assert.match(plantProblem(cell, 'oak_sapling', { at, light: () => 4 }), /dark/);
  assert.match(plantProblem(cell, 'oak_sapling', { at, avoid: [{ x: 3, z: 3, r: 8, why: 'too close to the house' }] }), /house/);
  assert.match(plantProblem(cell, 'oak_sapling', { at, others: [{ x: 1, z: 0 }] }), /next to/);
  assert.equal(plantProblem(cell, 'dark_oak_sapling', { at, others: [{ x: 1, z: 0 }] }), null); // 2x2 neighbours are the point
});
