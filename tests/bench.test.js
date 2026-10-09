import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, MILESTONES, score, summarize, weakestLink } from '../behavior_pack/scripts/core/bench.js';

test('milestones are recorded once, with the time, and never un-reached', () => {
  const t = new Tracker();
  assert.deepEqual(t.update(5, { oak_log: 1 }, { x: 0, y: 70, z: 0 }).map((e) => e.id), ['log']);
  assert.deepEqual(t.update(10, {}, { x: 3, y: 70, z: 0 }).filter((e) => e.type === 'milestone'), []);
  assert.deepEqual(t.update(30, { oak_planks: 4, crafting_table: 1, wooden_pickaxe: 1 }, { x: 5, y: 70, z: 0 }).map((e) => e.id), ['planks', 'table', 'wood_pickaxe']);
  assert.equal(t.result(600).achieved.log, 5);
});
test('a stall is a minute with nothing new and no movement, with what the bot was doing', () => {
  const t = new Tracker();
  const p = { x: 0, y: 70, z: 0 };
  let stalls = [];
  for (let s = 0; s <= 200; s += 5) stalls.push(...t.update(s, { dirt: 1 }, p, { step: 'get_logs', mode: 'none' }).filter((e) => e.type === 'stall'));
  assert.ok(stalls.length >= 2 && stalls.length <= 4);
  assert.equal(stalls[0].step, 'get_logs');
  const m = new Tracker(); let moved = 0;
  for (let s = 0; s <= 200; s += 5) moved += m.update(s, { dirt: 1 }, { x: s, y: 70, z: 0 }).filter((e) => e.type === 'stall').length;
  assert.equal(moved, 0);
});
test('score rewards earlier and further, and a death costs', () => {
  assert.ok(score({ log: 10 }, 0, 600) > score({ log: 500 }, 0, 600));
  assert.ok(score({ log: 10, iron_pickaxe: 100 }, 0, 600) > score({ log: 10 }, 0, 600));
  assert.ok(score({ log: 10 }, 1, 600) < score({ log: 10 }, 0, 600));
  assert.equal(MILESTONES.length, new Set(MILESTONES.map((m) => m.id)).size);
});
test('summary: reached counts, medians, ranked stalls and deaths, the weakest link', () => {
  const runs = [
    { achieved: { log: 10, planks: 20, table: 25 }, stalls: [{ step: 'get_stone', mode: 'none' }], deaths: [], score: 3 },
    { achieved: { log: 14, planks: 30 }, stalls: [{ step: 'get_stone', mode: 'none' }, { step: 'x', mode: 'flee' }], deaths: [{ cause: 'zombie', last: 'planks' }], score: 1 },
    { achieved: { log: 12 }, stalls: [], deaths: [], score: 1 },
  ];
  const s = summarize(runs, 600);
  assert.equal(s.milestones[0].median_s, 12);
  assert.equal(s.milestones.find((m) => m.id === 'table').reached, 1);
  assert.equal(s.top_stalls[0].what, 'get_stone / none');
  assert.equal(s.deaths, 1);
  assert.equal(weakestLink(s), 'planks');
});
