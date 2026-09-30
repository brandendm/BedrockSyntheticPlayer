import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, EXPECTED } from '../behavior_pack/scripts/core/calibrate.js';

test('calibrate: what the code was built on says nothing', () => {
  const j = judge({ head: 1.52, apex: 1.2522, airTicks: 12, useGap: 10 });
  assert.deepEqual(j.notes, []);
  assert.equal(j.adopt.eyeHeight, 1.52);
  assert.equal(j.adopt.useGap, 10);
});

test('calibrate: a taller head is adopted and reported', () => {
  const j = judge({ head: 1.62 });
  assert.equal(j.adopt.eyeHeight, 1.62);
  assert.equal(j.notes.length, 1);
  assert.match(j.notes[0], /1\.62/);
});

test('calibrate: a head that is not believable is left alone', () => {
  for (const head of [0.4, 2.6, NaN, Infinity]) {
    const j = judge({ head });
    assert.equal(j.adopt.eyeHeight, undefined, `head ${head}`);
  }
});

test('calibrate: a different item-use gap is adopted, within limits', () => {
  assert.equal(judge({ useGap: 6 }).adopt.useGap, 6);
  assert.equal(judge({ useGap: 6 }).notes.length, 1);
  assert.equal(judge({ useGap: 1 }).adopt.useGap, 2);
  assert.equal(judge({ useGap: 30 }).adopt.useGap, 16);
});

test('calibrate: a different jump is reported, nothing adopted', () => {
  const j = judge({ apex: 1.5, airTicks: 15 });
  assert.equal(j.notes.length, 2);
  assert.deepEqual(j.adopt, {});
});

test('calibrate: missing measures are skipped', () => {
  const j = judge({});
  assert.deepEqual(j, { notes: [], adopt: {} });
  assert.equal(EXPECTED.head, 1.52);
});
