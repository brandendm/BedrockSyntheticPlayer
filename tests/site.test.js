import test from 'node:test';
import assert from 'node:assert/strict';
import { siteWork, siteScore, biomeCost } from '../behavior_pack/scripts/core/site.js';

const kit = { stone_axe: 1, stone_shovel: 1, stone_pickaxe: 1 };
const flat = () => [...Array(100).fill({ id: 'air', part: 'clear' }), ...Array(26).fill({ id: 'grass_block', part: 'foot' })];

test('flat open ground is nearly free; a small tree or our table is fine, a build or water is not', () => {
  const w = siteWork(flat(), kit);
  assert.equal(w.ok, true);
  assert.ok(w.seconds < 1);
  const tree = flat(); tree[10] = { id: 'oak_log', part: 'clear' }; tree[11] = { id: 'oak_log', part: 'clear' }; tree[12] = { id: 'oak_leaves', part: 'clear' };
  const wt = siteWork(tree, kit);
  assert.equal(wt.ok, true); assert.equal(wt.logs, 2);
  const table = flat(); table[5] = { id: 'crafting_table', part: 'clear' };
  assert.equal(siteWork(table, kit).moves, 1, 'our table: move it, not a reason to go elsewhere');
  const built = flat(); built[5] = { id: 'oak_planks', part: 'clear' };
  assert.equal(siteWork(built, kit).ok, false);
  const wet = flat(); wet[110] = { id: 'water', part: 'foot' };
  assert.equal(siteWork(wet, kit).ok, false);
});

test('dips: fill up to 2 deep, a deeper hole rules it out', () => {
  const d1 = flat(); d1[105] = { id: 'air', part: 'foot', below: 'dirt' };
  const d2 = flat(); d2[105] = { id: 'air', part: 'foot', below: 'air', below2: 'dirt' };
  const d3 = flat(); d3[105] = { id: 'air', part: 'foot', below: 'air', below2: 'air' };
  assert.ok(siteWork(d1, kit).ok && siteWork(d2, kit).ok);
  assert.equal(siteWork(d3, kit).ok, false);
});

test('plains and ordinary forest beat dense forest, swamp and shore; must fit before dusk', () => {
  assert.ok(biomeCost('minecraft:plains') < biomeCost('minecraft:taiga'));
  assert.ok(biomeCost('minecraft:forest') < biomeCost('minecraft:roofed_forest'));
  assert.ok(biomeCost('minecraft:birch_forest') < biomeCost('minecraft:swampland'));
  const w = siteWork(flat(), kit);
  assert.ok(siteScore(w, { biome: 'plains' }) < siteScore(w, { biome: 'roofed_forest' }));
  const bumpy = { ok: true, seconds: 60, logs: 0, moves: 0 };
  assert.ok(siteScore(bumpy, { secondsLeft: 100 }) > siteScore(w, { secondsLeft: 100, dist: 40 }), 'no time to clear it before dark');
});
