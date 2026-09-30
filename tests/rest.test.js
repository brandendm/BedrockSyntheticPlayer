import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRest, canHeal, REST_BELOW, REST_UNTIL } from '../behavior_pack/scripts/core/rest.js';

test('hurt below four hearts: rest, if there is anything to heal with', () => {
  assert.equal(shouldRest({ health: 3, hunger: 20 }), true);
  assert.equal(shouldRest({ health: REST_BELOW - 0.5, hunger: 10, canEat: true }), true);
  assert.equal(shouldRest({ health: 3, hunger: 10, canEat: false }), false); // (starving, nothing to eat: food first, not sitting)
});

test('not hurt enough: work on', () => {
  assert.equal(shouldRest({ health: REST_BELOW, hunger: 20 }), false);
  assert.equal(shouldRest({ health: 12, hunger: 20 }), false);
  assert.equal(shouldRest({ health: 20 }), false);
});

test('once resting, keep on until seven hearts', () => {
  assert.equal(shouldRest({ health: 11, hunger: 20, resting: true }), true);
  assert.equal(shouldRest({ health: REST_UNTIL, hunger: 20, resting: true }), false);
});

test('a bout that got nowhere is not started again straight away', () => {
  assert.equal(shouldRest({ health: 2, hunger: 20, coolingDown: true }), false);
});

test('healing needs the food bar at 18 or a meal', () => {
  assert.equal(canHeal({ hunger: 18 }), true);
  assert.equal(canHeal({ hunger: 17, canEat: false }), false);
  assert.equal(canHeal({ hunger: 4, canEat: true }), true);
});
