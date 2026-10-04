import test from 'node:test';
import assert from 'node:assert/strict';
import { wetRun, shoreFromSamples, pushImpulse, driveSpeed, boatArrived, BOAT_VMAX, BOAT_PUSH_CAP, MIN_WET_RUN } from '../behavior_pack/scripts/core/boating.js';

const flags = (s) => [...s].map((c) => c === 'w');

test('a path across a lake: the wet stretch and the first dry cell after it', () => {
  assert.deepEqual(wetRun(flags('dddwwwwwwwwwwdd')), { a: 3, b: 13 });
  assert.deepEqual(wetRun(flags('wwwwwwwwd')), { a: 0, b: 8 });
});

test('a path that ENDS in the lake (the search finishes 8 short of a target past the far shore): b is -1, not a made-up cell (the u204 boatcross lake)', () => {
  // x+3 dry, x+4.. wet, tolerance reached at x+39: 6 dry cells, then 37 wet to the end
  const path = [...'dddddd', ...'w'.repeat(37)];
  assert.deepEqual(wetRun(flags(path.join(''))), { a: 6, b: -1 });
});

test('a pond (under 8 wet cells in a row) is swum, not rowed; two ponds do not add up', () => {
  assert.equal(wetRun(flags('ddwwwwwwwdd')), null);                 // 7
  assert.equal(wetRun(flags('wwwwddwwwwdd')), null);
  assert.equal(MIN_WET_RUN, 8);
  assert.deepEqual(wetRun(flags('wwwdwwwwwwwwd')), { a: 4, b: 12 }); // the first run that is long enough
});

test('no wet cells, no path', () => {
  assert.equal(wetRun([]), null);
  assert.equal(wetRun(flags('dddd')), null);
});

const land = (x) => ({ k: 'land', x, y: 151, z: 0.5 });
const water = { k: 'water' };

test('the far shore is read from the water\'s edge too (u204: asked from the shore cell the old scan saw water first, had no shore to leave from, and found nothing)', () => {
  const from = { x: 3.5, y: 151, z: 0.5 };
  // 20 samples of water (2 blocks apart: 40 across), then land
  const samples = [...Array(20).fill(water), land(45.5), land(47.5)];
  const r = shoreFromSamples(from, samples);
  assert.ok(r);
  assert.equal(r.shore, from);
  assert.equal(r.far.x, 45.5);
  assert.equal(r.width, 40);
});

test('the shore is the last land before the water, the far shore the first land after at least 8 blocks of it', () => {
  const from = { x: -1.5, y: 151, z: 0.5 };
  const samples = [land(0.5), land(2.5), water, water, water, water, land(14.5), land(16.5)];
  const r = shoreFromSamples(from, samples);
  assert.equal(r.shore.x, 2.5);
  assert.equal(r.far.x, 14.5);
  assert.equal(r.width, 8);
});

test('a pond narrower than 8 is not crossed by boat; an island in a lake does not end the crossing', () => {
  const from = { x: 0, y: 151, z: 0 };
  assert.equal(shoreFromSamples(from, [land(2), water, water, water, land(10), land(12)]), null); // 6 across
  const r = shoreFromSamples(from, [land(2), water, water, water, land(10), water, water, water, water, water, land(22)]);
  // 6 across, land, then 10 across: the second is the crossing (the island is its shore)
  assert.equal(r.shore.x, 10);
  assert.equal(r.far.x, 22);
});

test('ice and leaves are passed over: neither water to row nor land to leave from', () => {
  const from = { x: 0, y: 151, z: 0 };
  const r = shoreFromSamples(from, [land(2), water, water, { k: 'bad' }, water, water, land(14)]);
  assert.equal(r.far.x, 14);
  assert.equal(r.width, 10);
});

test('pushImpulse: from rest it pushes at the cap along the heading, scaled by the gain', () => {
  const p = pushImpulse({ x: 0, z: 0 }, 1, 0, 0.35);
  assert.ok(Math.abs(p.x - BOAT_PUSH_CAP * 0.6) < 1e-9);
  assert.equal(p.z, 0);
  const q = pushImpulse({ x: 0, z: 0 }, 0.6, 0.8, 0.35);
  assert.ok(Math.abs(Math.hypot(q.x, q.z) - BOAT_PUSH_CAP * 0.6) < 1e-9);
  assert.ok(q.x > 0 && q.z > 0 && q.z / q.x > 1.3 && q.z / q.x < 1.4);
});

test('pushImpulse: at the wanted speed nothing, short of it a push, over it a brake, sideways drift is cancelled', () => {
  assert.deepEqual(pushImpulse({ x: 0.35, z: 0 }, 1, 0, 0.35), { x: 0, z: 0 });
  assert.ok(pushImpulse({ x: 0.3, z: 0 }, 1, 0, 0.35).x > 0);
  assert.ok(pushImpulse({ x: 0.4, z: 0 }, 1, 0, 0.35).x < 0);
  const drift = pushImpulse({ x: 0.35, z: 0.05 }, 1, 0, 0.35);
  assert.ok(drift.z < 0 && Math.abs(drift.x) < 1e-9);
});

test('driving the lake: a simple model of a boat (the impulse added, 0 to 10% drag a tick) gets going at once, never far over the top speed, and does the 36 blocks in about 5 s', () => {
  for (const drag of [1, 0.98, 0.95, 0.92, 0.9]) {
    let x = 0, vx = 0, t = 0, top = 0;
    const goal = 39;
    while (x < goal - 2.7 && t < 600) { // (it stops pushing 2.7 short: boatArrived)
      const imp = pushImpulse({ x: vx, z: 0 }, 1, 0, driveSpeed(goal - x, BOAT_VMAX, vx * 20) / 20);
      vx = (vx + imp.x) * drag; x += vx; t++; top = Math.max(top, vx * 20);
    }
    assert.ok(t < 600, `drag ${drag}: never got there`);
    assert.ok(top <= BOAT_VMAX + 1, `drag ${drag}: ${top} b/s`);
    assert.ok(t / 20 > 4.5 && t / 20 < 5.5, `drag ${drag}: ${t / 20} s`);
  }
});

test('driveSpeed: flat out until the last few blocks, never below 2 b/s, never above the cap', () => {
  assert.equal(driveSpeed(40), BOAT_VMAX);
  assert.equal(driveSpeed(6), BOAT_VMAX);
  assert.ok(driveSpeed(2) < BOAT_VMAX && driveSpeed(2) >= 2);
  assert.equal(driveSpeed(0), 2);
  assert.equal(driveSpeed(40, 5), 5);
});

test('driveSpeed: under the cruising speed it asks for a fifth more, at it (or near the shore) it does not', () => {
  assert.ok(Math.abs(driveSpeed(40, BOAT_VMAX, 5) - BOAT_VMAX * 1.2) < 1e-9);
  assert.equal(driveSpeed(40, BOAT_VMAX, BOAT_VMAX - 0.2), BOAT_VMAX);
  assert.equal(driveSpeed(40, BOAT_VMAX, 9), BOAT_VMAX);          // over it: back to the cruise (the push brakes)
  assert.ok(driveSpeed(2, BOAT_VMAX, 6) < BOAT_VMAX * 1.2);
});

test('boatArrived: close to the far shore, or stopped against the bank within reach of it; not stopped mid-lake', () => {
  assert.equal(boatArrived({ d: 2.5, speed: 7, stillTicks: 0 }), true);
  assert.equal(boatArrived({ d: 3.4, speed: 7, stillTicks: 0 }), false);
  assert.equal(boatArrived({ d: 3.4, speed: 0.2, stillTicks: 9 }), true);   // against the bank
  assert.equal(boatArrived({ d: 3.4, speed: 0.2, stillTicks: 3 }), false);  // a moment's pause
  assert.equal(boatArrived({ d: 20, speed: 0, stillTicks: 100 }), false);   // stuck out in the lake: the nudge's business, not an arrival
});
