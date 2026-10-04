import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullPath, boatEnd, flankSpots, climbSpot, boatToMob, BOAT_CLIMB, LEAD_SLACK } from '../behavior_pack/scripts/core/towline.js';

// The u204 villagerhaul slab: grass at y 151 everywhere, and a one-high stone rise 46..49 x 11..17 (the boat sat at 45,16 and was
// pulled east into its face for 54 s while the walker went round it).
const GROUND = 151;
const rise = (x, z) => x >= 46 && x <= 49 && z >= 11 && z <= 17;
const surf = (x, z) => GROUND + (rise(x, z) ? 1 : 0);
const standable = (x, z) => surf(x, z);
const BOAT = { x: 45, z: 16 };

test('pullPath: a straight pull into the face of a one-high rise is stopped there', () => {
  const p = pullPath(surf, BOAT, { x: 54, z: 16 }, GROUND);
  assert.equal(p.clear, false);
  assert.equal(p.rise, 1);
  assert.ok(p.reach < 2 && p.reach > 0.2, `reach ${p.reach}`);
  assert.equal(Math.floor(p.at.x), 46);
  assert.ok(p.x < 46 && p.x > 44.9, "it sat at the face");
});

test('pullPath: from the south-east the same boat slides clear of it', () => {
  assert.equal(pullPath(surf, BOAT, { x: 52, z: 22 }, GROUND).clear, true);
  assert.equal(pullPath(surf, { x: 40, z: 16 }, { x: 44, z: 16 }, GROUND).clear, true, 'flat ground: clear');
});

test('pullPath: follows the ground down (a drop is not a step) and up by a snow layer', () => {
  const s = (x) => (x < 3 ? 70 : x < 6 ? 69 : 69.1);
  assert.equal(pullPath((x) => s(x), { x: 0.5, z: 0.5 }, { x: 9, z: 0.5 }, 70).clear, true);
  const stairs = (x) => 70 + Math.max(0, Math.floor(x - 2));
  assert.equal(pullPath((x) => stairs(x), { x: 0.5, z: 0.5 }, { x: 9, z: 0.5 }, 70).clear, false, 'one-high steps one after another');
});

test('pullPath: a hole is a stop too (no surface)', () => {
  const p = pullPath((x) => (x >= 4 && x < 7 ? -Infinity : 70), { x: 0.5, z: 0.5 }, { x: 9, z: 0.5 }, 70);
  assert.equal(p.clear, false);
  assert.equal(p.rise, Infinity);
});

test('boatEnd: it comes until LEAD_SLACK from us; a step stops it short', () => {
  const near = boatEnd(surf, { x: 30, z: 16 }, { x: 33, z: 16 }, GROUND);
  assert.equal(near.d, 0, 'already within the slack');
  const e = boatEnd(surf, { x: 30, z: 16 }, { x: 40, z: 16 }, GROUND);
  assert.ok(Math.abs(e.x - (40 - LEAD_SLACK)) < 0.01 && e.clear);
  const blocked = boatEnd(surf, BOAT, { x: 54, z: 16 }, GROUND);
  assert.equal(blocked.clear, false);
  assert.ok(blocked.x < 46.5);
});

test('flankSpots: round the rise, the boat is sent south-east of it; every spot has a clear pull; none is in the rise\'s lee', () => {
  const wp = { x: 54, z: 20.5 };
  const spots = flankSpots({ surf, standable, boat: BOAT, level: GROUND, wp, me: { x: 53, z: 16 } });
  assert.ok(spots.length > 0, 'a way round was found');
  for (const s of spots) assert.equal(pullPath(surf, BOAT, s, GROUND).clear, true);
  const best = spots[0];
  assert.ok(best.z > 18, `best spot is south of the rise: ${JSON.stringify(best)}`);
  assert.ok(best.gain > 1);
});

test('flankSpots: nothing round a wall across the whole slab (the real hills): empty, so the climb is next', () => {
  const wall = (x, z) => GROUND + (x >= 54 ? 1 : 0);
  const spots = flankSpots({ surf: wall, standable: wall, boat: { x: 52.5, z: 14 }, level: GROUND, wp: { x: 62, z: 14 }, me: { x: 56, z: 14 } });
  assert.deepEqual(spots, []);
});

test('climbSpot: onto the step ahead of the boat, past its edge', () => {
  const c = climbSpot({ surf, standable, boat: BOAT, level: GROUND, toward: { x: 53, z: 16 } });
  assert.ok(c, 'found');
  assert.equal(c.y, GROUND + 1);
  assert.ok(c.x >= 46 && c.x < 50);
  assert.equal(climbSpot({ surf, standable, boat: { x: 40, z: 16 }, level: GROUND, toward: { x: 44, z: 16 } }), null, 'nothing in the way: no climb');
  // A step too high to stand on, nothing beyond: none.
  const sheer = (x) => GROUND + (x >= 46 ? 9 : 0);
  assert.equal(climbSpot({ surf: sheer, standable: sheer, boat: BOAT, level: GROUND, toward: { x: 53, z: 16 } }), null);
});

test('boatToMob: stand past the mob on the line from the boat, within the lead\'s reach, going by it on our side', () => {
  const boat = { x: 30.5, z: 14.5 }, mob = { x: 40.5, z: 10.5 }, me = { x: 32.5, z: 14.5 };
  const r = boatToMob(boat, mob, me);
  assert.ok(Math.hypot(r.stand.x - boat.x, r.stand.z - boat.z) <= 8.5 + 1e-9);
  // On the line boat -> mob.
  const cross = (r.stand.x - boat.x) * (mob.z - boat.z) - (r.stand.z - boat.z) * (mob.x - boat.x);
  assert.ok(Math.abs(cross) < 1e-6);
  // The side point is on our side of the line and clear of the mob by the side distance.
  assert.ok(Math.abs(Math.hypot(r.via.x - mob.x, r.via.z - mob.z) - 3.4) < 1e-9);
  const cv = (r.via.x - boat.x) * (mob.z - boat.z) - (r.via.z - boat.z) * (mob.x - boat.x);
  const cm = (me.x - boat.x) * (mob.z - boat.z) - (me.z - boat.z) * (mob.x - boat.x);
  assert.equal(Math.sign(cv), Math.sign(cm));
  // Near: past by 5.2.
  const n = boatToMob({ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 0, z: 3 });
  assert.ok(Math.abs(n.stand.x - 7.2) < 1e-9 && Math.abs(n.stand.z) < 1e-9);
  assert.ok(BOAT_CLIMB > 0);
});
