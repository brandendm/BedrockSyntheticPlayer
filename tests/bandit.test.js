import test from 'node:test';
import assert from 'node:assert/strict';
import { Bandit, betaSample } from '../behavior_pack/scripts/core/bandit.js';

const seeded = (s) => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

test('with no evidence it follows the model (the prior arm)', () => {
  const b = new Bandit({}, seeded(1));
  let prior = 0;
  for (let i = 0; i < 200; i++) if (b.pick('up:hand', ['stairs', 'pillar'], 'stairs') === 'stairs') prior++;
  assert.ok(prior > 120 && prior < 200, `prior chosen ${prior}/200`);
});
test('evidence beats the model: the arm that wins gets chosen', () => {
  const b = new Bandit({}, seeded(2));
  for (let i = 0; i < 12; i++) { b.report('c', 'stairs', false); b.report('c', 'pillar', true); }
  let pillar = 0;
  for (let i = 0; i < 200; i++) if (b.pick('c', ['stairs', 'pillar'], 'stairs') === 'pillar') pillar++;
  assert.ok(pillar > 190, `pillar chosen ${pillar}/200`);
});
test('one arm is returned as is; contexts are separate; the store is plain data', () => {
  const store = {};
  const b = new Bandit(store, seeded(3));
  assert.equal(b.pick('x', ['only']), 'only');
  b.report('a', 'm', true); b.report('b', 'm', false);
  assert.deepEqual(store, { a: { m: { w: 1, n: 1 } }, b: { m: { w: 0, n: 1 } } });
  assert.match(b.summary(), /a: m 1\/1/);
  const r9 = seeded(9); const m = Array.from({ length: 400 }, () => betaSample(5, 5, r9)).reduce((x, y) => x + y, 0) / 400;
  assert.ok(m > 0.3 && m < 0.7);
});
