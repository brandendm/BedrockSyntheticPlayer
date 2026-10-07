import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProbe } from '../sim/probes_run.mjs';
import { distance } from '../sim/calibrate.mjs';

test('the simulator runs a probe deterministically and a trace is at distance 0 from itself', async () => {
  const a = await runProbe('probewalk'), b = await runProbe('probewalk');
  assert.deepEqual(a.rows, b.rows);
  assert.equal(distance(a.rows, b.rows).rms, 0);
  assert.ok(a.rows[a.rows.length - 1][0] > 1, 'the walker moved east');
});

test('the lead follows: a boat 8 away is pulled in to about the lead\'s rest length', async () => {
  const r = await runProbe('probepull');
  const last = r.rows[60];
  const gap = last[0] - last[6];
  assert.ok(gap > 3 && gap < 6, `gap ${gap}`);
});

test('distance tolerates a timing shift of a tick or two but not a speed error', () => {
  const line = (v, shift = 0) => Array.from({ length: 60 }, (_, i) => [(i + shift) * v, 1, 0, v, 0, 0]);
  assert.ok(distance(line(0.2), line(0.2, 1)).rms < 0.05);
  assert.ok(distance(line(0.2), line(0.3)).rms > 0.5);
});
