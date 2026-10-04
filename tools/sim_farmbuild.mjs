// `!bot buildfarm` (game/farmbuild.js) run in Node against a fake world (tools/mock/server_ironfarm.mjs) and a fake bot that places blocks under a
// player's rules (in reach, against a solid neighbour whose face the eye is on, from a spot with a block under it and room to head height, taking an
// item from its pack). What this checks is the glue: the pad, the bot's things set aside and put back (and never saved as its own), the order of the
// commands for the bits that take a state, a stop and a carry-on, a bot whose hands never work, and that what is left standing is the plan. What it
// cannot say is whether the real bot's hands manage it: that is for the game.
//
//   node tools/sim_farmbuild.mjs [-v]
import { register } from 'node:module';
register('./mock/hooks_ironfarm.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { farmBuildCommand } = await import('../behavior_pack/scripts/game/farmbuild.js');
const { ironFarmCommand } = await import('../behavior_pack/scripts/game/ironfarm.js');
const { ironFarmPlan, render, LAVA, BASE_Y, SLAB } = await import('../behavior_pack/scripts/core/ironfarm.js');
const { reaches, facing, FREE, STAND_ON } = await import('../behavior_pack/scripts/core/farmbuild.js');
const { container, invCounts } = await import('../behavior_pack/scripts/game/inventory.js');
const VERBOSE = process.argv.includes('-v');
const G = globalThis.__ifw;
const key = (x, y, z) => `${x},${y},${z}`;
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

class Aborted extends Error {}
const idAt = (x, y, z) => G.grid.get(key(x, y, z))?.id ?? 'air';

/** A bot: a pack, a place, a task generation, and a pair of hands (homestead.placeAt) that keep the rules and can be made to miss. */
function makeAgent(knobs = {}) {
  const pack = new MC.Container(36);
  pack.addItem(new MC.ItemStack('iron_sword', 1));
  pack.addItem(new MC.ItemStack('bread', 12));
  const agent = {
    taskGen: 0, task: null, suspended: null, kitHeld: false, saves: [], placeCalls: 0, standing: 0,
    newTask(t) { this.task = t; return ++this.taskGen; },
    saveKit() { if (this.kitHeld) return; this.saves.push(Object.entries(invCounts(this.sim)).map(([k, n]) => `${k}:${n}`).join(',')); },
    motor: { stop() {}, setFocus() {} },
    skills: {
      check(gen) { if (gen !== agent.taskGen) throw new Aborted(); },
      async wait(gen, n) { await MC.system.waitTicks(n); this.check(gen); },
      log() {},
    },
    homestead: {
      async placeAt(gen, cell, id, via, next, opts) {
        agent.skills.check(gen);
        agent.placeCalls++;
        await MC.system.waitTicks(10);
        if (knobs.stopAfter && agent.placeCalls === knobs.stopAfter) agent.newTask(null);   // someone typed "stop"
        agent.skills.check(gen);
        if (knobs.miss && (knobs.miss === 1 || Math.abs(cell.x * 7 + cell.y * 13 + cell.z * 31) % knobs.miss === 0)) return false;   // (the same cells every time: a retry misses too)
        if (!opts?.stay) throw new Error('the farm build must not let the bot walk off its spot');
        const l = agent.sim.location, s = { x: Math.floor(l.x), y: Math.floor(l.y + 0.05), z: Math.floor(l.z) };
        if (!STAND_ON.has(idAt(s.x, s.y - 1, s.z)) || !FREE.has(idAt(s.x, s.y, s.z)) || !FREE.has(idAt(s.x, s.y + 1, s.z))) throw new Error(`the bot is standing wrong at ${key(s.x, s.y, s.z)}`);
        if (idAt(cell.x, cell.y, cell.z) !== 'air') return false;
        if (!reaches(s, cell)) throw new Error(`out of reach ${key(cell.x, cell.y, cell.z)} from ${key(s.x, s.y, s.z)}`);
        if (cell.x === s.x && cell.z === s.z && (cell.y === s.y || cell.y === s.y + 1)) throw new Error('asked to place into the bot');
        if (!DIRS.some(([a, b, d]) => { const n = { x: cell.x + a, y: cell.y + b, z: cell.z + d }; return !FREE.has(idAt(n.x, n.y, n.z)) && facing(s, cell, n); })) throw new Error(`nothing to click for ${key(cell.x, cell.y, cell.z)} from ${key(s.x, s.y, s.z)}`);
        const c = container(agent.sim);
        const slot = [...Array(c.size).keys()].find((i) => c.getItem(i)?.typeId === `minecraft:${id}`);
        if (slot === undefined) return false;
        const it = c.getItem(slot); it.amount--; c.setItem(slot, it.amount ? it : undefined);
        G.grid.set(key(cell.x, cell.y, cell.z), { id: id === SLAB ? SLAB : id });
        return true;
      },
    },
    sim: {
      location: { x: 100.5, y: 70, z: 100.5 }, dimension: MC.dimension, isValid: true,
      teleport(loc) { this.location = { x: loc.x, y: loc.y, z: loc.z }; agent.standing++; }, clearVelocity() {},
      selectedSlotIndex: 0,
      getComponent(n) {
        if (n === 'minecraft:inventory') return { container: pack };
        if (n === 'minecraft:equippable') return { getEquipment() { return undefined; }, setEquipment() {} };
        return undefined;
      },
    },
  };
  return agent;
}

let failed = 0;
const cases = [];
const t = (name, fn) => cases.push({ name, fn });
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const tele = [];
const player = { id: 'p1', location: { x: 100.5, y: 70, z: 100.5 }, dimension: MC.dimension, teleport(l) { tele.push(l); } };
G.players = [player];
const chat = () => G.log.filter((l) => l.startsWith('CHAT ')).map((l) => l.slice(5));
const settle = async (until, max = 5000) => { for (let i = 0; i < max; i++) { await new Promise((r) => setImmediate(r)); if (G.log.some((l) => until.test(l))) { await new Promise((r) => setImmediate(r)); return true; } } return false; };
function reset(knobs = {}) { G.grid.clear(); G.log.length = 0; G.tick = 0; G.entities.length = 0; G.awake.clear(); G.knobs = knobs; G.intervals.clear(); G.time = 0; tele.length = 0; }
/** Where the farm is (from its one lava block). */
const originOf = (plan) => { const e = [...G.grid].find(([, v]) => v.id === 'lava'); if (!e) return null; const [x, y, z] = e[0].split(',').map(Number); return { x: x - LAVA.x, y: y - LAVA.y, z: z - LAVA.z }; };
const WATER = /^(water|flowing_water)$/;
/** Every block of the plan is there (the platform's water aside, which flows), and nothing else but water and the pad. */
function matches(plan, o) {
  const ref = render(plan), bad = [];
  for (const [k, v] of ref.cells) {
    const [x, y, z] = k.split(',').map(Number);
    const c = G.grid.get(key(x + o.x, y + o.y, z + o.z));
    if (!c) { bad.push(`nothing at ${k}, wanted ${v.id}`); continue; }
    if (WATER.test(v.id) ? !WATER.test(c.id) : c.id !== v.id) bad.push(`${k}: ${c.id}, wanted ${v.id}`);
  }
  for (const [k, c] of G.grid) {
    const [x, y, z] = k.split(',').map(Number);
    if (ref.cells.has(key(x - o.x, y - o.y, z - o.z)) || WATER.test(c.id)) continue;
    if (c.id === 'stone' && y - o.y === BASE_Y - 1) continue;   // the pad
    if (c.id === 'torch' && y - o.y === BASE_Y) continue;       // its torches
    bad.push(`${k}: ${c.id} where the plan has nothing`);
  }
  return bad;
}
const DONE = /You are in the room at the bottom|No pad|fails its own|Build it in|Stopped at|The build failed/;
async function run(agent, args = [], knobs = {}) {
  reset(knobs);
  return again(agent, args);
}
async function again(agent, args = []) {
  G.log.length = 0;
  farmBuildCommand(agent, player, args);
  ok(await settle(DONE), `it never finished: ${chat().slice(-3).join(' | ')}`);
  return chat();
}

t('the bot builds the farm on a pad in the sky: the world is the plan, the pad is under it, the bot has its own things back and never saved the farm\'s blocks as its own', async () => {
  const agent = makeAgent();
  const mine = invCounts(agent.sim);
  const msgs = await run(agent);
  const plan = ironFarmPlan();
  const o = originOf(plan);
  ok(o, 'no farm');
  ok(o.y + BASE_Y - 1 >= 80, `the pad is at y ${o.y + BASE_Y - 1}`);
  const bad = matches(plan, o);
  ok(!bad.length, `${bad.length} wrong: ${bad.slice(0, 4).join(' | ')}`);
  ok(G.grid.get(key(o.x - 13, o.y + BASE_Y - 1, o.z - 13))?.id === 'stone' && G.grid.get(key(o.x + 28, o.y + BASE_Y - 1, o.z + 28))?.id === 'stone', 'the pad is not 42 x 42');
  const after = invCounts(agent.sim);
  ok(JSON.stringify(after) === JSON.stringify(mine), `the bot's things: ${JSON.stringify(after)} instead of ${JSON.stringify(mine)}`);
  ok(agent.saves.length >= 1 && agent.saves.every((x) => x === 'iron_sword:1,bread:12'), `kit saves: ${agent.saves.join(' / ')} (the bot's own things only, before the build and after they were put back)`);
  ok(!agent.kitHeld && agent.task === null, 'still holding the kit or still on a task');
  const line = msgs.find((l) => /Built\. The bot placed/.test(l));
  ok(line, `no report line: ${msgs.slice(-6).join(' | ')}`);
  const m = /placed (\d+) of (\d+) blocks itself/.exec(line);
  ok(m && Number(m[1]) / Number(m[2]) > 0.9, `by hand: ${m?.[0]}`);
  ok(/Everything checked out/.test(line), line);
  ok(agent.placeCalls > 1100, `${agent.placeCalls} placements`);
  ok(tele.length >= 2 && tele.at(-1).y === o.y + -6, `the player ends in the room: ${JSON.stringify(tele.at(-1))}`);
  ok(msgs.some((l) => /Water: flowing over the whole platform/.test(l)), 'no water');
  ok(msgs.some((l) => /Hallway water: running/.test(l)), 'no hallway water');
  if (VERBOSE) console.log(msgs.join('\n'));
});

t('the farm it makes is the farm "ironfarm" works on: status, golem, bill; and building again replaces it', async () => {
  const agent = makeAgent();
  await run(agent);
  G.log.length = 0;
  ironFarmCommand(player, ['status']);
  await settle(/Platform|platform|Campfires|campfire/);
  ok(!chat().some((l) => /No farm/.test(l)), 'ironfarm status says there is no farm');
  const first = originOf(ironFarmPlan());
  await again(agent, ['new']);
  const second = originOf(ironFarmPlan());
  ok(second, 'no second farm');
  const bad = matches(ironFarmPlan(), second);
  ok(!bad.some((b) => /wanted/.test(b)), bad.slice(0, 3).join(' | '));
  ok(first.x === second.x && first.y === second.y, 'a second build went somewhere else (same player spot: same place)');
});

t('"cobble" makes the walls cobblestone; the slabs are cobblestone either way', async () => {
  const agent = makeAgent();
  await run(agent, ['cobble']);
  const plan = ironFarmPlan({ shell: 'cobblestone' });
  const o = originOf(plan);
  ok(o, 'no farm');
  const bad = matches(plan, o);
  ok(!bad.length, bad.slice(0, 3).join(' | '));
  ok(![...G.grid.values()].some((c) => c.id === 'dirt'), 'dirt in a cobblestone farm');
});

t('stopped half way: the bot gets its things back at once; "buildfarm" carries on at the same place, placing only what is missing', async () => {
  const agent = makeAgent({ stopAfter: 500 });
  const mine = invCounts(agent.sim);
  const msgs = await run(agent);
  ok(msgs.some((l) => /Stopped at layer/.test(l)), `no stop report: ${msgs.slice(-3).join(' | ')}`);
  ok(JSON.stringify(invCounts(agent.sim)) === JSON.stringify(mine), 'the bot\'s things are not back');
  ok(!agent.kitHeld, 'kit still held');
  const calls = agent.placeCalls;
  const o1 = originOf(ironFarmPlan());
  ok(o1 === null, 'the lava is down before the end');
  const dirt = [...G.grid.values()].filter((c) => c.id === 'dirt').length;
  ok(dirt > 300 && dirt < 700, `${dirt} dirt after the stop`);
  const msgs2 = await again(agent);
  ok(msgs2.some((l) => /Carrying on where it stopped/.test(l)), 'did not say it carried on');
  const o = originOf(ironFarmPlan());
  const bad = matches(ironFarmPlan(), o);
  ok(!bad.length, bad.slice(0, 3).join(' | '));
  ok(agent.placeCalls - calls < 1100, `${agent.placeCalls - calls} more placements: it started over`);
  ok(JSON.stringify(invCounts(agent.sim)) === JSON.stringify(mine), 'the bot\'s things are not back after the second run');
});

t('a bot whose hands never work: it says so, sets everything by command, and the farm is the plan', async () => {
  const agent = makeAgent({ miss: 1 });
  const msgs = await run(agent);
  const plan = ironFarmPlan();
  const o = originOf(plan);
  ok(o, 'no farm');
  const bad = matches(plan, o);
  ok(!bad.length, bad.slice(0, 3).join(' | '));
  ok(msgs.some((l) => /Placing by hand is not working well enough/.test(l)), 'no word about it');
  ok(msgs.some((l) => /Built\. The bot placed 0 of/.test(l)), msgs.find((l) => /Built/.test(l)));
  ok(agent.placeCalls < 80, `${agent.placeCalls} tries before giving up`);
});

t('one block in five will not go down by hand: set by command, counted, and the farm is the plan', async () => {
  const agent = makeAgent({ miss: 5 });
  const msgs = await run(agent);
  const plan = ironFarmPlan();
  const o = originOf(plan);
  const bad = matches(plan, o);
  ok(!bad.length, bad.slice(0, 3).join(' | '));
  const line = msgs.find((l) => /Built\. The bot placed/.test(l));
  ok(/that would not go down by hand/.test(line), line);
  ok(!/gave up placing by hand/.test(line), 'gave up at a 80% hit rate');
});

t('not in the overworld: it says so and does nothing', async () => {
  const agent = makeAgent();
  reset();
  const dim = { ...MC.dimension, id: 'minecraft:nether' };
  const p2 = { ...player, dimension: dim };
  G.players = [p2];
  farmBuildCommand(agent, p2, []);
  ok(await settle(/Build it in the overworld/), 'no refusal');
  G.players = [player];
  ok(G.grid.size === 0 && agent.taskGen === 0, 'it did something');
});

t('"buildfarm status" says what is going on and "stop" when nothing is', async () => {
  const agent = makeAgent();
  reset();
  farmBuildCommand(agent, player, ['stop']);
  ok(chat().some((l) => /Not building/.test(l)), 'stop with nothing running said nothing');
  await run(agent);
  G.log.length = 0;
  farmBuildCommand(agent, player, ['status']);
  ok(chat().some((l) => /Finished: \d+ of \d+ blocks placed by the bot/.test(l)), chat().join(' | '));
});

for (const c of cases) {
  try { await c.fn(); console.log(`ok   ${c.name.slice(0, 150)}`); } catch (e) { failed++; console.log(`FAIL ${c.name.slice(0, 150)}\n     ${e.message}${VERBOSE ? `\n${e.stack}` : ''}`); }
}
console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} cases pass`);
process.exit(failed ? 1 : 0);
