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
const { reaches, facing, edge, FREE, STAND_ON } = await import('../behavior_pack/scripts/core/farmbuild.js');
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
    taskGen: 0, task: null, suspended: null, kitHeld: false, testHold: false, saves: [], placeCalls: 0, standing: 0,
    newTask(t) { this.task = t; return ++this.taskGen; },
    saveKit() { if (this.kitHeld) return; this.saves.push(Object.entries(invCounts(this.sim)).map(([k, n]) => `${k}:${n}`).join(',')); },
    motor: { stop() {}, setFocus() {}, snap() {} },
    skills: {
      check(gen) { if (gen !== agent.taskGen) throw new Aborted(); },
      async wait(gen, n) { await MC.system.waitTicks(n); this.check(gen); },
      log() {},
      // (The fake bot's feet: it gets to any spot with a block under it and room for it, as the real one walks; the walking itself is the game's.)
      // A spot over air: a block of what it carries put under it first (a bridge or the top of a pillar), as the real one does; scaffolding.
      async walkTo(gen, cell) {
        await MC.system.waitTicks(4);
        this.check(gen);
        if (knobs.unreach && knobs.unreach(cell)) return { ok: false, placed: [], broke: [] };
        const placed = [];
        const under = { x: cell.x, y: cell.y - 1, z: cell.z };
        if (idAt(under.x, under.y, under.z) === 'air') {
          const c = container(agent.sim);
          const slot = [...Array(c.size).keys()].find((i) => /dirt|cobblestone$/.test(c.getItem(i)?.typeId ?? ''));
          if (slot === undefined) return { ok: false, placed, broke: [] };
          const it = c.getItem(slot);
          G.grid.set(key(under.x, under.y, under.z), { id: it.typeId.replace('minecraft:', '') });
          if (it.amount > 1) { it.amount--; c.setItem(slot, it); } else c.setItem(slot, undefined);
          placed.push(under); agent.scaffolded = (agent.scaffolded ?? 0) + 1;
        }
        agent.sim.location = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }; agent.standing++;
        return { ok: true, placed, broke: [] };
      },
      inReach() { return true; },
      async goNear() { return true; },
      async mine(gen, q) { G.grid.delete(key(q.x, q.y, q.z)); agent.mined = (agent.mined ?? 0) + 1; return true; },
    },
    /** One placement under a player's rules (throws on a rule the build should never ask to break); `drop` puts the block in. */
    rules(gen, cell, id, below, drop) {
      agent.skills.check(gen);
      if (knobs.miss && (knobs.miss === 1 || Math.abs(cell.x * 7 + cell.y * 13 + cell.z * 31) % knobs.miss === 0)) return false;   // (the same cells every time: a retry misses too)
      const l = agent.sim.location, s = { x: Math.floor(l.x), y: Math.floor(l.y + 0.05), z: Math.floor(l.z) };
      if (!STAND_ON.has(idAt(s.x, s.y - 1, s.z)) || !FREE.has(idAt(s.x, s.y, s.z)) || !FREE.has(idAt(s.x, s.y + 1, s.z))) throw new Error(`the bot is standing wrong at ${key(s.x, s.y, s.z)}`);
      if (idAt(cell.x, cell.y, cell.z) !== 'air') return false;
      if (!reaches(s, cell)) throw new Error(`out of reach ${key(cell.x, cell.y, cell.z)} from ${key(s.x, s.y, s.z)}`);
      if (cell.x === s.x && cell.z === s.z && (cell.y === s.y || cell.y === s.y + 1)) throw new Error('asked to place into the bot');
      if (id === SLAB && !below) throw new Error('a slab asked for without "only on the block under it"');
      if (!(!below && edge(s, cell) && !FREE.has(idAt(s.x, s.y - 1, s.z))) && !(below ? [[0, -1, 0]] : DIRS).some(([a, b, d]) => { const n = { x: cell.x + a, y: cell.y + b, z: cell.z + d }; return !FREE.has(idAt(n.x, n.y, n.z)) && facing(s, cell, n); })) throw new Error(`nothing to click for ${key(cell.x, cell.y, cell.z)} from ${key(s.x, s.y, s.z)}`);
      const c = container(agent.sim);
      const slot = [...Array(c.size).keys()].find((i) => c.getItem(i)?.typeId === `minecraft:${id}`);
      if (slot === undefined) return false;
      if (!drop()) return false;
      const it = c.getItem(slot); it.amount--; c.setItem(slot, it.amount ? it : undefined);
      agent.byWay[agent.way] = (agent.byWay[agent.way] ?? 0) + 1;
      return true;
    },
    byWay: {}, way: '',
    homestead: {
      async placeAt(gen, cell, id, via, next, opts) {
        agent.placeCalls++;
        await MC.system.waitTicks(10);
        if (knobs.stopAfter && agent.placeCalls === knobs.stopAfter) agent.newTask(null);   // someone typed "stop"
        if (!opts?.stay) throw new Error('the farm build must not let the bot walk off its spot');
        if (id === SLAB && !(via && via.y === cell.y - 1 && via.x === cell.x && via.z === cell.z)) throw new Error('a slab placed without the block under it as the face');
        agent.way = 'real';
        return agent.rules(gen, cell, id, id === SLAB, () => { G.grid.set(key(cell.x, cell.y, cell.z), { id }); return true; });
      },
      async placeQuick(gen, cell, id, put, opts) {
        agent.placeCalls++;
        const since = MC.system.currentTick - (this.quickAt ?? -100);
        await MC.system.waitTicks(Math.max(1, (opts?.gap ?? 3) - since));
        if (knobs.stopAfter && agent.placeCalls === knobs.stopAfter) agent.newTask(null);
        agent.way = 'quick';
        const r = agent.rules(gen, cell, id, !!opts?.below, () => put(cell));
        if (r) this.quickAt = MC.system.currentTick;
        return r;
      },
      async placeHeld(gen, cell, id, opts) {
        agent.placeCalls++;
        if (typeof agent.sim.startBuild !== 'function') throw new TypeError('startBuild is not a function');
        await MC.system.waitTicks(knobs.heldTicks ?? 3);
        if (knobs.stopAfter && agent.placeCalls === knobs.stopAfter) agent.newTask(null);
        agent.way = 'held';
        const ok = agent.rules(gen, cell, id, !!opts?.below, () => { G.grid.set(key(cell.x, cell.y, cell.z), { id }); return true; });
        // (knobs.heldSlip: every n-th held placement puts a second block down before it is let go, in front of the first, toward the bot)
        let extra = 0;
        if (ok && knobs.heldSlip && agent.placeCalls % knobs.heldSlip === 0) {
          const l = agent.sim.location, s = { x: Math.floor(l.x), z: Math.floor(l.z) };
          const q = { x: cell.x + Math.sign(s.x - cell.x), y: cell.y, z: cell.z + Math.sign(s.z - cell.z) };
          if ((q.x !== cell.x || q.z !== cell.z) && idAt(q.x, q.y, q.z) === 'air' && !(q.x === s.x && q.z === s.z)) { G.grid.set(key(q.x, q.y, q.z), { id }); extra = 1; }
        }
        return { ok, extra };
      },
    },
    sim: {
      location: { x: 100.5, y: 70, z: 100.5 }, dimension: MC.dimension, isValid: true,
      teleport(loc) { this.location = { x: loc.x, y: loc.y, z: loc.z }; agent.standing++; }, clearVelocity() {},
      ...(knobs.held ? { startBuild() {}, stopBuild() {} } : {}),
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
  // (u220: the lava goes in by hand once the hallway walls hold it, part way up, so it may be down at the stop; the farm is not finished either way.)
  ok(!msgs.some((l) => /Built\. The bot placed/.test(l)), 'it says it finished');
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
  ok(msgs.some((l) => /Placing by hand is not working at all/.test(l)), 'no word about it');
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

t('spots it cannot get to the first time (u218, the live run: "could not get to" and the rest by command): other spots, back later, every block by hand', async () => {
  const asked = new Map();
  const agent = makeAgent({ unreach: (c) => { const k = key(c.x, c.y, c.z), n = (asked.get(k) ?? 0) + 1; asked.set(k, n); return n === 1 && Math.abs(c.x * 7 + c.z * 3 + c.y) % 3 === 0; } });
  const msgs = await run(agent);
  const plan = ironFarmPlan();
  const bad = matches(plan, originOf(plan));
  ok(!bad.length, bad.slice(0, 3).join(' | '));
  const line = msgs.find((l) => /Built\. The bot placed/.test(l));
  ok(/placed 1193 of 1193 blocks itself \(100%\)/.test(line ?? ''), line);
  ok(!msgs.some((l) => /set with commands|by command after/.test(l)), msgs.filter((l) => /command/.test(l)).join(' | '));
});

const rateOf = (line) => Number(/([\d.]+) blocks a second while placing/.exec(line ?? '')?.[1] ?? NaN);

t('no held button in this version: the quick hand, at a player\'s pace (5 or more blocks a second while placing), every block taken from the pack', async () => {
  const agent = makeAgent();
  const msgs = await run(agent);
  ok(msgs.some((l) => /Held-button test: this version has no held button/.test(l)), 'no word on the held button');
  const line = msgs.find((l) => /Built\. The bot placed/.test(l));
  ok(/quick hand/.test(line), line);
  ok(rateOf(line) >= 5, `rate ${rateOf(line)}: ${line}`);
  ok(agent.byWay.quick > 1100 && !agent.byWay.real && !agent.byWay.held, JSON.stringify(agent.byWay));
  ok(!matches(ironFarmPlan(), originOf(ironFarmPlan())).length, 'not the plan');
});

t('"real": the game\'s own item use, a block every 10 ticks (2 a second), as before', async () => {
  const agent = makeAgent();
  const msgs = await run(agent, ['real']);
  const line = msgs.find((l) => /Built\. The bot placed/.test(l));
  ok(/game's own item use/.test(line), line);
  ok(rateOf(line) <= 2.1, `rate ${rateOf(line)}`);
  ok(agent.byWay.real > 1100 && !agent.byWay.quick, JSON.stringify(agent.byWay));
  ok(!msgs.some((l) => /Held-button test/.test(l)), 'tried the held button though "real" was asked for');
});

t('a held button the game paces like a player\'s: the test on the pad passes, the bot builds with it (no cheat), the test blocks are gone', async () => {
  const agent = makeAgent({ held: true, heldTicks: 3 });
  const msgs = await run(agent, [], { held: true });
  ok(msgs.some((l) => /Held-button test: 5 of 5 blocks went in, 3\.0 ticks a block.*no cheat/.test(l)), msgs.find((l) => /Held-button/.test(l)));
  const line = msgs.find((l) => /Built\. The bot placed/.test(l));
  ok(/held button/.test(line) && rateOf(line) >= 5, line);
  // (the edge blocks of the floors are bridged with the game's own click, "real": u220)
  ok(agent.byWay.held > 900 && (agent.byWay.held + (agent.byWay.real ?? 0)) > 1150 && !agent.byWay.quick, JSON.stringify(agent.byWay));
  ok(!matches(ironFarmPlan(), originOf(ironFarmPlan())).length, 'not the plan (the test blocks left on the pad?)');
});

t('a held button at the game\'s 10-tick pace: the test says so and the quick hand builds it', async () => {
  const agent = makeAgent({ held: true, heldTicks: 10 });
  const msgs = await run(agent);
  ok(msgs.some((l) => /Held-button test: 5 of 5 blocks went in, 10\.0 ticks a block.*So the quick hand/.test(l)), msgs.find((l) => /Held-button/.test(l)));
  ok(agent.byWay.quick > 1100, JSON.stringify(agent.byWay));
});

t('a held button that now and then puts a second block down: after three, the quick hand takes over; the strays are taken out and the farm is the plan', async () => {
  const agent = makeAgent({ held: true, heldTicks: 3, heldSlip: 50 });
  const msgs = await run(agent);
  ok(msgs.some((l) => /held button is not working out \(it put a second block down/.test(l)), 'no switch');
  ok(agent.byWay.held >= 100 && agent.byWay.quick > 150, JSON.stringify(agent.byWay));
  const bad = matches(ironFarmPlan(), originOf(ironFarmPlan()));
  ok(!bad.length, bad.slice(0, 3).join(' | '));
  // (u218: a slip into a cell of the plan that wants that block is kept as placed; only one where the plan has none is a stray, and the report says so.)
  ok(!msgs.some((l) => /blocks were left where the plan has none/.test(l)) || bad.length === 0, 'strays left');
});

t('monsters round the site are taken away while it builds; the villagers are left alone', async () => {
  const agent = makeAgent();
  reset();
  G.entities.push({ typeId: 'minecraft:zombie', id: 'z1', location: { x: 150, y: 90, z: 100 }, isValid: true, remove() { this.isValid = false; }, kill() { this.isValid = false; } });
  const msgs = await again(agent);
  ok(!G.entities[0].isValid, 'the zombie is still there');
  ok(msgs.some((l) => /1 monsters that turned up round the site were taken away/.test(l)), 'not reported');
  ok(G.entities.filter((e) => /villager/.test(e.typeId) && e.isValid).length >= 10, 'villagers gone');
  ok(agent.testHold === false, 'the bot was left unable to fight');
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
