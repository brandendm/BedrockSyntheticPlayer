import test from 'node:test';
import assert from 'node:assert/strict';
import { settleStep, chooseFood } from '../behavior_pack/scripts/core/settle.js';
import { keepClear, inTheWay, blueprint, furnishings } from '../behavior_pack/scripts/core/house.js';

const k = (p) => `${p.x},${p.y},${p.z}`;

for (const layout of ['chests', 'cabin']) {
  test(`house (${layout}): the cells kept clear are the rooms, doorways and doorstep, never a wall`, () => {
    const o = { x: 10, y: 64, z: -5, layout };
    for (const dir of ['north', 'east', 'south', 'west']) {
      const cells = keepClear(o, dir), walls = new Set(blueprint(o, dir).map(k));
      const fur = furnishings(o, dir);
      const byKey = new Map(cells.map((c) => [k(c), c]));
      assert.ok(cells.every((c) => !walls.has(k(c))), 'no wall or roof block is "in the way"');
      for (const p of [fur.stand, fur.doorstep, fur.bed.standAt, ...(fur.stands ?? [])]) assert.ok(byKey.has(k(p)) && !byKey.get(k(p)).want, `walkable ${k(p)}`);
      assert.equal(byKey.get(k(fur.door)).want, 'door');
      assert.equal(byKey.get(k(fur.table)).want, 'crafting_table');
      assert.equal(byKey.get(k(fur.furnace)).want, 'furnace');
      for (const c of fur.chests) assert.equal(byKey.get(k(c)).want, 'chest');
      assert.equal(new Set(cells.map(k)).size, cells.length, 'no cell twice');
    }
  });
}

test('house: what counts as in the way', () => {
  const room = { x: 0, y: 0, z: 0 }, table = { x: 0, y: 0, z: 0, want: 'crafting_table' }, door = { x: 0, y: 0, z: 0, want: 'door' };
  for (const id of ['cobblestone', 'oak_planks', 'dirt', 'glass', 'white_wool', 'chest', 'water', 'lava', 'sand', 'oak_fence']) assert.ok(inTheWay(room, id), id);
  for (const id of ['air', 'short_grass', 'torch', 'red_carpet', 'stone_pressure_plate', 'snow_layer', 'fire']) assert.ok(!inTheWay(room, id), id);
  assert.ok(!inTheWay(table, 'crafting_table'));
  assert.ok(inTheWay(table, 'furnace'), 'the wrong thing in our spot');
  assert.ok(!inTheWay(door, 'wooden_door') && !inTheWay(door, 'spruce_door'));
  assert.ok(inTheWay(door, 'cobblestone'));
});

test('plan: fire first, then clearing, then repairs; day or night', () => {
  const base = { tableDist: 0, furnace: null, smelt: null, sheep: false, animals: 0, bedDeferred: false, inv: {} };
  const house = { dist: 5, bed: true, furnace: true, table: true, door: true, damage: 3 };
  for (const time of [1000, 14000]) {
    assert.equal(settleStep({ ...base, time, house: { ...house, fire: 2, blocked: 4 } }).step, 'fight_fire');
    assert.equal(settleStep({ ...base, time, house: { ...house, blocked: 4 } }).step, 'clear_house');
  }
  assert.notEqual(settleStep({ ...base, time: 1000, house: { ...house, blocked: 0, fire: 0 } }).step, 'clear_house');
});

test('eating: hunger and saturation that land, least wasted', () => {
  const inv = { cooked_beef: 4, beef: 6, bread: 3, apple: 2 };
  assert.equal(chooseFood(inv, { hunger: 12 }), 'cooked_beef', 'properly hungry: the steak (8 hunger, 12.8 saturation)');
  assert.equal(chooseFood({ beef: 6, bread: 3 }, { hunger: 12 }), 'bread', 'bread beats raw beef');
  assert.equal(chooseFood(inv, { hunger: 19, saturation: 18 }), 'beef', 'full and saturated: the smallest bite (least wasted), not a steak');
  assert.equal(chooseFood(inv, { hunger: 19, saturation: 0 }), 'cooked_beef', 'hurt with no saturation: the steak\'s 12.8 is the fast healing');
  assert.equal(chooseFood({ beef: 6 }, { hunger: 12, cookingSoon: true }), null, 'raw waits while some cooks');
  assert.equal(chooseFood({ beef: 6 }, { hunger: 5, cookingSoon: true }), 'beef', 'unless starving');
  assert.equal(chooseFood({ beef: 6 }, { hunger: 12, health: 6, cookingSoon: true }), 'beef', 'or badly hurt');
  assert.equal(chooseFood({ chicken: 3 }, { hunger: 10 }), null, 'raw chicken only when starving');
  assert.equal(chooseFood({ rotten_flesh: 3 }, { hunger: 12 }), null);
  assert.equal(chooseFood({ rotten_flesh: 3 }, { hunger: 4 }), 'rotten_flesh', 'rotten flesh: starving, nothing else');
  assert.equal(chooseFood({ rotten_flesh: 3, bread: 1 }, { hunger: 4 }), 'bread');
  assert.equal(chooseFood(inv, { hunger: 20 }), null);
});
