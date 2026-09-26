import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceStep, ironHave, IRON_GOAL } from '../behavior_pack/scripts/core/advance.js';

const base = { tableDist: 2, furnaceDist: 3, smelt: null, worn: [] };
const kit = { stone_pickaxe: 3, stone_sword: 1, cobblestone: 20, oak_planks: 8, stick: 4, cooked_beef: 8 };

test('iron goal: armor 24 + tools 9 + bucket 3 + shield 1', () => {
  assert.equal(IRON_GOAL, 37);
  assert.equal(ironHave({ raw_iron: 4, iron_ingot: 2, iron_pickaxe: 1 }, ['iron_boots']), 4 + 2 + 3 + 4);
});

test('first check for water near the house', () => {
  assert.equal(advanceStep({ ...base, inv: kit, farm: null, waterNearHouse: null }).step, 'check_water');
});

test('water near: hoe, then the farm, before any iron', () => {
  assert.deepEqual(advanceStep({ ...base, inv: kit, farm: null, waterNearHouse: true }).items, ['stone_hoe']);
  const s = advanceStep({ ...base, inv: { ...kit, stone_hoe: 1 }, farm: null, waterNearHouse: true });
  assert.equal(s.step, 'make_farm');
  assert.equal(s.water, 'near');
});

test('no water near: 3 iron, smelt, bucket, then the farm by the house', () => {
  const f = { ...base, farm: null, waterNearHouse: false };
  assert.deepEqual(advanceStep({ ...f, inv: kit }), { step: 'get_iron', need: 3, why: 'bucket' });
  assert.equal(advanceStep({ ...f, inv: { ...kit, raw_iron: 3 } }).step, 'smelt');
  assert.equal(advanceStep({ ...f, inv: { ...kit, raw_iron: 3 }, smelt: { ready: false, kind: 'ore' } }).step, 'wait_smelt');
  assert.deepEqual(advanceStep({ ...f, inv: { ...kit, iron_ingot: 3 } }).items, ['bucket']);
  const farm = advanceStep({ ...f, inv: { ...kit, bucket: 1, stone_hoe: 1 } });
  assert.equal(farm.step, 'make_farm');
  assert.equal(farm.water, 'bucket');
});

test('after the farm: mine iron, pickaxe first as soon as there are 3 ingots', () => {
  const f = { ...base, farm: { tiles: 24, ripe: 0 }, waterNearHouse: true };
  assert.equal(advanceStep({ ...f, inv: { ...kit, stone_hoe: 1 } }).step, 'get_iron');
  assert.deepEqual(advanceStep({ ...f, inv: { ...kit, iron_ingot: 3 } }).items, ['iron_pickaxe']);
  assert.deepEqual(advanceStep({ ...f, inv: { ...kit, iron_ingot: 3, iron_pickaxe: 1 } }).items, ['iron_sword']);
  assert.equal(advanceStep({ ...f, inv: { ...kit, iron_ingot: 1, iron_pickaxe: 1 } }).step, 'get_iron');
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
  assert.equal(advanceStep({ ...f, inv: kit, smelt: { ready: false, kind: 'ore', n: 4, dist: 3 } }).step, 'wait_smelt');
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
