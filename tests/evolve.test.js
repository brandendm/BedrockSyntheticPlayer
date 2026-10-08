import test from 'node:test';
import assert from 'node:assert/strict';
import { mutate, criterion, variants } from '../sim/evolve_courses.mjs';
import { towParts } from '../sim/gencourse.mjs';
import { hardCourses, jobSets } from '../sim/evals.mjs';
import { TUNABLES } from '../behavior_pack/scripts/core/tunables.js';

test('mutate keeps courses valid and bounded', () => {
  let p = towParts(7, 2);
  for (let i = 0; i < 200; i++) {
    p = mutate(p);
    assert.ok(p.length >= 1 && p.length <= 7);
    for (const q of p) assert.ok(q.gap >= 2 && ['step', 'gate', 'wall', 'pit'].includes(q.kind));
  }
});
test('criterion: unsolved is worthless, a split is valuable, a default failure worth more', () => {
  assert.equal(criterion([false, false, false]).kind, 'unsolved');
  assert.equal(criterion([true, true, true]).score, 0);
  const a = criterion([true, false, false, true]), b = criterion([false, true, true, false]);
  assert.equal(b.kind, 'learnable');
  assert.ok(b.score > a.score);
});
test('variants stay inside the ranges', () => {
  for (const v of variants(30)) for (const [k, x] of Object.entries(v)) if (TUNABLES[k]) assert.ok(x >= TUNABLES[k].min - 1e-9 && x <= TUNABLES[k].max + 1e-9, k);
});
test('hard courses are split between train and held, a missing file is none', () => {
  assert.deepEqual(hardCourses('/nonexistent.json'), []);
  const { train, held } = jobSets('tow');
  assert.ok(train.length > 0 && held.length > 0);
});
