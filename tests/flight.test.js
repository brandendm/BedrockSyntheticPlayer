import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, stepLine, stepRuns, invDiff, pathAndNet } from '../behavior_pack/scripts/core/flight.js';

// n one-second samples; f(i) gives the fields that vary.
const run = (n, f) => Array.from({ length: n }, (_, i) => ({ t: i * 20, x: 0, y: 64, z: 0, hp: 20, food: 20, step: 'get_stone', mode: 'none', inv: 'a:1', sleeping: false, ...f(i) }));

test('frozen: in place, pack unchanged, 60 s', () => {
  const d = diagnose(run(60, () => ({})));
  assert.equal(d.kind, 'frozen');
  assert.match(d.why, /get_stone/);
});

test('not frozen while fighting, waiting on purpose, or asleep; too short a record says nothing', () => {
  assert.equal(diagnose(run(60, () => ({ mode: 'fight' }))), null);
  assert.equal(diagnose(run(60, () => ({ step: 'wait_smelt' }))), null);
  assert.equal(diagnose(run(60, () => ({ sleeping: true }))), null);
  assert.equal(diagnose(run(20, () => ({}))), null);
});

test('moving and gaining is fine', () => {
  assert.equal(diagnose(run(60, (i) => ({ x: i * 4, inv: `a:${i}` }))), null);
  assert.equal(diagnose(run(60, (i) => ({ x: i * 4 }))), null, 'walking somewhere with the pack the same is travel');
});

test('pacing: 30+ blocks walked, back where it started, nothing gained', () => {
  const d = diagnose(run(60, (i) => ({ x: i % 10 < 5 ? (i % 10) * 2 : (10 - (i % 10)) * 2 })));
  assert.equal(d.kind, 'pacing');
});

test('spinning: the plan flips 8+ times with nothing gained and nowhere gone', () => {
  const d = diagnose(run(60, (i) => ({ step: i % 6 < 3 ? 'get_stone' : 'craft', x: (i % 2) * 0.5 })));
  assert.equal(d.kind, 'spinning');
});

test('starving: food 0, health falling, nothing eaten', () => {
  const d = diagnose(run(60, (i) => ({ food: 0, hp: 20 - Math.floor(i / 15), x: i * 3 })));
  assert.equal(d.kind, 'starving');
});

test('the steps in order, runs folded; the pack diff', () => {
  const s = [...run(4, () => ({ step: 'get_stone' })), ...run(2, () => ({ step: 'craft' })), ...run(3, () => ({ step: 'get_stone' }))];
  assert.equal(stepLine(s), 'get_stone 4s > craft 2s > get_stone 3s');
  assert.equal(stepRuns(s).length, 3);
  assert.equal(invDiff({ cobblestone: 5, oak_log: 3 }, { cobblestone: 17, stick: 2 }), 'cobblestone +12, oak_log -3, stick +2');
  assert.equal(invDiff({ a: 1 }, { a: 1 }), 'nothing');
  assert.deepEqual(pathAndNet(run(3, (i) => ({ x: i * 3 }))), { path: 6, net: 6 });
});

test('a pool loop looks like spinning: the plan restarts every few seconds with nothing gained', () => {
  // swim_out <-> get_iron every 4 s for a minute, pack the same, in place
  const d = diagnose(run(60, (i) => ({ step: i % 4 < 2 ? 'get_iron' : 'swim_out', x: (i % 2) * 0.3 })));
  assert.ok(d && ['spinning', 'pacing', 'frozen'].includes(d.kind));
});
