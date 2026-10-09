import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShow, resolveMob, roundWinner, MOB_LIST, personality } from '../behavior_pack/scripts/core/colosseum.js';

test('resolveMob: names, spaces, namespaces, aliases, prefixes', () => {
  assert.deepEqual(resolveMob(['iron', 'golem']), { id: 'iron_golem', known: true });
  assert.deepEqual(resolveMob('minecraft:Creeper'), { id: 'creeper', known: true });
  assert.equal(resolveMob(['dragon']).id, 'ender_dragon');
  assert.deepEqual(resolveMob(['frobnitz']), { id: 'frobnitz', known: false });
  assert.equal(resolveMob([]), null);
  assert.equal(resolveMob(['bad;name']), null);
});

test('parseShow: commands, mobs with counts, bots, rounds and team', () => {
  assert.equal(parseShow([]).cmd, 'help');
  assert.equal(parseShow(['stop']).cmd, 'stop');
  const z = parseShow(['zombie', '6']);
  assert.deepEqual([z.cmd, z.mode, z.mob.id, z.count, z.team, z.rounds], ['show', 'mobs', 'zombie', 6, 2, 3]);
  const g = parseShow(['iron', 'golem', '2', 'rounds', '5', 'team', '3']);
  assert.deepEqual([g.mob.id, g.count, g.rounds, g.team], ['iron_golem', 2, 5, 3]);
  const b = parseShow(['bots', 'team', '2']);
  assert.deepEqual([b.mode, b.team, b.rounds], ['bots', 2, 3]);
  assert.equal(parseShow(['bots']).team, 1);
  assert.equal(parseShow(['wither', '9']).count, 1);
  assert.equal(parseShow(['zombie', '99']).count, 12);
  assert.ok(MOB_LIST.includes(parseShow(['random']).mob.id));
});

test('roundWinner', () => {
  assert.equal(roundWinner({ botsLeft: 2, foesLeft: 0 }), 'bots');
  assert.equal(roundWinner({ botsLeft: 0, foesLeft: 3 }), 'foes');
  assert.equal(roundWinner({ botsLeft: 1, foesLeft: 1 }), '');
  assert.equal(roundWinner({ botsLeft: 1, foesLeft: 1, timedOut: true }), 'draw');
  assert.equal(roundWinner({ botsLeft: 2, foesLeft: 1, timedOut: true }), 'bots');
  assert.equal(roundWinner({ botsLeft: 0, foesLeft: 0 }), 'draw');
});

test('personality is one of the styles', () => {
  assert.ok(['archer', 'brawler', 'dancer'].includes(personality(() => 0.5).name));
});
