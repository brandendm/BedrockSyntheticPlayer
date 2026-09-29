// Entry point. Commands (in chat):
//   !bot spawn            spawn the agent next to you
//   !bot despawn          remove it
//   !bot <anything else>  sent to the brain (come, follow me, goto x y z, stop, ...)
// Same commands without chat:  /scriptevent agent:cmd <text>
import { system, world, GameMode } from '@minecraft/server';
import { spawnSimulatedPlayer } from '@minecraft/server-gametest';
import { Agent } from './game/agent.js';
import { runTests } from './game/scenarios.js';
import { poll } from './game/bridge.js';
import { CONFIG } from './config.js';

/** @type {Agent | null} */
let agent = null;

let debugLog = false;

/** player may be undefined when the command comes from the server console. */
function reply(player, msg) {
  if (player) player.sendMessage(msg);
  else console.warn(`[agent] ${msg}`);
}

/** Where to spawn: next to the player, or (from the console) on the surface at world spawn. */
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

async function spawnAgent(player) {
  // A script reload (/reload) loses our handle on an existing bot; kick the orphan so there's only one.
  for (const p of world.getPlayers({ name: CONFIG.botName })) {
    try { p.dimension.runCommand(`kick "${p.name}"`); } catch { try { p.kill(); } catch {} }
  }
  const where = await spawnPoint(player);
  const sim = spawnSimulatedPlayer(where, CONFIG.botName, GameMode.Survival);
  // Simulated players respawn at world spawn, which can be mid-air. Pin a safe one.
  try { sim.setSpawnPoint({ dimension: where.dimension, x: Math.floor(where.x), y: Math.floor(where.y), z: Math.floor(where.z) }); } catch (e) { console.warn(`[agent] setSpawnPoint: ${e}`); }
  agent = new Agent(sim);
  agent.say(`Ready (build ${CONFIG.build}).`);
}

function handle(text, player) {
  const cmd = text.trim();
  const lower = cmd.toLowerCase();
  // "@Name <command>" from the dashboard: as if that player had typed it (come, follow me, spawn).
  if (cmd.startsWith('@') && !player) {
    const [who, ...rest] = cmd.slice(1).split(/\s+/);
    const pl = world.getPlayers({ name: who })[0];
    if (!pl) return console.warn(`[agent] dashboard: ${who} isn't online`);
    return handle(rest.join(' '), pl);
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
  if (lower === 'version') return reply(player, `Bedrock Agent build ${CONFIG.build}`);
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
  if (lower === 'test' || lower.startsWith('test ')) {
    if (!agent?.sim.isValid) return reply(player, 'spawn first');
    runTests(agent, player, lower.split(/\s+/).slice(1)).catch((e) => console.error(`[test] ${e}\n${e.stack}`));
    return;
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
  if (ev.sender.name === CONFIG.botName || ev.sender.id === agent?.sim.id) return;
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
world.afterEvents.entityHurt.subscribe((ev) => {
  if (!agent) return;
  // Following someone: what goes for them, and what they go for, is ours to fight too.
  if (ev.hurtEntity.id !== agent.sim.id) { try { agent.onEscortHurt(ev.hurtEntity, ev.damageSource.damagingEntity); } catch {} return; }
  agent.onHurt(ev.damageSource.damagingEntity, ev.damageSource.cause, ev.damage);
});

// Dead simulated players don't respawn on their own.
world.afterEvents.entityDie.subscribe((ev) => {
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
    } catch (e) {
      console.error(`[agent] respawn failed: ${e}`);
    }
  }, 40);
});

system.runInterval(() => {
  if (!agent) return;
  try {
    agent.tick();
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
  try { status = agent?.sim.isValid ? agent.status() : { online: false, name: CONFIG.botName, players: world.getPlayers().map((pl) => pl.name) }; } catch (e) { status = { online: !!agent, error: `${e}` }; }
  poll(status).then((cmds) => { for (const c of cmds) handle(String(c), undefined); })
    .catch(() => {}).finally(() => { polling = false; });
}, 20);

console.warn('[agent] Bedrock Agent loaded');
