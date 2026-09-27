import test from 'node:test';
import assert from 'node:assert/strict';
import { MotorController } from '../behavior_pack/scripts/core/motor.js';
import { findPath, smoothPath, Cell } from '../behavior_pack/scripts/core/pathfinder.js';
import { angleDiff, makeRng, dist2D } from '../behavior_pack/scripts/core/mathutil.js';
import { makeWorld, SimBody, runMotor } from './helpers.js';

function plan(w, from, to) {
  const r = findPath(w.classify, from, to);
  assert.equal(r.complete, true);
  return smoothPath(w.classify, r.path);
}

function maxYawStep(looks) {
  let m = 0;
  for (let i = 1; i < looks.length; i++) m = Math.max(m, Math.abs(angleDiff(looks[i].yaw, looks[i - 1].yaw)));
  return m;
}

test('walks around a wall, arrives, never snaps the camera', async () => {
  const solids = [];
  for (let z = -4; z <= 4; z++) solids.push([6, 64, z], [6, 65, z]);
  const w = makeWorld({ solids });
  const body = new SimBody(w, { x: 0.5, y: 64, z: 0.5 }, 180); // start facing away from the goal
  const motor = new MotorController(body, {}, makeRng(1));
  const wps = plan(w, body.pos, { x: 12, y: 64, z: 0 });
  const { result, ticks } = await runMotor(motor, body, motor.followPath(wps));

  assert.equal(result?.status, 'arrived', `got ${JSON.stringify(result)} after ${ticks} ticks`);
  assert.ok(dist2D(body.pos, { x: 12.5, z: 0.5 }) < 0.5);
  assert.ok(maxYawStep(body.looks) <= 25, `camera snapped ${maxYawStep(body.looks).toFixed(1)} deg in one tick`);
});

test('movement never points more than ~20 deg off where the head faces', async () => {
  const w = makeWorld();
  const body = new SimBody(w, { x: 0.5, y: 64, z: 0.5 }, 90);
  const motor = new MotorController(body, {}, makeRng(2));
  const origTick = motor.tick.bind(motor);
  let worst = 0;
  motor.tick = () => {
    origTick();
    const o = motor.lastOutput;
    if (o.moveYaw !== null) worst = Math.max(worst, Math.abs(angleDiff(o.moveYaw, o.yaw)));
  };
  const wps = [{ x: 0.5, y: 64, z: 0.5 }, { x: 10.5, y: 64, z: 0.5 }, { x: 10.5, y: 64, z: 10.5 }];
  const { result } = await runMotor(motor, body, motor.followPath(wps));
  assert.equal(result?.status, 'arrived');
  assert.ok(worst <= 21, `strafed ${worst.toFixed(1)} deg`);
});

test('jumps up a step', async () => {
  const w = makeWorld({ ground: (x) => (x >= 4 ? 65 : 64) });
  const body = new SimBody(w, { x: 0.5, y: 64, z: 0.5 }, -90);
  const motor = new MotorController(body, {}, makeRng(3));
  const wps = plan(w, body.pos, { x: 8, y: 65, z: 0 });
  const { result } = await runMotor(motor, body, motor.followPath(wps));
  assert.equal(result?.status, 'arrived');
  assert.equal(body.pos.y, 65);
});

test('reports stuck when the path is blocked', async () => {
  const solids = [];
  for (let z = -3; z <= 3; z++) solids.push([4, 64, z], [4, 65, z], [4, 66, z]);
  const w = makeWorld({ solids });
  const body = new SimBody(w, { x: 0.5, y: 64, z: 0.5 }, -90);
  const motor = new MotorController(body, {}, makeRng(4));
  const wps = [{ x: 0.5, y: 64, z: 0.5 }, { x: 9.5, y: 64, z: 0.5 }]; // stale path through a wall
  const { result } = await runMotor(motor, body, motor.followPath(wps), 400);
  assert.equal(result?.status, 'stuck');
});

test('lookAt turns smoothly then holds before resolving', async () => {
  const w = makeWorld();
  const body = new SimBody(w, { x: 0.5, y: 64, z: 0.5 }, 0);
  const motor = new MotorController(body, {}, makeRng(5));
  const { result, ticks } = await runMotor(motor, body, motor.lookAt({ x: -10, y: 65.6, z: -10 }, 4));
  assert.equal(result?.status, 'aligned');
  assert.ok(ticks >= 8, `too fast to look human: ${ticks} ticks`);
  assert.ok(maxYawStep(body.looks) <= 25);
});

test('seamless repath keeps walking without a new reaction pause', async () => {
  const w = makeWorld();
  const body = new SimBody(w, { x: 0.5, y: 64, z: 0.5 }, -90);
  const motor = new MotorController(body, {}, makeRng(6));
  const p1 = motor.followPath([{ x: 0.5, y: 64, z: 0.5 }, { x: 20.5, y: 64, z: 0.5 }]);
  for (let i = 0; i < 30; i++) { motor.tick(); body.step(); }
  const p2 = motor.followPath([{ x: body.pos.x, y: 64, z: body.pos.z }, { x: 12.5, y: 64, z: 3.5 }], { seamless: true });
  assert.equal(p1, p2);
  motor.tick();
  assert.notEqual(motor.lastOutput.moveYaw, null, 'stopped on repath');
  const { result } = await runMotor(motor, body, p2);
  assert.equal(result?.status, 'arrived');
});

test('never looks at an avoided point (enderman head), even when the path goes right at it', async () => {
  const w = makeWorld();
  const body = new SimBody(w, { x: 0.5, y: 64, z: 0.5 }, -90);
  const motor = new MotorController(body, {}, makeRng(7));
  const head = { x: 8.5, y: 66.6, z: 0.5 }; // enderman standing on the path, eyes ~3 blocks up
  motor.setAvoid([head]);
  const origTick = motor.tick.bind(motor);
  let closest = 180;
  motor.tick = () => {
    origTick();
    const eye = { x: body.pos.x, y: body.pos.y + 1.62, z: body.pos.z };
    const dy = Math.abs(((Math.atan2(-(head.x - eye.x), head.z - eye.z) * 180 / Math.PI) - body.yaw + 540) % 360 - 180);
    const dp = Math.abs((-Math.atan2(head.y - eye.y, Math.hypot(head.x - eye.x, head.z - eye.z)) * 180 / Math.PI) - body.pitch);
    if (dist2D(body.pos, head) > 2) closest = Math.min(closest, Math.max(dy, dp));
  };
  await runMotor(motor, body, motor.followPath([{ x: 0.5, y: 64, z: 0.5 }, { x: 6.5, y: 64, z: 0.5 }]));
  assert.ok(closest > 12, `looked within ${closest.toFixed(1)} deg of the enderman's eyes`);
});

test('focus: keeps facing the target while backpedalling away from it', async () => {
  const w = makeWorld();
  const body = new SimBody(w, { x: 0.5, y: 64, z: 0.5 }, -90);
  const motor = new MotorController(body, {}, makeRng(8));
  motor.setFocus({ x: 5.5, y: 65, z: 0.5 }); // mob to the east
  const { result } = await runMotor(motor, body, motor.followPath([{ x: 0.5, y: 64, z: 0.5 }, { x: -6.5, y: 64, z: 0.5 }], { urgent: true }));
  assert.equal(result?.status, 'arrived');
  assert.ok(Math.abs(angleDiff(body.yaw, -90)) < 25, `ended facing ${body.yaw.toFixed(0)}, should still face the mob (-90)`);
});

test('1-high steps beside 2-high walls: climbs without getting stuck in the seam (real-width body)', async () => {
  // A 2-high ledge with 1-3 one-high steps cut into its edge, approached from random spots and
  // headings; the goal is up on the ledge. The old motor jumped into the seam in ~7% of these.
  for (let seed = 1; seed <= 40; seed++) {
    const r = makeRng(seed);
    const hm = new Map();
    for (let z = -6; z <= 6; z++) for (let x = 6; x <= 12; x++) hm.set(`${x},${z}`, 66);
    const steps = r.int(1, 3);
    for (let i = 0; i < steps; i++) hm.set(`6,${r.int(-4, 4)}`, 65);
    const w = makeWorld({ ground: (x, z) => hm.get(`${x},${z}`) ?? 64 });
    const start = { x: r.range(0.4, 3.6), y: 64, z: r.range(-5.6, 5.6) };
    const goal = { x: 9, y: 66, z: r.int(-5, 5) };
    const body = new SimBody(w, start, r.range(-180, 180), { hw: 0.3 });
    const motor = new MotorController(body, {}, makeRng(seed));
    const wps = plan(w, body.pos, goal);
    const { result, ticks } = await runMotor(motor, body, motor.followPath(wps), 800);
    assert.equal(result?.status, 'arrived', `seed ${seed}: ${JSON.stringify(result)} after ${ticks} ticks`);
    assert.ok(body.jumps <= 4, `seed ${seed}: ${body.jumps} jumps for two steps`);
  }
});

test('leaps a 1-block gap instead of going down and around', async () => {
  // A trench 1 wide and 2 deep across the whole way (z -8..8), floor at 62.
  const ground = (x, z) => (x === 5 ? 62 : 64);
  const w = makeWorld({ ground });
  const r = findPath(w.classify, { x: 0.5, y: 64, z: 0.5 }, { x: 10, y: 64, z: 3 });
  assert.equal(r.complete, true);
  assert.ok(r.path.some((p) => p.move?.type === 'leap'), 'plans a leap');
  assert.ok(r.path.every((p) => p.y === 64), 'never climbs down into the trench');
  for (const [sx, sz, yaw] of [[0.5, 0.5, -90], [2.2, -3.1, 0], [3.5, 4.4, 180]]) {
    const body = new SimBody(w, { x: sx, y: 64, z: sz }, yaw, { hw: 0.3 });
    const motor = new MotorController(body, {}, makeRng(3));
    const wps = plan(w, body.pos, { x: 10, y: 64, z: 3 });
    const { result, ticks } = await runMotor(motor, body, motor.followPath(wps), 600);
    assert.equal(result?.status, 'arrived', `from ${sx},${sz}: ${JSON.stringify(result)} after ${ticks} ticks`);
    assert.equal(body.jumps, 1, `from ${sx},${sz}: ${body.jumps} jumps`);
  }
});

test('never leaps over a deep drop or lava', () => {
  const deep = makeWorld({ ground: (x, z) => (x === 5 ? 50 : 64) });
  assert.ok(!findPath(deep.classify, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }).path.some((p) => p.move?.type === 'leap'));
  const lava = makeWorld({ ground: (x, z) => (x === 5 ? 62 : 64), danger: [[5, 62, 0], [5, 62, 1], [5, 62, -1]].flatMap(([x, y, z]) => [[x, y, z]]) });
  const r = findPath(lava.classify, { x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 });
  assert.ok(!r.path.some((p, i) => p.move?.type === 'leap' && Math.abs(p.z) <= 1 && r.path[i - 1] && Math.abs(r.path[i - 1].z) <= 1 && p.z === r.path[i - 1].z && [-1, 0, 1].includes(p.z)), 'no leap over the lava');
});

test('climbs a 1-wide, 3-high staircase out of a quarry without turning round', async () => {
  // Stairs along -x: column x (1..10) has its floor one lower per block, 3 blocks of room.
  const classify = (x, y, z) => {
    if (x <= 0) return y < 64 ? Cell.SOLID : Cell.AIR;
    if (z !== 0 || x > 10) return Cell.SOLID;
    return y >= 64 - x && y < 67 - x ? Cell.AIR : Cell.SOLID;
  };
  const w = { classify };
  const body = new SimBody(w, { x: 10.5, y: 54, z: 0.5 }, 90, { hw: 0.3 });
  const motor = new MotorController(body, {}, makeRng(1));
  const r = findPath(classify, body.pos, { x: -3, y: 64, z: 0 });
  assert.equal(r.complete, true);
  const { result } = await runMotor(motor, body, motor.followPath(smoothPath(classify, r.path)), 2000);
  assert.equal(result?.status, 'arrived');
  const worst = Math.max(...body.looks.slice(10).map((l) => Math.abs(angleDiff(l.yaw, 90))));
  assert.ok(worst < 30, `turned ${worst.toFixed(0)} deg away from the way out`);
  assert.equal(body.jumps, 10, 'one jump per step');
});

// Worlds from tools/stress_path.mjs that used to trip the walker: a leaf at head height round a
// drop (the lookahead cut the corner into it), a bush at a corner (turning 0.7 early clipped it),
// a step-up onto a 1-wide bridge over a ravine (the jump's carry went over the side).
test('stress worlds that used to trip the walker: all arrive', async () => {
  const { KINDS, walk } = await import('../tools/stress_path.mjs');
  const { makeRng: rng } = await import('../behavior_pack/scripts/core/mathutil.js');
  for (const [kind, seed] of [['forest', 11], ['forest', 164], ['jungle', 104], ['ravine', 69]]) {
    const sc = KINDS[kind](rng(seed * 7919 + kind.length));
    const out = await walk(sc.w, sc.start, sc.goal, sc.tol, seed);
    assert.equal(out.status, 'arrived', `${kind} ${seed}: ${out.status} at ${JSON.stringify(out.at)}`);
    assert.equal(out.replans, 0, `${kind} ${seed}: needed a replan`);
  }
});
