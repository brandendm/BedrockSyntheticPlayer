// Shooting a bow the way the bow test showed it can be done: the view is set exactly (lookAtLocation) at the angle the arrow's own drop
// needs (core/ballistics.js), aimed ahead of a moving target, and HELD there by the motor's focus through the draw, release and flight
// (left to itself the motor's idle head drift moved it 20 to 30 degrees over a draw).
import { system } from '@minecraft/server';
import { container, hold, invCounts } from './inventory.js';
import { solvePitch } from '../core/ballistics.js';


/** The aim step shared by the bow and the crossbow: the view set at the pitch the drop needs, ahead of a moving target. */
function makeAim(agent, target, speed) {
  const sim = agent.sim;
  return () => {
    const eye = sim.getHeadLocation();
    let tgt;
    try {
      const head = target.getHeadLocation(), v = target.getVelocity();
      const flight = Math.hypot(head.x - eye.x, head.z - eye.z) / speed;
      tgt = { x: head.x + v.x * flight, y: head.y - 0.3 + v.y * flight * 0.5, z: head.z + v.z * flight };
    } catch { tgt = { ...target.location, y: target.location.y + 1 }; }
    const dx = tgt.x - eye.x, dz = tgt.z - eye.z, d = Math.hypot(dx, dz) || 1;
    const th = solvePitch(d, tgt.y - eye.y);
    const pt = { x: eye.x + (dx / d) * 30 * Math.cos(th), y: eye.y + 30 * Math.sin(th), z: eye.z + (dz / d) * 30 * Math.cos(th) };
    /** @type {any} */ (sim).lookAtLocation(pt);
    agent.motor.setFocus(pt);
  };
}

/**
 * One crossbow bolt: hold use until it is loaded (about 1.25 s; the view kept on the target meanwhile), let go, then use again to fire it. Returns true if the second use was made
 * (not checked against the game: a bolt that did not load is a use wasted). Same options as shootAt.
 */
export async function shootCrossbow(agent, target, { strafe = null, stop = () => false, speed = 3.1 } = {}) {
  const sim = agent.sim;
  if (!invCounts(sim).arrow || !invCounts(sim).crossbow) return false;
  hold(sim, 'crossbow');
  try {
    const aim = makeAim(agent, target, speed);
    aim();
    await system.waitTicks(2);
    const item = container(sim)?.getItem(sim.selectedSlotIndex);
    try { /** @type {any} */ (sim).useItem(item); } catch { return false; }
    for (let k = 0; k < 14 && !stop(); k++) {
      try { aim(); } catch { break; }
      if (strafe) agent.body.move(strafe.x, strafe.z, 0.5);
      await system.waitTicks(2);
    }
    try { /** @type {any} */ (sim).stopUsingItem(); } catch { /* */ }
    await system.waitTicks(2);
    if (stop()) return false;
    try { aim(); } catch { /* */ }
    await system.waitTicks(2);
    try { /** @type {any} */ (sim).useItem(container(sim)?.getItem(sim.selectedSlotIndex)); } catch { return false; }
    await system.waitTicks(2);
    try { /** @type {any} */ (sim).stopUsingItem(); } catch { /* */ }
    return true;
  } finally { agent.motor.setFocus(null); }
}

/**
 * One shot at an entity. `strafe`: sidestep while drawing (x, z of a unit vector, or null). Returns true if an arrow was loosed.
 * @param {any} agent
 * @param {import('@minecraft/server').Entity} target
 * @param {{ strafe?: {x:number,z:number}|null, stop?: () => boolean, speed?: number }} [opts]
 */
export async function shootAt(agent, target, { strafe = null, stop = () => false, speed = 2.8 } = {}) {
  const sim = agent.sim;
  if (!invCounts(sim).arrow || !invCounts(sim).bow) return false;
  hold(sim, 'bow');
  try {
    // Aimed again every two ticks through the whole draw, not once at the start: a draw is 1.4 s, and a player who strafes is a metre or
    // more from where they were when the draw began (the duel: 40 s of arrows, none landed).
    const aim = makeAim(agent, target, speed);
    aim();
    await system.waitTicks(4);
    const item = container(sim)?.getItem(sim.selectedSlotIndex);
    try { /** @type {any} */ (sim).useItem(item); } catch { return false; }
    for (let k = 0; k < 11 && !stop(); k++) {
      try { aim(); } catch { break; }
      if (strafe) agent.body.move(strafe.x, strafe.z, 0.5);
      await system.waitTicks(2);
    }
    try { aim(); } catch { /* */ }
    try { /** @type {any} */ (sim).stopUsingItem(); } catch { /* */ }
    await system.waitTicks(2);
    return true;
  } finally { agent.motor.setFocus(null); }
}
