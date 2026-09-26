import test from 'node:test';
import assert from 'node:assert/strict';
import { traitsOf, wantScore, biomeName, classifyTop, onIsland, searchFor } from '../behavior_pack/scripts/core/biomes.js';

test('biome traits: sheep on plains, not deserts or oceans; trees in forests', () => {
  assert.equal(wantScore('minecraft:plains', 'sheep'), 3);
  assert.equal(wantScore('minecraft:sunflower_plains', 'sheep'), 3);
  assert.equal(wantScore('minecraft:desert', 'sheep'), 0);
  assert.equal(wantScore('minecraft:deep_ocean', 'sheep'), 0);
  assert.equal(wantScore('minecraft:mushroom_island', 'log'), 0);
  assert.equal(wantScore('minecraft:roofed_forest', 'log'), 3);
  assert.equal(wantScore('minecraft:bamboo_jungle', 'trees'), 3);
  assert.equal(wantScore('minecraft:stone_beach', 'stone'), 3);
  assert.equal(traitsOf('minecraft:deep_dark').land, true, 'deep dark is not an ocean');
  assert.equal(traitsOf('minecraft:frozen_river').land, false);
  assert.equal(wantScore('minecraft:beach', 'land'), 3);
  assert.equal(wantScore('minecraft:warm_ocean', 'land'), 0);
  assert.equal(biomeName('minecraft:roofed_forest'), 'dark forest');
  assert.ok(searchFor('log').includes('minecraft:forest'));
});

test('surface samples and island detection', () => {
  assert.equal(classifyTop('minecraft:water'), 'water');
  assert.equal(classifyTop('minecraft:oak_leaves'), 'trees');
  assert.equal(classifyTop('minecraft:grass_block'), 'land');
  assert.equal(classifyTop('minecraft:stone'), 'stone');
  const ring = (w, n = 12) => Array.from({ length: n }, (_, i) => ({ kind: i < w ? 'water' : 'land', dist: 24 }));
  assert.equal(onIsland(300, ring(10)), true);
  assert.equal(onIsland(300, ring(4)), false, 'coast, not an island');
  assert.equal(onIsland(5000, ring(12)), false, 'a big landmass by the sea');
});
