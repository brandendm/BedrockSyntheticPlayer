// `!bot buildfarm`: the bot builds the iron golem farm (core/ironfarm.js) itself, with its own hands. `!bot ironfarm` is the other way: every block
// set at once by command, no bot. Here the bot is put on a flat pad in the sky (level, empty, nothing hostile spawns on it), given the blocks, and
// places the shell, the window, the composters and the slabs one at a time (core/farmbuild.js decides where it stands for each); the pieces that take a
// particular state (beds, hoppers, chests, signs, gates, the door, torches, campfires, lava, water, villagers) are set with commands, as they always
// have been (game/ironfarm_parts.js). A block that will not go down by hand is set by command and counted, so what you get is always the farm,
// and the report says how much of it the bot placed. If the hand keeps missing, or is far too slow, the rest is set by command and it says so.
//
//   !bot buildfarm              build it (carries on where it stopped, if it was stopped)
//   !bot buildfarm new          a new pad and a new farm, whatever was there
//   !bot buildfarm cobble       with cobblestone walls instead of dirt
//   !bot buildfarm status       how far it has got, how much by hand
//   !bot buildfarm stop         stop (the bot's own things go back in its pack)
//   !bot buildfarm clearpad     take the pad away again (after "ironfarm clear")
// The farm is then the same one `!bot ironfarm` makes: status, view, golem, time, bill and the rest of its commands work on it.
import { system, world } from '@minecraft/server';
import { ironFarmPlan, checkPlan, blockArg, BASE_Y, FLOOR_Y, DOOR, GATES, OUT_VIEW, SLAB } from '../core/ironfarm.js';
import { runBuild, newStats, splitPlan } from '../core/farmbuild.js';
import { say, wait, W, run, idAt } from './ironfarm_world.js';
import { findSlab, placeSigns, placeGates, placeDoor } from './ironfarm_parts.js';
import { finishBuild, clearFarm, farmStands, shellArg } from './ironfarm.js';
import { invCounts, give, container, kitOf, restoreKit } from './inventory.js';

const AREA = 'bsp_farmbuild';
/** The pad, in plan coordinates: 12 blocks all round the tower (x and z -1..16), one block thick, its top just under the tower's bottom layer. */
const PAD = Object.freeze({ x1: -13, x2: 28, z1: -13, z2: 28, y: BASE_Y - 1 });
/** Torches on the pad (nothing hostile spawns where there is light), outside the tower's footprint. */
const PAD_TORCHES = (() => {
  const out = [];
  for (const x of [-9, -1, 8, 17, 25]) for (const z of [-9, -1, 8, 17, 25]) if (!(x >= -2 && x <= 17 && z >= -2 && z <= 17)) out.push({ x, z });
  return out;
})();
const MAX_TICKS = 40 * 60 * 20;   // forty minutes of placing by hand, then the rest by command

/** @type {null | { running: boolean, finished: boolean, dim: any, off: {x:number,y:number,z:number}, shell: string|undefined, stats: any, started: number, phase: string, report: string, stop: boolean }} */
let job = null;

const strip = (id) => id.replace('minecraft:', '');
/** The bot's way of being told to stop (game/skills.js throws it from every check): matched by name, so this file does not pull the whole skill set in. */
const aborted = (e) => e?.constructor?.name === 'Aborted';
/** Health and food back to full (the build is long; nothing in it is meant to hurt). */
function topUp(ent) {
  try { ent.getComponent('minecraft:health')?.resetToMaxValue(); } catch { /* */ }
  try { ent.getComponent('minecraft:player.hunger')?.setCurrentValue(20); } catch { /* */ }
  try { ent.getComponent('minecraft:player.saturation')?.setCurrentValue(20); } catch { /* */ }
}
const mins = (ticks) => `${Math.floor(ticks / 1200)}:${String(Math.floor((ticks % 1200) / 20)).padStart(2, '0')}`;

export function farmBuildCommand(agent, player, args) {
  const sub = (args[0] ?? 'start').toLowerCase();
  if (sub === 'status') return status();
  if (sub === 'stop') return stop(agent);
  const go = async () => {
    if (sub === 'clearpad') return clearPad(player);
    return start(agent, player, args);
  };
  go().catch((e) => say(`buildfarm failed: ${e}\n${e?.stack ?? ''}`));
}

function status() {
  if (!job) return say('No bot build yet: "!bot buildfarm" starts one.');
  const s = job.stats;
  const line = `${s.hand} of ${s.cells} blocks placed by the bot, ${s.command} by command (${s.footing} to have something to stand on, ${s.fallback + s.repaired} that would not go down), ${s.already} already there`;
  if (job.running) return say(`Building (${job.phase}), layer ${s.layer}: ${line}; ${mins(system.currentTick - job.started)} so far.${s.gaveUp ? ` Placing by hand was given up: ${s.gaveUp}.` : ''}`);
  say(`${job.finished ? 'Finished' : 'Stopped'}: ${line}. ${job.report}`);
}

function stop(agent) {
  if (!job?.running) return say('Not building.');
  job.stop = true;
  agent.newTask(null);          // (the build notices at its next step, puts the bot's things back, and says where it got to)
  say('Stopping.');
}

// ---- the pad ----
/** Where the pad goes: east of the player, in the sky above everything natural round it. Returns the plan offset (plan y BASE_Y - 1 is the pad's top). */
async function pickSite(p) {
  const dim = p.dimension;
  const cx = Math.floor(p.location.x) + 44, cz = Math.floor(p.location.z);
  const half = Math.ceil((PAD.x2 - PAD.x1) / 2);
  // (Load the ground there first, or the heights below read as nothing and the pad could end up inside a mountain.)
  try { dim.runCommand(`tickingarea remove ${AREA}`); } catch { /* none */ }
  try { dim.runCommand(`tickingarea add ${cx - half - 8} 64 ${cz - half - 8} ${cx + half + 8} 64 ${cz + half + 8} ${AREA} true`); } catch { /* the player's own loads it */ }
  await loaded(dim, { x: cx, y: 64, z: cz }, 100);
  await wait(10);
  let top = Math.floor(p.location.y);
  for (let dx = -half - 8; dx <= half + 8; dx += 8) for (let dz = -half - 8; dz <= half + 8; dz += 8) {
    try { const b = dim.getTopmostBlock({ x: cx + dx, z: cz + dz }); if (b) top = Math.max(top, b.location.y); } catch { /* unloaded */ }
  }
  const max = dim.heightRange.max - 40;
  const padY = Math.min(max, Math.max(top + 24, Math.floor(p.location.y) + 20, 80));
  const mid = Math.round((PAD.x1 + PAD.x2) / 2);
  return { x: cx - mid, y: padY - PAD.y, z: cz - mid };
}

async function loaded(dim, q, ticks = 200) {
  for (let i = 0; i < ticks; i++) {
    try { if (dim.getBlock(q)) return true; } catch { /* not yet */ }
    await wait(2);
  }
  return false;
}

async function makePad(dim, off) {
  const a = W(off, { x: PAD.x1, y: PAD.y, z: PAD.z1 }), b = W(off, { x: PAD.x2, y: PAD.y, z: PAD.z2 });
  try { dim.runCommand(`tickingarea remove ${AREA}`); } catch { /* none */ }
  let area = '';
  try { dim.runCommand(`tickingarea add ${a.x} 64 ${a.z} ${b.x} 64 ${b.z} ${AREA} true`); area = 'box'; } catch {
    try { dim.runCommand(`tickingarea add circle ${Math.floor((a.x + b.x) / 2)} 64 ${Math.floor((a.z + b.z) / 2)} 4 ${AREA} true`); area = 'circle'; } catch { /* no ticking area: the player's own loads it */ }
  }
  if (!(await loaded(dim, { x: a.x, y: a.y, z: a.z })) || !(await loaded(dim, { x: b.x, y: a.y, z: b.z }))) return { ok: false, area, why: 'the chunks for the pad would not load' };
  // The air over it first (so nothing is in the way: clouds of leaves, a floating island), then the pad, then the torches.
  const h = W(off, { x: 0, y: PAD.y + 1, z: 0 }).y;
  const ceil = Math.min(dim.heightRange.max - 1, h + 20);
  const fails = [];
  const fillAll = async (y1, y2, id) => {
    for (let x = a.x; x <= b.x; x += 16) {
      const why = run(dim, `fill ${x} ${y1} ${a.z} ${Math.min(b.x, x + 15)} ${y2} ${b.z} ${id}`);
      if (why) fails.push(why);
      await wait(1);
    }
  };
  await fillAll(a.y + 1, ceil, 'air');
  await fillAll(a.y, a.y, 'stone');
  for (const t of PAD_TORCHES) { const q = W(off, { x: t.x, y: PAD.y + 1, z: t.z }); const why = run(dim, `setblock ${q.x} ${q.y} ${q.z} torch`); if (why) fails.push(why); }
  await wait(5);
  const mid = W(off, { x: 8, y: PAD.y, z: 8 });
  if (idAt(dim, mid) !== 'stone') return { ok: false, area, why: `the pad did not go in (${fails[0] ?? `${idAt(dim, mid)} where it should be`})` };
  return { ok: true, area, why: '' };
}

async function clearPad(player) {
  if (job?.running) return say('Building: stop it first.');
  if (farmStands()) return say('The farm still stands on it: "!bot ironfarm clear" first.');
  if (!job) return say('No pad.');
  const { dim, off } = job;
  const a = W(off, { x: PAD.x1, y: PAD.y, z: PAD.z1 }), b = W(off, { x: PAD.x2, y: PAD.y + 1, z: PAD.z2 });
  for (let x = a.x; x <= b.x; x += 16) { run(dim, `fill ${x} ${a.y} ${a.z} ${Math.min(b.x, x + 15)} ${b.y} ${b.z} air`); await wait(1); }
  try { dim.runCommand(`tickingarea remove ${AREA}`); } catch { /* none */ }
  job = null;
  say('Pad taken away.');
}

// ---- the build ----
async function start(agent, player, args) {
  if (job?.running) return say('Already building: "!bot buildfarm status", or "!bot buildfarm stop".');
  const p = player ?? world.getPlayers().find((pl) => pl.id !== agent.sim.id);
  if (!p) return say('No player to build for.');
  const dim = p.dimension;
  if (dim.id !== 'minecraft:overworld') return say('Build it in the overworld.');
  const shell = shellArg(args);
  const again = !!job && !job.finished && !args.includes('new') && job.shell === shell;
  const plan = ironFarmPlan({ shell });
  const problems = checkPlan(plan, { deep: false });
  if (problems.length) return say(`The plan fails its own checks (${problems.slice(0, 3).join('; ')}): not building.`);
  let off;
  if (again) {
    off = job.off;
    say('Carrying on where it stopped (same pad, same place).');
  } else {
    if (farmStands()) await clearFarm(false);
    off = await pickSite(p);
    say(`Making a pad in the sky: ${PAD.x2 - PAD.x1 + 1} x ${PAD.z2 - PAD.z1 + 1}, its top at y ${off.y + PAD.y}, ${Math.abs(off.x - Math.floor(p.location.x))} blocks from you.`);
    const pad = await makePad(dim, off);
    if (!pad.ok) return say(`No pad: ${pad.why}.`);
  }
  const stats = newStats();
  job = { running: true, finished: false, dim, off, shell, stats, started: system.currentTick, phase: 'starting', report: '', stop: false };
  const J = job;
  const gen = agent.newTask({ kind: 'farmbuild' });
  agent.suspended = null;
  agent.motor.stop();
  const sim = agent.sim, S = agent.skills;
  // The bot's own things are set aside (and the agent told not to save the farm's blocks as its own); the player is put where the pad is.
  try { agent.saveKit(); } catch { /* */ }
  agent.kitHeld = true;
  const saved = kitOf(sim);
  try { container(sim)?.clearAll(); } catch { /* */ }
  topUp(sim);
  const view = { x: 7.5, y: BASE_Y, z: PAD.z1 + 2.5 };
  const where = (pt) => W(off, pt);
  try { p.teleport(where(view), { facingLocation: where({ x: 7.5, y: 1, z: 7.5 }), dimension: dim }); } catch (e) { say(`Could not move you to the pad: ${e}`); }
  const notes = [];
  /** @type {string[]} */
  const fails = [];
  let signs = null, door = null, gates = null, slabSpell = null;
  const noItem = new Set();
  try {
    // The slab's spelling for commands (a probe on the pad's corner, taken away again).
    const probe = W(off, { x: PAD.x1, y: PAD.y + 1, z: PAD.z1 });
    slabSpell = await findSlab(dim, probe, probe, notes);
    run(dim, `setblock ${probe.x} ${probe.y} ${probe.z} air`);
    // The farm's blocks as the bot will meet them.
    const { rest } = splitPlan(plan);
    const special = new Set(['sign', 'gate', 'door', 'lava', 'cwater', 'water']);
    const norm = (id) => (id.includes('slab') ? SLAB : id);
    const hands = {
      blockAt: (c) => { const q = W(off, c); try { const b = dim.getBlock(q); return b ? norm(strip(b.typeId)) : null; } catch { return null; } },
      where: () => { const l = sim.location; return { x: Math.floor(l.x) - off.x, y: Math.floor(l.y + 0.05) - off.y, z: Math.floor(l.z) - off.z }; },
      async stand(s) {
        const loc = { x: off.x + s.x + 0.5, y: off.y + s.y, z: off.z + s.z + 0.5 };
        agent.motor.stop();
        try { sim.teleport(loc, { dimension: dim }); sim.clearVelocity(); } catch (e) { S.log(`farmbuild: teleport ${s.x} ${s.y} ${s.z}: ${e}`); return false; }
        await S.wait(gen, 3);
        const q = sim.location;
        return Math.abs(q.x - loc.x) < 1.2 && Math.abs(q.z - loc.z) < 1.2 && Math.abs(q.y - loc.y) < 1.5;
      },
      async place(c, id) {
        if (noItem.has(id)) return false;
        let ok = false;
        try { ok = await agent.homestead.placeAt(gen, W(off, c), id, null, null, { lenient: true, stay: true }); } catch (e) { if (aborted(e)) throw e; S.log(`farmbuild: place ${id}: ${e}`); }
        return ok && hands.blockAt(c) === id;
      },
      set(c, id) {
        const q = W(off, c);
        if (id === SLAB) { if (!slabSpell) return false; return run(dim, `setblock ${q.x} ${q.y} ${q.z} ${slabSpell}`) === ''; }
        return run(dim, `setblock ${q.x} ${q.y} ${q.z} ${id}`) === '';
      },
      stock(id, n) {
        const have = invCounts(sim)[id] ?? 0;
        if (have >= n) return;
        try { give(sim, id, n - have); } catch (e) { noItem.add(id); notes.push(`The bot cannot be given ${id} (${String(e).slice(0, 60)}): those are set by command.`); }
      },
      now: () => system.currentTick,
      check: () => S.check(gen),
      yield: () => S.wait(gen, 1),
      say: (m) => say(m),
    };
    await hands.stand({ x: 7, y: BASE_Y, z: PAD.z1 + 6 });
    const plain = (y) => rest.filter((o) => o.y === y && !special.has(o.tag));
    const after = async (y, st) => {
      if (y === 'slabs') {
        J.phase = 'lava, water, the rest';
        const lava = rest.find((o) => o.tag === 'lava');
        if (lava) {
          if (!signs?.lavaOk) notes.push('The lava was NOT placed: the signs that hold it would not stay on their wall (see above).');
          else { const q = W(off, lava); const why = run(dim, `setblock ${q.x} ${q.y} ${q.z} lava`); if (why) fails.push(`lava: ${why}`); }
        }
        return;
      }
      for (const o of plain(y)) {
        const q = W(off, o);
        const cmd = `setblock ${q.x} ${q.y} ${q.z} ${blockArg(o.id, o.states)}`;
        const why = run(dim, cmd);
        if (why) fails.push(`${o.note || o.id}: ${why} (${cmd})`);
      }
      if (y === DOOR.y + 1 && !door) door = await placeDoor(dim, off, plan.ops.find((q) => q.tag === 'door' && !q.states.upper_block_bit), plan.ops.find((q) => q.tag === 'door' && q.states.upper_block_bit), notes);
      if (y === FLOOR_Y && !signs) signs = await placeSigns(dim, off, notes);
      if (y === GATES[0].y && !gates) gates = await placeGates(dim, off, notes);
      J.phase = `layer ${y} done`;
      if ([-4, 0, 3, 6].includes(y)) say(`Layer ${y} done: ${st.hand} of ${st.cells} blocks placed by the bot so far, ${st.command} by command, ${mins(system.currentTick - J.started)} in.`);
      topUp(sim);
    };
    J.phase = 'placing';
    say(`The bot is placing the farm (${plan.shell}: it has what it needs). "!bot buildfarm status" says how far it has got, "!bot buildfarm stop" stops it. Watch from the pad.`);
    await runBuild(plan, hands, { after, maxTicks: MAX_TICKS, stats });
    agent.motor.setFocus(null);
    J.phase = 'finishing';
    const slabCells = (stats.handById[SLAB] ?? 0) + (stats.commandById[SLAB] ?? 0);
    const byHand = Math.round((100 * stats.hand) / Math.max(1, stats.cells - stats.already));
    const lead = `The bot placed ${stats.hand} of ${stats.cells - stats.already} blocks itself (${byHand}%) in ${mins(system.currentTick - J.started)}; ${stats.command} were set by command (${stats.footing} to have something to stand on${stats.fallback + stats.repaired ? `, ${stats.fallback + stats.repaired} that would not go down by hand` : ''}${stats.gaveUp ? `; it gave up placing by hand: ${stats.gaveUp}` : ''}). `;
    J.report = lead;
    await finishBuild({ p, dim, off, plan, found: { cols: [] }, fails, notes, slab: slabSpell, slabCells, signs, door, gates, lead, extra: `Standing on a pad at y ${off.y + PAD.y} (${PAD.x2 - PAD.x1 + 1} x ${PAD.z2 - PAD.z1 + 1}); "!bot buildfarm clearpad" takes it away once the farm is cleared.` });
    J.finished = true;
    try { sim.teleport(W(off, OUT_VIEW), { dimension: dim }); } catch { /* */ }
  } catch (e) {
    if (aborted(e) || J.stop) {
      const s = J.stats;
      J.report = `Stopped at layer ${s.layer} with ${s.hand} blocks placed by the bot. "!bot buildfarm" carries on from there.`;
      say(J.report);
    } else {
      J.report = `Failed: ${e}`;
      say(`The build failed at layer ${J.stats.layer}: ${e}\n${e?.stack ?? ''} "!bot buildfarm" tries again from there.`);
    }
  } finally {
    J.running = false;
    try { agent.motor.setFocus(null); } catch { /* */ }
    try { container(sim)?.clearAll(); restoreKit(sim, { slots: saved.slots, worn: {} }); } catch (e) { say(`Could not put the bot's things back: ${e}. They are in the world's memory and come back at the next spawn.`); }
    agent.kitHeld = false;
    try { agent.saveKit(); } catch { /* */ }
    if (gen === agent.taskGen) agent.newTask(null);
    if (J.finished) { try { dim.runCommand(`tickingarea remove ${AREA}`); } catch { /* */ } }
  }
}
