import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainItem, chainStep, chainOutline } from '../behavior_pack/scripts/core/chain.js';

const f = (inv, more = {}) => ({ inv, tableDist: Infinity, furnaceKnown: false, smelt: null, oreCooking: 0, ...more });

test('names as typed', () => {
  assert.equal(chainItem('Iron Pickaxe'), 'iron_pickaxe');
  assert.equal(chainItem('minecraft:stone'), 'cobblestone');
  assert.equal(chainItem('logs'), 'log');
  assert.equal(chainItem('diamond'), null);
});

test('an iron pickaxe from nothing starts with wood, then stone, then iron', () => {
  assert.equal(chainStep('iron_pickaxe', 1, f({}))?.step, 'gather_logs');
  const woodTools = f({ wooden_pickaxe: 1, stick: 4 });
  assert.equal(chainStep('iron_pickaxe', 1, woodTools)?.step, 'get_stone');
  const stoneTools = f({ stone_pickaxe: 1, stick: 4, cobblestone: 20 }, { tableDist: 2 });
  assert.equal(chainStep('iron_pickaxe', 1, stoneTools)?.step, 'get_iron');
});

test('raw iron goes to the furnace, ingots go to the tool, a met goal is null', () => {
  const base = { stone_pickaxe: 1, stick: 4, coal: 2 };
  assert.equal(chainStep('iron_pickaxe', 1, f({ ...base, raw_iron: 3, furnace: 1 }, { tableDist: 2 }))?.step, 'smelt');
  assert.equal(chainStep('iron_pickaxe', 1, f({ ...base, raw_iron: 3 }, { tableDist: 2 }))?.step, 'get_stone'); // no furnace yet: stone for one
  assert.equal(chainStep('iron_pickaxe', 1, f({ ...base, iron_ingot: 3 }, { tableDist: 2 }))?.step, 'craft');
  assert.equal(chainStep('iron_pickaxe', 1, f({ iron_pickaxe: 1 })), null);
  assert.equal(chainStep('cobblestone', 5, f({ cobblestone: 9 })), null);
});

test('the outline reads in the order it is worked', () => {
  const o = chainOutline('iron_pickaxe');
  assert.ok(o.indexOf('wooden_pickaxe') < o.indexOf('stone_pickaxe'));
  assert.ok(o.indexOf('stone_pickaxe') < o.indexOf('raw_iron'));
  assert.ok(o.indexOf('iron_ingot') < o.indexOf('iron_pickaxe'));
});
