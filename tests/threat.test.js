import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, fleePoint, weaponDamage } from '../behavior_pack/scripts/core/threat.js';

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

test('creepers: hit and back off when armed, healthy and it is the only thing on us; else run', () => {
  const d = decide({ health: 20, damage: 6, mobs: [mob('creeper', 5)] });
  assert.equal(d.mode, 'fight');
  assert.match(d.reason, /creeper/);
  assert.equal(decide({ health: 20, damage: 1, mobs: [mob('creeper', 5)] }).mode, 'flee', 'unarmed');
  assert.equal(decide({ health: 10, damage: 6, mobs: [mob('creeper', 5)] }).mode, 'flee', 'hurt');
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 5), mob('zombie', 6)] }).mode, 'flee', 'not with a zombie on us too');
  assert.equal(decide({ health: 20, damage: 6, mobs: [mob('creeper', 5, { canReach: false })] }).mode, 'none', 'one that cannot get at us is no threat');
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
