// Test aids for the iron farm (`!bot ironfarm time | speed | golem`). The farm only produces after 1/700-a-tick spawn rolls (about a golem in
// 35 seconds at best, and the first few minutes may be spent waiting for the villagers to count as working), so to try it out:
//   - time: set the time of day, or run it faster (the villagers' day: working, sleeping, "worked yesterday"). Done by moving the world clock
//     on every tick, so it speeds up the clock and what runs off it. It does NOT speed up the game: Bedrock has no /tick command (Java only),
//     and a pack cannot make the game run more ticks, so water, hoppers and the spawn rolls themselves run at the normal rate.
//   - speed: the gamerule randomtickspeed x N (random ticks only: crops, leaves, fire; not the spawn roll), then the game's own
//     `tick rate` command if this version has one, else the clock; and says what each did.
//   - golem: puts iron golems on the platform at once (or one every few seconds), so the water, the hole, the campfires, the hoppers and
//     the chest can be watched working without waiting for the game to spawn one. Those are made by the pack, not by the village: they say nothing
//     about the spawn rate.
import { system, world } from '@minecraft/server';
import { PLATFORM, CORNERS, HOLE, HOLE_CENTRE, WATER_Y } from '../core/ironfarm.js';
import { say, run, W } from './ironfarm_world.js';

/** Bedrock's time-of-day numbers (ticks into the 24000-tick day). */
export const TIMES = { sunrise: 23000, day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000 };

let fast = null;
export const fastTime = () => fast?.mult ?? 1;

export function stopFast() {
  if (fast) { try { system.clearRun(fast.id); } catch { /* */ } fast = null; }
}

function startFast(dim, mult) {
  stopFast();
  const step = mult - 1;
  const id = system.runInterval(() => {
    try {
      if (typeof world.setAbsoluteTime === 'function') world.setAbsoluteTime(world.getAbsoluteTime() + step);
      else dim.runCommand(`time add ${step}`);
    } catch { /* */ }
  }, 1);
  fast = { id, mult };
}

const clock = () => { try { return `day ${Math.floor(world.getAbsoluteTime() / 24000)}, ${world.getTimeOfDay()} of 24000`; } catch { return ''; } };

/** `time day|night|noon|midnight|sunrise|sunset | set N | add N | fast N | normal` */
export function timeCommand(dim, args) {
  const a = (args[0] ?? '').toLowerCase();
  if (a in TIMES) {
    const why = run(dim, `time set ${TIMES[a]}`);
    return say(why ? `Could not set the time: ${why}` : `Time set to ${a} (${TIMES[a]}). Now ${clock()}.`);
  }
  if (a === 'set' || a === 'add') {
    const n = Math.floor(Number(args[1]));
    if (!Number.isFinite(n)) return say('Say a number of ticks: "time set 6000".');
    const why = run(dim, `time ${a} ${n}`);
    return say(why ? `Could not: ${why}` : `Time ${a} ${n}. Now ${clock()}.`);
  }
  if (a === 'fast' || a === 'speed') {
    const n = Math.max(2, Math.min(200, Math.floor(Number(args[1] ?? 20)) || 20));
    startFast(dim, n);
    return say(`The clock now runs x${n} (a whole day in ${(1200 / n).toFixed(1)} s). Villagers' days and nights go by x${n}; water, hoppers and the golem spawn rolls do NOT (a pack cannot run the game faster). "time normal" stops it. Now ${clock()}.`);
  }
  if (a === 'normal' || a === 'stop' || a === 'off') { stopFast(); return say(`Clock back to normal. Now ${clock()}.`); }
  say(`Time: now ${clock()}${fast ? `, running x${fast.mult}` : ''}. Commands: time day|night|noon|midnight|sunrise|sunset, time set N, time add N, time fast N (clock x N), time normal.`);
}

let savedRts = null;
const randomTickSpeed = () => { try { return world.gameRules?.randomTickSpeed ?? null; } catch { return null; } };

/**
 * `speed N | normal`. Three things, each reported: (1) the gamerule randomtickspeed x N (Bedrock's is 1): crops, leaves, grass and fire; it is NOT the game's tick rate and does not touch the golem spawn roll, the water, the hoppers or the villagers' days;
 * (2) the game's own `tick rate`, in case this version has the command (Java does; I know of none in Bedrock); (3) if (2) is refused, the clock x N.
 */
export function speedCommand(dim, args) {
  const a = (args[0] ?? '').toLowerCase();
  if (a === 'normal' || a === 'off' || a === 'stop') {
    const back = savedRts ?? 1;
    const g = run(dim, `gamerule randomtickspeed ${back}`);
    const why = run(dim, 'tick rate 20');
    stopFast();
    savedRts = null;
    return say(`Speed back to normal: random ticks ${g ? `(the gamerule: ${g})` : `x1 (randomtickspeed ${back})`}, the clock normal${why ? '' : ', tick rate 20'}.`);
  }
  const n = Math.max(1, Math.min(100, Math.floor(Number(a)) || 0));
  if (!n) return say('Say how many times faster: "speed 5", or "speed normal".');
  if (savedRts === null) savedRts = randomTickSpeed();
  const parts = [];
  const g = run(dim, `gamerule randomtickspeed ${n}`);
  parts.push(g ? `Random ticks: the game would not take the gamerule (${g}).` : `Random ticks x${n} (gamerule randomtickspeed ${n}; it was ${savedRts ?? 1}): crops, leaves, grass and fire. It is NOT the tick rate: the golem spawn roll, water, hoppers and the villagers' days are not on it.`);
  const why = run(dim, `tick rate ${20 * n}`);
  if (!why) { stopFast(); parts.push(`Game speed x${n}: tick rate ${20 * n}.`); }
  else {
    startFast(dim, Math.max(2, n));
    parts.push(`The game would not take \`tick rate ${20 * n}\` (${why}): Bedrock has no /tick, only Java does. So the clock runs x${Math.max(2, n)} instead (the villagers' day); water, hoppers and the spawn rolls stay at the normal speed.`);
  }
  say(`${parts.join(' ')} "speed normal" puts it all back.`);
}

/** The platform cells a test golem may start on: not a corner, not the hole, and a few blocks from the hole so the water has something to do. */
export function startCells() {
  const out = [];
  for (let x = PLATFORM.x1; x <= PLATFORM.x2; x++) for (let z = PLATFORM.z1; z <= PLATFORM.z2; z++) {
    if (CORNERS.some(([a, b]) => a === x && b === z)) continue;
    if (x >= HOLE.x1 && x <= HOLE.x2 && z >= HOLE.z1 && z <= HOLE.z2) continue;
    if (Math.hypot(x + 0.5 - HOLE_CENTRE.x, z + 0.5 - HOLE_CENTRE.z) < 3) continue;
    out.push({ x, z });
  }
  return out;
}

/** Put n golems on the platform (random cells); returns how many were made. */
export function spawnTestGolems(farm, n) {
  const cells = startCells();
  let made = 0;
  for (let i = 0; i < n; i++) {
    const c = cells[Math.floor(Math.random() * cells.length)];
    const at = W(farm.off, { x: c.x + 0.5, y: WATER_Y, z: c.z + 0.5 });
    try {
      const e = farm.dim.spawnEntity('minecraft:iron_golem', at);
      farm.test.add(e.id);
      made++;
    } catch (e) { say(`Could not spawn a golem: ${e}`); break; }
  }
  return made;
}

/** `golem [n]` (n golems now), `golem auto [seconds]` (one every few seconds), `golem off`. */
export function golemCommand(farm, args) {
  if (!farm) return say('No farm.');
  const a = (args[0] ?? '1').toLowerCase();
  if (a === 'off' || a === 'stop') {
    if (farm.auto >= 0) { try { system.clearRun(farm.auto); } catch { /* */ } farm.auto = -1; return say('No more test golems.'); }
    return say('No test golems were being made.');
  }
  if (a === 'auto') {
    const s = Math.max(5, Math.min(600, Math.floor(Number(args[1] ?? 30)) || 30));
    if (farm.auto >= 0) { try { system.clearRun(farm.auto); } catch { /* */ } }
    farm.auto = system.runInterval(() => { if (farm) spawnTestGolems(farm, 1); }, s * 20);
    spawnTestGolems(farm, 1);
    return say(`A test golem on the platform now and then one every ${s} s. "golem off" stops it.`);
  }
  const n = Math.max(1, Math.min(10, Math.floor(Number(a)) || 1));
  const made = spawnTestGolems(farm, n);
  say(`${made} test golem${made === 1 ? '' : 's'} on the platform (made by the pack, not the village: this tests the water, the hole, the campfires, the hoppers and the chest, not the spawn rate). I say what happens to each.`);
}
