import test from 'node:test';
import assert from 'node:assert/strict';
import { blockValue, itemValue, armorUpgrades, armorInfo } from '../behavior_pack/scripts/core/wants.js';

test('ore: coal and iron wanted, copper and the like left alone', () => {
  const inv = { stone_pickaxe: 1 };
  assert.ok(blockValue('coal_ore', { inv }) > 0);
  assert.ok(blockValue('deepslate_coal_ore', { inv }) > 0);
  assert.ok(blockValue('iron_ore', { inv }) > blockValue('coal_ore', { inv: { coal: 200 } }));
  for (const id of ['copper_ore', 'deepslate_copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore']) assert.equal(blockValue(id, { inv }), 0, id);
  assert.equal(blockValue('diamond_ore', { inv }), 0, 'no iron pickaxe: no drop');
  assert.ok(blockValue('diamond_ore', { inv: { iron_pickaxe: 1 } }) > 0);
  assert.ok(blockValue('coal_ore', { inv: { coal: 10 } }) > blockValue('coal_ore', { inv: { coal: 200 } }), 'short of coal: worth more');
});

test('items: armor or a sword better than ours is well worth the walk; junk is not', () => {
  const inv = { stone_sword: 1 };
  assert.ok(itemValue('iron_chestplate', { inv }) >= 12);
  assert.equal(itemValue('leather_chestplate', { inv, worn: ['iron_chestplate'] }), 0, 'worse than what we wear');
  assert.ok(itemValue('iron_sword', { inv }) >= 8);
  assert.equal(itemValue('wooden_sword', { inv }), 0);
  for (const id of ['string', 'bone', 'rotten_flesh', 'poppy', 'andesite', 'copper_ingot', 'raw_copper']) assert.equal(itemValue(id, { inv }), 0, id);
  assert.ok(itemValue('coal', { inv }) > 0);
  assert.ok(itemValue('white_wool', { inv, needs: { wool: 3 } }) > 0);
  assert.equal(itemValue('white_wool', { inv, needs: { wool: 0 } }), 0);
});

test('armor: the best piece for each slot goes on, any material', () => {
  assert.deepEqual(armorInfo('diamond_helmet'), { slot: 'helmet', points: 3 });
  const up = armorUpgrades({ iron_chestplate: 1, leather_helmet: 1, iron_helmet: 1, golden_boots: 1 }, ['chainmail_chestplate', 'iron_boots']);
  const by = Object.fromEntries(up.map((u) => [u.slot, u]));
  assert.equal(by.chestplate.id, 'iron_chestplate');
  assert.equal(by.chestplate.replaces, 'chainmail_chestplate');
  assert.equal(by.helmet.id, 'iron_helmet');
  assert.equal(by.boots, undefined, 'gold boots are worse than the iron ones worn');
});
