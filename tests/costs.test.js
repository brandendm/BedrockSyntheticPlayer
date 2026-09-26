import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseTool, breakSeconds, cheapestPlaceable, spendableBlocks, blockSourceCost, dropsWith } from '../behavior_pack/scripts/core/costs.js';

test('dirt: fist, never the pickaxe; a shovel is fine (faster, cheap wear)', () => {
  assert.equal(chooseTool('dirt', { diamond_pickaxe: 1 }).tool, null);
  assert.equal(chooseTool('dirt', { wooden_shovel: 1, diamond_pickaxe: 1 }).tool, 'wooden_shovel');
  assert.equal(chooseTool('oak_leaves', { diamond_axe: 1, iron_pickaxe: 1 }).tool, null);
});

test('stone: needs a pickaxe for the drop; the cheapest suitable one wins', () => {
  assert.equal(chooseTool('stone', {}), null);                              // no drop by hand
  assert.equal(chooseTool('stone', {}, { needDrop: false }).tool, null);    // but can be punched through
  assert.equal(chooseTool('stone', {}, { needDrop: false }).seconds, 7.5);
  assert.equal(chooseTool('stone', { wooden_pickaxe: 1, stone_pickaxe: 1 }).tool, 'stone_pickaxe');
  assert.equal(chooseTool('iron_ore', { wooden_pickaxe: 1 }), null);        // wood can't harvest iron
  assert.equal(chooseTool('iron_ore', { wooden_pickaxe: 1, stone_pickaxe: 1 }).tool, 'stone_pickaxe');
  assert.ok(dropsWith('diamond_ore', 'iron_pickaxe') && !dropsWith('diamond_ore', 'stone_pickaxe'));
});

test('break times match Bedrock', () => {
  assert.equal(breakSeconds('dirt', null), 0.75);
  assert.equal(breakSeconds('stone', 'wooden_pickaxe'), 1.125);
  assert.equal(breakSeconds('deepslate', null), 15);
});

test('build with dirt, keep the cobblestone (and never dip into the reserve first)', () => {
  assert.equal(cheapestPlaceable({ cobblestone: 20, dirt: 3 }), 'dirt');
  assert.equal(cheapestPlaceable({ cobblestone: 20, oak_planks: 4 }), 'cobblestone');
  assert.equal(cheapestPlaceable({ cobblestone: 8, andesite: 1 }, { cobblestone: 8 }), 'andesite');
  assert.equal(spendableBlocks({ cobblestone: 10, dirt: 2 }, { cobblestone: 8 }), 4);
});

test('getting blocks to build with: dirt by fist beats stone with a pickaxe at the same distance', () => {
  const inv = { stone_pickaxe: 1 };
  assert.ok(blockSourceCost('dirt', inv, 3) < blockSourceCost('stone', inv, 3));
  assert.equal(blockSourceCost('stone', {}, 1), Infinity); // punched stone drops nothing
  assert.ok(blockSourceCost('dirt', {}, 10) > blockSourceCost('dirt', {}, 1));
});

test('planks are never a throwaway block: dirt or cobblestone first, planks only if nothing else', async () => {
  const { cheapestPlaceable, plankReserve, spendableBlocks } = await import('../behavior_pack/scripts/core/costs.js');
  const inv = { oak_planks: 40, cobblestone: 5 };
  assert.equal(cheapestPlaceable(inv, plankReserve(inv)), 'cobblestone');
  assert.equal(spendableBlocks({ oak_planks: 40 }, plankReserve({ oak_planks: 40 })), 0);
  assert.equal(cheapestPlaceable({ oak_planks: 3 }, plankReserve({ oak_planks: 3 })), 'oak_planks'); // nothing else at all
});
