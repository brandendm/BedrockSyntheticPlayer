// The colosseum: `!bot colosseum <mob> [count] [team N] [rounds N]` or `!bot colosseum bots [team N] [rounds N]`.
// A glass-walled arena is built in the sky with tiered stands around it and you are put in the top row to watch (creative, so you can fly in for a
// closer look: `!bot colosseum stop` ends it and puts you back). Bots in full diamond armour with a shield, diamond sword, axe and spear, a bow
// and 64 arrows fight the mob you named (the red team of bots against the mobs: any mob in the game, count 1-12), or the red team fights the blue
// team of bots. Best of N rounds. A bot that falls to 2 hearts is knocked out (healed and sat on the bench, not killed) and the round goes to the
// last side standing. Everything is put back at the end: your position and game mode, mob griefing, the bots sent home. The arena stays up in the
// sky for the next show (`!bot colosseum clear` takes it down).
import { system, world, ItemStack } from '@minecraft/server';
import { CONFIG } from '../config.js';
import { crew } from './crew.js';
import { WorldMemory } from './memory.js';
import { hold, invCounts } from './inventory.js';
import { Builder, kit, giveKit, topUp, tell } from './arena.js';
import { shootAt } from './aim.js';
import { weaponReach, bestWeapon } from '../core/tactics.js';
import { MOB_LIST, AQUATIC, FLYERS, parseShow, roundWinner, KO_HP, personality, loadoutKit, meleeIds, describeLoadout } from '../core/colosseum.js';

const R = 12;               // inner half-size: the floor is 25 x 25
const H = 10;               // wall height
const TIERS = 5;
const AREA = 'bsp_colosseum';
const SITE_KEY = 'colosseum:site';
const NAMES = ['Brutus', 'Maximus', 'Spartacus', 'Flavia', 'Cassius', 'Octavia', 'Marcus', 'Livia'];
const STASH_KEY = 'colosseum:player';

/** @type {any} */
let SHOW = null;
export const colosseumRunning = () => !!SHOW;

const hpOf = (e) => { try { return e.getComponent('minecraft:health')?.currentValue ?? 0; } catch { return 0; } };
const alive = (e) => { try { return !!e && e.isValid && hpOf(e) > 0; } catch { return false; } };
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const pretty = (id) => String(id).replace(/^minecraft:/, '').replace(/_/g, ' ');
const wait = (n) => system.waitTicks(n);

export function colosseumCommand(agent, player, words) {
  const say = (m) => (player ? player.sendMessage(`§6[Colosseum]§r ${m}`) : tell(m));
  const p = parseShow(words);
  if (p.cmd === 'help') {
    return say('`!bot colosseum <mob> [count] [team N] [rounds N]` (e.g. zombie 6, iron golem 2, wither, random), `!bot colosseum bots [team N] [rounds N]` (red vs blue), `list`, `stop`, `clear`. Gear: armor=none|leather|chain|iron|gold|diamond|netherite weapon=wood|stone|iron|gold|diamond|netherite weapons=sword,axe,spear,mace,trident bow=on|off shield=on|off enchant=on|off park=on|off (park: remove roaming bots and hold the main bot still during the show, default on) (blue.armor=... for the blue team). Default: full diamond, sword/axe/spear, bow, shield.');
  }
  if (p.cmd === 'list') return say(`Mobs: ${MOB_LIST.join(', ')}. Any other id is tried as typed.`);
  if (p.cmd === 'stop') { if (SHOW) { SHOW.abort = true; return say('Stopping the show.'); } return say(player && recoverPlayer(player) ? 'No show is running; put you back where you were.' : 'No show is running.'); }
  if (p.cmd === 'clear') { if (player) recoverPlayer(player); clearArena(agent).then((n) => say(n ? 'The colosseum is taken down.' : 'There is none standing.')).catch((e) => say(`could not: ${e}`)); return; }
  if (SHOW) return say('A show is already on (`!bot colosseum stop`).');
  runShow(agent, player, p).catch((e) => { console.warn(`[colosseum] ${e}\n${e?.stack ?? ''}`); say(`The show failed: ${e}`); }).then(() => {});
}

// ---------- the building ----------

function siteFor(agent, player) {
  try { const s = JSON.parse(String(world.getDynamicProperty(SITE_KEY) ?? 'null')); if (s && s.dim === agent.dim.id) return s; } catch { /* */ }
  const ref = player ? player.location : agent.sim.location;
  const dim = agent.dim;
  let top = Math.floor(ref.y);
  for (const [dx, dz] of [[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20]]) { try { const b = dim.getTopmostBlock({ x: Math.floor(ref.x) + dx, z: Math.floor(ref.z) + dz }); if (b) top = Math.max(top, b.location.y); } catch { /* */ } }
  const G = Math.min(dim.heightRange.max - H - 8, top + 40);
  // Straight above where the player (or the bot) is: chunks are whole columns, so a sky arena over ground that is loaded anyway costs no extra chunks (one 40 blocks to the side did).
  const s = { cx: Math.floor(ref.x), G, cz: Math.floor(ref.z), dim: dim.id };
  try { world.setDynamicProperty(SITE_KEY, JSON.stringify(s)); } catch { /* */ }
  return s;
}

const boxOf = (s) => ({ x1: s.cx - R - TIERS - 4, x2: s.cx + R + TIERS + 4, z1: s.cz - R - TIERS - 4, z2: s.cz + R + TIERS + 4, y1: s.G - 1, y2: s.G + H + 4 });

async function loaded(dim, p) { for (let i = 0; i < 150; i++) { try { if (dim.getBlock(p)) return true; } catch { /* */ } await wait(2); } return false; }

async function areaOn(dim, s) {
  const b = boxOf(s);
  try { dim.runCommand(`tickingarea remove ${AREA}`); } catch { /* */ }
  try { dim.runCommand(`tickingarea add ${b.x1} 64 ${b.z1} ${b.x2} 64 ${b.z2} ${AREA} true`); } catch (e) {
    try { dim.runCommand(`tickingarea add circle ${s.cx} 64 ${s.cz} 4 ${AREA} true`); } catch { throw new Error(`could not keep the sky loaded: ${e}`); }
  }
  if (!(await loaded(dim, { x: s.cx, y: s.G, z: s.cz }))) throw new Error('the arena chunks did not load');
}

export async function clearArena(agent) {
  let s = null;
  try { s = JSON.parse(String(world.getDynamicProperty(SITE_KEY) ?? 'null')); } catch { /* */ }
  if (!s) return 0;
  const dim = world.getDimension(s.dim);
  await areaOn(dim, s);
  const b = boxOf(s), B = new Builder(dim);
  try { for (const e of dim.getEntities({ location: { x: s.cx, y: s.G, z: s.cz }, maxDistance: 40, excludeTypes: ['minecraft:player'] })) { try { if (!/simulated|player/.test(e.typeId)) e.remove(); } catch { /* */ } } } catch { /* */ }
  B.fill(b.x1, b.y1, b.z1, b.x2, b.y2, b.z2, 'air');
  await B.run();
  try { dim.runCommand(`tickingarea remove ${AREA}`); } catch { /* */ }
  try { world.setDynamicProperty(SITE_KEY, undefined); } catch { /* */ }
  return 1;
}

async function build(dim, s, wet) {
  const { cx, cz, G } = s, b = boxOf(s), B = new Builder(dim);
  B.fill(b.x1, b.y1, b.z1, b.x2, b.y2, b.z2, 'air');
  // floor: smooth stone, a quartz cross, the teams' strips (red west, blue east)
  B.fill(cx - R - 1, G, cz - R - 1, cx + R + 1, G, cz + R + 1, 'smooth_stone');
  B.fill(cx - R, G, cz, cx + R, G, cz, 'quartz_block');
  B.fill(cx, G, cz - R, cx, G, cz + R, 'quartz_block');
  B.fill(cx - R, G, cz - R, cx - R + 1, G, cz + R, 'red_concrete');
  B.fill(cx + R - 1, G, cz - R, cx + R, G, cz + R, 'blue_concrete');
  // glass walls and roof (a hollow box), a sea lantern grid in the roof for light
  B.fill(cx - R - 1, G + 1, cz - R - 1, cx + R + 1, G + H + 1, cz + R + 1, 'glass');
  B.fill(cx - R, G + 1, cz - R, cx + R, G + H, cz + R, 'air');
  for (const i of [-9, -3, 3, 9]) for (const j of [-9, -3, 3, 9]) B.set(cx + i, G + H + 1, cz + j, 'sea_lantern');
  // cover: four pillars and a stepped centre
  for (const [px, pz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) B.fill(cx + px, G + 1, cz + pz, cx + px, G + 4, cz + pz, 'stone_bricks');
  B.fill(cx - 2, G + 1, cz - 2, cx + 2, G + 1, cz + 2, 'polished_andesite');
  B.fill(cx - 1, G + 2, cz - 1, cx + 1, G + 2, cz + 1, 'polished_andesite');
  // stands on all four sides: tier k is k blocks high, k steps out from the glass
  for (let k = 1; k <= TIERS; k++) {
    const o = R + 1 + k;
    B.fill(cx - R - 1, G + 1, cz + o, cx + R + 1, G + k, cz + o, 'stone_bricks');
    B.fill(cx - R - 1, G + 1, cz - o, cx + R + 1, G + k, cz - o, 'stone_bricks');
    B.fill(cx + o, G + 1, cz - R - 1, cx + o, G + k, cz + R + 1, 'stone_bricks');
    B.fill(cx - o, G + 1, cz - R - 1, cx - o, G + k, cz + R + 1, 'stone_bricks');
  }
  if (wet) B.fill(cx - R, G + 1, cz - R, cx + R, G + 2, cz + R, 'water');
  const fails = await B.run(() => SHOW?.abort);
  if (fails) console.warn(`[colosseum] ${fails} build commands failed, first: ${B.failed.join(' | ')}`);
}

/** Every simulated player that is not in `keep` and is named like the bot (hired workers, benchmark bots, orphans left by a script reload) is removed; returns how many. */
export function removeExtraBots(keep) {
  let n = 0;
  for (const pl of world.getPlayers()) {
    if (keep.has(pl.id) || !pl.name.startsWith(CONFIG.botName)) continue;
    try { pl.dimension.runCommand(`kick "${pl.name}"`); n++; } catch { try { pl.kill(); n++; } catch { /* */ } }
  }
  for (let i = crew.members.length - 1; i >= 0; i--) if (!keep.has(crew.members[i].sim?.id)) { try { crew.members[i].newTask(null); } catch { /* */ } crew.members.splice(i, 1); }
  return n;
}

// ---------- the show ----------

async function runShow(agent, player, p) {
  const dim = agent.dim;
  if (dim.id !== 'minecraft:overworld') { tell('The colosseum is built in the overworld.'); return; }
  const wet = p.mode === 'mobs' && AQUATIC.has(p.mob.id);
  const S = siteFor(agent, player);
  const show = { abort: false, round: 0, over: true, fighters: [], foes: [], stats: new Map(), saved: null };
  SHOW = show;
  const say = (m) => { tell(m); };
  const title = (t, sub = '') => { try { for (const pl of world.getPlayers()) pl.onScreenDisplay.setTitle(t, { subtitle: sub, fadeInDuration: 6, stayDuration: 50, fadeOutDuration: 10 }); } catch { /* */ } };
  const bar = (t) => { try { for (const pl of world.getPlayers()) pl.onScreenDisplay.setActionBar(t); } catch { /* */ } };
  let griefWas = null;
  const subs = [];
  try {
    say('Building the colosseum in the sky...');
    await areaOn(dim, S);
    await build(dim, S, wet);
    if (show.abort) return;
    try { griefWas = world.gameRules?.mobGriefing ?? null; world.gameRules.mobGriefing = false; } catch { try { dim.runCommand('gamerule mobgriefing false'); griefWas = true; } catch { /* */ } }
    // Nothing else spawns while the show is on (the stands are dark and the night is long): the rule is put back after.
    try { show.spawnWas = world.gameRules?.doMobSpawning ?? true; world.gameRules.doMobSpawning = false; } catch { try { dim.runCommand('gamerule domobspawning false'); show.spawnWas = true; } catch { /* */ } }
    // Against mobs it is night all through (undead burn in daylight, and the roof is glass): the time is stopped and put back after.
    if (p.mode === 'mobs') {
      try { show.time = world.getTimeOfDay(); show.cycle = world.gameRules?.doDaylightCycle ?? true; world.gameRules.doDaylightCycle = false; } catch { /* */ }
      try { dim.runCommand('time set midnight'); } catch { try { dim.runCommand('time set 18000'); } catch { /* */ } }
    }
    const G = S.G + 1; // (standing y)
    const seat = { x: S.cx + 0.5, y: S.G + TIERS + 1, z: S.cz + R + 1 + TIERS + 0.5 };
    // who watches
    if (player) {
      let spawn = null;
      try { const sp = player.getSpawnPoint?.(); if (sp) spawn = { x: sp.x, y: sp.y, z: sp.z, dim: sp.dimension?.id ?? sp.dimensionId ?? 'minecraft:overworld' }; } catch { /* */ }
      show.saved = { name: player.name, pos: { ...player.location }, mode: String(player.getGameMode?.() ?? 'survival'), spawn };
      try { world.setDynamicProperty(STASH_KEY, JSON.stringify(show.saved)); } catch { /* */ }
      try { player.setGameMode('creative'); } catch { /* */ }
      // (the stands are home while the show is on: a death anywhere comes back here)
      try { player.setSpawnPoint({ dimension: dim, x: Math.floor(seat.x), y: Math.floor(seat.y), z: Math.floor(seat.z) }); } catch (e) { console.warn(`[colosseum] spawn point: ${e}`); }
      player.teleport(seat, { facingLocation: { x: S.cx, y: S.G + 3, z: S.cz }, dimension: dim });
    }
    // Nothing else is simulated while the show is on: bots roaming the world (each keeps its own chunks ticking and runs its own scripts) are removed, and the main bot stands still.
    try {
      const gone = removeExtraBots(new Set([agent.sim.id]));
      if (gone) say(`Removed ${gone} roaming bot${gone === 1 ? '' : 's'} (they only cost performance).`);
      if (p.park !== false) { show.parked = { auto: agent.autoEnabled }; agent.autoEnabled = false; agent.newTask(null); }
    } catch (e) { console.warn(`[colosseum] tidy: ${e}`); }
    // the fighters
    const sides = p.mode === 'bots' ? [['A', p.team], ['B', p.team]] : [['A', p.team]];
    let nm = 0;
    for (const [team, n] of sides) {
      for (let i = 0; i < n; i++) {
        const name = `${CONFIG.botName}${team === 'A' ? 'R' : 'B'}${i + 1}`;
        const where = { dimension: dim, x: S.cx + (team === 'A' ? -R + 1 : R - 1) + 0.5, y: S.G + 1, z: S.cz + (i - (n - 1) / 2) * 4 + 0.5 };
        const w = crew.factory(name, where, agent, { memory: new WorldMemory(null) });
        crew.members.push(w);
        w.autoEnabled = false; w.testHold = true; w.newTask(null);
        w.arenaHook = { onDeath() {}, onRespawn() {}, mobTypes: [], swims: wet, fightId: () => null };
        const style = personality();
        const label = NAMES[nm++ % NAMES.length];
        try { w.sim.nameTag = `${team === 'A' ? '§c' : '§9'}${label}`; } catch { /* */ }
        const load = team === 'B' ? p.blueGear : p.gear;
        const f = { w, team, name, label, style, load, kit: ((l) => kit(l.slots, l.worn))(loadoutKit(load)), melee: meleeIds(load), out: false, kills: 0, dmg: 0, hits: 0, kos: 0, target: null };
        show.fighters.push(f);
        show.stats.set(w.sim.id, f);
        await wait(5);
      }
    }
    await wait(30);
    // who hit whom, who killed whom
    const wa = /** @type {any} */ (world.afterEvents);
    const hs = wa.entityHurt.subscribe((ev) => { try { const f = show.stats.get(ev.damageSource?.damagingEntity?.id); if (f) { f.hits++; f.dmg += ev.damage; } } catch { /* */ } });
    const ds = wa.entityDie.subscribe((ev) => {
      try {
        const f = show.stats.get(ev.damageSource?.damagingEntity?.id);
        if (f && show.foes.some((m) => m.id === ev.deadEntity.id)) { f.kills++; say(`§e${f.label}§r brings down the ${pretty(ev.deadEntity.typeId)}!`); }
      } catch { /* */ }
    });
    subs.push(() => wa.entityHurt.unsubscribe(hs), () => wa.entityDie.unsubscribe(ds));

    if (p.warn?.length) say(`§cIgnored: ${p.warn.join('; ')}`);
    say(p.mode === 'bots' ? `§cRed§r: ${describeLoadout(p.gear)}. §9Blue§r: ${describeLoadout(p.blueGear)}.` : `The bots: ${describeLoadout(p.gear)}.`);
    const score = { A: 0, B: 0, draws: 0 };
    const teamName = (t) => (p.mode === 'bots' ? (t === 'A' ? '§cRed' : '§9Blue') : t === 'A' ? '§cThe bots' : `§2The ${pretty(p.mob.id)}${p.count > 1 ? 's' : ''}`);
    const needed = Math.floor(p.rounds / 2) + 1;
    for (let rd = 1; rd <= p.rounds && !show.abort && score.A < needed && score.B < needed; rd++) {
      show.round = rd; show.over = true;
      // reset the field
      for (const e of dim.getEntities({ location: { x: S.cx, y: S.G, z: S.cz }, maxDistance: 30 })) { if (/arrow|item|xp_orb/.test(e.typeId) || show.foes.includes(e)) { try { e.remove(); } catch { /* */ } } }
      show.foes = [];
      strays(dim, S, p, show);
      for (const f of show.fighters) {
        f.out = false; f.target = null;
        if (!f.w.sim.isValid) continue;
        giveKit(f.w.sim, f.kit); topUp(f.w.sim);
        const i = show.fighters.filter((g) => g.team === f.team).indexOf(f), n = show.fighters.filter((g) => g.team === f.team).length;
        await dropHorse(f);
        f.w.sim.teleport({ x: S.cx + (f.team === 'A' ? -R + 1 : R - 1) + 0.5, y: G, z: S.cz + (i - (n - 1) / 2) * 4 + 0.5 });
        if (f.load.mount) await mountUp(f);
      }
      if (p.mode === 'mobs') {
        for (let i = 0; i < p.count; i++) {
          const fly = FLYERS.has(p.mob.id);
          const at = { x: S.cx + 3 + Math.random() * (R - 5) + 0.5, y: G + (fly ? 3 : 0), z: S.cz + (Math.random() * 2 - 1) * (R - 3) + 0.5 };
          try { show.foes.push(dim.spawnEntity(`minecraft:${p.mob.id}`, at)); } catch (e) {
            if (!i) { say(`§cCannot spawn "${p.mob.id}" (${e}). \`!bot colosseum list\` has the names.`); show.abort = true; break; }
          }
        }
        if (show.abort) break;
      } else {
        
      }
      title(`Round ${rd}`, `${teamName('A')}§r vs ${teamName('B')}`);
      for (let c = 3; c >= 1 && !show.abort; c--) { bar(`§e${c}...`); await wait(20); }
      if (show.abort) break;
      show.over = false;
      const myRound = rd;
      for (const f of show.fighters) drive(f, show, myRound, S, p).catch((e) => console.warn(`[colosseum] ${f.name}: ${e}`));
      const t0 = system.currentTick, limit = (p.mode === 'mobs' && /wither|ender_dragon|warden|elder/.test(p.mob.id) ? 240 : 100) * 20;
      let win = '';
      while (!win && !show.abort) {
        await wait(2);
        for (const f of show.fighters) {
          if (f.out) continue;
          if (!alive(f.w.sim)) { f.out = true; say(`§e${f.label}§r has fallen!`); continue; }
          if (hpOf(f.w.sim) <= KO_HP) {
            f.out = true; f.kos++;
            say(`§e${f.label}§r is knocked out!`);
            topUp(f.w.sim);
            await dropHorse(f);
            f.w.sim.teleport({ x: S.cx + (f.team === 'A' ? -R - 3 : R + 3) + 0.5, y: S.G + 3, z: S.cz - R - 1 + 0.5 });
          }
        }
        if (system.currentTick % 6 === 0) { show.foes = foesNow(dim, S, p, show); strays(dim, S, p, show); }
        else show.foes = show.foes.filter((m) => { try { return m.isValid; } catch { return false; } });
        const a = show.fighters.filter((f) => f.team === 'A' && !f.out).length;
        const b = p.mode === 'bots' ? show.fighters.filter((f) => f.team === 'B' && !f.out).length : show.foes.filter(alive).length;
        if (system.currentTick % 10 === 0) bar(hud(show, p, a, b));
        win = roundWinner({ botsLeft: a, foesLeft: b, timedOut: system.currentTick - t0 > limit });
      }
      show.over = true;
      if (show.abort) break;
      const w = win === 'bots' ? 'A' : win === 'foes' ? 'B' : null;
      if (w) score[w]++; else score.draws++;
      title(w ? `${teamName(w)} take round ${rd}` : `Round ${rd}: a draw`, `${score.A} - ${score.B}`);
      say(`Round ${rd}: ${w ? `${teamName(w)}§r win` : 'a draw'}. Score ${score.A}-${score.B}.`);
      await wait(70);
    }
    if (!show.abort) {
      const champ = score.A > score.B ? 'A' : score.B > score.A ? 'B' : null;
      title(champ ? `${teamName(champ)}§r are the champions!` : 'The series is a draw', `${score.A} - ${score.B}`);
      for (const f of show.fighters) say(`§e${f.label}§r (${f.style.name}): ${f.kills} kills, ${Math.round(f.dmg)} damage in ${f.hits} hits, knocked out ${f.kos}x.`);
      say(`Final: ${score.A}-${score.B}${score.draws ? `, ${score.draws} drawn` : ''}.`);
      await wait(100);
    }
  } finally {
    show.over = true; show.abort = true;
    try { if (show.parked) { agent.autoEnabled = show.parked.auto; if (show.parked.auto) agent.startAuto(); } } catch { /* */ }
    for (const u of subs) { try { u(); } catch { /* */ } }
    for (const e of show.foes) { try { e.remove(); } catch { /* */ } }
    try { for (const e of dim.getEntities({ location: { x: S.cx, y: S.G, z: S.cz }, maxDistance: 30, type: 'minecraft:arrow' })) e.remove(); } catch { /* */ }
    for (const f of show.fighters) {
      try { f.horse?.remove(); } catch { /* */ }
      try { f.w.setBlocking(false); f.w.motor.setFocus(null); f.w.arenaHook = null; f.w.testHold = false; } catch { /* */ }
      try { f.w.sim.disconnect(); } catch { try { dim.runCommand(`kick "${f.w.sim.name}"`); } catch { /* */ } }
      const i = crew.members.indexOf(f.w); if (i >= 0) crew.members.splice(i, 1);
    }
    try { if (griefWas !== null) world.gameRules.mobGriefing = griefWas; else dim.runCommand('gamerule mobgriefing true'); } catch { try { dim.runCommand('gamerule mobgriefing true'); } catch { /* */ } }
    if (show.spawnWas !== undefined) { try { world.gameRules.doMobSpawning = show.spawnWas; } catch { try { dim.runCommand(`gamerule domobspawning ${show.spawnWas}`); } catch { /* */ } } }
    if (show.time !== undefined) {
      try { world.gameRules.doDaylightCycle = show.cycle; } catch { /* */ }
      try { dim.runCommand(`time set ${Math.floor(show.time)}`); } catch { /* */ }
    }
    if (player && show.saved && player.isValid) putBack(player, show.saved, dim);
    try { world.setDynamicProperty(STASH_KEY, undefined); } catch { /* */ }
    try { dim.runCommand(`tickingarea remove ${AREA}`); } catch { /* */ }
    SHOW = null;
    bar('');
  }
}

function hud(show, p, a, b) {
  const hearts = (e) => `${Math.max(0, Math.round(hpOf(e) / 2))}♥`;
  const reds = show.fighters.filter((f) => f.team === 'A').map((f) => `${f.out ? '§8' : '§c'}${f.label} ${f.out ? 'KO' : hearts(f.w.sim)}`).join('  ');
  const foes = p.mode === 'bots'
    ? show.fighters.filter((f) => f.team === 'B').map((f) => `${f.out ? '§8' : '§9'}${f.label} ${f.out ? 'KO' : hearts(f.w.sim)}`).join('  ')
    : `§2${pretty(p.mob.id)} x${b} (${show.foes.filter(alive).reduce((t, m) => t + Math.round(hpOf(m)), 0)} hp)`;
  return `${reds}   §r|   ${foes}`;
}

// ---------- one bot's fight ----------

function enemiesOf(f, show, p) {
  if (p.mode === 'bots') return show.fighters.filter((g) => g.team !== f.team && !g.out && alive(g.w.sim)).map((g) => g.w.sim);
  return show.foes.filter(alive);
}

async function drive(f, show, round, S, p) {
  const a = f.w, sim = a.sim;
  let lastSwing = -99, strafe = 1, nextStrafe = 0, nextShot = 0, chosen = '', lastPos = null, lastPosT = 0;
  const live = () => !show.over && show.round === round && !f.out && alive(sim) && a.sim === sim;
  while (live()) {
    await wait(2);
    if (!live()) break;
    const t = system.currentTick;
    const foes = enemiesOf(f, show, p);
    if (!foes.length) { a.setBlocking(false); continue; }
    const me = sim.location;
    foes.sort((x, y) => d3(me, x.location) - d3(me, y.location));
    // stay on a target unless another is clearly nearer
    let tgt = foes.find((e) => e.id === f.target?.id) ?? foes[0];
    if (tgt !== foes[0] && d3(me, tgt.location) > d3(me, foes[0].location) + 4) tgt = foes[0];
    f.target = tgt;
    const you = tgt.location, d = d2(me, you), dy = you.y - me.y;
    const dx = (you.x - me.x) / (d || 1), dz = (you.z - me.z) / (d || 1);
    if (t >= nextStrafe) { strafe = -strafe; nextStrafe = t + f.style.strafe + Math.floor(Math.random() * 20); }
    const flying = FLYERS.has(String(tgt.typeId).replace('minecraft:', '')) || dy > 2.5;
    const creeper = /creeper/.test(tgt.typeId);
    const arrows = invCounts(sim).arrow ?? 0;
    // Eyes on the target the whole time (the motor's idle head drift turned them away between swings and shots): the view is set and held.
    try { const aimAt = tgt.getHeadLocation ? tgt.getHeadLocation() : { x: you.x, y: you.y + 1.2, z: you.z }; a.motor.setFocus(aimAt); sim.lookAtLocation(aimAt); } catch { /* */ }
    const clear = clearShot(a.dim, sim.getHeadLocation(), tgt);
    const bowNow = f.load.bow && arrows > 0 && clear && ((d > f.style.bowFrom && !(f.style.name === 'brawler' && d < 10)) || (flying && d > 3) || (creeper && d < 9));
    if (bowNow) {
      if (chosen !== 'bow') { hold(sim, 'bow'); chosen = 'bow'; }
      a.setBlocking(false);
      const away = creeper && d < 7 ? -1 : 0;
      a.body.move(away ? -dx : -dz * strafe, away ? -dz : dx * strafe, away ? 1 : 0.6);
      if (t >= nextShot) { await shootAt(a, tgt, { strafe: { x: -dz * strafe, z: dx * strafe }, stop: () => !live() }); nextShot = system.currentTick + 4; }
      continue;
    }
    const weapon = bestWeapon(f.melee.filter((id) => invCounts(sim)[id]).map((id) => ({ id }))) ?? f.melee.find((id) => invCounts(sim)[id]) ?? null;
    if (chosen !== (weapon ?? 'fist')) { hold(sim, weapon); chosen = weapon ?? 'fist'; }
    const wr = weaponReach(weapon), every = Math.max(10, wr.cooldown);
    const riding = !!f.horse && f.horse.isValid && !!a.horses.mounted();
    const far = Math.max(2.4, wr.reach - 0.3), near = riding ? Math.max(1.2, wr.minReach + 0.2) : Math.max(f.style.close - 1, wr.minReach + 0.25);
    try { sim.lookAtEntity(tgt); } catch { /* */ }
    // Behind a pillar or the glass: no shot, and the way round (a step to the side as it closes in) instead of walking into it.
    if (d > far) a.body.move(clear ? dx : dx - dz * strafe * 0.9, clear ? dz : dz + dx * strafe * 0.9, 1);
    else if (d < near) a.body.move(-dx, -dz, 1);
    else a.body.move(-dz * strafe, dx * strafe, 0.8);
    // wedged against a pillar or a step: hop
    if (t - lastPosT >= 10) { if (lastPos && d > far && Math.hypot(me.x - lastPos.x, me.z - lastPos.z) < 0.25) { try { sim.jump(); } catch { /* */ } nextStrafe = 0; } lastPos = { ...me }; lastPosT = t; }
    const ready = t - lastSwing >= every;
    a.setBlocking(!ready && d < 5);
    if (ready && d3(me, you) <= wr.reach + 0.3 && d >= wr.minReach && a.facing({ x: you.x, y: me.y, z: you.z }, 24)) { try { sim.attackEntity(tgt); } catch { /* */ } lastSwing = t; }
  }
  try { a.setBlocking(false); a.body.stop?.(); a.motor.setFocus(null); } catch { /* */ }
}

/** Is there nothing solid (a pillar, the glass wall) between the bot's eye and the target's chest? Arrows into a wall are wasted. */
function clearShot(dim, from, tgt) {
  try {
    const to = tgt.getHeadLocation ? tgt.getHeadLocation() : { x: tgt.location.x, y: tgt.location.y + 1, z: tgt.location.z };
    const dx = to.x - from.x, dy = (to.y - 0.4) - from.y, dz = to.z - from.z, len = Math.hypot(dx, dy, dz);
    if (len < 1.5) return true;
    const hit = dim.getBlockFromRay(from, { x: dx / len, y: dy / len, z: dz / len }, { maxDistance: len - 0.5, includeLiquidBlocks: false, includePassableBlocks: false });
    return !hit;
  } catch { return true; }
}

function putBack(player, saved, dim) {
  try { player.setGameMode(saved.mode); } catch { /* */ }
  try {
    if (saved.spawn) player.setSpawnPoint({ dimension: world.getDimension(saved.spawn.dim), x: saved.spawn.x, y: saved.spawn.y, z: saved.spawn.z });
    else player.setSpawnPoint(undefined);
  } catch (e) { console.warn(`[colosseum] restoring the spawn point: ${e}`); }
  try { player.teleport(saved.pos, { dimension: dim ?? world.getDimension('overworld') }); } catch { /* */ }
}

/** Put a player back from the stash a show that did not end properly left (a crash, a reload). */
export function recoverPlayer(player) {
  if (SHOW) return false;
  let saved = null;
  try { saved = JSON.parse(String(world.getDynamicProperty(STASH_KEY) ?? 'null')); } catch { /* */ }
  if (!saved || saved.name !== player.name) return false;
  putBack(player, saved, null);
  try { world.setDynamicProperty(STASH_KEY, undefined); } catch { /* */ }
  return true;
}

world.afterEvents.playerSpawn.subscribe((ev) => {
  if (ev.initialSpawn) system.runTimeout(() => { try { recoverPlayer(ev.player); } catch { /* */ } }, 60);
});

/** Ids of the bots in the show that is on now (so a clean-up of roaming bots leaves them alone). */
export function colosseumKeepIds() { return SHOW ? SHOW.fighters.map((f) => f.w.sim?.id).filter(Boolean) : []; }

/** A horse for this bot, made the way that works in the game: summoned grown-up, tamed by event, saddled by replaceitem, and ridden by command (all run as the bot). */
export const HORSE_CHAIN = [
  'summon horse ~ ~ ~ ~ ~ minecraft:ageable_grow_up',
  'event entity @e[type=horse,c=1] minecraft:on_tame',
  'replaceitem entity @e[type=horse,c=1] slot.saddle 0 saddle 1',
  'ride @s start_riding @e[type=horse,c=1] teleport_rider',
];

async function mountUp(f) {
  const a = f.w, sim = a.sim, dim = a.dim;
  try {
    for (const c of HORSE_CHAIN) {
      try { sim.runCommand(c); } catch (e) { console.warn(`[colosseum] ${f.name}: "${c}" failed: ${e}`); }
      await wait(3);
    }
    try {
      const hs = dim.getEntities({ type: 'minecraft:horse', location: sim.location, maxDistance: 5 });
      hs.sort((x, y) => d3(sim.location, x.location) - d3(sim.location, y.location));
      f.horse = hs[0] ?? null;
    } catch { /* */ }
    let ok = !!a.horses.mounted();
    if (!ok && f.horse) { try { ok = await a.horses.getOn(a.taskGen, f.horse); } catch { /* the old way, if the ride command did not take */ } }
    f.mounted = ok;
    if (!ok) console.warn(`[colosseum] ${f.name} could not get on its horse: fighting on foot`);
  } catch (e) { console.warn(`[colosseum] horse for ${f.name}: ${e}`); }
}

async function dropHorse(f) {
  try { if (f.horse) { try { await f.w.horses.getOff(f.w.taskGen); } catch { try { f.w.sim.runCommand('ride @s stop_riding'); } catch { /* */ } } try { f.horse.remove(); } catch { /* */ } f.horse = null; } } catch { /* */ }
}

/** The show's mobs now: the ones spawned plus any more of their kind inside the arena (a slime's split, a zombie's reinforcement). */
function foesNow(dim, S, p, show) {
  if (p.mode !== 'mobs') return [];
  const seen = new Map(show.foes.filter((m) => { try { return m.isValid; } catch { return false; } }).map((m) => [m.id, m]));
  try {
    for (const e of dim.getEntities({ type: `minecraft:${p.mob.id}`, location: { x: S.cx, y: S.G + 4, z: S.cz }, maxDistance: R + 8 })) {
      const l = e.location;
      if (Math.abs(l.x - S.cx) <= R + 1 && Math.abs(l.z - S.cz) <= R + 1 && l.y >= S.G && l.y <= S.G + H + 1) seen.set(e.id, e);
    }
  } catch { /* */ }
  return [...seen.values()];
}

/** Hostile things in the arena or its stands that the show did not put there (spawned anyway, wandered in) are removed. */
function strays(dim, S, p, show) {
  try {
    const b = boxOf(S);
    const keep = new Set([...show.foes.map((m) => m.id), ...show.fighters.map((f) => f.horse?.id).filter(Boolean)]);
    const related = p.mode === 'mobs' ? RELATED[p.mob.id] ?? [] : [];
    for (const e of dim.getEntities({ location: { x: b.x1, y: b.y1, z: b.z1 }, volume: { x: b.x2 - b.x1 + 1, y: b.y2 - b.y1 + 1, z: b.z2 - b.z1 + 1 }, families: ['monster'] })) {
      const t = e.typeId.replace('minecraft:', '');
      if (keep.has(e.id) || (p.mode === 'mobs' && (t === p.mob.id || related.includes(t))) || /^simulated|player$/.test(t)) continue;
      try { e.remove(); } catch { /* */ }
    }
  } catch { /* */ }
}
const RELATED = { evoker: ['vex'], ravager: ['pillager', 'vindicator'], witch: [], wither: ['wither_skeleton'], ender_dragon: [], zombie: ['zombie_villager', 'husk', 'drowned'], husk: ['zombie'], skeleton: ['spider'], spider: ['skeleton'], slime: ['slime'], magma_cube: ['magma_cube'] };
