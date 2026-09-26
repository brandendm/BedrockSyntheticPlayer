import test from 'node:test';
import assert from 'node:assert/strict';
import { burnsFor, planFuel, charcoalInput } from '../behavior_pack/scripts/core/fuel.js';

test('Bedrock fuel values; nether wood does not burn', () => {
  assert.equal(burnsFor('charcoal'), 8);
  assert.equal(burnsFor('oak_planks'), 1.5);
  assert.equal(burnsFor('birch_log'), 1.5);
  assert.equal(burnsFor('oak_slab'), 1.5); // 0.75 on Java
  assert.equal(burnsFor('wooden_pickaxe'), 1);
  assert.equal(burnsFor('stick'), 0.5);
  assert.equal(burnsFor('oak_sapling'), 0.5);
  assert.equal(burnsFor('crimson_planks'), 0);
  assert.equal(burnsFor('warped_stem'), 0);
  assert.equal(charcoalInput('crimson_stem'), false);
  assert.equal(charcoalInput('stripped_oak_log'), true);
});

test('2 logs to cook with planks in hand: 2 planks (3 items of fuel), nothing crafted', () => {
  const p = planFuel({ oak_log: 2, oak_planks: 5 }, 'oak_log', 2);
  assert.deepEqual(p, { k: 2, fuel: 'oak_planks', n: 2, plankFrom: null, planks: 0 });
});

test('only one kind of log: plank one (6 items), cook the rest, never burn a raw log', () => {
  const p = planFuel({ birch_log: 2 }, 'birch_log', 2);
  assert.equal(p.plankFrom, 'birch_log');
  assert.equal(p.planks, 1);
  assert.equal(p.fuel, 'birch_planks');
  assert.equal(p.k, 1);
  const q = planFuel({ birch_log: 4 }, 'birch_log', 3);
  assert.deepEqual([q.k, q.fuel, q.n, q.planks], [3, 'birch_planks', 2, 1]); // 3 cooked, 1 log planked
});

test('another kind of log: plank that instead of cutting the batch', () => {
  const p = planFuel({ birch_log: 2, oak_log: 1 }, 'birch_log', 2);
  assert.deepEqual([p.k, p.fuel, p.plankFrom], [2, 'oak_planks', 'oak_log']);
});

test('junk first: saplings for 1 item, not a plank', () => {
  const p = planFuel({ mutton: 1, oak_planks: 4, oak_sapling: 5 }, 'mutton', 1); // 2 kept for replanting
  assert.equal(p.fuel, 'oak_sapling');
  assert.equal(p.n, 2);
});

test('outgrown wooden tools burn; the only pickaxe does not', () => {
  assert.equal(planFuel({ beef: 1, wooden_pickaxe: 1, stone_pickaxe: 1 }, 'beef', 1).fuel, 'wooden_pickaxe');
  assert.equal(planFuel({ beef: 1, wooden_pickaxe: 1 }, 'beef', 1), null);
});

test('coal for 8, not for 2 (a charcoal is 4 torches)', () => {
  assert.equal(planFuel({ oak_log: 8, coal: 1, oak_planks: 6 }, 'oak_log', 8).fuel, 'coal');
  assert.equal(planFuel({ oak_log: 2, charcoal: 1, oak_planks: 2 }, 'oak_log', 2).fuel, 'oak_planks');
});

test('sticks for torches are kept', () => {
  assert.equal(planFuel({ mutton: 1, stick: 2 }, 'mutton', 1, { keepSticks: 2 }), null);
  assert.equal(planFuel({ mutton: 1, stick: 4 }, 'mutton', 1, { keepSticks: 2 }).fuel, 'stick');
});

test('short on fuel: cook what 1 plank covers (1 of 3 mutton) instead of refusing', () => {
  const p = planFuel({ mutton: 3, oak_planks: 1 }, 'mutton', 3);
  assert.deepEqual([p.k, p.fuel, p.n], [1, 'oak_planks', 1]);
});

test('crimson planks are no fuel', () => {
  assert.equal(planFuel({ mutton: 2, crimson_planks: 10 }, 'mutton', 2), null);
});

test('saplings kept for replanting are not burned', () => {
  assert.equal(planFuel({ mutton: 1, oak_sapling: 2, oak_planks: 1 }, 'mutton', 1).fuel, 'oak_planks');
  assert.equal(planFuel({ mutton: 1, dark_oak_sapling: 4, oak_planks: 1 }, 'mutton', 1).fuel, 'oak_planks');
});

test('leaf litter: 0.5 an item, burned before planks, nothing wasted on odd batches', () => {
  assert.equal(burnsFor('leaf_litter'), 0.5);
  assert.deepEqual(planFuel({ mutton: 1, leaf_litter: 10, oak_planks: 4 }, 'mutton', 1), { k: 1, fuel: 'leaf_litter', n: 2, plankFrom: null, planks: 0 });
  assert.equal(planFuel({ oak_log: 3, leaf_litter: 6, oak_planks: 4 }, 'oak_log', 3).fuel, 'leaf_litter');
  // 8 items: 16 litter beats spending a charcoal (4 torches' worth)
  assert.equal(planFuel({ oak_log: 8, leaf_litter: 20, charcoal: 1 }, 'oak_log', 8).fuel, 'leaf_litter');
});
