// Gliding with elytra (the elytra test): off a tower, wings open in the air, steered by where the view points (the nose down gains speed, up
// trades it for height). The pitch each tick is core/glide.js planGlide's: as steep a dive as still lets the pull-out end on the landing spot
// with the sink at the ground small, bending up just enough to land on it.
//
// The u204 run: 8.6 s against the owner's 4. The pitch in its trace was 0 for the whole glide: the view was set with lookAtLocation, and the idle
// camera (core/motor.js, a wandering gaze roughly level) wrote it again every tick, so it flew level, overshot, turned back and sank the last 8
// blocks. The view is now the motor's own focus, and the motor's spring is made stiffer for the flight so that the view follows the command in
// a tenth of a second or two instead of half a second. Whether a simulated player can open the wings at all was never in doubt after u186
// (`glide()` works); how soon after the jump is what the report will show.
import { system } from '@minecraft/server';
import { trace } from './bridge.js';
import { planGlide } from '../core/glide.js';

/**
 * Fly from where the bot stands (the top of a tower, facing the landing) to `pad` (its block: feet land at pad.y + 1).
 * ctx: { gy, landed(), flatD(), hp() }. Returns { glided, glideS, peak (blocks/s), rockets, why, saved, openedS (seconds from the start to the wings
 * opening), pitchMax, sinkAtLand (blocks/s) }.
 */
export async function flyElytra(agent, pad, ctx) {
  const sim = /** @type {any} */ (agent.sim), motor = agent.motor, S = agent.skills;
  const gen = agent.newTask({ kind: 'test' });
  const out = { glided: false, glideS: 0, peak: 0, rockets: 0, why: '', saved: false, openedS: 0, pitchMax: 0, sinkAtLand: 0 };
  const gliding = () => { try { return !!sim.isGliding; } catch { return false; } };
  const mo = motor.o, keep = { omega: mo.omega, maxPitchSpeed: mo.maxPitchSpeed };
  mo.omega = 16; mo.maxPitchSpeed = 700;
  let dirX = 1, dirZ = 0;
  // The view: toward the pad on the ground plane, the nose `pitchDeg` below the horizon (negative: above). Held by the motor each tick.
  const view = (pitchDeg) => {
    const p = sim.location, dx = pad.x - p.x, dz = pad.z - p.z, len = Math.hypot(dx, dz);
    if (len > 2.5) { dirX = dx / len; dirZ = dz / len; }     // (over the spot the way on is the way it was)
    motor.setFocus({ x: p.x + dirX * 20, y: p.y + 1.62 - Math.tan((pitchDeg * Math.PI) / 180) * 20, z: p.z + dirZ * 20 });
  };
  view(0);
  const t0 = system.currentTick;
  let seen = '', tries = 0, lastTry = -99, jumpedAt = -99, airborne = false, glideT0 = 0, last = { ...sim.location }, lastTrace = -99, plan = null;
  const level = pad.y + 1;
  try {
    for (let tick = 0; tick < 20 * 45; tick++) {
      S.check(gen);
      const now = system.currentTick, p = sim.location, onGround = !!sim.isOnGround;
      if (!airborne && !onGround) airborne = true;
      if (airborne && onGround && now - t0 > 20) break;
      const vel = (() => { try { return sim.getVelocity(); } catch { return null; } })() ?? { x: p.x - last.x, y: p.y - last.y, z: p.z - last.z };
      const speed = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) * 20;
      last = { ...p };
      if (!airborne) {
        // Off the edge at once (no pause: the u204 bot stood 1 s before it moved), a jump at the lip for the height, as the owner did.
        view(0);
        try { sim.moveToLocation({ x: pad.x, y: p.y, z: pad.z }, { speed: 1 }); } catch { /* */ }
        const ahead = S.blockAt({ x: Math.floor(p.x + dirX * 0.9), y: Math.floor(p.y) - 1, z: Math.floor(p.z + dirZ * 0.9) }) ?? 'air';
        if (onGround && now - jumpedAt > 10 && /^(air|cave_air)$/.test(ahead)) { try { sim.jump(); jumpedAt = now; } catch { /* */ } }
      } else if (!gliding()) {
        // In the air with the wings shut: the simulated player's own glide() (a player's second jump) as soon as it is off the ground, a jump in the air if refused.
        view(8);
        if (now - lastTry >= 2 && tries < 20 && now - jumpedAt >= 4) {
          try { const r = sim.glide(); seen = `glide() gave ${r}`; } catch (e) { seen = `glide() threw ${e}`; }
          if (tries >= 6 && tries % 2 === 0) { try { sim.jump(); } catch { /* */ } }
          tries++; lastTry = now;
        }
        // The fall would kill from here: slow falling (the test goes on, and says so).
        if (p.y < ctx.gy + 9 && !out.saved && tries >= 3) { try { sim.runCommand('effect @s slow_falling 8 0 true'); } catch { /* */ } out.saved = true; }
        if (tries >= 20 && !out.why) out.why = `${tries} tries in the air, isGliding stayed false (${seen})`;
      } else {
        if (!out.glided) { out.glided = true; glideT0 = now; out.openedS = (now - t0) / 20; trace(`elytra: wings open ${out.openedS.toFixed(2)} s after the start (${tries} tries), ${(p.y - level).toFixed(1)} above the landing, ${(Math.hypot(pad.x - p.x, pad.z - p.z)).toFixed(1)} from it`); }
        out.peak = Math.max(out.peak, speed);
        // The state along the way to the spot: speed toward it, sink, height over the landing, distance.
        const dx = pad.x - p.x, dz = pad.z - p.z, d = Math.hypot(dx, dz) || 1;
        const vx = (vel.x * dx + vel.z * dz) / d, vy = vel.y;
        plan = planGlide({ h: p.y - level, d, vx, vy }, { aim: 0, lag: 3, dive: 40, vyTd: 0.25 });
        view(plan.pitch);
        out.pitchMax = Math.max(out.pitchMax, plan.pitch);
        out.sinkAtLand = Math.max(out.sinkAtLand, -vy * 20);
        if (now - lastTrace >= 5) {
          lastTrace = now;
          let pitchNow = NaN; try { pitchNow = sim.getRotation().x; } catch { /* */ }
          trace(`elytra: t${((now - t0) / 20).toFixed(2)} h${(p.y - level).toFixed(1)} d${d.toFixed(1)} v${(vx * 20).toFixed(1)}/${(vy * 20).toFixed(1)} b/s ${plan.mode} cmd${plan.pitch.toFixed(0)} view${pitchNow.toFixed(0)} lands ${plan.land.toFixed(1)} sink ${(-plan.vyTd * 20).toFixed(1)}`);
        }
      }
      await S.wait(gen, 1);
      if (ctx.hp() <= 0) break;
    }
  } finally {
    motor.setFocus(null);
    mo.omega = keep.omega; mo.maxPitchSpeed = keep.maxPitchSpeed;
  }
  if (!out.glided && !out.why) out.why = `${tries} tries, isGliding stayed false (${seen || 'never in the air to try'})`;
  out.glideS = out.glided ? (system.currentTick - glideT0) / 20 : 0;
  // Landed (or out of time): the wings shut again, and the view level, so it is not left in the gliding state (the u186 run left the character looking bugged).
  try { sim.stopMoving(); } catch { /* */ }
  try { sim.stopGliding(); } catch { /* */ }
  try { sim.runCommand('effect @s clear'); } catch { /* */ }
  await S.wait(gen, 4);
  try { sim.stopGliding(); } catch { /* */ }
  try { sim.lookAtLocation({ x: sim.location.x + 5, y: sim.location.y + 1.62, z: sim.location.z }); } catch { /* */ }
  return out;
}
