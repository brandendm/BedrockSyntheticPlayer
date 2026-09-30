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
