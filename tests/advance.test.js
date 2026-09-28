import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceStep, ironHave, IRON_GOAL } from '../behavior_pack/scripts/core/advance.js';

const base = { tableDist: 2, furnaceDist: 3, smelt: null, worn: [] };
const kit = { stone_pickaxe: 3, stone_sword: 1, cobblestone: 20, oak_planks: 8, stick: 4, cooked_beef: 8 };

test('iron goal: armor 24 + tools 9 + bucket 3 + shield 1', () => {
  assert.equal(IRON_GOAL, 37);
  assert.equal(ironHave({ raw_iron: 4, iron_ingot: 2, iron_pickaxe: 1 }, ['iron_boots']), 4 + 2 + 3 + 4);
});

test('with a bucket: first check for water near the house', () => {
  assert.equal(advanceStep({ ...base, inv: { ...kit, bucket: 1 }, farm: null, waterNearHouse: null }).step, 'check_water');
});

test('the farm waits for a bucket: iron first, even with water by the house', () => {
  const s = advanceStep({ ...base, inv: kit, farm: null, waterNearHouse: true });
  assert.equal(s.step, 'get_iron');
  assert.deepEqual(advanceStep({ ...base, inv: { ...kit, bucket: 1 }, farm: null, waterNearHouse: true }).items, ['stone_hoe']);
  const near = advanceStep({ ...base, inv: { ...kit, bucket: 1, stone_hoe: 1 }, farm: null, waterNearHouse: true });
  assert.deepEqual([near.step, near.water], ['make_farm', 'near']);
  const far = advanceStep({ ...base, inv: { ...kit, bucket: 1, stone_hoe: 1 }, farm: null, waterNearHouse: false });
  assert.deepEqual([far.step, far.water], ['make_farm', 'bucket']);
});

test('goals switched off: no farm, no iron', () => {
  const f = { ...base, farm: null, waterNearHouse: true };
  assert.notEqual(advanceStep({ ...f, inv: { ...kit, bucket: 1, stone_hoe: 1 }, goals: { farm: false } }).step, 'make_farm');
  assert.equal(advanceStep({ ...f, inv: kit, goals: { iron: false } }).step, 'done');
});

test('after the farm: mine iron, the shield from the first ingot, then the pickaxe', () => {
  const f = { ...base, farm: { tiles: 24, ripe: 0 }, waterNearHouse: true };
  assert.equal(advanceStep({ ...f, inv: { ...kit, stone_hoe: 1 } }).step, 'get_iron');
  assert.deepEqual(advanceStep({ ...f, inv: { ...kit, iron_ingot: 1 } }).items, ['shield']);
  assert.equal(advanceStep({ ...f, inv: { ...kit, iron_ingot: 3, shield: 1 } }).step, 'equip');
  assert.deepEqual(advanceStep({ ...f, worn: ['shield'], inv: { ...kit, iron_ingot: 3 } }).items, ['iron_pickaxe']);
  assert.deepEqual(advanceStep({ ...f, worn: ['shield'], inv: { ...kit, iron_ingot: 3, iron_pickaxe: 1 } }).items, ['iron_sword']);
  assert.equal(advanceStep({ ...f, worn: ['shield'], inv: { ...kit, iron_ingot: 1, iron_pickaxe: 1 } }).step, 'get_iron');
});

test('no wood for the shield: the pickaxe goes ahead, the shield keeps its ingot', () => {
  const f = { ...base, farm: { tiles: 24, ripe: 0 }, waterNearHouse: true };
  const bare = { ...kit, oak_planks: 0 };
  assert.deepEqual(advanceStep({ ...f, inv: { ...bare, iron_ingot: 4 } }).items, ['iron_pickaxe']);
  assert.equal(advanceStep({ ...f, inv: { ...bare, iron_ingot: 3 } }).step, 'get_iron');
});

test('armor gets worn; ripe wheat gets harvested; bread when hungry', () => {
  const f = { ...base, farm: { tiles: 24, ripe: 2 }, waterNearHouse: true };
  assert.equal(advanceStep({ ...f, inv: { ...kit, iron_chestplate: 1 } }).step, 'equip');
  assert.equal(advanceStep({ ...f, farm: { tiles: 24, planted: 24, ripe: 15 }, inv: kit }).step, 'tend_farm');
  assert.equal(advanceStep({ ...f, farm: { tiles: 24, planted: 2, ripe: 2 }, inv: kit }).step, 'tend_farm');
  assert.equal(advanceStep({ ...f, farm: { tiles: 24, planted: 10, ripe: 0 }, inv: { ...kit, wheat_seeds: 6 } }).step, 'tend_farm');
  assert.deepEqual(advanceStep({ ...f, inv: { ...kit, cooked_beef: 0, wheat: 3 } }).items, ['bread']);
});

test('everything made and worn: done', () => {
  const inv = { ...kit, iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, iron_shovel: 1, bucket: 1 };
  const worn = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield'];
  assert.equal(advanceStep({ ...base, worn, inv, farm: { tiles: 24, ripe: 0 }, waterNearHouse: true }).step, 'done');
});

test('spare pickaxes before an iron trip: three stone ones', () => {
  const f = { ...base, farm: { tiles: 24, ripe: 0 }, waterNearHouse: true };
  const inv = { ...kit, stone_pickaxe: 1, stone_hoe: 1 }; // down to one
  assert.deepEqual(advanceStep({ ...f, inv }).items, ['stone_pickaxe']);
  assert.equal(advanceStep({ ...f, inv: { ...inv, stone_pickaxe: 3 } }).step, 'get_iron');
});

test('iron in the furnace counts: wait for it rather than mine more', () => {
  const f = { ...base, farm: null, waterNearHouse: false };
  // (Short of plenty more: mining goes on while it smelts.)
  assert.equal(advanceStep({ ...f, inv: kit, smelt: { ready: false, kind: 'ore', n: 4, dist: 3 } }).step, 'get_iron');
  assert.equal(advanceStep({ ...f, inv: kit, smelt: { ready: true, kind: 'ore', n: 4, dist: 40 } }).step, 'collect_smelt');
  // The big batch: mining carries on while 20 smelt, for what's still short.
  const big = advanceStep({ ...base, farm: { tiles: 24, ripe: 0 }, waterNearHouse: true, inv: { ...kit, bucket: 1, stone_hoe: 1 }, smelt: { ready: false, kind: 'ore', n: 20, dist: 3 } });
  assert.deepEqual([big.step, big.need], ['get_iron', 37 - 3 - 20]);
});

test('a farm that just failed waits: iron meanwhile', () => {
  const s = advanceStep({ ...base, farm: null, farmBlocked: true, waterNearHouse: false, inv: { ...kit, bucket: 1, stone_hoe: 1 } });
  assert.equal(s.step, 'get_iron');
});

test('down the mine with one pickaxe left: keep mining, spares get made at the surface', () => {
  const f = { ...base, farm: { tiles: 24, ripe: 0 }, waterNearHouse: true };
  const inv = { ...kit, stone_pickaxe: 1, stone_hoe: 1, bucket: 1 };
  assert.equal(advanceStep({ ...f, inv, underground: true }).step, 'get_iron');
  assert.deepEqual(advanceStep({ ...f, inv, underground: false }).items, ['stone_pickaxe']);
});

test('moved in: short of cobblestone for the hoe fetches some (never "blocked"), torches before the mine', async () => {
  const { advanceStep } = await import('../behavior_pack/scripts/core/advance.js');
  const kit = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, oak_planks: 8 };
  const s = advanceStep({ inv: { ...kit, bucket: 1 }, tableDist: 0, waterNearHouse: true, farm: null });
  assert.equal(s.step, 'get_stone');
  assert.equal(s.need, 2);
  const t = advanceStep({ inv: { ...kit, stone_hoe: 1, stone_pickaxe: 3, coal: 2 }, tableDist: 0, waterNearHouse: true, farm: { tiles: 24, planted: 24, ripe: 0 } });
  assert.deepEqual([t.step, t.items], ['craft', ['torch']]);
});

test('iron to smelt and nothing to burn: wood for fuel first, not a furnace job that fails', async () => {
  const { advanceStep } = await import('../behavior_pack/scripts/core/advance.js');
  const inv = { iron_pickaxe: 1, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, stone_hoe: 1, raw_iron: 36, torch: 10 };
  const s = advanceStep({ inv, tableDist: 0, waterNearHouse: true, farm: { tiles: 24, planted: 24, ripe: 0 } });
  assert.equal(s.step, 'gather_logs');
  assert.deepEqual(s.wanted, ['furnace fuel']);
  assert.equal(advanceStep({ inv: { ...inv, coal: 5 }, tableDist: 0, waterNearHouse: true, farm: { tiles: 24, planted: 24, ripe: 0 } }).step, 'smelt');
});

test('mine camp: smelting, collecting and spare pickaxes happen down there; without one, not', async () => {
  const { advanceStep } = await import('../behavior_pack/scripts/core/advance.js');
  const farm = { tiles: 24, planted: 24, ripe: 0 };
  const kit = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, stone_hoe: 1, bucket: 1, torch: 16 };
  const down = { tableDist: 0, waterNearHouse: true, farm, underground: true };
  // Raw iron and coal down the mine: at the camp, into its furnace; without a camp, keep mining.
  assert.equal(advanceStep({ ...down, camp: true, inv: { ...kit, raw_iron: 5, coal: 3 } }).step, 'smelt');
  assert.equal(advanceStep({ ...down, camp: false, inv: { ...kit, raw_iron: 5, coal: 3 } }).step, 'get_iron');
  // A finished batch at the camp: collect it (it's right there), even with iron still to dig.
  const ready = { ready: true, kind: 'ore', n: 3, dist: 20 };
  assert.equal(advanceStep({ ...down, camp: true, smelt: ready, oreCooking: 3, inv: kit }).step, 'collect_smelt');
  assert.notEqual(advanceStep({ ...down, camp: false, smelt: ready, oreCooking: 3, inv: kit }).step, 'collect_smelt');
  // One pickaxe left and cobblestone in hand: a spare at the camp's table, not without one.
  assert.deepEqual(advanceStep({ ...down, camp: true, inv: { ...kit, cobblestone: 20, stick: 4 } }).items, ['stone_pickaxe']);
  assert.equal(advanceStep({ ...down, camp: true, inv: { ...kit, cobblestone: 20 } }).step, 'get_iron', 'no wood for a handle: keep mining, no climb out for a log');
  assert.equal(advanceStep({ ...down, camp: false, inv: { ...kit, cobblestone: 20 } }).step, 'get_iron');
});
