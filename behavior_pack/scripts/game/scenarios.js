// In-game test scenarios you can watch:  !bot test <name> [arg]   or   !bot test all
// Each one builds its setup a few blocks in front of you, runs the bot through it, reports the
// result in chat (and to brain/logs/tests.jsonl), then puts every block back the way it was.
//   roof [h]      a glass sky roof h (8) blocks up: the bot must not think it's underground
//   tower [h]     stranded on a h (10) high cobblestone pillar: get down (hop or dig, by cost)
//   hole [d]      in a 1x1 hole d (2) deep, then walk 12 blocks away
//   pit [d]       in a 3x3 pit d (3) deep, then walk 12 blocks away
//   trap [d]      a 1x1 hole d (2) deep in solid ground with auto mode on: must climb out by itself
//   house         builds the starter house on a cleared patch (gives it the materials), then a
//                 night in it: door shut, in bed, out in the morning
//   sheep         three sheep nearby: hunt them for 3 wool and pick it up
//   pen           two cows in a fenced pen with a gate: go in through the gate, get the beef,
//                 shut the gate behind it
//   smelt         furnace + 2 logs + planks (given): load it, come back for the charcoal
//   climb         a 6-deep stone pit with no pickaxe: walk up the rubble first, then build up
//                 with dirt from the walls instead of punching stone
//   ladder        a ladder up a 4-high cliff: climb it to get to the top
//   ledge         a crafting table 4 blocks back on a 2-high ledge: get within reach of it
//   shelter       nightfall with no house: dig in (or wall in), then come out in the morning
//   resume        starts the house, gets interrupted and "restarts" (state wiped, only the world's
//                 memory left): must finish the same house on the same spot
//   ghostlog      it remembers a tree 4 blocks away that's gone (and a log sealed in a wall):
//                 must drop those memories, chop the real tree 12 blocks off and pick the logs up
//   quarry        gets stone twice (inventory emptied in between): the second time it goes back
//                 to the staircase it dug, not a new hole
//   treetop       on top of its own dirt pillar up in a tree's leaves: get back down
//   corner        a 2-high ledge with 1-high steps cut into it, started off to the side: must go
//                 up a step square-on (not jump into the seam beside it) and get on top
//   leap          a 1-wide, 2-deep trench across a walled corridor: jump it, don't climb through
//   bridge        a 3-wide, 7-deep chasm across a walled corridor (16 dirt given): bridge it
//   husk          a husk walks up: fight it from the edge of reach (reports the closest it got)
//   creeper       calibration, nothing explodes: a creeper's walk speed and the distance it starts
//                 hissing at (the bot stands still; the creeper is removed the moment it hisses),
//                 then a stone sword and a stone spear swung once each at 3, 3.5 and 4 blocks: did
//                 it land, how far did it knock it back. The numbers tools/sim_combat.mjs guesses.
// The bot keeps whatever it's carrying; give it a pickaxe or sword first to test with one.

import { dist3D } from '../core/mathutil.js';
import { sendEvent } from './bridge.js';
import { system, world, ItemStack } from '@minecraft/server';
import { blueprint, furnishings } from '../core/house.js';
import { invCounts as invCountsOf, hold, container as packOf } from './inventory.js';

const NAMES = ['roof', 'tower', 'hole', 'pit', 'trap', 'climb', 'ledge', 'ladder', 'husk', 'creeper', 'sheep', 'pen', 'smelt', 'smeltlogs', 'shelter', 'house', 'resume', 'ghostlog', 'quarry', 'dark', 'replant', 'litter', 'trader', 'iron', 'farm', 'equip', 'water', 'bucketfarm', 'treetop', 'corner', 'leap', 'bridge'];
let running = false;

export async function runTests(agent, player, args) {
  if (running) return agent.say('A test is already running.');
  const [name = 'all', arg] = args;
  const list = name === 'all' ? NAMES : NAMES.includes(name) ? [name] : null;
  if (!list) return agent.say(`Tests: ${NAMES.join(', ')}, all.`);
  running = true;
  const autoWas = agent.autoEnabled;
  agent.autoEnabled = false;
  const results = [];
  try {
    for (const n of list) results.push(await runOne(agent, player, n, arg === undefined ? undefined : Number(arg)));
  } finally {
    agent.autoEnabled = autoWas;
    running = false;
  }
  if (results.length > 1) agent.say(`Tests done: ${results.filter((r) => r.pass).length}/${results.length} passed.`);
}

async function runOne(agent, player, name, arg) {
  const dim = agent.dim, sim = agent.sim, S = agent.skills;
  // Site: 10 blocks in front of whoever asked (or of the bot), on natural ground.
  const from = player ?? sim;
  const v = from.getViewDirection();
  const len = Math.hypot(v.x, v.z) || 1;
  const x = Math.floor(from.location.x + (v.x / len) * 10), z = Math.floor(from.location.z + (v.z / len) * 10);
  const gy = S.groundTop(x, z);
  if (!Number.isFinite(gy)) return report(agent, name, false, 'no ground in front of you (unloaded?)');
  const box = { x1: x - 8, y1: gy - 8, z1: z - 8, x2: x + 14, y2: gy + 18, z2: z + 8 };
  const cmd = (c) => { try { dim.runCommand(c); return true; } catch (e) { console.warn(`[test] ${c}: ${e}`); return false; } };
  if (!cmd(`structure save agent_test_backup ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} false memory true`)) {
    return report(agent, name, false, "couldn't back up the test area, not touching it");
  }
  agent.newTask(null);
  agent.motor.stop();
  const t0 = system.currentTick;
  const hp0 = agent.health();
  const secs = () => ((system.currentTick - t0) / 20).toFixed(0);
  const idle = async (maxS) => { // wait for the task to end (or time out)
    await system.waitTicks(10);
    for (let i = 0; i < maxS * 4 && agent.task; i++) await system.waitTicks(5);
    return !agent.task;
  };
  const tp = (px, py, pz) => sim.teleport({ x: px + 0.5, y: py, z: pz + 0.5 });
  let pass = false, detail = '';
  try {
    agent.say(`Test ${name}: starting.`);
    switch (name) {
      case 'roof': {
        const h = arg ?? 8;
        cmd(`fill ${x - 8} ${gy + h} ${z - 8} ${x + 8} ${gy + h} ${z + 8} glass`);
        tp(x, gy + 1, z);
        await system.waitTicks(20);
        const gen = agent.newTask({ kind: 'test' });
        const under = S.isUnderground(), trapped = await S.isTrapped(gen);
        agent.newTask(null);
        pass = !under && !trapped;
        detail = pass ? 'not fooled by the glass' : `thinks it's ${under ? 'underground' : 'trapped'}`;
        break;
      }
      case 'tower': {
        const h = arg ?? 10;
        cmd(`fill ${x} ${gy + 1} ${z} ${x} ${gy + h} ${z} cobblestone`);
        tp(x, gy + h + 1, z);
        await system.waitTicks(20);
        S.getDownStats = { hops: 0, digs: 0 };
        agent.apply([{ type: 'surface' }]);
        await idle(150);
        const f = S.feet();
        pass = f.y <= gy + 2 && !(await S.isTrapped(agent.newTask(null)));
        detail = `${pass ? 'down' : `still at y${f.y - gy - 1} above ground`} in ${secs()}s, dug ${S.getDownStats.digs}, hopped ${S.getDownStats.hops}, lost ${Math.max(0, hp0 - agent.health())} hp`;
        break;
      }
      case 'hole':
      case 'pit': {
        const d = arg ?? (name === 'hole' ? 2 : 3), r = name === 'hole' ? 0 : 1;
        cmd(`fill ${x - r} ${gy - d + 1} ${z - r} ${x + r} ${gy} ${z + r} air`);
        tp(x, gy - d + 1, z);
        await system.waitTicks(20);
        const goal = agent.resolveY({ x: x + 12, z });
        agent.startGoto(goal, 1);
        await idle(120);
        const dd = dist3D(sim.location, goal);
        pass = dd <= 2.5;
        detail = `${pass ? 'out and there' : `stuck ${dd.toFixed(0)} blocks short`} in ${secs()}s`;
        break;
      }
      case 'trap': {
        const d = arg ?? 2;
        cmd(`fill ${x - 4} ${gy - 4} ${z - 4} ${x + 4} ${gy} ${z + 4} dirt`);
        cmd(`fill ${x - 4} ${gy} ${z - 4} ${x + 4} ${gy} ${z + 4} grass_block`);
        cmd(`fill ${x - 4} ${gy + 1} ${z - 4} ${x + 4} ${gy + 4} ${z + 4} air`);
        cmd(`fill ${x} ${gy - d + 1} ${z} ${x} ${gy} ${z} air`);
        tp(x, gy - d + 1, z);
        await system.waitTicks(20);
        agent.autoEnabled = true; agent.autoDone = false; agent.nextAutoTry = 0;
        let out = false;
        for (let i = 0; i < 90 * 4 && !out; i++) {
          await system.waitTicks(5);
          const f = S.feet();
          out = f.y >= gy + 1 || Math.hypot(f.x - x, f.z - z) >= 2;
        }
        agent.autoEnabled = false;
        pass = out;
        detail = `${out ? 'climbed out' : 'still in the hole'} in ${secs()}s`;
        break;
      }
      case 'house': {
        cmd(`fill ${x - 7} ${gy - 2} ${z - 7} ${x + 7} ${gy} ${z + 7} dirt`);
        cmd(`fill ${x - 7} ${gy} ${z - 7} ${x + 7} ${gy} ${z + 7} grass_block`);
        cmd(`fill ${x - 7} ${gy + 1} ${z - 7} ${x + 7} ${gy + 8} ${z + 7} air`);
        tp(x, gy + 1, z);
        const H = agent.homestead, oldHouse = agent.memory.data.house;
        agent.memory.data.house = null;
        const inv = sim.getComponent('minecraft:inventory').container;
        for (const [id, n] of /** @type {Array<[string, number]>} */ ([['cobblestone', 30], ['oak_planks', 60], ['wooden_door', 1], ['torch', 4], ['bed', 1], ['furnace', 1], ['crafting_table', 1]])) inv.addItem(new ItemStack(`minecraft:${id}`, n));
        await system.waitTicks(20);
        const gen = agent.newTask({ kind: 'test' });
        let built = false;
        try { built = await H.buildHouse(gen); } catch (e) { detail = `build error ${e}`; }
        const h = H.house;
        let placed = 0, total = 0, sleptOk = false, outOk = false;
        if (h) {
          for (const b of blueprint(h, h.dir)) { total++; if (!/^(air|short_grass)$/.test(S.blockAt(b) ?? 'air')) placed++; }
          const fur = furnishings(h, h.dir);
          const doorOk = /door/.test(S.blockAt(fur.door) ?? '');
          const bedOk = /bed/.test(S.blockAt(fur.bed.foot) ?? '');
          const tBuilt = secs();
          world.setTimeOfDay(13000);
          const night = H.nightAtHome(gen).catch(() => false);
          for (let i = 0; i < 40 && !sim.isSleeping; i++) await system.waitTicks(5);
          sleptOk = !!sim.isSleeping;
          const homeOk = H.isHome();
          world.setTimeOfDay(23400);
          await night;
          outOk = await H.leaveHouse(agent.newTask({ kind: 'test' })).catch(() => false);
          detail = `${placed}/${total} blocks in ${tBuilt}s, door ${doorOk ? 'yes' : 'no'}, bed ${bedOk ? 'yes' : 'no'}, table ${h.table ? 'yes' : 'no'}, furnace ${h.furnace ? 'yes' : 'no'}; night: ${homeOk ? 'inside' : 'NOT inside'}, ${sleptOk ? 'slept' : 'no sleep'}, ${outOk ? 'out the door in the morning' : 'stuck inside'}`;
          pass = built && placed >= total - 2 && doorOk && bedOk && homeOk && outOk;
        } else if (!detail) detail = 'no house built (no site?)';
        world.setTimeOfDay(1000);
        agent.memory.data.house = oldHouse ?? null;
        agent.memory.save();
        break;
      }
      case 'sheep': {
        tp(x, gy + 1, z);
        for (let i = 0; i < 3; i++) cmd(`summon sheep ${x + 6} ${gy + 1} ${z + i - 1}`);
        if (!invCountsOf(sim).stone_sword) sim.getComponent('minecraft:inventory').container.addItem(new ItemStack('minecraft:stone_sword', 1));
        agent.equipBestWeapon();
        await system.waitTicks(10);
        const woolN = () => Object.entries(invCountsOf(sim)).filter(([id]) => id.endsWith('_wool')).reduce((a, [, n]) => a + n, 0);
        const w0 = woolN();
        const gen = agent.newTask({ kind: 'test' });
        const kills = await agent.homestead.hunt(gen, new Set(['sheep']), () => woolN() - w0 >= 3, 60).catch((e) => { detail = `${e}`; return 0; });
        pass = woolN() - w0 >= 3;
        detail = `${kills} sheep in ${secs()}s, picked up ${woolN() - w0} wool`;
        for (const e of dim.getEntities({ type: 'minecraft:sheep', location: { x, y: gy, z }, maxDistance: 20 })) try { e.remove(); } catch {}
        break;
      }
      case 'pen': {
        cmd(`fill ${x - 3} ${gy - 1} ${z - 6} ${x + 12} ${gy} ${z + 6} grass_block`);
        cmd(`fill ${x - 3} ${gy + 1} ${z - 6} ${x + 12} ${gy + 4} ${z + 6} air`);
        cmd(`fill ${x + 4} ${gy + 1} ${z - 3} ${x + 10} ${gy + 1} ${z + 3} oak_fence`);
        cmd(`fill ${x + 5} ${gy + 1} ${z - 2} ${x + 9} ${gy + 1} ${z + 2} air`);
        const gate = { x: x + 4, y: gy + 1, z };
        cmd(`setblock ${gate.x} ${gate.y} ${gate.z} fence_gate ["minecraft:cardinal_direction"="east"]`);
        cmd(`summon cow ${x + 7} ${gy + 1} ${z - 1}`); cmd(`summon cow ${x + 8} ${gy + 1} ${z + 1}`);
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        const beef = () => invCountsOf(sim).beef ?? 0;
        const b0 = beef();
        const gen = agent.newTask({ kind: 'test' });
        const kills = await agent.homestead.hunt(gen, new Set(['cow']), () => beef() - b0 >= 2, 60).catch((e) => { detail = `${e}`; return 0; });
        await S.goNear(gen, { x: x + 0.5, y: gy + 1, z: z + 0.5 }, 1, 2).catch(() => false); // walk back out
        await system.waitTicks(20);
        let shut = false;
        try { shut = !dim.getBlock(gate)?.permutation.getState('open_bit'); } catch {}
        pass = beef() - b0 >= 1 && kills >= 1;
        detail = `${kills} cows in ${secs()}s, picked up ${beef() - b0} beef, gate ${shut ? 'shut' : 'left open'} behind it`;
        for (const e of dim.getEntities({ type: 'minecraft:cow', location: { x, y: gy, z }, maxDistance: 20 })) try { e.remove(); } catch {}
        break;
      }
      case 'smelt':
      case 'smeltlogs': {
        tp(x, gy + 1, z);
        const inv = sim.getComponent('minecraft:inventory').container;
        // smeltlogs: 3 birch logs and nothing else to burn: one gets made into planks for fuel.
        const kit = name === 'smelt' ? [['furnace', 1], ['oak_log', 2], ['oak_planks', 4]] : [['furnace', 1], ['birch_log', 3]];
        for (const [id, n] of /** @type {Array<[string, number]>} */ (kit)) inv.addItem(new ItemStack(`minecraft:${id}`, n));
        const c0 = invCountsOf(sim).charcoal ?? 0;
        const H = agent.homestead;
        const gen = agent.newTask({ kind: 'test' });
        const started = await H.startSmelt(gen, 'log', 2, 2).catch(() => false);
        if (started) { while (system.currentTick < H.smeltJob.readyAt) await system.waitTicks(20); await H.collectSmelt(gen); }
        const got = (invCountsOf(sim).charcoal ?? 0) - c0;
        pass = started && got >= 2;
        detail = `${started ? 'loaded the furnace' : "couldn't load a furnace"}, got ${got} charcoal in ${secs()}s`;
        const fp = H.smeltJob?.pos ?? agent.memory.list('furnace', dim.id, sim.location)[0]?.pos;
        if (fp) agent.memory.forgetNear('furnace', dim.id, fp, 0.5);
        H.smeltJob = null;
        break;
      }
      case 'climb': {
        cmd(`fill ${x - 5} ${gy - 8} ${z - 5} ${x + 5} ${gy} ${z + 5} stone`);
        cmd(`fill ${x - 5} ${gy + 1} ${z - 5} ${x + 5} ${gy + 6} ${z + 5} air`);
        cmd(`fill ${x - 2} ${gy - 6} ${z - 2} ${x + 2} ${gy} ${z + 2} air`);       // the pit: floor at gy-7
        cmd(`setblock ${x + 1} ${gy - 6} ${z} stone`);                                // rubble: a step up...
        cmd(`fill ${x + 2} ${gy - 6} ${z} ${x + 2} ${gy - 5} ${z} stone`);            // ...and another
        cmd(`fill ${x + 3} ${gy - 3} ${z - 2} ${x + 3} ${gy - 1} ${z + 2} dirt`);     // dirt in the wall up top
        tp(x - 1, gy - 6, z);
        // No pickaxe for this one (it's the case where punching stone is the slow way).
        const inv = sim.getComponent('minecraft:inventory').container;
        const stash = [];
        for (let i = 0; i < inv.size; i++) { const it = inv.getItem(i); if (it && /pickaxe/.test(it.typeId)) { stash.push([i, it]); inv.setItem(i, undefined); } }
        await system.waitTicks(20);
        const gen = agent.newTask({ kind: 'test' });
        agent.apply([{ type: 'surface' }]);
        await idle(150);
        const f = S.feet();
        pass = f.y >= gy + 1;
        detail = `${pass ? 'out' : `still ${gy + 1 - f.y} below the top`} in ${secs()}s (${agent.skills.lastUpCost ?? ''})`;
        for (const [i, it] of stash) inv.setItem(i, it);
        void gen;
        break;
      }
      case 'ladder': {
        cmd(`fill ${x - 3} ${gy - 1} ${z - 4} ${x + 10} ${gy} ${z + 4} stone`);
        cmd(`fill ${x - 3} ${gy + 1} ${z - 4} ${x + 10} ${gy + 9} ${z + 4} air`);
        cmd(`fill ${x + 3} ${gy + 1} ${z - 4} ${x + 10} ${gy + 4} ${z + 4} stone`);   // a 4-high cliff
        for (let h = 1; h <= 4; h++) cmd(`setblock ${x + 2} ${gy + h} ${z} ladder ["facing_direction"=4]`);
        tp(x - 2, gy + 1, z);
        await system.waitTicks(10);
        const goal = { x: x + 6, y: gy + 5, z };
        agent.startGoto(goal, 1);
        await idle(60);
        const dd = dist3D(sim.location, goal);
        pass = dd <= 2;
        detail = `${pass ? 'up the ladder and there' : `stuck ${dd.toFixed(1)} blocks short at y+${(S.feet().y - gy - 1)}`} in ${secs()}s`;
        break;
      }
      case 'corner': {
        cmd(`fill ${x - 6} ${gy - 2} ${z - 7} ${x + 12} ${gy} ${z + 7} stone`);
        cmd(`fill ${x - 6} ${gy + 1} ${z - 7} ${x + 12} ${gy + 6} ${z + 7} air`);
        cmd(`fill ${x + 3} ${gy + 1} ${z - 7} ${x + 12} ${gy + 2} ${z + 7} stone`); // 2-high ledge
        cmd(`setblock ${x + 3} ${gy + 2} ${z - 2} air`);                            // 1-high steps in its edge
        cmd(`setblock ${x + 3} ${gy + 2} ${z + 3} air`);
        tp(x - 3, gy + 1, z + 5);
        await system.waitTicks(10);
        const goal = { x: x + 8, y: gy + 3, z };
        agent.startGoto(goal, 1);
        await idle(40);
        const dd = dist3D(sim.location, goal);
        pass = dd <= 2;
        detail = `${pass ? 'up the step and there' : `stuck ${dd.toFixed(1)} blocks short at ${S.feet().x - x} ${S.feet().y - gy - 1} ${S.feet().z - z}`} in ${secs()}s`;
        break;
      }
      case 'leap':
      case 'bridge': {
        const wide = name === 'bridge' ? 3 : 1, deep = name === 'bridge' ? 7 : 2;
        cmd(`fill ${x - 6} ${gy - 8} ${z - 5} ${x + 12} ${gy} ${z + 5} stone`);
        cmd(`fill ${x - 6} ${gy + 1} ${z - 5} ${x + 12} ${gy + 6} ${z + 5} air`);
        cmd(`fill ${x - 6} ${gy + 1} ${z - 5} ${x + 12} ${gy + 4} ${z - 5} stone`); // corridor walls
        cmd(`fill ${x - 6} ${gy + 1} ${z + 5} ${x + 12} ${gy + 4} ${z + 5} stone`);
        cmd(`fill ${x - 6} ${gy + 1} ${z - 5} ${x - 6} ${gy + 4} ${z + 5} stone`);   // closed at both ends:
        cmd(`fill ${x + 12} ${gy + 1} ${z - 5} ${x + 12} ${gy + 4} ${z + 5} stone`); // no way round
        cmd(`fill ${x + 3} ${gy - deep + 1} ${z - 4} ${x + 2 + wide} ${gy} ${z + 4} air`);
        if (name === 'bridge') sim.getComponent('minecraft:inventory').container.addItem(new ItemStack('minecraft:dirt', 16));
        tp(x - 2, gy + 1, z);
        await system.waitTicks(10);
        const goal = { x: x + 9, y: gy + 1, z };
        let lowest = S.feet().y;
        const watch = system.runInterval(() => { try { lowest = Math.min(lowest, S.feet().y); } catch {} }, 2);
        const gen = agent.newTask({ kind: 'test' });
        const ok = await S.goNear(gen, goal, 1, 3).catch(() => false);
        system.clearRun(watch);
        const f = S.feet();
        const across = f.x >= x + 3 + wide && f.y >= gy + 1;
        const dry = lowest >= gy + 1;
        pass = ok && across && dry;
        detail = `${across ? 'across' : 'not across'}${dry ? '' : `, fell to ${lowest - gy - 1}`} in ${secs()}s`;
        agent.newTask(null);
        break;
      }
      case 'ledge': {
        cmd(`fill ${x - 6} ${gy - 2} ${z - 8} ${x + 12} ${gy} ${z + 8} dirt`);
        cmd(`fill ${x - 6} ${gy + 1} ${z - 8} ${x + 12} ${gy + 6} ${z + 8} air`);
        cmd(`fill ${x + 2} ${gy + 1} ${z - 8} ${x + 12} ${gy + 2} ${z + 8} stone`); // a 2-high cliff all along
        const table = { x: x + 6, y: gy + 3, z };
        cmd(`setblock ${table.x} ${table.y} ${table.z} crafting_table`);
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        const gen = agent.newTask({ kind: 'test' });
        const ok = await S.reach(gen, table).catch(() => false);
        pass = ok && S.inReach(table);
        detail = `${pass ? 'in reach of the table' : "couldn't reach it"} in ${secs()}s, standing ${S.feet().y - gy - 1} up`;
        break;
      }
      case 'shelter': {
        cmd(`fill ${x - 4} ${gy - 5} ${z - 4} ${x + 4} ${gy} ${z + 4} dirt`);
        cmd(`fill ${x - 4} ${gy} ${z - 4} ${x + 4} ${gy} ${z + 4} grass_block`);
        cmd(`fill ${x - 4} ${gy + 1} ${z - 4} ${x + 4} ${gy + 5} ${z + 4} air`);
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        const oldHouse = agent.memory.data.house;
        agent.memory.data.house = null;
        world.setTimeOfDay(13000);
        const gen = agent.newTask({ kind: 'test' });
        const done = agent.homestead.shelter(gen).catch((e) => { detail = `${e}`; });
        await system.waitTicks(20 * 15);
        const g = new Set([S.feet().y]);
        const enclosed = await S.isTrapped(gen).catch(() => false) || S.coverAbove() > 0;
        const tIn = secs();
        world.setTimeOfDay(23400);
        for (let i = 0; i < 90 * 4 && agent.task; i++) { await system.waitTicks(5); if (!agent.homestead) break; if (await Promise.race([done.then(() => true), system.waitTicks(1).then(() => false)])) break; }
        const out = S.feet().y >= gy + 1 && !(await S.isTrapped(agent.newTask({ kind: 'test' })).catch(() => true));
        pass = enclosed && out;
        detail = `${enclosed ? `holed up at y${[...g][0] - gy - 1} in ${tIn}s` : 'not enclosed'}, ${out ? 'out again in the morning' : 'still stuck in the morning'} (${secs()}s total)`;
        agent.memory.data.house = oldHouse ?? null;
        world.setTimeOfDay(1000);
        break;
      }
      case 'resume': {
        cmd(`fill ${x - 7} ${gy - 2} ${z - 7} ${x + 7} ${gy} ${z + 7} dirt`);
        cmd(`fill ${x - 7} ${gy} ${z - 7} ${x + 7} ${gy} ${z + 7} grass_block`);
        cmd(`fill ${x - 7} ${gy + 1} ${z - 7} ${x + 7} ${gy + 8} ${z + 7} air`);
        tp(x, gy + 1, z);
        const H = agent.homestead, oldHouse = agent.memory.data.house, oldProject = agent.memory.data.houseProject;
        agent.memory.data.house = null; agent.memory.data.houseProject = null;
        const inv = sim.getComponent('minecraft:inventory').container;
        for (const [id, n] of /** @type {Array<[string, number]>} */ ([['cobblestone', 30], ['oak_planks', 60], ['wooden_door', 1], ['torch', 4]])) inv.addItem(new ItemStack(`minecraft:${id}`, n));
        await system.waitTicks(20);
        // 1. Start building, get interrupted 12 s in.
        const gen1 = agent.newTask({ kind: 'test' });
        H.buildHouse(gen1).catch(() => {});
        await system.waitTicks(20 * 12);
        agent.newTask(null);
        await system.waitTicks(10);
        const p1 = H.project, prog1 = H.projectProgress();
        // 2. "Restart": nothing in the bot's head, only what's saved in the world.
        H.shortfall = null; H.smeltJob = null;
        const saved = JSON.parse(String(world.getDynamicProperty('agent:memory')));
        agent.memory.data = saved;
        const p2 = H.project;
        // 3. Carry on.
        const gen2 = agent.newTask({ kind: 'test' });
        // Watch the walls while it carries on: they must never go down (no tear-down-and-rebuild).
        let lowest = prog1?.placed ?? 0, watching = true;
        (async () => { while (watching) { const pr = H.projectProgress(); if (pr) lowest = Math.min(lowest, pr.placed); await system.waitTicks(5); } })();
        const built = await H.buildHouse(gen2).catch(() => false);
        watching = false;
        const toreDown = prog1 && lowest < prog1.placed;
        const h = H.house;
        let placed = 0, total = 0;
        if (h) for (const b of blueprint(h, h.dir)) { total++; if (!/^(air|short_grass)$/.test(S.blockAt(b) ?? 'air')) placed++; }
        const same = !!(p1 && p2 && h && p1.x === h.x && p1.z === h.z && p2.x === p1.x);
        pass = built && same && placed >= total - 2 && !toreDown;
        detail = `${toreDown ? `TORE DOWN walls (down to ${lowest}), ` : ''}interrupted at ${prog1 ? `${prog1.placed}/${prog1.total}` : 'no project saved'}, after restart ${p2 ? 'remembered the site' : 'FORGOT the site'}, finished ${placed}/${total} ${same ? 'on the same spot' : 'somewhere else'} (${secs()}s)`;
        agent.memory.data.house = oldHouse ?? null; agent.memory.data.houseProject = oldProject ?? null; agent.memory.save();
        break;
      }
      case 'ghostlog': {
        cmd(`fill ${x - 6} ${gy - 2} ${z - 6} ${x + 14} ${gy} ${z + 6} grass_block`);
        cmd(`fill ${x - 6} ${gy + 1} ${z - 6} ${x + 14} ${gy + 9} ${z + 6} air`);
        cmd(`fill ${x - 2} ${gy + 1} ${z + 3} ${x + 2} ${gy + 3} ${z + 5} stone`);           // a wall...
        cmd(`setblock ${x} ${gy + 2} ${z + 4} oak_log`);                                         // ...with a log sealed inside
        cmd(`fill ${x + 12} ${gy + 1} ${z} ${x + 12} ${gy + 4} ${z} oak_log`);                   // the real tree
        cmd(`fill ${x + 11} ${gy + 5} ${z - 1} ${x + 13} ${gy + 6} ${z + 1} oak_leaves`);
        tp(x, gy + 1, z);
        const mem = agent.memory, dimId = dim.id;
        mem.remember('log', dimId, { x: x + 4, y: gy + 1, z }, 4);      // a tree that isn't there any more
        mem.remember('log', dimId, { x, y: gy + 2, z: z + 4 }, 1);       // the one in the wall
        await system.waitTicks(10);
        const logs = () => Object.entries(invCountsOf(sim)).filter(([id]) => /_log$/.test(id)).reduce((a, [, n]) => a + n, 0);
        const l0 = logs();
        const gen = agent.newTask({ kind: 'test' });
        let err = '';
        await Promise.race([S.gatherLogs(gen, l0 + 3).catch((e) => { err = `${e}`; }), system.waitTicks(20 * 90)]);
        agent.newTask(null);
        const got = logs() - l0;
        const ghost = mem.list('log', dimId, { x: x + 4, y: gy + 1, z }).some((e) => Math.abs(e.pos.x - (x + 4)) < 2 && Math.abs(e.pos.z - z) < 2);
        pass = got >= 3; // (the ghost only gets forgotten if it was the cheapest option and got visited)
        detail = `picked up ${got} logs in ${secs()}s, ghost tree ${ghost ? 'STILL remembered' : 'forgotten'}${err ? ` (${err})` : ''}`;
        mem.forgetNear('log', dimId, { x, y: gy, z }, 16);
        break;
      }
      case 'quarry': {
        cmd(`fill ${x - 8} ${gy - 9} ${z - 8} ${x + 8} ${gy - 3} ${z + 8} stone`);
        cmd(`fill ${x - 8} ${gy - 2} ${z - 8} ${x + 8} ${gy - 1} ${z + 8} dirt`);
        cmd(`fill ${x - 8} ${gy} ${z - 8} ${x + 8} ${gy} ${z + 8} grass_block`);
        cmd(`fill ${x - 8} ${gy + 1} ${z - 8} ${x + 8} ${gy + 5} ${z + 8} air`);
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        const inv = sim.getComponent('minecraft:inventory').container;
        const stoneN = () => invCountsOf(sim).cobblestone ?? 0;
        const drop = () => { for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === 'minecraft:cobblestone') inv.setItem(i, undefined); };
        drop();
        const gen = agent.newTask({ kind: 'test' });
        await S.getStone(gen, 6).catch(() => {});
        const t1 = secs(), q1 = S.feet(), n1 = stoneN();
        drop();
        await S.goNear(gen, { x: x + 0.5, y: gy + 1, z: z + 0.5 }, 1.5, 2).catch(() => {}); // back up top
        const tA = system.currentTick;
        await S.getStone(gen, 6).catch(() => {});
        const t2 = ((system.currentTick - tA) / 20).toFixed(0), q2 = S.feet(), n2 = stoneN();
        const same = Math.hypot(q1.x - q2.x, q1.z - q2.z) <= 6;
        pass = n1 >= 6 && n2 >= 6 && same;
        detail = `1st: ${n1} cobblestone in ${t1}s; 2nd: ${n2} in ${t2}s ${same ? 'from the same quarry' : `from a new spot ${Math.round(Math.hypot(q1.x - q2.x, q1.z - q2.z))} blocks away`}`;
        break;
      }
      case 'bucketfarm': {
        // The real thing, at the real house: fill the bucket wherever the water is, farm by the house.
        const inv = sim.getComponent('minecraft:inventory').container;
        if (!invCountsOf(sim).bucket && !invCountsOf(sim).water_bucket) inv.addItem(new ItemStack('minecraft:bucket', 1));
        if (!invCountsOf(sim).stone_hoe) inv.addItem(new ItemStack('minecraft:stone_hoe', 1));
        const gen = agent.newTask({ kind: 'test' });
        agent.memory.data.farm = null;
        const ok = await agent.farm.make(gen, 'bucket', 24).catch((e) => { detail = `${e}`; return false; });
        const st = agent.farm.state();
        pass = !!ok && (st?.planted ?? 0) >= 4;
        detail = `${ok ? 'made' : 'not made'}: ${st?.tiles ?? 0} tiles, ${st?.planted ?? 0} planted, ${secs()}s`;
        break;
      }
      case 'water': {
        const p0 = { ...S.feet() };
        const raw = await S.scan((id) => id === 'water', { radius: 80, below: 4, above: 3, limit: 48 });
        const kept = await agent.farm.waterNear(sim.location, 80);
        let probe = 'n/a';
        try { const b = dim.getBlock({ x: -55, y: 62, z: 21 }); probe = b ? `${b.typeId} depth ${b.permutation.getState('liquid_depth')}` : 'unloaded'; } catch (e) { probe = `${e}`; }
        pass = kept.length > 0;
        detail = `at ${p0.x} ${p0.y} ${p0.z}: raw ${raw.length}, kept ${kept.length}${kept[0] ? ` nearest ${kept[0].x} ${kept[0].y} ${kept[0].z}` : ''}; the pool block: ${probe}; fast scan off: ${S.constructor.noFastScan}`;
        break;
      }
      case 'equip': {
        const inv = sim.getComponent('minecraft:inventory').container;
        for (const id of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield']) inv.addItem(new ItemStack(`minecraft:${id}`, 1));
        const n = agent.equipArmor();
        const worn = agent.worn();
        pass = worn.length >= 5 && !['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield'].some((id) => invCountsOf(sim)[id]);
        detail = `equipped ${n}; wearing ${worn.join(', ')}`;
        break;
      }
      case 'farm': {
        // A stand-in house on flat grass. arg 0: a pond 10 blocks off (farm by it); arg 1: no water
        // near the house, a pool 30 off and a bucket (fill it, farm by the house).
        const bucket = arg === 1;
        cmd(`fill ${x - 20} ${gy - 2} ${z - 20} ${x + 34} ${gy} ${z + 20} grass_block`);
        cmd(`fill ${x - 20} ${gy + 1} ${z - 20} ${x + 34} ${gy + 6} ${z + 20} air`);
        cmd(`fill ${x - 12} ${gy + 1} ${z - 12} ${x + 12} ${gy + 1} ${z + 12} short_grass replace air`);
        const pond = bucket ? { x: x + 30, z } : { x: x + 10, z };
        cmd(`fill ${pond.x - 1} ${gy} ${pond.z - 1} ${pond.x + 1} ${gy} ${pond.z + 1} water`);
        cmd(`fill ${pond.x - 1} ${gy + 1} ${pond.z - 1} ${pond.x + 1} ${gy + 1} ${pond.z + 1} air`);
        tp(x, gy + 1, z);
        await system.waitTicks(20);
        const H = agent.homestead, mem = agent.memory.data;
        const saved = { house: mem.house, farm: mem.farm, water: mem.waterNearHouse, fw: mem.farmWater };
        H.setHouse({ x, y: gy + 1, z, dir: 'south', bed: true, table: true, furnace: true, level: 1 });
        mem.farm = null; mem.waterNearHouse = undefined;
        const inv = sim.getComponent('minecraft:inventory').container;
        if (!invCountsOf(sim).stone_hoe) inv.addItem(new ItemStack('minecraft:stone_hoe', 1));
        if (bucket && !invCountsOf(sim).bucket) inv.addItem(new ItemStack('minecraft:bucket', 1));
        const gen = agent.newTask({ kind: 'test' });
        try {
          const near = await agent.farm.checkWater(gen);
          const ok = await agent.farm.make(gen, near ? 'near' : 'bucket', 24);
          const st = agent.farm.state();
          pass = ok && near === !bucket && !!st && st.planted >= 4;
          detail = `water near: ${near}, farm ${ok ? 'made' : 'not made'}, ${st?.tiles ?? 0} tiles, ${st?.planted ?? 0} planted, ${invCountsOf(sim).wheat_seeds ?? 0} seeds left, ${secs()}s`;
        } catch (e) { detail = `${e}`; }
        mem.house = saved.house; mem.farm = saved.farm; mem.waterNearHouse = saved.water; mem.farmWater = saved.fw;
        agent.memory.save();
        break;
      }
      case 'trader': {
        cmd(`fill ${x - 8} ${gy - 1} ${z - 8} ${x + 14} ${gy} ${z + 8} grass_block`);
        cmd(`fill ${x - 8} ${gy + 1} ${z - 8} ${x + 14} ${gy + 6} ${z + 8} air`);
        tp(x, gy + 1, z);
        cmd(`summon wandering_trader ${x + 5} ${gy + 1} ${z}`);
        await system.waitTicks(20);
        const l0 = invCountsOf(sim).lead ?? 0;
        const inv = sim.getComponent('minecraft:inventory').container;
        if (!invCountsOf(sim).stone_sword) inv.addItem(new ItemStack('minecraft:stone_sword', 1));
        agent.equipBestWeapon();
        const gen = agent.newTask({ kind: 'test' });
        await agent.homestead.hunt(gen, new Set(['wandering_trader']), () => (invCountsOf(sim).lead ?? 0) > l0, 60).catch((e) => { detail = `${e}`; });
        const got = (invCountsOf(sim).lead ?? 0) - l0;
        pass = got >= 1;
        detail = `${got} leads in ${secs()}s`;
        for (const e of dim.getEntities({ type: 'minecraft:trader_llama', location: { x, y: gy, z }, maxDistance: 30 })) try { e.remove(); } catch {}
        break;
      }
      case 'iron': {
        const inv = sim.getComponent('minecraft:inventory').container;
        for (let i = invCountsOf(sim).stone_pickaxe ?? 0; i < 3; i++) inv.addItem(new ItemStack('minecraft:stone_pickaxe', 1));
        if ((invCountsOf(sim).torch ?? 0) < 8) inv.addItem(new ItemStack('minecraft:torch', 16));
        const r0 = S.rawIron();
        const gen = agent.newTask({ kind: 'test' });
        await S.getIron(gen, arg ?? 3, 400).catch((e) => { detail = `${e}`; });
        const got = S.rawIron() - r0;
        pass = got >= (arg ?? 3);
        detail = `${got} raw iron in ${secs()}s, now at Y ${S.feet().y}`;
        break;
      }
      case 'litter':
      case 'replant': {
        cmd(`fill ${x - 6} ${gy - 1} ${z - 6} ${x + 10} ${gy} ${z + 6} grass_block`);
        cmd(`fill ${x - 6} ${gy + 1} ${z - 6} ${x + 10} ${gy + 10} ${z + 6} air`);
        const tx = x + 5;
        cmd(`fill ${tx - 2} ${gy + 4} ${z - 2} ${tx + 2} ${gy + 5} ${z + 2} oak_leaves`);
        cmd(`fill ${tx} ${gy + 1} ${z} ${tx} ${gy + 5} ${z} oak_log`);
        if (name === 'litter') cmd(`fill ${tx - 3} ${gy + 1} ${z - 3} ${tx + 3} ${gy + 1} ${z + 3} leaf_litter ["growth"=3] replace air`);
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        const inv = sim.getComponent('minecraft:inventory').container;
        inv.addItem(new ItemStack('minecraft:oak_sapling', 2));
        const logs0 = Object.entries(invCountsOf(sim)).filter(([id]) => /_log$/.test(id)).reduce((a, [, n]) => a + n, 0);
        const gen = agent.newTask({ kind: 'test' });
        agent.memory.forgetNear('log', dim.id, { x: tx, y: gy + 1, z }, 64);
        await S.gatherLogs(gen, logs0 + 5).catch((e) => { detail = `${e}`; });
        const at = S.blockAt({ x: tx, y: gy + 1, z });
        const litter = invCountsOf(sim).leaf_litter ?? 0;
        pass = name === 'litter' ? litter >= 4 : /sapling/.test(at ?? '');
        detail = name === 'litter' ? `picked up ${litter} leaf litter, took ${secs()}s` : `stump spot now ${at}`;
        break;
      }
      case 'dark': {
        // Sealed in solid stone 20 below the surface: tunnel along and check it lights the way.
        const by = gy - 20;
        cmd(`fill ${x - 3} ${by - 2} ${z - 3} ${x + 30} ${by + 4} ${z + 3} stone`);
        cmd(`fill ${x} ${by} ${z} ${x} ${by + 1} ${z} air`);
        tp(x, by, z);
        await system.waitTicks(10);
        const inv = sim.getComponent('minecraft:inventory').container;
        if (!invCountsOf(sim).torch) inv.addItem(new ItemStack('minecraft:torch', 8));
        if (!Object.keys(invCountsOf(sim)).some((id) => /_pickaxe$/.test(id))) inv.addItem(new ItemStack('minecraft:stone_pickaxe', 1));
        const t0 = invCountsOf(sim).torch ?? 0;
        const gen = agent.newTask({ kind: 'test' });
        const start = { ...S.feet() };
        let mined = 0;
        const res = await S.tunnel(gen, () => (mined = Math.abs(S.feet().x - start.x) + Math.abs(S.feet().z - start.z)) < 24, 0).catch((e) => { detail = `${e}`; return null; });
        const used = t0 - (invCountsOf(sim).torch ?? 0);
        // Darkest spot along the way we came.
        let darkest = 15;
        for (let dx = -3; dx <= 30; dx++) for (let dz = -3; dz <= 3; dz++) {
          try { const b = dim.getBlock({ x: x + dx, y: by, z: z + dz }); if (b && b.isAir) darkest = Math.min(darkest, b.getLightLevel()); } catch {}
        }
        pass = !!res && used >= 2 && darkest >= 1; // the tunnel may double back in the box: what counts is no dark spot
        detail = `tunnelled ${mined}, ${used} torches, darkest spot on the way light ${darkest}`;
        break;
      }
      case 'treetop': {
        cmd(`fill ${x - 5} ${gy - 1} ${z - 5} ${x + 5} ${gy} ${z + 5} grass_block`);
        cmd(`fill ${x - 5} ${gy + 1} ${z - 5} ${x + 5} ${gy + 9} ${z + 5} air`);
        cmd(`fill ${x - 2} ${gy + 4} ${z - 2} ${x + 2} ${gy + 7} ${z + 2} oak_leaves`);   // canopy
        cmd(`fill ${x} ${gy + 1} ${z} ${x} ${gy + 6} ${z} oak_log`);                         // trunk
        cmd(`fill ${x + 1} ${gy + 1} ${z} ${x + 1} ${gy + 4} ${z} dirt`);                    // our pillar
        cmd(`fill ${x + 1} ${gy + 5} ${z} ${x + 1} ${gy + 6} ${z} air`);
        for (let h = 1; h <= 4; h++) S.markPlaced({ x: x + 1, y: gy + h, z });
        tp(x + 1, gy + 5, z);
        await system.waitTicks(20);
        agent.apply([{ type: 'surface' }]);
        await idle(60);
        const f = S.feet();
        pass = f.y <= gy + 2;
        detail = `${pass ? 'down' : `still ${f.y - gy - 1} up`} in ${secs()}s`;
        break;
      }
      case 'creeper': {
        // On Peaceful a summoned creeper is gone the same tick: nothing to measure.
        let diff = '';
        try { diff = String(world.getDifficulty()); } catch {}
        if (diff === 'Peaceful') { detail = 'the world is on Peaceful: creepers vanish as soon as they are summoned (set it to Easy or harder for this test)'; break; }
        // A sealed lane along +x: stone floor level with the highest surface round here (water and
        // leaves count: started in a lake, the lane was built on the lake bed and the water came
        // back in), glass walls and roof, the inside cleared. The test area is put back afterwards.
        let fy = gy;
        for (let lx = x - 3; lx <= x + 14; lx++) for (let lz = z - 4; lz <= z + 4; lz++) {
          try { const top = dim.getTopmostBlock({ x: lx, z: lz }); if (top) fy = Math.max(fy, top.location.y); } catch {}
        }
        fy = Math.min(fy, gy + 10); // inside the backed-up box
        cmd(`fill ${x - 3} ${fy} ${z - 4} ${x + 14} ${fy + 5} ${z + 4} glass`);
        cmd(`fill ${x - 2} ${fy + 1} ${z - 3} ${x + 13} ${fy + 4} ${z + 3} air`);
        cmd(`fill ${x - 2} ${fy} ${z - 3} ${x + 13} ${fy} ${z + 3} stone`);
        agent.testHold = true;
        agent.endCombat();
        try { tp(x, fy + 1, z); } catch {}
        await system.waitTicks(10);
        // The weapons to try: given for the test, taken back after.
        const given = [];
        for (const id of ['stone_sword', 'stone_spear']) {
          try { packOf(sim)?.addItem(new ItemStack(`minecraft:${id}`, 1)); given.push(id); } catch (e) { detail += `no ${id} in this version (${e}); `; }
        }
        const hpOf = (e) => { try { return e.getComponent('minecraft:health')?.currentValue ?? null; } catch { return null; } };
        // Swelling: there's no fuse state a script can read (is_ignited is "on fire"), but a creeper
        // stops walking while it swells. One tracker per creeper, fed every tick.
        let still = 0;
        const lit = (e) => {
          try {
            const v = e.getVelocity(), d = dist3D(sim.location, e.location);
            still = Math.hypot(v.x, v.z) < 0.02 && d <= 3.5 ? still + 1 : 0;
            return still >= 2 || d <= 2.2; // (2.2: close enough to call it, whatever it looks like)
          } catch { return false; }
        };
        // A creeper can go at any moment (despawned, killed, removed): every read of it is guarded.
        const ok = (e) => { try { return !!e?.isValid; } catch { return false; } };
        const dd = (e) => { try { return ok(e) ? dist3D(sim.location, e.location) : NaN; } catch { return NaN; } };
        let vanished = 0, stale = 0;
        // A handle to a creeper can go stale while the creeper's still there (the game reloads it):
        // find it again, the nearest creeper in the lane.
        const fresh = (c) => {
          if (ok(c)) return c;
          try {
            const e = dim.getEntities({ type: 'minecraft:creeper', location: { x: x + 6, y: fy + 1, z: z + 0.5 }, maxDistance: 12 })[0];
            if (e) { stale++; return e; }
          } catch {}
          return null;
        };
        const summon = async (dx) => {
          cmd(`summon creeper ${x + dx} ${fy + 1} ${z}`);
          await system.waitTicks(2);
          return dim.getEntities({ type: 'minecraft:creeper', location: { x: x + dx + 0.5, y: fy + 1, z: z + 0.5 }, maxDistance: 3 })[0] ?? null;
        };
        // Removed however stale our handle is: the lane is cleared of creepers.
        const gone = () => { try { for (const e of dim.getEntities({ type: 'minecraft:creeper', location: { x: x + 6, y: fy + 1, z: z + 0.5 }, maxDistance: 14 })) e.remove(); } catch {} };
        // Eyes on it (the motor's focus, which it holds every tick, and the body).
        const face = (c) => { try { const l = c.location; agent.motor.setFocus({ x: l.x, y: l.y + 1, z: l.z }); sim.lookAtEntity(c); } catch {} };
        const log = [];
        // 1. Walk speed, and where it starts hissing. The bot stands still, looking at it.
        const speeds = [], litAt = [];
        let sawIgnite = false;
        for (let trial = 0; trial < 2; trial++) {
          try { tp(x, fy + 1, z); } catch {}
          let c = await summon(10);
          still = 0;
          if (!c) { log.push("couldn't summon a creeper"); break; }
          let prev = dd(c);
          for (let i = 0; i < 400 && c; i++) {
            face(c);
            await system.waitTicks(1);
            c = fresh(c);
            const d = dd(c);
            if (!c || Number.isNaN(d)) { vanished++; break; }
            if (d > 3.2 && d < 8.5) speeds.push(prev - d);
            prev = d;
            if (lit(c)) { sawIgnite = true; litAt.push(d); break; }
          }
          gone();
          await system.waitTicks(20);
        }
        const avg = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN);
        if (stale) log.push(`(creeper handle went stale ${stale} time${stale > 1 ? 's' : ''}: found it again)`);
        if (vanished) log.push(`lost the creeper ${vanished} time${vanished > 1 ? 's' : ''}`);
        log.push(`walks ${avg(speeds).toFixed(3)} blocks/tick`);
        log.push(sawIgnite ? `stopped to swell at ${litAt.map((v) => v.toFixed(2)).join(', ')}` : 'never seen to stop and swell');
        // 2. One swing each, sword and spear, at 2.8 to 4.4 blocks (feet to feet): landed? knockback?
        const hits = {}; // weapon -> [{ at, landed, kb }]
        for (const w of given) {
          for (const at of [2.8, 3.2, 3.6, 4.0, 4.4]) {
            if (!sim.isValid || agent.health() <= 0) { log.push('the bot is down: stopping'); break; }
            try { tp(x, fy + 1, z); } catch {}
            try { hold(sim, w); } catch {}
            let c = await summon(9);
            still = 0;
            if (!c) break;
            let d = dd(c), early = false;
            for (let i = 0; i < 300 && c && d > at; i++) {
              face(c);
              await system.waitTicks(1);
              c = fresh(c);
              d = dd(c);
              if (c && lit(c)) { early = true; break; }
            }
            if (!c || Number.isNaN(d)) { vanished++; log.push(`${w} ${at}: lost the creeper`); gone(); continue; }
            if (early) { log.push(`${w} ${at}: it hissed first`); gone(); continue; }
            face(c);
            const hp0 = hpOf(c), d0 = dd(c);
            try { sim.attackEntity(c); } catch (e) { log.push(`${w}: attack threw ${e}`); }
            await system.waitTicks(2);
            c = fresh(c);
            const hp1 = c ? hpOf(c) : null;
            let far = d0;
            for (let k = 0; k < 16 && c; k++) { await system.waitTicks(1); c = fresh(c); const dk = dd(c); if (!Number.isNaN(dk)) far = Math.max(far, dk); if (c && lit(c)) break; }
            const landed = hp0 !== null && hp1 !== null && hp1 < hp0;
            (hits[w] ??= []).push({ at: d0, landed, kb: far - d0 });
            log.push(`${w} at ${d0.toFixed(2)}: ${landed ? `hit (${hp0}->${hp1}), knocked back ${(far - d0).toFixed(2)}` : 'MISSED'}`);
            gone();
            await system.waitTicks(w.endsWith('spear') ? 25 : 12); // the spear's own cooldown
          }
        }
        for (const id of given) { const slot = packOf(sim); for (let i = 0; slot && i < slot.size; i++) { const it = slot.getItem(i); if (it?.typeId === `minecraft:${id}`) { slot.setItem(i, undefined); break; } } }
        agent.testHold = false;
        agent.motor.setFocus(null);
        pass = speeds.length > 5;
        // For tools/calibration.json (tools/sim_combat.mjs reads it): the arena on this game's numbers.
        const kind = (w) => (w.endsWith('spear') ? 'spear' : 'sword');
        const cal = { creeperSpeed: +avg(speeds).toFixed(3), knockback: {}, reachFeet: {} };
        const lits = litAt.filter((v) => v > 0);
        if (lits.length) cal.fuseStart = +Math.max(...lits).toFixed(2);
        for (const [w, rs] of Object.entries(hits)) {
          const ok = rs.filter((r) => r.landed);
          if (ok.length) { cal.knockback[kind(w)] = +avg(ok.map((r) => r.kb)).toFixed(2); cal.reachFeet[kind(w)] = +Math.max(...ok.map((r) => r.at)).toFixed(2); }
        }
        log.push(`calibration.json: ${JSON.stringify(cal)}`);
        detail += log.join('; ');
        console.warn(`[test] creeper calibration: ${detail}`);
        break;
      }
      case 'husk': {
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        cmd(`summon husk ${x + 8} ${gy + 1} ${z}`);
        await system.waitTicks(2);
        const husk = dim.getEntities({ type: 'minecraft:husk', location: { x: x + 8, y: gy + 1, z }, maxDistance: 3 })[0];
        if (!husk) { detail = "couldn't summon a husk"; break; }
        let minD = Infinity, closeTicks = 0;
        for (let i = 0; i < 20 * 40 && husk.isValid; i++) {
          await system.waitTicks(1);
          if (!husk.isValid) break;
          const dd = dist3D(sim.location, husk.location);
          minD = Math.min(minD, dd);
          if (dd < 2) closeTicks++;
        }
        const killed = !husk.isValid;
        if (!killed) try { husk.remove(); } catch {}
        pass = killed && minD >= 1.6;
        detail = `${killed ? 'killed it' : 'husk still alive'} in ${secs()}s, closest ${minD.toFixed(1)} blocks, inside 2 blocks for ${(closeTicks / 20).toFixed(1)}s, lost ${Math.max(0, hp0 - agent.health())} hp (mode: ${agent.mode})`;
        break;
      }
    }
  } catch (e) {
    // Where it broke: the first line of the stack in our code.
    const at = String(e?.stack ?? '').split('\n').slice(1, 4).map((l) => l.trim()).join(' < ');
    detail = `${detail ? `${detail}; ` : ''}error: ${e}${at ? ` (${at})` : ''}`;
  } finally {
    agent.testHold = false;
    agent.newTask(null);
    agent.motor.stop();
    // Put the ground back, then make sure the bot isn't left inside a restored block.
    cmd(`structure load agent_test_backup ${box.x1} ${box.y1} ${box.z1}`);
    cmd('structure delete agent_test_backup');
    try {
      const top = S.groundTop(Math.floor(sim.location.x), Math.floor(sim.location.z));
      if (Number.isFinite(top) && top >= Math.floor(sim.location.y)) sim.teleport({ x: sim.location.x, y: top + 1, z: sim.location.z });
    } catch {} // (the bot died in the test: it respawns on its own)
  }
  return report(agent, name, pass, detail);
}

function report(agent, name, pass, detail) {
  agent.say(`Test ${name}: ${pass ? 'PASS' : 'FAIL'} - ${detail}.`);
  sendEvent({ type: 'test_result', name, pass, detail, state: agent.snapshot() }).catch(() => {});
  return { name, pass, detail };
}
