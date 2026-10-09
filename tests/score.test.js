import test from 'node:test';
import assert from 'node:assert/strict';
import { runScore } from '../behavior_pack/scripts/core/score.js';

test('passes: faster and healthier score higher, all within 0.6..1', () => {
  const fast = runScore({ pass: true, detail: 'reached the gold block in 20s; lowest health 18', cap: 300 });
  const slow = runScore({ pass: true, detail: 'reached the gold block in 280s; lowest health 3', cap: 300 });
  assert.ok(fast > slow && slow >= 0.6 && fast <= 1);
});
test('failures: the further it got, the higher; always below any pass', () => {
  const far = runScore({ pass: false, detail: 'died in 30s; lowest health 0, x 40/45' });
  const near = runScore({ pass: false, detail: 'died in 5s; lowest health 0, x 2/45' });
  assert.ok(far > near && far < 0.6);
  assert.ok(runScore({ pass: false, detail: 'still 2 below it in 200s' }) > runScore({ pass: false, detail: 'still 15 below it in 200s' }));
  assert.ok(runScore({ pass: false, detail: 'something odd' }) < 0.2);
});
test('no detail still gives a number', () => {
  assert.ok(Number.isFinite(runScore({ pass: true })) && Number.isFinite(runScore({ pass: false })));
});
