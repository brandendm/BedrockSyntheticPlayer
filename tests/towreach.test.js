import test from 'node:test';
import assert from 'node:assert/strict';
import { newReach, reached, rideSpeed, RIDE_REACH, WELCOME_ABOARD } from '../behavior_pack/scripts/core/towreach.js';

test('a walker needs to be within 1.1 of the waypoint; a rider within 2.2', () => {
  const s = newReach();
  assert.equal(reached(s, 0, 1.5), false);
  assert.equal(reached(newReach(), 0, 1.0), true);
  assert.equal(reached(newReach(), 0, 2.0, { ride: true }), true);
  assert.equal(reached(newReach(), 0, RIDE_REACH + 0.1, { ride: true }), false);
});

test('a rider that came within 3.2 and is now moving away has gone past it (the circling horse)', () => {
  const s = newReach();
  // a wide pass: 5 away, 2.6 at the closest, then back out
  const seq = [5, 4, 3, 2.6, 2.9, 3.4, 3.6];
  const got = seq.map((d) => reached(s, 7, d, { ride: true }));
  assert.deepEqual(got, [false, false, false, false, false, false, true]);
  // on foot the same pass is not "past it"
  const w = newReach();
  assert.deepEqual(seq.map((d) => reached(w, 7, d)), seq.map(() => false));
});

test('the closest-so-far resets at the next waypoint, and the end of a route (hold) is not passed, only arrived at', () => {
  const s = newReach();
  reached(s, 1, 2.5, { ride: true });
  assert.equal(reached(s, 2, 6, { ride: true }), false);          // a new waypoint: nothing yet
  const h = newReach();
  reached(h, 9, 2.5, { ride: true, hold: true });
  assert.equal(reached(h, 9, 3.6, { ride: true, hold: true }), false);
});

test('riding slows into the last blocks, never to a crawl, and is full speed far off', () => {
  assert.equal(rideSpeed(30), 1);
  assert.ok(rideSpeed(1) < rideSpeed(4));
  assert.ok(rideSpeed(0) >= 0.35);
});

test('only villagers and the player are welcome in a boat', () => {
  assert.equal(WELCOME_ABOARD.test('minecraft:horse'), false);
  assert.equal(WELCOME_ABOARD.test('minecraft:villager_v2'), true);
  assert.equal(WELCOME_ABOARD.test('minecraft:player'), true);
});
