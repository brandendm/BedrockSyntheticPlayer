// Motor controller: turns high-level intents into smooth, human-looking input at 20 tps.
//
// The brain never sets the camera. It hands the motor an intent ("follow this path",
// "look at that block") and the motor owns rotation and movement every tick.
//
// What makes it look human:
//   - Rotation is a damped spring with a speed cap: no snapping. Big turns are
//     slightly underdamped, so they overshoot a touch and settle like a mouse flick.
//   - Steering is pure pursuit toward a point ~1.6 blocks ahead, so corners become curves.
//   - The gaze is further ahead (~4 blocks) and slightly down at the ground, not at the feet.
//   - Movement follows the facing direction: it can drift at most `maxStrafeDeg` off the
//     head yaw, and it turns in place first if the path doubles back.
//   - Short random reaction delay before each new intent; head starts turning during it.
//   - Tiny low-frequency jitter on the output angles, idle head drift when waiting.
//
// The motor is pure: it talks to the game only through a `body` adapter:
//   getPos() -> {x,y,z} feet        isOnGround() -> bool
//   look(yaw, pitch)                 move(dirX, dirZ, speed01)   stop()
//   jump()                           setSprinting(bool)       isInWater(), swimUp() (optional)

import {
  DEG, clamp, angleDiff, yawTo, pitchTo, viewVector, dist2D, springAngle, makeRng, SmoothNoise,
} from './mathutil.js';
import { gaitFor, landingAlong, reachFrom } from './jump.js';

export const TICK = 0.05;
// The simulated player's head is 1.52 above its feet in BDS 1.26 (measured: feet y 72.000, head 73.520), not the
// 1.62 of the Java-edition player. With 1.62 every aim came out 2-3 degrees low (a block short at 2 blocks out).
// (Live binding: game/calibrate.js sets it from what the game reports when the bot spawns.)
export let EYE_HEIGHT = 1.52;
export function setEyeHeight(h) { EYE_HEIGHT = h; }

export const DEFAULTS = Object.freeze({
  omega: 11,            // spring stiffness (rad/s-ish); higher = snappier head
  zetaSmall: 1.0,       // critically damped for small corrections
  zetaFlick: 0.72,      // slight overshoot on big turns
  flickThreshold: 45,   // degrees
  maxYawSpeed: 480,     // deg/s cap (24 deg/tick)
  maxPitchSpeed: 300,
  jitterYaw: 0.35,      // degrees of output jitter
  jitterPitch: 0.25,
  steerLookahead: 1.6,  // blocks
  gazeLookahead: 4.0,
  gazeDrop: 0.6,        // look this far below eye level at the gaze point (tuned in-game)
  maxStrafeDeg: 35,     // max angle between facing and movement direction (was 20: the bot turned its view 10 to 50 times as far as a player in the same job)
  turnInPlaceDeg: 100,  // above this heading error, stop and turn first (was 75)
  arriveRadius: 0.35,
  waypointRadius: 0.7,  // flat corners: start turning this early
  reactionTicks: [1, 3], // 50-150 ms (was 150-350: the test runs had a player start moving 0.1 s in, the bot 0.3 to 1.1 s)
  stuckWindow: 40,      // ticks between progress checks
  stuckMinProgress: 0.4,
  sprintMinRemaining: 4,
});

export class MotorController {
  constructor(body, opts = {}, rng = makeRng()) {
    this.body = body;
    this.o = { ...DEFAULTS, ...opts };
    this.rng = rng;
    const r = body.getRotation ? body.getRotation() : { yaw: 0, pitch: 0 };
    this.yaw = r.yaw;
    this.pitch = r.pitch;
    this.yawV = 0;
    this.pitchV = 0;
    this.t = 0;
    this.intent = null;
    this.glance = null;
    this.delay = 0;
    this.sprinting = false;
    this.jumpCooldown = 0;
    this.idleYaw = this.yaw;
    this.nYaw = new SmoothNoise(rng, 0.35);
    this.nPitch = new SmoothNoise(rng, 0.3);
    this.nIdle = new SmoothNoise(rng, 0.05);
    this.lastOutput = { yaw: this.yaw, pitch: this.pitch, moveYaw: null };
    this.focus = null;     // point to keep looking at while moving (combat): feet may strafe/backpedal freely
    this.avoid = [];       // points never to look straight at (enderman heads)
    this.submerge = false; // true: stay down in water instead of floating up (the arena's diver steers itself)
  }

  /** Keep the head on this point (e.g. a mob's chest) regardless of walking direction. null to clear. */
  setFocus(point) {
    this.focus = point;
  }

  /**
   * The head straight onto the point this instant, no spring (u216: a fast builder's flick from one block to the next, a block's width apart; the
   * spring takes 4 to 6 ticks to settle, and a stiffer one is unstable at 20 ticks a second). It stays there as the focus.
   */
  snap(point) {
    const pos = this.body.getPos();
    const eye = { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z };
    this.yaw = yawTo(eye, point);
    this.pitch = clamp(pitchTo(eye, point), -89, 89);
    this.yawV = 0;
    this.pitchV = 0;
    this.focus = point;
    this.body.look(this.yaw, this.pitch);
    this.lastOutput = { yaw: this.yaw, pitch: this.pitch, moveYaw: null };
  }

  /** Points the gaze must steer clear of (enderman heads). */
  setAvoid(points) {
    this.avoid = points || [];
  }

  get busy() {
    return this.intent !== null;
  }

  /**
   * Walk a list of waypoints ({x,y,z}, y = feet level). Resolves {status: arrived|stuck|cancelled}.
   * seamless: if already walking, swap in the new path without stopping or a new reaction
   * delay (used when repathing toward a moving target).
   */
  followPath(waypoints, { seamless = false, urgent = false, walk = false } = {}) {
    if (seamless && this.intent?.kind === 'path') {
      const it = this.intent;
      it.urgent = urgent;
      it.walk = walk;
      it.wps = waypoints;
      it.idx = Math.min(1, waypoints.length - 1);
      it.lastRemaining = Infinity;
      it.strikes = 0;
      return it.promise;
    }
    return this._begin({
      kind: 'path',
      urgent,
      walk, // never sprint (closing on a creeper: a sprint's carry takes us inside its fuse range)
      wps: waypoints,
      idx: Math.min(1, waypoints.length - 1),
      ticks: 0,
      lastRemaining: Infinity,
      strikes: 0,
    });
  }

  /** Turn to face a point and hold on it briefly (look before acting). Resolves {status: aligned|timeout|cancelled}. */
  lookAt(point, holdTicks = 4, timeoutTicks = 60) {
    return this._begin({ kind: 'look', point, hold: holdTicks, held: 0, ticks: 0, timeout: timeoutTicks });
  }

  /**
   * Sidestep: walk in a world direction ({x, z}, unit) for `ticks` without turning to face it (A/D
   * keys: the head stays on whatever it's watching, the feet go sideways at walking speed; no
   * sprinting sideways). A reflex to something seen coming (an arrow), so a short reaction.
   * Resolves {status: arrived|cancelled}.
   */
  strafe(dir, ticks, { reaction = 2 } = {}) {
    return this._begin({ kind: 'strafe', dir, ticks, reaction });
  }

  /** Briefly look at something while idle (a mob walking past, a noise). */
  glanceAt(point, ticks = 30) {
    if (!this.intent) this.glance = { point, ticks };
  }

  stop() {
    this._finish('cancelled');
  }

  _begin(intent) {
    this._finish('cancelled');
    this.glance = null;
    this.delay = intent.reaction ?? this.rng.int(...this.o.reactionTicks);
    intent.promise = new Promise((resolve) => {
      intent.resolve = resolve;
    });
    this.intent = intent;
    return intent.promise;
  }

  _finish(status, extra = {}) {
    const it = this.intent;
    if (!it) return;
    this.intent = null;
    this.body.stop();
    this._setSprint(false);
    this.idleYaw = this.yaw;
    it.resolve({ status, ...extra });
  }

  _setSprint(v) {
    if (v !== this.sprinting) {
      this.sprinting = v;
      this.body.setSprinting(v);
    }
  }

  tick() {
    const o = this.o;
    this.t += TICK;
    if (this.jumpCooldown > 0) this.jumpCooldown--;

    // In water: keep the head above the surface (swims up if we sank), unless the path's taking us
    // under (a dive: down, or along below the surface; the agent's air watch brings us up if short).
    const inWater = !!this.body.isInWater?.();
    const wp = this.intent?.kind === 'path' ? this.intent.wps[this.intent.idx] : null;
    const diving = !!wp?.dive && wp.y <= this.body.getPos().y + 0.3;
    if (inWater && !diving && !this.submerge) this.body.swimUp?.(); // (submerge: a job under water on purpose, an arena's diver)

    const pos = this.body.getPos();
    const eye = { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z };
    let gaze;
    let move = null;
    let yawOverride = null;

    const it = this.intent;
    if (it && it.kind === 'path') {
      const r = this._pathStep(pos, it);
      if (!r) return this._output(eye, null, null); // finished this tick
      gaze = r.gaze;
      move = r.move;
      yawOverride = r.headYaw;
    } else if (it && it.kind === 'strafe') {
      if (this.delay <= 0 && it.ticks-- <= 0) { this._rotate(eye, this.focus ?? this.lastGaze ?? eye); this._output(eye, null, null); return this._finish('arrived'); }
      gaze = this.lastGaze ?? { x: eye.x + it.dir.x, y: eye.y, z: eye.z + it.dir.z };
      move = { yaw: Math.atan2(-it.dir.x, it.dir.z) / DEG, speed: 1 };
      this._setSprint(false);
    } else if (it && it.kind === 'look') {
      gaze = it.point;
      it.ticks++;
      const aligned =
        Math.abs(angleDiff(yawTo(eye, gaze), this.yaw)) < 2.5 &&
        Math.abs(pitchTo(eye, gaze) - this.pitch) < 2.5;
      it.held = aligned ? it.held + 1 : 0;
      if (it.held >= it.hold) {
        this._rotate(eye, gaze);
        this._output(eye, gaze, null);
        return this._finish('aligned');
      }
      if (it.ticks > it.timeout) return this._finish('timeout');
    } else if (this.glance) {
      gaze = this.glance.point;
      if (--this.glance.ticks <= 0) this.glance = null;
    } else {
      // Idle: slow wandering gaze around where we last faced, roughly level.
      const y = this.idleYaw + this.nIdle.at(this.t) * 25;
      const p = 4 + this.nIdle.at(this.t + 100) * 10;
      const v = viewVector(y, p);
      gaze = { x: eye.x + v.x * 5, y: eye.y + v.y * 5, z: eye.z + v.z * 5 };
    }

    if (this.focus) {
      gaze = this.focus;
      yawOverride = null;
    }
    this._rotate(eye, gaze, yawOverride);
    this.lastGaze = gaze;

    if (this.delay > 0) {
      this.delay--;
      move = null; // head moves during reaction delay, feet don't yet
    }
    this._output(eye, gaze, move);
  }

  _rotate(eye, gaze, yawOverride = null) {
    const o = this.o;
    // Looking (all but) straight up or down at something: the bearing to it is whatever the last few centimetres of where we stand make it, and
    // the spring swung the head round to follow every one (the u204 forest test, chopping up a trunk: 6705 degrees of yaw in the minute against
    // the owner's 1332). A player's yaw does not move when he looks up a trunk: held where it is while the target is within a quarter block of
    // the line and 4 times further up or down than across.
    const across = Math.hypot(gaze.x - eye.x, gaze.z - eye.z);
    const overhead = across < 0.25 && Math.abs(gaze.y - eye.y) > across * 4;
    const ty = yawOverride ?? (overhead ? this.yaw : yawTo(eye, gaze));
    let tp = clamp(pitchTo(eye, gaze), -89, 89);
    // Never look an enderman in the eyes: if the target direction passes near one, look down instead.
    for (const a of this.avoid) {
      const ay = yawTo(eye, a), ap = pitchTo(eye, a);
      if (Math.abs(angleDiff(ty, ay)) < 20 && Math.abs(tp - ap) < 20) tp = clamp(Math.max(tp, ap + 30), -89, 89);
    }
    const err = Math.abs(angleDiff(ty, this.yaw));
    const zeta = err > o.flickThreshold ? o.zetaFlick : o.zetaSmall;
    [this.yaw, this.yawV] = springAngle(this.yaw, this.yawV, ty, o.omega, zeta, TICK, o.maxYawSpeed, true);
    [this.pitch, this.pitchV] = springAngle(this.pitch, this.pitchV, tp, o.omega, 1.0, TICK, o.maxPitchSpeed, false);
    this.pitch = clamp(this.pitch, -89, 89);
  }

  _output(eye, gaze, move) {
    const o = this.o;
    const yaw = this.yaw + this.nYaw.at(this.t) * o.jitterYaw;
    const pitch = clamp(this.pitch + this.nPitch.at(this.t) * o.jitterPitch, -89, 89);
    this.body.look(yaw, pitch);
    if (move && move.speed > 0) {
      const d = { x: -Math.sin(move.yaw * DEG), z: Math.cos(move.yaw * DEG) };
      this.body.move(d.x, d.z, move.speed);
    } else if (this.intent) {
      this.body.stop();
    }
    this.lastOutput = { yaw, pitch, moveYaw: move && move.speed > 0 ? move.yaw : null };
  }

  _pathStep(pos, it) {
    const o = this.o;
    const wps = it.wps;
    const last = wps.length - 1;
    it.ticks++;

    // Advance past waypoints we've reached or passed.
    while (it.idx < last && this._reached(pos, wps, it.idx)) it.idx++;
    // Fell back off a step we'd counted as climbed (bumped a corner mid-jump): take it again.
    if (it.idx >= 2 && this.body.isOnGround() && wps[it.idx - 1].y > wps[it.idx - 2].y &&
        wps[it.idx].y >= wps[it.idx - 1].y && pos.y < wps[it.idx - 1].y - 0.5) it.idx--;

    const final = wps[last];
    // (Not "arrived" part way up a vine or ladder whose top is the last waypoint: the u204 vineclimb walk ended 0.8 under the top vine, within the
    // 1 of height, and the climb out onto the tower never happened.)
    const climbingTo = final.y - pos.y >= 0.45 && !!this.body.onClimbable?.();
    if (it.idx === last && dist2D(pos, final) < o.arriveRadius && Math.abs(pos.y - final.y) < 1 && !climbingTo) {
      this._finish('arrived');
      return null;
    }

    // Stuck detection: remaining distance must shrink every window.
    const remaining = this._remaining(pos, it);
    if (it.ticks % o.stuckWindow === 0) {
      if (it.lastRemaining - remaining < o.stuckMinProgress) {
        it.strikes++;
        if (it.strikes === 1) this.body.jump(); // cheap unstick attempt
        if (it.strikes >= 2) {
          this._finish('stuck', { at: { ...pos }, waypointIndex: it.idx });
          return null;
        }
      } else it.strikes = 0;
      it.lastRemaining = remaining;
    }

    // On a ladder with the next waypoint above: hold forward into the wall to climb, look up it.
    const nextWp = wps[it.idx];
    if (nextWp.y > pos.y + 0.3 && dist2D(pos, nextWp) < 0.8) {
      const climbYaw = this.body.climbYaw?.();
      if (climbYaw != null) {
        return { gaze: { x: nextWp.x, y: nextWp.y + EYE_HEIGHT + 1.5, z: nextWp.z }, move: { yaw: climbYaw, speed: 1 }, headYaw: climbYaw };
      }
      // On a vine with nothing beside it to push into (one hanging free): climbed by jumping, over and over.
      if (this.body.onClimbable?.() && this.jumpCooldown === 0) { this.body.jump(); this.jumpCooldown = 5; }
    }
    const leap = this._leap(pos, it);
    if (leap === 'fell') {
      this._finish('stuck', { at: { ...pos }, waypointIndex: it.idx, fell: true });
      return null;
    }
    // Up a stair or onto a slab: just walk into it (the game steps a body up half a block). Only if
    // that doesn't take (a stair the other way round, a mob in the way) does it jump.
    const nx = wps[it.idx];
    if (nx.stair && dist2D(pos, nx) < 1.3 && this.body.isOnGround() && pos.y < nx.y - 0.6) it.stairStall = (it.stairStall ?? 0) + 1;
    else it.stairStall = 0;
    if (leap?.air || leap?.lineup) {
      // In the air over a gap: the held direction is the steering (core/jump.js), head on the landing.
      this._setSprint(leap.sprint);
      const faceYaw = yawTo(pos, leap.face);
      return { gaze: { ...leap.face, y: leap.face.y + EYE_HEIGHT - o.gazeDrop }, move: leap.move ?? { yaw: faceYaw, speed: 0 }, headYaw: faceYaw };
    }
    const step = leap || nx.stair ? null : this._stepUp(pos, it);
    const steer = leap ? leap.steer : step ? step.steer : this._lookahead(pos, it, o.steerLookahead);
    const g = this._lookahead(pos, it, o.gazeLookahead);
    const gaze = { x: g.x, y: g.y + EYE_HEIGHT - o.gazeDrop, z: g.z };

    const steerYaw = yawTo(pos, steer);
    const headErr = angleDiff(steerYaw, this.yaw);
    const absErr = Math.abs(headErr);

    let speed = 0;
    let moveYaw;
    if (step?.backpedal) {
      // Stepping back to line up again: keep facing the step, walk backwards, slowly.
      const faceYaw = yawTo(pos, step.face);
      this._setSprint(false);
      return { gaze: { ...step.face, y: step.face.y + EYE_HEIGHT - o.gazeDrop }, move: { yaw: steerYaw, speed: 0.5 }, headYaw: faceYaw };
    }
    if (this.focus) {
      // Combat footwork: head stays on the target, feet go wherever the path says (strafe, backpedal).
      speed = 1;
      moveYaw = steerYaw;
    } else {
      const turnLimit = it.urgent ? 120 : o.turnInPlaceDeg;
      if (absErr < turnLimit) {
        speed = clamp(Math.cos(headErr * DEG), it.urgent ? 0.6 : 0.3, 1);
        const dEnd = dist2D(pos, final);
        if (it.idx === last) speed *= clamp(dEnd / 1.5, 0.35, 1);
      }
      moveYaw = this.yaw + clamp(headErr, -o.maxStrafeDeg, o.maxStrafeDeg);
    }

    // Sprint on long, straight, level stretches, with hysteresis. When fleeing or chasing, sprint whenever roughly facing the way.
    const levelAhead = this._levelAhead(pos, it, 4);
    const moveErr = Math.abs(angleDiff(moveYaw, this.yaw));
    if (leap?.sprint) this._setSprint(true); // a 2-3 block gap: a sprint-jump
    else if (leap || it.walk) this._setSprint(false); // a walking jump clears one block and can't overshoot the landing
    else if (it.urgent) this._setSprint(remaining > 2 && moveErr < 45);
    else if (!this.sprinting && remaining > o.sprintMinRemaining && absErr < 12 && levelAhead) this._setSprint(true);
    else if (this.sprinting && (remaining < 3 || absErr > 25 || !levelAhead)) this._setSprint(false);

    // Jump for step-ups, only when lined up with the step block: a body half over the block
    // beside it (a 2-high wall next to the 1-high step) would jump into the seam forever.
    const next = wps[it.idx];
    const inWater = !!this.body.isInWater?.();
    const canJump = this.body.isOnGround() || inWater;
    const lined = !step || inWater || step.aligned;
    if (leap?.jump && this.body.isOnGround() && this.jumpCooldown === 0) {
      this.body.jump();
      this.jumpCooldown = 8;
    }
    if (next.y > pos.y + 0.5 && dist2D(pos, next) < 1.35 && canJump && lined && this.jumpCooldown === 0 && (!next.stair || it.stairStall > 12)) {
      this.body.jump();
      this.jumpCooldown = 8;
      if (step) it.stepJumps = (it.stepJumps ?? 0) + 1;
    }

    // Head yaw follows the steering direction, leaning up to 15 deg toward the gaze point.
    // (Following the gaze alone can deadlock at corners: head looks ahead, feet need to turn.)
    const headYaw = steerYaw + clamp(angleDiff(yawTo(pos, gaze), steerYaw), -15, 15);

    return { gaze, move: { yaw: moveYaw, speed }, headYaw };
  }

  /**
   * Leaping a gap (waypoint marked `leap`, two blocks on from the last): run straight along the
   * line through both blocks' centres and jump at the edge (the edge is 1.5 before the landing
   * centre; the box still has a foothold until ~1.2). Not lined up by the edge: back up and line
   * up again rather than walk off. 'fell' if we ended up down in the gap.
   */
  _leap(pos, it) {
    const wps = it.wps;
    const next = wps[it.idx], prev = wps[it.idx - 1];
    if (!next?.leap || !prev) { this._air = null; return null; }
    const gap = typeof next.leap === 'number' ? next.leap : 1;
    const onGround = this.body.isOnGround();
    // Down in the gap (below both the take-off and the landing): fell. (Before the jump, a leap up
    // a level has us a block under the landing: that's the take-off, not a fall.)
    if (onGround && pos.y < Math.min(prev.y, next.y) - 0.5) return 'fell';
    let dx = next.x - prev.x, dz = next.z - prev.z;
    if (Math.abs(dx) >= Math.abs(dz)) { dx = Math.sign(dx); dz = 0; } else { dz = Math.sign(dz); dx = 0; }
    const rx = pos.x - next.x, rz = pos.z - next.z;
    const along = rx * dx + rz * dz;
    const lateral = -rx * dz + rz * dx;
    const at = (a) => ({ x: next.x + dx * a, y: pos.y, z: next.z + dz * a });
    // Walk or sprint: the slowest that makes it (core/jump.js). A sprint-jump onto a pillar a level
    // down just goes over it.
    const dyLand = Math.round(next.y - prev.y);
    const sprint = gaitFor(gap, dyLand) === 'sprint';
    // In the air: forward, nothing or back, whichever brings us down nearest the landing block's
    // middle (a touch short of it: what's left of the speed carries us on after), and sideways
    // back onto the line. The way a player steers a jump.
    const last = this._air;
    this._air = { x: pos.x, y: pos.y, z: pos.z };
    if (!onGround) {
      if (!last) return { steer: at(0.6), jump: false, sprint };
      const v = (pos.x - last.x) * dx + (pos.z - last.z) * dz;
      const vy = pos.y - last.y;
      const landDy = next.y - pos.y;
      const want = -along - 0.15; // (how far on the landing point is)
      let best = null;
      for (const hold of [1, 0, -1]) {
        const d = landingAlong(v, vy, landDy, hold, this.sprinting);
        if (d === null) continue;
        const miss = Math.abs(d - want);
        if (!best || miss < best.miss - 0.02) best = { hold, miss };
      }
      const hold = best ? best.hold : 1;
      // Sideways: back toward the line through the landing block's middle.
      const side = clamp(-lateral * 2, -1, 1);
      const mx = dx * hold - dz * side, mz = dz * hold + dx * side;
      const len = Math.hypot(mx, mz);
      return { air: true, sprint, move: len < 0.05 ? null : { yaw: yawTo({ x: 0, z: 0 }, { x: mx, z: mz }), speed: Math.min(1, len) }, face: at(0.6) };
    }
    // The take-off edge is gap + 0.5 before the landing block's centre; the box keeps a foothold
    // ~0.3 past it.
    const edge = -(gap + 0.5);
    if (along > edge + 0.4) return { steer: at(0.6), jump: false, sprint }; // across (landed): carry on
    const aligned = Math.abs(lateral) < (next.narrow ? 0.08 : 0.25) && Math.abs(angleDiff(this.yaw, yawTo(pos, at(0)))) < 25;
    if (!aligned && along > edge - 0.3) {
      // Too close to the edge to fix it on the move: stop, turn to face the jump and shuffle
      // sideways onto the line where we stand (on a pillar there's nowhere to back off to).
      const side = Math.abs(lateral) < (next.narrow ? 0.04 : 0.1) ? 0 : clamp(-lateral * 3, -1, 1);
      const mx = -dz * side, mz = dx * side;
      return { lineup: true, sprint: false, move: side ? { yaw: yawTo({ x: 0, z: 0 }, { x: mx, z: mz }), speed: Math.min(0.4, Math.abs(side)) } : null, face: at(0.6) };
    }
    // At the edge: jump if the speed we have carries it (core/jump.js reachFrom); if not (we came
    // round a turn, or lined up standing still), back to the far side of the take-off block and
    // run at it: a block's run is most of a sprint's speed.
    const v = last ? (pos.x - last.x) * dx + (pos.z - last.z) * dz : 0;
    const enough = reachFrom(v, sprint ? 'sprint' : 'walk', dyLand) >= gap + 0.1;
    if (it.leapBack === it.idx) {
      if (along > edge - 0.7) return { lineup: true, sprint: false, move: { yaw: yawTo(pos, at(edge - 0.75)), speed: 0.6 }, face: at(0.6) };
      it.leapBack = null;
    }
    if (aligned && along > edge - 0.05 && !enough && it.leapBack !== -it.idx) {
      it.leapBack = it.idx; // (once: a second go at it jumps from whatever speed it's got)
      return { lineup: true, sprint: false, move: null, face: at(0.6) };
    }
    if (it.leapBack === null && along <= edge - 0.6) it.leapBack = -it.idx;
    return { steer: at(Math.min(along + 1.2, 0.6)), jump: aligned && along > edge - 0.05, sprint };
  }

  /**
   * Going up a step: follow the straight line through the step block along the step's direction
   * (steps are always cardinal), so the body arrives square on the block instead of cutting the
   * corner. aligned = centred enough (body edge inside the step column) and heading along it.
   * After a few jumps that didn't get us up, back off a pace and line up again.
   */
  _stepUp(pos, it) {
    const wps = it.wps;
    const next = wps[it.idx], prev = wps[it.idx - 1];
    const up = pos.y >= next.y - 0.2 && this.body.isOnGround();
    // Jumps are counted per step: a staircase is one step-up after another, and carrying the count
    // over made every third stair look like a failed one (turn round, walk back, turn round again).
    if (it.stepIdx !== it.idx) { it.stepIdx = it.idx; it.stepJumps = 0; it.backoff = 0; }
    if (!prev || up || !(next.y > prev.y + 0.5) || dist2D(prev, next) < 0.5) {
      it.stepJumps = 0;
      it.backoff = 0;
      return null;
    }
    let dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return null;
    // Snap to the dominant axis: a step up is always a move to an adjacent (cardinal) block.
    if (Math.abs(dx) >= Math.abs(dz)) { dx = Math.sign(dx); dz = 0; } else { dz = Math.sign(dz); dx = 0; }
    const rx = pos.x - next.x, rz = pos.z - next.z;
    const along = rx * dx + rz * dz;      // < 0 before the step
    const lateral = -rx * dz + rz * dx;   // sideways offset from the line through the step's centre
    const at = (a) => ({ x: next.x + dx * a, y: pos.y, z: next.z + dz * a });
    if ((it.stepJumps ?? 0) >= 3 && !it.backoff) { it.backoff = 10; it.stepJumps = 0; }
    if (it.backoff > 0) {
      // Back off like a player does: step backwards facing the step (S key), never turn round.
      it.backoff--;
      return { steer: at(-1.6), aligned: false, backpedal: true, face: at(0.5) };
    }
    const lead = clamp(-along, 0.6, 1.2);
    const heading = Math.abs(angleDiff(this.lastOutput.moveYaw ?? this.yaw, yawTo(pos, at(0.5))));
    // Aim past the step's centre only if the path carries straight on: where it turns (onto a
    // 1-wide bridge, along a cliff edge) the jump's carry would take us over the side.
    const after = wps[it.idx + 1];
    const straightOn = !next.tight && (!after || (after.x - next.x) * dx + (after.z - next.z) * dz > 0.95 * Math.hypot(after.x - next.x, after.z - next.z));
    return {
      steer: at(Math.min(along + lead, straightOn ? 0.5 : 0)),
      aligned: Math.abs(lateral) < 0.18 && (heading < 35 || along > -0.95),
    };
  }

  _reached(pos, wps, i) {
    const w = wps[i];
    const prev = wps[i - 1];
    // A step up counts only once we're standing up there, not while jumping past its edge.
    // (Horizontal steps only: ladder and pillar waypoints sit straight above the last one.)
    // A gap leap counts once we've landed on the far side.
    if (w.leap) return pos.y >= w.y - 0.2 && this.body.isOnGround() && dist2D(pos, w) < 1.0;
    // On a stair's low half or a slab we stand half a block under the waypoint's level.
    if (w.stair) return pos.y >= w.y - 0.6 && this.body.isOnGround() && dist2D(pos, w) < 1.0;
    if (prev && w.y > prev.y + 0.5 && dist2D(prev, w) > 0.5) return pos.y >= w.y - 0.2 && this.body.isOnGround() && dist2D(pos, w) < 1.0;
    if (Math.abs(pos.y - w.y) > 0.9) return false;
    // A tight one (beside a drop, a corner round a trunk): get onto it before turning for the next.
    if (dist2D(pos, w) < (w.tight ? 0.3 : this.o.waypointRadius)) return true;
    // Passed it: projection onto segment (prev -> w) is beyond the end.
    const p = wps[i - 1] || w;
    const sx = w.x - p.x, sz = w.z - p.z;
    const len2 = sx * sx + sz * sz;
    if (len2 < 1e-6) return false;
    const t = ((pos.x - p.x) * sx + (pos.z - p.z) * sz) / len2;
    return t >= 1 && dist2D(pos, w) < (w.tight ? 0.5 : 1.2);
  }

  /** Point `dist` blocks ahead along the path. Stops at the next height change so jumps are lined up. */
  _lookahead(pos, it, dist) {
    const wps = it.wps;
    let cur = { x: pos.x, y: wps[it.idx].y, z: pos.z };
    let rem = dist;
    for (let k = it.idx; k < wps.length; k++) {
      const w = wps[k];
      const d = dist2D(cur, w);
      if (d >= rem) {
        const t = rem / d;
        return { x: cur.x + (w.x - cur.x) * t, y: w.y, z: cur.z + (w.z - cur.z) * t };
      }
      rem -= d;
      const before = cur;
      cur = w;
      const nxt = wps[k + 1];
      if (nxt && nxt.y !== w.y && Math.abs(pos.y - w.y) > 0.5) break;
      // A waypoint off our level (a drop down) or a hairpin (round a tree, a leaf at head height):
      // steer at it, not across the corner. Cutting it aimed the body straight into what the path
      // went round, and it walked into that forever.
      if (nxt && (Math.abs(pos.y - w.y) > 0.5 || w.tight)) break;
      if (nxt) {
        const ax = w.x - before.x, az = w.z - before.z, bx = nxt.x - w.x, bz = nxt.z - w.z;
        const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
        if (la > 1e-6 && lb > 1e-6 && (ax * bx + az * bz) / (la * lb) < 0.2) break; // turns > ~80 deg
      }
    }
    return cur;
  }

  _remaining(pos, it) {
    const wps = it.wps;
    let r = dist2D(pos, wps[it.idx]) + Math.abs(pos.y - wps[it.idx].y);
    for (let k = it.idx; k < wps.length - 1; k++) {
      r += dist2D(wps[k], wps[k + 1]) + Math.abs(wps[k].y - wps[k + 1].y);
    }
    return r;
  }

  _levelAhead(pos, it, dist) {
    const wps = it.wps;
    let acc = dist2D(pos, wps[it.idx]);
    if (Math.abs(wps[it.idx].y - pos.y) > 0.5) return false;
    for (let k = it.idx; k < wps.length - 1 && acc < dist; k++) {
      if (wps[k + 1].y !== wps[k].y) return false;
      acc += dist2D(wps[k], wps[k + 1]);
    }
    return true;
  }
}
