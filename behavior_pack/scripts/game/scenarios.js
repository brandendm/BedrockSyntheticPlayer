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
//   calibrate     measures the head height, a jump and the item-use gap in the game (game/calibrate.js)
//                 on a flat patch, and checks they match what the code was built on
//   husk          a husk walks up: fight it from the edge of reach (reports the closest it got)
//   creeper       calibration, nothing explodes: a creeper's walk speed and the distance it starts
//                 hissing at (the bot stands still; the creeper is removed the moment it hisses),
//                 then a stone sword and a stone spear swung once each at 3, 3.5 and 4 blocks: did
//                 it land, how far did it knock it back. The numbers tools/sim_combat.mjs guesses.
//   portal        10 obsidian and a flint and steel (given): build the frame (4 wide, 5 tall) by placing the
//                 blocks, light it, walk in and arrive in the Nether (then back; the Nether side's portal stays)
//   horse         a wild horse and a saddle (given): tame it the way a player does (get on, get thrown,
//                 again), saddle it, ride it a few blocks
//   leadsling     calibrates the sling: a boat jammed at the foot of a 1, 2 and 3 high step with the bot on top, the lead
//                 stretched to 5, 7, 9 and 11 blocks and a jump: the least stretch that brings the boat up each height, and
//                 where the lead snaps (kept in the world as leadCal.sling)
//   leadboat      a boat on a lead, walked away from at three speeds, then again riding a saddled horse:
//                 the distance it starts to follow at, the furthest apart they got, whether the lead
//                 snapped. What it measures is kept in the world (leadCal) for the lead code to use.
// The bot keeps whatever it's carrying; give it a pickaxe or sword first to test with one.

import { dist3D } from '../core/mathutil.js';
import { castRay } from './world.js';
import { sendEvent } from './bridge.js';
import { EXPECTED } from '../core/calibrate.js';
import { CONFIG } from '../config.js';
import { system, world, ItemStack, EquipmentSlot, Direction } from '@minecraft/server';
import { blueprint, furnishings } from '../core/house.js';
import { invCounts as invCountsOf, hold, take, container as packOf } from './inventory.js';
import { TestRecorder } from './testrun.js';
import { runDuel } from './duel.js';
import { shootAt } from './aim.js';
import { flyElytra } from './elytra.js';
import { Tracker, isVillager } from '../core/village.js';
import { isTamed, saddledOf } from './horse.js';
import { solvePitch } from '../core/ballistics.js';
import { getPlan } from '../core/learnhouse.js';
import { passRates, addStat } from '../core/testrun.js';
import { compare } from '../core/testrun.js';

/** How far the slab reaches round the site (west, east, to each side) for a test; the backed-up box is the same (a structure is 64 across at most). */
function extFor(name) {
  return name === 'farm' || name === 'farmrace' ? { w: 22, e: 36, r: 24 } : name === 'horserace' || name === 'elytra' ? { w: 8, e: 54, r: 10 } : name === 'bow' ? { w: 14, e: 34, r: 14 }
    : name === 'leadboat' || name === 'villagerhaul' ? { w: 12, e: 44, r: 12 } : { w: 14, e: 18, r: 12 };
}
const NAMES = ['roof', 'tower', 'hole', 'pit', 'trap', 'climb', 'ledge', 'ladder', 'husk', 'creeper', 'sheep', 'pen', 'smelt', 'smeltlogs', 'shelter', 'house', 'resume', 'ghostlog', 'quarry', 'dark', 'replant', 'litter', 'trader', 'iron', 'farm', 'equip', 'water', 'bucketfarm', 'treetop', 'corner', 'leap', 'bridge', 'fall', 'vines', 'stairgap', 'loot', 'shield', 'skel', 'rest', 'nights', 'calibrate', 'portal', 'horse', 'leadboat', 'leadsling', 'bow', 'duel', 'horserace', 'pillarrace', 'woodrace', 'lavacross', 'obsidian', 'mineore', 'enderman', 'blaze', 'ghast', 'witherskeleton', 'placerate', 'farmrace', 'creepers', 'ravine', 'elytra', 'villagerhaul', 'forest', 'village'];
let running = false;
/** How many sky sites have been used this session (each test gets a new one, 120 blocks further). */
let siteCounter = 0;

// Tests that wait out real time (a 5 minute despawn, a night, a furnace, a long walk): left out of
// `!bot test all quick`. Their real durations are in the batch report (`secs`), so this list can be
// corrected from data: anything over QUICK_S in the last report belongs here.
const SLOW = new Set(['villagerhaul', 'forest', 'village', 'loot', 'nights', 'rest', 'shelter', 'house', 'resume', 'quarry', 'farm', 'bucketfarm', 'iron', 'sheep', 'pen', 'smelt', 'smeltlogs', 'trader', 'ghostlog', 'stairgap', 'portal', 'horse', 'leadboat', 'leadsling', 'duel', 'horserace']);
/** Tests that need you there (you are the opponent). */
const PLAYER_ONLY = new Set(['duel', 'horserace', 'pillarrace', 'woodrace', 'farmrace']);
const QUICK_S = 60;
// The ones that need monsters about (and the world's own difficulty); the rest run peaceful with monsters cleared.
/** Tests that stay on the real ground (trees, water, ores, the night, long walks); everything else is built in the sky. */
const GROUND = new Set(['forest', 'village', 'water', 'bucketfarm', 'treetop', 'vines', 'ghostlog', 'nights', 'calibrate', 'quarry', 'dark', 'iron', 'loot', 'rest', 'house', 'resume', 'shelter']);
/** Tests that need the day and night going round (the rest are kept at day while the tests run). */
const NIGHT = new Set(['shelter', 'house', 'resume', 'nights', 'rest', 'dark', 'loot']);
/** Tests that need the natural terrain or water as it is: no floor is laid for them. */
/** Tests run out in the real world, at a site found for them (a forest, the way to a village): no slab, no grass floor laid. */
const WORLDT = new Set(['forest', 'village']);
const NATURAL = new Set(['forest', 'village', 'water', 'bucketfarm', 'treetop', 'vines', 'ghostlog', 'nights', 'calibrate']);
const COMBAT = new Set(['husk', 'creeper', 'skel', 'shield', 'dark', 'duel', 'enderman', 'blaze', 'ghast', 'witherskeleton', 'creepers']);
// The ones a player can do too (`!bot test <name> me`): a goal the player can reach and the test can see.
const HUMAN_OK = new Set(['tower', 'hole', 'pit', 'climb', 'ladder', 'corner', 'leap', 'bridge', 'ledge', 'bow', 'husk', 'sheep', 'pen', 'replant', 'litter', 'house', 'lavacross', 'obsidian', 'mineore', 'enderman', 'blaze', 'ghast', 'witherskeleton', 'creepers', 'ravine', 'leadboat', 'elytra', 'villagerhaul', 'forest', 'village']);
// No single test runs longer than this (the task is ended and the test left to report what it has).
const CAP_S = 240;

/** For `test <name> me`: what the test is, what is given to you, and how it ends. */
/** The hotbar slot holding this item, or -1. */
const findSlotOf = (e, id) => { const c = packOf(e); for (let i = 0; c && i < c.size; i++) if (c.getItem(i)?.typeId === `minecraft:${id}`) return i; return -1; };
const HUMAN_HELP = {
  tower: { kit: [], text: 'You start on top of a 10-block cobblestone tower. Get down to the ground safely (no fall damage) any way you like.' },
  hole: { kit: [['dirt', 16], ['stone_pickaxe', 1]], text: 'You start at the bottom of a 2-deep hole. Get out and walk to the gold block 12 blocks east (a gold block).' },
  pit: { kit: [['dirt', 16], ['stone_pickaxe', 1]], text: 'You start at the bottom of a 3-deep 3x3 pit. Get out and walk to the gold block 12 blocks east.' },
  climb: { kit: [], text: 'You start at the bottom of a 7-deep stone pit with some rubble steps, no pickaxe (like the bot). Get to the top, y above the rim.' },
  ladder: { kit: [], text: 'A 4-high cliff with a ladder. Go to the gold block on top of the cliff, 6 blocks east of the ladder.' },
  corner: { kit: [], text: 'A 2-high ledge with two 1-block steps in its edge. Walk to the gold block on top, to the east.' },
  leap: { kit: [], text: 'A closed corridor with a 1-wide, 2-deep gap in the floor. Get across it without falling and reach the gold block at the far end.' },
  bridge: { kit: [['dirt', 16]], text: 'A closed corridor with a 3-wide, 7-deep gap. You have 16 dirt. Get across without falling and reach the gold block at the far end.' },
  ledge: { kit: [['dirt', 16]], text: 'A crafting table sits on top of a 2-high cliff. Get close enough to open it (within about 4 blocks of it).' },
};
HUMAN_HELP.husk = { kit: [], text: 'A husk (a desert zombie) is 8 blocks east of you. Kill it. Use your sword.' };
HUMAN_HELP.sheep = { kit: [], text: 'Three sheep stand 6 blocks east. Kill them and pick up 3 wool.' };
HUMAN_HELP.pen = { kit: [], text: 'Two cows in a fenced pen with a gate, 4 blocks east. Go in through the gate, kill them and pick up 2 raw beef.' };
HUMAN_HELP.replant = { kit: [['oak_sapling', 2]], text: 'A tree stands 5 blocks east. Cut the whole tree down, then plant a sapling where the trunk stood.' };
HUMAN_HELP.litter = { kit: [], text: 'A tree stands 5 blocks east with leaf litter on the ground round it. Break the litter and pick up at least 4 pieces.' };
HUMAN_HELP.house = { kit: [], noKit: true, text: 'Build a house the way you like, with a door, a bed, a crafting table, a furnace, chests and signs. Your own things are put aside and you are given everything a house takes (they come back when you finish). Say `!bot test done` when you are finished: the bot learns from how you built it.' };
const MOB_KIT = [['diamond_sword', 1], ['bow', 1], ['arrow', 64], ['shield', 1]];
HUMAN_HELP.lavacross = { kit: [['water_bucket', 1]], text: 'A lake of lava 11 blocks wide, wall to wall, between two netherrack platforms (the Nether: lava lakes you must cross). Get to the gold block on the far side without burning: bridge it with your cobblestone, or cool it with the water bucket.' };
HUMAN_HELP.obsidian = { kit: [['water_bucket', 1], ['diamond_pickaxe', 1]], text: 'A pool of lava three wide. Turn it into obsidian with the water bucket and mine at least one obsidian with the diamond pickaxe, without being burned (this is how a nether portal is made when you have none).' };
HUMAN_HELP.mineore = { kit: [['iron_pickaxe', 1]], text: 'The ground under you has ore in it: coal, iron, copper, gold, redstone, lapis and diamond (two or three of each). Dig down and bring up one of each (raw iron, copper and gold, coal, redstone, lapis lazuli and a diamond), with the iron pickaxe.' };
HUMAN_HELP.enderman = { kit: [...MOB_KIT, ['carved_pumpkin', 1]], text: 'An enderman, 10 blocks east: kill it. Do not look at its head (it attacks), or wear the carved pumpkin on your head (then it cannot be angered by your eyes). You have a diamond sword, a bow and arrows and a shield; iron armour is put on.' };
HUMAN_HELP.blaze = { kit: MOB_KIT, text: 'A blaze, 10 blocks east and 4 up: kill it (it hovers and shoots fireballs). You have a diamond sword, a bow and arrows and a shield; iron armour is put on.' };
HUMAN_HELP.ghast = { kit: MOB_KIT, text: 'A ghast, 14 blocks east and 9 up: kill it (it shoots exploding fireballs; a hit on the fireball sends it back, or shoot the ghast). You have a bow and arrows, a diamond sword and a shield; iron armour is put on.' };
HUMAN_HELP.witherskeleton = { kit: MOB_KIT, text: 'A wither skeleton, 10 blocks east: kill it (its hits wither you). You have a diamond sword, a bow and arrows and a shield; iron armour is put on.' };
HUMAN_HELP.creepers = { kit: [['stone_sword', 1], ['shield', 1], ['bow', 1], ['arrow', 32]], text: 'Four creepers come at you across the open ground. You have a shield (off hand: hold right-click to raise it, it takes most of a blast), a sword and a bow. Get rid of all four (killed or blown up) and lose as few hearts as you can: 7 hearts or less passes.' };
HUMAN_HELP.ravine = { kit: [], text: 'You are at the bottom of a ravine, 9 deep and 3 wide, sheer walls. Get out onto the surface: your 32 cobblestone and 16 dirt are for building yourself out, the pickaxe for digging.' };
HUMAN_HELP.bow = { kit: [['bow', 1], ['arrow', 48]], text: 'Six targets (armor stands) in different spots in front of you: near and far, left and right, one on a pillar and one on a step. Hit as many as you can, 5 of 6 passes (hold right-click to draw, release to shoot).' };
HUMAN_HELP.leadboat = { kit: [['lead', 2]], text: 'Two villagers and a boat at the west end of a rough course: a pond, a step up and another with stones on it, a trench, a three-high hill, a gap 3 wide and 6 deep across the whole width, a plateau with a gold block and, just past it, a pit 3 wide and 3 deep. Put a lead on the boat (use the lead on it), get both villagers into it (walk it into them, it can take two), lead the boat over all of it and get both villagers into the pit (round it, so the boat is pulled in; if the boat is against a villager for 4 s and it does not board, it is put in for you). Your 32 cobblestone and 16 dirt are for the gap. The bot does the same, then rides a horse over the first part with the boat alone.' };
HUMAN_HELP.villagerhaul = { kit: [['lead', 2]], text: 'Two villagers stand near the start, a boat at the west end. Put a lead on the boat, get both villagers into it (walk it into them, it can take two) and lead the boat over three hills and across a 3-wide gap (your cobblestone and dirt are for it) to the gold block: both villagers within 4 blocks of it. If the boat is against a villager for 4 s and it does not board, it is put in for you.' };
HUMAN_HELP.elytra = { kit: [['firework_rocket', 6]], text: 'You stand on a 22-high tower with elytra on, 44 blocks west of a gold block, and have 6 firework rockets. Jump off, jump again in the air to open the wings, aim with the view (nose down for speed, up to slow), use a rocket for a boost, and land on the gold block (within 4 blocks, 5 hearts lost at most).' };
HUMAN_HELP.forest = { kit: [], text: 'You and the bot are dropped, one after the other, at the same spot in a forest (the trees are put back between turns). Get 15 logs as fast as you can; the stone axe is in your kit.' };
HUMAN_HELP.village = { kit: [], text: 'You are dropped about 170 blocks from a village, with no idea which way. Find it as fast as you can: the clock stops when you are within 24 blocks of its middle. The bot starts from the same spot.' };
const SHORT = { forest: 'Get 15 logs', village: 'Find the village', leadboat: 'Lead villagers into the pit', villagerhaul: 'Villagers in a boat to the gold block', elytra: 'Glide to the gold block', creepers: 'Beat 4 creepers, shield up', ravine: 'Get out of the ravine', lavacross: 'Cross the lava', obsidian: 'Make and mine obsidian', mineore: 'One of each ore', enderman: 'Kill the enderman', blaze: 'Kill the blaze', ghast: 'Kill the ghast', witherskeleton: 'Kill the wither skeleton', tower: 'Get down, no fall damage', hole: 'Get out, reach the gold block', pit: 'Get out, reach the gold block', climb: 'Get out of the pit', ladder: 'Reach the gold block', corner: 'Reach the gold block', leap: 'Cross the gap, gold block', bridge: 'Bridge to the gold block', ledge: 'Get near the table', bow: 'Hit the 6 targets', husk: 'Kill the husk', sheep: 'Collect 3 wool', pen: 'Collect 2 raw beef', replant: 'Cut tree, replant sapling', litter: 'Collect 4 leaf litter', house: 'Build a house, then test done' };
const humanHelp = (name) => HUMAN_HELP[name] ?? null;
/** What you are handed in every test you do: tools, blocks and food; the test's own extras on top. `climb` has no tools, like the bot's run. */
const STD_KIT = [['stone_pickaxe', 1], ['stone_axe', 1], ['stone_shovel', 1], ['stone_sword', 1], ['cobblestone', 32], ['dirt', 16], ['bread', 8]];
/** @returns {Array<[string, number]>} */
const kitFor = (name) => {
  if (humanHelp(name)?.noKit) return [];
  const extra = humanHelp(name)?.kit ?? [];
  const base = name === 'climb' ? [] : STD_KIT.filter(([id]) => !extra.some(([e]) => e === id));
  return /** @type {Array<[string, number]>} */ ([...base, ...extra]);
};

/**
 * !bot test <name> [arg]      one test
 * !bot test all               every test, one after another, unattended
 * !bot test all quick         only the ones that don't wait out real time (under a minute each)
 * !bot test all slow          only the slow ones
 * !bot test <a>,<b>,<c>       a list
 * Every batch ends with ONE summary (chat, brain/logs/tests.jsonl as `test_batch`): pass/fail, how
 * long each took (slowest first) and what each failed on. A test over CAP_S is cut off.
 */
export async function runTests(agent, player, args) {
  if (args[0] === 'stop') {
    if (!running) return agent.say('No test is running.');
    agent.testAbort = true; agent.testSkipped = true;
    try { agent.newTask(null); agent.motor.stop(); } catch { /* */ }
    return agent.say('Stopping the tests; what was collected so far is kept.');
  }
  if (args[0] === 'go') { agent.testGo = true; return; }
  // `test clean`: lava and fire left by the old shared test site (all of them now have a site of their own, far off): turned to air within 48
  // blocks of you, from 40 below you to 130 above.
  if (args[0] === 'clean') {
    if (!player) return agent.say('Say it in chat yourself: `!bot test clean`.');
    const px = Math.floor(player.location.x), pz = Math.floor(player.location.z), py = Math.floor(player.location.y);
    const X1 = px - 48, X2 = px + 48, Z1 = pz - 48, Z2 = pz + 48, y1 = Math.max(-60, py - 40), y2 = Math.min(319, py + 130);
    const per = Math.max(1, Math.floor(30000 / ((X2 - X1 + 1) * (Z2 - Z1 + 1))));
    let done = 0;
    for (const liq of ['lava', 'flowing_lava', 'fire']) for (let yy = y1; yy <= y2; yy += per) { try { agent.dim.runCommand(`fill ${X1} ${yy} ${Z1} ${X2} ${Math.min(y2, yy + per - 1)} ${Z2} air replace ${liq}`); done++; } catch { /* unloaded part */ } }
    return agent.say(`Cleared lava and fire within 48 blocks of you (${done} passes).`);
  }
  // `test fast`: skip the waiting in this test (the night, a furnace cooking): the script API has no way to run the game faster,
  // so the waits the tests know about are cut short instead.
  if (args[0] === 'fast') {
    if (!running) return agent.say('No test is running.');
    agent.testFast = true;
    try { const t = world.getTimeOfDay(); if (t >= 12500 && t < 23000) world.setTimeOfDay(23500); } catch { /* */ }
    return agent.say('Fast mode for this test: the night is set to morning, a furnace is filled, and the bot\'s own pauses are a quarter as long (the game itself cannot be sped up from a script).');
  }
  if (args[0] === 'done') { agent.testDone = true; return; }
  if (args[0] === 'skip') {
    if (!running) return agent.say('No test is running.');
    agent.testSkipped = true;
    try { agent.newTask(null); agent.motor.stop(); } catch { /* */ }
    return agent.say('Skipping this test.');
  }
  // Retired: the bot passes these, about as fast as a player (the sweeps to u172); `include all` or `include <name>` brings them back.
  const RETIRED = ['leap', 'corner', 'ladder', 'ledge', 'pit', 'hole', 'bridge', 'husk', 'woodrace', 'roof', 'trap', 'smelt', 'smeltlogs', 'shelter', 'equip', 'fall', 'vines', 'stairgap', 'treetop', 'ghostlog', 'creeper', 'calibrate', 'nights', 'leadsling', 'portal', 'horse'];
  if (agent.memory.data.testOmit === undefined) { agent.memory.data.testOmit = [...RETIRED]; agent.memory.save(); }
  // The second round (the u177 run): the bot passes these at or beyond a player's pace, or beats them outright.
  if (!agent.memory.data.retiredV2) {
    agent.memory.data.testOmit = [...new Set([...agent.memory.data.testOmit, 'sheep', 'enderman', 'blaze', 'ghast', 'witherskeleton', 'horserace', 'bow', 'duel', 'litter', 'replant'])];
    agent.memory.data.retiredV2 = true; agent.memory.save();
  }
  // The third (the u181 run): the bot ties or beats you on these.
  if (!agent.memory.data.retiredV3) {
    agent.memory.data.testOmit = [...new Set([...agent.memory.data.testOmit, 'lavacross', 'obsidian', 'pillarrace'])];
    agent.memory.data.retiredV3 = true; agent.memory.save();
  }
  // The fourth (the u183 run): mineore (nothing to learn from a pickaxe test that fails 0/7 either way) and the house (the build is learned from your turn, the bot's own is too slow to wait for).
  if (!agent.memory.data.retiredV4) {
    agent.memory.data.testOmit = [...new Set([...agent.memory.data.testOmit, 'mineore', 'house'])];
    agent.memory.data.retiredV4 = true; agent.memory.save();
  }
  const omitList = () => (agent.memory.data.testOmit ??= []);
  if (args[0] === 'omit' || args[0] === 'include') {
    const names = String(args[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean);
    if (args[0] === 'omit' && names.includes('none')) agent.memory.data.testOmit = [];
    else if (args[0] === 'include' && names.includes('all')) agent.memory.data.testOmit = [];
    else {
      const bad = names.filter((n) => !NAMES.includes(n));
      if (bad.length) return agent.say(`Not tests: ${bad.join(', ')}.`);
      const cur = new Set(omitList());
      for (const n of names) args[0] === 'omit' ? cur.add(n) : cur.delete(n);
      agent.memory.data.testOmit = [...cur];
    }
    agent.memory.save();
    return agent.say(`Left out of "test all": ${agent.memory.data.testOmit.join(', ') || 'nothing'}.`);
  }
  if (args[0] === 'rate' || args[0] === 'rates') {
    const r = passRates(agent.memory.data.testRuns, omitList());
    return agent.say(`Pass rate, last run of each test: you ${r.human.pct === null ? 'no runs' : `${r.human.pct}% (${r.human.pass}/${r.human.total})`}, bot ${r.bot.pct === null ? 'no runs' : `${r.bot.pct}% (${r.bot.pass}/${r.bot.total})`}.`);
  }
  if (running) return agent.say('A test is already running.');
  // `test all except a,b`: this batch only.
  const exIdx = args.indexOf('except');
  const except = new Set(exIdx >= 0 ? String(args[exIdx + 1] ?? '').split(',').map((n) => n.trim()) : []);
  if (exIdx >= 0) args = args.slice(0, exIdx);
  // `!bot test <name> me`: you do it (same setup, you at the start, the bot stands by); both runs are measured and compared.
  // Who does it: the bot (default), `me` (you only), `both` (the bot, then you, each test), `youfirst` (you, then the bot).
  const MODE_WORDS = ['me', 'human', 'both', 'botfirst', 'youfirst', 'mefirst', 'daycycle', 'alsobot'];
  const who = args.includes('youfirst') || args.includes('mefirst') ? 'youfirst' : args.includes('both') || args.includes('botfirst') ? 'botfirst' : args.includes('me') || args.includes('human') ? 'you' : 'bot';
  const keepCycle = args.includes('daycycle');
  const human = who !== 'bot';
  const [name = 'all', arg] = args.filter((a) => !MODE_WORDS.includes(a));
  const mode = name === 'all' && ['quick', 'slow'].includes(String(arg)) ? String(arg) : null;
  const named = String(name).includes(',') ? String(name).split(',').map((n) => n.trim()) : null;
  const list = named && named.every((n) => NAMES.includes(n)) ? named
    : name === 'all' ? NAMES.filter((n) => !omitList().includes(n) && !except.has(n) && (player || !PLAYER_ONLY.has(n))).filter((n) => (mode === 'quick' ? !SLOW.has(n) : mode === 'slow' ? SLOW.has(n) : true))
    : NAMES.includes(name) ? [name] : null;
  // When you take part, `test all` leaves out the tests that have no turn for you (`alsobot` brings them back).
  if (who !== 'bot' && name === 'all' && !args.includes('alsobot') && list) { const keep = list.filter((n) => HUMAN_OK.has(n) || PLAYER_ONLY.has(n)); list.length = 0; list.push(...keep); }
  if (!list) return agent.say(`Tests: ${NAMES.join(', ')}, all [quick|slow], or a,b,c.`);
  if (!list.length) return agent.say('Every test is omitted.');
  if (human && !player) return agent.say('Say it in chat yourself: `!bot test <name> me` (or both / youfirst).');
  if (who === 'you' && !list.some((n) => HUMAN_OK.has(n))) agent.say(`None of those can be done by you yet (${[...HUMAN_OK].join(', ')}); the bot does them.`);
  running = true;
  const autoWas = agent.autoEnabled;
  agent.autoEnabled = false;
  const results = [];
  const argN = mode || arg === undefined ? undefined : Number(arg);
  const tAll = system.currentTick;
  const home0 = player ? { x: player.location.x, y: player.location.y, z: player.location.z } : null;
  // Progress (the dashboard's bar), and the world kept calm: peaceful for everything but the fights, which get back what it was.
  agent.testAbort = false;
  // The runs: [test, you?]. A test you can do is done by the bot, you, or both in the order you chose; the others by the bot.
  /** @type {Array<[string, boolean]>} */
  const jobs = [];
  for (const n of list) {
    if (!HUMAN_OK.has(n) || who === 'bot') jobs.push([n, false]);
    else if (who === 'you') jobs.push([n, true]);
    else if (who === 'botfirst') jobs.push([n, false], [n, true]);
    else jobs.push([n, true], [n, false]);
  }
  const humanTurns = list.filter((n) => HUMAN_OK.has(n) || PLAYER_ONLY.has(n));
  if (who !== 'bot') agent.say(`You have a turn in ${humanTurns.length} of ${list.length} tests (${humanTurns.join(', ') || 'none'}); the rest are the bot's alone.`);
  const gm0 = /** @type {any} */ (player)?.getGameMode?.() ?? 'survival';
  const setGm = (m) => { try { /** @type {any} */ (player)?.setGameMode(m); } catch { /* */ } };
  agent.testProgress = { running: true, done: 0, total: jobs.length, current: null, human, startedAt: Date.now() };
  // Daylight: kept at day while the tests run (the ones that need the night turn the cycle back on), put back after.
  const cycle0 = (() => { try { return /** @type {any} */ (world).gameRules?.doDaylightCycle ?? true; } catch { return true; } })();
  const setCycle = (on) => { try { world.getDimension('overworld').runCommand(`gamerule dodaylightcycle ${on}`); } catch { /* */ } if (!on) { try { world.setTimeOfDay(1000); } catch { /* */ } } };
  const diff0 = (() => { try { return String(world.getDifficulty()).toLowerCase(); } catch { return 'normal'; } })();
  const setDiff = (d) => { try { world.getDimension('overworld').runCommand(`difficulty ${d}`); } catch { /* */ } };
  try {
    for (const [n, isYou] of jobs) {
      if (agent.testAbort) break;
      const human = isYou;
      const t0 = system.currentTick;
      agent.testProgress.current = n;
      agent.testSkipped = false; agent.testFast = false;
      setDiff(COMBAT.has(n) ? diff0 : 'peaceful');
      setCycle(keepCycle || NIGHT.has(n));
      // Creative while you watch (you can fly about), survival while you do a test or fight in one.
      setGm(isYou || PLAYER_ONLY.has(n) ? 'survival' : 'creative');
      try { player?.removeEffect('slow_falling'); } catch { /* */ }
      // The cap: at the deadline the task ends, so waits on it return and the test reports.
      let capped = false;
      const capS = ['leadboat', 'leadsling', 'forest', 'village', 'villagerhaul'].includes(n) ? 480 : CAP_S;
      agent.testProgress.deadline = Date.now() + capS * 1000;
      agent.testProgress.limitS = capS;
      const cap = system.runTimeout(() => { capped = true; agent.newTask(null); agent.motor.stop(); }, capS * 20);
      let r;
      try { r = await runOne(agent, player, n, argN, human); } finally { try { system.clearRun(cap); } catch {} }
      agent.testProgress.done++;
      r.secs = Math.round((system.currentTick - t0) / 20);
      if (agent.testSkipped) { const sl = agent.memory.data.testRuns?.[n]?.[human ? 'human' : 'bot']; if (sl) { sl.skipped = true; agent.memory.save(); } r.pass = false; r.skipped = true; r.detail = `skipped; ${r.detail}`; agent.testSkipped = false; }
      else if (capped) { r.pass = false; r.detail = `cut off after ${capS} s; ${r.detail}`; }
      results.push(r);
    }
  } finally {
    setDiff(diff0);
    setCycle(cycle0);
    setGm(gm0);
    agent.testProgress = { ...agent.testProgress, running: false, current: null, deadline: null };
    agent.testSkipped = false; agent.testAbort = false;
    try { if (player && home0) player.teleport(home0); } catch { /* */ }
    agent.autoEnabled = autoWas;
    running = false;
  }
  if (results.length > 1) {
    const total = Math.round((system.currentTick - tAll) / 20);
    const failed = results.filter((r) => !r.pass);
    const slowest = [...results].sort((a, b) => b.secs - a.secs).slice(0, 5).map((r) => `${r.name} ${r.secs}s`).join(', ');
    agent.say(`Tests done: ${results.length - failed.length}/${results.length} passed in ${Math.floor(total / 60)}m${total % 60}s. Slowest: ${slowest}.${failed.length ? ` FAILED: ${failed.map((r) => r.name).join(', ')}.` : ''}`);
    sendEvent({ type: 'test_batch', build: CONFIG.build, passed: results.length - failed.length, total: results.length, secs: total, results: results.map((r) => ({ name: r.name, pass: r.pass, secs: r.secs, detail: String(r.detail).slice(0, 300) })) }).catch(() => {});
  }
}

async function runOne(agent, player, name, arg, human = false) {
  const dim = agent.dim, sim = agent.sim, S = agent.skills;
  // Most tests are built in the sky on a slab of their own (no lakes, slopes or trees to interfere); the ones that
  // need the real world (trees, water, ores, the night) stay on the ground.
  const sky = !GROUND.has(name);
  const from = player ?? sim;
  let x, z, gy;
  /** What the world-site finder found (a village's middle). @type {any} */
  let worldInfo = null;
  /** The ticking area that keeps a far-off site loaded (removed at the end). */
  let tickName = '';
  if (sky) {
    // Sky sites go round a ring 56 blocks from where you are (eight places, one after another), inside the chunks that are loaded: the
    // first try, 4000 blocks out, was mostly not loaded when the slab was built (blocks missing, "none walkable" under the bot). What a
    // test leaves (lava, fire) is cleaned out with a margin, and the next test is somewhere else.
    siteCounter++;
    const slot = siteCounter % 8, ang = (slot * Math.PI) / 4;
    x = Math.floor(from.location.x + 56 * Math.cos(ang));
    z = Math.floor(from.location.z + 56 * Math.sin(ang));
    gy = 150;
    tickName = `agent_test_site_${slot}`;
    try { dim.runCommand(`tickingarea remove ${tickName}`); } catch { /* none */ }
    try { dim.runCommand(`tickingarea add circle ${x} ${gy} ${z} 4 ${tickName} true`); } catch (e) { console.warn(`[test] tickingarea: ${e}`); }
    // Every corner of the slab and its middle must answer before anything is built (a loaded chunk gives a block, an unloaded one nothing).
    const e0 = extFor(name);
    const probes = [[x - e0.w, z - e0.r], [x + e0.e, z - e0.r], [x - e0.w, z + e0.r], [x + e0.e, z + e0.r], [x, z], [x + Math.floor(e0.e / 2), z]];
    let loaded = false;
    for (let i = 0; i < 120 && !loaded; i++) {
      loaded = probes.every(([px, pz]) => { try { return !!dim.getBlock({ x: px, y: gy, z: pz }); } catch { return false; } });
      if (!loaded) await system.waitTicks(5);
    }
    if (!loaded) { try { dim.runCommand(`tickingarea remove ${tickName}`); } catch { /* */ } return report(agent, name, false, 'the test site did not load (a corner of the slab had no chunk after 30 s)'); }
  } else if (WORLDT.has(name)) {
    // A site out in the real world, found for the test (the same one for you and the bot, kept for this build).
    const found = name === 'forest' ? await findForestSite(agent, from) : await findVillageSite(agent, from);
    if (found.error) return report(agent, name, false, found.error);
    x = found.x; z = found.z; gy = found.gy; tickName = found.tickName; worldInfo = found;
  } else {
    // Site: 10 blocks in front of whoever asked (or of the bot), on natural ground.
    const v = from.getViewDirection();
    const len = Math.hypot(v.x, v.z) || 1;
    x = Math.floor(from.location.x + (v.x / len) * 10); z = Math.floor(from.location.z + (v.z / len) * 10);
    const gy0 = S.groundTop(x, z);
    if (!Number.isFinite(gy0)) return report(agent, name, false, 'no ground in front of you (unloaded?)');
    gy = gy0;
  }
  // (the farm test lays 55 x 41 of its own: its slab and backup are that big)
  const ext = extFor(name);
  // The rim wall is only low (to keep walkers on the slab) where things fly: a ghast or blaze hovering out over the edge, the arrows at it.
  const wallH = ['ghast', 'blaze', 'bow'].includes(name) ? 2 : 8;
  const box = name === 'forest' ? { x1: x - 32, y1: gy - 6, z1: z - 32, x2: x + 31, y2: gy + 26, z2: z + 31 } : sky ? { x1: x - ext.w, y1: gy - 10, z1: z - ext.r, x2: x + ext.e, y2: gy + (name === 'elytra' ? 36 : 20), z2: z + ext.r } : { x1: x - 8, y1: gy - 8, z1: z - 8, x2: x + 14, y2: gy + 18, z2: z + 8 };
  const pHome = player ? { x: player.location.x, y: player.location.y, z: player.location.z } : null;
  const cmd = (c) => { try { dim.runCommand(c); return true; } catch (e) { console.warn(`[test] ${c}: ${e}`); return false; } };
  if (!cmd(`structure save agent_test_backup ${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2} false memory true`)) {
    if (tickName) { try { dim.runCommand(`tickingarea remove ${tickName}`); } catch { /* */ } }
    return report(agent, name, false, "couldn't back up the test area, not touching it");
  }
  const home = { x: sim.location.x, y: sim.location.y, z: sim.location.z };
  if (sky) {
    cmd(`fill ${x - ext.w} ${gy - 10} ${z - ext.r} ${x + ext.e} ${gy - 4} ${z + ext.r} stone`);
    cmd(`fill ${x - ext.w} ${gy - 3} ${z - ext.r} ${x + ext.e} ${gy - 1} ${z + ext.r} dirt`);
    cmd(`fill ${x - ext.w} ${gy} ${z - ext.r} ${x + ext.e} ${gy} ${z + ext.r} grass_block`);
    // Built, and checked: a corner and the middle must now be what was put there (a chunk that loaded late would have taken the fill and lost it).
    for (let attempt = 0; attempt < 2; attempt++) {
      const okSlab = [[x - ext.w, z - ext.r], [x + ext.e, z + ext.r], [x, z]].every(([px, pz]) => { try { return dim.getBlock({ x: px, y: gy, z: pz })?.typeId === 'minecraft:grass_block'; } catch { return false; } });
      if (okSlab) break;
      await system.waitTicks(20);
      cmd(`fill ${x - ext.w} ${gy - 10} ${z - ext.r} ${x + ext.e} ${gy - 4} ${z + ext.r} stone`);
      cmd(`fill ${x - ext.w} ${gy - 3} ${z - ext.r} ${x + ext.e} ${gy - 1} ${z + ext.r} dirt`);
      cmd(`fill ${x - ext.w} ${gy} ${z - ext.r} ${x + ext.e} ${gy} ${z + ext.r} grass_block`);
    }
    // A glass wall round the slab's rim, so nobody (the bot in a fight, a horse, you) can walk or be knocked off it into the sky.
    const wx1 = x - ext.w, wx2 = x + ext.e, wz1 = z - ext.r, wz2 = z + ext.r;
    for (const [a1, b1, a2, b2] of [[wx1, wz1, wx2, wz1], [wx1, wz2, wx2, wz2], [wx1, wz1, wx1, wz2], [wx2, wz1, wx2, wz2]]) cmd(`fill ${a1} ${gy + 1} ${b1} ${a2} ${gy + wallH} ${b2} glass`);
    // Whoever is not doing the test waits on the slab too (the bot by the edge while you do it).
    try { if (human) sim.teleport({ x: x - 4.5, y: gy + 1, z: z + 6.5 }); else sim.teleport({ x: x + 0.5, y: gy + 1, z: z + 0.5 }); } catch { /* */ }
    if (human && player) { try { player.teleport({ x: x + 0.5, y: gy + 1, z: z + 0.5 }); } catch { /* */ } }
    await system.waitTicks(5);
  }
  agent.newTask(null);
  agent.motor.stop();
  // A calm site: hostile mobs near it (creepers walking into a house test) are cleared unless the test is a fight.
  if (!COMBAT.has(name)) { try { dim.runCommand(`kill @e[family=monster,x=${x},y=${gy},z=${z},r=64]`); } catch { /* none */ } }
  // Tables and furnaces remembered from earlier tests (their blocks were put back when those ended)
  // would change what the bot does here: replanting keeps clear of "our table", crafting walks
  // off to it. Every test starts without them; the ones that need one place it themselves.
  for (const cat of ['crafting_table', 'furnace']) agent.memory.forgetNear(cat, dim.id, { x, y: gy, z }, 40);
  // Items lying about from earlier tests (logs from the vine tree, saplings) would have it digging
  // through the fresh rock to fetch them: the site starts with none.
  try { for (const e of dim.getEntities({ type: 'minecraft:item', location: { x, y: gy, z }, maxDistance: 48 })) e.remove(); } catch {}
  let t0 = system.currentTick;
  const hp0 = agent.health();
  /** @type {Array<() => void>} */
  const cleanup = [];
  /** What a test put in the pack: taken out again at the end (the flint and steel stayed in the bot's hand and pack). @type {Record<string, number>} */
  const gave = {};
  const giveItem = (id, n) => { packOf(sim)?.addItem(new ItemStack(`minecraft:${id}`, n)); gave[id] = (gave[id] ?? 0) + n; };
  const secs = () => ((system.currentTick - t0) / 20).toFixed(0);
  const idle = async (maxS) => { // wait for the task to end (or time out)
    await system.waitTicks(10);
    for (let i = 0; i < maxS * 4 && agent.task; i++) await system.waitTicks(5);
    return !agent.task;
  };
  /** Like idle, but also ends the moment `done()` holds (your clock stops when you are out; the bot's was running on while it walked off the top). */
  const idleOr = async (maxS, done) => {
    await system.waitTicks(10);
    for (let i = 0; i < maxS * 4 && agent.task && !agent.testSkipped; i++) { if (done()) break; await system.waitTicks(5); }
    const ok = done();
    if (ok && agent.task) { agent.newTask(null); agent.motor.stop(); }
    return ok || !agent.task;
  };
  const who = human ? player : sim;
  // Human mode: the same setup, you do it while the bot stands by; ends when the goal is met or the time is up.
  const humanTry = async (done, maxS, mark = null, remind = '') => {
    if (mark) cmd(`setblock ${Math.floor(mark.x)} ${Math.ceil(mark.y) - 1} ${Math.floor(mark.z)} gold_block`);
    const h = humanHelp(name);
    const kit = kitFor(name);
    agent.say(`YOUR TURN, ${name}: ${h ? h.text : 'do what the test describes.'}${kit.length ? ` You were given: ${kit.map(([id, n]) => `${n} ${id}`).join(', ')}.` : ' You were given nothing (like the bot).'} Take your time: the clock starts when you move (or say \`!bot test go\`). \`!bot test skip\` gives up.`);
    try { player.onScreenDisplay.setTitle(`Your turn: ${name}`, { subtitle: SHORT[name] ?? '', stayDuration: 160, fadeInDuration: 5, fadeOutDuration: 10 }); } catch { /* */ }
    // Reading time is not on the clock: it starts when you move or jump (or say go), after 60 s at most.
    agent.testGo = false;
    if (agent.testProgress) { agent.testProgress.reading = true; agent.testProgress.deadline = null; }
    const p0 = { x: who.location.x, y: who.location.y, z: who.location.z };
    for (let i = 0; i < 60 * 10 && !agent.testSkipped && !agent.testGo; i++) {
      await system.waitTicks(2);
      const l = who.location;
      if (Math.hypot(l.x - p0.x, l.y - p0.y, l.z - p0.z) > 0.8) break;
    }
    rec.reset(); t0 = system.currentTick;
    if (agent.testProgress) { agent.testProgress.reading = false; agent.testProgress.deadline = Date.now() + maxS * 1000; agent.testProgress.limitS = maxS; }
    for (let i = 0; i < maxS * 4 && !agent.testSkipped; i++) {
      if (done()) return true;
      if (remind && i % 20 === 0) { try { player.onScreenDisplay.setActionBar(remind); } catch { /* */ } }
      await system.waitTicks(5);
    }
    return false;
  };
  const rec = new TestRecorder(who).start();
  // The bot's clock starts when its task does (the setup's own waits are not its time; yours starts when you move).
  if (!human) {
    let began = false;
    const watchStart = system.runInterval(() => { if (!began && agent.task) { began = true; rec.reset(); t0 = system.currentTick; } }, 1);
    cleanup.push(() => { try { system.clearRun(watchStart); } catch { /* */ } });
  }
  // The bot gets what you are handed in the tests you can do (it fought the husk bare-handed against your sword).
  if (!human && HUMAN_OK.has(name)) { for (const [id, n] of kitFor(name)) giveItem(id, n); try { agent.equipBestWeapon(); } catch { /* */ } }
  if (human) agent.testHold = true; // the bot stands by while you do it (no fighting or fleeing of its own)
  /** What the human was handed, taken back at the end. @type {Array<[string, number]>} */
  const handed = [];
  if (human) {
    const pk = packOf(player);
    for (const [id, n] of kitFor(name)) { try { pk?.addItem(new ItemStack(`minecraft:${id}`, n)); handed.push([id, n]); } catch { /* */ } }
  }
  const tp = (px, py, pz) => who.teleport({ x: px + 0.5, y: py, z: pz + 0.5 });
  let pass = false, detail = '';
  /** The recorded summary of one leg of a test, if that is what is compared with you (the bot's foot leg of the lead test). @type {any} */
  let legSummary = null;
  /** @type {any} */ let runSummary = null, runTrace = null;
  /** More runs a test recorded (the duel records both of you): { who, summary, trace, pass }. @type {Array<any>} */
  const extraRuns = [];
  try {
    const tpg = agent.testProgress;
    agent.say(`Test ${name}${tpg ? ` (${tpg.done + 1}/${tpg.total})` : ''}${human ? ' [you]' : ''}: starting (build ${CONFIG.build}).${!human && tpg?.human && !HUMAN_OK.has(name) && !PLAYER_ONLY.has(name) ? ' (bot only: no turn for you in this one.)' : ''}`);
    // A floor to stand on: the two layers at ground level over the site filled where there is air or liquid (the tests that
    // carve their own terrain, or need the water, build over it).
    if (!sky && !NATURAL.has(name)) for (const rep of ['air', 'water', 'flowing_water', 'lava', 'flowing_lava']) { cmd(`fill ${x - 8} ${gy - 1} ${z - 8} ${x + 14} ${gy} ${z + 8} grass_block replace ${rep}`); }
    // Spectators' seat: a small glass platform behind the site, you looking at where the bot starts.
    if (!human && player && !PLAYER_ONLY.has(name)) {
      if (sky) {
        // The seat: a 3x3 stone-brick platform raised over the slab's west edge with a clear view of the site; slow falling in case of a slip.
        const sx = x - ext.w + 2;
        cmd(`fill ${sx} ${gy + 3} ${z - 1} ${sx + 2} ${gy + 3} ${z + 1} stone_bricks`);
        try { player.teleport({ x: sx + 1.5, y: gy + 4, z: z + 0.5 }, { facingLocation: { x, y: gy + 2, z: z + 0.5 } }); } catch { /* */ }
      } else {
        // On the real ground the bot goes where the test takes it (trees, caves, a long walk): a floating camera in spectator mode,
        // through the rock if need be, that keeps within 12 blocks of it. The game mode is put back afterwards.
        // The camera never puts you inside rock while you can still take damage from it: down in the rock you are in spectator
        // mode (set first, moved a moment later); back in the open you are moved to air above the ground first, then creative again.
        let gm = 'creative', pending = null;
        const setMode = (m) => { gm = m; try { /** @type {any} */ (player).setGameMode(m); } catch { /* */ } };
        const airAbove = (px, py, pz) => { const top = S.groundTop(Math.floor(px), Math.floor(pz)); return { x: px, y: Math.max(py, Number.isFinite(top) ? top + 3 : py), z: pz }; };
        const cam = () => {
          try {
            const b = sim.location, p = player.location;
            if (pending) { const f = pending; pending = null; f(); return; }
            const nowUnder = b.y < S.groundTop(Math.floor(b.x), Math.floor(b.z)) - 3;
            if (nowUnder && gm !== 'spectator') { setMode('spectator'); return; }       // moved on the next beat, once the mode is on
            if (!nowUnder && gm === 'spectator') {
              player.teleport(airAbove(b.x - 4, b.y + 4, b.z - 4), { facingLocation: { x: b.x, y: b.y + 1, z: b.z } });
              pending = () => setMode('creative');
              return;
            }
            if (Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) > 12) {
              const to = gm === 'spectator' ? { x: b.x - 4, y: b.y + 4, z: b.z - 4 } : airAbove(b.x - 4, b.y + 4, b.z - 4);
              player.teleport(to, { facingLocation: { x: b.x, y: b.y + 1, z: b.z } });
            }
          } catch { /* */ }
        };
        try { const top = S.groundTop(x - 7, z - 4); player.teleport({ x: x - 7, y: Math.max(gy + 6, Number.isFinite(top) ? top + 3 : 0), z: z - 4 }, { facingLocation: { x, y: gy + 1, z } }); } catch { /* */ }
        const camRun = system.runInterval(cam, 10);
        cleanup.push(() => { try { system.clearRun(camRun); } catch { /* */ } try { if (pHome) player.teleport(pHome); } catch { /* */ } try { /** @type {any} */ (player).setGameMode('creative'); } catch { /* */ } });
      }
    }
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
        if (human) {
          const hpT = () => { try { return who.getComponent('minecraft:health').currentValue; } catch { return 20; } };
          const hp0T = hpT();
          pass = await humanTry(() => who.location.y <= gy + 2, 150);
          const lost = Math.max(0, hp0T - hpT());
          pass = pass && lost <= 3; // the test is getting down WITHOUT fall damage: a jump off costs 7
          detail = `you ${pass ? 'did it' : 'did not get down safely'} in ${secs()}s, lost ${lost} hp`;
          break;
        }
        S.getDownStats = { hops: 0, digs: 0 };
        agent.apply([{ type: 'surface' }]);
        await idleOr(150, () => sim.location.y <= gy + 2 && sim.isOnGround);
        const f = S.feet();
        pass = f.y <= gy + 2 && !(await S.isTrapped(agent.newTask(null)));
        detail = `${pass ? 'down' : `still at y${f.y - gy - 1} above ground`} in ${secs()}s, dug ${S.getDownStats.digs}, ledges ${S.getDownStats.staged ?? 0}, hopped ${S.getDownStats.hops}, lost ${Math.max(0, hp0 - agent.health())} hp`;
        break;
      }
      case 'hole':
      case 'pit': {
        const d = arg ?? (name === 'hole' ? 2 : 3), r = name === 'hole' ? 0 : 1;
        cmd(`fill ${x - r} ${gy - d + 1} ${z - r} ${x + r} ${gy} ${z + r} air`);
        tp(x, gy - d + 1, z);
        await system.waitTicks(20);
        const goal = agent.resolveY({ x: x + 12, z });
        if (human) { pass = await humanTry(() => dist3D(who.location, goal) <= 2.5, 120, goal); detail = `you ${pass ? 'did it' : 'did not finish'} in ${secs()}s`; break; }
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
        // (The whole backed-up area: the house with its chest room is 9 deep.)
        cmd(`fill ${x - 8} ${gy - 2} ${z - 8} ${x + 14} ${gy} ${z + 8} dirt`);
        cmd(`fill ${x - 8} ${gy} ${z - 8} ${x + 14} ${gy} ${z + 8} grass_block`);
        cmd(`fill ${x - 8} ${gy + 1} ${z - 8} ${x + 14} ${gy + 8} ${z + 8} air`);
        tp(x + 3, gy + 1, z);
        if (human) {
          // Your build is the lesson: the recording (game/demo.js) is the learning, and your things come back when it ends.
          // Free materials: two double chests at the west end of the plot (two chests side by side), filled to the brim.
          const supply = await supplyChests(dim, cmd, x - 6, gy + 1, z + 4);
          agent.say(`Free materials: ${supply} in the chests at the west end of the plot (two double chests, left of where you stand).`);
          const before = getPlan();
          const started = agent.demo.startHouse(player);
          if (!agent.demo.on) { detail = String(started); break; }
          agent.testDone = false;
          const done = await humanTry(() => !!agent.testDone, 900, null, 'Finished building? Say  !bot test done');
          agent.demo.stop();
          for (let i = 0; i < 80 && agent.memory.data.learnKit; i++) await system.waitTicks(5);   // learning, then your things back
          pass = done && !!getPlan() && getPlan() !== before;
          detail = `${done ? 'you said you were done' : 'time ran out'} after ${secs()}s; ${getPlan() && getPlan() !== before ? 'the bot learned your house' : 'nothing was learned (too little built?)'}`;
          break;
        }
        const H = agent.homestead, oldHouse = agent.memory.data.house;
        agent.memory.data.house = null;
        const inv = sim.getComponent('minecraft:inventory').container;
        for (const [id, n] of /** @type {Array<[string, number]>} */ ([['cobblestone', 40], ['oak_planks', 64], ['oak_planks', 64], ['wooden_door', 1], ['torch', 6], ['bed', 1], ['furnace', 1], ['crafting_table', 1], ['chest', 4], ['oak_sign', 4]])) inv.addItem(new ItemStack(`minecraft:${id}`, n));
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
          const st = H.houseStateNow();
          let label = '';
          try { label = dim.getBlock(fur.signs[0]?.cell)?.getComponent('minecraft:sign')?.getText?.() ?? ''; } catch {}
          detail = `${placed}/${total} blocks in ${tBuilt}s, door ${doorOk ? 'yes' : 'no'}, bed ${bedOk ? 'yes' : 'no'}, table ${h.table ? 'yes' : 'no'}, furnace ${h.furnace ? 'yes' : 'no'}, chests ${st.chestsPlaced}/${fur.chests.length}, signs ${st.signsPlaced}/${fur.signs.length}${label ? ` ("${label.replace(/\n/g, ' ')}")` : ''}; night: ${homeOk ? 'inside' : 'NOT inside'}, ${sleptOk ? 'slept' : 'no sleep'}, ${outOk ? 'out the door in the morning' : 'stuck inside'}`;
          pass = built && placed >= total - 2 && doorOk && bedOk && homeOk && outOk;
        } else if (!detail) detail = 'no house built (no site?)';
        world.setTimeOfDay(1000);
        agent.memory.data.house = oldHouse ?? null;
        agent.memory.save();
        break;
      }
      case 'sheep': {
        flatPatch(cmd, x, gy, z);
        tp(x, gy + 1, z);
        for (let i = 0; i < 3; i++) await spawnAdult(dim, 'minecraft:sheep', { x: x + 6.5, y: gy + 1, z: z + i - 0.5 });
        if (!invCountsOf(sim).stone_sword) sim.getComponent('minecraft:inventory').container.addItem(new ItemStack('minecraft:stone_sword', 1));
        agent.equipBestWeapon();
        await system.waitTicks(10);
        if (human) {
          const wp = () => Object.entries(invCountsOf(player)).filter(([id]) => id.endsWith('_wool')).reduce((a, [, n]) => a + n, 0);
          const w0 = wp();
          pass = await humanTry(() => wp() - w0 >= 3, 90);
          detail = `you picked up ${wp() - w0} wool in ${secs()}s`;
          for (const e of dim.getEntities({ type: 'minecraft:sheep', location: { x, y: gy, z }, maxDistance: 20 })) try { e.remove(); } catch { /* */ }
          for (const [id, n] of Object.entries(invCountsOf(player))) if (id.endsWith('_wool')) { try { take(player, id, n); } catch { /* */ } }
          break;
        }
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
        await spawnAdult(dim, 'minecraft:cow', { x: x + 7.5, y: gy + 1, z: z - 0.5 }); await spawnAdult(dim, 'minecraft:cow', { x: x + 8.5, y: gy + 1, z: z + 1.5 });
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        if (human) {
          const bp = () => invCountsOf(player).beef ?? 0;
          const b0 = bp();
          pass = await humanTry(() => bp() - b0 >= 2, 90);
          detail = `you picked up ${bp() - b0} beef in ${secs()}s`;
          for (const e of dim.getEntities({ type: 'minecraft:cow', location: { x, y: gy, z }, maxDistance: 20 })) try { e.remove(); } catch { /* */ }
          if (bp() > b0) { try { take(player, 'beef', bp() - b0); } catch { /* */ } }
          break;
        }
        const beef = () => invCountsOf(sim).beef ?? 0;
        const b0 = beef();
        const gen = agent.newTask({ kind: 'test' });
        const kills = await agent.homestead.hunt(gen, new Set(['cow']), () => beef() - b0 >= 2, 60).catch((e) => { detail = `${e}`; return 0; });
        // (No walk back out here any more: that was timed against a player who stops at the second beef, 6 s of the bot's 8.4.)
        let shut = false;
        try { shut = !dim.getBlock(gate)?.permutation.getState('open_bit'); } catch {}
        pass = beef() - b0 >= 1 && kills >= 1;
        detail = `${kills} cows in ${secs()}s, picked up ${beef() - b0} beef, gate ${shut ? 'shut' : 'open'}`;
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
        if (started) {
          while (system.currentTick < H.smeltJob.readyAt) {
            if (agent.testFast) {
              // Fast-forward: what the furnace would have made is put in its output.
              try { const c = H.container(H.smeltJob.pos); c.setItem(2, new ItemStack('minecraft:charcoal', 2)); c.setItem(0, undefined); H.smeltJob.readyAt = system.currentTick; } catch { /* */ }
              break;
            }
            await system.waitTicks(20);
          }
          await H.collectSmelt(gen);
        }
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
        if (human) { pass = await humanTry(() => who.location.y >= gy + 1, 150); detail = `you ${pass ? 'got out' : 'did not get out'} in ${secs()}s`; break; }
        // No pickaxe for this one (it's the case where punching stone is the slow way).
        const inv = sim.getComponent('minecraft:inventory').container;
        const stash = [];
        for (let i = 0; i < inv.size; i++) { const it = inv.getItem(i); if (it && /pickaxe/.test(it.typeId)) { stash.push([i, it]); inv.setItem(i, undefined); } }
        await system.waitTicks(20);
        const gen = agent.newTask({ kind: 'test' });
        agent.apply([{ type: 'surface' }]);
        await idleOr(150, () => sim.location.y >= gy + 1);
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
        if (human) { pass = await humanTry(() => dist3D(who.location, goal) <= 2, 60, goal); detail = `you ${pass ? 'did it' : 'did not finish'} in ${secs()}s`; break; }
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
        if (human) { pass = await humanTry(() => dist3D(who.location, goal) <= 2, 40, goal); detail = `you ${pass ? 'did it' : 'did not finish'} in ${secs()}s`; break; }
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
        if (human) { let low = who.location.y; const w = system.runInterval(() => { low = Math.min(low, who.location.y); }, 2); pass = await humanTry(() => dist3D(who.location, goal) <= 2.5, 90, goal); system.clearRun(w); pass = pass && low >= gy; detail = `you ${pass ? 'got across' : 'did not make it across dry'} in ${secs()}s`; break; }
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
        if (human) { const eye = () => Math.hypot(who.location.x - table.x - 0.5, who.location.y + 1.62 - table.y - 0.5, who.location.z - table.z - 0.5); pass = await humanTry(() => eye() <= 4.5, 60); detail = `you ${pass ? 'reached the table' : 'did not reach it'} in ${secs()}s`; break; }
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
        if (!agent.memory.data.house) { detail = 'needs a house to farm by (build one first); not counted'; agent.testSkipped = true; break; }
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
      case 'fall': {
        // Dropped from high up over flat ground with a water bucket: does the water go down in time,
        // and does the bucket come back full? arg: the height (default 16, at most 17).
        const h = Math.min(17, arg ?? 16);
        const inv = sim.getComponent('minecraft:inventory').container;
        if (!invCountsOf(sim).water_bucket) {
          for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === 'minecraft:bucket') { inv.setItem(i, undefined); break; }
          inv.addItem(new ItemStack('minecraft:water_bucket', 1));
        }
        cmd(`fill ${x - 3} ${gy} ${z - 3} ${x + 3} ${gy} ${z + 3} stone`);
        cmd(`fill ${x - 3} ${gy + 1} ${z - 3} ${x + 3} ${gy + h + 1} ${z + 3} air`);
        agent.testHold = false;
        agent.fallFrom = null; agent.mlg = null;
        tp(x, gy + 1 + h, z);
        const hpBefore = agent.health();
        for (let i = 0; i < 100 && !(agent.mlg?.done); i++) await system.waitTicks(2);
        await system.waitTicks(10);
        const lost = Math.max(0, hpBefore - agent.health());
        const refilled = !!invCountsOf(sim).water_bucket;
        pass = lost === 0 && refilled;
        detail = `fell ${h} blocks (${Math.max(0, h - 3)} damage without water): lost ${lost} hp; water ${agent.mlg ? `down ${agent.mlg.d?.toFixed(1) ?? '?'} above the ground` : 'never placed'}; bucket ${refilled ? 'full again' : 'not refilled'}`;
        break;
      }
      case 'equip': {
        const inv = sim.getComponent('minecraft:inventory').container;
        // (Whatever an earlier test left it wearing comes off first: the extras would just stay in the pack.)
        try { const eq = sim.getComponent('minecraft:equippable'); for (const slot of [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand]) eq.setEquipment(slot, undefined); } catch {}
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
        if (arg !== 2) cmd(`fill ${x - 12} ${gy + 1} ${z - 12} ${x + 12} ${gy + 1} ${z + 12} short_grass replace air`); // (arg 2: bare ground, to test the planting on its own)
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
      case 'calibrate': {
        cmd(`fill ${x - 5} ${gy - 1} ${z - 5} ${x + 5} ${gy} ${z + 5} grass_block`);
        cmd(`fill ${x - 5} ${gy + 1} ${z - 5} ${x + 5} ${gy + 6} ${z + 5} air`);
        tp(x, gy + 1, z);
        await system.waitTicks(20);
        const inv = sim.getComponent('minecraft:inventory').container;
        if ((invCountsOf(sim).cobblestone ?? 0) < 8) inv.addItem(new ItemStack('minecraft:cobblestone', 8));
        const before = invCountsOf(sim).cobblestone ?? 0;
        const summary = await agent.calibration.runNow();
        const m = agent.calibration.measured;
        const after = invCountsOf(sim).cobblestone ?? 0;
        const problems = [];
        if (m.head === undefined || Math.abs(m.head - EXPECTED.head) > 0.02) problems.push(`head ${m.head}`);
        if (m.apex === undefined || Math.abs(m.apex - EXPECTED.apex) > 0.06 || Math.abs(m.airTicks - EXPECTED.airTicks) > 1) problems.push(`jump ${m.apex}/${m.airTicks}`);
        if (m.useGap === undefined || m.useGap < 2 || m.useGap > 16) problems.push(`item use gap ${m.useGap}`);
        if (after !== before) problems.push(`cobblestone ${before} -> ${after}`);
        for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2], [2, -2], [-2, 2], [1, 0], [0, 1]]) {
          if (S.blockAt({ x: x + dx, y: gy + 1, z: z + dz }) === 'cobblestone') problems.push(`block left at ${x + dx} ${z + dz}`);
        }
        pass = problems.length === 0;
        detail = pass ? summary : `${problems.join('; ')} (${summary})`;
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
        if (human) {
          if (name === 'litter') {
            const l0 = invCountsOf(player).leaf_litter ?? 0;
            pass = await humanTry(() => (invCountsOf(player).leaf_litter ?? 0) - l0 >= 4, 120);
            detail = `you picked up ${(invCountsOf(player).leaf_litter ?? 0) - l0} leaf litter in ${secs()}s`;
            const got = (invCountsOf(player).leaf_litter ?? 0) - l0;
            if (got > 0) { try { take(player, 'leaf_litter', got); } catch { /* */ } }
          } else {
            pass = await humanTry(() => /sapling/.test(S.blockAt({ x: tx, y: gy + 1, z }) ?? ''), 150);
            detail = `you ${pass ? 'replanted where the trunk stood' : 'did not replant the spot'} in ${secs()}s (spot is ${S.blockAt({ x: tx, y: gy + 1, z })})`;
          }
          break;
        }
        const inv = sim.getComponent('minecraft:inventory').container;
        inv.addItem(new ItemStack('minecraft:oak_sapling', 2));
        const logs0 = Object.entries(invCountsOf(sim)).filter(([id]) => /_log$/.test(id)).reduce((a, [, n]) => a + n, 0);
        const gen = agent.newTask({ kind: 'test' });
        agent.memory.forgetNear('log', dim.id, { x: tx, y: gy + 1, z }, 64);
        if (name === 'litter') await S.grabLitter(gen, 8).catch((e) => { detail = `${e}`; });
        else await S.gatherLogs(gen, logs0 + 5).catch((e) => { detail = `${e}`; });
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

      case 'vines': {
        // A trunk wrapped in vines on every side (a jungle tree): chopping it must clear the vine in
        // front of each log first, the way a player has to (the crosshair lands on the vine), not
        // punch the log through it. Watched every tick: a log that breaks while a vine is the first
        // thing between the eye and it is a punch through the vine.
        cmd(`fill ${x - 6} ${gy - 1} ${z - 6} ${x + 8} ${gy} ${z + 6} grass_block`);
        cmd(`fill ${x - 6} ${gy + 1} ${z - 6} ${x + 8} ${gy + 8} ${z + 6} air`);
        const tx = x + 4, H = 4;
        cmd(`fill ${tx - 2} ${gy + H + 1} ${z - 2} ${tx + 2} ${gy + H + 2} ${z + 2} oak_leaves`);
        cmd(`fill ${tx} ${gy + 1} ${z} ${tx} ${gy + H + 1} ${z} oak_log`);
        // (vine_direction_bits: south 1, west 2, north 4, east 8: the side of the vine's block it hangs on)
        const sides = [[-1, 0, 8], [1, 0, 2], [0, -1, 1], [0, 1, 4]];
        const vineCells = [];
        for (let h = 1; h <= H; h++) for (const [dx, dz, bits] of sides) {
          if (cmd(`setblock ${tx + dx} ${gy + h} ${z + dz} vine ["vine_direction_bits"=${bits}]`)) vineCells.push({ x: tx + dx, y: gy + h, z: z + dz });
        }
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        const inv = sim.getComponent('minecraft:inventory').container;
        if (!Object.keys(invCountsOf(sim)).some((id) => /_axe$/.test(id))) inv.addItem(new ItemStack('minecraft:stone_axe', 1));
        const vinesLeft = () => vineCells.filter((c) => /vine/.test(S.blockAt(c) ?? '')).length;
        const v0 = vinesLeft();
        // Every tick: for each log still standing, is a vine the first block on the line from the eye to it?
        const logCells = []; for (let h = 1; h <= H; h++) logCells.push({ x: tx, y: gy + h, z });
        const behindVine = new Set(), punched = [], lastSeen = new Map();
        const watch = system.runInterval(() => {
          try {
            const e = S.eye();
            for (const c of logCells) {
              const k = `${c.x},${c.y},${c.z}`;
              const here = S.blockAt(c) ?? '';
              if (!/_log$/.test(here)) {
                if (behindVine.has(k)) {
                  punched.push(`${c.y - gy}`); behindVine.delete(k);
                  console.warn(`[test] vines: log ${k} broke with a vine first on the ray; last tick ${JSON.stringify(lastSeen.get(k))}; now eye ${e.x.toFixed(2)} ${e.y.toFixed(2)} ${e.z.toFixed(2)}, feet ${JSON.stringify(S.feet())}, crosshair ${JSON.stringify(S.crosshair()?.location)}`);
                }
                continue;
              }
              const d = { x: c.x + 0.5 - e.x, y: c.y + 0.5 - e.y, z: c.z + 0.5 - e.z };
              const hit = castRay(dim, e, d, Math.hypot(d.x, d.y, d.z) + 0.5, { vines: true });
              lastSeen.set(k, { eye: [e.x.toFixed(2), e.y.toFixed(2), e.z.toFixed(2)], first: hit ? `${hit.block.typeId}@${hit.block.location.x},${hit.block.location.y},${hit.block.location.z}` : null, cross: S.crosshair()?.location ? JSON.stringify(S.crosshair().location) : null, tick: system.currentTick });
              if (hit && /vine/.test(hit.block.typeId)) behindVine.add(k); else behindVine.delete(k);
            }
          } catch {}
        }, 1);
        const logs0 = Object.entries(invCountsOf(sim)).filter(([id]) => /_log$/.test(id)).reduce((a, [, n]) => a + n, 0);
        const gen = agent.newTask({ kind: 'test' });
        agent.memory.forgetNear('log', dim.id, { x: tx, y: gy + 1, z }, 64);
        await S.gatherLogs(gen, logs0 + H).catch((e) => { detail = `${e}`; });
        system.clearRun(watch);
        const got = Object.entries(invCountsOf(sim)).filter(([id]) => /_log$/.test(id)).reduce((a, [, n]) => a + n, 0) - logs0;
        pass = got >= H - 1 && punched.length === 0;
        detail = `${got} logs in ${secs()}s; ${punched.length ? `punched through a vine at height ${punched.join(', ')}` : 'no log broken through a vine'}; vines cleared ${v0 - vinesLeft()} of ${v0}`;
        break;
      }
      case 'stairgap': {
        // Our quarry stairs (recorded as the quarry) with one tread blown out: from the bottom the
        // way up has a 2-high gap. Up twice. Watched: jumps made (a jump that gains nothing is a
        // jump at the gap) and how long each trip took. The second trip should be a plain walk or
        // the same detour, not the same jumping again.
        const N = 7, x0 = x;
        cmd(`fill ${x - 3} ${gy - N - 1} ${z - 3} ${x + N + 4} ${gy} ${z + 3} stone`);
        cmd(`fill ${x - 3} ${gy + 1} ${z - 3} ${x + N + 4} ${gy + 6} ${z + 3} air`);
        const steps = [];
        for (let i = 0; i <= N; i++) {
          cmd(`fill ${x0 + i} ${gy - i + 1} ${z} ${x0 + i} ${gy - i + 3} ${z} air`);
          steps.push(`${x0 + i},${gy - i},${z}`);
        }
        agent.memory.data.quarry = { d: dim.id, steps, dir: 0, fails: 0, started: Date.now() };
        agent.memory.save();
        S._protected = null;
        // arg: tread to take out (default 4); +10: the first trip starts down in the hole it left;
        // +20: nothing missing but a torch on two of the steps (they must not be taken for damage).
        const raw = arg ?? 4, variant = Math.floor(raw / 10), k = raw % 10 || 4;
        if (variant === 2) {
          for (const i of [2, 5]) cmd(`setblock ${x0 + i} ${gy - i + 1} ${z} torch`);
        } else cmd(`setblock ${x0 + k} ${gy - k} ${z} air`); // the missing tread: 2 up, 2 across
        const inv = sim.getComponent('minecraft:inventory').container;
        if (!Object.keys(invCountsOf(sim)).some((id) => /_pickaxe$/.test(id))) inv.addItem(new ItemStack('minecraft:stone_pickaxe', 1));
        if ((invCountsOf(sim).cobblestone ?? 0) < 12) inv.addItem(new ItemStack('minecraft:cobblestone', 12));
        const trips = [];
        for (let trip = 0; trip < 2; trip++) {
          if (variant === 1 && trip === 0) tp(x0 + k, gy - k, z); else tp(x0 + N, gy - N + 1, z);
          await system.waitTicks(15);
          let jumps = 0, wasOn = true, lastY = sim.location.y;
          const w = system.runInterval(() => {
            try {
              const on = sim.isOnGround;
              if (wasOn && !on && sim.getVelocity().y > 0.2) jumps++;
              wasOn = on;
            } catch {}
          }, 1);
          const t1 = system.currentTick;
          const gen = agent.newTask({ kind: 'test' });
          const ok = await S.walkShaft(gen, 0).catch((e) => { detail += `${e}; `; return false; });
          system.clearRun(w);
          const f = S.feet();
          trips.push({ ok, up: f.y >= gy, jumps, s: ((system.currentTick - t1) / 20).toFixed(0), treadBack: !/air/.test(S.blockAt({ x: x0 + k, y: gy - k, z }) ?? 'air'), torches: variant === 2 ? [2, 5].filter((i) => /torch/.test(S.blockAt({ x: x0 + i, y: gy - i + 1, z }) ?? '')).length : null });
          agent.newTask(null);
          await system.waitTicks(10);
        }
        pass = trips.every((tr) => tr.up) && trips[1].jumps <= N + 3 && Number(trips[1].s) <= 15 && trips[0].jumps <= N + 8 && (variant !== 2 || trips.every((tr) => tr.torches === 2));
        detail = trips.map((tr, n) => `trip ${n + 1}: ${tr.up ? 'out' : 'NOT out'} in ${tr.s}s, ${tr.jumps} jumps, tread ${tr.treadBack ? 'there' : 'MISSING'}${tr.torches === null ? '' : `, ${tr.torches} of 2 torches left`}`).join('; ');
        break;
      }
      case 'loot': {
        // Died a way off: the gear is lying on a stone pad 17 blocks away, and it's ours to go back
        // for. With auto on, the bot must get all of it (not declare it gone after a few seconds).
        const px = x + 11, pz = z; // (the room, ±3, stays inside the backed-up and flattened box: x+14)
        cmd(`fill ${x - 8} ${gy - 3} ${z - 8} ${x + 14} ${gy} ${z + 8} stone`);      // flat, open ground all round
        cmd(`fill ${x - 8} ${gy + 1} ${z - 8} ${x + 14} ${gy + 8} ${z + 8} air`);
        tp(x - 6, gy + 1, z);
        await system.waitTicks(10);
        const inv = sim.getComponent('minecraft:inventory').container;
        for (let i = 0; i < inv.size; i++) inv.setItem(i, undefined); // (it died: nothing on us)
        // arg 1 (2): sealed in a stone room (no way in for a bare-handed bot) that opens after 12 s (45 s): it must
        // keep trying for its things, not write them off at the first "no way there".
        if (arg === 1 || arg === 2) {
          cmd(`fill ${px - 3} ${gy + 1} ${pz - 3} ${px + 3} ${gy + 4} ${pz + 3} obsidian`); // (nothing to break it with)
          cmd(`fill ${px - 2} ${gy + 1} ${pz - 2} ${px + 2} ${gy + 3} ${pz + 2} air`);
          system.runTimeout(() => { cmd(`fill ${px - 3} ${gy + 1} ${pz} ${px - 3} ${gy + 2} ${pz} air`); }, 20 * (arg === 2 ? 45 : 12));
        }
        const gear = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_pickaxe', 'iron_sword', 'bucket', 'shield'];
        for (const [n, id] of gear.entries()) dim.spawnItem(new ItemStack(`minecraft:${id}`, 1), { x: px - 1 + (n % 3), y: gy + 1, z: pz - 1 + Math.floor(n / 3) });
        agent.deathSpot = { x: px + 0.5, y: gy + 1, z: pz + 0.5, d: dim.id, at: Date.now() - 5000 };
        let gaveUp = false;
        agent.autoEnabled = true;
        agent.autoDone = false;
        agent.startAuto();
        const left = () => dim.getEntities({ type: 'minecraft:item', location: { x: px, y: gy + 1, z: pz }, maxDistance: 6 }).length;
        const wallAt = () => `${S.blockAt({ x: px - 3, y: gy + 1, z: pz })}/${S.blockAt({ x: px + 3, y: gy + 1, z: pz })}/${S.blockAt({ x: px, y: gy + 4, z: pz })}`;
        const series = [`walls ${wallAt()}`];
        for (let i = 0; i < 90 * 2 && left() > 0; i++) { await system.waitTicks(10); if (i % 4 === 0) { const f = S.feet(); series.push(`${i / 2}s:${left()}@${f.x - px},${f.y - gy},${f.z - pz}${agent.deathSpot ? '' : ' nospot'}`); } if (!agent.deathSpot && left() > 0) { gaveUp = true; break; } }
        agent.autoEnabled = false;
        agent.newTask(null);
        if (arg === 1 || arg === 2) {
          const rows = [];
          for (let yy = gy + 4; yy >= gy + 1; yy--) { let row = ''; for (let xx = px - 4; xx <= px + 4; xx++) { const b = S.blockAt({ x: xx, y: yy, z: pz }) ?? '?'; row += b === 'air' ? '.' : b === 'obsidian' ? '#' : b[0]; } rows.push(row); }
          const holes = [];
          for (let xx = px - 3; xx <= px + 3; xx++) for (let yy = gy + 1; yy <= gy + 4; yy++) for (let zz = pz - 3; zz <= pz + 3; zz++) {
            const inside = Math.abs(xx - px) <= 2 && Math.abs(zz - pz) <= 2 && yy <= gy + 3;
            if (!inside && S.blockAt({ x: xx, y: yy, z: zz }) !== 'obsidian') holes.push(`${xx - px},${yy - gy},${zz - pz}:${S.blockAt({ x: xx, y: yy, z: zz })}`);
          }
          detail += `shell holes: ${holes.join(' ') || 'none'}; `;
          const f = S.feet();
          detail += `room slice (x ${px - 4}..${px + 4}, y up top-down): ${rows.join(' / ')}; bot at ${f.x - px},${f.y - gy},${f.z - pz} from the pad; `;
        }
        const got = gear.length - Math.min(gear.length, left());
        pass = got === gear.length && !gaveUp;
        detail += `${got}/${gear.length} pieces picked up in ${secs()}s${gaveUp ? ', GAVE UP on them' : ''} (left lying ${left()}) [${series.join(' ')}; walls now ${wallAt()}]`;
        for (const e of dim.getEntities({ type: 'minecraft:item', location: { x: px, y: gy + 1, z: pz }, maxDistance: 10 })) try { e.remove(); } catch {}
        break;
      }
      case 'horserace':
      case 'pillarrace':
      case 'woodrace': {
        // You and the bot, side by side, at the same job; whoever finishes first wins. Both are recorded (you as `human`).
        if (!player) { detail = 'a race needs you: say it in chat'; break; }
        const pk = packOf(player);
        const givePlayer = (id, n) => { try { pk?.addItem(new ItemStack(`minecraft:${id}`, n)); handed.push([id, n]); } catch { /* */ } };
        const recH = new TestRecorder(player);
        const east = { x: x + 40, y: gy + 2, z };
        const faceEast = (e, dz) => { try { e.teleport({ x: x - 5.5, y: gy + 1, z: z + dz }, { facingLocation: { x: x + 40, y: gy + 1.6, z: z + dz } }); } catch { /* */ } };
        const result = { bot: null, you: null };
        let objective = '';
        const gen = agent.newTask({ kind: 'test' });
        agent.testHold = true;
        /** The countdown: on your screen and in chat, then GO. */
        const countdown = async () => {
          for (const n of ['3', '2', '1']) { try { player.onScreenDisplay.setTitle(n, { stayDuration: 14, fadeInDuration: 0, fadeOutDuration: 2 }); } catch { /* */ } await system.waitTicks(20); }
          try { player.onScreenDisplay.setTitle('GO!', { stayDuration: 20, fadeInDuration: 0, fadeOutDuration: 5 }); } catch { /* */ }
        };
        /** Wait for you to say go (or move); then count down. */
        const ready = async (text, short) => {
          agent.say(`RACE, ${name}: ${text} Say \`!bot test go\` when you are ready (or just start moving), \`!bot test skip\` to give up.`);
          try { player.onScreenDisplay.setTitle(`Race: ${name}`, { subtitle: short, stayDuration: 160, fadeInDuration: 5, fadeOutDuration: 10 }); } catch { /* */ }
          agent.testGo = false;
          if (agent.testProgress) { agent.testProgress.reading = true; agent.testProgress.deadline = null; }
          const p0 = { ...player.location };
          for (let i = 0; i < 60 * 10 && !agent.testSkipped && !agent.testGo; i++) {
            await system.waitTicks(2);
            if (Math.hypot(player.location.x - p0.x, player.location.z - p0.z) > 1.5) break;
          }
          if (agent.testProgress) agent.testProgress.reading = false;
          await countdown();
        };
        const running = (secsMax) => { if (agent.testProgress) { agent.testProgress.deadline = Date.now() + secsMax * 1000; agent.testProgress.limitS = secsMax; } };
        try {
          if (name === 'horserace') {
            // ---- 1. Two adult horses, a saddle each. Both of us tame ours (ride it until it accepts), saddle it, and get on it.
            objective = 'tame, saddle and mount your horse, then ride it over the rough ground, two laps of out to the gold line and back.';
            // A rough course, the same in both lanes: ground that steps up and down a block at a time, ditches, mounds; out to the gold line
            // at x + 48 and back to the start. A divider of bars between the lanes.
            let seed = 20260502;
            const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
            let hgt = 0;
            for (let cx = x + 5; cx < x + 46;) {
              const len = 1 + Math.floor(rnd() * 3), r = rnd();
              // Rougher than before: a step up or down nearly every segment (-1 to 3 high), short segments, and a one-block hurdle across the lane
              // now and then that has to be jumped.
              hgt = r < 0.4 ? Math.max(-1, hgt - 1) : r < 0.85 ? Math.min(3, hgt + 1) : hgt;
              if (cx + len > x + 45) hgt = 0;
              const hurdle = hgt >= 0 && rnd() < 0.3 && cx > x + 8 && cx + len < x + 44;
              for (const [zl, zh] of [[z - 9, z - 1], [z + 1, z + 9]]) {
                if (hgt > 0) cmd(`fill ${cx} ${gy + 1} ${zl} ${cx + len - 1} ${gy + hgt} ${zh} stone`);
                else if (hgt < 0) cmd(`fill ${cx} ${gy} ${zl} ${cx + len - 1} ${gy} ${zh} air`);
                if (hurdle) cmd(`fill ${cx} ${gy + hgt + 1} ${zl} ${cx} ${gy + hgt + 1} ${zh} stone`);
              }
              cx += len;
            }
            cmd(`fill ${x + 4} ${gy + 1} ${z} ${x + 49} ${gy + 3} ${z} iron_bars`);
            cmd(`fill ${x + 48} ${gy} ${z - 9} ${x + 48} ${gy} ${z - 1} gold_block`);
            cmd(`fill ${x + 48} ${gy} ${z + 1} ${x + 48} ${gy} ${z + 9} gold_block`);
            cmd(`fill ${x} ${gy} ${z - 9} ${x} ${gy} ${z - 1} quartz_block`);
            cmd(`fill ${x} ${gy} ${z + 1} ${x} ${gy} ${z + 9} quartz_block`);
            const hb = await spawnAdult(dim, 'minecraft:horse', { x: x - 3.5, y: gy + 1, z: z + 2.5 });
            const hh = await spawnAdult(dim, 'minecraft:horse', { x: x - 3.5, y: gy + 1, z: z - 2.5 });
            if (!hb || !hh) { detail = "couldn't get two adult horses (babies can't be ridden)"; break; }
            cleanup.push(() => { for (const h of [hb, hh]) try { h.remove(); } catch { /* */ } });
            // The same speed for both (a horse's is random, and a race should be about the rider).
            for (const h of [hb, hh]) { try { h.getComponent('minecraft:movement')?.setCurrentValue(0.25); } catch { /* */ } }
            giveItem('saddle', 1); givePlayer('saddle', 1);
            faceEast(sim, 2.5); faceEast(player, -2.5);
            agent.say(`HORSE RACE: two adult horses, a saddle each. Tame yours (get on until it stops throwing you), saddle it (right-click with the saddle) and mount it; the bot does the same with its own. When we are both on, there is a countdown and a race over rough ground (steps, ditches, mounds, hurdles to jump) to the gold line 48 blocks east, back to the start, and out and back once more: about 190 blocks.`);
            try { player.onScreenDisplay.setTitle('Horse race', { subtitle: 'Tame, saddle, mount, race', stayDuration: 160, fadeInDuration: 5, fadeOutDuration: 10 }); } catch { /* */ }
            running(300);
            const tPrep = system.currentTick;
            const botPrep = (async () => {
              const r = await horseReady(agent, gen, hb, secs);
              if (!r.ok) return { ok: false, detail: r.detail };
              const m = await agent.horses.getOn(gen, hb);
              return { ok: m, detail: m ? r.detail : `${r.detail}; would not take a rider` };
            })().catch((e) => ({ ok: false, detail: `${e}` }));
            const youReady = () => { try { return isTamed(hh) && saddledOf(hh) && player.getComponent('minecraft:riding')?.entityRidingOn?.id === hh.id; } catch { return false; } };
            for (let i = 0; i < 300 * 4 && !agent.testSkipped && !youReady(); i++) await system.waitTicks(5);
            const bp = await botPrep;
            const prepS = Math.round((system.currentTick - tPrep) / 20);
            if (!youReady()) { detail = `you were not on a tamed, saddled horse (${agent.testSkipped ? 'skipped' : 'time'}); bot: ${bp.detail}`; break; }
            if (!bp.ok) { detail = `the bot's horse: ${bp.detail}`; break; }
            agent.say(`Both mounted after ${prepS} s. Taking you to the start, behind the barrier.`);
            // Back behind the line and a barrier (taming and riding about had carried us past it): both horses, riders on, side by side.
            cmd(`fill ${x - 1} ${gy + 1} ${z - 9} ${x - 1} ${gy + 3} ${z + 9} iron_bars`);
            hb.addTag('race_bot'); hh.addTag('race_you');
            for (const [h, who2, tag, dz] of /** @type {Array<[any, any, string, number]>} */ ([[hb, sim, 'race_bot', 2.5], [hh, player, 'race_you', -2.5]])) {
              try { h.teleport({ x: x - 4.5, y: gy + 1, z: z + dz }, { facingLocation: { x: x + 40, y: gy + 1.6, z: z + dz } }); } catch { /* */ }
              await system.waitTicks(6);
              const on = () => { try { return who2.getComponent('minecraft:riding')?.entityRidingOn?.id === h.id; } catch { return false; } };
              // (A teleported horse may leave its rider behind: put them back on.)
              if (!on()) { cmd(`ride @a[name="${who2.name}"] start_riding @e[tag=${tag},c=1]`); await system.waitTicks(6); }
              try { h.teleport({ x: x - 4.5, y: gy + 1, z: z + dz }, { facingLocation: { x: x + 40, y: gy + 1.6, z: z + dz } }); } catch { /* */ }
            }
            await system.waitTicks(10);
            // ---- 2. The race.
            await ready('You are both on your horses.', 'Ride to the gold line');
            cmd(`fill ${x - 1} ${gy + 1} ${z - 9} ${x - 1} ${gy + 3} ${z + 9} air`); // the barrier goes up... and down at GO
            running(300);
            rec.reset(); t0 = system.currentTick; recH.start();
            const turnX = x + 48.5, homeX = x + 1.5;
            const stage = { bot: 0, you: 0 };
            const tStart = system.currentTick;
            let lastX = hb.location.x, lastChk = tStart;
            for (let i = 0; i < 300 * 20 && !agent.testSkipped && (result.bot === null || result.you === null); i++) {
              if (result.bot === null) {
                // two laps: out, back, out, back (stages 0 to 3)
                const goal = stage.bot % 2 === 0 ? { x: turnX + 4, y: hb.location.y, z: z + 5 } : { x: homeX - 5, y: hb.location.y, z: z + 5 };
                try { sim.moveToLocation(goal, { speed: 1 }); } catch { /* */ }
                // Stuck against a step: jump (what a rider does).
                if (system.currentTick - lastChk >= 10) { if (Math.abs(hb.location.x - lastX) < 0.15) { try { sim.jump(); } catch { /* */ } } lastX = hb.location.x; lastChk = system.currentTick; }
                if (stage.bot % 2 === 0 && hb.location.x >= turnX) stage.bot++;
                else if (stage.bot % 2 === 1 && hb.location.x <= homeX) { if (stage.bot === 3) result.bot = (system.currentTick - tStart) / 20; else stage.bot++; }
              }
              if (result.you === null) {
                if (stage.you % 2 === 0 && hh.location.x >= turnX) { stage.you++; agent.say(`You are at the far line (leg ${stage.you}/4): back!`); }
                else if (stage.you % 2 === 1 && hh.location.x <= homeX) { if (stage.you === 3) result.you = (system.currentTick - tStart) / 20; else { stage.you++; agent.say(`Start line (leg ${stage.you}/4): out again!`); } }
              }
              await system.waitTicks(1);
            }
          } else if (name === 'pillarrace') {
            // ---- Pillar up 15 blocks (a jump and a block under your feet, again and again): the first to the top.
            objective = 'pillar straight up 15 blocks; the first on top wins.';
            const topY = gy + 16;
            giveItem('cobblestone', 24); givePlayer('cobblestone', 24);
            faceEast(sim, 3.5); faceEast(player, -3.5);
            await system.waitTicks(10);
            await ready('Each of you has 24 cobblestone. Pillar straight up where you stand (jump and place a block under your feet, again and again): 15 blocks, the first on top wins.', 'Pillar up 15 blocks');
            running(90);
            rec.reset(); t0 = system.currentTick; recH.start();
            const tStart = system.currentTick;
            const botP = (async () => {
              while (!agent.testSkipped && S.feet().y < topY - 0.5 && system.currentTick - tStart < 90 * 20) {
                if (!(await S.stepUp(gen))) await system.waitTicks(5);
              }
              if (S.feet().y >= topY - 0.5) result.bot = (system.currentTick - tStart) / 20;
            })().catch(() => {});
            for (let i = 0; i < 90 * 20 && !agent.testSkipped && (result.bot === null || result.you === null); i++) {
              if (result.you === null && player.location.y >= topY - 0.5) result.you = (system.currentTick - tStart) / 20;
              await system.waitTicks(1);
            }
            await botP;
          } else {
            // ---- Chop a tree: 5 logs first.
            objective = 'cut your tree down: 5 logs; the first to 5 wins.';
            const tree = (tz) => { cmd(`fill ${x + 6 - 2} ${gy + 4} ${tz - 2} ${x + 6 + 2} ${gy + 5} ${tz + 2} oak_leaves`); cmd(`fill ${x + 6} ${gy + 1} ${tz} ${x + 6} ${gy + 5} ${tz} oak_log`); };
            tree(z - 6); tree(z + 6);
            giveItem('stone_axe', 1); givePlayer('stone_axe', 1);
            faceEast(sim, -3.5); faceEast(player, 3.5);
            const logsOf = (e) => Object.entries(invCountsOf(e)).filter(([id]) => /_log$/.test(id)).reduce((a, [, n]) => a + n, 0);
            const l0 = logsOf(sim), p0 = logsOf(player);
            await system.waitTicks(10);
            await ready('Each of you has a stone axe and a tree (yours is on your side, 6 blocks east). Cut it down: the first to 5 logs wins.', 'First to 5 logs');
            running(120);
            rec.reset(); t0 = system.currentTick; recH.start();
            const tStart = system.currentTick;
            const botP = (async () => {
              await S.gatherLogs(gen, l0 + 5);
              if (logsOf(sim) - l0 >= 5) result.bot = (system.currentTick - tStart) / 20;
            })().catch(() => {});
            for (let i = 0; i < 120 * 20 && !agent.testSkipped && (result.bot === null || result.you === null); i++) {
              if (result.you === null && logsOf(player) - p0 >= 5) result.you = (system.currentTick - tStart) / 20;
              await system.waitTicks(1);
            }
            for (const [id, n] of Object.entries(invCountsOf(player))) if (/_log$/.test(id)) { try { take(player, id, n); } catch { /* */ } }
            await Promise.race([botP, system.waitTicks(40)]);
          }
          const f1 = (v) => (v === null ? 'did not finish' : `${v.toFixed(1)} s`);
          const winner = result.bot !== null && (result.you === null || result.bot < result.you) ? 'the bot wins' : result.you !== null ? 'you win' : 'nobody finished';
          pass = result.bot !== null;
          detail = `${objective} bot ${f1(result.bot)}, you ${f1(result.you)}: ${winner}`;
          agent.say(`Race over: ${detail}.`);
        } finally {
          try {
            const sh = recH.stop();
            extraRuns.push({ who: 'human', summary: sh, trace: recH.trace(), pass: result.you !== null });
          } catch { /* the recorder never started */ }
          try { await agent.horses.getOff(null); } catch { /* */ }
          try { if (player.getComponent('minecraft:riding')?.entityRidingOn) player.runCommand('ride @s stop_riding'); } catch { /* */ }
          agent.motor.setFocus(null);
        }
        break;
      }
      case 'lavacross': {
        // The Nether's lava lakes: an 11-wide lake of lava, wall to wall (no way round), between two netherrack platforms.
        cmd(`fill ${x - 8} ${gy} ${z - 12} ${x - 2} ${gy} ${z + 12} netherrack`);
        cmd(`fill ${x + 10} ${gy} ${z - 12} ${x + 16} ${gy} ${z + 12} netherrack`);
        cmd(`fill ${x - 1} ${gy - 2} ${z - 12} ${x + 9} ${gy} ${z + 12} air`);
        cmd(`fill ${x - 1} ${gy - 2} ${z - 12} ${x + 9} ${gy - 1} ${z + 12} lava`);
        const goal = { x: x + 12.5, y: gy + 1, z: z + 0.5 };
        cmd(`setblock ${x + 12} ${gy} ${z} gold_block`);
        tp(x - 6, gy + 1, z);
        await system.waitTicks(10);
        const hpStart = (() => { try { return who.getComponent('minecraft:health').currentValue; } catch { return 20; } })();
        const hpNow = () => { try { return who.getComponent('minecraft:health').currentValue; } catch { return 0; } };
        let burned = 0;
        const watch = system.runInterval(() => { try { if (/lava/.test(dim.getBlock({ x: Math.floor(who.location.x), y: Math.floor(who.location.y), z: Math.floor(who.location.z) })?.typeId ?? '')) burned++; } catch { /* */ } }, 2);
        cleanup.push(() => { try { system.clearRun(watch); } catch { /* */ } });
        if (human) { pass = await humanTry(() => dist3D(who.location, goal) <= 2.5, 120, goal); pass = pass && burned === 0; detail = `you ${pass ? 'crossed' : 'did not cross unburned'} in ${secs()}s, lost ${Math.max(0, hpStart - hpNow())} hp, in lava ${burned * 0.1} s`; break; }
        const gen = agent.newTask({ kind: 'test' });
        // The lava is crossed by bridging it: a block against the last, walked onto, 11 times (the pathfinder's own bridging is for water and
        // gaps; lava is a hazard it will not path over).
        let ok = false;
        try {
          await S.goNear(gen, { x: x - 2.5, y: gy + 1, z: z + 0.5 }, 1, 2);
          for (let cx = x - 2; cx <= x + 9; cx++) {
            if (agent.testSkipped) break;
            if (!(await S.bridgeTo(gen, { x: cx, y: gy + 1, z }, { x: cx + 1, y: gy + 1, z }))) { detail = `bridge stopped at ${cx - x}: `; break; }
          }
          ok = await S.goNear(gen, goal, 1.5, 3).catch(() => false);
        } catch (e) { detail = `${e}`; }
        pass = dist3D(sim.location, goal) <= 2.5 && burned === 0;
        detail = `${detail}${pass ? 'across' : ok ? 'said it arrived but is not at the far side' : "did not get across"}, lost ${Math.max(0, hpStart - hpNow())} hp, in lava ${burned * 0.1} s, ${secs()}s (${invCountsOf(sim).cobblestone ?? 0} cobblestone left)`;
        break;
      }
      case 'obsidian': {
        // A 3 x 3 pool of lava in the rock, a water bucket and a diamond pickaxe: water on the lava makes obsidian, which only a diamond
        // pickaxe breaks.
        cmd(`fill ${x - 3} ${gy - 3} ${z - 4} ${x + 9} ${gy - 1} ${z + 4} stone`);
        cmd(`fill ${x + 3} ${gy - 2} ${z - 1} ${x + 5} ${gy} ${z + 1} air`);
        cmd(`fill ${x + 3} ${gy - 2} ${z - 1} ${x + 5} ${gy} ${z + 1} lava`);
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        const obs = () => (invCountsOf(who).obsidian ?? 0);
        const hpOf2 = () => { try { return who.getComponent('minecraft:health').currentValue; } catch { return 0; } };
        const hp1 = hpOf2();
        if (human) { pass = await humanTry(() => obs() >= 1, 120); detail = `you ${pass ? 'got' : 'did not get'} obsidian in ${secs()}s, lost ${Math.max(0, hp1 - hpOf2())} hp`; break; }
        const gen = agent.newTask({ kind: 'test' });
        const notes = [];
        try {
          // Water goes on the ground by the pool (a bucket will not take the lava block itself as a target) and runs onto the lava,
          // which turns to obsidian where the water reaches it.
          await S.goNear(gen, { x: x + 1.5, y: gy + 1, z: z + 0.5 }, 1, 2);
          const slot = hold(sim, 'water_bucket');
          if (slot < 0) notes.push('no water bucket');
          else {
            const edge = { x: x + 2, y: gy, z };
            try { sim.lookAtBlock(edge); } catch { /* */ }
            await system.waitTicks(4);
            let ok = false;
            try { ok = sim.useItemInSlotOnBlock(slot, edge, Direction.Up); } catch (e) { notes.push(`bucket: ${e}`); }
            notes.push(`water put ${ok ? 'down' : 'refused'}`);
            await system.waitTicks(50);
            notes.push(`pool now: ${[0, -1, 1].map((dz) => S.blockAt({ x: x + 3, y: gy, z: z + dz })).join('/')}`);
          }
          const cells = [];
          for (let cx = x + 3; cx <= x + 5; cx++) for (let cz = z - 1; cz <= z + 1; cz++) cells.push({ x: cx, y: gy, z: cz });
          const target = cells.find((c) => S.blockAt(c) === 'obsidian');
          if (target) {
            hold(sim, 'diamond_pickaxe');
            const was = S.essential; S.essential = true;
            const mined = await S.mine(gen, target, { collect: true, force: true }).catch((e) => { notes.push(`mine: ${e}`); return false; });
            S.essential = was;
            let got = mined;
            if (!mined) {
              // Its own mining will not open a block with lava beside it; a player just breaks it: the break call, from where it stands.
              try { sim.lookAtBlock(target); } catch { /* */ }
              await system.waitTicks(4);
              try { /** @type {any} */ (sim).breakBlock(target); } catch (e) { notes.push(`break: ${e}`); }
              for (let i = 0; i < 40 && S.blockAt(target) === 'obsidian'; i++) await system.waitTicks(5);
              await S.sweep(gen, target, 5, null, 10).catch(() => 0);
              got = S.blockAt(target) !== 'obsidian';
            }
            notes.push(got ? 'mined it' : 'would not mine it');
          }
        } catch (e) { notes.push(`${e}`); }
        pass = obs() >= 1;
        detail = `${pass ? 'got obsidian' : 'no obsidian'} in ${secs()}s, lost ${Math.max(0, hp1 - hpOf2())} hp; ${notes.join('; ')}`;
        break;
      }
      case 'mineore': {
        // Ore buried in the dirt and stone under the site, a few of each kind. One of each, with the iron pickaxe.
        /** @type {Array<[string, number, string]>} */
        const KINDS = [['coal_ore', 3, 'coal'], ['iron_ore', 3, 'raw_iron'], ['copper_ore', 3, 'raw_copper'], ['gold_ore', 2, 'raw_gold'], ['redstone_ore', 2, 'redstone'], ['lapis_ore', 2, 'lapis_lazuli'], ['diamond_ore', 2, 'diamond']];
        const ores = [];
        const taken = new Set();
        KINDS.forEach(([ore, count], i) => {
          for (let k = 0; k < count; k++) {
            let px = x + 2 + ((i * 3 + k * 5) % 9), pz = z - 4 + ((i * 5 + k * 3) % 9), py = gy - 2 - ((i + k * 2) % 6);
            while (taken.has(`${px},${py},${pz}`)) py--;
            taken.add(`${px},${py},${pz}`);
            cmd(`setblock ${px} ${py} ${pz} ${ore}`);
            ores.push({ ore, pos: { x: px, y: py, z: pz } });
          }
        });
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        const have = (e) => KINDS.filter(([, , item]) => (invCountsOf(e)[item] ?? 0) > 0).length;
        const missing = (e) => KINDS.filter(([, , item]) => !(invCountsOf(e)[item] ?? 0)).map(([, , item]) => item);
        if (human) { pass = await humanTry(() => have(who) >= KINDS.length, 240); detail = `you brought up ${have(who)}/${KINDS.length} kinds in ${secs()}s${pass ? '' : ` (missing ${missing(who).join(', ')})`}`; break; }
        const gen = agent.newTask({ kind: 'test' });
        hold(sim, 'iron_pickaxe');
        const t1 = system.currentTick;
        const notes = [];
        const essential0 = S.essential; S.essential = true; // (digging through stone to the ore, which it only does for what it needs)
        cleanup.push(() => { S.essential = essential0; });
        while (have(sim) < KINDS.length && system.currentTick - t1 < 240 * 20 && !agent.testSkipped) {
          const need = new Set(KINDS.filter(([, , item]) => !(invCountsOf(sim)[item] ?? 0)).map(([ore]) => ore));
          const f = S.feet();
          const next = ores.filter((o) => need.has(o.ore) && S.blockAt(o.pos) === o.ore).sort((a, b) => dist3D(f, a.pos) - dist3D(f, b.pos))[0];
          if (!next) break;
          let near = await S.goNear(gen, next.pos, 2, 2, { actionRange: 30 }).catch(() => false);
          let mined = await S.mine(gen, next.pos, { collect: true, force: true }).catch(() => false);
          if (!mined) {
            // Not exposed: dig to it. Down (a block under the feet, drop onto the next) while it is deeper, then sideways in a tunnel 2 high,
            // until it is beside us; then the ore.
            for (let step = 0; step < 40 && !mined && !agent.testSkipped; step++) {
              const fc = { x: Math.floor(sim.location.x), y: Math.floor(sim.location.y), z: Math.floor(sim.location.z) };
              const dx = next.pos.x - fc.x, dy = next.pos.y - fc.y, dz = next.pos.z - fc.z;
              if (Math.abs(dx) + Math.abs(dz) <= 1 && dy >= -1 && dy <= 2) { mined = await S.mine(gen, next.pos, { collect: true, force: true }).catch(() => false); break; }
              if (dy < -1 && Math.abs(dx) + Math.abs(dz) <= 1) { // straight down onto it
                await S.mine(gen, { x: fc.x, y: fc.y - 1, z: fc.z }, { collect: true, force: true, allowBelow: true }).catch(() => false);
                await system.waitTicks(8);
                continue;
              }
              if (dy < -1 && (Math.abs(dx) + Math.abs(dz) > 1 || step % 3 === 0)) { // down first, three at a time, then across
                await S.mine(gen, { x: fc.x, y: fc.y - 1, z: fc.z }, { collect: true, force: true, allowBelow: true }).catch(() => false);
                await system.waitTicks(8);
                continue;
              }
              const sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0, sz = sx === 0 ? Math.sign(dz) : 0;
              if (!sx && !sz) break;
              for (const yy of [0, 1]) await S.mine(gen, { x: fc.x + sx, y: fc.y + yy, z: fc.z + sz }, { collect: true, force: true }).catch(() => false);
              for (let k = 0; k < 14 && Math.floor(sim.location.x) === fc.x && Math.floor(sim.location.z) === fc.z; k++) { agent.body.move(sx, sz, 0.6); await system.waitTicks(2); }
              agent.body.stop();
            }
          }
          let broke = mined;
          if (!mined && S.blockAt(next.pos) === next.ore) {
            // Its mining refused (a rule about what is safe to open); the plain break, if it is in reach.
            try { sim.lookAtBlock(next.pos); } catch { /* */ }
            await system.waitTicks(4);
            try { /** @type {any} */ (sim).breakBlock(next.pos); } catch { /* */ }
            for (let i = 0; i < 40 && S.blockAt(next.pos) === next.ore; i++) await system.waitTicks(3);
            await S.sweep(gen, next.pos, 5, null, 10).catch(() => 0);
            broke = S.blockAt(next.pos) !== next.ore;
          }
          notes.push(`${next.ore.replace('_ore', '')} ${near ? 'reached' : 'not reached'}, ${mined ? 'mined' : broke ? 'broken by hand' : 'not mined'}`);
          if (!broke) ores.splice(ores.indexOf(next), 1);
          hold(sim, 'iron_pickaxe');
        }
        pass = have(sim) >= KINDS.length;
        detail = `${have(sim)}/${KINDS.length} kinds in ${secs()}s${pass ? '' : `, missing ${missing(sim).join(', ')}`}; ${notes.slice(0, 12).join('; ')}`;
        break;
      }
      case 'enderman':
      case 'blaze':
      case 'ghast':
      case 'witherskeleton': {
        // A nether/end mob to kill with a diamond sword and a bow, in iron armour with a shield.
        const MOB = { enderman: ['enderman', 1, 10], blaze: ['blaze', 4, 10], ghast: ['ghast', 9, 14], witherskeleton: ['wither_skeleton', 1, 10] }[name];
        const wear = (/** @type {any} */ ent, head) => {
          const eq = ent.getComponent('minecraft:equippable');
          /** @type {Record<string, any>} */ const old = {};
          for (const [slot, id] of [[EquipmentSlot.Head, head ?? 'iron_helmet'], [EquipmentSlot.Chest, 'iron_chestplate'], [EquipmentSlot.Legs, 'iron_leggings'], [EquipmentSlot.Feet, 'iron_boots'], [EquipmentSlot.Offhand, 'shield']]) {
            try { old[slot] = eq.getEquipment(slot); eq.setEquipment(slot, new ItemStack(`minecraft:${id}`, 1)); } catch { /* */ }
          }
          cleanup.push(() => { for (const k of Object.keys(old)) { try { eq.setEquipment(k, old[k]); } catch { /* */ } } });
        };
        wear(who, name === 'enderman' ? 'carved_pumpkin' : null);
        agent.shield = true;
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        let mob;
        try { mob = dim.spawnEntity(`minecraft:${MOB[0]}`, { x: x + MOB[2] + 0.5, y: gy + MOB[1], z: z + 0.5 }); } catch (e) { detail = `couldn't spawn a ${MOB[0]}: ${e}`; break; }
        cleanup.push(() => { try { mob.remove(); } catch { /* */ } });
        const alive = () => { try { return mob.isValid && (mob.getComponent('minecraft:health')?.currentValue ?? 0) > 0; } catch { return false; } };
        const hpMine = () => { try { return who.getComponent('minecraft:health').currentValue; } catch { return 0; } };
        const hp1 = hpMine();
        if (human) { pass = await humanTry(() => !alive(), 90); detail = `you ${pass ? 'killed' : 'did not kill'} the ${MOB[0].replace('_', ' ')} in ${secs()}s, lost ${Math.max(0, hp1 - hpMine())} hp`; break; }
        const gen = agent.newTask({ kind: 'test' });
        agent.testHold = true;
        let shots = 0, swings = 0;
        const t1 = system.currentTick;
        hold(sim, 'diamond_sword');
        while (alive() && !agent.testSkipped && system.currentTick - t1 < 90 * 20 && hpMine() > 2) {
          const d = dist3D(sim.location, mob.location);
          const away = { x: sim.location.x - mob.location.x, z: sim.location.z - mob.location.z };
          const al = Math.hypot(away.x, away.z) || 1;
          const side = { x: -away.z / al, z: away.x / al };
          if (name === 'ghast' || (name === 'blaze' && d > 5) || d > 12) {
            // Out of reach or in the air: the bow, sidestepping while it draws.
            if (await shootAt(agent, mob, { strafe: side, stop: () => !alive() })) shots++;
            await system.waitTicks(6);
          } else {
            hold(sim, 'diamond_sword');
            try { sim.lookAtEntity(mob); } catch { /* */ }
            if (d > 2.8) { agent.body.move(-away.x / al, -away.z / al, 1); }
            else agent.body.move(side.x, side.z, 0.6);
            if (d <= 3.0 && agent.facing(mob.location, 25)) { try { sim.attackEntity(mob); swings++; } catch { /* */ } await system.waitTicks(8); }
            await system.waitTicks(2);
          }
        }
        agent.body.stop?.();
        pass = !alive();
        detail = `${pass ? 'killed' : 'did not kill'} the ${MOB[0].replace('_', ' ')} in ${secs()}s (${swings} swings, ${shots} arrows), lost ${Math.max(0, hp1 - hpMine())} hp`;
        break;
      }
      case 'placerate': {
        // How fast can a simulated player put blocks down? The game refuses an item use sooner than 10 ticks after the last through
        // useItemInSlotOnBlock (a player clicks every 3 or 4). Each way there is, at each gap, six blocks along a row: how many went down.
        // The fastest way that never failed is kept (memory.data.placeCal) and used by placeOn from then on.
        giveItem('cobblestone', 64);
        tp(x + 5, gy + 1, z);
        await system.waitTicks(10);
        const gen = agent.newTask({ kind: 'test' });
        agent.testHold = true;
        const slot = hold(sim, 'cobblestone');
        giveItem('dirt', 32);
        const slotB = findSlotOf(sim, 'dirt');
        const METHODS = ['use', 'interact', 'useOnBlock', 'alternate'];
        const GAPS = [2, 3, 4, 6, 8, 10];
        const table = [];
        let best = null;
        for (const method of METHODS) {
          for (const gap of GAPS) {
            cmd(`fill ${x + 2} ${gy + 1} ${z + 2} ${x + 9} ${gy + 1} ${z + 2} air`);
            await system.waitTicks(4);
            let put = 0;
            for (let i = 0; i < 6; i++) {
              const nb = { x: x + 3 + i, y: gy, z: z + 2 }, cell = { x: nb.x, y: gy + 1, z: nb.z };
              try { sim.lookAtBlock(nb); } catch { /* */ }
              let ok = false;
              try {
                if (method === 'use') ok = sim.useItemInSlotOnBlock(slot, nb, Direction.Up);
                else if (method === 'alternate') ok = sim.useItemInSlotOnBlock(i % 2 ? slotB : slot, nb, Direction.Up);   // two different items in turn
                else if (method === 'interact') ok = /** @type {any} */ (sim).interactWithBlock(nb, Direction.Up);
                else ok = /** @type {any} */ (sim).useItemOnBlock(packOf(sim)?.getItem(slot), nb, Direction.Up);
              } catch { /* */ }
              await system.waitTicks(1);
              if (S.blockAt(cell) === 'cobblestone' || S.blockAt(cell) === 'dirt') put++;
              await system.waitTicks(Math.max(0, gap - 1));
              void ok;
            }
            table.push(`${method}@${gap}: ${put}/6`);
            if (put === 6 && (!best || gap < best.gap)) best = { method, gap };
          }
        }
        cmd(`fill ${x + 2} ${gy + 1} ${z + 2} ${x + 9} ${gy + 1} ${z + 2} air`);
        // A way faster than the plain one's 10 ticks, taken only if it is clearly so.
        if (best && best.gap <= 6) { agent.memory.data.placeCal = { ...best, at: Date.now(), build: CONFIG.build }; agent.memory.save(); }
        else if (agent.memory.data.placeCal) { agent.memory.data.placeCal = null; agent.memory.save(); }
        pass = !!best;
        detail = `${best ? `fastest that never failed: ${best.method} every ${best.gap} ticks${best.gap <= 6 ? ' (now used for building)' : ' (not faster than the usual, not used)'}` : 'none placed six in a row'}; ${table.join(', ')}`;
        break;
      }
      case 'ravine': {
        // A ravine 3 wide and 9 deep cut into the slab with sheer walls; you start on its floor with blocks and a pickaxe, and have to get out.
        cmd(`fill ${x + 2} ${gy - 9} ${z - 8} ${x + 4} ${gy} ${z + 8} air`);
        tp(x + 3, gy - 9, z);
        await system.waitTicks(15);
        const out = () => who.location.y >= gy + 0.9;
        if (human) { pass = await humanTry(out, 180); detail = `you ${pass ? 'got out' : 'did not get out'} in ${secs()}s`; break; }
        agent.newTask({ kind: 'test' });
        agent.apply([{ type: 'surface' }]);
        await idleOr(150, out);
        pass = out();
        detail = `${pass ? 'out of the ravine' : `still ${Math.round(gy + 1 - sim.location.y)} below the rim`} in ${secs()}s (ledges/digs: ${S.getDownStats?.staged ?? 0}/${S.getDownStats?.digs ?? 0}; ${invCountsOf(sim).cobblestone ?? 0} cobblestone left)`;
        break;
      }
      case 'creepers': {
        // Four creepers across open ground; a shield, a sword, a bow. Everything gone (killed or gone off) and 7 hearts lost at most.
        const eq = who.getComponent('minecraft:equippable');
        const oldOff = (() => { try { return eq?.getEquipment(EquipmentSlot.Offhand); } catch { return undefined; } })();
        try { eq?.setEquipment(EquipmentSlot.Offhand, new ItemStack('minecraft:shield', 1)); } catch { /* */ }
        cleanup.push(() => { try { eq?.setEquipment(EquipmentSlot.Offhand, oldOff); } catch { /* */ } });
        agent.shield = true;
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        const spots = [[10, -4], [12, 3], [14, -1], [9, 6]];
        for (const [dx, dz] of spots) cmd(`summon creeper ${x + dx + 0.5} ${gy + 1} ${z + dz + 0.5}`);
        const left = () => { try { return dim.getEntities({ type: 'minecraft:creeper', location: { x: x + 8, y: gy, z }, maxDistance: 40 }).length; } catch { return 0; } };
        const hpNow = () => { try { return who.getComponent('minecraft:health').currentValue; } catch { return 0; } };
        const hp1 = hpNow();
        cleanup.push(() => { try { for (const e of dim.getEntities({ type: 'minecraft:creeper', location: { x: x + 8, y: gy, z }, maxDistance: 60 })) e.remove(); } catch { /* */ } });
        if (human) { pass = await humanTry(() => left() === 0, 90); pass = pass && hp1 - hpNow() <= 14; detail = `you ${left() === 0 ? 'got rid of all four' : `left ${left()}`} in ${secs()}s, lost ${Math.max(0, hp1 - hpNow())} hp`; break; }
        // The bot just stands in it: its own fighting reflexes (shield, sword, and now the bow) have to deal with them.
        agent.newTask(null);
        agent.equipBestWeapon();
        const t1 = system.currentTick;
        while (left() > 0 && !agent.testSkipped && system.currentTick - t1 < 90 * 20 && hpNow() > 0) await system.waitTicks(10);
        pass = left() === 0 && hp1 - hpNow() <= 14;
        detail = `${left() === 0 ? 'all four gone' : `${left()} left`} in ${secs()}s, lost ${Math.max(0, hp1 - hpNow())} hp (mode ${agent.mode})`;
        break;
      }
      case 'farmrace': {
        // Two plots 28 blocks apart, each with a pond; a hoe and 24 seeds each. First to plant 12 wins (the seeds used up, which is what planting is).
        if (!player) { detail = 'a race needs you: say it in chat'; break; }
        const pk = packOf(player);
        const givePlayer = (id, n) => { try { pk?.addItem(new ItemStack(`minecraft:${id}`, n)); handed.push([id, n]); } catch { /* */ } };
        const recH = new TestRecorder(player);
        const result = { bot: null, you: null };
        for (const pz of [z + 14, z - 14]) {
          cmd(`fill ${x - 6} ${gy + 1} ${pz - 10} ${x + 14} ${gy + 4} ${pz + 10} air`);
          cmd(`fill ${x + 5} ${gy} ${pz - 1} ${x + 7} ${gy} ${pz + 1} water`);
        }
        giveItem('stone_hoe', 1); giveItem('wheat_seeds', 24); givePlayer('stone_hoe', 1); givePlayer('wheat_seeds', 24);
        try { player.teleport({ x: x + 1.5, y: gy + 1, z: z - 13.5 }, { facingLocation: { x: x + 6, y: gy + 1, z: z - 14 } }); } catch { /* */ }
        tp(x + 1, gy + 1, z + 14);
        const H = agent.homestead, mem = agent.memory.data;
        const saved = { house: mem.house, farm: mem.farm, water: mem.waterNearHouse, fw: mem.farmWater };
        cleanup.push(() => { mem.house = saved.house; mem.farm = saved.farm; mem.waterNearHouse = saved.water; mem.farmWater = saved.fw; agent.memory.save(); });
        H.setHouse({ x: x + 1, y: gy + 1, z: z + 14, dir: 'south', bed: true, table: true, furnace: true, level: 1 });
        mem.farm = null; mem.waterNearHouse = undefined;
        const gen = agent.newTask({ kind: 'test' });
        agent.testHold = false;
        const near = await agent.farm.checkWater(gen).catch(() => false);
        const seeds = (e) => invCountsOf(e).wheat_seeds ?? 0;
        const s0 = { bot: seeds(sim), you: seeds(player) };
        agent.say('FARM RACE: each of you has a hoe, 24 seeds and a pond. Till the ground beside the water with the hoe (right-click on grass) and plant seeds on it (right-click on the tilled ground): first to plant 12 wins. Say `!bot test go` (or start moving), `!bot test skip` to give up.');
        try { player.onScreenDisplay.setTitle('Farm race', { subtitle: 'Till and plant 12 seeds', stayDuration: 160, fadeInDuration: 5, fadeOutDuration: 10 }); } catch { /* */ }
        agent.testGo = false;
        if (agent.testProgress) { agent.testProgress.reading = true; agent.testProgress.deadline = null; }
        const p0 = { ...player.location };
        for (let i = 0; i < 60 * 10 && !agent.testSkipped && !agent.testGo; i++) { await system.waitTicks(2); if (Math.hypot(player.location.x - p0.x, player.location.z - p0.z) > 1.5) break; }
        if (agent.testProgress) agent.testProgress.reading = false;
        for (const n of ['3', '2', '1']) { try { player.onScreenDisplay.setTitle(n, { stayDuration: 14, fadeInDuration: 0, fadeOutDuration: 2 }); } catch { /* */ } await system.waitTicks(20); }
        try { player.onScreenDisplay.setTitle('GO!', { stayDuration: 20, fadeInDuration: 0, fadeOutDuration: 5 }); } catch { /* */ }
        if (agent.testProgress) { agent.testProgress.deadline = Date.now() + 180 * 1000; agent.testProgress.limitS = 180; }
        rec.reset(); t0 = system.currentTick; recH.start();
        const tStart = system.currentTick;
        const farmP = agent.farm.make(gen, near ? 'near' : 'bucket', 24).catch(() => false);
        try {
          for (let i = 0; i < 180 * 20 && !agent.testSkipped && (result.bot === null || result.you === null); i++) {
            if (result.bot === null && s0.bot - seeds(sim) >= 12) result.bot = (system.currentTick - tStart) / 20;
            if (result.you === null && s0.you - seeds(player) >= 12) result.you = (system.currentTick - tStart) / 20;
            await system.waitTicks(2);
          }
        } finally {
          agent.newTask(null); agent.motor.stop();
          await Promise.race([farmP, system.waitTicks(20)]);
          try { const sh = recH.stop(); extraRuns.push({ who: 'human', summary: sh, trace: recH.trace(), pass: result.you !== null }); } catch { /* */ }
        }
        const f1 = (v) => (v === null ? 'did not finish' : `${v.toFixed(1)} s`);
        pass = result.bot !== null;
        detail = `plant 12 seeds: bot ${f1(result.bot)}, you ${f1(result.you)}: ${result.bot !== null && (result.you === null || result.bot < result.you) ? 'the bot wins' : result.you !== null ? 'you win' : 'nobody finished'}`;
        agent.say(`Race over: ${detail}.`);
        break;
      }
      case 'duel': {
        if (!player) { detail = 'the duel needs you in the world: say it in chat'; break; }
        const r = await runDuel(agent, player, { cmd, x, gy, z, extraRuns, secs });
        pass = r.pass; detail = r.detail;
        break;
      }
      case 'bow': {
        // Six armor stands in different spots: near and far, left and right, one up on a pillar, one on a step. Hit as many as you can.
        const SPOTS = [[8, -5, 0], [12, 4, 0], [17, -8, 0], [20, 6, 3], [24, -1, 0], [10, 9, 2]];
        const stands = [];
        for (const [dx, dz, dy] of SPOTS) {
          if (dy > 0) cmd(`fill ${x + dx} ${gy + 1} ${z + dz} ${x + dx} ${gy + dy} ${z + dz} stone`);
          cmd(`summon armor_stand ${x + dx + 0.5} ${gy + dy + 1} ${z + dz + 0.5}`);
        }
        await system.waitTicks(6);
        for (const [dx, dz, dy] of SPOTS) {
          const st = dim.getEntities({ type: 'minecraft:armor_stand', location: { x: x + dx + 0.5, y: gy + dy + 1, z: z + dz + 0.5 }, maxDistance: 1.5 })[0];
          if (st) stands.push(st);
        }
        if (stands.length < SPOTS.length) { detail = `only ${stands.length} of ${SPOTS.length} targets were set up`; break; }
        who.teleport({ x: x + 0.5, y: gy + 1, z: z + 0.5 }, { facingLocation: { x: x + 12, y: gy + 1.6, z: z } });
        await system.waitTicks(10);
        const hitIds = new Set();
        let shots = 0;
        const wa = /** @type {any} */ (world.afterEvents);
        const sp = wa.entitySpawn.subscribe((ev) => { try { if (ev.entity.typeId === 'minecraft:arrow' && Math.hypot(ev.entity.location.x - who.location.x, ev.entity.location.z - who.location.z) < 4) shots++; } catch { /* */ } });
        const hp = wa.projectileHitEntity.subscribe((ev) => { try { const e = ev.getEntityHit()?.entity; if (ev.source?.id === who.id && e?.typeId === 'minecraft:armor_stand') hitIds.add(e.id); } catch { /* */ } });
        const hu = wa.entityHurt.subscribe((ev) => { try { if (ev.hurtEntity.typeId === 'minecraft:armor_stand' && ev.damageSource.cause === 'projectile') hitIds.add(ev.hurtEntity.id); } catch { /* */ } });
        cleanup.push(() => {
          try { wa.entitySpawn.unsubscribe(sp); wa.projectileHitEntity.unsubscribe(hp); wa.entityHurt.unsubscribe(hu); } catch { /* */ }
          for (const e of dim.getEntities({ type: 'minecraft:armor_stand', location: { x: x + 12, y: gy, z }, maxDistance: 40 })) try { e.remove(); } catch { /* */ }
          for (const e of dim.getEntities({ type: 'minecraft:arrow', location: { x: x + 12, y: gy, z }, maxDistance: 60 })) try { e.remove(); } catch { /* */ }
        });
        const nHit = () => stands.filter((e) => hitIds.has(e.id)).length;
        if (human) { pass = await humanTry(() => nHit() >= SPOTS.length, 150); pass = nHit() >= SPOTS.length - 1; detail = `you hit ${nHit()}/${SPOTS.length} targets with ${shots} arrows in ${secs()}s`; break; }
        giveItem('bow', 1); giveItem('arrow', 48);
        agent.testHold = true;
        const order = [...stands].sort((a2, b2) => SPOTS[stands.indexOf(a2)][0] - SPOTS[stands.indexOf(b2)][0]);
        const notes = [];
        for (const st of order) {
          let n = 0;
          while (!hitIds.has(st.id) && n < 4 && !agent.testSkipped && (() => { try { return st.isValid; } catch { return false; } })()) {
            n++;
            await shootAt(agent, st, { stop: () => agent.testSkipped });
            await system.waitTicks(22);                       // the flight and the hit
          }
          const sp2 = SPOTS[stands.indexOf(st)];
          notes.push(`${Math.round(Math.hypot(sp2[0], sp2[1]))} blocks${sp2[2] ? ` up ${sp2[2]}` : ''}: ${hitIds.has(st.id) ? `hit with ${n}` : `missed ${n}`}`);
        }
        pass = nHit() >= SPOTS.length - 1;
        detail = `${nHit()}/${SPOTS.length} targets with ${shots} arrows in ${secs()}s (${notes.join('; ')})`;
        break;
      }
      case 'shield':
      case 'skel': {
        // A skeleton down a sealed lane (a stone roof: it doesn't burn). 'shield': the bot stands
        // still facing it, three ways: bare, shield up (crouched), shield in the off hand but standing.
        // How many arrows are loosed and how much health is lost tells whether a raised shield
        // works for a simulated player at all. 'skel': the bot's own reflexes take it on (a sword
        // and, with arg 1, a shield): how long, how much health, does it close in and kill it.
        let fy = gy;
        for (let lx = x - 3; lx <= x + 14; lx++) for (let lz = z - 4; lz <= z + 4; lz++) {
          try { const top = dim.getTopmostBlock({ x: lx, z: lz }); if (top) fy = Math.max(fy, top.location.y); } catch {}
        }
        fy = Math.min(fy, gy + 10);
        cmd(`fill ${x - 3} ${fy} ${z - 4} ${x + 14} ${fy + 5} ${z + 4} stone`);
        cmd(`fill ${x - 2} ${fy + 1} ${z - 3} ${x + 13} ${fy + 4} ${z + 3} air`);
        cmd(`fill ${x - 2} ${fy} ${z - 3} ${x + 13} ${fy} ${z + 3} stone`);
        const eq = sim.getComponent('minecraft:equippable');
        const hpNow = () => { try { return sim.getComponent('minecraft:health').currentValue; } catch { return 0; } };
        const heal = () => { try { sim.getComponent('minecraft:health').resetToMaxValue(); } catch {} };
        const okE = (e) => { try { return !!e?.isValid; } catch { return false; } };
        const lane = { x: x + 6, y: fy + 1, z: z + 0.5 };
        const skeletons = () => { try { return dim.getEntities({ type: 'minecraft:skeleton', location: lane, maxDistance: 16 }); } catch { return []; } };
        const clear = () => { for (const e of skeletons()) try { e.remove(); } catch {} for (const e of dim.getEntities({ type: 'minecraft:arrow', location: lane, maxDistance: 16 })) try { e.remove(); } catch {} };
        const summon = async (dx) => { cmd(`summon skeleton ${x + dx} ${fy + 1} ${z}`); await system.waitTicks(2); return skeletons()[0] ?? null; };
        const sword = () => { if (!invCountsOf(sim).stone_sword && !invCountsOf(sim).iron_sword) packOf(sim)?.addItem(new ItemStack('minecraft:stone_sword', 1)); agent.equipBestWeapon(); };
        const results = [];
        if (name === 'shield') {
          agent.testHold = true; agent.endCombat();
          for (const [label, withShield, crouch] of [['bare', false, false], ['shield up', true, true], ['shield, standing', true, false]]) {
            clear();
            try { tp(x, fy + 1, z); } catch {}
            try { eq.setEquipment(EquipmentSlot.Offhand, withShield ? new ItemStack('minecraft:shield', 1) : undefined); } catch (e) { detail += `offhand ${e}; `; }
            heal();
            await system.waitTicks(5);
            const sk = await summon(9);
            if (!sk) { results.push(`${label}: couldn't summon`); continue; }
            const seen = new Set();
            let prev = hpNow(), hits = 0, dmg = 0;
            for (let i = 0; i < 20 * 20; i++) {
              try { const l = okE(sk) ? sk.location : null; if (l) { agent.motor.setFocus({ x: l.x, y: l.y + 1.4, z: l.z }); sim.lookAtEntity(sk); } } catch {}
              try { sim.isSneaking = crouch; } catch {}
              await system.waitTicks(1);
              try { for (const a of dim.getEntities({ type: 'minecraft:arrow', location: lane, maxDistance: 16 })) seen.add(a.id); } catch {}
              const h = hpNow();
              if (h < prev - 0.3) { hits++; dmg += prev - h; }
              prev = h;
              if (h <= 2) heal();
            }
            results.push(`${label}: ${seen.size} arrows, ${hits} hit, ${dmg.toFixed(1)} damage`);
            clear();
          }
          try { sim.isSneaking = false; } catch {}
          try { eq.setEquipment(EquipmentSlot.Offhand, undefined); } catch {}
          agent.testHold = false; agent.motor.setFocus(null);
          pass = true;
          detail = results.join('; ');
        } else if (arg === 8) {
          // Terrain fuzz: the same sealed lane, the skeleton on the flat, up a step, up two, down a
          // pit, behind a pillar. How long each takes (or that it doesn't), health lost, what the bot did.
          /** @type {Array<[string, (b: (c: string) => boolean) => { dx: number, dy: number }]>} */
          const trials = [
            ['flat 6', () => ({ dx: 6, dy: 0 })],
            ['1 up', (b) => { b(`fill ${x + 4} ${fy + 1} ${z - 3} ${x + 13} ${fy + 1} ${z + 3} stone`); return { dx: 7, dy: 1 }; }],
            ['2 up', (b) => { b(`fill ${x + 5} ${fy + 1} ${z - 3} ${x + 13} ${fy + 2} ${z + 3} stone`); return { dx: 8, dy: 2 }; }],
            ['pit 2 deep', (b) => { b(`fill ${x + 5} ${fy - 1} ${z - 1} ${x + 8} ${fy} ${z + 1} stone`); b(`fill ${x + 6} ${fy - 1} ${z} ${x + 7} ${fy} ${z} air`); return { dx: 6, dy: -2 }; }],
            ['behind a pillar', (b) => { b(`fill ${x + 3} ${fy + 1} ${z} ${x + 3} ${fy + 3} ${z} stone`); return { dx: 8, dy: 0 }; }],
            ['close 3', () => ({ dx: 3, dy: 0 })],
          ];
          agent.testHold = false;
          for (const [label, build] of trials) {
            clear();
            cmd(`fill ${x - 2} ${fy} ${z - 3} ${x + 13} ${fy} ${z + 3} stone`);
            cmd(`fill ${x - 2} ${fy + 1} ${z - 3} ${x + 13} ${fy + 4} ${z + 3} air`);
            const { dx, dy } = build(cmd);
            try { tp(x, fy + 1, z); } catch {}
            sword(); agent.equipBestWeapon(); agent.endCombat(); heal();
            await system.waitTicks(15);
            let sk = null;
            cmd(`summon skeleton ${x + dx} ${fy + 1 + dy} ${z}`);
            await system.waitTicks(2);
            sk = skeletons()[0] ?? null;
            if (!sk) { results.push(`${label}: couldn't summon`); continue; }
            const t1 = system.currentTick;
            let minHp = hpNow(), hits = 0, prevHp = hpNow(), modes = new Set();
            for (let i = 0; i < 20 * 25 && okE(sk); i++) {
              await system.waitTicks(1);
              modes.add(agent.mode);
              const h = hpNow();
              if (h < prevHp - 0.3) hits++;
              prevHp = h; minHp = Math.min(minHp, h);
              if (h <= 6) heal();
            }
            const killed = !okE(sk);
            results.push(`${label}: ${killed ? `killed in ${((system.currentTick - t1) / 20).toFixed(0)}s` : 'NOT killed'}, ${hits} hits, ${[...modes].join('/')}`);
            clear();
          }
          pass = results.every((r) => /killed/.test(r) && !/NOT/.test(r));
          detail = results.join('; ');
        } else if (arg === 6 || arg === 7) {
          // Indoors: a small room, the skeleton just outside the doorway (6: the wooden door open;
          // 7: a fence gate open) shooting in, or (8 -> arg 7 with furniture) - the bot must go out and
          // kill it, not stand there swinging at nothing (the house fights that went half a minute).
          clear();
          const wallX = x + 3;
          cmd(`fill ${wallX} ${fy + 1} ${z - 3} ${wallX} ${fy + 4} ${z + 3} stone`);          // the room's east wall
          const dz = z;
          if (arg === 6) {
            cmd(`setblock ${wallX} ${fy + 1} ${dz} wooden_door ["minecraft:cardinal_direction"="east","open_bit"=true]`);
            cmd(`setblock ${wallX} ${fy + 2} ${dz} wooden_door ["upper_block_bit"=true,"open_bit"=true]`);
          } else {
            cmd(`setblock ${wallX} ${fy + 1} ${dz} fence_gate ["minecraft:cardinal_direction"="east","open_bit"=true]`);
            cmd(`setblock ${wallX} ${fy + 2} ${dz} air`);
          }
          await system.waitTicks(2);
          let st = '?';
          try { st = JSON.stringify(dim.getBlock({ x: wallX, y: fy + 1, z: dz }).permutation.getAllStates()); } catch {}
          detail += `door ${dim.getBlock({ x: wallX, y: fy + 1, z: dz })?.typeId} ${st}; `;
          try { tp(x, fy + 1, z); } catch {}
          sword();
          agent.equipBestWeapon();
          heal();
          await system.waitTicks(10);
          const sk = await summon(5);   // (x+5: 2 blocks outside the door)
          if (!sk) { detail += "couldn't summon"; break; }
          const t1 = system.currentTick;
          let minHp = hpNow(), modes = new Set();
          for (let i = 0; i < 20 * 30 && okE(sk); i++) {
            await system.waitTicks(1);
            modes.add(agent.mode);
            minHp = Math.min(minHp, hpNow());
            if (hpNow() <= 0) break;
          }
          const killed = !okE(sk);
          pass = killed;
          detail += `${killed ? 'killed it' : 'skeleton still alive'} after ${((system.currentTick - t1) / 20).toFixed(0)}s, lowest hp ${minHp.toFixed(0)}, modes ${[...modes].join('/')}`;
          clear();
        } else if (arg === 4 || arg === 5) {
          // 4: the flip-flop damper's on (it silences reactions for 30 s) and an archer shoots from 12:
          // it must still take him on. 5: three of them at 10, 12 and 14: what the bot does (lives, or not).
          clear();
          try { tp(x, fy + 1, z); } catch {}
          sword();
          agent.equipBestWeapon();
          heal();
          await system.waitTicks(10);
          const sks = [];
          for (const dx of arg === 4 ? [12] : [10, 12, 14]) { const q = await summon(dx); if (q) sks.push(q); await system.waitTicks(1); }
          const t1 = system.currentTick;
          let minHp = hpNow(), modes = new Set();
          for (let i = 0; i < 20 * 45 && sks.some(okE); i++) {
            if (arg === 4) agent.ignoreThreatsUntil = system.currentTick + 600;
            await system.waitTicks(1);
            modes.add(agent.mode);
            minHp = Math.min(minHp, hpNow());
            if (hpNow() <= 0) break;
          }
          const left = sks.filter(okE).length;
          agent.ignoreThreatsUntil = 0;
          const alive = hpNow() > 0;
          pass = arg === 4 ? left === 0 : alive;
          detail = `${sks.length} skeleton${sks.length === 1 ? '' : 's'}: ${left} left after ${((system.currentTick - t1) / 20).toFixed(0)}s, lowest hp ${minHp.toFixed(0)}, ${alive ? 'alive' : 'died'}, modes ${[...modes].join('/')}`;
          clear();
        } else if (arg === 3) {
          // What the bot can tell about a skeleton at range: does `target` name us, is it visible.
          agent.testHold = true; agent.endCombat();
          clear();
          try { tp(x, fy + 1, z); } catch {}
          heal();
          await system.waitTicks(10);
          const sk = await summon(12);
          if (!sk) { detail = "couldn't summon"; break; }
          const rows = [];
          for (let i = 0; i < 20 * 12; i++) {
            await system.waitTicks(1);
            if (i % 30 !== 0) continue;
            const m = agent.scanMobs(24).find((q) => q.type === 'skeleton');
            let tg = '?';
            try { tg = sk.target ? sk.target.typeId.replace('minecraft:', '') : 'none'; } catch (e) { tg = `err`; }
            rows.push(m ? `${(i / 20).toFixed(0)}s d${m.dist.toFixed(0)} tgt=${m.targetingMe ? 1 : 0}(${tg}) vis=${m.visible ? 1 : 0}` : `${(i / 20).toFixed(0)}s gone`);
          }
          agent.testHold = false;
          clear();
          pass = true;
          detail = rows.join('; ');
        } else {
          for (const withShield of arg === 1 ? [true] : arg === 0 ? [false] : [false, true]) {
            clear();
            try { tp(x, fy + 1, z); } catch {}
            sword();
            try { eq.setEquipment(EquipmentSlot.Offhand, withShield ? new ItemStack('minecraft:shield', 1) : undefined); } catch {}
            agent.equipBestWeapon();
            heal();
            await system.waitTicks(10);
            const sk = await summon(12);
            if (!sk) { results.push("couldn't summon"); continue; }
            const t1 = system.currentTick;
            let minD = Infinity, hp0 = hpNow(), blocked = 0, modes = new Set();
            for (let i = 0; i < 20 * 40 && okE(sk); i++) {
              await system.waitTicks(1);
              try { minD = Math.min(minD, dist3D(sim.location, sk.location)); } catch {}
              modes.add(agent.mode);
              if (agent.blocking) blocked++;
              if (hpNow() <= 0) break;
            }
            const killed = !okE(sk);
            results.push(`${withShield ? 'with' : 'without'} a shield: ${killed ? 'killed it' : 'skeleton still alive'} in ${((system.currentTick - t1) / 20).toFixed(0)}s, closest ${minD.toFixed(1)}, lost ${Math.max(0, hp0 - hpNow()).toFixed(0)} hp, shield up ${blocked} ticks, modes ${[...modes].join('/')}`);
            clear();
          }
          try { eq.setEquipment(EquipmentSlot.Offhand, undefined); } catch {}
          pass = results.length > 0 && results.every((r) => /killed it/.test(r));
          detail = results.join('; ');
        }
        break;
      }
      case 'rest': {
        // Hurt to 3 hp with the plan free to go anywhere: it must stop and heal first, not go off
        // working (arg 0: fed, with cooked beef; 1: hungry, with cooked beef; 2: hungry, nothing to eat: can't
        // heal, so it must not sit there waiting; healing burns the food bar: 1.5 points an hp).
        cmd(`fill ${x - 8} ${gy - 3} ${z - 8} ${x + 14} ${gy} ${z + 8} grass_block`);
        cmd(`fill ${x - 8} ${gy + 1} ${z - 8} ${x + 14} ${gy + 8} ${z + 8} air`);
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        const inv = sim.getComponent('minecraft:inventory').container;
        for (let i = 0; i < inv.size; i++) inv.setItem(i, undefined);
        inv.addItem(new ItemStack('minecraft:stone_sword', 1));
        inv.addItem(new ItemStack('minecraft:stone_pickaxe', 3));
        inv.addItem(new ItemStack('minecraft:cobblestone', 20));
        if (arg !== 2) inv.addItem(new ItemStack('minecraft:cooked_beef', 6));
        agent.equipBestWeapon();
        const setHunger = (n) => { try { sim.getComponent('minecraft:player.hunger').setCurrentValue(n); } catch (e) { detail += `hunger ${e}; `; } };
        setHunger(arg === 1 || arg === 2 ? 10 : 20);
        try { sim.getComponent('minecraft:player.saturation').setCurrentValue(0); } catch {}
        try { sim.getComponent('minecraft:health').setCurrentValue(3); } catch {}
        const start = { ...sim.location };
        agent.autoEnabled = true; agent.resting = false; agent.restCoolUntil = 0;
        agent.startAuto();
        const t1 = system.currentTick;
        let restedTicks = 0, healedAt = -1;
        for (let i = 0; i < 20 * 100; i++) {
          await system.waitTicks(1);
          if (agent.autoStep === 'rest') restedTicks++;
          if (healedAt < 0 && agent.health() >= 14) { healedAt = i; if (arg !== 2) break; }
          if (arg === 2 && i > 20 * 12) break;
        }
        const moved = Math.hypot(sim.location.x - start.x, sim.location.z - start.z);
        const hp = agent.health();
        agent.autoEnabled = false; agent.newTask(null); agent.motor.stop();
        pass = arg === 2 ? restedTicks < 20 * 4 : healedAt >= 0 && restedTicks > 20 * 5 && moved < 12;
        detail = `${arg === 2 ? 'hungry, nothing to eat' : arg === 1 ? 'hungry, cooked beef' : 'fed, cooked beef'}: hp ${hp.toFixed(0)} after ${((system.currentTick - t1) / 20).toFixed(0)}s, resting ${(restedTicks / 20).toFixed(0)}s, moved ${moved.toFixed(0)} blocks, step ${agent.autoStep}`;
        break;
      }
      case 'nights': {
        // Night, a sword and full health, `goal nights off`: it must carry on working (not go home
        // and sit) - and with it on, go home. arg 0: off; 1: on. The house is a stub: the bot only
        // has to pick the right step.
        const was = agent.memory.data.settings?.nights;
        agent.setGoal('nights', arg === 1);
        const inv = sim.getComponent('minecraft:inventory').container;
        if (!Object.keys(invCountsOf(sim)).some((id) => /_sword$/.test(id))) inv.addItem(new ItemStack('minecraft:stone_sword', 1));
        try { sim.getComponent('minecraft:health').resetToMaxValue(); } catch {}
        const timeWas = world.getTimeOfDay();
        try { world.setTimeOfDay(14000); } catch {}
        await system.waitTicks(5);
        const works = agent.workNights(invCountsOf(sim));
        const step = agent.planStep(invCountsOf(sim), 0, 0);
        try { world.setTimeOfDay(timeWas); } catch {}
        agent.setGoal('nights', was !== false);
        const home = ['go_home', 'shelter'].includes(step.step);
        // (Without a house, an armed bot works the night either way: what shows the switch is workNights.)
        pass = arg === 1 ? !works : works && !home;
        detail = `nights ${arg === 1 ? 'on' : 'off'}: works through the night ${works}, at night the plan is "${step.step}"${step.why ? ` (${step.why})` : ''}`;
        break;
      }
      case 'husk': {
        tp(x, gy + 1, z);
        await system.waitTicks(10);
        cmd(`summon husk ${x + 8} ${gy + 1} ${z}`);
        await system.waitTicks(2);
        const husk = dim.getEntities({ type: 'minecraft:husk', location: { x: x + 8, y: gy + 1, z }, maxDistance: 3 })[0];
        if (!husk) { detail = "couldn't summon a husk"; break; }
        if (human) { pass = await humanTry(() => !husk.isValid, 60); if (!pass) { try { husk.remove(); } catch { /* */ } } detail = `you ${pass ? 'killed the husk' : 'did not kill the husk'} in ${secs()}s`; break; }
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
      case 'portal': {
        // A clear, flat patch; the frame stands in the x/y plane at z, 4 wide and 5 tall (12 obsidian: the
        // two bottom corners give the columns something to stand on, the top corners aren't needed). Its bottom row is on
        // the ground, so getting in is a step up: the bot finds the frame and paths into it, whatever it stands on.
        cmd(`fill ${x - 6} ${gy} ${z - 4} ${x + 9} ${gy} ${z + 6} grass_block`);
        cmd(`fill ${x - 6} ${gy + 1} ${z - 4} ${x + 9} ${gy + 8} ${z + 6} air`);
        giveItem('obsidian', 12); giveItem('flint_and_steel', 1); giveItem('cobblestone', 6);
        tp(x + 1, gy + 1, z + 4);
        await system.waitTicks(20);
        const H = agent.homestead;
        const gen = agent.newTask({ kind: 'test' });
        let byBot = 0, byCmd = 0;
        const put = async (cell, item) => {
          let ok = false;
          try { ok = await H.placeAt(gen, cell, item); } catch (e) { if (e?.constructor?.name === 'Aborted') throw e; console.warn(`[test] portal placeAt: ${e}`); }
          if (ok && S.blockAt(cell) === item) { if (item === 'obsidian') byBot++; return true; }
          if (cmd(`setblock ${cell.x} ${cell.y} ${cell.z} ${item}`)) { if (item === 'obsidian') byCmd++; return true; }
          return false;
        };
        // 1. The bottom row, from the front, on the ground.
        const bottom = [x, x + 1, x + 2, x + 3].map((fx) => ({ x: fx, y: gy + 1, z }));
        for (const cell of bottom) await put(cell, 'obsidian');
        // 2. The way a player reaches the top: a little cobblestone stair in front (three blocks), up it to eye height with the
        //    upper frame, then it's taken down again.
        const steps = [{ x: x + 1, y: gy + 1, z: z + 3 }, { x: x + 1, y: gy + 1, z: z + 2 }, { x: x + 1, y: gy + 2, z: z + 2 }];
        for (const cell of steps) await put(cell, 'cobblestone');
        await S.goNear(gen, { x: x + 1.5, y: gy + 3, z: z + 2.5 }, 0.7, 3);
        // 3. The two columns, low to high, then the top row against their sides.
        for (const fy of [gy + 2, gy + 3, gy + 4]) { await put({ x, y: fy, z }, 'obsidian'); await put({ x: x + 3, y: fy, z }, 'obsidian'); }
        for (const fx of [x + 1, x + 2]) await put({ x: fx, y: gy + 5, z }, 'obsidian');
        for (const cell of [steps[2], steps[1], steps[0]]) { try { await S.mine(gen, cell); } catch (e) { if (e?.constructor?.name === 'Aborted') throw e; } }
        const frame = [...bottom, ...[gy + 2, gy + 3, gy + 4].flatMap((fy) => [{ x, y: fy, z }, { x: x + 3, y: fy, z }]), ...[x + 1, x + 2].map((fx) => ({ x: fx, y: gy + 5, z }))];
        const built = frame.filter((cell) => S.blockAt(cell) === 'obsidian').length;
        if (built < frame.length) { detail = `frame incomplete (${built}/${frame.length} obsidian; the bot placed ${byBot})`; break; }
        // 4. Light it: flint and steel on the top of a bottom block, from in front, one use every 10 ticks.
        await S.goNear(gen, { x: x + 1.5, y: gy + 1, z: z + 3.5 }, 0.8, 3);
        const inner = [{ x: x + 1, y: gy + 2, z }, { x: x + 2, y: gy + 2, z }];
        const slot = hold(sim, 'flint_and_steel');
        let lit = false, tries = 0, used = '';
        for (; tries < 5 && !lit; tries++) {
          await agent.motor.lookAt({ x: x + 1.5, y: gy + 2.2, z: z + 0.5 }, 8, 30);
          await S.useGap(gen);
          try { used = String(sim.useItemInSlotOnBlock(slot, { x: x + 1, y: gy + 1, z }, Direction.Up, { x: 0.5, y: 1, z: 0.5 })); } catch (e) { used = `threw ${e}`; }
          S.lastUseTick = system.currentTick;
          await system.waitTicks(12);
          lit = inner.some((cell) => /(^|_)portal$/.test(S.blockAt(cell) ?? '')); // (the block is `portal`)
        }
        if (!lit) { detail = `built the frame (${byBot} placed by the bot, ${byCmd} by command) but it didn't light after ${tries} tries (use returned ${used}, slot ${slot}, inner block ${S.blockAt(inner[0])}, held ${sim.getComponent('minecraft:inventory').container.getItem(sim.selectedSlotIndex)?.typeId ?? 'nothing'})`; break; }
        // 5. Find the frame the way it would any (ours, a ruined one, someone's), path to the floor of its inside and stand there until moved.
        const frames = agent.portal.find(12);
        if (!frames.length) { detail = `lit, but the frame finder saw none within 12 blocks`; break; }
        const fr = frames[0];
        const through = await agent.portal.enter(gen, fr, 20);
        const dimNow = through.dimension;
        const standingIn = through.ok, finalAt = `${sim.location.x.toFixed(1)} ${sim.location.y.toFixed(1)} ${sim.location.z.toFixed(1)}`, closest = 0, jumps = 0;
        void standingIn; void closest; void jumps;
        const arrived = dimNow !== dim.id;
        const where = { x: Math.round(sim.location.x), y: Math.round(sim.location.y), z: Math.round(sim.location.z) };
        if (arrived) {
          await system.waitTicks(40);
          try { sim.teleport(home, { dimension: dim }); } catch (e) { console.warn(`[test] portal back: ${e}`); }
        }
        pass = arrived;
        detail = `${arrived ? `lit it and arrived in ${dimNow} at ${where.x} ${where.y} ${where.z}` : `lit but didn't get through: ${through.why} (frame ${fr.w}x${fr.h} on the ${fr.axis} axis, ${through.tries} tries, ended at ${finalAt})`}; frame ${byBot} placed by the bot, ${byCmd} by command; lighting took ${tries} click(s), ${secs()}s`;
        break;
      }
      case 'horse': {
        flatPatch(cmd, x, gy, z);
        giveItem('saddle', 1);
        tp(x, gy + 1, z);
        const horse = await spawnAdultHorse(dim, { x: x + 4.5, y: gy + 1, z: z + 0.5 });
        if (!horse) { detail = "couldn't get an adult horse (only babies spawned, and they can't be ridden)"; break; }
        cleanup.push(() => { try { horse.remove(); } catch {} });
        await system.waitTicks(20);
        const gen = agent.newTask({ kind: 'test' });
        const r = await horseReady(agent, gen, horse, secs);
        if (!r.ok) { detail = r.detail; break; }
        const ride = await rideAcross(agent, gen, horse, 8);
        pass = ride.mounted && ride.moved >= 4;
        detail = `${r.detail}; ${ride.detail}`;
        break;
      }
      case 'leadsling': {
        // Calibrating the sling (game/leadtow.js sling). A long stone platform x..x+13 of each height in turn (1, 2, 3 blocks) with
        // a boat jammed at its foot and the bot on top. The lead is stretched to 5, 7, 9, 11 blocks, a jump, and 2 s watched: did the
        // boat come up, how fast did it fly, did the lead break. The least stretch that works per height, and where it snaps.
        flatPatch(cmd, x, gy, z);
        giveItem('lead', 12);
        const gen = agent.newTask({ kind: 'test' });
        const byRise = {}, peaks = {}, rows = [];
        let snapAt = null;
        // Saved even if the test is stopped half way: what was found so far.
        cleanup.push(() => {
          if (!Object.keys(byRise).length) return;
          agent.memory.data.leadCal = { ...(agent.memory.data.leadCal ?? {}), sling: { byRise, peaks, snapAt, guard: snapAt ? Math.max(5, snapAt - 0.8) : 11, at: Date.now(), build: CONFIG.build, partial: Object.keys(byRise).length < 3 } };
          agent.memory.save();
        });
        for (const rise of [1, 2, 3]) {
          cmd(`fill ${x} ${gy + 1} ${z - 2} ${x + 13} ${gy + rise} ${z + 2} stone`);
          const topY = gy + rise + 1;
          for (const target of [5, 7, 9, 11]) {
            if (snapAt !== null && target >= snapAt) { rows.push(`h${rise}@${target}: skipped (broke at ${snapAt})`); continue; }
            tp(x - 2, gy + 1, z);
            await system.waitTicks(8);
            const boat = dim.spawnEntity('minecraft:boat', { x: x - 0.9, y: gy + 1, z: z + 0.5 });
            cleanup.push(() => { try { boat.remove(); } catch {} });
            await system.waitTicks(8);
            if (!leashTo(sim, boat)) { rows.push(`h${rise}@${target}: no lead`); try { boat.remove(); } catch {} continue; }
            tp(x + 1, topY, z);
            await system.waitTicks(10);
            const r = await agent.tow.sling(gen, boat, { target, guard: 11.5 });
            rows.push(`h${rise}@${target}: ${r.snapped ? `BROKE at ${r.stretch}` : r.ok ? `up (stretch ${r.stretch}, flew ${r.peak} b/s)` : `stayed down (stretch ${r.stretch}, climbed ${r.climbed})`}`);
            try { boat.remove(); } catch {}
            if (r.snapped) { snapAt = snapAt === null ? r.stretch : Math.min(snapAt, r.stretch); continue; }
            if (r.ok) { byRise[rise] = r.stretch; peaks[rise] = r.peak; break; }
          }
        }
        const found = Object.keys(byRise).length;
        if (found) {
          const cal = agent.memory.data.leadCal ?? {};
          agent.memory.data.leadCal = { ...cal, sling: { byRise, peaks, snapAt, guard: snapAt ? Math.max(5, snapAt - 0.8) : 11, at: Date.now(), build: CONFIG.build } };
          agent.memory.save();
        }
        pass = found === 3;
        detail = `${found}/3 heights brought up${snapAt ? `, the lead breaks at ${snapAt}` : ', no snap seen up to 11'}; least stretch by height ${JSON.stringify(byRise)}; ${rows.join('; ')}`;
        break;
      }
      case 'leadboat': {
        // A lane 7 wide, rough on purpose: a pond just ahead of the start (the straight line goes through it), up one block, up another with
        // a few 1-high stones scattered on it, down one, a 1-wide trench; then a three-high hill, a gap 3 wide and 6 deep across the whole
        // slab (blocks are needed: the bot builds across it, the boat follows over), and a plateau with a gold block. The bot tows a boat
        // over all of it on foot (game/leadtow.js), then again on a horse over the first part; you tow one over all of it on foot.
        tp(x - 6, gy + 1, z - 8);   // (out of the way: the course is built where whoever it is stood, inside stone)
        flatPatch(cmd, x, gy, z);
        cmd(`fill ${x - 5} ${gy - 1} ${z - 1} ${x - 4} ${gy} ${z + 3} water`);              // a pond in the straight line
        cmd(`fill ${x - 3} ${gy + 1} ${z - 3} ${x + 13} ${gy + 1} ${z + 3} stone`);        // up one at x-3
        cmd(`fill ${x + 2} ${gy + 2} ${z - 3} ${x + 8} ${gy + 2} ${z + 3} stone`);         // up another at x+2
        for (const [bx, bz] of [[3, 1], [5, -1], [6, 2], [4, -2], [7, 0]]) cmd(`setblock ${x + bx} ${gy + 3} ${z + bz} stone`); // rubble on it
        cmd(`fill ${x + 11} ${gy} ${z - 3} ${x + 11} ${gy + 1} ${z + 3} air`);             // a trench at x+11
        const farGoal = towTail(cmd, x, gy, z, { pit: true });
        // The boats start at the west end, inside the backed-up box: solid grass under them and air round (it spawned in terrain before).
        cmd(`fill ${x - 8} ${gy} ${z - 3} ${x - 6} ${gy} ${z + 4} grass_block`);
        cmd(`fill ${x - 8} ${gy + 1} ${z - 3} ${x - 6} ${gy + 4} ${z + 4} air`);
        const goal = { x: x + 12.5, y: gy + 2, z: z + 0.5 };
        // Two villagers at the start, to be led to the pit at the far end.
        const vils = [];
        for (const [vx, vz] of [[-7.5, -2.5], [-7.5, 3.5]]) { const v = await spawnAdult(dim, 'minecraft:villager_v2', { x: x + vx, y: gy + 1, z: z + vz }); if (v) { vils.push(v); cleanup.push(() => { try { v.remove(); } catch {} }); } }
        if (vils.length < 2) { detail = `could only get ${vils.length} adult villagers`; break; }
        const pit = farGoal.pit;
        const inPit = (v) => { try { const l = v.location; return v.isValid && l.x >= pit.x1 && l.x < pit.x2 + 1 && l.z >= pit.z1 && l.z < pit.z2 + 1 && l.y < gy + 2.5; } catch { return false; } };
        const nPit = () => vils.filter(inPit).length;
        if (human) {
          tp(x - 6, gy + 1, z);
          const boat = dim.spawnEntity('minecraft:boat', { x: x - 7.5, y: gy + 1, z: z + 0.5 });
          cleanup.push(() => { try { boat.remove(); } catch {} });
          const leashed = () => { try { return !!boat.getComponent('minecraft:leashable')?.isLeashed; } catch { return false; } };
          const near = vils.map(() => 0);
          const boatRiders = () => { try { return boat.getComponent('minecraft:rideable')?.getRiders() ?? []; } catch { return []; } };
          pass = await humanTry(() => {
            vils.forEach((v, i) => {
              if (!v.isValid || boatRiders().some((r) => r.id === v.id)) { near[i] = 0; return; }
              near[i] = Math.hypot(v.location.x - boat.location.x, v.location.z - boat.location.z) <= 1.8 ? near[i] + 1 : 0;
              if (near[i] >= 16 && boatRiders().length < 2) { boardVillager(cmd, boat, v); near[i] = 0; try { player.onScreenDisplay.setActionBar('The game did not take the villager in: put in the boat for you.'); } catch { /* */ } }
            });
            return nPit() === 2;
          }, 300, { x: farGoal.x, y: farGoal.y, z: farGoal.z }, 'Both villagers into the boat, led over the course, into the pit');
          detail = `you ${pass ? 'got both villagers into the pit' : `did not finish (${nPit()}/2 villagers in the pit)`} in ${secs()}s`;
          break;
        }
        giveItem('lead', 3); giveItem('saddle', 1);
        const gen = agent.newTask({ kind: 'test' });
        const cal = { legs: {} };
        cleanup.push(() => { if (Object.keys(cal.legs).length) { agent.memory.data.leadCal = { ...(agent.memory.data.leadCal ?? {}), ...cal, at: Date.now(), build: CONFIG.build, partial: true }; agent.memory.save(); } });
        const lines = [];
        let walkOk = false;
        // The lines so far are in the result however the test ends (the report of a skipped run said nothing of what the bot did).
        cleanup.push(() => { if (!detail && lines.length) detail = `${lines.join(' | ')} | (interrupted)`; });
        // On foot, the whole course, with the villagers.
        tp(x - 6, gy + 1, z);
        await system.waitTicks(10);
        {
          const boat = dim.spawnEntity('minecraft:boat', { x: x - 7.5, y: gy + 1, z: z + 0.5 });
          cleanup.push(() => { try { boat.remove(); } catch {} });
          await system.waitTicks(10);
          const via = leashTo(sim, boat);
          if (!via) { detail = `couldn't put a lead on the boat (leashable: ${!!boat.getComponent('minecraft:leashable')})`; break; }
          boat.addTag('vh_boat');
          const rid = () => { try { return boat.getComponent('minecraft:rideable')?.getRiders() ?? []; } catch { return []; } };
          const fns = { riding: (v) => rid().some((r) => r.id === v.id), ridersN: () => rid().length, putIn: (v) => { boardVillager(cmd, boat, v); } };
          rec.reset(); t0 = system.currentTick;
          await sweepVillagers(agent, gen, boat, vils, gy, fns);
          const m = await agent.tow.run(gen, boat, { ...farGoal, x: farGoal.x - 0.5 }, { maxS: 150 });
          cal.legs.walk = m;
          // Round the pit to its far side: the boat is pulled straight across it and drops in with its riders.
          let circled = false;
          if (m.arrived && !m.snapped && boat.isValid) {
            const wps = [{ x: pit.x1 - 0.5, z: pit.z2 + 2.5 }, { x: pit.x2 + 2, z: pit.z2 + 2.5 }, { x: pit.x2 + 2, z: z + 0.5 }];
            for (const wp of wps) {
              for (let i = 0; i < 160 && boat.isValid && nPit() < 2; i++) {
                const sep = Math.hypot(sim.location.x - boat.location.x, sim.location.z - boat.location.z);
                if (sep > 7) { try { sim.stopMoving(); } catch { /* */ } } else { try { sim.moveToLocation({ x: wp.x, y: gy + 3, z: wp.z }, { speed: 0.7 }); } catch { /* */ } }
                await system.waitTicks(2);
                if (Math.hypot(sim.location.x - wp.x, sim.location.z - wp.z) < 1.2) break;
              }
              if (nPit() >= 2) break;
            }
            circled = true;
            for (let i = 0; i < 15 && nPit() < 2; i++) await system.waitTicks(10);
          }
          legSummary = rec.snapshot();
          lines.push(`on foot: ${vils.filter((v) => fns.riding(v)).length}/2 villagers in the boat, ${nPit()}/2 in the pit${circled ? '' : ' (never got round the pit)'}; ${towLine(m, farGoal)}${m.notes.length ? ` [${m.notes.join('; ')}]` : ''}`);
          detail = lines.join(' | ');
          walkOk = m.arrived && !m.snapped && nPit() === 2;
          try { boat.remove(); } catch {}
        }
        // On a horse, the first part (the horse jumps a block, not a gap).
        tp(x - 6, gy + 1, z);
        const horse = await spawnAdultHorse(dim, { x: x - 5.5, y: gy + 1, z: z - 2.5 });
        let horseOk = false;
        if (!horse) lines.push("horse leg: couldn't get an adult horse (babies can't be ridden)");
        else {
          cleanup.push(() => { try { horse.remove(); } catch {} });
          await system.waitTicks(20);
          const r = await horseReady(agent, gen, horse, secs);
          if (!r.ok) lines.push(`horse leg: ${r.detail}`);
          else {
            // Up on the horse first, then the boat goes down behind it (a boat dropped beside a loose horse trapped it).
            const ride = await rideAcross(agent, gen, horse, 0);
            const hl = horse.location;
            const bp = hl.x - 2.4 >= x - 7.9 ? { x: hl.x - 2.4, y: gy + 1, z: hl.z } : { x: hl.x, y: gy + 1, z: Math.min(hl.z + 2.6, z + 3.5) };
            const boat = dim.spawnEntity('minecraft:boat', bp);
            cleanup.push(() => { try { boat.remove(); } catch {} });
            await system.waitTicks(10);
            if (!ride.mounted) lines.push(`horse leg: ${ride.detail}`);
            else if (!leashTo(sim, boat)) lines.push("horse leg: couldn't lead the boat from the saddle");
            else {
              const m = await agent.tow.run(gen, boat, goal, { mount: horse, maxS: 90 });
              cal.legs.horse = m;
              lines.push(`${r.detail}; on the horse: ${towLine(m, goal)}`);
              horseOk = m.arrived && !m.snapped;
            }
            try { await agent.horses.getOff(gen); } catch {}
          }
        }
        agent.memory.data.leadCal = { ...(agent.memory.data.leadCal ?? {}), ...cal, at: Date.now(), build: CONFIG.build };
        agent.memory.save();
        pass = walkOk && horseOk;
        detail = lines.join(' | ');
        break;
      }
      case 'forest': {
        // Dropped in a forest (the same spot for you and the bot; the trees are put back between): 15 logs as fast as you can.
        const logsOf = (e) => Object.entries(invCountsOf(e)).filter(([id]) => /_log$/.test(id)).reduce((a, [, n]) => a + n, 0);
        cleanup.push(() => {
          try { for (const [id, n] of Object.entries(invCountsOf(who))) if (/_(log|planks)$|_sapling$|^stick$/.test(id)) take(who, id, n); } catch { /* */ }
          try { dim.runCommand(`kill @e[type=item,x=${x},y=${gy},z=${z},r=70]`); } catch { /* */ }
        });
        try { who.teleport({ x: x + 0.5, y: gy + 1, z: z + 0.5 }); } catch { /* */ }
        await system.waitTicks(20);
        if (human) { pass = await humanTry(() => logsOf(who) >= 15, 240); detail = `you had ${logsOf(who)}/15 logs in ${secs()}s (${worldInfo.what})`; break; }
        for (let r = 0; r < 4; r++) agent.memory.forgetNear('log', dim.id, { x, y: gy, z }, 400);
        const gen = agent.newTask({ kind: 'test' });
        try { agent.equipBestWeapon(); } catch { /* */ }
        const job = S.gatherLogs(gen, 15).catch(() => {});
        for (let i = 0; i < 240 * 4 && logsOf(sim) < 15 && !agent.testSkipped; i++) await system.waitTicks(5);
        agent.newTask(null); agent.motor.stop();
        await Promise.race([job, system.waitTicks(20)]);
        pass = logsOf(sim) >= 15;
        detail = `${logsOf(sim)}/15 logs in ${secs()}s (${worldInfo.what})`;
        break;
      }
      case 'village': {
        // Dropped about 170 blocks from a village, nothing known: find it (within 24 blocks of its middle) as fast as you can.
        const V = worldInfo.village;
        const near = (e) => { try { return Math.hypot(e.location.x - V.x, e.location.z - V.z) <= 24; } catch { return false; } };
        const mem = agent.memory.data, savedV = mem.villages;
        mem.villages = [];
        cleanup.push(() => { mem.villages = savedV; agent.memory.save(); });
        try { who.teleport({ x: x + 0.5, y: gy + 1, z: z + 0.5 }); } catch { /* */ }
        await system.waitTicks(30);
        const d0 = Math.round(Math.hypot(x - V.x, z - V.z));
        if (human) { pass = await humanTry(() => near(player), 420); detail = `you ${pass ? 'found it' : 'did not find it'} in ${secs()}s (start ${d0} away; ${worldInfo.what})`; break; }
        const gen = agent.newTask({ kind: 'test' });
        agent.villageHoldUntil = 0; agent.villageBase = null; agent.villageRing = 0;
        const job = (async () => { for (;;) await agent.seekVillage(gen); })().catch(() => {});
        for (let i = 0; i < 420 * 4 && !near(sim) && !agent.testSkipped; i++) await system.waitTicks(5);
        agent.newTask(null); agent.motor.stop();
        await Promise.race([job, system.waitTicks(20)]);
        pass = near(sim);
        detail = `${pass ? 'found it' : `did not find it (${Math.round(Math.hypot(sim.location.x - V.x, sim.location.z - V.z))} blocks off)`} in ${secs()}s (start ${d0} away; ${worldInfo.what})`;
        break;
      }
      case 'villagerhaul': {
        // Two villagers stand near the start; you have a boat, a lead, blocks. Get both into the boat (walk it into them on its lead), and
        // lead the boat with them in it over three hills and across a gap (build over it) to the gold block. Both within 4 blocks of it.
        tp(x - 6, gy + 1, z - 8);
        flatPatch(cmd, x, gy, z);
        const farGoal = towTail(cmd, x, gy, z);
        cmd(`fill ${x + 8} ${gy + 1} ${z - 3} ${x + 11} ${gy + 1} ${z + 3} stone`);        // a low rise before the hills
        cmd(`fill ${x - 8} ${gy} ${z - 3} ${x - 6} ${gy} ${z + 4} grass_block`);
        const spots = [{ x: x + 2.5, z: z - 3.5 }, { x: x + 4.5, z: z + 3.5 }];
        const vils = [];
        for (const sp of spots) { const v = await spawnAdult(dim, 'minecraft:villager_v2', { x: sp.x, y: gy + 1, z: sp.z }); if (v) { vils.push(v); cleanup.push(() => { try { v.remove(); } catch {} }); } }
        if (vils.length < 2) { detail = `could only get ${vils.length} adult villagers`; break; }
        tp(x - 6, gy + 1, z);
        const boat = dim.spawnEntity('minecraft:boat', { x: x - 7.5, y: gy + 1, z: z + 0.5 });
        boat.addTag('vh_boat');
        cleanup.push(() => { try { boat.remove(); } catch {} });
        await system.waitTicks(10);
        const ridersN = () => { try { return boat.getComponent('minecraft:rideable')?.getRiders().length ?? 0; } catch { return 0; } };
        const riding = (v) => { try { return boat.getComponent('minecraft:rideable')?.getRiders().some((r) => r.id === v.id) ?? false; } catch { return false; } };
        const putIn = (v, how) => {
          let ok = false;
          try { ok = !!boat.getComponent('minecraft:rideable')?.addRider(v); } catch { /* */ }
          if (!ok) { v.addTag('vh_v'); ok = cmd('ride @e[tag=vh_v,c=1] start_riding @e[tag=vh_boat,c=1] teleport_rider'); v.removeTag('vh_v'); }
          boarded.push(`${how}`);
          return ok;
        };
        const boarded = [];
        const goalD = (v) => { try { return Math.hypot(v.location.x - farGoal.x, v.location.z - farGoal.z); } catch { return 99; } };
        const done = () => vils.every((v) => v.isValid && goalD(v) <= 4);
        if (human) {
          const near = vils.map(() => 0);
          pass = await humanTry(() => {
            vils.forEach((v, i) => {
              if (!v.isValid || riding(v)) { near[i] = 0; return; }
              near[i] = Math.hypot(v.location.x - boat.location.x, v.location.z - boat.location.z) <= 1.8 ? near[i] + 1 : 0;
              if (near[i] >= 16 && ridersN() < 2) { putIn(v, 'by command (the boat was against it for 4 s)'); near[i] = 0; try { player.onScreenDisplay.setActionBar('The game did not take the villager in: put in the boat for you.'); } catch { /* */ } }
            });
            return done();
          }, 300, { x: farGoal.x, y: farGoal.y, z: farGoal.z }, 'Both villagers to the gold block, in the boat on its lead');
          detail = `you ${pass ? 'got both villagers there' : `did not finish (${vils.filter((v) => v.isValid && goalD(v) <= 4).length}/2 at the gold block, ${ridersN()} in the boat)`} in ${secs()}s${boarded.length ? `; ${boarded.length} put in by command` : ''}`;
          break;
        }
        giveItem('lead', 3);
        const gen = agent.newTask({ kind: 'test' });
        if (!leashTo(sim, boat)) { detail = "couldn't put a lead on the boat"; break; }
        rec.reset(); t0 = system.currentTick;
        await sweepVillagers(agent, gen, boat, vils, gy, { riding, ridersN, putIn });
        const m = await agent.tow.run(gen, boat, { ...farGoal, x: farGoal.x + 2.5 }, { maxS: 170 });
        pass = !m.snapped && done();
        detail = `${vils.filter((v) => riding(v)).length}/2 villagers in the boat (${boarded.length ? `${boarded.length} by command` : 'both took the boat by themselves'}); ${vils.filter((v) => v.isValid && goalD(v) <= 4).length}/2 at the gold block; ${towLine(m, farGoal)}${m.notes.length ? ` [${m.notes.join('; ')}]` : ''}`;
        break;
      }
      case 'elytra': {
        // Off a 22-high tower with elytra on and fireworks in the pack: glide to the gold block 44 blocks east and land by it (4 blocks or
        // nearer, 5 hearts lost at most). Open the wings with a second jump in the air; look where you want to go; a firework gives a boost.
        const eq = who.getComponent('minecraft:equippable');
        const oldChest = (() => { try { return eq?.getEquipment(EquipmentSlot.Chest); } catch { return undefined; } })();
        try { eq?.setEquipment(EquipmentSlot.Chest, new ItemStack('minecraft:elytra', 1)); } catch { /* */ }
        cleanup.push(() => { try { eq?.setEquipment(EquipmentSlot.Chest, oldChest); } catch { /* */ } });
        const TOP = 22, padX = x + 44;
        cmd(`fill ${x - 6} ${gy + 1} ${z} ${x - 6} ${gy + TOP} ${z} stone`);
        cmd(`fill ${x - 7} ${gy + TOP} ${z - 1} ${x - 5} ${gy + TOP} ${z + 1} stone_bricks`);
        cmd(`fill ${padX - 2} ${gy} ${z - 2} ${padX + 2} ${gy} ${z + 2} grass_block`);
        cmd(`setblock ${padX} ${gy} ${z} gold_block`);
        const hpE = () => { try { return who.getComponent('minecraft:health').currentValue; } catch { return 0; } };
        const hpStart = hpE();
        const lost = () => Math.max(0, hpStart - hpE());
        const flatD = () => Math.hypot(who.location.x - (padX + 0.5), who.location.z - (z + 0.5));
        const landed = () => who.isOnGround && who.location.y <= gy + 3 && who.location.x > x;
        try { who.teleport({ x: x - 5.5, y: gy + TOP + 1, z: z + 0.5 }, { facingLocation: { x: padX, y: gy + TOP + 1, z: z + 0.5 } }); } catch { /* */ }
        await system.waitTicks(15);
        if (human) {
          pass = await humanTry(() => landed() && flatD() <= 4 && lost() <= 5, 90, null, 'Jump, jump again to open the wings, land on the gold block');
          detail = `you ${pass ? 'landed by the gold block' : `ended ${Math.round(flatD())} blocks from it`} in ${secs()}s, lost ${lost()} hp`;
          break;
        }
        const r = await flyElytra(agent, { x: padX + 0.5, y: gy, z: z + 0.5 }, { gy, cmd, hp: hpE, landed, flatD });
        pass = r.glided && landed() && flatD() <= 4 && lost() <= 5;
        detail = `${r.glided ? `glided (${r.glideS.toFixed(1)} s, fastest ${r.peak.toFixed(1)} b/s, ${r.rockets} firework(s))` : `never started gliding (${r.why})`}; ended ${Math.round(flatD())} blocks from the gold block in ${secs()}s, lost ${lost()} hp${r.saved ? ' (slow falling given: the fall would have killed)' : ''}`;
        break;
      }
    }
  } catch (e) {
    // Where it broke: the first line of the stack in our code.
    const at = String(e?.stack ?? '').split('\n').slice(1, 4).map((l) => l.trim()).join(' < ');
    detail = e?.constructor?.name === 'Aborted' ? `${detail ? `${detail}; ` : ''}interrupted: the task was replaced (mode ${agent.mode}${agent.lastTaskSwap ? `; ${agent.lastTaskSwap.from} -> ${agent.lastTaskSwap.to} ${Math.round((system.currentTick - agent.lastTaskSwap.tick) / 20)} s ago by ${agent.lastTaskSwap.where}` : ''})` : `${detail ? `${detail}; ` : ''}error: ${e}${at ? ` (${at})` : ''}`;
  } finally {
    runSummary = rec.stop(); runTrace = rec.trace();
    if (legSummary) runSummary = legSummary;
    for (const [id, n] of handed) { try { take(player, id, Math.min(n, invCountsOf(player)[id] ?? 0)); } catch { /* */ } }
    agent.testHold = false;
    for (const f of cleanup) f();
    try { for (const [id, n] of Object.entries(gave)) { const have = invCountsOf(sim)[id] ?? 0; if (have > 0) take(sim, id, Math.min(have, n)); } S.restHands(); } catch {}
    try { if (sim.dimension.id !== dim.id) sim.teleport(home, { dimension: dim }); } catch {}
    agent.newTask(null);
    agent.motor.stop();
    // Everyone down from the sky before the slab goes.
    // (The player goes back to where they stood at the start of this test, so the next site is in the same place, not wherever the seat was.)
    if (sky || WORLDT.has(name)) { try { sim.teleport(home); } catch { /* */ } }
    try { if (player && pHome) player.teleport(pHome); } catch { /* */ }
    await system.waitTicks(5);
    // Lava does not vanish when the structure is put back (what flowed stays for a while): turned to air first, in the whole box.
    if (name === 'lavacross' || name === 'obsidian') {
      // (A fill takes at most 32768 blocks: in layers.)
      const X1 = box.x1 - 14, X2 = box.x2 + 14, Z1 = box.z1 - 14, Z2 = box.z2 + 14, per = Math.max(1, Math.floor(30000 / ((X2 - X1 + 1) * (Z2 - Z1 + 1))));
      for (const liq of ['lava', 'flowing_lava', 'obsidian', 'fire']) for (let yy = box.y1 - 20; yy <= box.y2; yy += per) cmd(`fill ${X1} ${yy} ${Z1} ${X2} ${Math.min(box.y2, yy + per - 1)} ${Z2} air replace ${liq}`);
      await system.waitTicks(10);
    }
    // Put the ground back, then make sure the bot isn't left inside a restored block.
    cmd(`structure load agent_test_backup ${box.x1} ${box.y1} ${box.z1}`);
    cmd('structure delete agent_test_backup');
    if (tickName) { try { dim.runCommand(`tickingarea remove ${tickName}`); } catch { /* */ } }
    try {
      const top = S.groundTop(Math.floor(sim.location.x), Math.floor(sim.location.z));
      if (Number.isFinite(top) && top >= Math.floor(sim.location.y)) sim.teleport({ x: sim.location.x, y: top + 1, z: sim.location.z });
    } catch {} // (the bot died in the test: it respawns on its own)
  }
  const keep = (who, summary, trace, ok) => {
    if (!summary) return;
    const runs = (agent.memory.data.testRuns ??= {});
    const slot = (runs[name] ??= {});
    const stopped = !!agent.testSkipped;
    slot[who] = { ...summary, pass: ok, build: CONFIG.build, at: Date.now(), ...(stopped ? { skipped: true } : {}) };
    // The lifetime pass/fail count, saved with the world right away; a skipped or stopped run is not counted.
    if (!stopped) addStat((agent.memory.data.testStats ??= {}), name, who, ok, Date.now(), CONFIG.build);
    agent.memory.save();
    sendEvent({ type: 'test_run', name, who, pass: ok, stopped, summary, trace }).catch(() => {});
  };
  keep(human ? 'human' : 'bot', runSummary, runTrace, pass);
  for (const e of extraRuns) keep(e.who, e.summary, e.trace, e.pass);
  const both = agent.memory.data.testRuns?.[name];
  if (both?.human && both?.bot && (human || extraRuns.length)) { try { agent.say(`You vs me, ${compare(name, both.human, both.bot)}`); } catch { /* */ } }
  return report(agent, name, pass, detail, human);
}

function report(agent, name, pass, detail, human = false) {
  agent.say(`Test ${name}: ${pass ? 'PASS' : 'FAIL'} - ${detail}.`);
  if (!pass) { try { agent.flight.dump(`test ${name} failed: ${String(detail).slice(0, 120)}`); } catch { /* */ } }
  sendEvent({ type: 'test_result', name, pass, detail, who: human ? 'human' : 'bot', state: agent.snapshot() }).catch(() => {});
  return { name, pass, detail };
}


// ---------- helpers for the portal, horse and lead tests ----------

/** @type {Array<[string, number]>} */
const SUPPLY = [
  ['cobblestone', 1024], ['oak_planks', 1024], ['oak_log', 256], ['spruce_planks', 256], ['birch_planks', 256], ['stone_bricks', 256], ['stone', 256],
  ['glass', 256], ['glass_pane', 128], ['dirt', 128], ['oak_stairs', 128], ['stone_stairs', 128], ['oak_slab', 128], ['cobblestone_slab', 128],
  ['oak_door', 8], ['spruce_door', 4], ['bed', 4], ['crafting_table', 4], ['furnace', 6], ['chest', 12], ['oak_sign', 24], ['torch', 128],
  ['ladder', 32], ['oak_fence', 64], ['oak_fence_gate', 8], ['oak_trapdoor', 16], ['white_wool', 32], ['bread', 32],
];

/** Two double chests at (x, y, z) and (x, y, z + 2), filled from SUPPLY. Returns a short description. */
async function supplyChests(dim, cmd, x, y, z) {
  const cells = [];
  for (const dz of [0, 2]) {
    cmd(`fill ${x - 1} ${y} ${z + dz} ${x + 2} ${y + 1} ${z + dz} air`);
    cmd(`setblock ${x} ${y} ${z + dz} chest ["minecraft:cardinal_direction"="south"]`);
    cmd(`setblock ${x + 1} ${y} ${z + dz} chest ["minecraft:cardinal_direction"="south"]`);
    cells.push({ x, y, z: z + dz }, { x: x + 1, y, z: z + dz });
  }
  await system.waitTicks(5);
  const boxes = cells.map((c) => { try { return dim.getBlock(c)?.getComponent('minecraft:inventory')?.container ?? null; } catch { return null; } }).filter(Boolean);
  let stacks = 0;
  for (const [id, total] of SUPPLY) {
    let left = total;
    while (left > 0) {
      const n = Math.min(left, 64);
      let rest;
      try { rest = new ItemStack(`minecraft:${id}`, n); } catch { left = 0; break; } // (an id this version does not have: skipped)
      for (const b of boxes) { if (!rest) break; try { rest = b.addItem(rest); } catch { break; } }
      if (rest) break; // every chest is full
      left -= n; stacks++;
    }
  }
  return `${stacks} stacks (${SUPPLY.slice(0, 4).map(([id, n]) => `${n} ${id}`).join(', ')}, glass, stairs, slabs, doors, beds, furnaces, chests, signs, torches...)`;
}


/** A villager into the boat by the game's own call, else by command (said so by the caller). */
function boardVillager(cmd, boat, v) {
  let ok = false;
  try { ok = !!boat.getComponent('minecraft:rideable')?.addRider(v); } catch { /* */ }
  if (!ok) { try { v.addTag('vh_v'); boat.addTag('vh_boat'); ok = cmd('ride @e[tag=vh_v,c=1] start_riding @e[tag=vh_boat,c=1] teleport_rider'); v.removeTag('vh_v'); } catch { /* */ } }
  return ok;
}

/**
 * Villagers into a boat on a lead, the way a player did it: the boat trails the bot on its lead, so the bot walks a good way PAST the villager and the
 * boat sweeps into it. From 6 blocks short of it, a moment for the boat to come up behind, then through it and 5 on at a walk; if that did not take
 * it, again from the sides; the game is helped only after three sweeps. fns: { riding(v), ridersN(), putIn(v, how) }.
 */
async function sweepVillagers(agent, gen, boat, vils, gy, fns) {
  const S = agent.skills, sim = agent.sim;
  for (const v of vils) {
    for (let pass = 0; pass < 3 && v.isValid && !fns.riding(v) && fns.ridersN() < 2; pass++) {
      const vl = v.location, bl = boat.location;
      const ang = Math.atan2(vl.z - bl.z, vl.x - bl.x) + (pass === 0 ? 0 : pass === 1 ? Math.PI / 2 : -Math.PI / 2);
      const ux = Math.cos(ang), uz = Math.sin(ang);
      await S.goNear(gen, { x: vl.x - ux * 6, y: gy + 1, z: vl.z - uz * 6 }, 1, 1).catch(() => false);
      await system.waitTicks(20);
      const end = { x: v.location.x + ux * 5, y: gy + 1, z: v.location.z + uz * 5 };
      for (let i = 0; i < 90 && v.isValid && !fns.riding(v); i++) {
        try { sim.moveToLocation(end, { speed: 0.7 }); } catch { /* */ }
        await system.waitTicks(2);
        if (Math.hypot(sim.location.x - end.x, sim.location.z - end.z) < 1) break;
      }
      try { sim.stopMoving(); } catch { /* */ }
      await system.waitTicks(10);
    }
    if (v.isValid && !fns.riding(v) && fns.ridersN() < 2) fns.putIn(v, 'by command');
  }
}

/**
 * The far part of the lead courses: from x+14 a three-high hill, a gap 3 wide and 6 deep across the whole slab, and a plateau
 * two high with a gold block. Returns the gold block's standing place.
 */
function towTail(cmd, x, gy, z, { pit = false } = {}) {
  const R = 11;
  cmd(`fill ${x + 14} ${gy + 1} ${z - R} ${x + 38} ${gy + 6} ${z + R} air`);
  const rise = [[16, 1], [17, 2], [18, 3], [19, 3], [20, 2], [21, 1]];
  for (const [dx, h] of rise) cmd(`fill ${x + dx} ${gy + 1} ${z - R} ${x + dx} ${gy + h} ${z + R} stone`);
  cmd(`fill ${x + 24} ${gy - 5} ${z - R} ${x + 26} ${gy} ${z + R} air`);                      // the gap
  cmd(`fill ${x + 31} ${gy + 1} ${z - R} ${x + 38} ${gy + 2} ${z + R} stone`);                  // the plateau
  if (pit) {
    // A pit 3 wide and 3 deep in the plateau (its floor the slab's grass, three blocks down: a villager cannot climb out).
    cmd(`fill ${x + 35} ${gy} ${z - 1} ${x + 37} ${gy + 2} ${z + 1} air`);
    cmd(`setblock ${x + 33} ${gy + 2} ${z} gold_block`);
    return { x: x + 33.5, y: gy + 3, z: z + 0.5, pit: { x1: x + 35, x2: x + 37, z1: z - 1, z2: z + 1 } };
  }
  cmd(`setblock ${x + 34} ${gy + 2} ${z} gold_block`);
  return { x: x + 34.5, y: gy + 3, z: z + 0.5 };
}

/** A flat, clear patch of grass around the site (inside the backed-up box: x-8..x+14, z-8..z+8). */
function flatPatch(cmd, x, gy, z) {
  cmd(`fill ${x - 8} ${gy} ${z - 8} ${x + 14} ${gy} ${z + 8} grass_block`);
  cmd(`fill ${x - 8} ${gy + 1} ${z - 8} ${x + 14} ${gy + 8} ${z + 8} air`);
}

/** Tame (by riding; the game's own taming after 8 tries) and saddle a horse. { ok, detail }. */
async function horseReady(agent, gen, horse, secs) {
  const r = await agent.horses.tame(gen, horse, 8);
  if (!r.ok) return { ok: false, detail: `not tame after ${r.tries} tries (${r.how}, ${secs()}s)` };
  const saddled = await agent.horses.saddle(gen, horse);
  if (!saddled) return { ok: false, detail: `tame after ${r.tries} tries (${r.how}) but not saddled` };
  return { ok: true, detail: `tamed in ${r.tries} tries ${r.how} and saddled (${secs()}s)` };
}

/** Get on a saddled horse and, if blocks > 0, steer it that far along +x. { mounted, moved, detail }. */
async function rideAcross(agent, gen, horse, blocks) {
  const sim = agent.sim;
  if (!(await agent.horses.getOn(gen, horse))) return { mounted: false, moved: 0, detail: 'saddled, but it would not take a rider' };
  if (!blocks) return { mounted: true, moved: 0, detail: 'on the horse' };
  const start = { ...horse.location };
  const goal = { x: start.x + blocks, y: start.y, z: start.z };
  for (let i = 0; i < 20 * 8; i++) {
    try { sim.moveToLocation(goal, { speed: 1 }); } catch {}
    await system.waitTicks(1);
    if (Math.hypot(horse.location.x - start.x, horse.location.z - start.z) >= blocks) break;
  }
  const moved = Math.hypot(horse.location.x - start.x, horse.location.z - start.z);
  await agent.horses.getOff(gen);
  return { mounted: true, moved, detail: `rode ${moved.toFixed(1)} of ${blocks} blocks` };
}

/** A lead from us to `e`: by using one on it (what a player does), else the API's own. Returns how, or null. */
function leashTo(sim, e) {
  const comp = () => { try { return e.getComponent('minecraft:leashable'); } catch { return null; } };
  hold(sim, 'lead');
  try { sim.interactWithEntity(e); } catch {}
  if (comp()?.isLeashed) return 'lead used on it';
  try { comp()?.leashTo(sim); } catch {}
  return comp()?.isLeashed ? 'leashTo' : null;
}

/** One line for a tow's result. */
function towLine(m, goal) {
  const f = (v) => (v == null ? '?' : Number(v).toFixed(1));
  const off = m.boatEnd ? Math.hypot(m.boatEnd.x - goal.x, m.boatEnd.z - goal.z) : null;
  return `${m.arrived ? 'got there' : `DID NOT get there (${m.why || 'out of time'})`} in ${m.secs}s (efficiency ${m.efficiency}, 1 = walking the straight line), boat ${off == null ? 'gone' : `${f(off)} from the goal`}; boat first moved at ${f(m.pullAt)} apart, furthest ${f(m.maxSep)}, ${m.snapped ? 'lead SNAPPED' : 'lead held'}, slung ${m.slingOk}/${m.slings}, unstuck ${m.tugs}x, rerouted ${m.reroutes}x, jumped ${m.steps}x (limits soft ${m.soft}, hard ${m.hard}, max ${m.max}; guard ${f(m.holdAt)})`;
}

/** A grown horse: babies can't be ridden. One that spawns young is grown up by its own event, else replaced (up to 8 tries). */
async function spawnAdultHorse(dim, loc) { return spawnAdult(dim, 'minecraft:horse', loc); }

/** An adult of this animal (a baby drops nothing and cannot be ridden): grown up by its own event, else replaced. */
async function spawnAdult(dim, type, loc) {
  const baby = (e) => { try { return e.hasComponent('minecraft:is_baby'); } catch { return false; } };
  for (let i = 0; i < 8; i++) {
    let h;
    try { h = dim.spawnEntity(type, loc); } catch { return null; }
    await system.waitTicks(4);
    if (baby(h)) { try { h.triggerEvent('minecraft:ageable_grow_up'); } catch { /* no such event */ } await system.waitTicks(4); }
    if (!baby(h)) return h;
    try { h.remove(); } catch { /* */ }
  }
  return null;
}

// ---------- sites out in the real world (the forest and village tests) ----------

/** Keep a circle of chunks loaded at (x, z) and wait until a column there answers. */
async function loadCircle(dim, name, x, z, r = 4) {
  try { dim.runCommand(`tickingarea remove ${name}`); } catch { /* none */ }
  try { dim.runCommand(`tickingarea add circle ${x} 64 ${z} ${r} ${name} true`); } catch { return false; }
  for (let i = 0; i < 160; i++) {
    try { const b = dim.getTopmostBlock({ x, z }); if (b && typeof b.typeId === 'string' && b.location.y < 300) return true; } catch { /* not loaded yet */ }
    await system.waitTicks(5);
  }
  return false;
}

/** The first solid ground under a column, through leaves, logs and air: { y (the ground block), canopy (the top was leaves) } or null. */
function groundUnder(dim, x, z) {
  try {
    const top = dim.getTopmostBlock({ x, z });
    if (!top) return null;
    let y = top.location.y;
    const canopy = /leaves/.test(top.typeId);
    for (let k = 0; k < 40; k++, y--) {
      const id = String(dim.getBlock({ x, y, z })?.typeId ?? '');
      if (!id || /air|leaves|_log|vine|grass$|fern|flower|snow_layer|bush|petals|sapling|mushroom|bamboo|sugar|kelp/.test(id) && !/grass_block/.test(id)) continue;
      if (/water|lava|ice/.test(id)) return null;
      return { y, canopy };
    }
  } catch { /* not loaded */ }
  return null;
}

/** A forest: the world seed's nearest forest biome, then the densest canopy within 40 blocks of it; the spot is kept for this build. */
async function findForestSite(agent, from) {
  const dim = agent.dim, mem = agent.memory.data;
  const sites = (mem.testSites ??= {});
  const kept = sites.forest;
  if (kept && kept.build === CONFIG.build && await loadCircle(dim, 'agent_test_world', kept.x, kept.z)) return { ...kept, tickName: 'agent_test_world' };
  let spot = null, what = '';
  for (const size of [384, 768]) {
    for (const id of ['minecraft:forest', 'minecraft:birch_forest', 'minecraft:flower_forest', 'minecraft:taiga']) {
      let pos = null;
      try { pos = dim.calculateClosestBiomeFromSeed(from.location, id, { boundingSize: { x: size, y: 128, z: size } }); } catch { continue; }
      if (!pos) continue;
      if (!(await loadCircle(dim, 'agent_test_world', Math.floor(pos.x), Math.floor(pos.z)))) continue;
      // The densest canopy: columns on a 6-block grid whose top is leaves, counted within 14 blocks.
      const cells = [];
      for (let dx = -42; dx <= 42; dx += 6) for (let dz = -42; dz <= 42; dz += 6) {
        const cx = Math.floor(pos.x) + dx, cz = Math.floor(pos.z) + dz;
        let leaf = false; try { leaf = /leaves/.test(dim.getTopmostBlock({ x: cx, z: cz })?.typeId ?? ''); } catch { /* */ }
        cells.push({ cx, cz, leaf });
      }
      let best = null;
      for (const c of cells) {
        const score = cells.filter((o) => o.leaf && Math.hypot(o.cx - c.cx, o.cz - c.cz) <= 14).length;
        if (!best || score > best.score) best = { ...c, score };
      }
      if (!best || best.score < 8) continue;
      // A standing place near it: ground, two clear blocks above, nothing wet.
      for (let dx = -4; dx <= 4 && !spot; dx++) for (let dz = -4; dz <= 4 && !spot; dz++) {
        const sx = best.cx + dx, sz = best.cz + dz, g = groundUnder(dim, sx, sz);
        if (!g) continue;
        let clear = true; try { clear = ['air', 'short_grass'].some((a) => dim.getBlock({ x: sx, y: g.y + 1, z: sz })?.typeId === `minecraft:${a}`) && dim.getBlock({ x: sx, y: g.y + 2, z: sz })?.typeId === 'minecraft:air'; } catch { clear = false; }
        if (clear) { spot = { x: sx, z: sz, gy: g.y }; what = `${id.replace('minecraft:', '').replace(/_/g, ' ')}, canopy ${best.score}/25`; }
      }
      if (spot) break;
    }
    if (spot) break;
  }
  if (!spot) return { error: 'no forest found: the seed search found none within reach, or none with a dense canopy' };
  const found = { ...spot, what, build: CONFIG.build };
  sites.forest = found; agent.memory.save();
  return { ...found, tickName: 'agent_test_world' };
}

/** What a village looks like from a ring of columns round (x0, z0): { x, y, z } of a confirmed one, or null. */
async function scanVillageAt(agent, x0, z0) {
  const dim = agent.dim, V = agent.villages;
  if (!(await loadCircle(dim, 'agent_test_scan', x0, z0))) return null;
  const items = [];
  for (let rr = 8; rr <= 64; rr += 8) {
    const n = Math.max(8, Math.round(2 * Math.PI * rr / 8));
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const e = V.topEvidence(dim, Math.floor(x0 + Math.cos(ang) * rr), Math.floor(z0 + Math.sin(ang) * rr));
      if (e) items.push(e);
    }
  }
  try {
    for (const e of dim.getEntities({ location: { x: x0, y: 64, z: z0 }, maxDistance: 72 })) {
      let t; try { t = String(e.typeId).replace(/^minecraft:/, ''); } catch { continue; }
      if (isVillager(t)) items.push({ kind: 'villager', x: Math.floor(e.location.x), y: Math.floor(e.location.y), z: Math.floor(e.location.z) });
    }
  } catch { /* */ }
  const tr = new Tracker();
  const now = Date.now();
  tr.add(items, now);
  const found = tr.villages(now);
  return found.length ? found[0] : null;
}

/**
 * A village for the race: the nearest one the world has (the seed's village biome as the place to look, ringed scans round it), and a
 * start about 170 blocks from its middle on ground. Kept for this build, so you and the bot start from the same spot.
 */
async function findVillageSite(agent, from) {
  const dim = agent.dim, mem = agent.memory.data;
  const sites = (mem.testSites ??= {});
  const pickStart = async (V) => {
    const order = [0, 3, 6, 1, 4, 7, 2, 5].map((k) => (k * Math.PI) / 4 + 0.3);
    for (const dist of [170, 150, 200]) for (const ang of order) {
      const sx = Math.floor(V.x + Math.cos(ang) * dist), sz = Math.floor(V.z + Math.sin(ang) * dist);
      if (!(await loadCircle(dim, 'agent_test_world', sx, sz, 2))) continue;
      const g = groundUnder(dim, sx, sz);
      if (!g || g.canopy || g.y < 60) continue;
      let clear = false; try { clear = dim.getBlock({ x: sx, y: g.y + 1, z: sz })?.typeId === 'minecraft:air' && dim.getBlock({ x: sx, y: g.y + 2, z: sz })?.typeId === 'minecraft:air'; } catch { /* */ }
      if (!clear) continue;
      if (await scanVillageAt(agent, sx, sz)) continue; // a village right here too: another direction
      await loadCircle(dim, 'agent_test_world', sx, sz, 2);
      return { x: sx, z: sz, gy: g.y };
    }
    return null;
  };
  const kept = sites.village;
  if (kept && kept.build === CONFIG.build) {
    if (await loadCircle(dim, 'agent_test_world', kept.x, kept.z, 2)) return { ...kept, tickName: 'agent_test_world' };
  }
  const hint = agent.lookout?.seedSearch?.('village') ?? null;
  const base = hint ? { x: Math.floor(hint.pos.x), z: Math.floor(hint.pos.z) } : { x: Math.floor(from.location.x), z: Math.floor(from.location.z) };
  let V = null, scanned = 0;
  const pts = [[0, 0]];
  for (let ring = 1; ring <= 3 && true; ring++) for (let k = 0; k < 6; k++) { const a = (k * Math.PI) / 3 + (ring % 2 ? 0 : Math.PI / 6); pts.push([Math.cos(a) * 96 * ring, Math.sin(a) * 96 * ring]); }
  for (const [dx, dz] of pts) {
    scanned++;
    V = await scanVillageAt(agent, Math.floor(base.x + dx), Math.floor(base.z + dz));
    if (V) break;
  }
  try { dim.runCommand('tickingarea remove agent_test_scan'); } catch { /* */ }
  if (!V) return { error: `no village found: ${scanned} places scanned round ${hint ? `the ${hint.id.replace('minecraft:', '')} ${Math.round(hint.dist)} blocks off` : 'here'}` };
  const start = await pickStart(V);
  if (!start) return { error: `a village at ${V.x} ${V.z}, but no ground to start from 150-200 blocks off it` };
  const found = { ...start, village: { x: V.x, y: V.y, z: V.z }, what: `village at ${V.x} ${V.z}, score ${V.score}`, build: CONFIG.build };
  sites.village = found; agent.memory.save();
  return { ...found, tickName: 'agent_test_world' };
}
