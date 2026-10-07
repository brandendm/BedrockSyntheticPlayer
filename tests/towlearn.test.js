import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseTow, speedFrac, mergeLearned } from '../behavior_pack/scripts/core/towlearn.js';

// A player leads a boat along +x: the boat only follows once they're over 5 apart, the player waits at 6.5 apart, and the boat
// sticks for 3 seconds at one point; the player then goes round to its side (a quarter turn) and it comes free.
function simulate() {
  const out = [];
  let px = 0, pz = 0, bx = -2, bz = 0;
  for (let i = 0; i < 160; i++) {
    const t = i * 5, sep = Math.hypot(px - bx, pz - bz);
    const stuck = i >= 60 && i < 76;
    if (sep > 5 && !stuck) { const d = 1 / (sep || 1); bx += (px - bx) * d; bz += (pz - bz) * d; } // 4 blocks/s toward the player
    if (stuck && i === 75) { px = bx; pz = bz + 5; }                                                   // goes round to the side
    else if (sep < 6.5 && !(stuck && sep > 5)) px += 1;                                                // 4 blocks/s unless waiting
    out.push({ t, px, pz, bx, bz, by: 64, rise: stuck ? 1 : 0, leashed: true, ride: false });
  }
  return out;
}

test('a tow is worked out from a player doing it', () => {
  const r = analyseTow(simulate());
  assert.ok(r);
  assert.ok(r.pullAt >= 4.5 && r.pullAt <= 6.5, `pullAt ${r.pullAt}`);
  assert.ok(r.holdAt >= 5.5 && r.holdAt <= 7.2, `holdAt ${r.holdAt}`);
  assert.ok(r.stuckEvents >= 1);
  assert.ok(r.flank && r.flank.angle >= 50 && r.flank.angle <= 130, JSON.stringify(r.flank));
  assert.equal(r.blockedRise, 1);
  assert.equal(r.snapped, false);
});

test('too little to learn from gives nothing', () => assert.equal(analyseTow(simulate().slice(0, 10)), null));

test('speed against separation, and sessions folded together', () => {
  const r = analyseTow(simulate());
  const curve = [{ from: 0, to: 4, frac: 1 }, { from: 4, to: 7, frac: 0.6 }, { from: 7, to: 99, frac: 0.1 }];
  assert.equal(speedFrac(curve, 1), 1);
  assert.equal(speedFrac(curve, 5), 0.6);
  assert.equal(speedFrac(curve, 11), 0.35); // (the floor: easing to a stop is the hold distance's job)
  assert.equal(speedFrac(null, 3), 1);
  const m = mergeLearned({ ...r, secs: 10, pullAt: 4 }, { ...r, secs: 10, pullAt: 6 });
  assert.equal(m.pullAt, 5);
  assert.equal(m.sessions, 2);
});

test('standing still with the boat close does not teach a standstill', () => {
  // A player who mostly stands about (boat near) and sometimes walks off: the slow buckets must not read as "stop".
  const S = [];
  let px = 0;
  for (let i = 0; i < 120; i++) {
    const moving = i % 30 >= 20;               // walks for the last third of each half minute
    if (moving) px += 1;
    S.push({ t: i * 5, px, pz: 0, bx: px - 1.5, bz: 0, by: 64, rise: 0, leashed: true, ride: false });
  }
  const r = analyseTow(S);
  assert.ok(r.curve.every((row) => row.frac > 0.5), JSON.stringify(r.curve));
  assert.ok(speedFrac(r.curve, 1) >= 0.35);
});

test('a sling is read from a jump with the lead stretched and the boat still', () => {
  const S = [];
  for (let i = 0; i < 60; i++) {
    // The player walks off, the boat is stuck at 0; at sample 40 they are 9 apart and jump; the boat then flies to them.
    const px = Math.min(9, i * 0.5), py = i >= 40 && i <= 42 ? 64 + (i - 39) * 0.5 : 64;
    const bx = i > 42 ? Math.min(px - 1, (i - 42) * 1.2) : 0;
    S.push({ t: i * 5, px, py, pz: 0, bx, bz: 0, by: 64, rise: 1, leashed: true, ride: false });
  }
  const r = analyseTow(S);
  assert.ok(r.sling, JSON.stringify(r));
  assert.ok(r.sling.stretch >= 8 && r.sling.stretch <= 9.1, `stretch ${r.sling.stretch}`);
  assert.ok(r.sling.boatPeak > 3, `peak ${r.sling.boatPeak}`);
});

import { slingCame, stuckTrack } from '../behavior_pack/scripts/core/towlearn.js';

test('a sling where the boat never moved is not "it came" (u202 counted 16 of them)', () => {
  assert.equal(slingCame({ snapped: false, valid: true, moved: 0.1, closer: 0, climbed: 0 }), false);
  assert.equal(slingCame({ snapped: false, valid: true, moved: 0.4, closer: 0.4, climbed: 0.1 }), false);
  assert.equal(slingCame({ snapped: false, valid: true, moved: 6, closer: 5, climbed: 1.4 }), true);
  assert.equal(slingCame({ snapped: false, valid: true, moved: 1, closer: 0.8, climbed: 0.6 }), true); // went up the step
  assert.equal(slingCame({ snapped: true, valid: true, moved: 6, closer: 5, climbed: 1.4 }), false);   // the lead broke
  assert.equal(slingCame({ snapped: false, valid: false, moved: 0, closer: 0, climbed: 0 }), false);
});

test('the stuck counter counts a boat that rocks a little as the same place', () => {
  let t = null;
  for (const [x, z] of [[46.4, -29.4], [46.6, -29.6], [46.5, -29.5], [47.2, -29.9], [46.6, -29.0]]) t = stuckTrack(t, { x, z });
  assert.equal(t.count, 5);
  // (rounded to whole blocks, 46.4 / 46.6 straddle .5 and the old key changed every time)
  const moved = stuckTrack(t, { x: 52, z: -29.5 });
  assert.equal(moved.count, 1);
  assert.deepEqual(moved.anchor, { x: 52, z: -29.5 });
});

import { learnedStretch } from '../behavior_pack/scripts/core/towlearn.js';

test('u241: a sling remembers the height of the step, and building forward for room before the jump is read from the blocks placed', () => {
  const S = [];
  for (let i = 0; i < 90; i++) {
    // Blocks go down at samples 10..30 (a block every 2: ten), the player walking out along them; at 50 they jump at 7.5 apart, the boat (stuck against a 2-high step) comes.
    const placed = Math.min(10, Math.max(0, Math.floor((i - 10) / 2)));
    const px = Math.min(7.5, 3 + Math.max(0, i - 10) * 0.2), py = i >= 50 && i <= 52 ? 64 + (i - 49) * 0.5 : 64;
    const bx = i > 52 ? Math.min(px - 1, (i - 52) * 1.2) : 0;
    S.push({ t: i * 5, px, py, pz: 0, bx, bz: 0, by: 64, rise: 2, leashed: true, ride: false, placed });
  }
  const r = analyseTow(S);
  assert.ok(r.sling && r.sling.came === 1, JSON.stringify(r.sling));
  assert.equal(r.sling.byRise[2], r.sling.stretch);
  assert.ok(r.runway && r.runway.blocks >= 8 && r.runway.gain > 2, JSON.stringify(r.runway));
  // Folded in with an earlier session, the heights are kept.
  const m = mergeLearned({ secs: 30, sling: { n: 1, stretch: 6, boatPeak: 5, byRise: { 1: 6 } }, runway: null }, r);
  assert.equal(m.sling.byRise[1], 6);
  assert.equal(m.sling.byRise[2], r.sling.stretch);
});

test('u241: the stretch for a step comes from the player\'s own jump at that height, the nearest lower one a little longer, or the overall median', () => {
  const sl = { stretch: 7, byRise: { 1: 5.5, 3: 8 } };
  assert.equal(learnedStretch(sl, 1), 5.5);
  assert.equal(learnedStretch(sl, 3), 8);
  assert.equal(learnedStretch(sl, 2), 5.5);   // nothing at 2: the lower one (the next height up is not needed to be more than that)
  assert.equal(learnedStretch(sl, 4), 8.5);   // above all: the highest, a little more
  assert.equal(learnedStretch({ stretch: 7, byRise: null }, 2), 7);
  assert.equal(learnedStretch(null, 2), null);
});

test('u241: a jump that frees a boat jammed on a corner (no step) is kept as a yank, with its stretch', () => {
  const S = [];
  for (let i = 0; i < 60; i++) {
    const px = Math.min(7, i * 0.4), py = i >= 40 && i <= 42 ? 64 + (i - 39) * 0.5 : 64;
    const bx = i > 42 ? Math.min(px - 1, (i - 42) * 1.2) : 0;
    S.push({ t: i * 5, px, py, pz: 0, bx, bz: 0, by: 64, rise: 0, leashed: true, ride: false, placed: 0 });
  }
  const r = analyseTow(S);
  assert.ok(r.sling?.flat && r.sling.flat.stretch >= 6, JSON.stringify(r.sling));
  assert.equal(r.sling.byRise, null);
  assert.equal(mergeLearned({ secs: 20, sling: { n: 1, stretch: 5, boatPeak: 3, byRise: { 2: 6 } } }, r).sling.byRise[2], 6);
});
