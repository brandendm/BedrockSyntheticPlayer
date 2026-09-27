import test from 'node:test';
import assert from 'node:assert/strict';
import { wetCones, towardWet, ExploreStall } from '../behavior_pack/scripts/core/explore.js';
import { makeRng } from '../behavior_pack/scripts/core/mathutil.js';

test('water we swam out of only rules out its direction when it is near and recent', () => {
  const p = { x: 0, z: 0 };
  const wet = [{ x: 30, z: 0, t: 1000 }, { x: -200, z: 0, t: 1000 }, { x: 0, z: 30, t: 0 }];
  const cones = wetCones(wet, p, 6500);
  assert.equal(cones.length, 1, 'the far one and the old one no longer count');
  assert.equal(towardWet(0, cones), true);
  assert.equal(towardWet(Math.PI, cones), false);
  assert.equal(towardWet(Math.PI / 2, cones), false);
});

test('swims in every direction nearby still leave room between the cones', () => {
  const p = { x: 0, z: 0 };
  const wet = [0, 1, 2].map((k) => ({ x: Math.cos(k * 2.1) * 30, z: Math.sin(k * 2.1) * 30, t: 100 }));
  const cones = wetCones(wet, p, 200);
  let open = 0;
  for (let k = 0; k < 36; k++) if (!towardWet((k / 36) * 2 * Math.PI, cones)) open++;
  assert.ok(open > 0, 'three swims no longer close off every way');
});

test('explore calls that get nowhere: a trek after 3, give up after 6; moving starts it over', () => {
  const s = new ExploreStall();
  const here = { x: 5, z: 5 };
  for (let i = 0; i < 3; i++) { s.start(here, 'sheep'); s.end({ x: 6, z: 5 }); }
  assert.equal(s.verdict(), 'trek');
  for (let i = 0; i < 3; i++) { s.start(here, 'sheep'); s.end(here); }
  assert.equal(s.verdict(), 'giveup');
  s.start(here, 'sheep'); s.end({ x: 40, z: 5 });
  assert.equal(s.verdict(), 'ok', 'got somewhere');
  s.start(here, 'log');
  assert.equal(s.verdict(), 'ok', 'looking for something else');
});

test('treks go a new way each time, and not into water if there is another way', () => {
  const s = new ExploreStall(), r = makeRng(3);
  const a1 = s.trekAngle(r), a2 = s.trekAngle(r);
  const gap = Math.abs(Math.atan2(Math.sin(a1 - a2), Math.cos(a1 - a2)));
  assert.ok(gap > 2, 'the second trek goes roughly the other way');
  const cones = [0];
  const a3 = new ExploreStall().trekAngle(makeRng(4), cones);
  assert.equal(towardWet(a3, cones), false);
});
