import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, bootMedian, readRuns } from '../sim/validate.mjs';

const runs = (xs) => xs.map(([pass, secs]) => ({ pass, secs }));
test('compare: the sim passing where the game mostly fails is called too easy', () => {
  const c = compare(runs([[false, null], [false, null], [false, null], [true, 20]]), runs([[true, 9]]));
  assert.match(c.verdict, /TOO EASY/);
});
test('compare: a sim 40% faster than the game is flagged, a close one is ok', () => {
  const real = runs(Array.from({ length: 8 }, (_, i) => [true, 13 + (i % 3) * 0.2]));
  assert.equal(compare(real, runs([[true, 8]])).verdict, 'sim too fast');
  assert.equal(compare(real, runs([[true, 13.2]])).verdict, 'ok');
  assert.equal(compare([], runs([[true, 8]])).verdict, 'no real runs');
});
test('bootMedian is deterministic and brackets the median', () => {
  const a = [10, 11, 12, 12, 13, 14, 15], ci = bootMedian(a);
  assert.deepEqual(ci, bootMedian(a));
  assert.ok(ci[0] <= 12 && ci[1] >= 12);
  assert.equal(bootMedian([1, 2]), null);
});
test('readRuns: bot runs only, duplicates and stopped runs dropped, horse variants marked, cut lines skipped', () => {
  const t = [{ type: 'test_run', t: '1', name: 'leadstep', who: 'bot', pass: true, summary: { secs: 13 } }, { type: 'test_run', t: '1', name: 'leadstep', who: 'bot', pass: true, summary: { secs: 13 } }, { type: 'test_run', t: '2', name: 'leadgate', who: 'bot', stopped: true, pass: false }, { type: 'test_run', t: '3', name: 'leadstep', who: 'human', pass: true, summary: { secs: 9 } }, { type: 'test_run', t: '4', name: 'leadstephorse', who: 'bot', pass: true, summary: { secs: 20 } }].map((e) => JSON.stringify(e)).join('\n') + '\n{"type":"te';
  const r = readRuns(t);
  assert.equal(r.length, 2);
  assert.equal(r[1].horse, true);
  assert.equal(r[0].secs, 13);
});
