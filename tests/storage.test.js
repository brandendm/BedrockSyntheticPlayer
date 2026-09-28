import test from 'node:test';
import assert from 'node:assert/strict';
import { depositPlan, keepCount, takePlan, chestKindOf, sortIntoChests } from '../behavior_pack/scripts/core/storage.js';
import { settleStep } from '../behavior_pack/scripts/core/settle.js';
import { furnishings, blueprint, CHEST_KINDS } from '../behavior_pack/scripts/core/house.js';
import { planCrafts } from '../behavior_pack/scripts/core/recipes.js';
import { upkeepNeeds } from '../behavior_pack/scripts/core/advance.js';

test('chest: tools, armor, iron and what gets placed stay in the pack; junk and surplus go in', () => {
  const inv = {
    stone_pickaxe: 2, iron_sword: 1, iron_helmet: 1, raw_iron: 7, iron_ingot: 3, bucket: 1, bed: 1, furnace: 1,
    cobblestone: 150, andesite: 40, diorite: 12, rotten_flesh: 5, string: 3, torch: 40, cooked_beef: 20,
    oak_log: 10, birch_log: 12, wheat_seeds: 30, redstone: 9,
  };
  const p = depositPlan(inv);
  for (const id of ['stone_pickaxe', 'iron_sword', 'iron_helmet', 'raw_iron', 'iron_ingot', 'bucket', 'bed', 'furnace']) assert.equal(p[id], undefined, id);
  assert.equal(p.cobblestone, 150 - 64);
  assert.equal(p.andesite, 40);
  assert.equal(p.rotten_flesh, 5);
  assert.equal(p.redstone, 9);
  assert.equal(p.torch, 8);
  assert.equal(p.cooked_beef, 4);
  assert.equal(p.wheat_seeds, 14);
  // Logs are kept 16 in all, not 16 of each kind: the bigger stack stays.
  assert.equal((p.oak_log ?? 0) + (p.birch_log ?? 0), 6);
  assert.equal(p.birch_log, undefined);
});

test('chest: wool is kept until there is a bed, then put away', () => {
  assert.equal(keepCount('white_wool', {}), Infinity);
  assert.equal(depositPlan({ white_wool: 3, bed: 1 }).white_wool, 3);
});

test('chest: taking back only what a job needs, from what is in there', () => {
  const chest = { cobblestone: 40, cobbled_deepslate: 10, oak_log: 3 };
  assert.deepEqual(takePlan(chest, [[(id) => id === 'cobblestone' || id === 'cobbled_deepslate', 45]]), { cobblestone: 40, cobbled_deepslate: 5 });
  assert.deepEqual(takePlan(chest, [[(id) => id.endsWith('_log'), 10]]), { oak_log: 3 });
  assert.deepEqual(takePlan({}, [[() => true, 5]]), {});
});

test('chest: made (8 planks at a table) and put in once the house is up', () => {
  assert.deepEqual(planCrafts({ oak_planks: 8 }, ['chest']).steps, ['chest']);
  const base = { tableDist: 0, time: 1000, furnace: { dist: 3, inHouse: true }, smelt: null, sheep: false, animals: 0, bedDeferred: true };
  const kit = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, torch: 8, cooked_beef: 8 };
  const house = { dist: 3, door: true, bed: true, table: true, furnace: true, lit: true, litOutside: true, chest: false };
  const craft = settleStep({ ...base, house, inv: { ...kit, oak_log: 2 } });
  assert.deepEqual([craft.step, craft.items], ['craft', ['chest']]);
  assert.equal(settleStep({ ...base, house, inv: { ...kit, chest: 1 } }).step, 'furnish');
  assert.equal(settleStep({ ...base, house, inv: kit }).step, 'gather_logs');
  const done = { ...house, chest: true };
  assert.equal(settleStep({ ...base, house: done, inv: kit }).step, 'done');
  assert.equal(settleStep({ ...base, house: done, packFull: true, inv: kit }).step, 'store');
  assert.equal(settleStep({ ...base, house: done, packFull: true, chestFull: true, inv: kit }).step, 'done', 'both chests full: not back every round');
});

test('house: the chests go in free cells, in reach of the middle, off the way in', () => {
  const o = { x: 0, y: 64, z: 0 };
  for (const dir of ['north', 'south', 'east', 'west']) {
    const fur = furnishings(o, dir);
    const taken = [fur.table, fur.furnace, fur.bed.foot, fur.bed.head, fur.bed.standAt, fur.stand, fur.door, { ...fur.stand, ...fur.door, y: o.y }];
    const walkIn = [fur.door, furnishings(o, dir).stand];
    const k = (p) => `${p.x},${p.y},${p.z}`;
    const walls = new Set(blueprint(o, dir).map(k));
    for (const c of fur.chests) {
      assert.ok(!taken.some((t) => k(t) === k(c)), `${dir}: chest on furniture ${k(c)}`);
      assert.ok(!walls.has(k(c)), `${dir}: chest in a wall`);
      assert.ok(!walkIn.some((t) => k(t) === k(c)), `${dir}: chest in the way in`);
      const d = Math.hypot(c.x - fur.stand.x, c.y + 0.5 - (fur.stand.y + 1.62), c.z - fur.stand.z);
      assert.ok(d <= 4.5, `${dir}: out of reach`);
    }
    // Not side by side (two single chests, not one double one that could fail to form).
    const [a, b] = fur.chests;
    assert.ok(Math.abs(a.x - b.x) + Math.abs(a.z - b.z) > 1);
  }
});

test('moved in: the hoe, spare pickaxes, iron tool handles and the shield counted up front', () => {
  const need = upkeepNeeds({ stone_pickaxe: 1 });
  assert.equal(need.stone, 2 + 2 * 3); // hoe + two spare pickaxes
  assert.ok(need.planks >= 6 + 8, `planks ${need.planks}`); // shield 6 + ~15 sticks (8 planks)
  const kitted = upkeepNeeds({ iron_pickaxe: 1, stone_pickaxe: 1, iron_sword: 1, iron_axe: 1, iron_shovel: 1, stone_hoe: 1, shield: 1 });
  assert.deepEqual(kitted, { planks: 0, stone: 0 });
});

test('chest room: each thing in the chest its sign says', () => {
  for (const [id, kind] of [['cobblestone', 'stone'], ['andesite', 'stone'], ['coal', 'stone'], ['raw_copper', 'stone'], ['diamond', 'stone'],
    ['oak_log', 'wood'], ['spruce_planks', 'wood'], ['oak_sapling', 'wood'], ['stick', 'wood'],
    ['cooked_beef', 'food'], ['beef', 'food'], ['wheat_seeds', 'food'], ['wheat', 'food'], ['apple', 'food'],
    ['rotten_flesh', 'misc'], ['bone', 'misc'], ['string', 'misc'], ['gunpowder', 'misc'], ['spider_eye', 'misc']]) assert.equal(chestKindOf(id), kind, id);
  const kinds = CHEST_KINDS.map((k) => k.kind);
  const per = sortIntoChests({ cobblestone: 64, oak_log: 10, rotten_flesh: 5, bread: 3, tuff: 12 }, kinds);
  assert.deepEqual(per, [{ cobblestone: 64, tuff: 12 }, { oak_log: 10 }, { bread: 3 }, { rotten_flesh: 5 }]);
  // No chest of a kind (a cabin's plain chests): into the 'misc' one, else the first.
  assert.deepEqual(sortIntoChests({ oak_log: 3 }, ['stone', 'misc']), [{}, { oak_log: 3 }]);
});
