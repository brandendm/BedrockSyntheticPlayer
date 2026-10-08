// Extra bots ("workers") that run tests alongside the main one, each its own Agent in its own simulated player. main.js ticks and respawns them (everyone()), game/scenarios.js
// hires them for a batch (`!bot test all workers 4`) and sends them home when it ends. They share the main bot's memory (one world, one set of saved notes) and do not run any
// autonomous job of their own, restore a kit, or answer chat.
import { CONFIG } from '../config.js';

export const crew = { members: [], factory: null };
/** main.js registers how to make one: (name, where, primaryAgent) -> Agent. */
export const setCrewFactory = (f) => { crew.factory = f; };
/** The main bot and everyone hired. */
export const everyone = (primary) => [primary, ...crew.members].filter(Boolean);
export const isCrewId = (id) => crew.members.some((a) => a.sim?.id === id);
export const isCrewName = (name) => crew.members.some((a) => a.sim?.name === name);
export const MAX_WORKERS = 6;

/** Make `n` bots in all (the main one counts): returns [primary, ...the hired]. Anything that fails to spawn is left out. */
export async function hire(primary, n, near, system) {
  const want = Math.max(1, Math.min(MAX_WORKERS, Math.floor(n)));
  const got = [primary];
  for (let i = 1; i < want && crew.factory; i++) {
    const name = `${CONFIG.botName}${i + 1}`;
    try {
      let w = crew.members.find((a) => a.sim?.name === name && a.sim.isValid);
      if (!w) {
        w = crew.factory(name, { dimension: primary.dim, x: near.x + 1.5 * i, y: near.y, z: near.z + 1.5 }, primary);
        crew.members.push(w);
        await system.waitTicks(5);
      }
      w.autoEnabled = false;
      got.push(w);
    } catch (e) { console.warn(`[crew] could not hire ${name}: ${e}`); }
  }
  return got;
}

/** Send every hired bot home (disconnect), forget them. */
export function dismissAll() {
  for (const w of crew.members) { try { w.newTask(null); w.motor.stop(); } catch { /* */ } try { w.sim.disconnect(); } catch { try { w.sim.dimension.runCommand(`kick "${w.sim.name}"`); } catch { /* */ } } }
  crew.members.length = 0;
}
