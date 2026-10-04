// `!bot ironfarm`: puts the iron golem farm of core/ironfarm.js into the world in one go with game commands. The bot is not involved (it works
// with no bot spawned): this is for looking at the design and testing the mechanics. The farm goes in the sky above whoever asks (20 blocks
// up, or higher if there is ground in the way: golems also spawn on ground), as a hollow shell of cobblestone round three rooms with slabs on
// every bare roof, so the platform is the only place golems can spawn. Nothing of the world is overwritten but air up there (`force` replaces
// whatever is in the way).
//
//   !bot ironfarm              build it (and teleport you into the viewing room)
//   !bot ironfarm clear        take it away again
//   !bot ironfarm status       what is there and what has happened (blocks, water, lava, villagers, golems, chest)
//   !bot ironfarm bill         what it would take to build it by hand in survival
//   !bot ironfarm view [pod|top]  back to the viewing room (or in among the villagers, or on the platform's west wall looking in from above)
//   !bot ironfarm water on|off|kick   the platform's water source: off drains the platform; on / kick put it
//                              back and make sure it flows (see below)
//   !bot ironfarm lava on|off  the lava over the kill corner (off if something goes wrong with it)
//   !bot ironfarm villagers    new villagers (adults only, nitwits removed)
//   !bot ironfarm build force  build even if something is in the way
//
// Water placed by a command may not start to flow (the game wants the source to get a block update), so after placing it this counts the
// water on the platform and, until all 16 cells have it: gives the source a block update from a neighbour; takes the source out and puts it
// back; and as the last resort lays the flowing water by hand, a cell at a time at the depth it would have. It says which one worked. The
// lava is placed only once the signs that hold it have been seen to stay on their wall.
//
// Tip: `/gamemode spectator` flies through the stone to look at the inside.
import { system, world } from '@minecraft/server';
import { ironFarmPlan, checkPlan, blockArg, waterField, render, materials, KILL, SOURCE, STAND, POD_VIEW, CHEST, PLATFORM, LAVA, SIGNS, SPAWN_VOLUME } from '../core/ironfarm.js';

const TAG = '§b[IronFarm]§r';
const VILLAGERS = ['minecraft:villager_v2', 'minecraft:villager'];
const WANT = 10;
/** Ways the cobblestone slab is spelt in the game's block names, tried in this order until one is accepted. */
const SLAB_IDS = ['cobblestone_slab', 'stone_block_slab ["stone_slab_type"="cobblestone"]', 'oak_slab', 'wooden_slab'];
const SIGN_IDS = ['wall_sign', 'oak_wall_sign', 'spruce_wall_sign'];
const OPPOSITE = { 2: 3, 3: 2, 4: 5, 5: 4 };

/** @type {null | { dim: any, off: {x:number,y:number,z:number}, plan: any, builtAt: number, waterOn: boolean, lavaOn: boolean, seen: Map<string, any>, ironSeen: number, watcher: number, villagerNote: string, buildNote: string, waterNote: string, announced: Set<number>, slab: string|null, signId: string|null, ticks: number, warned: Set<string> }} */
let farm = null;

const say = (m) => { try { world.sendMessage(`${TAG} ${m}`); } catch { /* */ } console.warn(`[ironfarm] ${m}`); };
const wait = (n) => system.waitTicks(n);
const W = (o, p) => ({ x: p.x + o.x, y: p.y + o.y, z: p.z + o.z });

/** Run a command; returns '' if it worked, else why not. */
function run(dim, cmd) {
  try {
    const r = dim.runCommand(cmd);
    if (r && r.successCount === 0) return 'did nothing';
    return '';
  } catch (e) { return String(e).slice(0, 120); }
}

const idAt = (dim, q) => { try { return (dim.getBlock(q)?.typeId ?? 'unloaded').replace('minecraft:', ''); } catch { return 'unloaded'; } };
const stateAt = (dim, q, name) => { try { return dim.getBlock(q)?.permutation.getState(name); } catch { return undefined; } };
const isWater = (id) => id === 'water' || id === 'flowing_water';

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
    say('Commands: build, clear, status, bill, view [pod|top], water on|off|kick, lava on|off, villagers.');
  };
  go().catch((e) => say(`failed: ${e}\n${e?.stack ?? ''}`));
}

/** The highest block in each column of the spawn volume's footprint round the farm: ground in the volume is a place golems could spawn. */
function groundTop(dim, centre) {
  let top = -Infinity, columns = 0;
  for (let x = centre.x - SPAWN_VOLUME.rx - 1; x <= centre.x + SPAWN_VOLUME.rx + 1; x++) for (let z = centre.z - SPAWN_VOLUME.rz - 1; z <= centre.z + SPAWN_VOLUME.rz + 1; z++) {
    try { const b = dim.getTopmostBlock({ x, z }); if (b) { top = Math.max(top, b.y); columns++; } } catch { /* an unloaded column */ }
  }
  return { top, columns };
}

async function build(p, force) {
  if (farm) await clear(false);
  const plan = ironFarmPlan();
  const problems = checkPlan(plan);
  if (problems.length) return say(`The plan fails its own checks (${problems.slice(0, 3).join('; ')}): not building.`);
  const bd = plan.bounds;
  const mid = { x: Math.round((bd.x1 + bd.x2) / 2), y: Math.round((bd.y1 + bd.y2) / 2), z: Math.round((bd.z1 + bd.z2) / 2) };
  const dim = p.dimension;
  const off = { x: Math.floor(p.location.x) - mid.x, y: Math.floor(p.location.y) + 20 - mid.y, z: Math.floor(p.location.z) - mid.z };
  // Ground inside the spawn volume would be a place for golems to spawn (and a way in for everything else): keep the volume clear of it.
  const ground = groundTop(dim, W(off, plan.centre));
  let raised = '';
  if (ground.columns && plan.centre.y + off.y - SPAWN_VOLUME.ry < ground.top + 4) {
    off.y = ground.top + 4 + SPAWN_VOLUME.ry - plan.centre.y;
    raised = ` Raised to clear the ground (it reaches y ${ground.top} here).`;
  }
  const lo = W(off, { x: bd.x1, y: bd.y1, z: bd.z1 }), hi = W(off, { x: bd.x2, y: bd.y2, z: bd.z2 });
  if (hi.y > 316) return say(`Too high up here: the ground reaches y ${ground.top}, and the farm needs to be 10 above it. Try somewhere lower.`);
  // Something in the way? A grid of samples through the box.
  if (!force) {
    const hits = [];
    for (let i = 0; i <= 5; i++) for (let j = 0; j <= 5; j++) for (let k = 0; k <= 5; k++) {
      const q = { x: Math.round(lo.x + (hi.x - lo.x) * i / 5), y: Math.round(lo.y + (hi.y - lo.y) * j / 5), z: Math.round(lo.z + (hi.z - lo.z) * k / 5) };
      let id = 'air';
      try { id = dim.getBlock(q)?.typeId ?? 'unloaded'; } catch { id = 'unloaded'; }
      if (id !== 'minecraft:air') hits.push(`${id.replace('minecraft:', '')} at ${q.x} ${q.y} ${q.z}`);
    }
    if (hits.length) return say(`Something is in the way up there (${hits.slice(0, 3).join(', ')}${hits.length > 3 ? `, ${hits.length - 3} more` : ''}). Run "ironfarm build force" to replace it.`);
  }
  say(`Building at ${lo.x} ${lo.y} ${lo.z} to ${hi.x} ${hi.y} ${hi.z} (${plan.ops.length} steps).${raised}`);
  /** @type {string[]} */
  const fails = [];
  const notes = [];
  let slab = null, slabTried = false, signs = null;
  for (const o of plan.ops) {
    if (o.tag === 'water') continue;                    // below, with the checks
    if (o.tag === 'sign') {                             // the three together, once, with their checks
      if (!signs) signs = await placeSigns(dim, off, notes);
      continue;
    }
    let cmd;
    if (o.op === 'fill') {
      const a = W(off, { x: o.box.x1, y: o.box.y1, z: o.box.z1 }), b = W(off, { x: o.box.x2, y: o.box.y2, z: o.box.z2 });
      if (o.tag === 'slab') {
        if (!slabTried) { slabTried = true; slab = await findSlab(dim, a, b, notes); continue; }   // (the first run is placed by the search)
        if (!slab) continue;
        cmd = `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${slab}`;
      } else cmd = `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${o.id}`;
    } else {
      const q = W(off, o);
      if (o.tag === 'lava') {
        if (!signs?.ok) { notes.push('The lava was NOT placed: the signs that hold it would not stay on their wall (see above).'); continue; }
        cmd = `setblock ${q.x} ${q.y} ${q.z} lava`;
      } else cmd = `setblock ${q.x} ${q.y} ${q.z} ${blockArg(o.id, o.states)}`;
    }
    const why = run(dim, cmd);
    if (why) fails.push(`${o.note || o.id}: ${why} (${cmd})`);
    if (o.op === 'fill' && o.id === 'cobblestone') await wait(2);
  }
  await wait(5);
  farm = { dim, off, plan, builtAt: system.currentTick, waterOn: true, lavaOn: !!signs?.ok, seen: new Map(), ironSeen: 0, watcher: -1, villagerNote: '', buildNote: '', waterNote: '', announced: new Set(), slab, signId: signs?.id ?? null, ticks: 0, warned: new Set() };
  const w = await ensureWater(dim, off, plan);
  farm.waterNote = w.note;
  const checks = verify(dim, off, plan);
  const vil = await spawnVillagers(dim, off, plan);
  farm.villagerNote = vil.note;
  try { p.teleport(W(off, { x: STAND.x, y: STAND.y, z: STAND.z }), { facingLocation: W(off, { x: STAND.x, y: STAND.y + 1.5, z: STAND.z - 6 }), dimension: dim }); } catch (e) { say(`Could not teleport you: ${e}`); }
  farm.watcher = system.runInterval(() => watch(), 40);
  farm.buildNote = notes.join(' ');
  say(`Built. ${fails.length ? `${fails.length} commands failed: ${fails.slice(0, 4).join(' | ')}` : 'Every command went through.'} ${checks.length ? `Not as planned: ${checks.join('; ')}.` : 'Everything checked out when read back.'}`);
  if (notes.length) say(notes.join(' '));
  say(w.note);
  say(vil.note);
  say('You are in the viewing room: the platform (open to the sky) is through the glass ahead, the chest at your feet; "!bot ironfarm view top" puts you on its wall to look down into it. A day or two of waiting may be needed: villagers count as working only after a day of it. "!bot ironfarm status" says how it is going, "!bot ironfarm bill" what it would cost in survival.');
}

/** Find a spelling of the cobblestone slab the game accepts: the first slab run is tried with each, and read back. */
async function findSlab(dim, a, b, notes) {
  for (const cand of SLAB_IDS) {
    const why = run(dim, `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${cand}`);
    await wait(1);
    if (!why && idAt(dim, a).includes('slab')) return cand;
    run(dim, `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} air`);
  }
  notes.push('NO slab spelling was accepted: the bare roofs are not covered, so golems may also spawn on them.');
  return null;
}

/**
 * The three wall signs that hold the lava. Each is placed facing the way the plan says, given a block update from a neighbour (a sign with
 * nothing to hang on stays until it gets one), and read back; if it is gone the other way round is tried, then the next spelling of the name.
 */
async function placeSigns(dim, off, notes) {
  let id = null, flip = false;
  const done = [];
  for (const s of SIGNS) {
    const q = W(off, s);
    let ok = false;
    for (const cand of id ? [id] : SIGN_IDS) {
      for (const facing of flip ? [OPPOSITE[s.facing], s.facing] : [s.facing, OPPOSITE[s.facing]]) {
        const why = run(dim, `setblock ${q.x} ${q.y} ${q.z} ${blockArg(cand, { facing_direction: facing })}`);
        if (why) { if (!id) notes.push(`Sign ${cand} facing ${facing}: ${why}.`); continue; }
        await wait(2);
        await kick(dim, q);
        if (idAt(dim, q).endsWith('wall_sign')) { ok = true; id = cand; if (facing !== s.facing && !done.length) flip = true; break; }
        notes.push(`Sign ${cand} facing ${facing} at ${s.x},${s.y},${s.z} would not stay.`);
        run(dim, `setblock ${q.x} ${q.y} ${q.z} air`);
      }
      if (ok) break;
    }
    done.push(ok);
    if (!ok) { notes.push(`The sign at ${s.x},${s.y},${s.z} (plan coordinates) would not stay on its wall.`); break; }
  }
  const all = done.length === SIGNS.length && done.every(Boolean);
  if (all && flip) notes.push('(The signs hold the other way round to the plan: facing_direction names the side the sign hangs on here.)');
  return { ok: all, id };
}

/** A block update next to a cell: a block put in a free neighbour and taken out again. */
async function kick(dim, q) {
  for (const [dx, dy, dz] of [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0]]) {
    const n = { x: q.x + dx, y: q.y + dy, z: q.z + dz };
    if (idAt(dim, n) !== 'air') continue;
    run(dim, `setblock ${n.x} ${n.y} ${n.z} cobblestone`);
    await wait(2);
    run(dim, `setblock ${n.x} ${n.y} ${n.z} air`);
    await wait(2);
    return true;
  }
  return false;
}

/** The water on the platform floor: how many of the cells it should reach have it, and the depth in each. */
function waterOnPlatform(dim, off, plan) {
  const field = waterField(render(plan), [SOURCE], PLATFORM.y1);
  let have = 0;
  /** @type {Record<string, number | undefined>} */
  const depth = {};
  for (const [k] of field) {
    const [x, z] = k.split(',').map(Number);
    const q = W(off, { x, y: PLATFORM.y1, z });
    if (isWater(idAt(dim, q))) { have++; depth[k] = stateAt(dim, q, 'liquid_depth'); }
  }
  return { have, want: field.size, field, depth, corner: depth[`${KILL.x},${KILL.z}`] };
}

/**
 * Put the water source in and make sure it flows over the whole platform. Each remedy is tried only if the one before left some of the
 * 16 cells dry; returns what worked (or that nothing did) in words.
 */
async function ensureWater(dim, off, plan) {
  const src = W(off, SOURCE);
  const tried = [];
  const settle = async (name, ticks) => {
    await wait(ticks);
    const s = waterOnPlatform(dim, off, plan);
    tried.push(`${name}: ${s.have} of ${s.want} cells`);
    return s;
  };
  let s;
  const why = run(dim, `setblock ${src.x} ${src.y} ${src.z} water`);
  if (why) tried.push(`placing the source: ${why}`);
  s = await settle('source placed', 30);
  if (s.have < s.want) {
    // 1: a block update beside the source (a source made by a command may not know it should spread until something next to it changes).
    await kick(dim, src);
    s = await settle('block update beside the source', 30);
  }
  if (s.have < s.want) {
    // 2: the source out and in again.
    run(dim, `setblock ${src.x} ${src.y} ${src.z} air`);
    await wait(10);
    run(dim, `setblock ${src.x} ${src.y} ${src.z} water`);
    s = await settle('source taken out and put back', 40);
  }
  let hand = false;
  if (s.have < s.want) {
    // 3: lay the flowing water by hand, nearest first, each at the depth it would have.
    hand = true;
    const cells = [...s.field].filter(([, l]) => l > 0).sort((a, b) => a[1] - b[1]);
    let bad = 0;
    for (const [k, l] of cells) {
      const [x, z] = k.split(',').map(Number);
      const q = W(off, { x, y: PLATFORM.y1, z });
      if (run(dim, `setblock ${q.x} ${q.y} ${q.z} flowing_water ["liquid_depth"=${l}]`)) bad++;
    }
    s = await settle(`flowing water laid by hand${bad ? ` (${bad} cells refused)` : ''}`, 40);
  }
  const ok = s.have >= s.want;
  const note = `Water: ${ok ? 'flowing over the whole platform' : 'NOT right'} (${s.have} of ${s.want} floor cells wet, the corner at depth ${s.corner ?? 'none'} of 7). ${tried.join('; ')}.${ok && hand ? ' It would not spread by itself, so the flowing water is placed cell by cell: if it dries up, the game does not treat command-placed water as water that flows.' : ''}${ok && !hand && tried.length > 1 ? ' (It needed the nudge: the first placement alone did not spread.)' : ''}`;
  return { ok, note, state: s };
}

/** Read back what matters: a list of what is not as it should be. */
function verify(dim, off, plan) {
  const bad = [];
  const typeAt = (q) => idAt(dim, W(off, q));
  let beds = 0, comps = 0;
  for (const b of plan.beds) { if (typeAt(b.head) === 'bed') beds++; if (typeAt(b.foot) === 'bed') beds++; }
  for (const s of plan.stations) if (typeAt(s) === 'composter') comps++;
  if (beds !== 40) bad.push(`${beds} of 40 bed halves in place`);
  if (comps !== plan.stations.length) bad.push(`${comps} of ${plan.stations.length} composters`);
  const lt = typeAt(LAVA);
  if (lt !== 'lava') bad.push(`${lt} where the lava should be`);
  for (const s of SIGNS) {
    const t = typeAt(s);
    if (!t.endsWith('wall_sign')) bad.push(`${t} where a sign should be at ${s.x},${s.y},${s.z}`);
  }
  for (const { dz, name } of [{ dz: 0, name: 'first' }, { dz: 1, name: 'second' }]) {
    const q = { x: KILL.x, y: KILL.y - 1, z: KILL.z + dz };
    const f = stateAt(dim, W(off, q), 'facing_direction');
    if (typeAt(q) !== 'hopper') bad.push(`${typeAt(q)} where the ${name} hopper should be`);
    else if (f !== 3) bad.push(`the ${name} hopper reads facing_direction ${f}, not 3`);
  }
  if (typeAt(CHEST) !== 'chest') bad.push(`${typeAt(CHEST)} where the chest should be`);
  if (typeAt(SOURCE) !== 'water') bad.push(`${typeAt(SOURCE)} where the water source should be`);
  const torches = plan.ops.filter((o) => o.id === 'torch').filter((o) => typeAt(o) === 'torch').length;
  if (torches !== plan.ops.filter((o) => o.id === 'torch').length) bad.push(`${torches} of ${plan.ops.filter((o) => o.id === 'torch').length} torches`);
  return bad;
}

// The profession reading (the skin, `variant`, is the biome's and differs from villager to villager; it says nothing about a nitwit).
const markOf = (e) => { try { return e.getComponent('minecraft:mark_variant')?.value ?? null; } catch { return null; } };
const isBaby = (e) => { try { return e.hasComponent('minecraft:is_baby'); } catch { return false; } };

/**
 * Ten villagers, all adults, none a nitwit. A villager made with a command gets a random profession (nitwits among them) and may be a baby.
 * Each is told to grow up and to become unskilled (no profession: it takes a workstation of its own from the composters); one that is then
 * still a baby, or whose profession reading differs from the rest (a nitwit does not take that change) is killed, and replaced.
 */
async function spawnVillagers(dim, off, plan, existing = []) {
  const stats = { spawned: 0, babies: 0, odd: 0, events: { grow: 0, unskilled: 0 }, marks: /** @type {Record<string, number>} */ ({}) };
  const spots = plan.villagers.map((v) => W(off, v));
  let type = null, baseline = null;
  const kept = [...existing];
  for (let round = 0; round < 5 && kept.length < WANT; round++) {
    const need = WANT - kept.length, n = need + (round === 0 ? 4 : 2);
    const batch = [];
    for (let i = 0; i < n; i++) {
      const s = spots[(kept.length + i) % spots.length];
      let e = null;
      for (const t of type ? [type] : VILLAGERS) { try { e = dim.spawnEntity(t, s); type = t; break; } catch { /* next type */ } }
      if (e) batch.push(e);
    }
    stats.spawned += batch.length;
    await wait(4);
    for (const e of batch) {
      try { e.triggerEvent('minecraft:ageable_grow_up'); stats.events.grow++; } catch { /* an adult has no such event */ }
      try { e.triggerEvent('minecraft:become_unskilled'); stats.events.unskilled++; } catch { /* */ }
    }
    await wait(6);
    const adults = [];
    for (const e of batch) {
      if (!e.isValid) continue;
      if (isBaby(e)) { stats.babies++; try { e.kill(); } catch { /* */ } continue; }
      adults.push({ e, key: String(markOf(e)) });
    }
    for (const a of adults) stats.marks[a.key] = (stats.marks[a.key] ?? 0) + 1;
    if (baseline === null && adults.length) {
      const tally = {};
      for (const a of adults) tally[a.key] = (tally[a.key] ?? 0) + 1;
      baseline = Object.entries(tally).sort((x, y) => y[1] - x[1])[0][0];
    }
    for (const a of adults) {
      // (If the profession reset was refused for every one of them the readings are all over the place and mean nothing: keep the adults.)
      const odd = stats.events.unskilled > 0 && a.key !== baseline;
      if (odd) { stats.odd++; try { a.e.kill(); } catch { /* */ } continue; }
      if (kept.length < WANT) kept.push(a.e); else { try { a.e.kill(); } catch { /* */ } }
    }
  }
  const dist = Object.entries(stats.marks).map(([k, v]) => `${v} with profession reading ${k}`).join(', ');
  const unreadable = Object.keys(stats.marks).length === 1 && Object.keys(stats.marks)[0] === 'null';
  const note = `Villagers: ${kept.length} of ${WANT} adults in the pod (made ${stats.spawned}; ${stats.babies} babies and ${stats.odd} with a different profession reading, nitwits among them, killed). Readings: ${dist || 'none'}. Become-unskilled event ${stats.events.unskilled ? 'accepted' : 'REFUSED (nitwits cannot be told apart this way)'}.${unreadable ? ' The profession reading is not available either, so nitwits could not be told apart: check the villagers yourself.' : ''}`;
  return { kept, note, stats };
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
  const c = plan.bounds, cen = W(off, plan.centre);
  for (const t of [...VILLAGERS, 'minecraft:iron_golem', 'minecraft:item']) { try { for (const e of dim.getEntities({ type: t, location: cen, maxDistance: 30 })) { try { e.remove(); } catch { /* */ } } } catch { /* */ } }
  const lo = W(off, { x: c.x1, y: c.y1, z: c.z1 }), hi = W(off, { x: c.x2, y: c.y2, z: c.z2 });
  // The lava and the water go first, so they do not run when the walls go.
  const l = W(off, LAVA), s = W(off, SOURCE);
  run(dim, `setblock ${l.x} ${l.y} ${l.z} air`);
  run(dim, `setblock ${s.x} ${s.y} ${s.z} air`);
  await wait(2);
  const why = run(dim, `fill ${lo.x} ${lo.y} ${lo.z} ${hi.x} ${hi.y} ${hi.z} air`);
  farm = null;
  if (announce) say(`Cleared${why ? ` (the fill said: ${why})` : ''}.`);
}

/** On the platform's west wall (its top is a slab: 7.5), looking east and down into the pool. */
const TOP_VIEW = { x: 2.5, y: 7.5, z: 8.5 };

function view(p, mode) {
  if (!farm) return say('No farm.');
  const { off } = farm;
  if (mode === 'top') {
    p.teleport(W(off, TOP_VIEW), { facingLocation: W(off, { x: 6.5, y: 5, z: 9.5 }), dimension: farm.dim });
    return say('You are on the west wall of the platform, looking down into it.');
  }
  const pod = mode === 'pod';
  const to = pod ? POD_VIEW : STAND;
  p.teleport(W(off, to), { facingLocation: W(off, pod ? { x: 4.5, y: 1.5, z: 6 } : { x: STAND.x, y: STAND.y + 1.5, z: STAND.z - 6 }), dimension: farm.dim });
  say(pod ? 'You are in the pod, in the aisle among the villagers.' : 'You are in the viewing room.');
}

async function water(arg) {
  if (!farm) return say('No farm.');
  const { dim, off, plan } = farm;
  if (arg === 'off') {
    const q = W(off, SOURCE);
    const why = run(dim, `setblock ${q.x} ${q.y} ${q.z} air`);
    farm.waterOn = false;
    return say(`Water source removed${why ? ` (${why})` : ''}: the platform drains in a few seconds.`);
  }
  farm.waterOn = true;
  const w = await ensureWater(dim, off, plan);
  farm.waterNote = w.note;
  say(w.note);
}

function lava(arg) {
  if (!farm) return say('No farm.');
  const q = W(farm.off, LAVA);
  if (arg === 'off') { const why = run(farm.dim, `setblock ${q.x} ${q.y} ${q.z} air`); farm.lavaOn = false; return say(`Lava removed${why ? ` (${why})` : ''}.`); }
  const gone = SIGNS.filter((s) => !idAt(farm.dim, W(farm.off, s)).endsWith('wall_sign'));
  if (gone.length) return say(`Not putting the lava in: ${gone.length} of the 3 signs that hold it are missing.`);
  const why = run(farm.dim, `setblock ${q.x} ${q.y} ${q.z} lava`);
  farm.lavaOn = !why;
  say(`Lava back${why ? ` (${why})` : ''}.`);
}

function inventoryOf(dim, off) {
  /** @type {Record<string, number>} */
  const out = {};
  try {
    const c = dim.getBlock(W(off, CHEST))?.getComponent('minecraft:inventory')?.container;
    for (let i = 0; c && i < c.size; i++) { const it = c.getItem(i); if (it) out[it.typeId.replace('minecraft:', '')] = (out[it.typeId.replace('minecraft:', '')] ?? 0) + it.amount; }
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
  return x >= PLATFORM.x1 && x <= PLATFORM.x2 + 1 && z >= PLATFORM.z1 && z <= PLATFORM.z2 + 1 && y >= PLATFORM.y1 - 0.5 && y <= PLATFORM.y2 + 1;
}

/** Every two seconds: golems appearing and going, iron arriving, a sign gone from the lava, and a word if nothing has happened for a while. */
function watch() {
  if (!farm) return;
  farm.ticks++;
  const { dim, off, plan } = farm;
  // The lava is only as safe as the signs: if one has burned or popped off, take the lava out before it runs over the platform.
  if (farm.lavaOn && farm.ticks % 2 === 0) {
    const gone = SIGNS.filter((s) => !idAt(dim, W(off, s)).endsWith('wall_sign'));
    if (gone.length) {
      const l = W(off, LAVA);
      run(dim, `setblock ${l.x} ${l.y} ${l.z} air`);
      farm.lavaOn = false;
      say(`${gone.length} of the 3 signs holding the lava is gone (${gone.map((s) => `${s.x},${s.y},${s.z}`).join(' ')}): burned by the lava or popped off? I have taken the lava out. "!bot ironfarm lava on" puts it back if the signs are back.`);
    }
  }
  if (farm.waterOn && farm.ticks % 5 === 0 && !farm.warned.has('dry')) {
    const s = waterOnPlatform(dim, off, plan);
    if (s.have < s.want) { farm.warned.add('dry'); say(`The platform water has dried up: ${s.have} of ${s.want} cells wet. "!bot ironfarm water kick" tries again.`); }
  }
  const golems = entities(dim, off, plan, 'minecraft:iron_golem');
  const now = new Set();
  for (const g of golems) {
    now.add(g.id);
    if (!farm.seen.has(g.id)) {
      let wet = false;
      try { wet = g.isInWater; } catch { /* */ }
      say(`A golem has spawned at ${rel(off, g.location)} (plan coordinates; the platform is x ${PLATFORM.x1}-${PLATFORM.x2 + 1}, y ${PLATFORM.y1}, z ${PLATFORM.z1}-${PLATFORM.z2 + 1}): ${onPlatform(g.location, off) ? 'on the platform' : 'NOT on the platform'}, ${wet ? 'in water' : 'not in water'}, after ${((system.currentTick - farm.builtAt) / 1200).toFixed(1)} min.`);
      farm.seen.set(g.id, { at: g.location, t: system.currentTick });
    }
    const s = farm.seen.get(g.id);
    s.at = g.location;
  }
  for (const [id, s] of farm.seen) {
    if (now.has(id) || s.gone) continue;
    s.gone = true;
    say(`A golem is gone (last seen at ${rel(off, s.at)}, ${((system.currentTick - s.t) / 20).toFixed(0)} s after it spawned).`);
  }
  const inv = inventoryOf(dim, off);
  const iron = (inv.iron_ingot ?? 0);
  if (iron > farm.ironSeen) { say(`Iron in the chest: ${iron} (${Object.entries(inv).map(([k, v]) => `${v} ${k}`).join(', ')}).`); farm.ironSeen = iron; }
  const mins = Math.floor((system.currentTick - farm.builtAt) / 1200);
  if (!farm.seen.size && [5, 15, 30, 60, 120].includes(mins) && !farm.announced.has(mins)) {
    farm.announced.add(mins);
    const n = VILLAGERS.reduce((a, t) => a + entities(dim, off, plan, t).length, 0);
    say(`${mins} minutes and no golem yet (${n} villagers in the farm). "!bot ironfarm status" for the rest.`);
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
  try { time = ` day ${Math.floor(world.getAbsoluteTime() / 24000)}, time ${world.getTimeOfDay()}`; } catch { /* */ }
  const b = plan.bounds;
  say(`Built ${((system.currentTick - farm.builtAt) / 1200).toFixed(1)} min ago at ${off.x + b.x1} ${off.y + b.y1} ${off.z + b.z1} (the corner of its box);${time}. Villagers in it: ${vs.length} (${babies} babies). Golems alive: ${golems.length}; seen so far: ${farm.seen.size}. Chest: ${Object.keys(inv).length ? Object.entries(inv).map(([k, v]) => `${v} ${k}`).join(', ') : 'empty'}. Water ${farm.waterOn ? 'on' : 'off'}: ${w.have} of ${w.want} platform cells wet, corner depth ${w.corner ?? 'none'}. Lava ${farm.lavaOn ? 'on' : 'off'}. Slabs: ${farm.slab ?? 'none'}. ${checks.length ? `Not as planned: ${checks.join('; ')}.` : 'Blocks as planned.'} Village centre by my reckoning: ${plan.centre.x} ${plan.centre.y} ${plan.centre.z} plan, ${plan.centre.x + off.x} ${plan.centre.y + off.y} ${plan.centre.z + off.z} in the world. ${farm.villagerNote}`);
}
