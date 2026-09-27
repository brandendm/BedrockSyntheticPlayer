import test from 'node:test';
import assert from 'node:assert/strict';
import { planCrafts, nextStep, tableDecision, toolFor, shovelWorthIt, planksForLog, isLog, applyCraft, COBBLE_GOAL } from '../behavior_pack/scripts/core/recipes.js';

test('log families map to the right planks', () => {
  assert.equal(planksForLog('birch_log'), 'birch_planks');
  assert.equal(planksForLog('stripped_spruce_log'), 'spruce_planks');
  assert.equal(planksForLog('crimson_stem'), 'crimson_planks');
  assert.ok(isLog('dark_oak_log') && isLog('stripped_oak_log') && !isLog('oak_planks'));
});

test('3 logs cover table + pickaxe + sword; the shovel needs a 4th', () => {
  assert.equal(planCrafts({ oak_log: 3 }, ['crafting_table', 'wooden_pickaxe', 'wooden_sword']).logsShort, 0);
  assert.equal(planCrafts({ oak_log: 3 }, ['crafting_table', 'wooden_pickaxe', 'wooden_sword', 'wooden_shovel']).logsShort, 1);
  const p = planCrafts({ oak_log: 4 }, ['crafting_table', 'wooden_pickaxe', 'wooden_sword', 'wooden_shovel']);
  assert.equal(p.logsShort, 0);
  assert.equal(p.inv.wooden_pickaxe, 1);
  assert.equal(p.inv.wooden_shovel, 1);
});

test('reports how many logs are missing', () => {
  assert.equal(planCrafts({}, ['crafting_table', 'wooden_pickaxe']).logsShort, 3); // 4 + 3 + 2 planks = 9 -> 3 logs
  assert.equal(planCrafts({ birch_log: 1 }, ['crafting_table', 'wooden_pickaxe']).logsShort, 2);
});

test('applyCraft uses the right plank type', () => {
  const r = applyCraft({ spruce_log: 2 }, 'planks');
  assert.equal(r.inv.spruce_planks, 4);
  assert.equal(r.inv.spruce_log, 1);
});

test('tool choice: never a pickaxe on dirt', () => {
  const inv = { wooden_pickaxe: 1 };
  assert.equal(toolFor('dirt', inv), null); // fist, not pickaxe
  assert.equal(toolFor('grass_block', { ...inv, wooden_shovel: 1 }), 'wooden_shovel');
  assert.equal(toolFor('stone', inv), 'wooden_pickaxe');
  assert.equal(toolFor('coal_ore', { wooden_pickaxe: 1, stone_pickaxe: 1 }), 'stone_pickaxe');
});

test('shovel math: worth it for a staircase through dirt, not for two blocks', () => {
  assert.equal(shovelWorthIt({ blocksToDig: 12, canAffordFromInventory: true }).craft, true);
  assert.equal(shovelWorthIt({ blocksToDig: 2, canAffordFromInventory: true }).craft, false);
  assert.equal(shovelWorthIt({ blocksToDig: 12, canAffordFromInventory: false }).craft, false); // separate trip for wood
  // At the tree, one extra log (~3.5 s) + crafting (1.5 s) vs hand-digging: break-even around 13 blocks.
  assert.equal(shovelWorthIt({ blocksToDig: 12, canAffordFromInventory: false, alreadyAtTree: true }).craft, false);
  assert.equal(shovelWorthIt({ blocksToDig: 20, canAffordFromInventory: false, alreadyAtTree: true }).craft, true);
});

test('table: none remembered -> make one; close -> walk; far -> make one', () => {
  assert.equal(tableDecision({ dist: Infinity, inv: { oak_planks: 4 } }).choice, 'new');
  assert.equal(tableDecision({ dist: 3, inv: {} }).choice, 'use');
  assert.equal(tableDecision({ dist: 20, inv: { oak_planks: 8 } }).choice, 'walk');   // 4.7 s vs 5.5 s
  assert.equal(tableDecision({ dist: 60, inv: { oak_planks: 8 } }).choice, 'new');    // 14 s vs 5.5 s
  assert.equal(tableDecision({ dist: 60, inv: {} }).choice, 'walk');                  // no wood: 14 s vs 22.5 s
  assert.equal(tableDecision({ dist: 60, inv: { crafting_table: 1 } }).choice, 'new'); // just put it down
});

test('progression from nothing', () => {
  let s = nextStep({ inv: {}, exposedStoneKnown: false });
  assert.equal(s.step, 'gather_logs');
  assert.equal(s.count, 3);
  assert.deepEqual(s.wanted, ['crafting_table', 'wooden_pickaxe']);

  s = nextStep({ inv: { oak_log: 3 }, exposedStoneKnown: false });
  assert.deepEqual([s.step, s.items], ['craft', ['crafting_table']]);
  s = nextStep({ inv: { oak_log: 2, oak_planks: 4, crafting_table: 1 }, exposedStoneKnown: false });
  assert.equal(s.step, 'place_table');
  s = nextStep({ inv: { oak_log: 2, oak_planks: 4 }, tableDist: 2, exposedStoneKnown: false });
  assert.equal(s.step, 'craft');
  assert.ok(s.needsTable && s.items.includes('wooden_pickaxe'));
  s = nextStep({ inv: { oak_log: 4 }, tableDist: 2, exposedStoneKnown: false });
  assert.deepEqual(s.items, ['wooden_pickaxe'], 'wooden tier: the pickaxe only, no sword or shovel');

  // A remembered table nearby-ish: walk to it instead of spending a log.
  s = nextStep({ inv: { oak_log: 2 }, tableDist: 15, exposedStoneKnown: true });
  assert.equal(s.step, 'goto_table');
  assert.equal(s.dist, 15);
  // Remembered but far: make a new one.
  s = nextStep({ inv: { oak_log: 3 }, tableDist: 80, exposedStoneKnown: true });
  assert.deepEqual([s.step, s.items], ['craft', ['crafting_table']]);

  s = nextStep({ inv: { wooden_pickaxe: 1, wooden_sword: 1 }, tableDist: 2, exposedStoneKnown: false });
  assert.equal(s.step, 'get_stone', 'tables stay where they are now (remembered), no pickup');
  s = nextStep({ inv: { wooden_pickaxe: 1, cobblestone: COBBLE_GOAL, stick: 9 }, tableDist: 30, exposedStoneKnown: false });
  assert.equal(s.step, 'goto_table', 'no wood left: walking 30 blocks beats a trip for logs');
  s = nextStep({ inv: { wooden_pickaxe: 1, cobblestone: COBBLE_GOAL, stick: 9, oak_planks: 4 }, tableDist: 70, exposedStoneKnown: false });
  assert.deepEqual([s.step, s.items], ['craft', ['crafting_table']]);
  s = nextStep({ inv: { wooden_pickaxe: 1, cobblestone: COBBLE_GOAL, stick: 9 }, tableDist: 2, exposedStoneKnown: false });
  assert.deepEqual(s.items, ['stone_pickaxe', 'stone_sword', 'stone_axe', 'stone_shovel', 'stone_spear']);
  s = nextStep({ inv: { wooden_pickaxe: 1, cobblestone: COBBLE_GOAL, stick: 1, oak_planks: 1 }, tableDist: 2, exposedStoneKnown: false });
  assert.deepEqual([s.step, s.count], ['gather_logs', 1], 'short on sticks for stone tools -> one more log');
  s = nextStep({ inv: { stone_pickaxe: 1, stone_sword: 1 }, tableDist: 2, exposedStoneKnown: false });
  assert.deepEqual([s.step, s.need], ['get_stone', 5], 'axe, shovel and spear still to make');
  s = nextStep({ inv: { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, stone_spear: 1 }, tableDist: 2, exposedStoneKnown: false });
  assert.equal(s.step, 'done');
  s = nextStep({ inv: { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, cobblestone: 3, stick: 2 }, tableDist: 2, exposedStoneKnown: false });
  assert.deepEqual(s.items, ['stone_spear'], 'a spear for creepers: one cobblestone, two sticks');
});
