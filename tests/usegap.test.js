import test from 'node:test';
import assert from 'node:assert/strict';
import { GapTuner, GAP_START, GAP_MAX } from '../behavior_pack/scripts/core/usegap.js';

test('starts at 5, the owner\'s pace, well under the 10 that blocks need', () => {
  const t = new GapTuner();
  assert.equal(t.gap, GAP_START);
  assert.ok(t.gap < GAP_MAX);
});

test('a refusal puts the gap up by two, and never more than 10', () => {
  const t = new GapTuner();
  assert.equal(t.refused(), 7);
  assert.equal(t.refused(), 9);
  assert.equal(t.refused(), 10);
  assert.equal(t.refused(), 10);
});

test('four taken uses in a row try one tick less, down to the floor of 3', () => {
  const t = new GapTuner();
  for (let i = 0; i < 3; i++) assert.equal(t.ok(), false);
  assert.equal(t.ok(), true);
  assert.equal(t.gap, 4);
  for (let i = 0; i < 4; i++) t.ok();
  assert.equal(t.gap, 3);
  for (let i = 0; i < 20; i++) t.ok();
  assert.equal(t.gap, 3);
});

test('never goes back down to a gap that was refused', () => {
  const t = new GapTuner();
  for (let i = 0; i < 8; i++) t.ok();       // 5 -> 4 -> 3
  assert.equal(t.gap, 3);
  t.refused();                               // 3 refused: 5
  assert.equal(t.gap, 5);
  for (let i = 0; i < 40; i++) t.ok();       // may go to 4 (never refused), not to 3
  assert.equal(t.gap, 4);
  t.refused();                               // 4 refused: 6
  assert.equal(t.gap, 6);
  for (let i = 0; i < 40; i++) t.ok();       // 5 was never refused: down to 5, stops there
  assert.equal(t.gap, 5);
});

test('a game that refuses everything under 10 settles at 10 after a few tries, and stays there', () => {
  const t = new GapTuner();
  let tries = 0, now = 0, last = -100;
  const take = () => { tries++; const since = now - last; last = now; return since >= 10; };
  for (let use = 0; use < 24; use++) {
    for (;;) {
      now += t.gap;
      if (take()) { t.ok(); break; }
      t.refused();
    }
  }
  assert.equal(t.gap, 10);
  assert.ok(tries <= 24 + 4, `${tries} calls for 24 uses`);
});

test('a game that takes 5 keeps 5 and tries 4 (taken), then 3 (refused) and holds 4', () => {
  const t = new GapTuner();
  const limit = 4;
  let now = 0, last = -100, calls = 0;
  for (let use = 0; use < 40; use++) {
    for (;;) {
      now += t.gap; calls++;
      const since = now - last; last = now;
      if (since >= limit) { t.ok(); break; }
      t.refused();
    }
  }
  assert.equal(t.gap, 4);
  assert.ok(t.refusals <= 1);
});
