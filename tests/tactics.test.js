import test from 'node:test';
import assert from 'node:assert/strict';
import { fightMove, creeperFight, creeperMove, Stalemate, pickRefuge, bestWeapon, barricadeCells, CREEPER_HOLD, CREEPER_LIGHT, CREEPER_CALM } from '../behavior_pack/scripts/core/tactics.js';
import { HOLD_AT, REACH_HIT } from '../behavior_pack/scripts/core/threat.js';

const P = (x, y, z) => ({ x, y, z });

test('fight: plans to the mob itself (up the quarry steps), not a point on the line through the rock', () => {
  const me = P(0.5, 40, 0.5), mob = P(6.5, 52, 0.5); // skeleton at the mouth, 12 up
  const mv = fightMove({ me, mob, melee: false, t: 0 });
  assert.ok(mv.goal);
  assert.ok(Math.abs(mv.goal.y - 52) < 0.01, 'the goal is at the mob, not in the wall');
  assert.equal(mv.stop, false);
});

test('fight: in reach, swing; a zombie too close, back off to striking distance', () => {
  const near = fightMove({ me: P(0, 64, 0), mob: P(2.9, 64, 0), melee: true, t: 0 });
  assert.equal(near.swing, true);
  assert.equal(near.stop, true);
  const tooClose = fightMove({ me: P(0, 64, 0), mob: P(1.2, 64, 0), melee: true, t: 0 });
  assert.ok(tooClose.goal && tooClose.goal.x < 0, 'backs away from it');
  assert.equal(fightMove({ me: P(0, 64, 0), mob: P(2.9, 64, 0), melee: true, t: 0, canSwing: false }).swing, false);
});

test('shield: up against an archer on the way in and between swings on a zombie, down to swing', () => {
  const archer = fightMove({ me: P(0, 64, 0), mob: P(10, 64, 0), melee: false, t: 0, shield: true });
  assert.equal(archer.block, true);
  assert.equal(archer.urgent, false, 'a crouching walk, not a sprint');
  const between = fightMove({ me: P(0, 64, 0), mob: P(3, 64, 0), melee: true, t: 0, shield: true, canSwing: false });
  assert.equal(between.block, true);
  const swing = fightMove({ me: P(0, 64, 0), mob: P(3, 64, 0), melee: true, t: 0, shield: true, canSwing: true });
  assert.equal(swing.swing, true);
  assert.equal(swing.block, false);
  assert.equal(fightMove({ me: P(0, 64, 0), mob: P(10, 64, 0), melee: false, t: 0 }).block, false, 'no shield, nothing to raise');
});

test('creeper: arm\'s length. Hit it as it walks into reach, before its fuse range; never walk into it', () => {
  const me = P(0, 64, 0);
  const far = creeperFight({ me, mob: P(8, 64, 0), t: 0, st: {} });
  assert.ok(far.goal && far.tolerance >= CREEPER_HOLD, 'goes to it, stopping short');
  const wait = creeperFight({ me, mob: P(3.5, 64, 0), t: 0, st: {} });
  assert.equal(wait.stop, true, 'at arm\'s length: let it come');
  assert.equal(wait.swing, false);
  const hit = creeperFight({ me, mob: P(3.1, 64, 0), t: 0, st: {} });
  assert.equal(hit.swing, true, 'in our reach, outside its fuse range');
  assert.ok(REACH_HIT > CREEPER_LIGHT);
  const st = {};
  const close = creeperFight({ me, mob: P(2.2, 64, 0), t: 0, st, canSwing: false });
  assert.ok(close.goal && close.goal.x < 0, 'too close: back off');
  assert.equal(close.now, true);
  assert.equal(creeperFight({ me, mob: P(2.2, 64, 0), t: 1, st, canSwing: false }).now, false, 'not a new path every tick');
});

test('creeper hissing: knock it back and get past its calm range; nowhere to go: shield', () => {
  const st = {};
  const run = creeperFight({ me: P(0, 64, 0), mob: P(2.4, 64, 0), t: 0, st, lit: true });
  assert.equal(run.swing, true);
  assert.ok(run.goal && Math.hypot(run.goal.x - 2.4, run.goal.z) > CREEPER_CALM, 'past 6 from it');
  assert.equal(run.urgent, true);
  const stuck = creeperFight({ me: P(0, 64, 0), mob: P(2.4, 64, 0), t: 0, st: {}, lit: true, shield: true, canRetreat: false, canSwing: false });
  assert.equal(stuck.block, true);
  assert.equal(stuck.goal, null);
  assert.equal(creeperMove({ me: P(0, 64, 0), creeper: P(3, 64, 0), shield: true, lit: true }), 'block');
  assert.equal(creeperMove({ me: P(0, 64, 0), creeper: P(3, 64, 0), shield: true, lit: false }), 'run', 'not hissing: no need to crouch');
  assert.equal(creeperMove({ me: P(0, 64, 0), creeper: P(3, 64, 0), shield: false }), 'run');
});

test('stalemate: no hit and no ground gained for 6 s gives up; progress resets the clock', () => {
  const s = new Stalemate(120);
  assert.equal(s.update('sk', 0, 12, 0), false);
  assert.equal(s.update('sk', 100, 11.8, 0), false);
  assert.equal(s.update('sk', 130, 11.9, 0), true, 'staring contest');
  s.reset();
  s.update('sk', 0, 12, 0);
  s.update('sk', 100, 9, 0); // walked 3 closer
  assert.equal(s.update('sk', 180, 9, 0), false);
  s.update('sk', 200, 9, 4); // hit it
  assert.equal(s.update('sk', 300, 9, 4), false);
  assert.equal(s.update('zb', 400, 9, 0), false, 'a new target starts over');
});

test('refuge: away from the threats, on our side of them, out of an archer\'s sight when it can', () => {
  const me = P(0, 64, 0);
  const zombie = { type: 'zombie', pos: P(5, 64, 0), dist: 5 };
  const cands = [
    { ...P(-12, 64, 0), cost: 12 },
    { ...P(14, 64, 0), cost: 14 }, // past the zombie
  ];
  assert.deepEqual(pickRefuge(me, [zombie], cands), cands[0]);
  const sk = { type: 'skeleton', pos: P(8, 64, 0), dist: 8 };
  const open = { ...P(-10, 64, 0), cost: 10 }, cover = { ...P(-4, 64, 4), cost: 6 };
  const sees = (p) => p !== cover;
  assert.deepEqual(pickRefuge(me, [sk], [open, cover], sees), cover);
  assert.equal(pickRefuge(me, [zombie], [{ ...P(-1, 64, 0), cost: 1 }]), null, 'nowhere better: cornered');
});

test('weapon: sword beats axe beats spear of the same stuff; worn-out last; fists when nothing', () => {
  assert.equal(bestWeapon([{ id: 'stone_axe' }, { id: 'stone_sword' }, { id: 'stone_spear' }]), 'stone_sword');
  assert.equal(bestWeapon([{ id: 'iron_axe' }, { id: 'stone_sword' }]), 'stone_sword', 'Bedrock axes hit one less than the sword');
  assert.equal(bestWeapon([{ id: 'iron_axe' }, { id: 'stone_axe' }, { id: 'stone_spear' }]), 'iron_axe');
  assert.equal(bestWeapon([{ id: 'iron_sword', uses: 2 }, { id: 'stone_sword', uses: 100 }]), 'stone_sword');
  assert.equal(bestWeapon([{ id: 'wooden_spear' }]), 'wooden_spear');
  assert.equal(bestWeapon([{ id: 'dirt' }]), null);
  assert.equal(bestWeapon([]), null);
});

test('barricade: a 1-wide tunnel with the threat down it gets two blocks; open ground none', () => {
  // Tunnel along +x at y 64 (floor 63), z 0 only; dead end at x = 0.
  const tunnel = (x, y, z) => (y === 63 || y >= 66 || z !== 0 || x < 0 ? 'solid' : 'open');
  const cells = barricadeCells(P(0.5, 64, 0.5), P(8, 64, 0.5), tunnel);
  assert.deepEqual(cells, [P(1, 64, 0), P(1, 65, 0)]);
  assert.equal(barricadeCells(P(0.5, 64, 0.5), P(-8, 64, 0.5), tunnel), null, 'the threat is not down the way in');
  const open = (x, y) => (y === 63 ? 'solid' : 'open');
  assert.equal(barricadeCells(P(0.5, 64, 0.5), P(8, 64, 0.5), open), null);
});

void HOLD_AT;
