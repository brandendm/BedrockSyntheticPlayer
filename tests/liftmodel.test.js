import test from 'node:test';
import assert from 'node:assert/strict';
import { jumpsNeeded, minLength, liftPlan, excess, fitLift, LIFT } from '../behavior_pack/scripts/core/liftmodel.js';

test('one up but only two out: a jump pulls nothing, however you try', () => {
  assert.equal(jumpsNeeded(1, 2), Infinity);
  assert.ok(excess(1, 2) < 0);
});
test('further out: two jumps, then further still one', () => {
  const n = [4, 5, 6, 6.4, 7, 8].map((d) => jumpsNeeded(1, d));
  assert.equal(n[0], Infinity); assert.equal(n[1], Infinity);
  assert.equal(n[2], Infinity); assert.ok(n[3] >= 2 && Number.isFinite(n[3]));
  assert.ok(n[4] >= 2 && n[5] === 1);   // fitted to real probejumps (u288)
  for (let i = 1; i < n.length; i++) assert.ok(n[i] <= n[i - 1], 'never more jumps the further out');
});
test('going down does nothing: below the boat the lead is shorter', () => {
  assert.ok(excess(0, 6) < excess(2, 6) && excess(0, 6) < 0);
  assert.equal(jumpsNeeded(-3, 5), Infinity);
});
test('minLength is the inverse of jumpsNeeded', () => {
  for (const h of [0, 1, 2, 3]) for (const j of [1, 2, 3]) {
    const d = minLength(h, j);
    assert.ok(jumpsNeeded(h, d + 0.05) <= j, `h ${h} j ${j} d ${d}`);
    if (j === 1 && d > 0.2) assert.ok(jumpsNeeded(h, d - 0.2) > j);
  }
});
test('higher steps need more length for the same number of jumps', () => {
  assert.ok(minLength(3, 1) > 0 && minLength(1, 1) < 8);
  assert.ok(minLength(1, 2) < minLength(1, 1));
});
test('liftPlan: the fewest jumps that fit the guard; extra length when the room is short', () => {
  const a = liftPlan({ h: 1, guard: 8.8, room: 20 });
  assert.equal(a.feasible, true); assert.equal(a.jumps, 1);
  const b = liftPlan({ h: 1, guard: 8.8, room: 6.7 });   // little room: more jumps from nearer
  assert.equal(b.feasible, true); assert.ok(b.jumps >= 2 && b.d <= 6.7 + 1e-9);
  const c = liftPlan({ h: 1, guard: 8.8, room: 1.5 });   // elevation but no length: build
  assert.equal(c.feasible, false); assert.ok(c.extra > 0);
});
test('fitLift recovers a model from trials made with it', () => {
  const truth = { pull: 5.9, jump: 1.0, need0: 1.2, needPerH: 0.4, maxJumps: 4 };
  const trials = [];
  for (const h of [1, 2, 3]) for (const d of [3, 4, 5, 5.5, 6, 6.5, 7, 7.5, 8, 9]) { const j = jumpsNeeded(h, d, truth); trials.push({ h, d, jumps: Number.isFinite(j) ? j : 0 }); }
  const f = fitLift(trials);
  assert.equal(f.wrong, 0);
  assert.ok(LIFT.pull > 0);
});
