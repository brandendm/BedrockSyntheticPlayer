import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glideTick, touchdown, planGlide, followPitch, FLARE, GLIDE } from '../behavior_pack/scripts/core/glide.js';
import { flight } from '../tools/sim_glide.mjs';

// The owner's elytra run (u204 report): wings open 0.6 s in at x 2.0, y +1.0, going 6 b/s along and 5 b/s down, the nose 34 deg down for 1.5 s, then
// easing to 18 and back to 25. His positions (blocks along, blocks down from the start) were 3.8/-1.5 at 1 s, 14.3/-8.9 at 2 s, 32.3/-14.2 at 3 s, 50.7/-22 at 4 s.
const PROFILE = [[0, 34], [1.5, 34], [1.6, 31], [1.7, 29], [1.8, 28], [2.0, 27], [2.1, 24], [2.2, 22], [2.3, 21], [2.4, 19], [2.6, 18], [3.2, 18], [3.3, 21], [3.4, 23], [3.5, 24], [3.7, 25]];
const pitchAt = (t) => PROFILE.reduce((p, [tt, pp]) => (tt <= t ? pp : p), 34);

test('the glide model reproduces the owner\'s dive to within a few blocks', () => {
  let x = 2.0, y = 1.0, vx = 6 / 20, vy = -5 / 20;
  const at = {};
  for (let tick = 1; tick <= 68; tick++) {
    [vx, vy] = glideTick(vx, vy, pitchAt(0.6 + tick / 20));
    x += vx; y += vy;
    if ([8, 28, 48, 68].includes(tick)) at[Math.round(0.6 + tick / 20)] = [x, y];
  }
  const want = { 1: [3.8, -1.5], 2: [14.3, -8.9], 3: [32.3, -14.2], 4: [50.7, -22] };
  for (const [s, [wx, wy]] of Object.entries(want)) {
    const g = at[s];
    if (!g) continue;
    assert.ok(Math.abs(g[0] - wx) < 9 && Math.abs(g[1] - wy) < 5, `t=${s}: model ${g.map((v) => v.toFixed(1))} vs ${wx},${wy}`);
  }
});

test('level flight sinks slowly and keeps its speed; nose up trades speed for height', () => {
  let vx = 0.9, vy = 0;
  for (let i = 0; i < 40; i++) [vx, vy] = glideTick(vx, vy, 0);
  assert.ok(vy < 0 && vy > -0.5, `level sink ${vy}`);
  assert.ok(vx > 0.3);
  const [, up] = glideTick(0.9, -0.2, -30);
  const [, lvl] = glideTick(0.9, -0.2, 0);
  assert.ok(up > lvl, 'nose up sinks less');
});

test('touchdown: a steeper start lands nearer and harder', () => {
  const a = touchdown(20, 0.3, -0.2, 40), b = touchdown(20, 0.3, -0.2, 10);
  assert.ok(a.ticks < b.ticks, 'a dive gets down sooner');
  assert.ok(a.x > 0 && b.x > 0);
  assert.ok(a.vy < 0 && b.vy < 0);
});

test('planGlide: from the tower it dives first, bends up as the spot nears, and never asks for a landing harder than 5 b/s', () => {
  const first = planGlide({ h: 20, d: 48, vx: 0.2, vy: -0.4 }, { aim: 0 });
  assert.equal(first.mode, 'dive');
  assert.ok(first.pitch >= 30 && first.pitch <= 40, `pitch ${first.pitch}`);
  assert.ok(first.vyTd >= -0.25 - 1e-9);
  // Close to the ground and fast and sinking: pull up.
  const low = planGlide({ h: 3, d: 30, vx: 0.9, vy: -0.6 }, { aim: 0 });
  assert.ok(low.pitch < 0 || low.mode === 'pull', JSON.stringify(low));
});

test('the whole flight, view lag and all: about 3 s, touching down at the spot with a gentle sink, for a handful of ways the game could differ', () => {
  const worlds = [{}, { dragX: 0.98 }, { dragX: 0.989 }, { pitchBias: 4 }, { pitchBias: -4 }, { g: 0.0832 }, { g: 0.0768 }, { dragY: 0.972 }];
  for (const world of worlds) {
    const r = flight({ d: 48, h: 20, start: { vx: 0.2, vy: -0.4 }, world, aim: 0 });
    assert.ok(r.ticks / 20 < 3.8 && r.ticks / 20 > 2.2, `${JSON.stringify(world)}: ${r.ticks / 20} s`);
    assert.ok(Math.abs(r.miss) < 3, `${JSON.stringify(world)}: ${r.miss.toFixed(1)} from the spot`);
    assert.ok(-r.vy < 5.5, `${JSON.stringify(world)}: sink ${(-r.vy).toFixed(1)} b/s`);
  }
});

test('followPitch: the view comes to the command without overshooting, most of the way in 0.3 s', () => {
  let p = 0, r = 0, peak = 0;
  for (let i = 0; i < 6; i++) { [p, r] = followPitch(p, r, 40, 16); peak = Math.max(peak, p); }
  assert.ok(p > 30 && p <= 40.001, `after 0.3 s: ${p}`);
  for (let i = 0; i < 60; i++) { [p, r] = followPitch(p, r, 40, 16); peak = Math.max(peak, p); }
  assert.ok(peak <= 40.01 && Math.abs(p - 40) < 0.05);
  assert.ok(FLARE.up < 0 && GLIDE.g > 0);
});
