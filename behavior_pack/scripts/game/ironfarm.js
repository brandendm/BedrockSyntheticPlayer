// `!bot ironfarm`: puts the iron golem farm of core/ironfarm.js into the world in one go with game commands. The bot is not involved (it works
// with no bot spawned): this is for looking at the design and testing the mechanics. The farm is a tower on the ground where you stand (u209):
// a 16 x 16 open platform up top where the golems spawn, a hole in its middle, a shaft down to a kill chamber (lava on signs, campfires) and a
// small room at the bottom with a window onto it, a door, and a double chest. You stand at the bottom, not up in the sky. Slabs cover every bare
// top so the platform is the only place golems can spawn; the builder then READS the real blocks with the game's spawn rule and says how many
// spots there are on the platform and anywhere else. Nothing of the world is overwritten but air up there (`force` replaces whatever is in the way).
//
//   !bot ironfarm              build it (and teleport you into the room at the bottom)
//   !bot ironfarm clear        take it away again
//   !bot ironfarm status       what is there and what has happened (blocks, water, lava, villagers, golems, chests)
//   !bot ironfarm bill         what it would take to build it by hand in survival
//   !bot ironfarm scan         read the real blocks round the village centre: where could a golem spawn?
//   !bot ironfarm view [pod|top|out]  back to the room (or in among the villagers, on the platform's west wall, outside the door)
//   !bot ironfarm water on|off|kick   the platform's water sources: off drains the platform; on / kick put them back and make sure they flow
//   !bot ironfarm lava on|off  the lava over the kill chamber (off if something goes wrong with it)
//   !bot ironfarm villagers    new villagers (adults only, nitwits removed)
//   !bot ironfarm build force  build even if something is in the way (or the ground is uneven)
// Test aids (game/ironfarm_aids.js):
//   !bot ironfarm time day|night|noon|midnight|set N|fast N|normal      the time of day, or the clock x N
//   !bot ironfarm speed N|normal       random ticks x N (gamerule), the game's own `tick rate` if this version has it, else the clock
//   !bot ironfarm golem [n]|auto [s]|off   golems made on the platform at once (or every s seconds): tests everything after the spawn
//
// Water placed by a command may not start to flow (the game wants a source to get a block update), so after placing it this counts the water on
// the platform and, until every cell has it: gives some sources a block update from a neighbour; takes the sources out and puts them back; and as
// the last resort lays the flowing water by hand, a cell at a time at the depth it would have. It says which one worked. The lava is placed only
// once the signs that hold it (and the signs that stop the water going down the shaft) have been seen to stay on their wall.
//
// Tip: `/gamemode spectator` flies through the stone to look at the inside.
import { system, world } from '@minecraft/server';
import {
  ironFarmPlan, checkPlan, blockArg, materials, STAND, POD_VIEW, TOP_VIEW, OUT_VIEW, CHESTS, PLATFORM, LAVA, SIGNS, CAMPFIRES, WATER_Y, BASE_Y,
  SPAWN_COLUMNS, SHAFT_SHELL, ROOM_SHELL,
} from '../core/ironfarm.js';
import { say, wait, W, run, idAt, stateAt, chestSize, scanSpawnSpots, PLANT } from './ironfarm_world.js';
import {
  VILLAGERS, findSlab, placeSigns, placeDoor, pairChests, ensureWater, waterOnPlatform, shaftWater, verify, spawnVillagers, isBaby,
} from './ironfarm_parts.js';
import { timeCommand, speedCommand, golemCommand, fastTime } from './ironfarm_aids.js';

/** @type {null | { dim: any, off: {x:number,y:number,z:number}, plan: any, builtAt: number, waterOn: boolean, lavaOn: boolean, seen: Map<string, any>, ironSeen: number, watcher: number, villagerNote: string, buildNote: string, waterNote: string, announced: Set<number>, slab: string|null, slabCells: number, signId: string|null, ticks: number, warned: Set<string>, test: Set<string>, auto: number, foundation: any[], door: any, chestNote: string, scanNote: string }} */
let farm = null;

export function ironFarmCommand(player, args) {
  const sub = (args[0] ?? 'build').toLowerCase();
  const p = player ?? world.getPlayers()[0];
  if (!p) return say('No player to build it for.');
  const go = async () => {
    if (sub === 'build' || sub === 'force' || sub === 'here') return build(p, args.includes('force') || sub === 'force');
    if (sub === 'clear' || sub === 'remove') return clear(true);
    if (sub === 'status') return status();
    if (sub === 'bill' || sub === 'materials') return say(`Materials for a survival build: ${materials(ironFarmPlan()).text}.`);
    if (sub === 'view') return view(p, args[1]);
    if (sub === 'water') return water(args[1]);
    if (sub === 'lava') return lava(args[1]);
    if (sub === 'villagers') return villagers();
    if (sub === 'scan') return scan();
    if (sub === 'time') return timeCommand(p.dimension, args.slice(1));
    if (sub === 'speed' || sub === 'tick') return speedCommand(p.dimension, args.slice(1));
    if (sub === 'golem' || sub === 'golems') return golemCommand(farm, args.slice(1));
    say('Commands: build [force], clear, status, bill, scan, view [pod|top|out], water on|off|kick, lava on|off, villagers; test aids: time day|night|noon|midnight|set N|fast N|normal, speed N|normal, golem [n]|auto [s]|off.');
  };
  go().catch((e) => say(`failed: ${e}\n${e?.stack ?? ''}`));
}

// ---- where it goes ----
/** The terrain's top block in each column of the ground within reach of the spawn volume (plan columns SPAWN_COLUMNS, shifted by `off`). */
function surveyGround(dim, off) {
  const tops = new Map();
  let top = -Infinity;
  const S = SPAWN_COLUMNS;
  for (let x = S.x1; x <= S.x2; x++) for (let z = S.z1; z <= S.z2; z++) {
    try { const b = dim.getTopmostBlock({ x: x + off.x, z: z + off.z }); if (b) { tops.set(`${x},${z}`, b.y); top = Math.max(top, b.y); } } catch { /* an unloaded column */ }
  }
  return { top, tops, columns: tops.size };
}

/** The columns under the shaft and the room (and the step): a foundation goes in wherever the ground is lower than the tower's floor. */
function foundationColumns(tops, baseY, off) {
  const out = [];
  let gap = 0;
  for (let x = SHAFT_SHELL.x1; x <= ROOM_SHELL.x2 + 1; x++) for (let z = SHAFT_SHELL.z1 - 1; z <= ROOM_SHELL.z2; z++) {
    const t = tops.get(`${x},${z}`);
    if (t === undefined || t + 1 >= baseY) continue;
    out.push({ x: x + off.x, z: z + off.z, y1: t + 1, y2: baseY - 1 });
    gap = Math.max(gap, baseY - 1 - t);
  }
  return { cols: out, gap };
}

async function build(p, force) {
  if (farm) await clear(false);
  const plan = ironFarmPlan();
  const problems = checkPlan(plan);
  if (problems.length) return say(`The plan fails its own checks (${problems.slice(0, 3).join('; ')}): not building.`);
  const bd = plan.bounds;
  const mid = { x: Math.round((bd.x1 + bd.x2) / 2), z: Math.round((bd.z1 + bd.z2) / 2) };
  const dim = p.dimension;
  const off = { x: Math.floor(p.location.x) - mid.x, y: 0, z: Math.floor(p.location.z) - mid.z };
  // The ground: the tower's floor goes just above the highest ground within reach of the spawn volume (golems spawn on ground too, and mobs
  // come in from it), which is where you stand if the ground is level.
  const ground = surveyGround(dim, off);
  const stood = Math.floor(p.location.y);
  const baseY = ground.columns ? ground.top + 1 : stood;
  off.y = baseY - BASE_Y;
  const lo = W(off, { x: bd.x1, y: bd.y1, z: bd.z1 }), hi = W(off, { x: bd.x2, y: bd.y2, z: bd.z2 });
  if (hi.y > 319) return say(`Too high up here: the ground reaches y ${ground.top}, and the tower is ${bd.y2 - bd.y1 + 1} tall. Try somewhere lower.`);
  const found = foundationColumns(ground.tops, baseY, off);
  const rise = baseY - stood;
  if (!force && (found.gap > 12 || rise > 6)) return say(`The ground here is uneven: the tower's floor would be ${rise} blocks above where you stand and ${found.gap} above the lowest ground under the room. Stand somewhere flatter, or "ironfarm build force".`);
  let uneven = '';
  if (rise > 1) uneven = ` The ground rises ${rise} blocks round here, so the tower's floor is ${rise} above where you stood: the door is up there${found.cols.length ? ` (${found.cols.length} columns of cobblestone put under the room)` : ''}.`;
  // Something in the way? A grid of samples through the box (plants do not count: the floor goes where they are).
  if (!force) {
    const hits = [];
    for (let i = 0; i <= 5; i++) for (let j = 0; j <= 5; j++) for (let k = 0; k <= 5; k++) {
      const q = { x: Math.round(lo.x + (hi.x - lo.x) * i / 5), y: Math.round(lo.y + (hi.y - lo.y) * j / 5), z: Math.round(lo.z + (hi.z - lo.z) * k / 5) };
      let id = 'air';
      try { id = (dim.getBlock(q)?.typeId ?? 'unloaded').replace('minecraft:', ''); } catch { id = 'unloaded'; }
      if (id !== 'air' && !PLANT.test(id)) hits.push(`${id} at ${q.x} ${q.y} ${q.z}`);
    }
    if (hits.length) return say(`Something is in the way (${hits.slice(0, 3).join(', ')}${hits.length > 3 ? `, ${hits.length - 3} more` : ''}). Run "ironfarm build force" to replace it.`);
  }
  say(`Building at ${lo.x} ${lo.y} ${lo.z} to ${hi.x} ${hi.y} ${hi.z} (${plan.ops.length} steps), the tower's floor on the ground at y ${baseY}.${uneven}`);
  /** @type {string[]} */
  const fails = [];
  const notes = [];
  for (const c of found.cols) run(dim, `fill ${c.x} ${c.y1} ${c.z} ${c.x} ${c.y2} ${c.z} cobblestone`);
  let slab = null, slabTried = false, slabCells = 0, signs = null, door = null;
  for (const o of plan.ops) {
    if (o.tag === 'water') continue;                    // below, with the checks
    if (o.tag === 'sign') {                             // all the signs together, once, with their checks
      if (!signs) signs = await placeSigns(dim, off, notes);
      continue;
    }
    if (o.tag === 'door') {                             // both halves together, once
      if (!door) door = await placeDoor(dim, off, plan.ops.find((q) => q.tag === 'door' && !q.states.upper_block_bit), plan.ops.find((q) => q.tag === 'door' && q.states.upper_block_bit), notes);
      continue;
    }
    let cmd;
    const a = o.op === 'fill' ? W(off, { x: o.box.x1, y: o.box.y1, z: o.box.z1 }) : W(off, o);
    const b = o.op === 'fill' ? W(off, { x: o.box.x2, y: o.box.y2, z: o.box.z2 }) : a;
    const cells = o.op === 'fill' ? (o.box.x2 - o.box.x1 + 1) * (o.box.y2 - o.box.y1 + 1) * (o.box.z2 - o.box.z1 + 1) : 1;
    if (o.tag === 'slab') {
      if (!slabTried) { slabTried = true; slab = await findSlab(dim, a, b, notes); if (slab) slabCells += cells; continue; }   // (the first one is placed by the search)
      if (!slab) continue;
      cmd = `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${slab}`;
      if (!run(dim, cmd)) slabCells += cells; else fails.push(`${o.note}: ${cmd}`);
      continue;
    }
    if (o.tag === 'lava') {
      if (!signs?.ok) { notes.push('The lava was NOT placed: the signs that hold it (or the ones over the hole) would not stay on their wall (see above).'); continue; }
      cmd = `setblock ${a.x} ${a.y} ${a.z} lava`;
    } else if (o.op === 'fill') cmd = `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${o.id}`;
    else cmd = `setblock ${a.x} ${a.y} ${a.z} ${blockArg(o.id, o.states)}`;
    const why = run(dim, cmd);
    if (why) fails.push(`${o.note || o.id}: ${why} (${cmd})`);
    if (o.op === 'fill' && o.id === 'cobblestone') await wait(2);
  }
  await wait(5);
  farm = { dim, off, plan, builtAt: system.currentTick, waterOn: true, lavaOn: !!signs?.ok, seen: new Map(), ironSeen: 0, watcher: -1, villagerNote: '', buildNote: '', waterNote: '', announced: new Set(), slab, slabCells, signId: signs?.id ?? null, ticks: 0, warned: new Set(), test: new Set(), auto: -1, foundation: found.cols, door, chestNote: '', scanNote: '' };
  if (signs && !signs.holeOk) notes.push('The signs over the hole did not stay: water will run down the shaft. Not putting the water in.');
  const chests = await pairChests(dim, off);
  farm.chestNote = chests.note;
  const w = signs?.holeOk ? await ensureWater(dim, off, plan) : { ok: false, note: 'Water: not placed (the signs over the hole are missing).' };
  farm.waterOn = !!signs?.holeOk;
  farm.waterNote = w.note;
  const checks = verify(dim, off, plan);
  const sc = scanReport(dim, off, plan);
  farm.scanNote = sc.text;
  const vil = await spawnVillagers(dim, off, plan);
  farm.villagerNote = vil.note;
  try { p.teleport(W(off, STAND), { facingLocation: W(off, { x: 8, y: STAND.y + 1.2, z: 7.5 }), dimension: dim }); } catch (e) { say(`Could not teleport you: ${e}`); }
  farm.watcher = system.runInterval(() => watch(), 40);
  farm.buildNote = notes.join(' ');
  say(`Built. ${fails.length ? `${fails.length} commands failed: ${fails.slice(0, 4).join(' | ')}` : 'Every command went through.'} ${checks.length ? `Not as planned: ${checks.join('; ')}.` : 'Everything checked out when read back.'}`);
  if (notes.length) say(notes.join(' '));
  say(w.note);
  say(`${chests.note} ${door?.ok ? `Door in (direction ${door.direction}): if it stands across the doorway instead of in it, tell me.` : ''}`);
  say(`Slabs: ${slabCells} placed on bare tops (${slab ?? 'none'}), none on the platform floor. ${sc.text}`);
  say(vil.note);
  say('You are in the room at the bottom: the kill chamber is through the glass ahead, the double chest at your feet, the door behind you (east). "!bot ironfarm view top" puts you on the platform wall, "view out" outside the door. Villagers count as working only after a day of it: "!bot ironfarm time fast 20" runs the clock, "!bot ironfarm golem" puts a golem on the platform now to watch the rest working. "!bot ironfarm status" says how it is going, "!bot ironfarm bill" what it would cost in survival.');
}

/** Read the real blocks round the centre (both rounding readings of it) with the golem-spawn rule: how many spots are on the platform, how many elsewhere. */
function scanReport(dim, off, plan) {
  const c = plan.centres[0];
  const readings = [{ x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) }, { x: Math.ceil(c.x), y: Math.ceil(c.y), z: Math.ceil(c.z) }];
  const parts = [];
  let elsewhere = 0, platform = 0, unloaded = 0;
  for (const k of readings) {
    const r = scanSpawnSpots(dim, W(off, k));
    const onPlat = (s) => s.y - off.y === WATER_Y && s.x - off.x >= PLATFORM.x1 && s.x - off.x <= PLATFORM.x2 && s.z - off.z >= PLATFORM.z1 && s.z - off.z <= PLATFORM.z2;
    const here = r.spots.filter(onPlat).length, other = r.spots.filter((s) => !onPlat(s));
    platform = here; elsewhere += other.length; unloaded += r.unloaded;
    parts.push(`centre ${k.x},${k.y},${k.z}: ${here} on the platform, ${other.length} elsewhere${other.length ? ` (e.g. ${other.slice(0, 3).map((s) => `${s.x - off.x},${s.y - off.y},${s.z - off.z}`).join(' ')} in plan coordinates)` : ''}`);
  }
  return { text: `Golem spawn spots (the game's rule, read from the real blocks): ${parts.join('; ')}.${unloaded ? ` (${unloaded} unloaded cells were skipped.)` : ''}`, platform, elsewhere };
}

function scan() {
  if (!farm) return say('No farm.');
  const sc = scanReport(farm.dim, farm.off, farm.plan);
  farm.scanNote = sc.text;
  say(sc.text);
}

async function villagers() {
  if (!farm) return say('No farm.');
  const { dim, off, plan } = farm;
  const c = W(off, plan.centre);
  let n = 0;
  for (const t of VILLAGERS) { try { for (const e of dim.getEntities({ type: t, location: c, maxDistance: 20 })) { e.kill(); n++; } } catch { /* */ } }
  await wait(5);
  const v = await spawnVillagers(dim, off, plan);
  farm.villagerNote = v.note;
  say(`Replaced ${n} villagers. ${v.note}`);
}

async function clear(announce) {
  if (!farm) { if (announce) say('No farm.'); return; }
  const { dim, off, plan } = farm;
  try { system.clearRun(farm.watcher); } catch { /* */ }
  if (farm.auto >= 0) { try { system.clearRun(farm.auto); } catch { /* */ } }
  const c = plan.bounds, cen = W(off, plan.centre);
  for (const t of [...VILLAGERS, 'minecraft:iron_golem', 'minecraft:item']) { try { for (const e of dim.getEntities({ type: t, location: cen, maxDistance: 30 })) { try { e.remove(); } catch { /* */ } } } catch { /* */ } }
  const lo = W(off, { x: c.x1, y: c.y1, z: c.z1 }), hi = W(off, { x: c.x2, y: c.y2, z: c.z2 });
  // The lava and the water go first, so they do not run when the walls go.
  const l = W(off, LAVA);
  run(dim, `setblock ${l.x} ${l.y} ${l.z} air`);
  for (const o of plan.ops.filter((q) => q.tag === 'water')) {
    const a = W(off, { x: o.box.x1, y: o.box.y1, z: o.box.z1 }), b = W(off, { x: o.box.x2, y: o.box.y2, z: o.box.z2 });
    run(dim, `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} air`);
  }
  await wait(2);
  const why = run(dim, `fill ${lo.x} ${lo.y} ${lo.z} ${hi.x} ${hi.y} ${hi.z} air`);
  for (const f of farm.foundation) run(dim, `fill ${f.x} ${f.y1} ${f.z} ${f.x} ${f.y2} ${f.z} air`);
  farm = null;
  if (announce) say(`Cleared${why ? ` (the fill said: ${why})` : ''}.`);
}

function view(p, mode) {
  if (!farm) return say('No farm.');
  const { off, dim } = farm;
  const go = (to, look, msg) => { p.teleport(W(off, to), { facingLocation: W(off, look), dimension: dim }); say(msg); };
  if (mode === 'top') return go(TOP_VIEW, { x: 7.5, y: 4, z: 7.5 }, 'You are on the west wall of the platform, looking across and down at the hole.');
  if (mode === 'pod') return go(POD_VIEW, { x: 7.5, y: 1.5, z: 2.5 }, 'You are in the pod, among the villagers.');
  if (mode === 'out') return go(OUT_VIEW, { x: 13.5, y: -5.5, z: 7.5 }, 'You are on the ground outside the door.');
  go(STAND, { x: 8, y: STAND.y + 1.2, z: 7.5 }, 'You are in the room at the bottom.');
}

async function water(arg) {
  if (!farm) return say('No farm.');
  const { dim, off, plan } = farm;
  if (arg === 'off') {
    for (const o of plan.ops.filter((q) => q.tag === 'water')) {
      const a = W(off, { x: o.box.x1, y: o.box.y1, z: o.box.z1 }), b = W(off, { x: o.box.x2, y: o.box.y2, z: o.box.z2 });
      run(dim, `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} air`);
    }
    farm.waterOn = false;
    return say('Water sources removed: the platform drains in a few seconds.');
  }
  farm.waterOn = true;
  const w = await ensureWater(dim, off, plan);
  farm.waterNote = w.note;
  say(w.note);
}

const lavaSigns = () => SIGNS.filter((s) => s.group === 'lava');
const holeSigns = () => SIGNS.filter((s) => s.group === 'hole');

function lava(arg) {
  if (!farm) return say('No farm.');
  const q = W(farm.off, LAVA);
  if (arg === 'off') { const why = run(farm.dim, `setblock ${q.x} ${q.y} ${q.z} air`); farm.lavaOn = false; return say(`Lava removed${why ? ` (${why})` : ''}.`); }
  const gone = lavaSigns().filter((s) => !idAt(farm.dim, W(farm.off, s)).endsWith('wall_sign'));
  if (gone.length) return say(`Not putting the lava in: ${gone.length} of the ${lavaSigns().length} signs that hold it are missing.`);
  const why = run(farm.dim, `setblock ${q.x} ${q.y} ${q.z} lava`);
  farm.lavaOn = !why;
  say(`Lava back${why ? ` (${why})` : ''}.`);
}

/** What is in the chests (a double chest counted once). */
function inventoryOf(dim, off) {
  /** @type {Record<string, number>} */
  const out = {};
  const add = (c) => { for (let i = 0; c && i < c.size; i++) { const it = c.getItem(i); if (it) { const k = it.typeId.replace('minecraft:', ''); out[k] = (out[k] ?? 0) + it.amount; } } };
  try {
    const first = dim.getBlock(W(off, CHESTS[0]))?.getComponent('minecraft:inventory')?.container;
    add(first);
    if (!first || first.size < 54) add(dim.getBlock(W(off, CHESTS[1]))?.getComponent('minecraft:inventory')?.container);
  } catch { /* */ }
  return out;
}

const rel = (off, l) => `${(l.x - off.x).toFixed(1)} ${(l.y - off.y).toFixed(1)} ${(l.z - off.z).toFixed(1)}`;

function entities(dim, off, plan, type) {
  const c = W(off, plan.centre);
  try { return dim.getEntities({ type, location: c, maxDistance: 25 }); } catch { return []; }
}

function onPlatform(l, off) {
  const x = l.x - off.x, y = l.y - off.y, z = l.z - off.z;
  return x >= PLATFORM.x1 - 0.5 && x <= PLATFORM.x2 + 1.5 && z >= PLATFORM.z1 - 0.5 && z <= PLATFORM.z2 + 1.5 && y >= WATER_Y - 0.5 && y <= PLATFORM.y2 + 1;
}

/** Every two seconds: golems appearing and going, iron arriving, a sign gone, water where it should not be, and a word if nothing has happened for a while. */
function watch() {
  if (!farm) return;
  farm.ticks++;
  const { dim, off, plan } = farm;
  // The lava is only as safe as the signs: if one has burned or popped off, take the lava out before it runs over the chamber.
  if (farm.lavaOn && farm.ticks % 2 === 0) {
    const gone = lavaSigns().filter((s) => !idAt(dim, W(off, s)).endsWith('wall_sign'));
    if (gone.length) {
      const l = W(off, LAVA);
      run(dim, `setblock ${l.x} ${l.y} ${l.z} air`);
      farm.lavaOn = false;
      say(`${gone.length} of the ${lavaSigns().length} signs holding the lava is gone (${gone.map((s) => `${s.x},${s.y},${s.z}`).join(' ')}): burned by the lava or popped off? I have taken the lava out. "!bot ironfarm lava on" puts it back if the signs are back.`);
    }
  }
  // The signs over the hole keep the water out of the shaft: if one goes, the water would put out the campfires and meet the lava.
  if (farm.waterOn && farm.ticks % 2 === 0 && !farm.warned.has('holesign')) {
    const gone = holeSigns().filter((s) => !idAt(dim, W(off, s)).endsWith('wall_sign'));
    if (gone.length) {
      farm.warned.add('holesign');
      say(`${gone.length} of the ${holeSigns().length} signs over the hole is gone (${gone.map((s) => `${s.x},${s.y},${s.z}`).join(' ')}). Water would run down the shaft onto the lava and the campfires. Taking the water off: "!bot ironfarm water off" did it; put the sign back and "water on".`);
      void water('off');
    }
  }
  if (farm.waterOn && farm.ticks % 5 === 0 && !farm.warned.has('dry')) {
    const s = waterOnPlatform(dim, off, plan);
    if (s.have < s.want) { farm.warned.add('dry'); say(`The platform water has dried up: ${s.have} of ${s.want} cells wet. "!bot ironfarm water kick" tries again.`); }
  }
  if (farm.waterOn && farm.ticks % 5 === 0 && !farm.warned.has('shaft')) {
    const n = shaftWater(dim, off);
    if (n) { farm.warned.add('shaft'); say(`Water in the shaft: ${n} wet cells below the platform floor. The signs over the hole did not hold it; the campfires will be out. "!bot ironfarm status" for the rest.`); }
  }
  const golems = entities(dim, off, plan, 'minecraft:iron_golem');
  const now = new Set();
  for (const g of golems) {
    now.add(g.id);
    if (!farm.seen.has(g.id)) {
      let wet = false;
      try { wet = g.isInWater; } catch { /* */ }
      const test = farm.test.has(g.id);
      say(`${test ? 'A TEST golem has been put' : 'A golem has spawned'} at ${rel(off, g.location)} (plan coordinates; the platform is x ${PLATFORM.x1}-${PLATFORM.x2}, y ${WATER_Y}, z ${PLATFORM.z1}-${PLATFORM.z2}): ${onPlatform(g.location, off) ? 'on the platform' : 'NOT on the platform'}, ${wet ? 'in water' : 'not in water'}${test ? '' : `, after ${((system.currentTick - farm.builtAt) / 1200).toFixed(1)} min`}.`);
      farm.seen.set(g.id, { at: g.location, t: system.currentTick, test, logged: new Set() });
    }
    const s = farm.seen.get(g.id);
    s.at = g.location;
    // Where it is in its journey: on the platform, down the shaft, in the chamber (reported once each).
    const y = g.location.y - off.y;
    const stage = y < -3.5 ? 'in the chamber' : y < WATER_Y - 0.5 ? 'in the shaft' : 'on the platform';
    if (!s.logged.has(stage) && s.test) { s.logged.add(stage); say(`Test golem ${stage} (${((system.currentTick - s.t) / 20).toFixed(0)} s after it was put there).`); }
  }
  for (const [id, s] of farm.seen) {
    if (now.has(id) || s.gone) continue;
    s.gone = true;
    say(`A ${s.test ? 'test ' : ''}golem is gone (last seen at ${rel(off, s.at)}, ${((system.currentTick - s.t) / 20).toFixed(0)} s after it ${s.test ? 'was put there' : 'spawned'}).`);
  }
  const inv = inventoryOf(dim, off);
  const iron = (inv.iron_ingot ?? 0);
  if (iron > farm.ironSeen) { say(`Iron in the chest: ${iron} (${Object.entries(inv).map(([k, v]) => `${v} ${k}`).join(', ')}).`); farm.ironSeen = iron; }
  const mins = Math.floor((system.currentTick - farm.builtAt) / 1200);
  if (![...farm.seen.values()].some((s) => !s.test) && [5, 15, 30, 60, 120].includes(mins) && !farm.announced.has(mins)) {
    farm.announced.add(mins);
    const n = VILLAGERS.reduce((a, t) => a + entities(dim, off, plan, t).length, 0);
    say(`${mins} minutes and no golem spawned yet (${n} villagers in the farm). "!bot ironfarm status" for the rest.`);
  }
}

function status() {
  if (!farm) return say('No farm.');
  const { dim, off, plan } = farm;
  const vs = VILLAGERS.flatMap((t) => entities(dim, off, plan, t));
  const babies = vs.filter(isBaby).length;
  const golems = entities(dim, off, plan, 'minecraft:iron_golem');
  const inv = inventoryOf(dim, off);
  const checks = verify(dim, off, plan);
  const w = waterOnPlatform(dim, off, plan);
  let time = '';
  try { time = ` day ${Math.floor(world.getAbsoluteTime() / 24000)}, time ${world.getTimeOfDay()}${fastTime() > 1 ? ` (clock x${fastTime()})` : ''}`; } catch { /* */ }
  const b = plan.bounds;
  const camp = CAMPFIRES.map((c) => (idAt(dim, W(off, c)) === 'campfire' ? (stateAt(dim, W(off, c), 'extinguished') === true ? 'out' : 'lit') : idAt(dim, W(off, c))).toString()).join('/');
  const size = chestSize(dim, W(off, CHESTS[0]));
  say(`Built ${((system.currentTick - farm.builtAt) / 1200).toFixed(1)} min ago at ${off.x + b.x1} ${off.y + b.y1} ${off.z + b.z1} (the corner of its box);${time}. Villagers in it: ${vs.length} (${babies} babies). Golems alive: ${golems.length}; seen so far: ${farm.seen.size}. Chest (${size === 54 ? 'double' : `${size} slots`}): ${Object.keys(inv).length ? Object.entries(inv).map(([k, v]) => `${v} ${k}`).join(', ') : 'empty'}. Water ${farm.waterOn ? 'on' : 'off'}: ${w.have} of ${w.want} platform cells wet, hole depth ${w.hole ?? 'none'}; ${shaftWater(dim, off)} wet cells in the shaft. Lava ${farm.lavaOn ? 'on' : 'off'}. Campfires ${camp}. Door: ${farm.door?.ok ? 'in' : 'NOT in (open doorway)'}. Slabs: ${farm.slabCells} placed (${farm.slab ?? 'none'}). ${checks.length ? `Not as planned: ${checks.join('; ')}.` : 'Blocks as planned.'} Village centre by my reckoning: ${plan.centre.x} ${plan.centre.y} ${plan.centre.z} plan, ${plan.centre.x + off.x} ${plan.centre.y + off.y} ${plan.centre.z + off.z} in the world. ${farm.scanNote} ${farm.villagerNote}`);
}

