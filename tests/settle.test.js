import test from 'node:test';
import assert from 'node:assert/strict';
import { settleStep, houseShortfall, isNight } from '../behavior_pack/scripts/core/settle.js';
import { blueprint, materials, furnishings, frame, inside } from '../behavior_pack/scripts/core/house.js';
import { planCrafts, applyCraft } from '../behavior_pack/scripts/core/recipes.js';

const base = { tableDist: 0, time: 1000, furnace: null, smelt: null, house: null, sheep: false, animals: 0, bedDeferred: false };
const tools = { stone_pickaxe: 1, stone_sword: 1 };

test('ladder: furnace, then sheep, then charcoal, then the house', () => {
  assert.deepEqual(settleStep({ ...base, inv: { ...tools, cobblestone: 2 } }), { step: 'get_stone', need: 6, why: 'furnace' });
  assert.equal(settleStep({ ...base, inv: { ...tools, cobblestone: 8, oak_log: 2 } }).items[0], 'furnace');
  const s = settleStep({ ...base, sheep: true, inv: { ...tools, furnace: 1, white_wool: 1 } });
  assert.deepEqual([s.step, s.what, s.need], ['hunt', 'sheep', 2]);
  assert.equal(settleStep({ ...base, inv: { ...tools, furnace: 1, oak_log: 4 } }).step, 'smelt'); // no sheep around: torches next
  assert.equal(settleStep({ ...base, smelt: { ready: false }, inv: { ...tools, furnace: 1 } }).step, 'plan_house'); // pick the spot, then count
  assert.equal(settleStep({ ...base, project: true, shortfall: { stone: 20, planks: 0 }, smelt: { ready: false }, inv: { ...tools, furnace: 1 } }).why, 'house');
  assert.equal(settleStep({ ...base, smelt: { ready: true }, inv: { ...tools } }).step, 'collect_smelt');
});

test('ladder: easy meat only when animals are right here and food is low', () => {
  assert.equal(settleStep({ ...base, animals: 2, inv: { ...tools, furnace: 1 } }).what, 'food');
  assert.notEqual(settleStep({ ...base, animals: 2, inv: { ...tools, furnace: 1, cooked_beef: 8 } }).what, 'food');
});

test('cooking: only with something to burn (else the furnace job loops and gets set aside)', () => {
  const house = { bed: false, table: true, furnace: true, door: true, lit: true, dist: 3 };
  const inv = { ...tools, mutton: 3, torch: 8 };
  assert.notEqual(settleStep({ ...base, house, furnace: { inHouse: true }, inv }).step, 'smelt');
  assert.equal(settleStep({ ...base, house, furnace: { inHouse: true }, inv: { ...inv, oak_planks: 1 } }).step, 'smelt');
});

test('night: home if there is one, build if we can, else dig in', () => {
  assert.equal(settleStep({ ...base, time: 13000, house: { dist: 20 }, inv: {} }).step, 'go_home');
  assert.equal(settleStep({ ...base, time: 13000, inv: { cobblestone: 30, oak_planks: 64 } }).step, 'build_house');
  assert.equal(settleStep({ ...base, time: 13000, inv: {} }).step, 'shelter');
  assert.ok(isNight(12000) && isNight(20000) && !isNight(23500) && !isNight(6000));
});

test('house: materials, reach from the middle, walls before roof, nothing in the door', () => {
  const m = materials();
  assert.deepEqual([m.stone, m.planks], [23, 46]);
  const o = { x: 100, y: 64, z: 100 };
  const bp = blueprint(o, 'south');
  const stand = furnishings(o, 'south').stand;
  for (const b of bp) {
    const d = Math.hypot(b.x + 0.5 - (stand.x + 0.5), b.y + 0.5 - (stand.y + 1.62), b.z + 0.5 - (stand.z + 0.5));
    assert.ok(d <= 4.5, `out of reach ${JSON.stringify(b)} ${d}`);
  }
  const firstRoof = bp.findIndex((b) => b.h === 3);
  assert.ok(bp.slice(0, firstRoof).every((b) => b.h < 3) && bp.slice(firstRoof).every((b) => b.h === 3));
  const door = furnishings(o, 'south').door;
  assert.ok(!bp.some((b) => b.x === door.x && b.z === door.z && b.y <= door.y + 1));
  assert.deepEqual(frame(o, 'south')(0, 2), { x: 100, y: 64, z: 102 }); // front is +z when the door faces south
  assert.ok(inside({ ...o, dir: 'south' }, { x: 101.5, y: 64, z: 99.2 }) && !inside({ ...o, dir: 'south' }, { x: 104, y: 64, z: 100 }));
});

test('house shortfall and new recipes', () => {
  assert.deepEqual(houseShortfall({}), { stone: 27, logs: 13 });
  assert.equal(houseShortfall({ cobblestone: 27, oak_planks: 52 }), null);
  assert.deepEqual(houseShortfall({}, { stone: 5, planks: 0 }), { stone: 5, logs: 0 }); // a started house: exact counts
  assert.equal(planCrafts({ white_wool: 2, black_wool: 1, oak_planks: 3 }, ['bed']).missing, 'bed'); // one colour only
  assert.equal(applyCraft({ white_wool: 3, black_wool: 1, oak_planks: 3 }, 'bed').inv.black_wool, 1);
  assert.equal(applyCraft({ charcoal: 1, stick: 1 }, 'torch').made.torch, 4);
});

test('a house gets its crafting table and furnace inside', () => {
  const b = { tableDist: 0, time: 1000, furnace: null, smelt: null, sheep: false, animals: 0, bedDeferred: false };
  const kit = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, bed: 0, torch: 8 };
  const house = { dist: 3, door: true, bed: true, furnace: false, table: false, lit: true };
  assert.equal(settleStep({ ...b, house, inv: { ...kit, oak_log: 2, furnace: 1 } }).step, 'furnish');
  assert.equal(settleStep({ ...b, house: { ...house, table: true }, furnace: { dist: 30, inHouse: false }, inv: kit }).step, 'furnish');
  assert.deepEqual(settleStep({ ...b, house: { ...house, table: true }, inv: kit }).why, 'furnace');
});

test("never 'done' with the house missing its door, bed or light", () => {
  const b = { tableDist: 0, time: 1000, furnace: { dist: 3, inHouse: true }, smelt: null, sheep: false, animals: 0, bedDeferred: true };
  const kit = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, torch: 8, cooked_beef: 8 };
  const full = { dist: 3, door: true, bed: true, table: true, furnace: true, lit: true };
  assert.equal(settleStep({ ...b, house: full, inv: kit }).step, 'done');
  const noBed = settleStep({ ...b, house: { ...full, bed: false }, inv: kit });
  assert.equal(noBed.step, 'explore', 'no sheep known: goes looking for some');
  assert.equal(noBed.want, 'sheep');
  assert.notEqual(settleStep({ ...b, house: { ...full, door: false }, inv: { ...kit, oak_planks: 12 } }).step, 'done');
  assert.equal(settleStep({ ...b, house: { ...full, door: false }, inv: { ...kit, wooden_door: 1 } }).step, 'furnish');
  assert.equal(settleStep({ ...b, house: { ...full, lit: false }, inv: kit }).step, 'furnish', 'has torches: puts one up');
  assert.equal(settleStep({ ...b, house: { ...full, lit: false }, smelt: { ready: false }, inv: { ...kit, torch: 0 } }).step, 'wait_smelt');
});

test('a damaged house is repaired first, with the missing blocks fetched if short', () => {
  const b = { tableDist: 0, time: 1000, furnace: { dist: 3, inHouse: true }, smelt: null, sheep: true, animals: 3, bedDeferred: false };
  const kit = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, torch: 8 };
  const house = { dist: 3, door: true, bed: true, table: true, furnace: true, lit: true, damage: 4 };
  assert.equal(settleStep({ ...b, house, repairShort: { stone: 0, planks: 0 }, inv: kit }).step, 'repair_house');
  const short = settleStep({ ...b, house, repairShort: { stone: 3, planks: 0 }, inv: kit });
  assert.equal(short.step, 'get_stone');
  assert.equal(short.need, 3);
  assert.equal(settleStep({ ...b, time: 13000, house, repairShort: { stone: 0, planks: 0 }, inv: kit }).step, 'repair_house', 'even at night, with what it has');
  assert.equal(settleStep({ ...b, time: 13000, house, repairShort: { stone: 3, planks: 0 }, inv: kit }).step, 'go_home', "short at night: home anyway, fix it in the morning");
});

test('settle: no hunting for food or wool until armed with a stone sword', () => {
  const b = { tableDist: 0, time: 1000, furnace: { dist: 3, inHouse: false }, smelt: null, sheep: true, animals: 4, bedDeferred: false, armed: false };
  const inv = { stone_pickaxe: 1, stone_axe: 1, stone_shovel: 1 };
  const s = settleStep({ ...b, inv });
  assert.notEqual(s.step, 'hunt');
  assert.equal(settleStep({ ...b, armed: true, inv: { ...inv, stone_sword: 1 } }).step, 'hunt');
});

test('wool first: sheep in sight beats other animals and a finished furnace', () => {
  const inv = { ...tools, furnace: 1, cobblestone: 30, oak_log: 2 };
  assert.deepEqual(settleStep({ ...base, inv, sheep: true, animals: 3 }), { step: 'hunt', what: 'sheep', need: 3 });
  assert.equal(settleStep({ ...base, inv, sheep: true, animals: 3, smelt: { ready: true } }).what, 'sheep');
  assert.equal(settleStep({ ...base, inv: { ...inv, bed: 1 }, sheep: true, animals: 3 }).what, 'food');
});

test('torches by the door: after the inside one, before done', () => {
  const house = { bed: true, table: true, furnace: true, door: true, lit: true, litOutside: false, dist: 3 };
  const inv = { ...tools, cooked_mutton: 10 };
  assert.equal(settleStep({ ...base, house, furnace: { inHouse: true }, inv: { ...inv, torch: 2 } }).step, 'light_outside');
  assert.notEqual(settleStep({ ...base, house, furnace: { inHouse: true }, inv }).step, 'done');
  assert.equal(settleStep({ ...base, house: { ...house, litOutside: true }, furnace: { inHouse: true }, inv }).step, 'done');
});

test('a bed set in the wrong place gets redone', () => {
  const house = { bed: false, bedMisplaced: true, table: true, furnace: true, door: true, lit: true, litOutside: true, dist: 3 };
  assert.equal(settleStep({ ...base, house, furnace: { inHouse: true }, inv: { ...tools } }).step, 'furnish');
});

test('door torches before going off to look for sheep', () => {
  const house = { bed: false, table: true, furnace: true, door: true, lit: true, litOutside: false, dist: 3 };
  assert.equal(settleStep({ ...base, house, furnace: { inHouse: true }, inv: { ...tools, torch: 7, cooked_mutton: 10 } }).step, 'light_outside');
});

test('a finished furnace waits: no walk home mid-search unless near it or out of food', () => {
  const inv = { ...tools, furnace: 1, cobblestone: 30, oak_log: 4, cooked_mutton: 2 };
  const far = { ready: true, kind: 'food', dist: 80 };
  assert.notEqual(settleStep({ ...base, inv, smelt: far }).step, 'collect_smelt');
  assert.equal(settleStep({ ...base, inv, smelt: { ...far, dist: 8 } }).step, 'collect_smelt');
  assert.equal(settleStep({ ...base, inv: { ...inv, cooked_mutton: 0 }, smelt: far }).step, 'collect_smelt');
});
