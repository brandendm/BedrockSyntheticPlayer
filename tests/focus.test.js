import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseStep, needs, stepKey } from '../behavior_pack/scripts/core/focus.js';

const kit = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1 };
const base = (over = {}) => ({ inv: { ...kit }, haveFurnace: true, house: null, project: false, shortfall: null, ...over });

test('needs: counts wool for the bed, logs and stone for the house, net of what we carry', () => {
  const n = needs(base());
  assert.equal(n.wool, 3);
  assert.ok(n.stone >= 20, `stone ${n.stone}`);
  assert.ok(n.logs >= 10, `logs ${n.logs}`);
  const n2 = needs(base({ inv: { ...kit, white_wool: 3, cobblestone: 64, oak_log: 40, torch: 8, wooden_door: 1 } }));
  assert.equal(n2.wool, 0);
  assert.equal(n2.stone, 0);
  assert.equal(n2.logs, 0);
  // Moved in with the farm and mine kit (hoe, spare pickaxes, sticks for the iron tools, wood for the shield): nothing.
  const outfit = { ...kit, stone_pickaxe: 3, stone_hoe: 1, stick: 7, oak_planks: 6, torch: 8 };
  const built = needs(base({ house: { door: true, bed: true, table: true, furnace: true, chest: true }, inv: outfit }));
  assert.deepEqual([built.stone, built.logs, built.wool], [0, 0, 0]);
  // Moved in without it: the chest, the hoe, spare pickaxes and handles are counted up front.
  const bare = needs(base({ house: { door: true, bed: true, table: true, furnace: true, chest: false }, inv: { ...kit, torch: 8 } }));
  assert.ok(bare.logs >= 5, `logs ${bare.logs}`); // chest 8 + shield 6 + sticks: ~6 logs
  assert.equal(bare.stone, 8); // hoe 2 + two spare pickaxes 6
});

test('sheep in sight while out for stone with nothing known nearby: get the wool first', () => {
  const f = base();
  const s = chooseStep({ step: 'get_stone', need: 20, why: 'house' }, { inv: f.inv, need: needs(f), seen: { sheep: 9 }, canMineStone: true });
  assert.equal(s.step, 'hunt');
  assert.equal(s.what, 'sheep');
  assert.equal(s.opportunity, 'sheep');
});

test("stone right here beats sheep far off: the ladder's step stays", () => {
  const f = base();
  const main = { step: 'get_stone', need: 20, why: 'house' };
  assert.equal(chooseStep(main, { inv: f.inv, need: needs(f), seen: { sheep: 22, stone: 3 }, canMineStone: true }), main);
});

test('priority jobs are never pre-empted', () => {
  const f = base();
  for (const step of ['go_home', 'shelter', 'collect_smelt', 'build_house', 'craft']) {
    const main = { step, items: step === 'craft' ? ['furnace'] : undefined };
    assert.equal(chooseStep(main, { inv: f.inv, need: needs(f), seen: { sheep: 2, log: 2, food: 2 }, canMineStone: true }), main, step);
  }
});

test('a step that keeps failing is set aside for the cheapest other job, or exploring if none', () => {
  const f = base();
  const main = { step: 'get_stone', need: 20, why: 'house' };
  const deferred = new Set([stepKey(main)]);
  const s = chooseStep(main, { inv: f.inv, need: needs(f), seen: { log: 12, sheep: 20 }, deferred, canMineStone: true });
  assert.equal(s.step, 'gather_logs');
  const none = chooseStep(main, { inv: f.inv, need: needs(f), seen: {}, deferred, canMineStone: true });
  assert.equal(none.step, 'explore');
});

test("doesn't grab what's already covered, or stone without a pickaxe", () => {
  const f = base({ inv: { ...kit, white_wool: 3 } });
  const main = { step: 'gather_logs', count: 10, wanted: ['house'] };
  assert.equal(chooseStep(main, { inv: f.inv, need: needs(f), seen: { sheep: 3 } }), main);
  const main2 = { step: 'hunt', what: 'sheep', need: 3 };
  assert.equal(chooseStep(main2, { inv: {}, need: { stone: 20, logs: 0, wool: 3, food: 0 }, seen: { stone: 2 }, canMineStone: false }).step, 'hunt');
});

test('a set-aside step never sends it exploring for stone: quarry or dig instead', () => {
  const f = base();
  const main = { step: 'smelt', input: 'log', n: 2, fuelPlanks: 2 };
  const deferred = new Set([stepKey(main)]);
  const s = chooseStep(main, { inv: f.inv, need: needs(f), seen: {}, deferred, canMineStone: true });
  assert.equal(s.step, 'get_stone', 'digs for the stone it still needs rather than wandering');
  const noPick = chooseStep(main, { inv: f.inv, need: { stone: 20, logs: 0, wool: 0, food: 0 }, seen: {}, deferred, canMineStone: false });
  assert.equal(noPick.step, 'explore');
  assert.notEqual(noPick.want, 'stone');
  const withLogs = chooseStep(main, { inv: f.inv, need: needs(f), seen: { log: 40, stone: 50 }, deferred, canMineStone: true });
  assert.equal(withLogs.step, 'gather_logs', 'a known tree 40 blocks off, when the furnace job is stuck');
});

test('no hunting without a stone (or better) sword, even with sheep right there', () => {
  const f = base();
  const main = { step: 'get_stone', need: 20, why: 'house' };
  const s = chooseStep(main, { inv: f.inv, need: needs(f), seen: { sheep: 5, food: 4 }, canMineStone: true, canHunt: false });
  assert.notEqual(s.step, 'hunt');
});

test('a set-aside furnace job with the logs already in hand does not send it looking for trees', () => {
  const main = { step: 'smelt', input: 'log', n: 2, fuelPlanks: 2 };
  const deferred = new Set([stepKey(main)]);
  const s = chooseStep(main, { inv: { oak_log: 8 }, need: { stone: 0, logs: 0, wool: 0, food: 0 }, seen: { log: 3 }, deferred, canMineStone: true });
  assert.equal(s.step, 'explore');
  assert.notEqual(s.want, 'log');
});

test('bed on hold (looking for sheep got nowhere): not sent looking for sheep again', () => {
  const main = { step: 'hunt', what: 'sheep', need: 3 };
  const deferred = new Set([stepKey(main)]);
  const need = { stone: 0, logs: 0, wool: 3, food: 0 };
  const looking = chooseStep(main, { inv: { ...kit }, need, seen: {}, deferred, canMineStone: true, canHunt: true });
  assert.deepEqual([looking.step, looking.want], ['explore', 'sheep'], 'first time: go looking');
  const onHold = chooseStep(main, { inv: { ...kit }, need, seen: {}, deferred, canMineStone: true, canHunt: true, bedDeferred: true });
  assert.notEqual(onHold.want, 'sheep');
});
