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
//   !bot buildfarm held|quick|real   which hand (MODES below; by default the held button if a test on the pad shows the game paces it like
//                               yours, else the quick hand)
//   !bot buildfarm status       how far it has got, how much by hand
//   !bot buildfarm stop         stop (the bot's own things go back in its pack)
//   !bot buildfarm clearpad     take the pad away again (after "ironfarm clear")
// The farm is then the same one `!bot ironfarm` makes: status, view, golem, time, bill and the rest of its commands work on it.
import { system, world } from '@minecraft/server';
import { ironFarmPlan, checkPlan, blockArg, BASE_Y, GATES, OUT_VIEW, SLAB, STAIR_ID, SHAFT, SIGNS, LAVA, CAMPFIRES, CHAMBER_WATER, PLATFORM, WATER_Y, waterSources } from '../core/ironfarm.js';
import { runBuild, newStats, splitPlan, handSet, edge } from '../core/farmbuild.js';
import { render } from '../core/ironfarm_grid.js';
import { say, wait, W, run, idAt } from './ironfarm_world.js';
import { findSlab, placeSigns, placeGates, placeDoor } from './ironfarm_parts.js';
import { finishBuild, clearFarm, farmStands, shellArg } from './ironfarm.js';
import { invCounts, give, take, hold, container, kitOf, restoreKit } from './inventory.js';

const AREA = 'bsp_farmbuild';
/** The pad, in plan coordinates: 12 blocks all round the tower (x and z -1..16), one block thick, its top just under the tower's bottom layer. */
const PAD = Object.freeze({ x1: -13, x2: 28, z1: -13, z2: 28, y: BASE_Y - 1 });
/** Torches on the pad (nothing hostile spawns where there is light), outside the tower's footprint. */
const PAD_TORCHES = (() => {
  const out = [];
  for (const x of [-9, -1, 8, 17, 25]) for (const z of [-9, -1, 8, 17, 25]) if (!(x >= -2 && x <= 17 && z >= -2 && z <= 17)) out.push({ x, z });
  return out;
})();
const MAX_TICKS = 3 * 60 * 60 * 20;   // three hours of building by hand (walking and climbing included), then the rest by command (u218: was 75 minutes)
const SCAFFOLD_SPARE = 48;        // shell blocks over a layer's count: what it pillars and bridges with
/**
 * How the bot's hand puts a block down (u216). The game gives a simulated player one item use every 10 ticks (measured: 9 refused), a block every
 * half second; a player building fast places one every 3 to 4 ticks (your house runs: 11 blocks in 2 s).
 *   held   the game's own held use button (SimulatedPlayer.startBuild, undocumented): started once the crosshair is on the face, stopped as soon as
 *          the block is in. Legitimate if the game paces it like a player's held button: tried first on the pad (heldProbe) and used only if it is.
 *   quick  a cheat: the bot does everything a placement takes (stands within reach, the crosshair on a solid neighbour's face, the block in hand
 *          and one taken from its pack, a player's pace between blocks), and the block is put in by command instead of by the game's item use.
 *   real   the game's own item use, as in u215 (a block every 10 ticks at best).
 */
export const MODES = Object.freeze(['held', 'quick', 'real']);
export const QUICK_GAP = 3;        // ticks between blocks: a player's 3.4
const HELD_OK_TICKS = 5;           // the held probe's ticks a block (aim included) to count as a player's pace
const SOUND = { dirt: 'use.gravel', cobblestone: 'use.stone', glass: 'use.stone', composter: 'use.wood', [SLAB]: 'use.stone' };
const HAND_NAME = { held: 'with the game\'s held button', quick: 'with the quick hand (aimed by the bot, put in by command)', real: 'with the game\'s own item use' };
const modeArg = (args) => MODES.find((m) => args.some((a) => a.toLowerCase() === m)) ?? null;

/** @type {null | { running: boolean, finished: boolean, dim: any, off: {x:number,y:number,z:number}, shell: string|undefined, stats: any, started: number, phase: string, report: string, stop: boolean, mode: string, probed: null | { ok: boolean, line: string } }} */
let job = null;

const strip = (id) => id.replace('minecraft:', '');
/** The bot's way of being told to stop (game/skills.js throws it from every check): matched by name, so this file does not pull the whole skill set in. */
const aborted = (e) => e?.constructor?.name === 'Aborted';
/** What the bot can stand in (feet or head). */
const FREE_ID = /^(air|torch|wall_sign|fence_gate|.*_wall_sign)$/;
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
  const rate = s.handTicks ? ` (${((20 * s.hand) / s.handTicks).toFixed(1)} a second while placing)` : '';
  if (job.running) return say(`Building (${job.phase}, ${HAND_NAME[job.mode] ?? job.mode}${rate}), layer ${s.layer}: ${line}; ${mins(system.currentTick - job.started)} so far.${s.gaveUp ? ` Placing by hand was given up: ${s.gaveUp}.` : ''}`);
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

// ---- the held button, tried ----
/**
 * Does the game's held use button (startBuild) put blocks down at a player's pace, and only where the crosshair is? Five blocks in a row on the pad's
 * north-west corner (outside the tower, away from its torches), each started with the crosshair on the top of the pad block under it and stopped as
 * soon as it is in; the corner is read before and after, and anything that is not one of the five is a stray. Everything put there is taken away.
 * { ok, line }: ok only if all five went in, nothing else did, and it took HELD_OK_TICKS a block or less.
 */
async function heldProbe(agent, gen, dim, off, id, go) {
  const sim = agent.sim, S = agent.skills, H = agent.homestead;
  if (typeof (/** @type {any} */ (sim).startBuild) !== 'function') return { ok: false, line: 'this version has no held button for a simulated player (startBuild)' };
  const box = { x1: PAD.x1 - 1, x2: PAD.x1 + 6, y1: PAD.y + 1, y2: PAD.y + 4, z1: PAD.z1 - 1, z2: PAD.z1 + 5 };
  const read = () => { const m = new Map(); for (let x = box.x1; x <= box.x2; x++) for (let y = box.y1; y <= box.y2; y++) for (let z = box.z1; z <= box.z2; z++) m.set(`${x},${y},${z}`, idAt(dim, W(off, { x, y, z }))); return m; };
  const before = read();
  const targets = [0, 1, 2, 3, 4].map((i) => ({ x: PAD.x1 + i, y: PAD.y + 1, z: PAD.z1 }));
  const stand = { x: PAD.x1 + 2, y: PAD.y + 1, z: PAD.z1 + 2 };
  if (!(await go(stand))) return { ok: false, line: 'the bot could not walk to the corner of the pad to try it' };
  await S.wait(gen, 2);
  let placed = 0, extra = 0;
  const t0 = system.currentTick;
  for (const c of targets) {
    const r = await H.placeHeld(gen, W(off, c), id, { below: true, aimTicks: 4, maxTicks: 14 });
    if (r.ok) placed++;
    extra += r.extra;
  }
  const ticks = system.currentTick - t0;
  const after = read();
  const want = new Set(targets.map((c) => `${c.x},${c.y},${c.z}`));
  let strays = 0;
  for (const [k, v] of after) {
    if (v === before.get(k) || (want.has(k) && v === id)) continue;
    strays++;
  }
  // (Everything back as it was.)
  for (const [k, v] of after) {
    if (v === before.get(k)) continue;
    const [x, y, z] = k.split(',').map(Number), q = W(off, { x, y, z });
    run(dim, `setblock ${q.x} ${q.y} ${q.z} ${before.get(k) === 'air' ? 'air' : before.get(k)}`);
  }
  const per = placed ? ticks / placed : Infinity;
  const ok = placed === targets.length && strays === 0 && extra === 0 && per <= HELD_OK_TICKS;
  return { ok, line: `${placed} of ${targets.length} blocks went in${placed ? `, ${per.toFixed(1)} ticks a block with the aim (a player: about 3.5)` : ''}${strays || extra ? `, ${Math.max(strays, extra)} where they should not have` : ''}` };
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
  const asked = modeArg(args);
  const probed = again ? job.probed : null;
  job = { running: true, finished: false, dim, off, shell, stats, started: system.currentTick, phase: 'starting', report: '', stop: false, mode: asked ?? 'held', probed };
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
  // (Tools to take its scaffolding down with, and to break its way out if it walls itself in.)
  for (const t of ['iron_shovel', 'iron_pickaxe']) { try { give(sim, t, 1); } catch { /* */ } }
  topUp(sim);
  // No fighting or running of its own while it builds (a fight took the build over and stopped it), and no monsters on the site to fight: anything
  // hostile that turns up round the pad is taken away every two seconds (the tower is dark inside until it is finished).
  const testHeld = agent.testHold;
  agent.testHold = true;
  agent.homestead.placedLenient = 0;
  const siteCentre = W(off, { x: 7.5, y: 0, z: 7.5 });
  let swept = 0;
  const sweeper = system.runInterval(() => {
    try { for (const e of dim.getEntities({ location: siteCentre, maxDistance: 48, families: ['monster'] })) { try { e.remove(); swept++; } catch { /* */ } } } catch { /* */ }
  }, 40);
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
    const { rest, final } = splitPlan(plan);
    const hand = handSet(plan.shell);
    const rel = (q) => ({ x: q.x - off.x, y: q.y - off.y, z: q.z - off.z });
    const finalAt = (c) => final.at(c.x, c.y, c.z)?.id ?? 'air';
    /** Scaffolding the bot has put down (plan coordinates), until it takes it down. */
    const scaffold = new Map();
    let escaping = false;
    // What it may break on its way about: never the pad or a block of the farm, but when it has walled itself in (escaping), a plain block of the
    // farm (shell, glass, composter, slab) at a high price, which it then puts back. Its own scaffolding, as anything else, the usual rules.
    agent.digCost = (p) => {
      const c = rel({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
      if (c.y === PAD.y && c.x >= PAD.x1 && c.x <= PAD.x2 && c.z >= PAD.z1 && c.z <= PAD.z2) return Infinity;
      const want = final.at(c.x, c.y, c.z)?.id;
      if (!want || want === 'air' || /water/.test(want)) return undefined;
      if (scaffold.has(`${c.x},${c.y},${c.z}`) && hands.blockAt(c) !== want) return undefined;
      return escaping && hand.has(want) ? 30 : Infinity;
    };
    // (It pillars and bridges with the shell: the glass, composters and slabs are kept for the farm.)
    agent.reserveExtra = (inv) => ({ glass: inv.glass ?? 0, composter: inv.composter ?? 0, [SLAB]: inv[SLAB] ?? 0 });
    const special = new Set(['sign', 'gate', 'door', 'lava', 'cwater', 'water']);
    // (A slab as the bot meets it: a bottom one is SLAB; a top one (mobs spawn on it) and a double one are not.)
    const norm = (b) => {
      const id = strip(b.typeId);
      if (!id.includes('slab')) return id;
      if (id.includes('double')) return id;
      let top = false;
      try { top = b.permutation.getState('minecraft:vertical_half') === 'top' || b.permutation.getState('top_slot_bit') === true; } catch { /* */ }
      return top ? `${SLAB}:top` : SLAB;
    };
    let mode = J.mode, heldMisses = 0, heldSlips = 0;
    const fast = () => mode !== 'real';
    /** A block put against the side of the one the bot stands on (see hands.place): crouched at the edge, looking down at that face. */
    const bridgeHand = async (c, id, ft) => {
      const q = W(off, c), floor = W(off, { x: ft.x, y: ft.y - 1, z: ft.z });
      let was = false;
      try { was = sim.isSneaking; sim.isSneaking = true; } catch { /* */ }
      try {
        if (mode === 'quick') return await agent.homestead.placeQuick(gen, q, id, () => hands.set(c, id), { gap: QUICK_GAP, sound: SOUND[id] ?? null, against: floor });
        return await agent.homestead.placeAt(gen, q, id, floor, null, { lenient: true, stay: true });
      } finally { if (!was) { try { sim.isSneaking = false; } catch { /* */ } } }
    };
    const hands = {
      blockAt: (c) => { const q = W(off, c); try { const b = dim.getBlock(q); return b ? norm(b) : null; } catch { return null; } },
      where: () => { const l = sim.location; return { x: Math.floor(l.x) - off.x, y: Math.floor(l.y + 0.05) - off.y, z: Math.floor(l.z) - off.z }; },
      // On its own feet (u217: never teleported once it is on the pad): walking, jumping up onto what it has laid, pillaring and bridging with the
      // shell, breaking its way out (and so back in) only when walled in. What it put down is scaffolding (taken down at the end of the layer);
      // what of the farm it broke goes back to the core to be put back by hand.
      async stand(s) {
        agent.motor.stop();
        // (u218 live: "no route, 0 blocks to build with": the layer's blocks and the spare went on scaffolding. Never under 32 of the shell to pillar and
        // bridge with when it sets off.)
        { const have = invCounts(sim)[plan.shell] ?? 0; if (have < 32 && !noItem.has(plan.shell)) { try { give(sim, plan.shell, 64 - have); } catch { /* */ } } }
        const r = await S.walkTo(gen, W(off, s), { escape: (on) => { escaping = on; } });
        for (const c of r.placed) { const q = rel(c); scaffold.set(`${q.x},${q.y},${q.z}`, q); stats.scaffoldUp = (stats.scaffoldUp ?? 0) + 1; }
        if (r.broke.length) stats.escapes = (stats.escapes ?? 0) + 1;
        if (!r.ok) S.log(`farmbuild: could not get to ${s.x} ${s.y} ${s.z} (from ${JSON.stringify(hands.where())})`);
        return { ok: r.ok, broke: r.broke.map(rel) };
      },
      /** Its scaffolding down, by its own hand, top first: every block it pillared or bridged with that is not the farm's own. */
      async tidy() {
        const todo = [...scaffold.values()].sort((a, b) => b.y - a.y);
        for (const c of todo) {
          S.check(gen);
          const k = `${c.x},${c.y},${c.z}`;
          const want = finalAt(c), now = hands.blockAt(c);
          if (!now || now === 'air' || want === now) { scaffold.delete(k); continue; }   // gone, or the farm's own block now
          if (!hand.has(now) && !now.startsWith(SLAB)) { scaffold.delete(k); continue; }
          const q = W(off, c);
          let ok = false;
          try {
            if (!S.inReach(q)) await S.goNear(gen, { x: q.x + 0.5, y: q.y + 1, z: q.z + 0.5 }, 2.5, 2);
            ok = await S.mine(gen, q, { collect: true, allowBelow: true });
          } catch (e) { if (aborted(e)) throw e; }
          if (ok) { scaffold.delete(k); stats.scaffoldDown = (stats.scaffoldDown ?? 0) + 1; }
        }
      },
      async place(c, id) {
        if (noItem.has(id)) return false;
        const q = W(off, c), below = id === SLAB;
        let ok = false;
        // Beside the block under its feet, at that block's level (a floor laid outward from the floor it stands on): crouched at the edge, the
        // block against the side of the one under it, as a player bridges (u220).
        const ft = hands.where();
        if (!below && edge(ft, c) && !FREE_ID.test(hands.blockAt({ x: ft.x, y: ft.y - 1, z: ft.z }) ?? 'air')) {
          try { ok = await bridgeHand(c, id, ft); } catch (e) { if (aborted(e)) throw e; S.log(`farmbuild: bridge ${id}: ${e}`); }
          return ok && hands.blockAt(c) === id;
        }
        try {
          if (mode === 'held') {
            const r = await agent.homestead.placeHeld(gen, q, id, { below });
            ok = r.ok;
            heldMisses = ok ? 0 : heldMisses + 1;
            if (r.extra) heldSlips++;
            // (The held button putting blocks where they should not go, or not putting them where they should: the quick hand for the rest.)
            if (heldSlips >= 3 || heldMisses >= 4) {
              mode = 'quick'; J.mode = mode;
              const why = heldSlips >= 3 ? `it put a second block down before it was let go ${heldSlips} times` : `it missed ${heldMisses} blocks in a row`;
              notes.push(`The held button was dropped part way (${why}): the quick hand did the rest.`);
              say(`The held button is not working out (${why}): the rest with the quick hand.`);
            }
          } else if (mode === 'quick') ok = await agent.homestead.placeQuick(gen, q, id, () => hands.set(c, id), { gap: QUICK_GAP, below, sound: SOUND[id] ?? null });
          else ok = await agent.homestead.placeAt(gen, q, id, below ? W(off, { x: c.x, y: c.y - 1, z: c.z }) : null, null, { lenient: true, stay: true });
        } catch (e) { if (aborted(e)) throw e; S.log(`farmbuild: place ${id}: ${e}`); }
        return ok && hands.blockAt(c) === id;
      },
      set(c, id) {
        const q = W(off, c);
        if (id === SLAB) { if (!slabSpell) return false; return run(dim, `setblock ${q.x} ${q.y} ${q.z} ${slabSpell}`) === ''; }
        return run(dim, `setblock ${q.x} ${q.y} ${q.z} ${id}`) === '';
      },
      clear(c) { const q = W(off, c); return run(dim, `setblock ${q.x} ${q.y} ${q.z} air`) === ''; },
      stock(id, n) {
        if (id === plan.shell) n += SCAFFOLD_SPARE;
        const have = invCounts(sim)[id] ?? 0;
        if (have >= n) return;
        try { give(sim, id, n - have); } catch (e) { noItem.add(id); notes.push(`The bot cannot be given ${id} (${String(e).slice(0, 60)}): those are set by command.`); }
      },
      now: () => system.currentTick,
      check: () => S.check(gen),
      yield: () => S.wait(gen, 1),
      say: (m) => say(m),
    };
    // The one time the bot is put anywhere: on the pad at the start (the flat place to build on, as asked), unless it is already on the site;
    // from here on it goes on foot.
    const PARK = { x: 7, y: BASE_Y, z: PAD.z1 + 6 };
    {
      const h = hands.where();
      const onSite = h.x >= PAD.x1 && h.x <= PAD.x2 && h.z >= PAD.z1 && h.z <= PAD.z2 && h.y >= PAD.y + 1 && h.y <= plan.bounds.y2 + 3;
      if (!onSite) { try { sim.teleport(W(off, { x: PARK.x + 0.5, y: PARK.y, z: PARK.z + 0.5 }), { dimension: dim }); sim.clearVelocity(); } catch { /* */ } await S.wait(gen, 3); }
    }
    // Which hand: the held button if the game paces it like a player's (tried on the pad first), else the quick hand; "real" is the u215 way.
    if (mode === 'held') {
      if (J.probed && !asked) mode = J.probed.ok ? 'held' : 'quick';   // (carrying on: the verdict it came to before)
      else {
        J.phase = 'trying the held button';
        hands.stock(plan.shell, 8);
        const pr = await heldProbe(agent, gen, dim, off, plan.shell, (c) => hands.stand(c).then((r) => r.ok));
        J.probed = pr;
        if (pr.ok) say(`Held-button test: ${pr.line}. The bot builds with the game's own held button: no cheat.`);
        else if (asked === 'held') say(`Held-button test: ${pr.line}. Using it anyway, as asked (the quick hand takes over if it keeps missing).`);
        else { mode = 'quick'; say(`Held-button test: ${pr.line}. So the quick hand: the bot stands in reach, aims at the face and holds the block as you would, at your pace, and the block is put in by command (the cheat: the game lets a simulated player place only once every 10 ticks).`); }
      }
      J.mode = mode;
    }
    // u220 (the player: "place everything by hand"): every part goes in by the bot's own hand, the quick hand's way (it walks to a spot in reach,
    // takes the item in hand, puts the crosshair on the face it goes against, and the block goes in with the state the plan wants, by command:
    // the facing a click would give is not something a simulated player's aim can be trusted with), each as soon as the layer under it is down and
    // while the bot can still get to it: the hoppers, chests and stair on the floor, the campfires and the hallway water, the signs and the lava
    // once the hallway walls hold them, the beds and torches in the pod, the gates over the hole, the platform water from the wall tops, the door
    // last. The villagers are the one thing it does not bring: they are summoned at the end, as before.
    const ITEMS = { hopper: ['hopper'], chest: ['chest'], [STAIR_ID]: [STAIR_ID, 'cobblestone_stairs'], campfire: ['campfire'], torch: ['torch'], bed: ['bed', 'red_bed', 'white_bed'], wall_sign: ['oak_sign'], fence_gate: ['oak_fence_gate', 'fence_gate'], wooden_door: ['wooden_door', 'oak_door'], lava: ['lava_bucket'], water: ['water_bucket'] };
    /** The item for a part, in the pack (given if it is not there). null if the game knows none of its names. */
    const itemFor = (id) => {
      for (const it of ITEMS[id] ?? [id]) {
        if ((invCounts(sim)[it] ?? 0) > 0) return it;
        try { give(sim, it, 1); if ((invCounts(sim)[it] ?? 0) > 0) return it; } catch { /* the next name */ }
      }
      return null;
    };
    // (Not at the lip of the hole up on the platform: a slip there is a fall down the shaft onto the campfires and the lava.)
    const nearShaft = (q) => q.x >= SHAFT.x1 - 1 && q.x <= SHAFT.x2 + 1 && q.z >= SHAFT.z1 - 1 && q.z <= SHAFT.z2 + 1 && q.y > SHAFT.y2;
    /** A spot to put a part in from: room for the bot, something solid under it, the cell in reach, near where it is, not at the lip of the shaft. */
    const partStand = (c, reach) => {
      const from = hands.where();
      let best = null, bs = Infinity;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        const q = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        if (q.x === c.x && q.z === c.z && (q.y === c.y || q.y + 1 === c.y)) continue;
        const ex = q.x + 0.5 - (c.x + 0.5), ey = q.y + 1.52 - (c.y + 0.5), ez = q.z + 0.5 - (c.z + 0.5);
        if (ex * ex + ey * ey + ez * ez > reach * reach) continue;
        if (!FREE_ID.test(hands.blockAt(q) ?? 'x') || !FREE_ID.test(hands.blockAt({ ...q, y: q.y + 1 }) ?? 'x')) continue;
        const under = hands.blockAt({ ...q, y: q.y - 1 }) ?? 'air';
        if (FREE_ID.test(under) || /water|lava|campfire|magma/.test(under)) continue;
        if (nearShaft(q)) continue;
        const d = from ? Math.abs(q.x - from.x) + Math.abs(q.z - from.z) + Math.abs(q.y - from.y) * 2 + (q.y < from.y ? 6 : 0) : 0;
        if (d < bs) { bs = d; best = q; }
      }
      return best;
    };
    const partStats = { hand: 0, command: 0, missing: /** @type {string[]} */ ([]) };
    /**
     * One part by the bot's hand: there, item in hand, crosshair on it; then `put()` (the command with the plan's state, or one of the parts
     * routines that tries the game's spellings). `reach` 5 for a bucket poured onto a floor below (a player's reach in Bedrock).
     */
    const byHand = async (cell, id, put, { reach = 4.2, bucket = false } = {}) => {
      const it = itemFor(id);
      let there = false;
      const at = hands.where();
      const ok0 = at && (() => { const ex = at.x + 0.5 - (cell.x + 0.5), ey = at.y + 1.52 - (cell.y + 0.5), ez = at.z + 0.5 - (cell.z + 0.5); return ex * ex + ey * ey + ez * ez <= reach * reach && !(at.x === cell.x && at.z === cell.z && (at.y === cell.y || at.y + 1 === cell.y)); })();
      if (ok0) there = true;
      else { const st = partStand(cell, reach); if (st) there = (await hands.stand(st)).ok; }
      const q = W(off, cell);
      if (there && it) {
        try { await agent.homestead.aimFace(gen, q, it, { snap: true, lenient: true, aimTicks: 2 }); } catch (e) { if (aborted(e)) throw e; }
        try { hold(sim, it); } catch { /* */ }
        await S.wait(gen, QUICK_GAP);
      }
      const ok = await put();
      if (ok && there && it) {
        partStats.hand++;
        // (A bucket is not used up: one water bucket stands for the refills a player makes from a source of its own.)
        if (!bucket) { try { take(sim, it, 1); } catch { /* */ } }
      } else if (ok) { partStats.command++; partStats.missing.push(`${id} at ${cell.x},${cell.y},${cell.z}${it ? '' : ' (no item by that name)'}`); }
      return ok;
    };
    const setOp = (o) => () => {
      const q = W(off, o);
      const cmd = `setblock ${q.x} ${q.y} ${q.z} ${blockArg(o.id, o.states)}`;
      const why = run(dim, cmd);
      if (why) fails.push(`${o.note || o.id}: ${why} (${cmd})`);
      return !why;
    };
    const visit = async (c, item) => { await byHand(c, item === 'oak_sign' ? 'wall_sign' : 'fence_gate', async () => true); };
    const plain = (y) => rest.filter((o) => o.y === y && !special.has(o.tag));
    /** Every cell a list of ops fills (a bed's foot too). */
    const cellsOf = (ops) => new Set([...render({ ops }).cells.keys()]);
    const after = async (y, st) => {
      // (Off any cell a part is about to go in: a bed or a chest put where the bot stands has it inside a block.)
      if (y !== 'slabs') {
        const at = hands.where();
        const filled = cellsOf(plain(y));
        const hit = (q) => filled.has(`${q.x},${q.y},${q.z}`) || filled.has(`${q.x},${q.y + 1},${q.z}`);
        if (at && hit(at)) {
          const side = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dz]) => ({ x: at.x + dx, y: at.y, z: at.z + dz })).find((q) => !hit(q) && FREE_ID.test(hands.blockAt(q) ?? '') && FREE_ID.test(hands.blockAt({ ...q, y: q.y + 1 }) ?? '') && !FREE_ID.test(hands.blockAt({ ...q, y: q.y - 1 }) ?? 'air'));
          if (!(side && (await hands.stand(side)).ok)) await hands.stand(PARK);
        }
      }
      if (y === 'slabs') {
        J.phase = 'the door';
        // The door last of all (u218): until now the doorway was the room's way out (the pathfinder does not open doors). From outside it.
        if (!door) {
          const dl = plan.ops.find((q) => q.tag === 'door' && !q.states.upper_block_bit), du = plan.ops.find((q) => q.tag === 'door' && q.states.upper_block_bit);
          await byHand(dl, 'wooden_door', async () => { door = await placeDoor(dim, off, dl, du, notes); return !!door?.ok; });
        }
        if (partStats.command) notes.push(`${partStats.command} parts were put in by command, not by the bot's hand (it could not get to them, or the game has no item by that name): ${partStats.missing.slice(0, 6).join('; ')}.`);
        notes.push(`The parts (hoppers, chests, stair, campfires, signs, lava, beds, torches, gates, door, the water) by the bot's hand: ${partStats.hand}${partStats.command ? `, ${partStats.command} by command` : ', all of them'}. The villagers are summoned (it does not bring them).`);
        return;
      }
      J.phase = `layer ${y}: the parts`;
      // (carrying on after a stop: what is in already is left as it is)
      for (const o of plain(y)) if (hands.blockAt(o) !== o.id) await byHand(o, o.id, setOp(o));
      // The hallway water once the campfires are in (they keep it in its four cells).
      if (y === CHAMBER_WATER.y) {
        const camps = CAMPFIRES.every((c) => hands.blockAt(c) === 'campfire');
        const cw = rest.find((o) => o.tag === 'cwater');
        if (camps && cw) await byHand(cw, 'water', setOp(cw), { reach: 5, bucket: true });
      }
      // The signs that hold the lava, and the lava, once the hallway walls are up to the lava's height (later it cannot get to them).
      if (y === LAVA.y && !signs) {
        const signsIn = SIGNS.every((q) => /wall_sign$/.test(hands.blockAt(q) ?? ''));
        signs = signsIn ? { ok: true, lavaOk: true, id: hands.blockAt(SIGNS[0]) } : await placeSigns(dim, off, notes, visit);
        const lava = rest.find((o) => o.tag === 'lava');
        if (lava) {
          if (!signs?.lavaOk) notes.push('The lava was NOT placed: the signs that hold it would not stay on their wall (see above).');
          else if (hands.blockAt(lava) !== 'lava') await byHand(lava, 'lava', setOp(lava), { reach: 5, bucket: true });
        }
      }
      if (y === GATES[0].y && !gates) {
        const gatesIn = GATES.every((q) => /fence_gate$/.test(hands.blockAt(q) ?? ''));
        gates = gatesIn ? { ok: true, id: hands.blockAt(GATES[0]), open: GATES.length, there: GATES.length } : await placeGates(dim, off, notes, visit);
      }
      // The platform water, poured from the wall tops once the walls are up (the gates are already in).
      if (y === PLATFORM.y2 && (gates?.there ?? 0) === GATES.length) {
        J.phase = 'pouring the platform water';
        const srcs = waterSources().map((c) => ({ x: c.x, y: WATER_Y, z: c.z }));
        // (round the walls in order, the way a player walks it)
        const ring = (c) => (c.z === PLATFORM.z1 ? c.x : c.x === PLATFORM.x2 ? 100 + c.z : c.z === PLATFORM.z2 ? 300 - c.x : 400 - c.z);
        for (const c of srcs.sort((a, b) => ring(a) - ring(b))) {
          await byHand(c, 'water', () => run(dim, `setblock ${W(off, c).x} ${W(off, c).y} ${W(off, c).z} water`) === '', { reach: 5, bucket: true });
        }
      }
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
    const pctHand = Math.round((100 * stats.hand) / Math.max(1, stats.cells - stats.already));
    const rate = stats.handTicks ? (20 * stats.hand) / stats.handTicks : 0;
    const lead = `The bot placed ${stats.hand} of ${stats.cells - stats.already} blocks itself (${pctHand}%) in ${mins(system.currentTick - J.started)}, ${HAND_NAME[mode]}, ${rate.toFixed(1)} blocks a second while placing (you, building fast: about 5.5); ${stats.command} were set by command (${stats.footing} to have something to stand on${stats.fallback + stats.repaired ? `, ${stats.fallback + stats.repaired} that would not go down by hand` : ''}${stats.gaveUp ? `; it gave up placing by hand: ${stats.gaveUp}` : ''}). `;
    notes.push(`On its own feet the whole build: ${stats.standMoves} places to build from, ${stats.scaffoldUp ?? 0} blocks of scaffolding pillared or bridged and ${stats.scaffoldDown ?? 0} taken down again${stats.escapes ? `; it walled itself in ${stats.escapes} times and broke its way out (${stats.broken} blocks, ${stats.putBack} put back by hand, the rest by command)` : ''}.`);
    if (stats.strays) notes.push(`${stats.strays} blocks were left where the plan has none (a slip of the hand, scaffolding it could not get to) and were taken out by command.`);
    const lenient = agent.homestead.placedLenient ?? 0;
    if (lenient) notes.push(`${lenient} of the quick hand's blocks went in on a clear line to the face though the crosshair had not reported settling on it.`);
    if (swept) notes.push(`${swept} monsters that turned up round the site were taken away while it built.`);
    J.report = lead;
    await finishBuild({ p, dim, off, plan, found: { cols: [] }, fails, notes, slab: slabSpell, slabCells, signs, door, gates, lead, extra: `Standing on a pad at y ${off.y + PAD.y} (${PAD.x2 - PAD.x1 + 1} x ${PAD.z2 - PAD.z1 + 1}); "!bot buildfarm clearpad" takes it away once the farm is cleared.` });
    J.finished = true;
    try { await S.goNear(gen, W(off, OUT_VIEW), 2, 2); } catch (e) { if (aborted(e)) throw e; }
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
    try { system.clearRun(sweeper); } catch { /* */ }
    agent.testHold = testHeld;
    agent.digCost = undefined;
    agent.reserveExtra = undefined;
    try { /** @type {any} */ (sim).stopBuild?.(); } catch { /* */ }
    try { agent.motor.setFocus(null); } catch { /* */ }
    try { container(sim)?.clearAll(); restoreKit(sim, { slots: saved.slots, worn: {} }); } catch (e) { say(`Could not put the bot's things back: ${e}. They are in the world's memory and come back at the next spawn.`); }
    agent.kitHeld = false;
    try { agent.saveKit(); } catch { /* */ }
    if (gen === agent.taskGen) agent.newTask(null);
    if (J.finished) { try { dim.runCommand(`tickingarea remove ${AREA}`); } catch { /* */ } }
  }
}
