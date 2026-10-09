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

import { gearFrom, loadoutKit, meleeIds, describeLoadout, LOADOUT_DEFAULT } from '../behavior_pack/scripts/core/colosseum.js';

test('gear: default is full diamond, three weapons, bow, shield', () => {
  const k = loadoutKit(LOADOUT_DEFAULT);
  assert.deepEqual(k.slots.map((s) => s[1]), ['diamond_sword', 'diamond_axe', 'diamond_spear', 'bow', 'arrow', 'arrow', 'golden_apple']);
  assert.deepEqual(Object.keys(k.worn), ['Head', 'Chest', 'Legs', 'Feet', 'Offhand']);
  assert.equal(k.worn.Head[0], 'diamond_helmet');
});

test('gear: options parse, tiers and aliases, bad words warn and are ignored', () => {
  const p = parseShow(['zombie', '4', 'armor=chain', 'weapon=gold', 'weapons=sword,mace', 'bow=off', 'shield=off', 'enchant=on']);
  assert.equal(p.gear.armor, 'chain');
  assert.deepEqual(meleeIds(p.gear), ['golden_sword', 'mace']);
  assert.equal(p.gear.bow, false);
  assert.equal(p.gear.shield, false);
  assert.equal(loadoutKit(p.gear).worn.Head[0], 'chainmail_helmet');
  assert.equal(loadoutKit(p.gear).worn.Offhand, undefined);
  assert.equal(loadoutKit(p.gear).slots.some((s) => s[1] === 'arrow'), false);
  assert.deepEqual(p.mob.id, 'zombie');
  const bad = parseShow(['zombie', 'armor=cardboard', 'weapons=sword,laser']);
  assert.equal(bad.gear.armor, 'diamond');
  assert.deepEqual(bad.gear.weapons, ['sword']);
  assert.equal(bad.warn.length, 2);
  assert.equal(parseShow(['zombie', 'armor=none']).gear.armor, 'none');
  assert.deepEqual(Object.keys(loadoutKit(parseShow(['zombie', 'armor=none', 'shield=off']).gear).worn), []);
});

test('gear: blue overrides the red loadout and inherits the rest', () => {
  const p = parseShow(['bots', 'armor=netherite', 'blue.armor=leather', 'blue.weapon=stone']);
  assert.equal(p.gear.armor, 'netherite');
  assert.equal(p.blueGear.armor, 'leather');
  assert.deepEqual(meleeIds(p.blueGear), ['stone_sword', 'stone_axe', 'stone_spear']);
  assert.deepEqual(meleeIds(p.gear), ['diamond_sword', 'diamond_axe', 'diamond_spear']);
  assert.match(describeLoadout(p.blueGear), /leather armor/);
});

test('gear: enchant puts enchantments on the pieces, the mace gets only unbreaking', () => {
  const k = loadoutKit(parseShow(['zombie', 'enchant=on', 'weapons=sword,mace']).gear);
  assert.deepEqual(k.slots[0][3], [['sharpness', 5], ['unbreaking', 3]]);
  assert.deepEqual(k.slots[1][3], [['unbreaking', 3]]);
  assert.equal(k.worn.Chest[1][0][0], 'protection');
});

import { parseEnch, fitEnch, ENCH_MELEE, ENCH_MACE } from '../behavior_pack/scripts/core/colosseum.js';

test('enchantments: chosen lists parse, clamp, warn, and fit each item', () => {
  const warn = [];
  assert.deepEqual(parseEnch('sharpness,fire_aspect:9,knockback:1', { ...ENCH_MELEE, ...ENCH_MACE }, warn), [['sharpness', 5], ['fire_aspect', 2], ['knockback', 1]]);
  parseEnch('sharpness,zzz', ENCH_MELEE, warn);
  assert.equal(warn.length, 1);
  assert.deepEqual(parseEnch('none', ENCH_MELEE), []);
  assert.equal(parseEnch(undefined, ENCH_MELEE), null);
  assert.deepEqual(fitEnch([['sharpness', 5], ['smite', 5], ['fire_aspect', 2]], ENCH_MELEE), [['sharpness', 5], ['fire_aspect', 2]]);
  assert.deepEqual(fitEnch([['sharpness', 5], ['density', 5]], ENCH_MACE), [['density', 5]]);
  assert.equal(fitEnch([['power', 5]], ENCH_MELEE), undefined);
});

test('enchantments in the kit: chosen ones replace the standard preset, per item', () => {
  const p = parseShow(['zombie', 'weaponench=sharpness,fire_aspect,density', 'bowench=power,flame', 'armorench=protection:3,thorns', 'weapons=sword,mace', 'mount=on']);
  const k = loadoutKit(p.gear);
  assert.deepEqual(k.slots[0][3], [['sharpness', 5], ['fire_aspect', 2]]);
  assert.deepEqual(k.slots[1][3], [['fire_aspect', 2], ['density', 5]]);
  assert.deepEqual(k.slots.find((s) => s[1] === 'bow')[3], [['power', 5], ['flame', 1]]);
  assert.deepEqual(k.worn.Chest[1], [['protection', 3], ['thorns', 3]]);
  assert.equal(p.gear.mount, true);
  assert.equal(loadoutKit(parseShow(['zombie', 'bowench=infinity']).gear).slots.filter((s) => s[1] === 'arrow').length, 1);
  assert.equal(loadoutKit(parseShow(['zombie', 'enchant=on', 'armorench=none']).gear).worn.Chest[1], undefined);
});

test('park option: on by default, park=off keeps the main bot working', () => {
  assert.equal(parseShow(['zombie', '4']).park, true);
  assert.equal(parseShow(['zombie', '4', 'park=off']).park, false);
  assert.equal(parseShow(['bots', 'park=no']).park, false);
});
