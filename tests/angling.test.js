import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMakeCampfire, cookBatch, wantCampfire, newBite, biteStep, SETTLE_TICKS, fishGained } from '../behavior_pack/scripts/core/angling.js';
import { canCraft, applyCraft, planCrafts } from '../behavior_pack/scripts/core/recipes.js';

test('campfire needs sticks, coal and three logs; planks stand in for sticks', () => {
  assert.equal(canMakeCampfire({ stick: 3, coal: 1, oak_log: 3 }), true);
  assert.equal(canMakeCampfire({ oak_planks: 2, charcoal: 1, birch_log: 3 }), true);
  assert.equal(canMakeCampfire({ stick: 3, coal: 1, oak_log: 2 }), false);
  assert.equal(canMakeCampfire({ stick: 3, oak_log: 3 }), false);
  assert.equal(canMakeCampfire({ stick: 3, coal: 1, stripped_oak_log: 3 }), false);
});

test('recipes: campfire and rod craft from the right inputs', () => {
  const inv = { stick: 3, coal: 1, oak_log: 3, string: 2 };
  assert.ok(canCraft(inv, 'campfire'));
  assert.ok(canCraft(inv, 'fishing_rod'));
  const r = applyCraft(inv, 'campfire');
  assert.equal(r.inv.campfire, 1);
  assert.equal(r.inv.oak_log, undefined);
  assert.equal(applyCraft(inv, 'fishing_rod').inv.fishing_rod, 1);
  assert.equal(canCraft({ stick: 3, string: 1 }, 'fishing_rod'), false);
  const p = planCrafts({ oak_planks: 2, coal: 1, oak_log: 3 }, ['campfire']);
  assert.deepEqual(p.steps, ['stick', 'campfire']);
});

test('cookBatch fills four slots with the plentiful kind first', () => {
  assert.deepEqual(cookBatch({ beef: 3, porkchop: 2, stick: 9 }), [{ id: 'beef', n: 3 }, { id: 'porkchop', n: 1 }]);
  assert.deepEqual(cookBatch({ beef: 9 }), [{ id: 'beef', n: 4 }]);
  assert.deepEqual(cookBatch({ cooked_beef: 3 }), []);
});

test('wantCampfire: raw food, no furnace near, a fire in reach', () => {
  assert.equal(wantCampfire({ beef: 3, campfire: 1 }), true);
  assert.equal(wantCampfire({ beef: 3, campfire: 1 }, { furnaceHandy: true }), false);
  assert.equal(wantCampfire({ beef: 1, campfire: 1 }), false);
  assert.equal(wantCampfire({ beef: 3 }), false);
  assert.equal(wantCampfire({ beef: 3, stick: 3, coal: 1, oak_log: 3 }), true);
});

test('bite: only after the hook has settled, on a dip or a fast drop; dry hooks reset', () => {
  const st = newBite();
  for (let i = 0; i < SETTLE_TICKS - 1; i++) assert.equal(biteStep(st, { y: 62.9, vy: -0.3, wet: true }), false); // (still settling: a splash is not a bite)
  const s2 = newBite();
  for (let i = 0; i < SETTLE_TICKS + 5; i++) assert.equal(biteStep(s2, { y: 62.9, vy: 0.01, wet: true }), false);
  assert.equal(biteStep(s2, { y: 62.9, vy: -0.25, wet: true }), true);
  assert.equal(biteStep(s2, { y: 62.5, vy: -0.25, wet: true }), false); // (once)
  const s3 = newBite();
  for (let i = 0; i < SETTLE_TICKS + 5; i++) biteStep(s3, { y: 62.9, vy: 0, wet: true });
  assert.equal(biteStep(s3, { y: 62.6, vy: -0.02, wet: true }), true); // (a 0.3 sink)
  const s4 = newBite();
  for (let i = 0; i < 100; i++) assert.equal(biteStep(s4, { y: 70, vy: -0.5, wet: false }), false); // (in the air)
});

test('fishGained counts raw and cooked fish only', () => {
  assert.equal(fishGained({ cod: 1 }, { cod: 3, stick: 4, salmon: 1 }), 3);
  assert.equal(fishGained({}, { rotten_flesh: 2 }), 0);
});
