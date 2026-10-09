import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, fleePoint, weaponDamage, crowdOf, BOW_MIN, CROWD_RANGE } from '../behavior_pack/scripts/core/threat.js';
import { villageStep } from '../behavior_pack/scripts/core/advance.js';

const mob = (type, dist, extra = {}) => ({ id: `${type}${dist}`, type, dist, visible: true, targetingMe: false, attackedMe: false, pos: { x: dist, y: 64, z: 0 }, ...extra });

test('unarmed vs a zombie: flee', () => {
  assert.equal(decide({ health: 20, damage: 1, mobs: [mob('zombie', 5)] }).mode, 'flee');
});

test('iron sword vs one or two zombies: fight, vs three: flee', () => {
  const d = weaponDamage('minecraft:iron_sword');
  assert.equal(decide({ health: 20, damage: d, mobs: [mob('zombie', 5)] }).mode, 'fight');
  assert.equal(decide({ health: 20, damage: d, mobs: [mob('zombie', 3), mob('zombie', 4)] }).mode, 'fight');
  assert.equal(decide({ health: 20, damage: d, mobs: [mob('zombie', 3), mob('zombie', 4), mob('zombie', 5)] }).mode, 'flee');
});

test('creepers: held off at arm\'s length when it is the only thing on us (any weapon); else run', () => {
  const d = decide({ health: 20, damage: 6, mobs: [mob('creeper', 5)] });
  assert.equal(d.mode, 'fight');
  assert.match(d.reason, /creeper/);
  assert.equal(decide({ health: 20, damage: 1, mobs: [mob('creeper', 5)] }).mode, 'fight', 'fists: the knockback does it');
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 5), mob('zombie', 6)] }).mode, 'flee', 'not with a zombie on us too');
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 5), mob('skeleton', 12, { targetingMe: true })] }).mode, 'fight', 'a skeleton off at range: still hold the creeper off');
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 6, { canReach: false })] }).mode, 'none', 'one that cannot get at us is no threat');
});

test('creepers are noticed early: in sight within 8, hissing unseen within 8, anything within 4', () => {
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 7.5)] }).mode, 'fight', 'in sight, not known to be after us');
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 7, { visible: false, lit: true })] }).mode, 'fight', 'heard hissing');
  assert.notEqual(decide({ health: 20, damage: 6, mobs: [mob('creeper', 3.5, { visible: false, recent: false })] }).mode, 'none', 'right here, round a corner (no path search yet): noticed');
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 11, { targetingMe: true })] }).mode, 'fight', 'after us from 11');
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 11)] }).mode, 'none', 'wandering, well off');
});

test('endermen are ignored unless provoked', () => {
  assert.equal(decide({ health: 20, damage: 1, mobs: [mob('enderman', 4)] }).mode, 'none');
  assert.equal(decide({ health: 20, damage: 1, mobs: [mob('enderman', 4, { targetingMe: true })] }).mode, 'flee');
});

test('spiders are neutral in daylight, hostile at night', () => {
  assert.equal(decide({ health: 20, damage: 7, isNight: false, mobs: [mob('spider', 5)] }).mode, 'none');
  assert.equal(decide({ health: 20, damage: 7, isNight: true, mobs: [mob('spider', 5)] }).mode, 'fight');
});

test('low health always flees', () => {
  assert.equal(decide({ health: 5, damage: 9, mobs: [mob('zombie', 5)] }).mode, 'flee');
});

test('fists are fine against a silverfish', () => {
  assert.equal(decide({ health: 20, damage: 1, mobs: [mob('silverfish', 2)] }).mode, 'fight');
});

test('hysteresis keeps a fight going that would not have been started', () => {
  // iron sword vs 2 zombies at 15 hp: kill 3.6 s, die 5 s. Start needs < 3.0, keep needs < 4.5.
  const mobs = [mob('zombie', 3, { attackedMe: true }), mob('zombie', 4)];
  assert.equal(decide({ health: 15, damage: 7, mobs, prevMode: 'none' }).mode, 'flee');
  assert.equal(decide({ health: 15, damage: 7, mobs, prevMode: 'fight' }).mode, 'fight');
});

test('targets the mob that is hitting us first', () => {
  const r = decide({ health: 20, damage: 8, mobs: [mob('zombie', 2), mob('zombie', 3, { attackedMe: true })] });
  assert.equal(r.mode, 'fight');
  assert.equal(r.target, 'zombie3');
  const far = decide({ health: 20, damage: 8, mobs: [mob('zombie', 6), mob('zombie', 9, { attackedMe: true })] });
  assert.equal(far.target, 'zombie9');
});

test('a zombie in our face comes before the skeleton behind it that shot us', () => {
  const r = decide({ health: 16, damage: 7, shield: true, prevMode: 'fight', mobs: [mob('zombie', 2, { canReach: true }), mob('skeleton', 7, { attackedMe: true, targetingMe: true, canReach: true })] });
  assert.equal(r.mode, 'fight');
  assert.equal(r.target, 'zombie2');
});

test('toe to toe with a zombie: run only if clearly losing; a nearly dead one gets finished', () => {
  const mobs = [mob('zombie', 2, { canReach: true, attackedMe: true }), mob('skeleton', 6, { attackedMe: true, targetingMe: true, canReach: true, hp: 6 })];
  assert.equal(decide({ health: 8, damage: 7, shield: true, prevMode: 'fight', mobs }).mode, 'fight');
  const low = [mob('zombie', 2, { canReach: true, attackedMe: true, hp: 6 })];
  assert.equal(decide({ health: 5, damage: 7, prevMode: 'fight', mobs: low }).mode, 'fight');
  assert.equal(decide({ health: 5, damage: 7, prevMode: 'fight', mobs: [mob('zombie', 2, { canReach: true, attackedMe: true, hp: 20 })] }).mode, 'flee');
});

test('flee point is away from threats', () => {
  const p = fleePoint({ x: 0, y: 64, z: 0 }, [{ pos: { x: 5, z: 0 } }], 10);
  assert.ok(p.x <= -9);
});

test('keeps running from a zombie that fell out of sight or out of normal range', () => {
  const z = mob('zombie', 15, { visible: false });
  assert.equal(decide({ health: 20, damage: 1, mobs: [z], prevMode: 'none' }).mode, 'none');
  assert.equal(decide({ health: 20, damage: 1, mobs: [z], prevMode: 'flee' }).mode, 'flee');
});

test('never picks a fight while swimming', () => {
  assert.equal(decide({ health: 20, damage: 8, mobs: [mob('zombie', 4)], inWater: true }).mode, 'flee');
});

import { spacing, standOff, REACH_HIT, STOP_AT } from '../behavior_pack/scripts/core/threat.js';
test('melee spacing: close to the edge of reach, never walk into the zombie', () => {
  assert.equal(spacing(6, true), 'approach');
  assert.equal(spacing(2.9, true), 'hold');
  assert.equal(spacing(1.5, true), 'back');
  assert.equal(spacing(1.5, false), 'hold');   // ranged mobs: stay on them
  assert.ok(STOP_AT < REACH_HIT);             // we stop inside our own reach
  const p = standOff({ x: 10, y: 64, z: 0 }, { x: 0, y: 64, z: 0 });
  assert.ok(Math.abs(p.x - 2.8) < 1e-9 && p.z === 0);
});

test('a creeper we have walled off (no way to us, no sight of us, not hissing) is left alone, even close', () => {
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 3, { canReach: false, visible: false, recent: false })] }).mode, 'none');
  assert.notEqual(decide({ health: 20, damage: 6, mobs: [mob('creeper', 3, { canReach: false, visible: false, recent: false, lit: true })] }).mode, 'none', 'hissing: still one to get away from');
});

test('behind a kill slot: zombies at the gap are fought, even hurt; a baby or a spider still counts', () => {
  const zs = [mob('zombie', 2.2, { targetingMe: true }), mob('zombie', 4, { targetingMe: true }), mob('zombie', 6, { targetingMe: true })];
  assert.equal(decide({ health: 5, damage: 4, isNight: true, mobs: zs }).mode, 'flee');
  const d = decide({ health: 5, damage: 4, isNight: true, mobs: zs, slot: true });
  assert.equal(d.mode, 'fight');
  assert.equal(d.target, zs[0].id);
  assert.equal(decide({ health: 5, damage: 4, isNight: true, mobs: [...zs, mob('spider', 3, { targetingMe: true })], slot: true }).mode, 'flee');
  assert.equal(decide({ health: 5, damage: 4, isNight: true, mobs: [mob('zombie', 2.2, { targetingMe: true, baby: true })], slot: true }).mode, 'flee');
});

test('a witch is fought, not run from: it follows and throws from 10 blocks', () => {
  const w = mob('witch', 9, { targetingMe: true });
  assert.equal(decide({ health: 20, damage: 5, isNight: true, mobs: [w] }).mode, 'fight');
  // With a zombie too, where the race is close: still fight (running only gives it more throws).
  assert.equal(decide({ health: 20, damage: 5, isNight: true, mobs: [w, mob('zombie', 7, { targetingMe: true })] }).mode, 'fight');
});

test('a creeper with company: run while it is close; turn on the rest while it is well back', () => {
  const z = mob('zombie', 5, { attackedMe: true });
  assert.equal(decide({ health: 20, damage: 7, mobs: [mob('creeper', 7), z] }).mode, 'flee');
  const back = decide({ health: 20, damage: 7, mobs: [mob('creeper', 12), z] });
  assert.equal(back.mode, 'fight');
  assert.equal(back.target, z.id);
  assert.equal(decide({ health: 20, damage: 7, prevMode: 'fight', mobs: [mob('creeper', 9), z] }).mode, 'fight', 'at it already: until 8');
  assert.equal(decide({ health: 20, damage: 7, prevMode: 'fight', mobs: [mob('creeper', 9, { lit: true }), z] }).mode, 'flee', 'hissing');
});

test('armor counts: what a hit leaves, and the fight-or-run race on health through armor', async () => {
  const { armorFactor } = await import('../behavior_pack/scripts/core/threat.js');
  const { armorTotal } = await import('../behavior_pack/scripts/core/wants.js');
  assert.equal(armorFactor(3, 0), 1);
  assert.ok(Math.abs(armorFactor(3, 15) - 0.46) < 0.01, 'iron all over: a zombie hit mostly taken');
  assert.ok(armorFactor(20, 20, 8) < armorFactor(20, 20, 0), 'toughness keeps more against big hits');
  assert.deepEqual(armorTotal(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield']), { points: 15, toughness: 0 });
  assert.deepEqual(armorTotal(['diamond_chestplate', 'diamond_boots']), { points: 11, toughness: 4 });
  // Three zombies with a stone sword: run bare, fight in diamond.
  const zs = [mob('zombie', 3), mob('zombie', 4), mob('zombie', 5)];
  assert.equal(decide({ health: 20, damage: 6, mobs: zs }).mode, 'flee');
  assert.equal(decide({ health: 20, damage: 6, mobs: zs, armor: 20, toughness: 8 }).mode, 'fight');
  // Low health: 5 hp bare is running; in iron it fights on.
  assert.equal(decide({ health: 5, damage: 7, mobs: [mob('zombie', 3)] }).mode, 'flee');
  assert.equal(decide({ health: 5, damage: 7, mobs: [mob('zombie', 3)], armor: 15 }).mode, 'fight');
});

test('with a bow: creepers 9+ off are shot even in a crowd of them; nothing lit or close', () => {
  const crowd = [mob('creeper', 9.5), mob('creeper', 11), mob('creeper', 12)];
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 6.5), mob('creeper', 7.5), mob('creeper', 11)] }).mode, 'flee', 'no bow: run from a crowd');
  assert.equal(decide({ health: 20, damage: 6, bow: true, mobs: [mob('creeper', 6.5), mob('creeper', 7.5), mob('creeper', 11)] }).mode, 'flee', 'a bow does not shoot into blast reach');
  const d = decide({ health: 20, damage: 6, bow: true, mobs: crowd });
  assert.equal(d.mode, 'fight');
  assert.equal(d.target, 'creeper9.5');
  assert.equal(decide({ health: 20, damage: 6, bow: true, mobs: [mob('creeper', 4), mob('creeper', 7)] }).mode, 'flee', 'one close: not the bow');
  assert.ok(!/shoot/.test(decide({ health: 20, damage: 6, bow: true, mobs: [mob('creeper', 8), mob('creeper', 9.5)] }).reason), 'one inside BOW_MIN (blast reach): not the bow');
  assert.equal(decide({ health: 20, damage: 6, bow: true, mobs: [mob('creeper', 7, { lit: true }), mob('creeper', 11)] }).reason.includes('shoot'), false, 'one lit: not the bow');
});

test('a ghast: shot with a bow and arrows from as far as it is seen, run from without', () => {
  const g = mob('ghast', 30, { targetingMe: true, canReach: false });
  const d = decide({ health: 17, damage: 6, bow: true, mobs: [g] });
  assert.equal(d.mode, 'fight');
  assert.equal(d.target, 'ghast30');
  assert.notEqual(decide({ health: 17, damage: 6, mobs: [mob('ghast', 12, { targetingMe: true, canReach: false })] }).mode, 'fight', 'no bow: not walked up to');
  assert.equal(decide({ health: 17, damage: 6, bow: true, mobs: [g, mob('zombie', 3)] }).mode === 'fight' && decide({ health: 17, damage: 6, bow: true, mobs: [g, mob('zombie', 3)] }).target === 'ghast30', false, 'a zombie on us first');
});
test('the village hunt starts at 11 hearts when the hunger bar is too low to heal', () => {
  const f = { goals: {}, armed: true, health: 12, food: 16, villageReady: true };
  assert.equal(villageStep(f)?.step, 'seek_village');
  assert.equal(villageStep({ ...f, food: 20 }), null, 'with a full bar it waits to heal to 14');
});

test('crowdOf: seen creepers within range (and any within 6); company is a zombie within 14 or a shooter within 24', () => {
  const c = crowdOf([mob('creeper', 5), mob('creeper', 13), mob('creeper', 16), mob('creeper', 9, { visible: false }), mob('creeper', 5, { visible: false })]);
  assert.equal(c.creepers.length, 3, 'one within 14 seen, one within 6 unseen, the first; the far and the unseen-at-9 are not');
  assert.equal(c.company, false);
  assert.equal(crowdOf([mob('creeper', 5), mob('zombie', 12)]).company, true);
  assert.equal(crowdOf([mob('creeper', 5), mob('zombie', 16)]).company, false);
  assert.equal(crowdOf([mob('creeper', 5), mob('skeleton', 20)]).company, true);
  assert.equal(crowdOf([mob('creeper', 5, { canReach: false })]).creepers.length, 0, 'one we have walled off is not coming');
  assert.ok(BOW_MIN > 6 && CROWD_RANGE >= BOW_MIN);
});

test('with a bow and a shield and two creepers about: the crowd plan takes them, the bow does not draw', () => {
  const far = [mob('creeper', 10), mob('creeper', 11)];
  assert.equal(decide({ health: 20, damage: 6, bow: true, shield: false, mobs: far }).mode, 'fight', 'no shield: shoot them');
  assert.notEqual(decide({ health: 20, damage: 6, bow: true, shield: true, mobs: far }).reason, 'creeper: shoot it from afar', 'a shield: the crowd plan has them');
});

test('a vindicator: a run when bare, a fight in iron (armoredFight), never at low health', () => {
  const d = weaponDamage('minecraft:iron_sword');
  const v = [mob('vindicator', 6, { targetingMe: true })];
  assert.equal(decide({ health: 20, damage: d, mobs: v }).mode, 'flee', 'bare');
  assert.equal(decide({ health: 20, damage: d, armor: 15, toughness: 0, mobs: v }).mode, 'fight', 'in iron it is a race like any other');
  assert.equal(decide({ health: 4, damage: d, armor: 15, mobs: v }).mode, 'flee', 'hurt: run');
  assert.equal(decide({ health: 20, damage: d, armor: 15, mobs: [mob('ravager', 6, { targetingMe: true })] }).mode, 'flee', 'a ravager stays a run');
});

test('anything that hits us is defended against, known mob or not (u309): a wolf that bit us is fought, an unknown mob is learnt as neutral, players never', async () => {
  const { decide, learnMob, MOBS } = await import('../behavior_pack/scripts/core/threat.js');
  const wolf = (o) => ({ id: 1, type: 'wolf', dist: 2, visible: true, targetingMe: false, attackedMe: false, canReach: true, ...o });
  assert.equal(decide({ health: 20, damage: 6, mobs: [wolf({})] }).mode, 'none');                       // a wolf minding its business
  assert.equal(decide({ health: 20, damage: 6, mobs: [wolf({ attackedMe: true })] }).mode, 'fight');   // one that bit us
  assert.equal(learnMob('player', 20), null);
  assert.equal(learnMob('item', 1), null);
  assert.ok(learnMob('strange_new_mob', 30).neutral);
  assert.equal(MOBS.strange_new_mob.hp, 30);
  const m = { id: 2, type: 'strange_new_mob', dist: 2, visible: true, targetingMe: true, attackedMe: true, canReach: true };
  assert.equal(decide({ health: 20, damage: 6, mobs: [m] }).mode, 'fight');
  delete MOBS.strange_new_mob;
});
