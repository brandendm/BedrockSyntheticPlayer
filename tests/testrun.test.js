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

import { addStat, avgRates } from '../behavior_pack/scripts/core/testrun.js';
test('lifetime stats and the average pass rate', () => {
  const st = {};
  addStat(st, 'tower', 'bot', true); addStat(st, 'tower', 'bot', false); addStat(st, 'tower', 'human', true); addStat(st, 'hole', 'bot', true);
  assert.deepEqual(st.tower.bot, { p: 1, n: 2, last: { pass: false, at: 0, build: '' } });
  const a = avgRates(st);
  assert.deepEqual(a.bot, { pass: 2, total: 3, pct: 67 });
  assert.equal(a.human.pct, 100);
  assert.equal(avgRates(st, ['tower']).human.pct, null);
});

import { technique } from '../behavior_pack/scripts/core/testrun.js';
test('technique: first action, view turning, held items, event counts', () => {
  const S = Array.from({ length: 40 }, (_, i) => ({ t: i * 2, x: i < 10 ? 0 : (i - 10) * 0.3, y: 64, z: 0, g: 1, sn: 0, sp: 0, hp: 20, yw: i * 5, pt: 0, w: 0, cl: 0, sl: i < 20 ? 0 : 3, hd: i < 20 ? 'stone_sword' : 'dirt' }));
  const ev = [[1.2, 'p', 'dirt', 0, 64, 0, 'dirt'], [1.5, 'b', 'stone', 1, 64, 0, 'stone_pickaxe'], [2, 'h', 'husk'], [2, 'd', 'husk', 5], [3, 'D', 'contact', 2, 'husk'], [3, 'k', 'husk']];
  const t = technique(S, ev);
  assert.ok(t.firstActionS >= 0.9 && t.firstActionS <= 1.3, `first ${t.firstActionS}`);
  assert.equal(t.slotChanges, 1);
  assert.ok(t.turnYawDeg >= 190);
  assert.deepEqual(t.placedBy, { dirt: 1 });
  assert.equal(t.hits, 1); assert.equal(t.dealt, 5); assert.equal(t.taken, 2); assert.equal(t.kills, 1);
  assert.ok(t.held.stone_sword > 0 && t.held.dirt > 0);
  const m = summarise(S, { placed: 1, inv: { gained: {}, spent: { dirt: 1 } } }, ev);
  assert.equal(m.inv.spent.dirt, 1);
});
