import test from 'node:test';
import assert from 'node:assert/strict';
import { bake } from '../tools/bake_policy.mjs';
import fs from 'node:fs';

test('bakes known in-range keys into the defaults and skips the rest', () => {
  const src = fs.readFileSync(new URL('../behavior_pack/scripts/core/tunables.js', import.meta.url), 'utf8');
  const r = bake(src, { fightMargin: 0.7, fleeHealth: 99, nonsense: 1, keepFightingMargin: 'x' });
  assert.deepEqual(r.done, ['fightMargin']);
  assert.deepEqual(r.skipped.sort(), ['fleeHealth', 'keepFightingMargin', 'nonsense']);
  assert.match(r.src, /fightMargin:\s+\{ v: 0\.7,/);
  assert.match(r.src, /fleeHealth:\s+\{ v: 6,/);
});
test('tow keys are found in towtune.js', () => {
  const src = fs.readFileSync(new URL('../behavior_pack/scripts/core/towtune.js', import.meta.url), 'utf8');
  const r = bake(src, { guardMax: 9.0 });
  assert.deepEqual(r.done, ['guardMax']);
});
