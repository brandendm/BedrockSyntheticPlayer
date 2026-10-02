import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarise, compare } from '../behavior_pack/scripts/core/testrun.js';

const walk = (n, step, jumpEvery = 0) => Array.from({ length: n }, (_, i) => ({ t: i * 5, x: i * step, y: 64 + (jumpEvery && i % jumpEvery === 1 ? 1 : 0), z: 0, g: jumpEvery && i % jumpEvery === 1 ? 0 : 1, sn: 0, sp: 0, hp: 20 }));

test('a run is summarised', () => {
  const m = summarise(walk(40, 1), { placed: 2, broken: 1 });
  assert.equal(m.secs, 9.8);
  assert.ok(m.path >= 38 && m.path <= 40);
  assert.equal(m.directness, 1);
  assert.equal(m.placed, 2);
  assert.equal(summarise([{ t: 0, x: 0, y: 0, z: 0 }]), null);
});

test('jumps, standing still and damage are counted', () => {
  const s = walk(30, 0.5, 5).map((p, i) => (i > 20 ? { ...p, x: 10, hp: 17 } : p));
  const m = summarise(s);
  assert.ok(m.jumps >= 4, `jumps ${m.jumps}`);
  assert.ok(m.idleS > 1, `idle ${m.idleS}`);
  assert.equal(m.damage, 3);
});

test('two runs side by side say what differs', () => {
  const human = summarise(walk(20, 1));
  const bot = summarise(walk(60, 0.5).map((p, i) => ({ ...p, z: i % 2 ? 3 : 0 })), { broken: 6 });
  const c = compare('ladder', human, bot);
  assert.match(c, /you: 4\.8 s/);
  assert.match(c, /the bot took/);
  assert.match(c, /broke 6 more blocks/);
  assert.equal(compare('x', null, bot), null);
});

import { downsample, passRates } from '../behavior_pack/scripts/core/testrun.js';
test('a trace is downsampled and keeps the end', () => {
  const t = downsample(walk(1000, 1), 100);
  assert.ok(t.length <= 102);
  assert.deepEqual(t[t.length - 1].slice(1, 2), [999]);
  assert.deepEqual(downsample([]), []);
});
test('pass rates per side, omitted and skipped tests left out', () => {
  const r = passRates({ a: { human: { pass: true }, bot: { pass: false } }, b: { bot: { pass: true } }, c: { bot: { pass: true } }, d: { human: { pass: false, skipped: true } } }, ['c']);
  assert.deepEqual(r.bot, { pass: 1, total: 2, pct: 50 });
  assert.deepEqual(r.human, { pass: 1, total: 1, pct: 100 });
  assert.equal(passRates({}).bot.pct, null);
});
