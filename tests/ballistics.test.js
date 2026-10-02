import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heightAt, solvePitch } from '../behavior_pack/scripts/core/ballistics.js';

test('an arrow drops over distance', () => {
  assert.ok(heightAt(0, 12) < 0 && heightAt(0, 12) > -1);
  assert.ok(heightAt(0, 40) < heightAt(0, 12));
});
test('the solved pitch lands on the target', () => {
  for (const [d, dy] of [[12, 0], [12, -0.6], [30, 1], [5, 0]]) {
    const th = solvePitch(d, dy);
    assert.ok(Math.abs(heightAt(th, d) - dy) < 0.05, `${d},${dy}: ${heightAt(th, d)}`);
  }
  assert.ok(solvePitch(40, 0) > solvePitch(12, 0));
});
