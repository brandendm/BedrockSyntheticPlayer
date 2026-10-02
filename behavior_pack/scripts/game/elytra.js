// Gliding with elytra (the elytra test): off a tower, wings open with a jump in the air, steered by where the view points (the nose
// down gains speed, up trades it for height), a firework for a boost when it sinks below the line to the landing, and a flare at the end.
// Whether a simulated player can open the wings at all is not known: it tries a jump in the air, and what it saw is reported.
import { system } from '@minecraft/server';
import { hold, container } from './inventory.js';

/**
 * Fly from where the bot stands (the top of a tower, facing the landing) to `pad`. ctx: { gy, landed(), flatD() }.
 * Returns { glided, glideS, peak (blocks/s), rockets, why, saved }.
 */
export async function flyElytra(agent, pad, ctx) {
  const sim = /** @type {any} */ (agent.sim);
  const gen = agent.newTask({ kind: 'test' });
  const out = { glided: false, glideS: 0, peak: 0, rockets: 0, why: '', saved: false };
  const gliding = () => { try { return !!sim.isGliding; } catch { return false; } };
  const aimAt = (pitchDeg) => {
    // The view: toward the pad on the ground plane, the nose `pitchDeg` below the horizon (negative: above).
    const p = sim.location, dx = pad.x - p.x, dz = pad.z - p.z, len = Math.hypot(dx, dz) || 1;
    try { sim.lookAtLocation({ x: p.x + (dx / len) * 20, y: p.y + 1.62 - Math.tan((pitchDeg * Math.PI) / 180) * 20, z: p.z + (dz / len) * 20 }); } catch { /* */ }
  };
  aimAt(0);
  await system.waitTicks(5);
  // Off the edge: walk toward the pad.
  const x0 = sim.location.x;
  let seen = '', tries = 0, lastTry = -99, lastY = sim.location.y, rocketAt = -99, airborne = false, glideT0 = 0, last = { ...sim.location };
  const t0 = system.currentTick;
  for (let tick = 0; tick < 20 * 45; tick++) {
    const now = system.currentTick, p = sim.location, onGround = !!sim.isOnGround;
    if (!airborne && !onGround) airborne = true;
    if (airborne && onGround && now - t0 > 20) break;
    const vy = p.y - lastY; lastY = p.y;
    const speed = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) * 20; last = { ...p };
    if (!airborne) {
      try { sim.moveToLocation({ x: pad.x, y: p.y, z: pad.z }, { speed: 1 }); } catch { /* */ }
    } else if (!gliding()) {
      // Falling and the wings shut: the simulated player's own glide() (a player's second jump), a jump in the air if that is refused.
      if (vy < -0.2 && now - lastTry > 3 && tries < 14) {
        try { const r = sim.glide(); seen = `glide() gave ${r}`; } catch (e) { seen = `glide() threw ${e}`; }
        if (tries >= 4 && tries % 2 === 0) { try { sim.jump(); } catch { /* */ } }
        tries++; lastTry = now;
      }
      // The fall would kill from here: slow falling (the test goes on, and says so).
      if (p.y < ctx.gy + 9 && !out.saved && tries >= 3) { try { sim.runCommand('effect @s slow_falling 8 0 true'); } catch { /* */ } out.saved = true; }
      if (tries >= 14 && !out.why) out.why = `${tries} tries in the air, isGliding stayed false (${seen})`;
    } else {
      if (!out.glided) { out.glided = true; glideT0 = now; }
      out.peak = Math.max(out.peak, speed);
      const D = ctx.flatD(), des = ctx.gy + 1.5 + D * 0.2;
      let pitch = 10;                                  // a shallow glide
      if (D < 9) pitch = p.y > ctx.gy + 3 ? 12 : -22;  // a flare near the ground, to land on its feet
      else if (p.y > des + 2) pitch = 28;              // too high: nose down (faster, further)
      else if (p.y < des - 2) pitch = -12;             // too low: nose up
      if (speed < 9 && D >= 9) pitch = Math.max(pitch, 20);   // slow: nose down to pick up speed
      aimAt(pitch);
      // A firework when it is sinking under the line and has some way to go.
      if (p.y < des - 4 && D > 14 && now - rocketAt > 50 && out.rockets < 6) {
        const prev = sim.selectedSlotIndex;
        if (hold(sim, 'firework_rocket') >= 0) { try { sim.useItem(container(sim)?.getItem(sim.selectedSlotIndex)); out.rockets++; rocketAt = now; } catch { /* */ } }
        try { sim.selectedSlotIndex = prev; } catch { /* */ }
      }
    }
    await agent.skills.wait(gen, 1);
    if (ctx.hp() <= 0) break;
  }
  if (!out.glided && !out.why) out.why = `${tries} tries, isGliding stayed false (${seen || 'never fell fast enough to try'})`;
  out.glideS = out.glided ? (system.currentTick - glideT0) / 20 : 0;
  // Landed (or out of time): the wings shut again, and the view level, so it is not left in the gliding state (the u186 run left the character looking bugged).
  try { sim.stopMoving(); } catch { /* */ }
  try { sim.stopGliding(); } catch { /* */ }
  try { sim.runCommand('effect @s clear'); } catch { /* */ }
  await agent.skills.wait(gen, 4);
  try { sim.stopGliding(); } catch { /* */ }
  try { sim.lookAtLocation({ x: sim.location.x + 5, y: sim.location.y + 1.62, z: sim.location.z }); } catch { /* */ }
  void x0;
  return out;
}
