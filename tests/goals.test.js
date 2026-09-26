import test from 'node:test';
import assert from 'node:assert/strict';
import { goalChain } from '../behavior_pack/scripts/core/goals.js';

test('goal chain: first unfinished goal is current, with have/need counts', () => {
  const g = goalChain({ inv: { wooden_pickaxe: 1, wooden_sword: 1, cobblestone: 5 }, tableKnown: true, step: 'get_stone' });
  assert.equal(g[0].status, 'done');
  assert.equal(g[1].goal, 'Stone tools');
  assert.equal(g[1].status, 'current');
  assert.deepEqual([g[1].tasks[0].name, g[1].tasks[0].have, g[1].tasks[0].need], ['Cobblestone', 5, 9]);
  assert.equal(g[1].currentTask, 0);
  assert.ok(g.slice(2).every((x) => x.status === 'todo'));
});

test('goal chain: a later goal is current when that is what the bot is working on', () => {
  const kit = { stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, furnace: 1 };
  const g = goalChain({ inv: { ...kit, oak_log: 1 }, tableKnown: true, step: 'smelt' });
  assert.equal(g.find((x) => x.status === 'current').goal, 'Torches'); // no sheep: the bed waits
  const h = goalChain({ inv: { ...kit, bed: 1, torch: 8, cobblestone: 10 }, tableKnown: true, step: 'get_stone',
    project: { placed: 20, total: 69, needs: { stone: 6, planks: 0 } } });
  const house = h.find((x) => x.goal === 'House');
  assert.equal(house.status, 'current');
  assert.deepEqual([house.tasks[1].have, house.tasks[1].need], [10, 16]);
  assert.deepEqual([house.tasks[4].have, house.tasks[4].need], [20, 69]);
});
