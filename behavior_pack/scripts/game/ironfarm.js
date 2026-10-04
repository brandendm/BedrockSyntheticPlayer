// `!bot ironfarm`: puts the iron golem farm of core/ironfarm.js into the world in one go with game commands. The bot is not involved (it works
// with no bot spawned): this is for looking at the design and testing the mechanics. The farm goes in the sky 20 blocks above whoever asks
// (nothing of the world is overwritten but air up there; `force` replaces whatever is in the way), as a block of stone with the rooms carved
// out of it, so it is the only place golems can spawn.
//
//   !bot ironfarm              build it (and teleport you into the viewing room)
//   !bot ironfarm clear        take it away again
//   !bot ironfarm status       what is there and what has happened
//   !bot ironfarm view [pod]   back to the viewing room (or in among the villagers)
//   !bot ironfarm water on|off the platform's water source: off drains the platform, to see whether golems spawn on dry floor
//   !bot ironfarm villagers    new villagers (adults only, nitwits removed)
//   !bot ironfarm build force  build even if something is in the way
//
// Tip: `/gamemode spectator` flies through the stone to look at the inside.
import { system, world } from '@minecraft/server';
import { ironFarmPlan, checkPlan, blockArg, KILL, SOURCE, STAND, POD_VIEW, CHEST, PLATFORM } from '../core/ironfarm.js';

const TAG = '§b[IronFarm]§r';
const VILLAGERS = ['minecraft:villager_v2', 'minecraft:villager'];
const WANT = 10;

/** @type {null | { dim: any, off: {x:number,y:number,z:number}, plan: any, builtAt: number, waterOn: boolean, seen: Map<string, any>, ironSeen: number, watcher: number, villagerNote: string, announced: Set<number> }} */
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

export function ironFarmCommand(player, args) {
  const sub = (args[0] ?? 'build').toLowerCase();
  const p = player ?? world.getPlayers()[0];
  if (!p) return say('No player to build it for.');
  const go = async () => {
    if (sub === 'build' || sub === 'force' || sub === 'here') return build(p, args.includes('force') || sub === 'force');
    if (sub === 'clear' || sub === 'remove') return clear(true);
    if (sub === 'status') return status();
    if (sub === 'view') return view(p, args[1] === 'pod');
    if (sub === 'water') return water(args[1]);
    if (sub === 'villagers') return villagers();
    say('Commands: build, clear, status, view [pod], water on|off, villagers.');
  };
  go().catch((e) => say(`failed: ${e}\n${e?.stack ?? ''}`));
}

async function build(p, force) {
  if (farm) await clear(false);
  const plan = ironFarmPlan();
  const problems = checkPlan(plan);
  if (problems.length) return say(`The plan fails its own checks (${problems.slice(0, 3).join('; ')}): not building.`);
  const c = plan.cube, cc = { x: (c.x1 + c.x2) / 2, y: (c.y1 + c.y2) / 2, z: (c.z1 + c.z2) / 2 };
  const dim = p.dimension;
  const off = { x: Math.floor(p.location.x) - cc.x, y: Math.floor(p.location.y) + 20 - cc.y, z: Math.floor(p.location.z) - cc.z };
  const lo = W(off, { x: c.x1, y: c.y1, z: c.z1 }), hi = W(off, { x: c.x2, y: c.y2, z: c.z2 });
  if (hi.y > 316) return say('Too high up here: stand lower and try again.');
  // Something in the way? A grid of samples through the block.
  if (!force) {
    const hits = [];
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) for (let k = 0; k <= 4; k++) {
      const q = { x: Math.round(lo.x + (hi.x - lo.x) * i / 4), y: Math.round(lo.y + (hi.y - lo.y) * j / 4), z: Math.round(lo.z + (hi.z - lo.z) * k / 4) };
      let id = 'air';
      try { id = dim.getBlock(q)?.typeId ?? 'unloaded'; } catch { id = 'unloaded'; }
      if (id !== 'minecraft:air') hits.push(`${id.replace('minecraft:', '')} at ${q.x} ${q.y} ${q.z}`);
    }
    if (hits.length) return say(`Something is in the way up there (${hits.slice(0, 3).join(', ')}${hits.length > 3 ? `, ${hits.length - 3} more` : ''}). Run "ironfarm build force" to replace it.`);
  }
  say(`Building at ${lo.x} ${lo.y} ${lo.z} to ${hi.x} ${hi.y} ${hi.z} (${plan.ops.length} steps)...`);
  const fails = [];
  for (const o of plan.ops) {
    let cmd;
    if (o.op === 'fill') {
      const a = W(off, { x: o.box.x1, y: o.box.y1, z: o.box.z1 }), b = W(off, { x: o.box.x2, y: o.box.y2, z: o.box.z2 });
      cmd = `fill ${a.x} ${a.y} ${a.z} ${b.x} ${b.y} ${b.z} ${o.id}`;
    } else {
      const q = W(off, o);
      cmd = `setblock ${q.x} ${q.y} ${q.z} ${blockArg(o.id, o.states)}`;
    }
    const why = run(dim, cmd);
    if (why) fails.push(`${o.note || o.id}: ${why} (${cmd})`);
    if (o.op === 'fill' && o.id === 'stone') await wait(2);
  }
  await wait(5);
  const checks = verify(dim, off, plan);
  farm = { dim, off, plan, builtAt: system.currentTick, waterOn: true, seen: new Map(), ironSeen: 0, watcher: -1, villagerNote: '', announced: new Set() };
  const vil = await spawnVillagers(dim, off, plan);
  farm.villagerNote = vil.note;
  try { p.teleport(W(off, { x: STAND.x, y: STAND.y, z: STAND.z }), { facingLocation: W(off, { x: STAND.x, y: STAND.y + 1.5, z: STAND.z - 6 }), dimension: dim }); } catch (e) { say(`Could not teleport you: ${e}`); }
  farm.watcher = system.runInterval(() => watch(), 40);
  say(`Built. ${fails.length ? `${fails.length} commands failed: ${fails.slice(0, 4).join(' | ')}` : 'Every command went through.'} ${checks.length ? `Not as planned: ${checks.join('; ')}.` : 'Everything checked out when read back.'}`);
  say(vil.note);
  say('You are in the viewing room: the platform is through the glass ahead, the chest at your feet. Day or two of waiting may be needed: villagers count as working only after a day of it. "!bot ironfarm status" says how it is going.');
}

/** Read back what matters: a list of what is not as it should be. */
function verify(dim, off, plan) {
  const bad = [];
  const at = (q) => { try { return dim.getBlock(W(off, q)); } catch { return null; } };
  const typeAt = (q) => (at(q)?.typeId ?? 'unloaded').replace('minecraft:', '');
  let beds = 0, comps = 0;
  for (const b of plan.beds) { if (typeAt(b.head) === 'bed') beds++; if (typeAt(b.foot) === 'bed') beds++; }
  for (const s of plan.stations) if (typeAt(s) === 'composter') comps++;
  if (beds !== 40) bad.push(`${beds} of 40 bed halves in place`);
  if (comps !== plan.stations.length) bad.push(`${comps} of ${plan.stations.length} composters`);
  const L = { x: KILL.x, y: KILL.y + 2, z: KILL.z };
  if (typeAt(L) !== 'lava') bad.push(`${typeAt(L)} where the lava should be`);
  for (const [dx, dy, dz] of [[-1, 2, 0], [0, 2, -1], [0, 1, 0]]) {
    const q = { x: KILL.x + dx, y: KILL.y + dy, z: KILL.z + dz };
    const t = typeAt(q);
    let open = null;
    try { open = at(q)?.permutation.getState('open_bit'); } catch { /* */ }
    if (t !== 'crimson_fence_gate') bad.push(`${t} where a gate should be at ${dx},${dy},${dz}`);
    else if (open !== true) bad.push(`the gate at ${dx},${dy},${dz} reads open_bit ${open}`);
  }
  for (const { dz, name } of [{ dz: 0, name: 'first' }, { dz: 1, name: 'second' }]) {
    const q = { x: KILL.x, y: KILL.y - 1, z: KILL.z + dz };
    let f = null;
    try { f = at(q)?.permutation.getState('facing_direction'); } catch { /* */ }
    if (typeAt(q) !== 'hopper') bad.push(`${typeAt(q)} where the ${name} hopper should be`);
    else if (f !== 3) bad.push(`the ${name} hopper reads facing_direction ${f}, not 3`);
  }
  if (typeAt(CHEST) !== 'chest') bad.push(`${typeAt(CHEST)} where the chest should be`);
  if (typeAt(SOURCE) !== 'water') bad.push(`${typeAt(SOURCE)} where the water source should be`);
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
  const c = plan.cube, cen = W(off, plan.centre);
  for (const t of [...VILLAGERS, 'minecraft:iron_golem', 'minecraft:item']) { try { for (const e of dim.getEntities({ type: t, location: cen, maxDistance: 30 })) { try { e.remove(); } catch { /* */ } } } catch { /* */ } }
  const lo = W(off, { x: c.x1, y: c.y1, z: c.z1 }), hi = W(off, { x: c.x2, y: c.y2, z: c.z2 });
  const why = run(dim, `fill ${lo.x} ${lo.y} ${lo.z} ${hi.x} ${hi.y} ${hi.z} air`);
  farm = null;
  if (announce) say(`Cleared${why ? ` (the fill said: ${why})` : ''}.`);
}

function view(p, pod) {
  if (!farm) return say('No farm.');
  const { off } = farm;
  const to = pod ? POD_VIEW : STAND;
  p.teleport(W(off, to), { facingLocation: W(off, pod ? { x: 4.5, y: 1.5, z: 6 } : { x: STAND.x, y: STAND.y + 1.5, z: STAND.z - 6 }), dimension: farm.dim });
  say(pod ? 'You are in the pod, in the aisle among the villagers.' : 'You are in the viewing room.');
}

function water(arg) {
  if (!farm) return say('No farm.');
  const on = arg !== 'off';
  const q = W(farm.off, SOURCE);
  const why = run(farm.dim, `setblock ${q.x} ${q.y} ${q.z} ${on ? 'water' : 'air'}`);
  farm.waterOn = on;
  say(`Water source ${on ? 'back' : 'removed'}${why ? ` (${why})` : ''}${on ? '' : ': the platform drains in a few seconds. If golems spawn only now, they do not spawn on flowing water.'}`);
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

/** Every two seconds: golems appearing and going, iron arriving, and a word if nothing has happened for a while. */
function watch() {
  if (!farm) return;
  const { dim, off, plan } = farm;
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
  let time = '';
  try { time = ` day ${Math.floor(world.getAbsoluteTime() / 24000)}, time ${world.getTimeOfDay()}`; } catch { /* */ }
  say(`Built ${((system.currentTick - farm.builtAt) / 1200).toFixed(1)} min ago at ${off.x + plan.cube.x1} ${off.y + plan.cube.y1} ${off.z + plan.cube.z1} (the block's corner);${time}. Villagers in it: ${vs.length} (${babies} babies). Golems alive: ${golems.length}; seen so far: ${farm.seen.size}. Chest: ${Object.keys(inv).length ? Object.entries(inv).map(([k, v]) => `${v} ${k}`).join(', ') : 'empty'}. Water ${farm.waterOn ? 'on' : 'off'}. ${checks.length ? `Not as planned: ${checks.join('; ')}.` : 'Blocks as planned.'} Village centre by my reckoning: ${plan.centre.x} ${plan.centre.y} ${plan.centre.z} plan, ${plan.centre.x + off.x} ${plan.centre.y + off.y} ${plan.centre.z + off.z} in the world. ${farm.villagerNote}`);
}
