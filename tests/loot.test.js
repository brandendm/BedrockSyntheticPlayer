import test from 'node:test';
import assert from 'node:assert/strict';
import { lootPlan, lootWorth, backoffMs, LOOT_WINDOW_MS, MAX_FAILS, MAX_STUCK } from '../behavior_pack/scripts/core/loot.js';

const at = 1_000_000;
const ctx = (over = {}) => ({ now: at + 20000, dist: 30, night: false, health: 20, ...over });

test('gear is worth going back for, cobblestone is not', () => {
  assert.equal(lootWorth(['cobblestone', 'oak_log', 'dirt', 'cooked_beef']), 0);
  assert.equal(lootWorth(['iron_chestplate', 'iron_pickaxe', 'shield', 'cobblestone', 'raw_iron', 'bucket']), 5);
  assert.equal(lootWorth(['minecraft:diamond', 'stone_sword']), 2);
});

test('goes for it: the whole five minutes, not four tries', () => {
  const d = { at, worth: 3 };
  assert.equal(lootPlan(d, ctx()).do, 'go');
  assert.equal(lootPlan(d, ctx({ now: at + 250000 })).do, 'go');
  assert.equal(lootPlan(d, ctx({ now: at + LOOT_WINDOW_MS + 1 })).do, 'expired');
});

test('restarts of the job do not count against it: only failed legs and fruitless visits', () => {
  const d = { at, worth: 1, legs: 40 }; // forty legs walked (each restart is another) is nothing
  assert.equal(lootPlan(d, ctx()).do, 'go');
  assert.equal(lootPlan({ ...d, fails: MAX_FAILS - 1 }, ctx()).do, 'go');
  assert.equal(lootPlan({ ...d, fails: MAX_FAILS }, ctx()).do, 'giveup');
  assert.equal(lootPlan({ ...d, stuck: MAX_STUCK }, ctx()).do, 'giveup');
});

test('not yet: not respawned, standing on the spot, backing off', () => {
  const d = { at, worth: 1 };
  assert.equal(lootPlan(d, ctx({ now: at + 1000 })).do, 'wait');
  assert.equal(lootPlan(d, ctx({ health: 0 })).do, 'wait');
  assert.equal(lootPlan(d, ctx({ now: at + 5000, dist: 2 })).do, 'wait');
  const b = lootPlan({ ...d, retryAt: at + 25000 }, ctx());
  assert.deepEqual([b.do, b.why], ['wait', 'backing off']);
  assert.equal(lootPlan({ ...d, retryAt: at + 15000 }, ctx()).do, 'go');
});

test('at night far off: gear yes, junk no', () => {
  assert.equal(lootPlan({ at, worth: 4 }, ctx({ night: true, dist: 90 })).do, 'go');
  assert.equal(lootPlan({ at, worth: 0 }, ctx({ night: true, dist: 90 })).do, 'skip');
  assert.equal(lootPlan({ at, worth: 0 }, ctx({ night: true, dist: 20 })).do, 'go');
});

test('back-off grows and is capped', () => {
  assert.equal(backoffMs(1), 3000);
  assert.equal(backoffMs(4), 12000);
  assert.equal(backoffMs(50), 30000);
});
