import test from 'node:test';
import assert from 'node:assert/strict';
import { terrainCourse, terrainCommands, TERRAIN_KINDS, routeExists } from '../behavior_pack/scripts/core/terrain.js';

test('every course has a start, text and a sane command count', () => {
  for (const k of TERRAIN_KINDS) for (const lv of [1, 2, 3]) for (let s = 1; s <= 40; s++) {
    const c = terrainCourse(k, s, lv);
    assert.ok(c.text.length > 20 && c.start && (c.mobs.length >= 1 || c.waves.length >= 1), `${k} ${lv} ${s}`);
    assert.ok(terrainCommands(c, 0, 60, 0).length < 700, `${k} ${lv} ${s} too many commands`);
    assert.ok(c.goal || c.survive, `${k} has neither goal nor survive time`);
  }
});
test('grid courses have a clean route from start to goal', () => {
  for (const k of ['thicket', 'jungle', 'swamp', 'lavafield']) for (const lv of [1, 2, 3]) for (let s = 1; s <= 40; s++) {
    const c = terrainCourse(k, s, lv);
    assert.ok(routeExists(c.grid, c.start.x, c.start.z, c.goal.x, c.goal.z, c.W), `${k} ${lv} ${s}`);
  }
});
test('mobs never start inside an obstacle', () => {
  for (const k of ['thicket', 'jungle', 'swamp', 'lavafield']) for (let s = 1; s <= 40; s++) {
    const c = terrainCourse(k, s, 2);
    for (const m of c.mobs) if (m.type !== 'drowned') assert.ok(!['trunk', 'bush', 'lava'].includes(c.grid.get(`${m.x},${m.z}`)), `${k} ${s} ${m.type}`);
  }
});
test('the labyrinth is solvable and its mobs sit in corridors', () => {
  for (const lv of [1, 2, 3]) for (let s = 1; s <= 40; s++) {
    const c = terrainCourse('mobmaze', s, lv), open = c.grid, has = (x, z) => open.has(JSON.stringify({ x, z }));
    const seen = new Set([`${c.start.x},${c.start.z}`]), q = [[c.start.x, c.start.z]]; let ok = false;
    while (q.length) { const [x, z] = q.pop(); if (x === c.goal.x && z === c.goal.z) { ok = true; break; } for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = `${x + dx},${z + dz}`; if (has(x + dx, z + dz) && !seen.has(k)) { seen.add(k); q.push([x + dx, z + dz]); } } }
    assert.ok(ok, `maze ${lv} ${s}`);
    for (const m of c.mobs) assert.ok(has(m.x, m.z), `maze mob ${lv} ${s}`);
  }
});
test('ambush has waves and bait, siege a survive time, the others a goal block', () => {
  assert.ok(terrainCourse('ambush', 3, 2).waves.length >= 3 && terrainCourse('ambush', 3, 2).bait.length >= 4);
  assert.ok(terrainCourse('siege', 1, 3).survive > terrainCourse('siege', 1, 1).survive);
  assert.ok(terrainCommands(terrainCourse('thicket', 1, 1), 0, 60, 0).some((c) => c.endsWith('gold_block')));
  assert.throws(() => terrainCourse('nope'));
});

import fs from 'node:fs';
import { CAVE_KINDS } from '../behavior_pack/scripts/core/caves.js';
import { OCEAN_KINDS } from '../behavior_pack/scripts/core/ocean.js';
import { TOW_NAMES } from '../behavior_pack/scripts/core/towcourses.js';
test('every test the trainer runs exists in the scenario list', () => {
  const sc = fs.readFileSync(new URL('../behavior_pack/scripts/game/scenarios.js', import.meta.url), 'utf8');
  const names = new Set([...sc.match(/const NAMES = \[(.*?)\];/s)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
  [...CAVE_KINDS, ...OCEAN_KINDS, ...TERRAIN_KINDS, ...TOW_NAMES].forEach((n) => names.add(n));
  const tr = fs.readFileSync(new URL('../brain/trainer.py', import.meta.url), 'utf8');
  const block = tr.match(/GROUP_TESTS = \{(.*?)\n\}/s)[1] + tr.match(/GUARD_TESTS = \[(.*?)\]/s)[1];
  const used = [...block.matchAll(/"([a-z]+)"/g)].map((m) => m[1]).filter((n) => !['tow', 'combat', 'cave', 'play'].includes(n));
  assert.ok(used.length > 20);
  for (const n of used) assert.ok(names.has(n), `trainer runs ${n}, which is not a test`);
});
