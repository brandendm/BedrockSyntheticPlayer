// The arena engine: builds a test arena in the sky, puts you and the bot in it with the same kit, runs
// the countdown and the clock, keeps the score, and puts everything back (blocks, inventories,
// positions, game mode, spawn points). What each arena IS lives in game/arenas.js; this is the
// machinery. `!bot arena <name> [seconds]` runs one against you, `!bot test <name>` runs the bot alone.
//
// Safety, in this order of importance:
//   - your inventory is copied into the world (a dynamic property) and read back before it is cleared;
//     if the server dies mid-arena you get it back when you next join (or `!bot arena leave`);
//   - the arena is built in the empty sky and removed afterwards; the site is written down in the
//     world while it stands, so a crash leaves nothing behind for good;
//   - the bot's own kit is saved first and put back, and it never saves the arena kit as its own.
import { system, world, GameMode, DisplaySlotId, ObjectiveSortOrder } from '@minecraft/server';
import { winnerOf, rank, clockLeft } from '../core/arena.js';
import { kitOf, restoreKit, container, invCounts } from './inventory.js';
import { sendEvent } from './bridge.js';
import { CONFIG } from '../config.js';

const SITE_KEY = 'arena:site';
const stashKey = (name) => `arena:stash:${name}`;
const AREA = 'bsp_arena';
const BOARD = 'bsp_arena';

/** @type {any} the running arena, if any */
let S = null;

export const arenaRunning = () => !!S;
export const arenaSession = () => S;

const wait = (n) => system.waitTicks(n);
const OVERWORLD = 'minecraft:overworld';

export function tell(msg) { console.warn(`[arena] ${msg.replace(/§./g, '')}`); world.sendMessage(`§e[Arena]§r ${msg}`); }

// ---------- building ----------

/** A queue of build commands, run a few dozen a tick so a big arena does not stall the server. */
export class Builder {
  constructor(dim) { this.dim = dim; this.q = []; this.failed = []; }
  /** fill, split into slabs under the 32768-block limit. */
  fill(x1, y1, z1, x2, y2, z2, block, mode = '') {
    const ax = Math.min(x1, x2), bx = Math.max(x1, x2), ay = Math.min(y1, y2), by = Math.max(y1, y2), az = Math.min(z1, z2), bz = Math.max(z1, z2);
    const step = Math.max(1, Math.floor(30000 / ((bx - ax + 1) * (bz - az + 1))));
    for (let y = ay; y <= by; y += step) this.q.push(`fill ${ax} ${y} ${az} ${bx} ${Math.min(by, y + step - 1)} ${bz} ${block}${mode ? ` ${mode}` : ''}`);
  }
  set(x, y, z, block) { this.q.push(`setblock ${x} ${y} ${z} ${block}`); }
  cmd(c) { this.q.push(c); }
  async run(aborted = () => false, perTick = 28) {
    while (this.q.length && !aborted()) {
      for (let i = 0; i < perTick && this.q.length; i++) {
        const c = this.q.shift();
        try { this.dim.runCommand(c); } catch (e) { if (this.failed.length < 6) this.failed.push(`${c}: ${e}`); }
      }
      await wait(1);
    }
    return this.failed.length;
  }
}

// ---------- kits ----------

/** Items as plain data (inventory.js kit format): slots [[slot, {id, n, en?}]], worn { Head: {...} }. */
export function kit(slots, worn = {}) {
  return { slots: slots.map(([slot, id, n = 1, en]) => [slot, { id: `minecraft:${id}`, n, ...(en ? { en } : {}) }]), worn: Object.fromEntries(Object.entries(worn).map(([k, [id, en]]) => [k, { id: `minecraft:${id}`, n: 1, ...(en ? { en } : {}) }])) };
}

export function clearGear(ent) {
  try { container(ent)?.clearAll(); } catch {}
  try {
    const eq = ent.getComponent('minecraft:equippable');
    for (const k of ['Head', 'Chest', 'Legs', 'Feet', 'Offhand']) { try { eq?.setEquipment(k, undefined); } catch {} }
  } catch {}
}

export function giveKit(ent, k) {
  clearGear(ent);
  const n = restoreKit(ent, k);
  try { ent.selectedSlotIndex = 0; } catch {}
  return n;
}

export function topUp(ent) {
  try { ent.getComponent('minecraft:health')?.resetToMaxValue(); } catch {}
  try { ent.getComponent('minecraft:player.hunger')?.setCurrentValue(20); } catch {}
  try { ent.getComponent('minecraft:player.saturation')?.setCurrentValue(20); } catch {}
  try { for (const e of ent.getEffects()) ent.removeEffect(e.typeId); } catch {}
  try { ent.extinguishFire?.(); } catch {}
}

export const countOf = (ent, re) => { let n = 0; for (const [id, k] of Object.entries(invCounts(ent))) if (re.test(id)) n += k; return n; };

// ---------- the session ----------

function tickingArea(dim, box) {
  const [x1, , z1, x2, , z2] = box;
  try { dim.runCommand(`tickingarea remove ${AREA}`); } catch {}
  try { dim.runCommand(`tickingarea add ${x1} 64 ${z1} ${x2} 64 ${z2} ${AREA} true`); return 'box'; } catch (e) { console.warn(`[arena] ticking area box: ${e}`); }
  const cx = Math.floor((x1 + x2) / 2), cz = Math.floor((z1 + z2) / 2), r = Math.min(4, Math.max(1, Math.ceil(Math.max(x2 - x1, z2 - z1) / 32)));
  try { dim.runCommand(`tickingarea add circle ${cx} 64 ${cz} ${r} ${AREA} true`); return 'circle'; } catch (e) { console.warn(`[arena] ticking area circle: ${e}`); }
  return null;
}

/** Wait until a block in the box reads (its chunk is loaded). */
async function waitLoaded(dim, p, ticks = 200) {
  for (let i = 0; i < ticks; i++) {
    try { if (dim.getBlock(p)) return true; } catch {}
    await wait(2);
  }
  return false;
}

/**
 * Where to put it: the sky east of whoever's here, above everything natural around (sampled across the
 * footprint). `low` arenas hang just above the ground instead: an enderman that blinks out of its pen
 * lands on the terrain below, and one more than 54 blocks from every player is removed by the game.
 */
function pickSite(ref, dim, dims, low = false) {
  const ox = Math.floor(ref.x) + 24, oz = Math.floor(ref.z) - Math.floor(dims.d / 2);
  let top = Math.floor(ref.y) - 2;
  for (let dx = -8; dx <= dims.w + 8; dx += 8) {
    for (let dz = -8; dz <= dims.d + 8; dz += 8) {
      try { const b = dim.getTopmostBlock({ x: Math.floor(ox + dx), z: Math.floor(oz + dz) }); if (b) top = Math.max(top, b.location.y); } catch {}
    }
  }
  const max = dim.heightRange.max - dims.h - 4;
  const oy = low ? Math.min(max, top + 14) : Math.min(max, Math.max(top + 36, Math.floor(ref.y) + 30));
  return { x: ox, y: oy, z: oz };
}

function saveSite(box, dimId) {
  try { world.setDynamicProperty(SITE_KEY, JSON.stringify({ box, dim: dimId })); } catch {}
}

async function wipe(dim, box) {
  const B = new Builder(dim);
  // Whatever's in there (mobs, items, boats) first, then the blocks.
  try {
    for (const e of dim.getEntities({ location: { x: box[0], y: box[1], z: box[2] }, volume: { x: box[3] - box[0] + 1, y: box[4] - box[1] + 1, z: box[5] - box[2] + 1 }, excludeTypes: ['minecraft:player'] })) { try { e.remove(); } catch {} }
  } catch (e) { console.warn(`[arena] clearing entities: ${e}`); }
  B.fill(box[0], box[1], box[2], box[3], box[4], box[5], 'air');
  await B.run();
  return B.failed;
}

/**
 * Run one arena. `player` is who asked (null: the bot alone). Returns { pass, detail, entries } for tests.
 */
export async function runSession(agent, player, def, opts = {}) {
  if (S) { agent.say('An arena is already running (`!bot arena stop` ends it).'); return { pass: false, detail: 'an arena is already running' }; }
  const dim = agent.dim;
  if (dim.id !== OVERWORLD) { agent.say('Arenas are built in the overworld.'); return { pass: false, detail: 'not in the overworld' }; }
  const solo = !player || !!opts.solo;
  const secs = Math.max(20, Math.min(900, opts.secs || def.secs));
  const sim = agent.sim;
  const ref = player && !solo ? player.location : sim.location;
  const dims = def.dims(opts);
  const O = pickSite(ref, dim, dims, !!def.low);
  const box = [O.x, O.y, O.z, O.x + dims.w - 1, O.y + dims.h - 1, O.z + dims.d - 1];
  /** @type {any} */
  const s = {
    def, agent, dim, solo, secs, O, dims, box, opts, human: solo ? null : player, parts: [], gates: [], mobs: [],
    phase: 'build', abort: false, tick0: 0, tEnd: 0, x: {}, notes: [],
  };
  S = s;
  const bot = { key: 'bot', name: CONFIG.botName, bot: true, ent: sim, lane: solo || !s.human ? 0 : 1, score: 0, deaths: 0, done: false, doneAt: null, hp0: 20, x: {} };
  s.parts.push(bot);
  if (s.human) s.parts.unshift({ key: 'you', name: s.human.name, bot: false, ent: s.human, lane: 0, score: 0, deaths: 0, done: false, doneAt: null, hp0: 20, x: {} });
  s.you = s.human ? s.parts[0] : null;
  s.bot = bot;
  const abortNow = () => s.abort || !sim.isValid || (s.human && !s.human.isValid);

  // Remember how everything was, so the end can put it back.
  s.botWas = { auto: agent.autoEnabled, pos: { ...sim.location }, spawn: (() => { try { return sim.getSpawnPoint?.(); } catch { return undefined; } })(), kit: null };
  let stashed = false;
  let result = { pass: false, detail: 'did not run' };
  try {
    s.t00 = system.currentTick;
    tell(`Building the ${def.title} arena up in the sky...`);
    saveSite(box, dim.id);
    const area = tickingArea(dim, box);
    if (!area) throw new Error('could not load the sky for the arena (ticking area)');
    if (!(await waitLoaded(dim, { x: O.x + 1, y: O.y, z: O.z + 1 }))) throw new Error('the arena chunks did not load');
    await wait(10);
    s.G = O.y + (def.floor ?? 2); // y of the floor's top block
    const B = new Builder(dim);
    B.fill(box[0], box[1], box[2], box[3], box[4], box[5], 'air');
    def.build(s, B);
    s.lanes = def.layout(s);
    const tB = system.currentTick;
    const fails = await B.run(abortNow);
    console.warn(`[arena] built: ${system.currentTick - tB} ticks for the commands, ${fails} failed`);
    if (fails) console.warn(`[arena] ${fails} build commands failed, first: ${B.failed.join(' | ')}`);
    if (abortNow()) throw new Error('stopped while building');

    // The bot's own kit, saved; then every participant's things put aside.
    agent.autoEnabled = false;
    agent.newTask(null); agent.motor.stop();
    try { agent.saveKit(); } catch {}
    agent.arenaHook = {
      def,
      onDeath: () => { try { onDeath(s, bot); } catch (e) { console.warn(`[arena] onDeath: ${e}`); } },
      onRespawn: () => { try { onRespawn(s, bot); } catch (e) { console.warn(`[arena] onRespawn: ${e}`); } },
      resume: () => { if (S === s && s.phase === 'run') launchBot(s, bot); }, // a fight was in the way of the routine: back to it
      mobTypes: def.mobTypes ?? [],
      swims: !!def.swims, // the routine works under water on purpose: no "swim to shore" reflex (air is the routine's job)
      fightId: () => (def.fightTarget ? def.fightTarget(s, bot) : null),
    };
    agent.motor.submerge = !!def.swims;
    s.botWas.kit = kitOf(sim);
    if (s.you) {
      const k = kitOf(s.human);
      const json = JSON.stringify({ kit: k, back: { x: s.human.location.x, y: s.human.location.y, z: s.human.location.z }, mode: String(safe(() => s.human.getGameMode(), 'survival')), spawn: safe(() => { const sp = s.human.getSpawnPoint(); return sp ? { x: sp.x, y: sp.y, z: sp.z } : null; }, null), at: Date.now() });
      if (json.length > 30000) throw new Error('your inventory is too big to set aside safely: put some of it in a chest and try again');
      world.setDynamicProperty(stashKey(s.human.name), json);
      if (world.getDynamicProperty(stashKey(s.human.name)) !== json) throw new Error("couldn't set your inventory aside, so I haven't touched it");
      stashed = true;
      s.youWas = JSON.parse(json);
    }
    for (const p of s.parts) {
      if (!p.bot) { try { p.ent.setGameMode(GameMode.Survival); } catch { try { p.ent.runCommand('gamemode survival'); } catch {} } }
      try { p.ent.setSpawnPoint({ dimension: dim, x: Math.floor(s.lanes.starts[p.lane].x), y: Math.floor(s.lanes.starts[p.lane].y), z: Math.floor(s.lanes.starts[p.lane].z) }); } catch (e) { console.warn(`[arena] spawn point: ${e}`); }
      giveKit(p.ent, def.kit(s, p));
      topUp(p.ent);
      toStart(s, p);
    }
    await wait(10);
    if (def.ready) { await def.ready(s); await wait(10); } // (boats to sit in, anything to have in place before the count)

    // Countdown.
    s.phase = 'count';
    tell(`${def.title}: ${s.you ? `you vs ${CONFIG.botName}` : CONFIG.botName}, ${secs} seconds. ${def.rules}`);
    for (let n = 5; n >= 1; n--) {
      for (const p of s.parts) if (!p.bot) { title(p.ent, `${n}`, def.title, 0, 14, 2); sound(p.ent, 'random.click'); }
      await wait(20);
      if (abortNow()) throw new Error('stopped during the countdown');
    }
    for (const g of s.gates) { try { dim.runCommand(g); } catch {} }
    await wait(2);
    for (const p of s.parts) if (!p.bot) { title(p.ent, '§aGO!', def.title, 0, 24, 6); sound(p.ent, 'random.levelup'); }
    s.phase = 'run';
    s.tick0 = system.currentTick;
    console.warn(`[arena] GO at tick ${s.tick0} (${s.tick0 - s.t00} ticks after the request)`);
    s.tEnd = s.tick0 + secs * 20;
    for (const p of s.parts) p.hp0 = hpOf(p.ent);
    board(s, true);
    def.go?.(s);
    launchBot(s, bot);

    // The clock.
    while (s.phase === 'run') {
      await wait(4);
      if (abortNow()) break;
      const now = system.currentTick;
      try { def.tick?.(s, now); } catch (e) { console.warn(`[arena] tick: ${e}\n${e.stack}`); }
      if (now % 20 < 4) board(s, false);
      hud(s, now);
      if (now >= s.tEnd || def.over?.(s, now)) break;
    }
    s.phase = 'over';
    s.elapsed = system.currentTick - s.tick0;
    try { def.finish?.(s); } catch (e) { console.warn(`[arena] finish: ${e}`); }
    // Stop the bot's routine.
    agent.newTask(null); agent.motor.stop();
    result = announce(s);
    if (s.human?.isValid) await wait(s.opts.linger ?? 160);
  } catch (e) {
    console.warn(`[arena] ${def.name}: ${e}\n${e.stack ?? ''}`);
    result = { pass: false, detail: `error: ${e}`, entries: [] };
    tell(`Arena stopped: ${e}`);
  } finally {
    s.phase = 'cleanup';
    agent.arenaHook = null;
    agent.motor.submerge = false;
    try { agent.newTask(null); agent.motor.stop(); agent.body.stop(); } catch {}
    await cleanup(s, stashed).catch((e) => console.warn(`[arena] cleanup: ${e}\n${e.stack ?? ''}`));
    S = null;
  }
  return result;
}

const modeOf = (m) => ({ creative: GameMode.Creative, adventure: GameMode.Adventure, spectator: GameMode.Spectator }[String(m).toLowerCase()] ?? GameMode.Survival);
const safe = (f, d) => { try { return f(); } catch { return d; } };
const hpOf = (ent) => safe(() => ent.getComponent('minecraft:health').currentValue, 0);

function title(ent, big, sub, fadeIn = 0, stay = 20, fadeOut = 5) {
  try { ent.onScreenDisplay.setTitle(big, { subtitle: sub, fadeInDuration: fadeIn, stayDuration: stay, fadeOutDuration: fadeOut }); } catch {}
}
function sound(ent, id) { try { ent.runCommand(`playsound ${id} @s ~ ~ ~ 1 1`); } catch {} }

/** Back to the lane's start with the kit (also after a death). */
export function toStart(s, p) {
  const st = s.lanes.starts[p.lane];
  try {
    p.ent.teleport({ x: st.x, y: st.y, z: st.z }, { facingLocation: { x: st.x + (st.fx ?? 0), y: st.y + 1.5, z: st.z + (st.fz ?? 1) } });
  } catch (e) { console.warn(`[arena] teleport ${p.name}: ${e}`); }
}

// ---------- the bot ----------

export function launchBot(s, bot) {
  const agent = s.agent;
  const gen = agent.newTask({ kind: 'arena' });
  s.botGen = gen;
  Promise.resolve().then(() => s.def.bot?.(s, bot, gen)).catch((e) => {
    if (gen !== agent.taskGen) return; // told to stop
    console.warn(`[arena] bot routine: ${e}\n${e?.stack ?? ''}`);
  }).then(() => { if (gen === agent.taskGen && s.phase === 'run') agent.newTask(null); });
}

function onDeath(s, p) {
  p.deaths++;
  p.diedAt = system.currentTick;
  s.def.died?.(s, p);
  s.agent.newTask(null); s.agent.suspended = null; s.agent.endCombat();
}

function onRespawn(s, p) {
  if (s.phase !== 'run' && s.phase !== 'count') return;
  system.runTimeout(() => {
    if (S !== s || !s.agent.sim.isValid) return;
    if (!s.def.keepsGoing || s.def.keepsGoing(s, p)) {
      toStart(s, p);
      giveKit(p.ent, s.def.kit(s, p));
      topUp(p.ent);
      if (s.phase === 'run') launchBot(s, p);
    }
  }, 12);
}

// ---------- the people ----------

world.afterEvents.playerSpawn.subscribe((ev) => {
  const p = ev.player;
  if (S && S.you && p.id === S.you.ent.id && !ev.initialSpawn && (S.phase === 'run' || S.phase === 'count')) {
    const you = S.you;
    you.deaths++;
    system.runTimeout(() => {
      if (S && S.you === you && p.isValid && (!S.def.keepsGoing || S.def.keepsGoing(S, you))) {
        toStart(S, you); giveKit(p, S.def.kit(S, you)); topUp(p);
        S.def.youRespawned?.(S, you);
      } else if (S && p.isValid) {
        // Out of this round (a duel lost): watching from the start, nothing to carry.
        clearGear(p); toStart(S, you);
      }
    }, 10);
    return;
  }
  // Spawned (joined, or came back from dead) with things set aside and no arena running: back they go.
  if (!S) system.runTimeout(() => { try { if (!S) recoverPlayer(p); } catch (e) { console.warn(`[arena] recover: ${e}`); } }, ev.initialSpawn ? 40 : 10);
});

if (world.afterEvents.entityRemove) {
  world.afterEvents.entityRemove.subscribe((ev) => {
    if (S && CONFIG.debug && /enderman|golem|drowned|zombie|husk/.test(ev.typeId)) console.warn(`[arena] dbg removed ${ev.typeId} ${ev.removedEntityId}`);
  });
}

world.afterEvents.entityDie.subscribe((ev) => {
  if (!S) return;
  const e = ev.deadEntity;
  if (e.typeId === 'minecraft:player') {
    const p = S.parts.find((x) => !x.bot && x.ent.id === e.id);
    if (p) { p.diedAt = system.currentTick; S.def.died?.(S, p); }
    return;
  }
  S.def.mobDied?.(S, e, ev.damageSource);
});

world.beforeEvents.playerLeave.subscribe((ev) => {
  if (S && S.you && ev.player.id === S.you.ent.id) S.abort = true;
});

/** Give a player their things back from the stash (a crash, or a quit mid-arena). */
export function recoverPlayer(p) {
  if (S) return false;
  const raw = world.getDynamicProperty(stashKey(p.name));
  if (typeof raw !== 'string') return false;
  let j; try { j = JSON.parse(raw); } catch { return false; }
  try { p.teleport(j.back); } catch {}
  clearGear(p);
  const n = restoreKit(p, j.kit);
  try { p.setGameMode(modeOf(j.mode)); } catch {}
  try { if (j.spawn) p.setSpawnPoint({ dimension: world.getDimension('overworld'), ...j.spawn }); else p.setSpawnPoint(undefined); } catch {}
  world.setDynamicProperty(stashKey(p.name), undefined);
  p.sendMessage(`§e[Arena]§r Put your things back (${n} stacks) from before the arena.`);
  return true;
}

/** A crash left the sky arena standing: take it down (and let the ticking area go). */
export async function recoverSite() {
  if (S) return;
  const raw = world.getDynamicProperty(SITE_KEY);
  if (typeof raw !== 'string') return;
  let j; try { j = JSON.parse(raw); } catch { world.setDynamicProperty(SITE_KEY, undefined); return; }
  const dim = world.getDimension(j.dim.replace('minecraft:', ''));
  for (let i = 0; i < 20; i++) {
    if (S) return;
    if (await waitLoaded(dim, { x: j.box[0] + 1, y: j.box[1], z: j.box[2] + 1 }, 20)) {
      const failed = await wipe(dim, j.box);
      try { dim.runCommand(`tickingarea remove ${AREA}`); } catch {}
      if (!failed.length) { world.setDynamicProperty(SITE_KEY, undefined); console.warn('[arena] took down an arena left standing'); }
      return;
    }
    await wait(40);
  }
}
system.runTimeout(() => { recoverSite().catch((e) => console.warn(`[arena] recoverSite: ${e}`)); }, 200);

export function stopArena() { if (!S) return false; S.abort = true; return true; }

// ---------- HUD and score ----------

function hud(s, now) {
  if (!s.human?.isValid || now % 8 > 3) return;
  const left = Math.max(0, s.tEnd - now);
  const line = s.def.hudLine ? s.def.hudLine(s) : s.parts.map((p) => `${p.bot ? p.name : 'You'} ${s.def.text(s, p)}`).join('  §7|§r  ');
  try { s.human.onScreenDisplay.setActionBar(`§e${clockLeft(left)}§r  ${line}`); } catch {}
}

function board(s, first) {
  try {
    const sb = world.scoreboard;
    if (first) {
      try { sb.removeObjective(BOARD); } catch {}
      const o = sb.addObjective(BOARD, `§l${s.def.title}`);
      sb.setObjectiveAtDisplaySlot(DisplaySlotId.Sidebar, { objective: o, sortOrder: ObjectiveSortOrder.Descending });
    }
    const o = sb.getObjective(BOARD);
    if (!o) return;
    for (const p of s.parts) o.setScore(p.bot ? p.name : 'You', Math.round(s.def.points ? s.def.points(s, p) : (s.def.value(s, p) ?? 0)));
  } catch (e) { if (first) console.warn(`[arena] scoreboard: ${e}`); }
}

function announce(s) {
  const def = s.def;
  const entries = s.parts.map((p) => ({ name: p.bot ? p.name : p.name, who: p.bot ? 'bot' : 'you', value: def.value(s, p), text: def.text(s, p), p }));
  const alone = false;
  const win = alone ? null : winnerOf(entries.map((e) => ({ name: e.name, value: e.value })), def.better);
  const lines = rank(alone ? entries.filter((e) => e.who === 'you') : entries, def.better).map((e) => `${e.name}: ${e.text}`);
  tell(`§6${def.title} over.§r ${lines.join('  |  ')}${!alone && s.parts.length > 1 ? `  ->  ${win ? `§a${win} wins§r` : 'a tie'}` : ''}`);
  for (const p of s.parts) if (!p.bot) title(p.ent, alone ? '§eTime!' : win === p.name ? '§aYou win!' : win ? '§cScout wins' : '§eTie', lines.join('  /  '), 0, 120, 20);
  const verdict = def.verdict ? def.verdict(s, s.bot) : { pass: true, detail: '' };
  const detail = `${lines.join('; ')}${verdict.detail ? `; ${verdict.detail}` : ''}`;
  sendEvent({ type: 'arena_result', arena: def.name, secs: s.elapsed / 20, solo: s.solo, entries: entries.map((e) => ({ name: e.name, value: e.value, text: e.text })), winner: win }).catch(() => {});
  return { pass: verdict.pass, detail, entries, winner: win };
}

// ---------- putting it all back ----------

async function cleanup(s, stashed) {
  const { dim, agent } = s;
  // People out of the sky first, with their own things.
  try { world.scoreboard.removeObjective(BOARD); } catch {}
  const alive = (ent) => { try { return ent.isValid && ent.getComponent('minecraft:health').currentValue > 0; } catch { return false; } };
  // (Someone who died at the very end gets a moment to come back; a player has to click Respawn, so not for long.)
  for (const p of s.parts) { for (let i = 0; i < (p.bot ? 120 : 60) && p.ent.isValid && !alive(p.ent); i++) await wait(2); }
  for (const p of s.parts) {
    if (p.bot) continue;
    const ent = p.ent;
    if (!ent?.isValid) continue; // gone (quit): the stash waits for their next join
    if (!alive(ent)) {
      // Still on the death screen: their old spawn point goes back now (the sky one is about to vanish), and
      // the things set aside come back when they respawn (playerSpawn above).
      try { if (s.youWas?.spawn) ent.setSpawnPoint({ dimension: dim, ...s.youWas.spawn }); else ent.setSpawnPoint(undefined); } catch {}
      try { ent.sendMessage('§e[Arena]§r Your things are safe: you get them back when you respawn.'); } catch {}
      continue;
    }
    if (stashed && s.youWas) {
      clearGear(ent);
      try { ent.teleport(s.youWas.back); } catch (e) { console.warn(`[arena] teleport home: ${e}`); }
      const n = restoreKit(ent, s.youWas.kit);
      try { ent.setGameMode(modeOf(s.youWas.mode)); } catch {}
      try { if (s.youWas.spawn) ent.setSpawnPoint({ dimension: dim, ...s.youWas.spawn }); else ent.setSpawnPoint(undefined); } catch {}
      topUp(ent);
      world.setDynamicProperty(stashKey(p.name), undefined);
      ent.sendMessage(`§e[Arena]§r Back where you were, with your things (${n} stacks).`);
    }
  }
  // The bot.
  const sim = agent.sim;
  if (sim.isValid && s.botWas) {
    if (!alive(sim)) console.warn('[arena] the bot is still dead at the end; putting its things back anyway');
    clearGear(sim);
    try { sim.teleport(s.botWas.pos); } catch {}
    if (s.botWas.kit) restoreKit(sim, s.botWas.kit);
    try { if (s.botWas.spawn) sim.setSpawnPoint(s.botWas.spawn); else sim.setSpawnPoint({ dimension: dim, x: Math.floor(s.botWas.pos.x), y: Math.floor(s.botWas.pos.y), z: Math.floor(s.botWas.pos.z) }); } catch {}
    topUp(sim);
    agent.autoEnabled = s.botWas.auto;
    agent.equipBestWeapon?.();
  }
  s.def.cleanup?.(s);
  await wait(10);
  const failed = await wipe(dim, s.box);
  try { dim.runCommand(`tickingarea remove ${AREA}`); } catch {}
  if (!failed.length) { try { world.setDynamicProperty(SITE_KEY, undefined); } catch {} } else console.warn(`[arena] wipe: ${failed.join(' | ')}`);
  tell(`The arena is gone (${system.currentTick - s.t00} ticks in all).`);
}
