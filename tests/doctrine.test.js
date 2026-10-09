import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOOTERS, pickWeapon, kindOf, speedOf, DOCTRINE, KEYS, defaults, norm, flag, realPolicy, spacing, shootNow, pickTarget, describeChange, labLoad, table, fromStyle } from '../behavior_pack/scripts/core/doctrine.js';
import { parseShow } from '../behavior_pack/scripts/core/colosseum.js';
import { applyPolicy, TUNABLES } from '../behavior_pack/scripts/core/tunables.js';
import { fightMove } from '../behavior_pack/scripts/core/tactics.js';

test('every knob has a default inside its range and a sentence', () => {
  assert.ok(KEYS.length >= 20);
  for (const k of KEYS) { const d = DOCTRINE[k]; assert.ok(d.v >= d.min && d.v <= d.max, k); assert.ok(d.about.length > 10, k); }
});

test('norm clamps, drops junk and keeps backing off inside the hold', () => {
  const d = norm({ holdAt: 99, bowFrom: -5, nope: 1, strafePeriod: 'x', backOff: 3.0 });
  assert.equal(d.holdAt, DOCTRINE.holdAt.max);
  assert.equal(d.bowFrom, DOCTRINE.bowFrom.min);
  assert.equal(d.strafePeriod, DOCTRINE.strafePeriod.v);
  assert.ok(!('nope' in d));
  const e = norm({ holdAt: 2.0, backOff: 3.0 });
  assert.ok(e.backOff <= e.holdAt - 0.14);
});

test('the real-fight policy holds only what moved off the default', () => {
  assert.deepEqual(realPolicy(defaults()), {});
  const p = realPolicy(norm({ holdAt: 2.4, retreatHp: 9 }));
  assert.equal(p.holdAt, 2.4);
  assert.equal(p.fleeHealth, 7.5);
  for (const k of Object.keys(p)) assert.ok(TUNABLES[k], `${k} is a real tunable`);
});

test('the real fight reads the tunables (holdAt, backOff, shieldRange)', () => {
  const me = { x: 0, y: 0, z: 0 }, mob = { x: 2.9, y: 0, z: 0 };
  applyPolicy({});
  assert.equal(fightMove({ me, mob, melee: true, t: 0, shield: true, canSwing: false }).block, true);
  applyPolicy({ shieldRange: 2 });
  assert.equal(fightMove({ me, mob, melee: true, t: 0, shield: true, canSwing: false }).block, false);
  applyPolicy({ backOff: 3.0, holdAt: 3.0 });
  assert.ok(fightMove({ me, mob: { x: 2.7, y: 0, z: 0 }, melee: true, t: 0 }).goal, 'inside backOff: steps back');
  applyPolicy({});
});

test('spacing: on a horse it stands nearer, never inside the weapon minimum', () => {
  const wr = { reach: 3.2, minReach: 0, cooldown: 10 };
  const foot = spacing(defaults(), wr, false), ride = spacing({ ...defaults(), rideHold: 1.4 }, wr, true);
  assert.ok(foot.near < foot.far);
  assert.ok(ride.near <= 1.4 + 1e-9);
  assert.ok(spacing(defaults(), { reach: 4, minReach: 2.5, cooldown: 12 }, false).near >= 2.75);
});

test('shooting rules', () => {
  const d = defaults(), base = { hasBow: true, arrows: 10, clear: true, dist: 12, flying: false, creeper: false, nextShotOk: true };
  assert.equal(shootNow(d, base), true);
  assert.equal(shootNow(d, { ...base, dist: 5 }), false);
  assert.equal(shootNow(d, { ...base, dist: 5, creeper: true }), true);
  assert.equal(shootNow(d, { ...base, dist: 4, flying: true }), true);
  assert.equal(shootNow(d, { ...base, clear: false }), false);
  assert.equal(shootNow({ ...d, useBow: 0 }, base), false);
  assert.equal(shootNow(d, { ...base, arrows: 0 }), false);
});

test('target choice: sticks unless another is clearly better; likes the hurt one', () => {
  const d = norm({ switchMargin: 4, focusLow: 0 });
  const foes = [{ id: 'a', dist: 6, hp: 20 }, { id: 'b', dist: 3, hp: 20 }];
  assert.equal(pickTarget(d, foes, 'a'), 'a');
  assert.equal(pickTarget(d, [{ id: 'a', dist: 9, hp: 20 }, { id: 'b', dist: 3, hp: 20 }], 'a'), 'b');
  assert.equal(pickTarget(norm({ switchMargin: 0, focusLow: 1 }), [{ id: 'a', dist: 4, hp: 20 }, { id: 'b', dist: 5, hp: 2 }], null), 'b');
  assert.equal(pickTarget(d, [], null), null);
});

test('the switches decide the gear; the table is what the lab gets', () => {
  const scn = { armor: 'iron', weapon: 'iron', weapons: ['sword', 'axe'], shield: true, ranged: 'both', horse: true };
  const l = labLoad(scn, norm({ useHorse: 1, useBow: 0 }));
  assert.deepEqual([l.mount, l.bow, l.crossbow, l.shield, l.weapons], [true, false, false, true, ['sword', 'axe']]);
  const m = labLoad({ ...scn, weapons: [], shield: false, horse: false, ranged: 'crossbow' }, norm({ useHorse: 1 }));
  assert.deepEqual([m.mount, m.bow, m.crossbow, m.shield, m.weapons], [false, false, true, false, []]);
  const w = labLoad({ ...scn, env: 'water', enchLists: { w: [['sharpness', 5]], b: null, x: [['piercing', 4]], a: [['protection', 4]] } }, norm({ useHorse: 1 }));
  assert.equal(w.mount, false, 'no horse under water');
  assert.deepEqual([w.wench, w.bench, w.xench, w.aench], [[['sharpness', 5]], null, [['piercing', 4]], [['protection', 4]]]);
  assert.equal(Object.keys(table()).length, KEYS.length);
  assert.ok(flag(1) && !flag(0.5));
  assert.ok(fromStyle({ bowFrom: 6, strafe: 22, close: 3.4 }).bowFrom === 6);
  assert.ok(describeChange(norm({ holdAt: 2.2 }))[0].startsWith('holdAt 2.8 -> 2.2'));
});

test('colosseum lab command', () => {
  const p = parseShow(['lab', 'bouts', '12']);
  assert.equal(p.cmd, 'show');
  assert.equal(p.lab.bouts, 12);
  assert.equal(p.team, 1);
  assert.equal(parseShow(['lab']).lab.bouts, 9999);
  assert.deepEqual(parseShow(['lab', 'report']), { cmd: 'lab', sub: 'report' });
});

test('weapon choice: by damage a second times the doctrine weight; a spear can win when it is liked', () => {
  const items = [{ id: 'iron_sword', rate: 7 }, { id: 'iron_spear', rate: 2.1 }, { id: 'iron_axe', rate: 5 }];
  assert.equal(pickWeapon(defaults(), items), 'iron_sword');
  assert.equal(pickWeapon(norm({ wSpear: 4 }), items), 'iron_spear');
  assert.equal(pickWeapon(norm({ wSword: 0.2 }), items), 'iron_axe');
  assert.equal(pickWeapon(norm({ wSpear: 2, reachSpear: 1 }), items, { fast: true }), 'iron_spear');
  assert.equal(pickWeapon(defaults(), []), null);
  assert.equal(kindOf('minecraft:diamond_spear'), 'spear');
  assert.equal(kindOf('trident'), 'trident');
  assert.equal(kindOf('stick'), null);
});

test('crowds make an axe likelier; babies are faster', () => {
  const items = [{ id: 'iron_sword', rate: 7 }, { id: 'iron_axe', rate: 5 }];
  assert.equal(pickWeapon(norm({ crowdAxe: 1.5 }), items, { foes: 1 }), 'iron_sword');
  assert.equal(pickWeapon(norm({ crowdAxe: 1.5 }), items, { foes: 4 }), 'iron_axe');
  assert.ok(speedOf('zombie', true) > speedOf('zombie', false));
  assert.ok(speedOf('zombie', true) > defaults().kiteMaxSpeed);
});

test('a mounted spear is liked more; the lance and water knobs exist', () => {
  const items = [{ id: 'iron_sword', rate: 7 }, { id: 'iron_spear', rate: 2.1 }];
  assert.equal(pickWeapon(norm({ wSpear: 2 }), items, { mounted: false }), 'iron_sword');
  assert.equal(pickWeapon(norm({ wSpear: 2, rideSpear: 1 }), items, { mounted: true }), 'iron_spear');
  assert.equal(defaults().chargeSpear, 1);
  assert.ok(DOCTRINE.chargeFrom.min >= 5);
});

test('water=on and crossbow enchantments reach the kit', async () => {
  assert.equal(parseShow(['zombie', '3', 'water=on']).water, true);
  assert.equal(parseShow(['zombie', '3']).water, false);
  const { loadoutKit, LOADOUT_DEFAULT } = await import('../behavior_pack/scripts/core/colosseum.js');
  const k = loadoutKit({ ...LOADOUT_DEFAULT, weapons: [], bow: false, crossbow: true, xench: [['piercing', 4], ['sharpness', 5]] });
  const x = k.slots.find((s) => s[1] === 'crossbow');
  assert.deepEqual(x[3], [['piercing', 4]]);
  assert.ok(k.slots.some((s) => s[1] === 'arrow'));
});

test('more behaviours: target priority for shooters and creepers, eating, armor for mobs', async () => {
  const foes = [{ id: 'z', dist: 3, hp: 20, type: 'zombie' }, { id: 's', dist: 8, hp: 20, type: 'skeleton' }, { id: 'c', dist: 6, hp: 20, type: 'creeper' }];
  assert.equal(pickTarget(norm({ switchMargin: 0, focusLow: 0 }), foes, null), 'z');
  assert.equal(pickTarget(norm({ switchMargin: 0, focusLow: 0, shooterFirst: 2 }), foes, null), 's');
  assert.equal(pickTarget(norm({ switchMargin: 0, focusLow: 0, creeperFirst: 2 }), foes, null), 'c');
  assert.ok(SHOOTERS.has('witch') && !SHOOTERS.has('zombie'));
  assert.equal(labLoad({ armor: 'iron', weapons: ['sword'], ranged: 'none', apples: 4 }, defaults()).apples, 4);
  assert.ok(defaults().hitRun === 0 && defaults().cornerUp === 0 && DOCTRINE.drawTicks.min >= 8);
  const { armorItems, ARMOR_WEARERS } = await import('../behavior_pack/scripts/core/colosseum.js');
  assert.deepEqual(armorItems('iron'), { head: 'iron_helmet', chest: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' });
  assert.equal(armorItems('chain').chest, 'chainmail_chestplate');
  assert.equal(armorItems('none'), null);
  assert.ok(ARMOR_WEARERS.has('skeleton') && !ARMOR_WEARERS.has('creeper'));
  assert.equal(parseShow(['zombie', 'foearmor=diamond']).foeArmor, 'diamond');
  assert.equal(parseShow(['zombie']).foeArmor, 'none');
});
