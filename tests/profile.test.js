import test from 'node:test';
import assert from 'node:assert/strict';
import { adopt, DEFAULTS, LIMITS, MIN_SAMPLES } from '../behavior_pack/scripts/core/profile.js';

test('nothing learned: the defaults', () => {
  assert.deepEqual(adopt(null), { params: { ...DEFAULTS }, notes: [] });
  assert.deepEqual(adopt({ params: {} }).params, DEFAULTS);
});

test('too few samples: not taken up yet; enough: taken up and said', () => {
  const few = adopt({ params: { eat_at: { value: 10, n: MIN_SAMPLES.eat_at - 1 } } });
  assert.equal(few.params.eat_at, DEFAULTS.eat_at);
  const enough = adopt({ params: { eat_at: { value: 10, n: MIN_SAMPLES.eat_at }, iron_y: { value: -54, n: 20 } } });
  assert.equal(enough.params.eat_at, 10);
  assert.equal(enough.params.iron_y, -54);
  assert.equal(enough.notes.length, 2);
  assert.match(enough.notes[0], /eat_at 14 -> 10/);
});

test('a strange recording stays inside the limits', () => {
  const r = adopt({ params: { eat_at: { value: 2, n: 50 }, iron_y: { value: 200, n: 50 } } });
  assert.equal(r.params.eat_at, LIMITS.eat_at[0]);
  assert.equal(r.params.iron_y, LIMITS.iron_y[1]);
  assert.match(r.notes.join(' '), /kept within/);
  const junk = adopt({ params: { eat_at: { value: NaN, n: 50 }, iron_y: { value: null, n: 50 } } });
  assert.deepEqual(junk.params, DEFAULTS);
});

test('a learned number equal to the default says nothing', () => {
  assert.deepEqual(adopt({ params: { eat_at: { value: 14, n: 30 } } }).notes, []);
});
