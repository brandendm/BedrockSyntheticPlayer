import test from 'node:test';
import assert from 'node:assert/strict';
import { fightMove, creeperFight, creeperMove, Stalemate, pickRefuge, bestWeapon, barricadeCells, CREEPER_HOLD, CREEPER_LIGHT, CREEPER_CALM, weaponReach, pickCreeperSwing, creeperWeapon, knockbackRoom, blockOffCells, fleeJab, killSlotCells, killSlotWorth, dodgeArrow, arrowHits, aimBow, bowFight, blastDamage, fleeJabOrder, avoidCreepers, towerWorth, pinchWallCells, alcoveCells, creeperPlan, turnTo, awayPathFrom, CREEPER_SAFE, SHIELD_MIN_HP } from '../behavior_pack/scripts/core/tactics.js';
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

test('creeper: wait for one coming at us; walk (no sprint) only to one that is not coming', () => {
  const me = P(0, 64, 0);
  const st = {};
  creeperFight({ me, mob: P(9, 64, 0), t: 0, st });
  const coming = creeperFight({ me, mob: P(8, 64, 0), t: 8, st });
  assert.equal(coming.stop, true, 'it is closing: stand and let it come');
  assert.equal(coming.goal, null);
  const idle = {};
  let mv;
  for (let t = 0; t <= 50; t += 5) mv = creeperFight({ me, mob: P(8, 64, 0), t, st: idle });
  assert.ok(mv.goal, 'still for 2 s: go to it');
  assert.equal(mv.walk, true, 'walking, not sprinting');
  assert.ok(mv.tolerance >= REACH_HIT + 0.5, 'stopping well short');
});

test('creeper: hit it as it walks into reach, before its fuse range; keep it out while the swing recharges', () => {
  const me = P(0, 64, 0);
  const hit = creeperFight({ me, mob: P(3.1, 64, 0), t: 0, st: {} });
  assert.equal(hit.swing, true, 'in our reach, outside its fuse range');
  assert.ok(REACH_HIT > CREEPER_LIGHT);
  const st = {};
  const close = creeperFight({ me, mob: P(3.2, 64, 0), t: 0, st, canSwing: false });
  assert.ok(close.away > 3.4, 'swing not ready: back off, to a spot this far from it');
  assert.equal(close.now, true);
  assert.equal(creeperFight({ me, mob: P(3.2, 64, 0), t: 1, st, canSwing: false }).now, false, 'not a new path every tick');
  // A spear: reaches 4, nothing within 2.
  const spear = creeperFight({ me, mob: P(3.9, 64, 0), t: 0, st: {}, reach: 4, minReach: 2.4 });
  assert.equal(spear.swing, true, 'a spear jabs it from 3.9');
  const tooNear = creeperFight({ me, mob: P(2.2, 64, 0), t: 0, st: {}, reach: 4, minReach: 2.4 });
  assert.equal(tooNear.swing, false);
  assert.ok(tooNear.away > 2.4, 'inside the spear\'s minimum: back off to where it lands');
});

test('creeper hissing: knock it back and get past its calm range; nowhere to go: shield', () => {
  const run = creeperFight({ me: P(0, 64, 0), mob: P(2.4, 64, 0), t: 0, st: {}, lit: true });
  assert.equal(run.swing, true);
  assert.ok(run.away > CREEPER_CALM, 'past 6 from it');
  assert.equal(run.urgent, true);
  const stuck = creeperFight({ me: P(0, 64, 0), mob: P(2.4, 64, 0), t: 0, st: {}, lit: true, shield: true, canRetreat: false, canSwing: false });
  assert.equal(stuck.block, true);
  assert.equal(stuck.away, 0);
  assert.equal(creeperMove({ me: P(0, 64, 0), creeper: P(3, 64, 0), shield: true, lit: true }), 'block');
  assert.equal(creeperMove({ me: P(0, 64, 0), creeper: P(3, 64, 0), shield: true, lit: false }), 'run', 'not hissing: no need to crouch');
  assert.equal(creeperMove({ me: P(0, 64, 0), creeper: P(3, 64, 0), shield: false }), 'run');
});

test('spear and sword against a creeper: the jab from 4 when ready, the sword up close while it recharges', () => {
  const spear = { id: 'stone_spear', ...weaponReach('stone_spear') }, sword = { id: 'stone_sword', ...weaponReach('stone_sword') };
  assert.deepEqual([spear.reach, spear.minReach, spear.cooldown, spear.damage], [4, 2.4, 15, 3], 'wiki: Bedrock stone spear');
  assert.equal(pickCreeperSwing([{ ...spear, readyAt: 0 }, { ...sword, readyAt: 0 }], 3.8, 5).id, 'stone_spear');
  const s2 = pickCreeperSwing([{ ...spear, readyAt: 20 }, { ...sword, readyAt: 0 }], 3.0, 10);
  assert.deepEqual([s2.id, s2.ready], ['stone_sword', true], 'spear recharging: the sword');
  assert.equal(pickCreeperSwing([{ ...spear, readyAt: 20 }, { ...sword, readyAt: 15 }], 3.0, 10).ready, false);
  assert.equal(creeperWeapon([{ id: 'stone_sword' }, { id: 'wooden_spear' }, { id: 'stone_spear' }], 'stone_sword'), 'stone_spear');
  assert.equal(creeperWeapon([{ id: 'stone_sword' }], 'stone_sword'), 'stone_sword');
  assert.equal(bestWeapon([{ id: 'stone_spear' }, { id: 'wooden_sword' }]), 'wooden_sword', 'for everything else a sword: more damage a second');
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

test('knockback room: open ground behind it is room; a riser or rock right behind it is not', () => {
  const me = P(0.5, 64, 0.5), mob = P(3.5, 64, 0.5);
  const flat = (x, y) => (y < 64 ? 'solid' : 'open');
  assert.equal(knockbackRoom(me, mob, flat), 2);
  const wallBehind = (x, y) => (y < 64 || x >= 4 ? 'solid' : 'open');
  assert.equal(knockbackRoom(me, mob, wallBehind), 0);
  const twoHighStep = (x, y) => (y < 64 || (x >= 4 && y < 66) ? 'solid' : 'open');
  assert.ok(knockbackRoom(me, mob, twoHighStep) < 1, 'a 2-high riser behind it');
});

test('walling a creeper off: the column straight at it first, feet and head, one higher when it comes down at us', () => {
  const me = P(0.5, 40, 0.5);
  const open = (x, y) => (y < 40 ? 'solid' : 'open');
  const level = blockOffCells(me, P(5.5, 40, 0.5), open);
  assert.deepEqual(level.slice(0, 2), [P(1, 40, 0), P(1, 41, 0)], 'straight at it, feet then head');
  assert.ok(level.length >= 6, 'and the diagonals either side');
  const fromAbove = blockOffCells(me, P(4.5, 43, 0.5), open);
  assert.deepEqual(fromAbove.slice(0, 3), [P(1, 40, 0), P(1, 41, 0), P(1, 42, 0)], 'coming down at us: it sees over two');
  const tunnel = (x, y, z) => (y < 40 || y > 41 || z !== 0 ? 'solid' : 'open');
  assert.deepEqual(blockOffCells(me, P(5.5, 40, 0.5), tunnel), [P(1, 40, 0), P(1, 41, 0)], 'a 1-wide tunnel: two blocks');
});

test('creeper fight: cornered, no shield, a hit would not move it: one block against the blast (once), and fight on', () => {
  const me = P(0.5, 40, 0.5), st = {};
  creeperFight({ me, mob: P(7, 44, 0.5), t: 0, st, canWall: true, kbPoor: true });
  const w = creeperFight({ me, mob: P(5.5, 43, 0.5), t: 8, st, canWall: true, kbPoor: true });
  assert.equal(w.guard, true);
  assert.equal(w.wall, false, 'not a wall');
  assert.equal(creeperFight({ me, mob: P(5, 43, 0.5), t: 12, st, canWall: true, kbPoor: true }).guard, false, 'once');
  assert.equal(creeperFight({ me, mob: P(5.5, 43, 0.5), t: 8, st: { lastComing: 0 }, canWall: true, kbPoor: true, shield: true }).guard, false, 'a shield: no need');
  assert.equal(creeperFight({ me, mob: P(5.5, 40, 0.5), t: 8, st: { lastComing: 0 }, canWall: true, kbPoor: false }).guard, false, 'knockback works: keep it off with that');
  assert.equal(creeperFight({ me, mob: P(5.5, 43, 0.5), t: 8, st: { lastComing: 0 }, canWall: false, kbPoor: true }).guard, false, 'no blocks');
  // The old way, still there: wall it off.
  const st2 = {};
  creeperFight({ me, mob: P(8, 44, 0.5), t: 0, st: st2, canWall: true, kbPoor: true, walls: true });
  assert.equal(creeperFight({ me, mob: P(6, 43, 0.5), t: 8, st: st2, canWall: true, kbPoor: true, walls: true }).wall, true);
});

test('a block right in front takes most of a creeper blast', () => {
  const open = () => true;
  const blocked = (cellX) => (a, b) => { for (let i = 1; i < 40; i++) { const x = a.x + (b.x - a.x) * i / 40, y = a.y + (b.y - a.y) * i / 40; if (Math.floor(x) === cellX && Math.floor(y) === 40) return false; } return true; };
  const feet = P(0.5, 40, 0.5), creeper = P(2.5, 40.05, 0.5);
  const bare = blastDamage(creeper, feet, open), guarded = blastDamage(creeper, feet, blocked(1));
  assert.ok(bare > 20, `bare ${bare}`);
  assert.ok(guarded < bare / 3, `guarded ${guarded} vs ${bare}`);
});

test('flee jab: spear something catching up from out of its reach, sword it if it is on us, leave one that is not gaining', () => {
  const me = P(0, 64, 0);
  const run = (ds, opts) => { const st = {}; let r = null; ds.forEach((d, i) => { r = fleeJab({ me, mob: P(d, 64, 0), t: i * 2, st, ...opts }); }); return r; };
  const ready = { hasSpear: true, spearReady: true, swordReady: true };
  assert.equal(run([4.2, 3.9, 3.6, 3.3], ready), 'spear');
  assert.equal(run([3.2, 2.9, 2.6, 2.3], { ...ready, hasSpear: false }), 'sword');
  assert.equal(run([3.3, 3.3, 3.3, 3.3], ready), null, 'keeping pace, not gaining');
  assert.equal(run([4.2, 3.9, 3.6, 3.3], { ...ready, spearReady: false, swordReady: false }), null, 'nothing ready');
  assert.equal(run([4.2, 3.9, 3.6, 3.3], { ...ready, melee: false }), null, 'only melee mobs');
});

test('kill slot: across the end of a tunnel, a block at the feet (and over head height if the ceiling is higher)', () => {
  const tunnel = (high) => (x, y, z) => (z === 0 && x >= 1 && x <= 20 && y >= 40 && y < 40 + high ? 'open' : 'solid');
  const two = killSlotCells(P(1.5, 40, 0.5), P(9.5, 40, 0.5), tunnel(2));
  assert.deepEqual(two.cells, [P(2, 40, 0)]);
  assert.deepEqual(two.slot, P(2, 41, 0));
  assert.ok(two.stand.x < 1.5, 'stand at the back of our cell');
  assert.deepEqual(killSlotCells(P(1.5, 40, 0.5), P(9.5, 40, 0.5), tunnel(3)).cells, [P(2, 40, 0), P(2, 42, 0)]);
  // Mid-tunnel (two ways out), open ground, or it's coming from behind: no slot.
  assert.equal(killSlotCells(P(5.5, 40, 0.5), P(9.5, 40, 0.5), tunnel(2)), null);
  assert.equal(killSlotCells(P(0.5, 64, 0.5), P(8.5, 64, 0.5), (x, y) => (y >= 64 ? 'open' : 'solid')), null);
});

test('kill slot worth it: zombies only, more than one or us hurt, and time to put the block down', () => {
  const z = (dist, extra = {}) => ({ type: 'zombie', dist, ...extra });
  assert.equal(killSlotWorth({ threats: [z(6), z(8)], health: 20 }), true);
  assert.equal(killSlotWorth({ threats: [z(6)], health: 20 }), false);
  assert.equal(killSlotWorth({ threats: [z(6)], health: 10 }), true);
  assert.equal(killSlotWorth({ threats: [z(2.5), z(8)], health: 20 }), false, 'already on us');
  assert.equal(killSlotWorth({ threats: [z(6), { type: 'spider', dist: 8 }], health: 20 }), false);
  assert.equal(killSlotWorth({ threats: [z(6), { type: 'skeleton', dist: 8 }], health: 20 }), false);
  assert.equal(killSlotWorth({ threats: [z(6), z(7, { baby: true })], health: 20 }), false);
});

test('arrow dodge: one coming at us is stepped out of sideways; one wide of us, or too late, is not', () => {
  const open = (x, y) => (y >= 64 ? 'open' : 'solid');
  const me = P(0.5, 64, 0.5);
  // A skeleton 12 blocks off along +x, aimed at our chest: 1.6 a tick toward us.
  const arrow = { id: 'a', pos: P(12.5, 65.5, 0.5), vel: P(-1.6, 0.1, 0) };
  assert.ok(arrowHits(me, arrow.pos, arrow.vel));
  const dg = dodgeArrow({ me, arrows: [arrow], at: open });
  assert.ok(dg && dg.eta >= 2);
  assert.ok(Math.abs(dg.dir.x) < 1e-9 && Math.abs(Math.abs(dg.dir.z) - 1) < 1e-9, 'sideways to its flight');
  // Off our line by a block and a half: no dodge.
  assert.equal(dodgeArrow({ me, arrows: [{ ...arrow, pos: P(12.5, 65.5, 2) }], at: open }), null);
  // About to land (next tick): too late to move.
  assert.equal(dodgeArrow({ me, arrows: [{ ...arrow, pos: P(1.6, 65, 0.5) }], at: open }), null);
  // A 1-wide tunnel along x: nowhere sideways to go.
  const tunnel = (x, y, z) => (z === 0 && y >= 64 && y <= 65 ? 'open' : 'solid');
  assert.equal(dodgeArrow({ me, arrows: [arrow], at: tunnel }), null);
});

test('bow aim: leads a walking zombie and allows for the drop, so the arrow lands', () => {
  const from = P(0, 65.62, 0);
  for (const [x, y, vz] of [[8, 64, 0], [25, 64, 0], [15, 70, 0], [15, 58, 0], [15, 64, 0.155]]) {
    const a = aimBow(from, P(x, y, 0), { x: 0, z: vz }, 3);
    // Fly it against the moving target's box.
    let p = { ...from }, v = { x: a.x * 3, y: a.y * 3, z: a.z * 3 }, hit = false;
    for (let k = 1; k <= 40 && !hit; k++) {
      for (let i = 1; i <= 4; i++) {
        const q = { x: p.x + v.x * i / 4, y: p.y + v.y * i / 4, z: p.z + v.z * i / 4 };
        if (Math.abs(q.x - x) <= 0.55 && Math.abs(q.z - vz * k) <= 0.55 && q.y >= y - 0.25 && q.y <= y + 2.2) { hit = true; break; }
      }
      p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z };
      v = { x: v.x * 0.99, y: v.y * 0.99 - 0.05, z: v.z * 0.99 };
    }
    assert.ok(hit, `target at ${x},${y} moving ${vz}`);
  }
});

test('bow fight: shoot from range, back off when a zombie gets close, the sword when it is on us or nearly dead', () => {
  const me = P(0.5, 64, 0.5);
  assert.deepEqual(bowFight({ me, mob: P(12.5, 64, 0.5), kind: 'melee', sees: true, drawn: 5 }).draw, true);
  assert.equal(bowFight({ me, mob: P(12.5, 64, 0.5), kind: 'melee', sees: true, drawn: 20 }).release, true);
  const st = {};
  assert.ok(bowFight({ me, mob: P(4.5, 64, 0.5), kind: 'melee', sees: true, st }).away);
  assert.ok(bowFight({ me, mob: P(6.5, 64, 0.5), kind: 'melee', sees: true, st }).away, 'keeps backing off until there is room to draw');
  assert.ok(bowFight({ me, mob: P(8.6, 64, 0.5), kind: 'melee', sees: true, st }).draw);
  assert.equal(bowFight({ me, mob: P(3.5, 64, 0.5), kind: 'melee', sees: true }).melee, true);
  assert.equal(bowFight({ me, mob: P(6.5, 64, 0.5), kind: 'melee', sees: true, hp: 4, melee: 5 }).melee, true, 'one swing finishes it');
  assert.equal(bowFight({ me, mob: P(4.5, 64, 0.5), kind: 'explode', sees: true }).melee, true);
  assert.ok(bowFight({ me, mob: P(12.5, 64, 0.5), kind: 'melee', sees: false }).goal, 'no shot: get one');
});

test('running: a creeper coming up on us gets the spear first; the zombies still get jabbed', () => {
  const me = { x: 0, y: 64, z: 0 };
  const st = {};
  fleeJab({ me, mob: { x: 4.2, y: 64, z: 0 }, t: 0, st, creeper: true, hasSpear: true, spearReady: true });
  assert.equal(fleeJab({ me, mob: { x: 3.5, y: 64, z: 0 }, t: 4, st, creeper: true, hasSpear: true, spearReady: true }), 'spear');
  assert.equal(fleeJab({ me, mob: { x: 3.5, y: 64, z: 0 }, t: 5, st: {}, creeper: true, hasSpear: false, swordReady: true }), null, 'a sword only on one closing in');
  const order = fleeJabOrder([{ type: 'zombie', d: 2 }, { type: 'creeper', d: 3.8 }, { type: 'skeleton', d: 5 }]);
  assert.deepEqual(order.map((o) => o.type), ['creeper', 'zombie']);
  assert.deepEqual(fleeJabOrder([{ type: 'zombie', d: 2 }, { type: 'creeper', d: 6 }]).map((o) => o.type), ['zombie']);
});

test('running: routes keep off a creeper, but never fence us in when it is right by us', () => {
  const open = () => 0;
  const far = avoidCreepers(open, [{ x: 6.5, y: 64, z: 0.5 }], 3.5, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(far(5, 64, 0), 3, 'next to the creeper: dangerous');
  assert.equal(far(1, 64, 0), 0);
  const near = avoidCreepers(open, [{ x: 2, y: 64, z: 0.5 }], 3.5, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(near(-1, 64, 0), 0, 'the way away from it stays open');
  assert.equal(near(1, 64, 0), 3, 'nearer it than we are: not');
});

test('tower: up a pillar from zombies only, with the blocks and the headroom', () => {
  const z = (dist) => ({ type: 'zombie', dist });
  assert.equal(towerWorth({ threats: [z(3), z(4)], blocks: 8 }), true);
  assert.equal(towerWorth({ threats: [z(3)], blocks: 8, health: 20 }), false, 'one zombie: fight it');
  assert.equal(towerWorth({ threats: [z(3)], blocks: 8, health: 8 }), true, 'one, hurt');
  assert.equal(towerWorth({ threats: [z(3), z(4)], blocks: 2 }), false, 'not enough blocks');
  assert.equal(towerWorth({ threats: [z(3), z(4), { type: 'skeleton', dist: 20 }], blocks: 8 }), false, 'an archer: it shoots us up there');
  assert.equal(towerWorth({ threats: [z(3), { type: 'spider', dist: 4 }], blocks: 8 }), false, 'spiders climb');
  assert.equal(towerWorth({ threats: [z(3), z(4)], blocks: 8, headroom: false }), false, 'leaves overhead');
});

test('squeezed in a tunnel: the creeper\'s way walled off; no blocks, a pocket dug out of the side', () => {
  const tunnel = (x, y, z) => (z === 0 && x >= -12 && x <= 12 && (y === 40 || y === 41) ? 'open' : 'solid');
  assert.deepEqual(pinchWallCells(P(0.5, 40, 0.5), P(-6.5, 40, 0.5), tunnel), [P(-1, 40, 0), P(-1, 41, 0)]);
  assert.deepEqual(pinchWallCells(P(0.5, 40, 0.5), P(6.5, 40, 0.5), tunnel), [P(1, 40, 0), P(1, 41, 0)]);
  assert.equal(pinchWallCells(P(0.5, 64, 0.5), P(-6.5, 64, 0.5), (x, y) => (y >= 64 ? 'open' : 'solid')), null, 'open ground');
  const al = alcoveCells(P(0.5, 40, 0.5), P(-6.5, 40, 0.5), tunnel);
  assert.equal(al.cells.length, 3, 'head, feet and the one beyond: blocks to wall with');
  assert.equal(al.cells[0].x, 0);
  assert.equal(Math.abs(al.cells[0].z), 1, 'sideways, out of its line');
  assert.equal(al.into.y, 40);
});

test('a flight leans toward where the bot was going, never at the cost of safety', () => {
  const me = { x: 0, y: 64, z: 0 };
  const zombie = { type: 'zombie', dist: 4, pos: { x: 4, y: 64, z: 0 } };
  const west = { x: -9, y: 64, z: 0, cost: 9 }, north = { x: 0, y: 64, z: -9, cost: 9 };
  assert.deepEqual(pickRefuge(me, [zombie], [west, north], null, 3, { x: 0, z: -80 }), north, 'north when that is where it was going');
  assert.deepEqual(pickRefuge(me, [zombie], [west, north], null, 3, { x: -80, z: 0 }), west);
  const toward = { x: 6, y: 64, z: 0, cost: 6 }; // right past the zombie
  assert.notDeepEqual(pickRefuge(me, [zombie], [toward, west], null, 3, { x: 80, z: 0 }), toward, 'never toward the mob');
});

// ---------- a crowd of creepers (u205: the owner took four on the shield in 7.3 s; the bot ran and drew a bow for 31.9) ----------
const cr = (x, z, lit = false) => ({ pos: P(x, 64, z), d: Math.hypot(x - 0.5, z - 0.5), lit });
const ME = P(0.5, 64, 0.5);

test('turnTo: degrees from a heading round to a vector, +x toward +z', () => {
  assert.ok(Math.abs(turnTo(1, 0, 0, 1) - 90) < 1e-9);
  assert.ok(Math.abs(turnTo(1, 0, 0, -1) + 90) < 1e-9);
  assert.ok(Math.abs(turnTo(0, 1, 1, 0) + 90) < 1e-9);
  assert.equal(turnTo(1, 0, 3, 0), 0);
  assert.ok(Math.abs(Math.abs(turnTo(1, 0, -1, 0)) - 180) < 1e-9);
});

test('creeperPlan: four in a line in front, a shield and health: receive them facing the middle', () => {
  const p = creeperPlan({ me: ME, creepers: [cr(8, 0), cr(9, 1), cr(10, -1), cr(11, 0)], shield: true });
  assert.equal(p.act, 'receive');
  assert.ok(p.face.x > ME.x && Math.abs(p.face.z - ME.z) < 1.5, 'looking along the line they come in');
  assert.ok(p.spread <= 50);
});

test('creeperPlan: receive turns toward where they are, not a fixed way', () => {
  const p = creeperPlan({ me: ME, creepers: [cr(0, 8), cr(1, 9), cr(-1, 10)], shield: true });
  assert.equal(p.act, 'receive');
  assert.ok(p.face.z > ME.z + 2 && Math.abs(p.face.x - ME.x) < 2);
});

test('creeperPlan: not asked yet (the nearest is past 12): nothing, the old rules', () => {
  assert.equal(creeperPlan({ me: ME, creepers: [cr(13, 0), cr(13.5, 1)], shield: true }), null);
});

test('creeperPlan: one unlit creeper is the arm\'s-length dance, not a crowd', () => {
  assert.equal(creeperPlan({ me: ME, creepers: [cr(6, 0)], shield: true }), null);
  assert.equal(creeperPlan({ me: ME, creepers: [cr(6, 0)], shield: false }), null);
});

test('creeperPlan: company (a zombie, a skeleton) rules the plan out', () => {
  assert.equal(creeperPlan({ me: ME, creepers: [cr(8, 0), cr(9, 1)], shield: true, company: true }), null);
});

test('creeperPlan: creepers on opposite sides are not received on one shield', () => {
  const p = creeperPlan({ me: ME, creepers: [cr(7, 0), cr(-6, 0), cr(0, 7), cr(0, -6)], shield: true });
  assert.notEqual(p?.act, 'receive');
});

test('creeperPlan: hurt (under SHIELD_MIN_HP) with one hissing: outrun, never stand', () => {
  const p = creeperPlan({ me: ME, creepers: [cr(5, 0, true), cr(8, 1)], shield: true, health: SHIELD_MIN_HP - 1 });
  assert.equal(p.act, 'outrun');
  assert.equal(p.away, CREEPER_SAFE);
  assert.equal(p.from.length, 2);
  assert.equal(p.from[0].away, CREEPER_SAFE, 'the hissing one: out of its blast');
  assert.equal(p.from[1].away, 5, 'the unlit one: kept off at 5');
});

test('creeperPlan: no shield, one hissing: outrun; none hissing: line them up only with a shield', () => {
  assert.equal(creeperPlan({ me: ME, creepers: [cr(5, 0, true), cr(8, 1)], shield: false }).act, 'outrun');
  assert.equal(creeperPlan({ me: ME, creepers: [cr(8, 0), cr(9, 1)], shield: false }), null);
});

test('creeperPlan: a shield but nowhere safe to stand (a drop beside us): outrun the hissing', () => {
  assert.equal(creeperPlan({ me: ME, creepers: [cr(5, 0, true), cr(8, 1)], shield: true, safe: false }).act, 'outrun');
});

test('creeperPlan: spread all round with a shield and room: lead them into a line (twice at most)', () => {
  const ring = [cr(7, 0), cr(-6, 0), cr(0, 7), cr(0, -6)];
  const p = creeperPlan({ me: ME, creepers: ring, shield: true });
  assert.equal(p?.act, 'lead');
  assert.ok(p.away > p.nearest);
  assert.notEqual(creeperPlan({ me: ME, creepers: ring, shield: true, leads: 2 })?.act, 'lead');
});

test('creeperPlan: one left of a crowd we were taking on, hissing: the shield stays up; an unlit one: not ours', () => {
  assert.equal(creeperPlan({ me: ME, creepers: [cr(4, 0, true)], shield: true, active: true }).act, 'receive');
  assert.equal(creeperPlan({ me: ME, creepers: [cr(8, 0)], shield: true, active: true }), null);
});

test('awayPathFrom: asks the pathfinder for a standable cell far enough from every one, and returns its path', () => {
  let goalTest;
  const findPath = (classify, start, goal, opts) => { goalTest = opts.goalTest; return { complete: true, path: [P(0, 64, 0), P(-3, 64, 0)] }; };
  const from = [{ x: 5, y: 64, z: 0, away: 7.5 }, { x: 0, y: 64, z: 6, away: 5 }];
  const path = awayPathFrom(findPath, null, ME, from, 400, { drop: 1 });
  assert.equal(path.length, 2);
  const w = { standable: () => true };
  assert.equal(goalTest(-4, 64, -3, w), true, 'past both');
  assert.equal(goalTest(-1, 64, 0, w), false, 'still inside the first one\'s blast reach');
  assert.equal(goalTest(1, 64, 2, w), false);
  assert.equal(goalTest(-4, 64, -3, { standable: () => false }), false, 'must be somewhere we can stand');
  assert.equal(awayPathFrom(() => ({ complete: false, path: [] }), null, ME, from), null);
  assert.equal(awayPathFrom(() => ({ complete: true, path: [P(0, 64, 0)] }), null, ME, from), null, 'a one-cell path is not a way out');
});
