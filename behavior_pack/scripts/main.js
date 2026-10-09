// Entry point. Commands (in chat):
//   !bot spawn            spawn the agent next to you
//   !bot despawn          remove it
//   !bot <anything else>  sent to the brain (come, follow me, goto x y z, stop, ...)
// Same commands without chat:  /scriptevent agent:cmd <text>
import { goodSpawnColumn } from './core/spawnpick.js';
import { topColumn, findLand } from './game/landfinder.js';
import { system, world, GameMode, EquipmentSlot } from '@minecraft/server';
import { spawnSimulatedPlayer } from '@minecraft/server-gametest';
import { Agent } from './game/agent.js';
import { runTests, setTestSeeds } from './game/scenarios.js';
import { arenaCommand } from './game/arenas.js';
import { colosseumCommand, colosseumKeepIds } from './game/colosseum.js';
import { adminCall } from './game/adminlink.js';
import { parseAdmin } from './core/admincmd.js';
import { ironFarmCommand } from './game/ironfarm.js';
import { farmBuildCommand } from './game/farmbuild.js';
import { poll, sendEvent } from './game/bridge.js';
import { CONFIG } from './config.js';
import { orderOf } from './core/toggles.js';
import { applyPolicy, diffFromDefaults } from './core/tunables.js';
import { probeApis } from './game/probe.js';
import { crew, setCrewFactory, everyone, isCrewId, isCrewName } from './game/crew.js';
import { describeStyle } from './core/buildstyle.js';
import { chainItem, chainOutline } from './core/chain.js';
import { getPlan, setPlan, planMaterials, describe } from './core/learnhouse.js';

/** @type {Agent | null} */
let agent = null;

let debugLog = false;

/** player may be undefined when the command comes from the server console. */
function reply(player, msg) {
  if (player) player.sendMessage(msg);
  else console.warn(`[agent] ${msg}`);
}

/** Where to spawn: next to the player, or (from the console) on the surface at world spawn. */
/** A safe world spawn (u296): if the world spawn is not on dry land at the surface (a fresh world from tools/new_world.py had (0,0,0): bedrock level), find the nearest
 * column that is, and set the world spawn there. Runs once per world; nothing is moved when the spawn is already fine. */
async function fixWorldSpawn(force = false) {
  if (!force && world.getDynamicProperty('agent:spawnChecked') === true) return 'checked before';
  const dim = world.getDimension('overworld');
  const s = world.getDefaultSpawnLocation();
  const cur = await topColumn(dim, Math.floor(s.x), Math.floor(s.z));
  let msg;
  if (cur && goodSpawnColumn(cur.id, cur.y) && Math.abs(s.y - (cur.y + 1)) <= 3) msg = `world spawn ${Math.floor(s.x)} ${Math.floor(s.y)} ${Math.floor(s.z)} is fine (${cur.id} at y ${cur.y})`;
  else {
    msg = `world spawn ${Math.floor(s.x)} ${Math.floor(s.y)} ${Math.floor(s.z)} is not on dry land (${cur ? `${cur.id} at y ${cur.y}` : 'not loaded'}); searching`;
    const f = await findLand(dim, Math.floor(s.x), Math.floor(s.z), { step: 48, tries: 60 });
    if (f) { try { dim.runCommand(`setworldspawn ${f.x} ${f.y} ${f.z}`); msg += `; world spawn set to ${f.x} ${f.y} ${f.z} (${f.id})`; } catch (e) { msg += `; setworldspawn failed: ${e}`; } }
    else msg += '; found nothing in 60 tries';
  }
  world.setDynamicProperty('agent:spawnChecked', true);
  console.warn(`[agent] spawn: ${msg}`);
  return msg;
}

async function spawnPoint(player) {
  if (player) {
    const l = player.location;
    return { dimension: player.dimension, x: l.x + 1.5, y: l.y, z: l.z + 1.5 };
  }
  const dim = world.getDimension('overworld');
  const s = world.getDefaultSpawnLocation();
  // With nobody online the spawn chunk may not be loaded; a ticking area loads it.
  try { dim.runCommand(`tickingarea add circle ${s.x} 0 ${s.z} 2 agent_spawn true`); } catch {}
  for (let i = 0; i < 200; i++) {
    const y = surfaceY(dim, s.x, s.z);
    if (y !== null) return { dimension: dim, x: s.x + 0.5, y, z: s.z + 0.5 };
    await system.waitTicks(5);
  }
  throw new Error('spawn chunk never loaded');
}

/** First standable y scanning down from the build limit, or null if the chunk isn't loaded yet. */
function surfaceY(dim, x, z) {
  const { min, max } = dim.heightRange;
  for (let y = max - 1; y > min; y--) {
    const b = dim.getBlock({ x, y, z });
    if (!b) return null;
    if (!b.isAir && !b.isLiquid) return y + 1;
    if (b.isLiquid) return y + 1; // stand on water surface rather than sink; fine for a spawn point
  }
  return null;
}

// How a hired bot is made (game/crew.js): its own simulated player and Agent, sharing the main bot's memory.
setCrewFactory((name, where, primary, opts = {}) => {
  const sim = spawnSimulatedPlayer(where, name, GameMode.Survival);
  try { sim.setSpawnPoint({ dimension: where.dimension, x: Math.floor(where.x), y: Math.floor(where.y), z: Math.floor(where.z) }); } catch { /* */ }
  return new Agent(sim, { worker: true, memory: opts.memory ?? primary.memory });
});

async function spawnAgent(player) {
  // A script reload (/reload) loses our handle on an existing bot; kick the orphan so there's only one.
  for (const p of world.getPlayers({ name: CONFIG.botName })) {
    try { p.dimension.runCommand(`kick "${p.name}"`); } catch { try { p.kill(); } catch {} }
  }
  // A new world session for the brain (its logs and the live report start over): the first spawn into a world, whatever the
  // brain was last told. Not a death and respawn (no new Agent then), not a script reload in the same session.
  try {
    let wid = world.getDynamicProperty('agent:worldId');
    if (typeof wid !== 'string') { wid = `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`; world.setDynamicProperty('agent:worldId', wid); }
    await sendEvent({ type: 'session', world: wid, build: CONFIG.build, tick: system.currentTick });
  } catch { /* the brain may not be up: nothing to reset */ }
  const where = await spawnPoint(player);
  const sim = spawnSimulatedPlayer(where, CONFIG.botName, GameMode.Survival);
  // Simulated players respawn at world spawn, which can be mid-air. Pin a safe one.
  try { sim.setSpawnPoint({ dimension: where.dimension, x: Math.floor(where.x), y: Math.floor(where.y), z: Math.floor(where.z) }); } catch (e) { console.warn(`[agent] setSpawnPoint: ${e}`); }
  agent = new Agent(sim);
  try { world.getDimension('overworld').runCommand('gamerule showcoordinates true'); } catch {} // (see where we are: reports and path logs quote coordinates)
  agent.say(`Ready (build ${CONFIG.build}).`);
}

function handle(text, player) {
  const cmd = text.trim();
  const lower = cmd.toLowerCase();
  // "@Name <command>" from the dashboard: as if that player had typed it (come, follow me, spawn).
  if (cmd.startsWith('@') && !player) {
    const [who, ...rest] = cmd.slice(1).split(/\s+/);
    // (the exact name first; then ignoring case and spaces; then, if only one real player is here, that one: a stale name in the dashboard's list should not stop a click)
    const all = world.getPlayers(), norm = (n) => String(n).toLowerCase().replace(/\s+/g, '');
    const humans = all.filter((x) => !x.name.startsWith(CONFIG.botName));
    const pl = world.getPlayers({ name: who })[0] ?? all.find((x) => norm(x.name) === norm(who)) ?? (humans.length === 1 ? humans[0] : undefined);
    if (!pl) return console.warn(`[agent] dashboard: ${who} isn't online (players here: ${all.map((x) => x.name).join(', ') || 'none'})`);
    if (pl.name !== who) console.warn(`[agent] dashboard: "${who}" matched to ${pl.name}`);
    return handle(rest.join(' '), pl);
  }
  // "@Name /<command>" from the dashboard (a command chain): run it as that player, so @s and ~ ~ ~ mean them.
  if (cmd.startsWith('/') && player) {
    try {
      const r = player.runCommand(cmd.slice(1));
      console.warn(`[agent] ran ${cmd} as ${player.name} (${r.successCount} ok)`);
    } catch (e) { console.warn(`[agent] ${cmd} as ${player.name}: ${e}`); reply(player, `That command failed: ${e}`); }
    return;
  }
  // "/<command>" from the dashboard: run it as the server (time, weather, gamemode, give...).
  if (cmd.startsWith('/') && !player) {
    try {
      const r = world.getDimension('overworld').runCommand(cmd.slice(1));
      console.warn(`[agent] ran ${cmd} (${r.successCount} ok)`);
    } catch (e) { console.warn(`[agent] ${cmd}: ${e}`); }
    return;
  }
  if (lower === 'spawn') {
    if (agent?.sim.isValid) return reply(player, 'Agent already spawned.');
    spawnAgent(player).catch((e) => reply(player, `spawn failed: ${e}`));
    return;
  }
  if (lower === 'fixspawn') { fixWorldSpawn(true).then((m) => reply(player, m)).catch((e) => reply(player, `fixspawn failed: ${e}`)); return; }
  if (lower === 'version') return reply(player, `Bedrock Agent build ${CONFIG.build}`);
  // !bot learn on [name] | off | status: record a player's play so it can learn from it (game/demo.js).
  if (lower === 'learn' || lower.startsWith('learn ')) {
    if (!agent) return reply(player, 'spawn first');
    const [, sub = 'status', who] = lower.split(/\s+/);
    if (sub === 'tow') {
      const pl = world.getPlayers().find((p) => p.name.toLowerCase() === String(who ?? player?.name ?? '').toLowerCase()) ?? world.getPlayers().find((p) => p.id !== agent.sim.id);
      if (!pl) return reply(player, 'Who? `!bot learn tow <name>`.');
      return reply(player, agent.towlearn.start(pl));
    }
    if (sub === 'off' && agent.towlearn.on) return reply(player, agent.towlearn.stop());
    if (sub === 'off') { const was = agent.demo.mode === 'house'; agent.demo.stop(); return reply(player, was ? 'Reading the house you built...' : 'Stopped watching you.'); }
    // `learn house [name]`: your things put aside, a house kit given, the build recorded; `learn off` learns it and gives your things back.
    if (sub === 'house') return reply(player, 'Learning from your house is part of the house test now: `!bot test house me` (or pick Me only on the dashboard). Say `!bot test done` when it is built.');
    if (sub === 'restore') {
      const pl = world.getPlayers().find((p) => p.name.toLowerCase() === String(who ?? player?.name ?? '').toLowerCase()) ?? world.getPlayers().find((p) => p.id !== agent.sim.id);
      if (!pl) return reply(player, 'Who? `!bot learn restore <name>`.');
      return reply(player, agent.demo.restoreFor(pl) ? 'Your things are back.' : 'Nothing of yours is put aside.');
    }
    if (sub === 'on') {
      if (agent.demo.mode === 'house') return reply(player, 'Recording a house: `!bot learn off` first.');
      const pl = world.getPlayers().find((p) => p.name.toLowerCase() === String(who ?? player?.name ?? '').toLowerCase())
        ?? world.getPlayers().find((p) => p.id !== agent.sim.id);
      if (!pl) return reply(player, 'Who? `!bot learn on <name>`.');
      agent.demo.start(pl.name);
      return reply(player, `Watching ${pl.name} play: what you break, place, eat and fight, once a second where you are. \`!bot learn off\` stops. Nothing leaves this computer.`);
    }
    return reply(player, agent.demo.status());
  }
  // !bot look: a picture of the blocks round the bot (4 layers, 11 x 11), in the log and the dashboard: for where it's stuck.
  if (lower === 'look') {
    if (!agent) return reply(player, 'spawn first');
    const lines = agent.flight.surroundings();
    for (const l of lines) console.warn(`[look] ${l}`);
    const txt = lines.join('\n');
    agent.say(`Surroundings:\n${txt}`);
    return reply(player, 'Picture of the surroundings is in the log and on the dashboard.');
  }
  // !bot settings show|reset: the goal toggles and chat setting the brain keeps for every new world (brain/settings.json).
  if (lower === 'settings' || lower.startsWith('settings ')) {
    if (!agent) return reply(player, 'spawn first');
    const sub = lower.split(/\s+/)[1] ?? 'show';
    if (sub === 'reset') { sendEvent({ type: 'setting', reset: true }).catch(() => {}); return reply(player, 'Forgot the saved settings (this world keeps its own until you change them).'); }
    return reply(player, `This world: ${JSON.stringify(agent.memory.data.settings ?? {})}. Saved on this computer: they come back in every new world (\`!bot settings reset\` forgets them).`);
  }
  // !bot chat on|off: the bot's running commentary (what it's doing and why) in the game's chat. Off by default; the dashboard shows it either way.
  if (lower === 'chat' || lower.startsWith('chat ')) {
    if (!agent) return reply(player, 'spawn first');
    const sub = lower.split(/\s+/)[1] ?? 'status';
    if (sub === 'on' || sub === 'off') agent.setSetting('chat', sub === 'on');
    return reply(player, `In-game chat from the bot is ${agent.chatOn() ? 'ON' : 'OFF'} (the dashboard shows everything either way).`);
  }
  // !bot get <item> [n] / !bot chain [clear]: AltoClef-style task chains (core/chain.js). Asks for an item and the bot works out
  // and does everything it takes: wood, a table, a pickaxe, stone, iron, a furnace, smelting, the crafting.
  if (/^get (on|off)( .*)?$/.test(lower)) { /* handled below: get on / get off the horse */ }
  else if (lower === 'chain' || lower.startsWith('chain ') || lower.startsWith('get ')) {
    if (!agent) return reply(player, 'spawn first');
    const words = lower.replace(/^(chain|get)\s*/, '').split(/\s+/).filter(Boolean);
    if (words[0] === 'clear') { agent.clearChain(); return reply(player, 'Chain queue cleared.'); }
    if (!words.length) {
      const q = agent.chainQueue();
      return reply(player, q.length ? `Working on: ${q.map((g) => `${g.n} ${g.item}`).join(' > ')}. Steps for the first: ${chainOutline(q[0].item).join(' > ')}.` : 'No chain queued. `!bot get iron_pickaxe`, `!bot get 20 cobblestone`, `!bot get 3 iron_ingot` (names: anything it can craft, log, cobblestone, raw_iron, iron_ingot).');
    }
    const n = /^\d+$/.test(words[0]) ? Math.min(256, +words.shift()) : 1;
    const item = chainItem(words.join('_'));
    if (!item) return reply(player, `I don't know how to get "${words.join(' ')}" yet (anything craftable, logs, cobblestone, raw iron, iron ingots, horse, ride).`);
    agent.addChain(item, n);
    return reply(player, `Chain: ${n} ${item}: ${chainOutline(item).join(' > ')}.`);
  }
  // !bot tow <x> <z>: lead the nearest boat there over whatever is in the way, on foot or on the horse it is on (game/leadtow.js).
  { const t = lower.match(/^tow\s+(-?\d+)\s+(?:-?\d+\s+)?(-?\d+)$/); if (t) { if (!agent) return reply(player, 'spawn first'); agent.startTow(+t[1], +t[2]); return reply(player, `Towing the nearest boat to ${t[1]} ${t[2]}.`); } }
  // !bot mount / !bot dismount: get on its horse (tamed and saddled first if it can), and off again.
  if (lower === 'mount' || /^get on( .*)?$/.test(lower) || lower === 'ride') { if (!agent) return reply(player, 'spawn first'); agent.startMount(); return reply(player, 'Going to its horse.'); }
  if (lower === 'dismount' || /^get off( .*)?$/.test(lower)) { if (!agent) return reply(player, 'spawn first'); agent.startDismount(); return reply(player, 'Getting off.'); }
  // !bot order [village farm iron]: which goal after moving in comes first (what's named first, the rest in the usual order).
  if (lower === 'order' || lower.startsWith('order ')) {
    if (!agent) return reply(player, 'spawn first');
    const arg = lower.slice(5).trim();
    const order = arg ? agent.setOrder(arg) : orderOf(agent.memory.data.settings);
    return reply(player, `After moving in: ${order.join(' > ')}${arg ? '' : ' (change it with `!bot order farm iron village`)'}.`);
  }
  // !bot style: what it has learned of how you build (core/buildstyle.js).
  if (lower === 'style') { if (!agent) return reply(player, 'spawn first'); return reply(player, describeStyle(agent.memory.data.style)); }
  // !bot village [visit]: the villages it has recognised from afar (game/villages.js); `visit` goes now.
  if (lower === 'village' || lower === 'villages' || lower.startsWith('village ')) {
    if (!agent) return reply(player, 'spawn first');
    const here = agent.sim.location;
    const list = agent.villages.status().map((v) => `${v.x} ${v.y} ${v.z} (${Math.round(Math.hypot(v.x - here.x, v.z - here.z))} away, score ${v.score}${v.danger ? ', RAIDERS' : ''}${v.visited ? ', visited' : ''})`);
    // !bot village at <x> <z>: a village you found (`/locate structure village` shows it to you; the script never sees command text).
    const at = lower.match(/^villages?\s+at\s+(-?\d+)\s+(?:-?\d+\s+)?(-?\d+)$/);
    if (at) {
      const x = +at[1], z = +at[2];
      agent.villages.addKnown(x, z);
      agent.setGoal('villages', true);
      return reply(player, `Noted a village at ${x} ${z}: going there when the plan gets to villages (switched on).`);
    }
    if (lower.endsWith('visit')) {
      const v = agent.villages.pick('bed') ?? agent.villages.pick('food');
      if (!v) return reply(player, list.length ? 'None to go to now (raiders, visited lately or too far).' : 'No village known yet.');
      agent.startVillage(v);
      return reply(player, `Going to the village at ${v.x} ${v.y} ${v.z}.`);
    }
    return reply(player, list.length ? `Villages: ${list.join('; ')}` : 'No village known yet (it looks every 3 s out to 64 blocks).');
  }
  // !bot house learned on|off|show|clear: build the next house like the one you built (`!bot learn house`), or the starter.
  if (lower === 'house' || lower.startsWith('house ')) {
    if (!agent) return reply(player, 'spawn first');
    const [, what, sub = 'show'] = lower.split(/\s+/);
    if (what !== 'learned') return reply(player, 'Usage: !bot house learned on | off | show | clear');
    const plan = getPlan();
    if (sub === 'on') {
      if (!plan) return reply(player, 'No learned house yet: `!bot learn house` and build one.');
      agent.setGoal('learnedHouse', true);
      return reply(player, agent.homestead.house ? 'The next house gets your layout (the one standing now stays as it is).' : 'The house will be built like yours.');
    }
    if (sub === 'off') { agent.setGoal('learnedHouse', false); return reply(player, 'Back to the starter house.'); }
    if (sub === 'clear') { setPlan(null); try { world.setDynamicProperty('agent:houseplan', undefined); } catch {} agent.setGoal('learnedHouse', false); return reply(player, 'Forgot your house.'); }
    if (!plan) return reply(player, 'No learned house.');
    const m = planMaterials(plan);
    return reply(player, `${agent.memory.data.settings?.learnedHouse ? 'IN USE' : 'not in use'}: ${m.stone} stone + ${m.planks} wood blocks, ${plan.floor.length} floor cells, ${plan.chests.length} chest(s).\n${describe(plan).join('\n')}`);
  }
  // !bot profile on|off|show|refresh: use (or not) what it learned from you.
  if (lower === 'profile' || lower.startsWith('profile ')) {
    if (!agent) return reply(player, 'spawn first');
    const sub = lower.split(/\s+/)[1] ?? 'show';
    if (sub === 'off' || sub === 'on') { CONFIG.useProfile = sub === 'on'; agent.refreshProfile(true); return reply(player, `Learned numbers ${sub}.`); }
    if (sub === 'refresh') { agent.refreshProfile(true).then((g) => reply(player, g.notes.length ? g.notes.join('; ') : 'Defaults (nothing learned yet).')); return; }
    const pr = agent.profile;
    return reply(player, `${CONFIG.useProfile === false ? 'OFF. ' : ''}eat at ${pr.params.eat_at}, iron at Y ${pr.params.iron_y}. ${pr.notes.length ? pr.notes.join('; ') : 'All defaults.'}`);
  }
  // !bot offhand <item|shield|clear>: put an item in the bot's off hand to see whether the game draws it
  // (a torch, a totem_of_undying, a shield). Tells shield-specific from off-hand-in-general; test only.
  if (lower === 'offhand' || lower.startsWith('offhand ')) {
    if (!agent) return reply(player, 'spawn first');
    const item = (lower.split(/\s+/)[1] ?? '').replace(/[^a-z0-9_]/g, '');
    if (!item) return reply(player, 'Usage: !bot offhand torch | totem_of_undying | shield | clear');
    try {
      const eq = agent.sim.getComponent('minecraft:equippable');
      if (item === 'clear') { eq.setEquipment(EquipmentSlot.Offhand, undefined); reply(player, 'Off hand cleared (the shield comes back with !bot reshield).'); return; }
      const r = world.getDimension('overworld').runCommand(`replaceitem entity @a[name="${agent.sim.name}"] slot.weapon.offhand 0 ${item}`);
      console.warn(`[agent] offhand test: ${item} -> replaceitem ${r.successCount} ok; the game says it holds ${eq.getEquipment(EquipmentSlot.Offhand)?.typeId ?? 'nothing'}`);
      reply(player, `Off hand: ${item}. Is it drawn on the bot? Then try another, or !bot offhand clear.`);
    } catch (e) { reply(player, `offhand ${item}: ${e}`); }
    return;
  }
  // !bot reshield: put the shield on again so it's drawn (clear, set, replaceitem); see agent.refreshShield.
  if (lower === 'reshield') {
    if (!agent) return reply(player, 'spawn first');
    agent.refreshShield().then((ok) => reply(player, ok ? 'Shield put on again: is it showing?' : 'No shield in the off hand.')).catch(() => {});
    return;
  }
  // !bot dump [why]: the flight report now, printed to the server console ([flight] lines) and sent to the brain.
  if (lower === 'dump' || lower.startsWith('dump ')) {
    if (!agent) return reply(player, 'spawn first');
    agent.flight.dump(`asked for${lower.length > 4 ? `: ${lower.slice(5)}` : ''}`);
    return reply(player, 'Flight report printed to the server log ([flight] lines).');
  }
  if (lower === 'debug') {
    debugLog = !debugLog;
    CONFIG.debug = debugLog;
    return reply(player, `debug log ${debugLog ? 'on' : 'off'}`);
  }
  if (lower.startsWith('testcave')) {
    const minR = Number(lower.split(' ')[1] ?? 0);
    // Debug: teleport the bot into the nearest natural cave pocket below it (for testing escapes).
    const sim = agent?.sim;
    if (!sim) return reply(player, 'spawn first');
    const d = sim.dimension, o = sim.location;
    for (let r = minR; r <= minR + 64; r += 2) {
      for (let dx = -r; dx <= r; dx += 2) for (let dz = -r; dz <= r; dz += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = Math.floor(o.x) + dx, z = Math.floor(o.z) + dz;
        let top; try { top = d.getTopmostBlock({ x, z }); } catch { continue; }
        if (!top) continue;
        for (let y = top.location.y - 12; y > top.location.y - 50; y--) {
          try {
            const f = d.getBlock({ x, y: y - 1, z }), a1 = d.getBlock({ x, y, z }), a2 = d.getBlock({ x, y: y + 1, z });
            if (f && a1 && a2 && !f.isAir && !f.isLiquid && a1.isAir && a2.isAir) {
              sim.teleport({ x: x + 0.5, y, z: z + 0.5 });
              return reply(player, `testcave: ${x} ${y} ${z}, surface ${top.location.y}`);
            }
          } catch {}
        }
      }
    }
    return reply(player, 'testcave: none found');
  }
  // !bot probe api: try the game calls the bot relies on, once, and write down what the game answered (trace, events.jsonl).
  if (lower === 'probe api' || lower === 'probe') {
    if (!agent) return reply(player, 'spawn first');
    reply(player, 'Probing the game calls on a patch in front of me...');
    probeApis(agent).then((r) => reply(player, `Probe done: ${r.length} answers, in the decisions list and brain/logs/events.jsonl.`)).catch((e) => reply(player, `Probe failed: ${e}`));
    return;
  }
  if (lower === 'aimprobe') {
    // Debug: how far off the crosshair lands from where the bot means it (head vs eye, turn error).
    const A = agent; if (!A?.sim) return reply(player, 'spawn first');
    (async () => {
      const sim = A.sim, S = A.skills, f = S.feet();
      const tests = [];
      for (const [dx, dz] of [[2, 0], [3, 0], [2, 2], [0, 3], [-3, 1], [4, -1]]) for (const dy of [-1, 0, 1]) tests.push({ x: f.x + dx + 0.5, y: f.y + dy + 0.5, z: f.z + dz + 0.5 });
      const h0 = sim.getHeadLocation(), e0 = S.eye();
      console.warn(`[aimprobe] feet ${sim.location.x.toFixed(3)} ${sim.location.y.toFixed(3)} ${sim.location.z.toFixed(3)} head ${h0.x.toFixed(3)} ${h0.y.toFixed(3)} ${h0.z.toFixed(3)} eye ${e0.x.toFixed(3)} ${e0.y.toFixed(3)} ${e0.z.toFixed(3)} sneaking ${sim.isSneaking}`);
      for (const t of tests) {
        A.motor.setFocus(t);
        let k = 0; for (; k < 30 && S.aimError(t) > 0.3; k++) await system.waitTicks(1);
        const r = sim.getRotation(), h = sim.getHeadLocation();
        const dx = t.x - h.x, dy = t.y - h.y, dz = t.z - h.z;
        const yaw = Math.atan2(-dx, dz) * 180 / Math.PI, pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
        console.warn(`[aimprobe] target ${t.x.toFixed(1)} ${t.y.toFixed(1)} ${t.z.toFixed(1)}: ticks ${k}, err yaw ${(((yaw - r.y + 540) % 360) - 180).toFixed(2)} pitch ${(pitch - r.x).toFixed(2)}, aimError ${S.aimError(t).toFixed(2)}`);
      }
      A.motor.setFocus(null);
    })();
    return;
  }
  if (lower === 'resetmem') {
    // Debug (tests): forget everything remembered about the world (tables, trees, the house...), so a test starts clean.
    const A = agent; if (!A?.sim) return reply(player, 'spawn first');
    A.memory.data = { v: 3, res: [] };
    A.memory.saveNow?.();
    return reply(player, 'memory wiped');
  }
  if (lower === 'calibrate') {
    // Debug: measure the head height, a jump and the item-use gap now (game/calibrate.js), say what came out.
    const A = agent; if (!A?.sim) return reply(player, 'spawn first');
    A.calibration.runNow().then((r) => reply(player, `calibration: ${r}`)).catch((e) => reply(player, `calibration failed: ${e}`));
    return;
  }
  if (lower === 'dump') {
    // Debug: print the blocks around the bot, one layer per level ('.' air, L leaves, T log, # solid, ~ liquid).
    const sim = agent?.sim; if (!sim) return reply(player, 'spawn first');
    const d = sim.dimension, o = { x: Math.floor(sim.location.x), y: Math.floor(sim.location.y), z: Math.floor(sim.location.z) };
    console.warn(`[dump] feet ${o.x} ${o.y} ${o.z}`);
    for (let y = o.y + 4; y >= o.y - 4; y--) {
      const rows = [];
      for (let z = o.z - 5; z <= o.z + 5; z++) {
        let r = '';
        for (let x = o.x - 5; x <= o.x + 5; x++) {
          let b; try { b = d.getBlock({ x, y, z }); } catch {}
          const id = b?.typeId ?? '?';
          r += !b ? '?' : b.isAir ? '.' : b.isLiquid ? '~' : /leaves/.test(id) ? 'L' : /_log$/.test(id) ? 'T' : /vine/.test(id) ? 'v' : /grass|fern|flower|sapling/.test(id) ? ',' : '#';
        }
        rows.push(r);
      }
      console.warn(`[dump] y=${y}${y === o.y ? ' (feet)' : ''}`);
      for (const r of rows) console.warn(`[dump]   ${r}`);
    }
    return;
  }
  if (lower === 'logscan') {
    // Debug: run the real tree scan and show, for the nearest few, what's at each spot and what we see.
    const S = agent?.skills; if (!S) return;
    S.scan((id) => /(_log|_wood|_stem|_hyphae)$/.test(id), { radius: 32, below: 4, above: 10, limit: 12 }).then((found) => {
      const f = S.feet();
      console.warn(`[logscan] feet ${f.x} ${f.y} ${f.z}: ${found.length} found`);
      for (const b of found.slice(0, 6)) console.warn(`[logscan]  ${b.id} at ${b.x} ${b.y} ${b.z} (now ${S.blockAt(b)}): sees ${S.sees(b, true)}; ${S.whyNotUsable(b)}`);
    });
    return;
  }
  if (lower.startsWith('raylog ')) {
    // Debug: one ray from the eye to the centre of block x y z, long range; what does it hit, how far?
    const sim = agent?.sim; if (!sim) return;
    const [x, y, z] = lower.split(/\s+/).slice(1).map(Number);
    const d = sim.dimension, e = sim.getHeadLocation();
    const c = { x: x + 0.5, y: y + 0.5, z: z + 0.5 };
    const dx = c.x - e.x, dy = c.y - e.y, dz = c.z - e.z, len = Math.hypot(dx, dy, dz);
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    for (const opts of [{ maxDistance: len + 0.5 }, { maxDistance: 64 }, {}]) {
      let r;
      try { const h = d.getBlockFromRay(e, dir, { ...opts, includePassableBlocks: false, includeLiquidBlocks: false }); r = h ? `${h.block.typeId}@${h.block.location.x},${h.block.location.y},${h.block.location.z} face ${JSON.stringify(h.faceLocation)}` : 'nothing'; } catch (err) { r = `err ${err}`; }
      console.warn(`[raylog] eye ${e.x.toFixed(2)} ${e.y.toFixed(2)} ${e.z.toFixed(2)} target ${d.getBlock({ x, y, z })?.typeId} len ${len.toFixed(2)} opts ${JSON.stringify(opts)}: ${r}`);
    }
    return;
  }
  if (lower === 'raytest') {
    // Debug: how far do block raycasts reach? Gold blocks at eye level 5..40 blocks east, one ray each.
    const sim = agent?.sim; if (!sim) return;
    const d = sim.dimension, e = sim.getHeadLocation();
    const out = [];
    for (const [ox, oy, oz] of [[5, 0, 5], [5, 0, -5], [-5, 0, 5], [-5, 0, -5], [5, 1, 0], [5, -1, 0], [0, 1, 5], [8, 0, 0], [8, 0, 1], [8, 0, 3]]) {
      const [ax, az, k] = [ox, oz, oy];
      const p = { x: Math.floor(e.x) + ox, y: Math.floor(e.y) + oy, z: Math.floor(e.z) + oz };
      let before = '?';
      try { before = d.getBlock(p)?.typeId ?? 'unloaded'; d.setBlockType(p, 'minecraft:gold_block'); } catch (err) { out.push(`${k}: set ${err}`); continue; }
      const c = { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 };
      const dx = c.x - e.x, dy = c.y - e.y, dz = c.z - e.z, len = Math.hypot(dx, dy, dz);
      let hit = null;
      try { hit = d.getBlockFromRay(e, { x: dx / len, y: dy / len, z: dz / len }, { maxDistance: len + 0.5, includePassableBlocks: false, includeLiquidBlocks: false }); } catch (err) { out.push(`${k}: ray ${err}`); }
      out.push(`${ax},${az}*${k}: ${hit ? `${hit.block.typeId.replace('minecraft:', '')}@${hit.block.location.x},${hit.block.location.z}` : 'nothing'}`);
      try { d.setBlockType(p, before === 'unloaded' ? 'minecraft:air' : before); } catch {}
    }
    console.warn(`[raytest] ${out.join(' | ')}`);
    return;
  }
  if (lower === 'column') {
    const sim = agent?.sim; if (!sim) return;
    const f = { x: Math.floor(sim.location.x), y: Math.floor(sim.location.y), z: Math.floor(sim.location.z) };
    const ids = [];
    for (let y = f.y; y < f.y + 24; y++) { try { ids.push(`${y}:${sim.dimension.getBlock({ x: f.x, y, z: f.z })?.typeId.replace('minecraft:', '')}`); } catch { ids.push(`${y}:?`); } }
    console.warn(`[column] ${ids.join(' ')}`);
    return;
  }
  if (lower === 'skyline') {
    const sim = agent?.sim; if (!sim) return;
    const f = { x: Math.floor(sim.location.x), y: Math.floor(sim.location.y), z: Math.floor(sim.location.z) };
    const out = [];
    for (const r of [4, 8, 16, 24]) {
      const row = [];
      for (let a = 0; a < 8; a++) {
        const x = f.x + Math.round(Math.cos(a * Math.PI / 4) * r), z = f.z + Math.round(Math.sin(a * Math.PI / 4) * r);
        let y = '?'; try { y = agent.skills.groundTop(x, z); } catch {}
        row.push(y);
      }
      out.push(`r${r}: ${row.join(' ')}`);
    }
    console.warn(`[skyline] at ${f.x} ${f.y} ${f.z}: ${out.join(' | ')}`);
    return;
  }
  if (lower === 'around') {
    // Debug: print the blocks around the bot, layer by layer (feet-1 .. feet+3).
    const sim = agent?.sim; if (!sim) return;
    const f = { x: Math.floor(sim.location.x), y: Math.floor(sim.location.y), z: Math.floor(sim.location.z) };
    for (let dy = -1; dy <= 3; dy++) {
      const rows = [];
      for (let dz = -2; dz <= 2; dz++) {
        const row = [];
        for (let dx = -2; dx <= 2; dx++) {
          let id = '?';
          try { id = sim.dimension.getBlock({ x: f.x + dx, y: f.y + dy, z: f.z + dz })?.typeId.replace('minecraft:', '') ?? '?'; } catch {}
          row.push((dx === 0 && dz === 0 ? '*' : '') + id.slice(0, 9));
        }
        rows.push(row.join(' '));
      }
      console.warn(`[around] y${dy >= 0 ? '+' : ''}${dy} at ${f.x} ${f.y} ${f.z}\n  ${rows.join('\n  ')}`);
    }
    return;
  }
  // !bot policy {json} | policy clear | policy: the trained constants (core/tunables.js), applied at once and kept in the world's memory. The trainer sends these.
  if (lower === 'policy' || lower.startsWith('policy ')) {
    if (!agent) return reply(player, 'spawn first');
    const arg = cmd.slice(6).trim();
    try {
      if (arg === 'clear') agent.memory.data.policy = null;
      else if (arg) { const o = JSON.parse(arg); if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object'); agent.memory.data.policy = o; }
      const applied = applyPolicy(agent.memory.data.policy);
      if (arg) agent.memory.save();
      sendEvent({ type: 'policy', policy: diffFromDefaults(applied) });
      reply(player, `policy: ${JSON.stringify(diffFromDefaults(applied))}`);
    } catch (e) { reply(player, `policy: ${e}`); }
    return;
  }
  // !bot testseed {"*": 123, "raid": 7} | testseed clear: the seeds the random-course tests use (the trainer pairs the champion's and the candidate's runs on the same courses).
  if (lower === 'testseed' || lower.startsWith('testseed ')) {
    const arg = cmd.slice(8).trim();
    try { if (!arg || arg === 'clear') setTestSeeds(null); else { const o = JSON.parse(arg); setTestSeeds(o && typeof o === 'object' && !Array.isArray(o) ? o : typeof o === 'number' ? { '*': o } : null); } reply(player, `testseed: ${arg || 'clear'}`); } catch (e) { reply(player, `testseed: ${e}`); }
    return;
  }
  if (lower === 'done') { if (agent) /** @type {any} */ (agent).testDone = true; return; } // finished the house you were building for the test
  if (lower === 'test' || lower.startsWith('test ')) {
    if (!agent?.sim.isValid) return reply(player, 'spawn first');
    // From the dashboard there is no sender: the first real player is the one who takes part.
    const tester = player ?? world.getPlayers().find((pl) => pl.name !== agent.sim.name);
    runTests(agent, tester, lower.split(/\s+/).slice(1)).catch((e) => console.error(`[test] ${e}\n${e.stack}`));
    return;
  }
  if (lower === 'buildfarm' || lower.startsWith('buildfarm ') || lower.startsWith('ironfarm bot')) {
    // The same farm, built by the bot with its own hands on a pad in the sky (game/farmbuild.js).
    if (!agent?.sim.isValid) return reply(player, 'spawn first');
    const fw = lower.split(/\s+/).slice(1);
    farmBuildCommand(agent, player, lower.startsWith('ironfarm') ? fw.slice(1) : fw);
    return;
  }
  if (lower === 'ironfarm' || lower.startsWith('ironfarm ')) {
    // The iron golem farm (game/ironfarm.js), built with game commands: no bot needed.
    ironFarmCommand(player, lower.split(/\s+/).slice(1));
    return;
  }
  if (lower === 'admin' || lower.startsWith('admin ')) {
    // The Bedrock admin service (a separate program), through the brain with the bot's limited token: status, a console command, a saved chain, a backup.
    const q = parseAdmin(cmd.split(/\s+/).slice(1).map((w, i) => (i === 0 ? w.toLowerCase() : w)));
    if (q.error) return reply(player, `usage: !bot ${q.error}`);
    adminCall(q).then((r) => reply(player, `[admin] ${r.ok ? '' : 'refused/failed: '}${r.say}`));
    return;
  }
  if (lower === 'colosseum' || lower.startsWith('colosseum ')) {
    // Bots in diamond gear against any mob (or each other) in a glass arena with stands (game/colosseum.js).
    if (!agent?.sim.isValid) return reply(player, 'spawn first');
    colosseumCommand(agent, player, lower.split(/\s+/).slice(1));
    return;
  }
  if (lower === 'arena' || lower.startsWith('arena ')) {
    // Head-to-head test arenas (game/arenas.js): !bot arena <name> [seconds|solo], stop, leave.
    if (!agent?.sim.isValid) return reply(player, 'spawn first');
    const aw = lower.split(/\s+/).slice(1);
    // The forest is turn-taking (the bot's minute, then yours): it is a test of the test framework, not a side-by-side arena.
    if (aw[0] === 'forest') { runTests(agent, player, ['forest', aw[1] === 'solo' || !player ? 'bot' : 'both']).catch((e) => console.error(`[test] ${e}\n${e.stack}`)); return; }
    arenaCommand(agent, player, aw);
    return;
  }
  if (lower === 'despawn others' || lower === 'despawn extras' || lower === 'cleanup bots') {
    // Every simulated player that is not the main bot (nor fighting in a colosseum show now): hired workers, benchmark bots, orphans left by a script reload.
    const keep = new Set([agent?.sim?.id, ...colosseumKeepIds()].filter(Boolean));
    let n = 0;
    for (const p of world.getPlayers()) {
      if (keep.has(p.id) || !p.name.startsWith(CONFIG.botName)) continue;
      try { p.dimension.runCommand(`kick "${p.name}"`); n++; } catch { try { p.kill(); n++; } catch { /* */ } }
    }
    for (let i = crew.members.length - 1; i >= 0; i--) if (!keep.has(crew.members[i].sim?.id)) { try { crew.members[i].newTask(null); } catch { /* */ } crew.members.splice(i, 1); }
    return reply(player, n ? `Removed ${n} extra bot${n === 1 ? '' : 's'}.` : 'No extra bots found.');
  }
  if (lower === 'despawn') {
    if (agent?.sim.isValid) { try { agent.saveKit(); } catch {} agent.sim.disconnect(); } // its things come back with it on the next spawn
    agent = null;
    return;
  }
  if (!agent?.sim.isValid) return reply(player, `No agent. Type "${CONFIG.commandPrefix} spawn" first.`);
  agent.command(cmd, player ? player.name : 'console');
}

const lastChat = new Map();
world.afterEvents.chatSend.subscribe((ev) => {
  const msg = ev.message;
  if (ev.sender.name === CONFIG.botName || ev.sender.id === agent?.sim.id || isCrewId(ev.sender.id) || isCrewName(ev.sender.name)) return;
  if (msg.toLowerCase().startsWith(CONFIG.commandPrefix)) return handle(msg.slice(CONFIG.commandPrefix.length), ev.sender);
  // Plain chat: the brain (Jev) decides whether it's meant for the bot. At most one line per
  // player every 2 s, short lines only: keeps it cheap and ignores pasted walls of text.
  if (!CONFIG.naturalChat || !agent?.sim.isValid || msg.length > 160) return;
  const now = system.currentTick;
  if (now - (lastChat.get(ev.sender.id) ?? -Infinity) < 40) return;
  lastChat.set(ev.sender.id, now);
  agent.chat(msg, ev.sender.name);
});

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== 'agent:cmd') return;
  const src = ev.sourceEntity;
  handle(ev.message, src && src.typeId === 'minecraft:player' ? src : undefined);
});

// Remember who hits us: provoked neutral mobs become threats, and we hit back at the right one.
// (u296) A fresh world: make sure the world spawn is dry land, and a player's first join that landed underground or in water is moved to it.
system.runTimeout(() => { fixWorldSpawn().catch((e) => console.warn(`[agent] spawn check: ${e}`)); }, 60);
world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn || ev.player.id === agent?.sim.id) return;
  (async () => {
    const p = ev.player;
    if (p.getDynamicProperty('agent:seen') === true) return;
    p.setDynamicProperty('agent:seen', true);
    for (let i = 0; i < 40 && world.getDynamicProperty('agent:spawnChecked') !== true; i++) await system.waitTicks(20);
    let wet = false;
    try { wet = p.dimension.getBlock(p.location)?.isLiquid ?? false; } catch { /* */ }
    if (p.location.y < 55 || wet) {
      const s = world.getDefaultSpawnLocation();
      p.teleport({ x: s.x + 0.5, y: s.y, z: s.z + 0.5 }, { dimension: world.getDimension('overworld') });
      console.warn(`[agent] moved ${p.name} from ${Math.floor(p.location.x)} ${Math.floor(p.location.y)} ${Math.floor(p.location.z)} to the world spawn`);
    }
  })().catch(() => {});
});
world.afterEvents.playerSpawn.subscribe((ev) => { try { if (ev.initialSpawn && ev.player.id !== agent?.sim.id) agent?.demo.restoreOnJoin(ev.player); } catch { /* */ } });
world.afterEvents.playerBreakBlock.subscribe((ev) => { try { agent?.demo.onBreak(ev); } catch { /* recording never breaks play */ } });
world.afterEvents.playerPlaceBlock.subscribe((ev) => { try { agent?.demo.onPlace(ev); } catch { /* */ } });
world.afterEvents.itemCompleteUse.subscribe((ev) => { try { agent?.demo.onEat(ev); } catch { /* */ } });
world.afterEvents.entityHurt.subscribe((ev) => {
  for (const w of crew.members) { if (ev.hurtEntity.id === w.sim?.id) { try { w.onHurt(ev.damageSource.damagingEntity, ev.damageSource.cause, ev.damage); } catch { /* */ } } }
  if (!agent) return;
  try { agent.demo.onHurt(ev); } catch { /* */ }
  // Following someone: what goes for them, and what they go for, is ours to fight too.
  if (ev.hurtEntity.id !== agent.sim.id) { try { agent.onEscortHurt(ev.hurtEntity, ev.damageSource.damagingEntity); } catch {} return; }
  agent.onHurt(ev.damageSource.damagingEntity, ev.damageSource.cause, ev.damage);
});

// Dead simulated players don't respawn on their own.
world.afterEvents.entityDie.subscribe((ev) => {
  for (const w of crew.members) {
    if (ev.deadEntity.id !== w.sim?.id) continue;
    try { w.onDeath(); } catch { /* */ }
    system.runTimeout(() => { try { w.sim.respawn(); } catch (e) { console.error(`[crew] respawn failed: ${e}`); } }, 40);
  }
  if (agent) { try { agent.demo.onDie(ev); } catch { /* */ } }
  if (!agent || ev.deadEntity.id !== agent.sim.id) return;
  const src = ev.damageSource;
  const by = src.damagingEntity ? src.damagingEntity.typeId.replace('minecraft:', '') : src.cause;
  const p = agent.sim.location;
  agent.say(`Died (${by}) at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}.`);
  agent.onDeath();
  system.runTimeout(() => {
    try {
      agent?.sim.respawn();
      agent?.say('Respawned.');
      agent?.arenaHook?.onRespawn?.();
    } catch (e) {
      console.error(`[agent] respawn failed: ${e}`);
    }
  }, 40);
});

system.runInterval(() => {
  if (!agent) return;
  try {
    const t0 = Date.now();
    agent.tick();
    agent.notePerf(Date.now() - t0);
    for (const w of crew.members) { try { if (w.sim.isValid) w.tick(); } catch (e) { console.error(`[crew] tick error: ${e}`); } }
    if (debugLog && system.currentTick % 20 === 0) {
      const p = agent.sim.location, r = agent.sim.getRotation();
      console.warn(`[agent] pos ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} yaw ${r.y.toFixed(1)} pitch ${r.x.toFixed(1)} task ${agent.task?.kind ?? 'idle'}`);
    }
  } catch (e) {
    console.error(`[agent] tick error: ${e}\n${e.stack}`);
  }
}, 1);

// A slow script tick must never take the whole server down: cancel the watchdog's termination
// (the hang is logged; the bot carries on) instead of letting BDS shut down.
try {
  system.beforeEvents.watchdogTerminate.subscribe((e) => {
    e.cancel = true;
    console.warn(`[agent] watchdog wanted to terminate scripts (${e.terminateReason}); cancelled`);
  });
} catch (e) { console.warn(`[agent] watchdog hook: ${e}`); }

// Dashboard: status out, commands in, once a second.
let polling = false;
system.runInterval(() => {
  if (polling) return;
  polling = true;
  let status;
  try { status = agent?.sim.isValid ? agent.status() : { online: false, name: CONFIG.botName, players: world.getPlayers().map((pl) => pl.name).filter((n) => !n.startsWith(CONFIG.botName)) }; } catch (e) { status = { online: !!agent, error: `${e}` }; }
  // (u296) The hired bots too: who is out there and what each is doing (the dashboard and the benchmark read this).
  try {
    if (crew.members.length) status = { ...status, crew: crew.members.filter((w) => w.sim?.isValid).map((w) => { const l = w.sim.location; return { name: w.sim.name, hp: Math.round(w.health()), mode: w.mode, task: w.task?.kind ?? null, step: w.autoStep ?? null, pos: [Math.round(l.x), Math.round(l.y), Math.round(l.z)] }; }) };
  } catch { /* the status goes out without it */ }
  poll(status).then((cmds) => { for (const c of cmds) handle(String(c), undefined); })
    .catch(() => {}).finally(() => { polling = false; });
}, 20);

console.warn('[agent] Bedrock Agent loaded');
