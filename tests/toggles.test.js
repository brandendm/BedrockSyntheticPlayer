import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOALS, goalsOf, goalKey } from '../behavior_pack/scripts/core/toggles.js';

test('going home at dark is a goal that can be switched off, on by default', () => {
  assert.ok(GOALS.some((g) => g.key === 'nights'));
  assert.equal(goalsOf({}).nights, true);
  assert.equal(goalsOf({ nights: false }).nights, false);
  assert.equal(goalsOf({ nights: false }).beds, true); // (sleeping is its own switch)
});

test('goal names as typed reach the night switch', () => {
  for (const n of ['nights', 'night', 'dark', 'Home', 'dusk']) assert.equal(goalKey(n), 'nights', n);
  assert.equal(goalKey('sleep'), 'beds');
  assert.equal(goalKey('nonsense'), null);
});

import { parseOrder, orderOf, DEFAULT_ORDER } from '../behavior_pack/scripts/core/toggles.js';
import { orderedAdvance, villageStep } from '../behavior_pack/scripts/core/advance.js';

test('goal order: what is named goes first, the rest keep their usual order', () => {
  assert.deepEqual(parseOrder('iron'), ['iron', 'village', 'farm']);
  assert.deepEqual(parseOrder('farm iron village'), ['farm', 'iron', 'village']);
  assert.deepEqual(parseOrder('nonsense'), DEFAULT_ORDER);
  assert.deepEqual(orderOf({}), DEFAULT_ORDER);
});

test('village hunting waits for a sword, and goes first or last as ordered', () => {
  const base = { inv: { iron_ingot: 0 }, worn: [], tableDist: 0, goals: { farm: false }, armed: true, health: 20, waterNearHouse: false };
  assert.equal(villageStep({ ...base, armed: false }), null);
  assert.equal(villageStep({ ...base, villageVisited: true }), null);
  assert.equal(villageStep({ ...base, goals: { villages: false } }), null);
  assert.equal(orderedAdvance(base, ['village', 'iron']).step, 'seek_village');
  assert.notEqual(orderedAdvance(base, ['iron', 'village']).step, 'seek_village');
});
