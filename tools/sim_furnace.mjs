// The furnace, for real: game/homestead.js's own furnace code (ensureFurnace, startSmelt,
// collectSmelt, waitSmelt, the job list, saving and restoring it) and game/memory.js, run in Node
// against a stand-in for the game (tools/mock/server.mjs). The furnaces in it cook the Bedrock way:
// 10 s an item, fuel by core/fuel.js's burn times, a burning item finishes even with nothing to
// cook, and only while the chunk is loaded (within 64 blocks of the bot). Each case says what a
// player would expect and whether the bot got it.
//
//   node tools/sim_furnace.mjs [-v]
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Homestead } = await import('../behavior_pack/scripts/game/homestead.js');
const { WorldMemory } = await import('../behavior_pack/scripts/game/memory.js');
const { burnsFor } = await import('../behavior_pack/scripts/core/fuel.js');
const { settleStep } = await import('../behavior_pack/scripts/core/settle.js');
const { advanceStep } = await import('../behavior_pack/scripts/core/advance.js');
const { system, ItemStack, Container } = MC;
const VERBOSE = process.argv.includes('-v');

const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const PRODUCT = (id) => (id === 'raw_iron' ? 'iron_ingot' : /(_log|_wood)$/.test(id) ? 'charcoal' : { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken' }[id] ?? null);

/** A little world: furnaces (cooking the Bedrock way), the bot, and what it says. */
function makeGame() {
  const furnaces = new Map(); // key -> { pos, c: Container(3), progress, burn }
  const log = [];
  const pack = new Container(36);
  const dropped = [];
  const dim = {
    id: 'minecraft:overworld',
    getBlock: (p) => { const f = furnaces.get(key(p)); return f ? { typeId: 'minecraft:furnace', getComponent: (t) => (t === 'minecraft:inventory' ? { container: f.c } : undefined) } : undefined; },
    spawnItem: (it) => dropped.push(it),
  };
  const bot = { id: 'bot', location: { x: 0.5, y: 64, z: 0.5 }, dimension: dim, getComponent: (t) => (t === 'minecraft:inventory' ? { container: pack } : undefined) };
  // Cooking, every tick, for the furnaces whose chunk is loaded.
  let loadedRange = 64;
  MC.onTick(() => {
    for (const f of furnaces.values()) {
      if (hd(bot.location, f.pos) > loadedRange) continue;
      const input = f.c.getItem(0);
      const out = f.c.getItem(2);
      const product = input ? PRODUCT(input.typeId.replace('minecraft:', '')) : null;
      const canCook = input && product && (!out || (out.typeId === `minecraft:${product}` && out.amount < 64));
      if (f.burn <= 0 && canCook) {
        const fuel = f.c.getItem(1);
        const b = fuel ? burnsFor(fuel.typeId.replace('minecraft:', '')) : 0;
        if (b > 0) { f.burn = b * 200; fuel.amount--; f.c.setItem(1, fuel.amount ? fuel : undefined); }
      }
      if (f.burn > 0) {
        f.burn--;
        if (canCook && ++f.progress >= 200) {
          f.progress = 0;
          input.amount--; f.c.setItem(0, input.amount ? input : undefined);
          f.c.setItem(2, new ItemStack(product, (out?.amount ?? 0) + 1));
        }
      } else f.progress = 0;
    }
  });
  const walkTo = (p) => {
    // 4.3 blocks a second, the clock running as we go (furnaces load and unload on the way).
    const from = { ...bot.location }, n = Math.ceil(d3(from, p) / 4.3 * 20);
    for (let i = 1; i <= n; i++) { bot.location = { x: from.x + (p.x - from.x) * i / n, y: from.y + (p.y - from.y) * i / n, z: from.z + (p.z - from.z) * i / n }; system.advance(1); }
  };
  let camp = null;
  const S = {
    log: (m) => log.push(`${system.currentTick}: ${m}`),
    check() {},
    async wait(gen, n) { system.advance(n); },
    // One path search gets ~40 blocks; further takes travelToward first.
    async reach(gen, p) { const d = d3(bot.location, { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }); if (d > 40) return false; if (d > 3) walkTo({ x: p.x + 1.5, y: p.y, z: p.z + 0.5 }); return true; },
    async travelToward(gen, p) { walkTo({ x: p.x + 4.5, y: p.y, z: p.z + 0.5 }); return true; },
    async place(gen, id) {
      if (id !== 'furnace') return null;
      const p = { x: Math.floor(bot.location.x) + 1, y: Math.floor(bot.location.y), z: Math.floor(bot.location.z) };
      furnaces.set(key(p), { pos: p, c: new Container(3), progress: 0, burn: 0 });
      takeItem('furnace', 1);
      return p;
    },
    async mine(gen, p) {
      const f = furnaces.get(key(p));
      if (!f) return false;
      for (let i = 0; i < 3; i++) { const it = f.c.getItem(i); if (it) pack.addItem(it); } // what's in it drops, and we pick it up
      pack.addItem(new ItemStack('furnace', 1));
      furnaces.delete(key(p));
      return true;
    },
    // (Out of loading range the game can't say what's there: null.)
    blockAt: (p) => { if (hd(bot.location, p) > loadedRange) return null; const f = furnaces.get(key(p)); return f ? (f.burn > 0 ? 'lit_furnace' : 'furnace') : 'air'; },
    campFurnace: () => camp,
    isCampBlock: (p) => !!camp && key(p) === key(camp),
    isUnderground: () => bot.location.y < 50,
    nearQuarry: (p, r) => !!camp && d3(p, camp) <= r,
    inReach: () => true,
  };
  const saved = { state: null };
  const a = {
    sim: bot, skills: S, lookout: null,
    motor: { lookAt: async () => ({ status: 'aligned' }), setFocus() {} },
    say: (m) => log.push(`${system.currentTick}: says "${m}"`), sayOnce: (k, m) => log.push(`${system.currentTick}: says "${m}"`),
    // agent.saveState's jobs part: ticks left, in ms.
    saveState: () => { saved.state = H.jobs.map((j) => ({ ...j, readyInMs: Math.max(0, (j.readyAt - system.currentTick) * 50) })); },
  };
  a.memory = new WorldMemory();
  a.memory.data.res = [];
  const H = new Homestead(a);
  a.homestead = H;
  const give = (id, n) => pack.addItem(new ItemStack(id, n));
  const takeItem = (id, n) => { for (let i = 0; i < pack.size && n > 0; i++) { const it = pack.getItem(i); if (it?.typeId === `minecraft:${id}`) { const k = Math.min(n, it.amount); it.amount -= k; n -= k; pack.setItem(i, it.amount ? it : undefined); } } };
  const count = (id) => { let n = 0; for (let i = 0; i < pack.size; i++) { const it = pack.getItem(i); if (it?.typeId === `minecraft:${id}`) n += it.amount; } return n; };
  const addFurnace = (p, remember = true) => { furnaces.set(key(p), { pos: p, c: new Container(3), progress: 0, burn: 0 }); if (remember) a.memory.remember('furnace', dim.id, p); };
  // The plan's view of the furnace job, as agent.js builds it (settleFacts / advanceFacts).
  const smeltFact = () => { const j = H.planJob(); return j ? { ready: system.currentTick >= j.readyAt, kind: j.kind, n: j.n ?? 0, dist: d3(bot.location, j.pos) } : null; };
  return { H, a, S, bot, pack, dim, furnaces, log, dropped, give, count, takeItem, addFurnace, walkTo, saved, smeltFact, setCamp: (p) => { camp = p; }, setRange: (r) => { loadedRange = r; } };
}

// ---------- the cases ----------
const results = [];
const check = (name, ok, detail, g) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  if (VERBOSE && g) console.log(g.log.slice(-12).map((l) => `      ${l}`).join('\n'));
};
const gen = 0;
const house = { x: 5, y: 64, z: 5 };

// 1. Charcoal at the house furnace, stay about, collect.
{
  const g = makeGame();
  g.addFurnace(house);
  g.give('oak_log', 8); g.give('oak_planks', 8);
  await g.H.startSmelt(gen, 'log', 6, 0);
  g.S.wait(gen, 20 * 70);
  await g.H.collectSmelt(gen);
  check('charcoal, nearby, collected', g.count('charcoal') === 6 && !g.H.jobs.length, `${g.count('charcoal')} charcoal, ${g.H.jobs.length} jobs left`, g);
}

// 2. Iron in the house furnace, then off mining 150 blocks away (its chunk unloads: it stops), back
// when the job says it's done.
{
  const g = makeGame();
  g.addFurnace(house);
  g.give('raw_iron', 8); g.give('coal', 2);
  await g.H.startSmelt(gen, 'ore', 8, 0);
  const due = g.H.jobs[0].readyAt;
  g.walkTo({ x: 150, y: 64, z: 5 });
  while (system.currentTick < due) system.advance(20);
  g.walkTo({ x: house.x + 1.5, y: 64, z: house.z });
  await g.H.collectSmelt(gen);
  const first = g.count('iron_ingot');
  const job = g.H.jobs[0];
  // The plan would then wait on the rest (wait_smelt) and collect.
  if (job) { await g.H.waitSmelt(gen); }
  check('iron while away past loading range, then back', g.count('iron_ingot') === 8 && !g.H.jobs.length, `${first} ingots on getting back, then ${g.count('iron_ingot')} after waiting on the rest; ${g.H.jobs.length} jobs left`, g);
}

// 3. A server restart halfway through a batch (the tick count starts again at 0).
{
  const g = makeGame();
  g.addFurnace(house);
  g.give('oak_log', 8); g.give('oak_planks', 8);
  await g.H.startSmelt(gen, 'log', 8, 0);
  system.advance(20 * 30);
  g.a.saveState();
  system.restart();
  g.H.jobs = g.saved.state.map(({ readyInMs, ...job }) => ({ ...job, readyAt: system.currentTick + Math.ceil((readyInMs ?? 0) / 50) })); // agent.js's restore
  const ready0 = system.currentTick >= g.H.jobs[0].readyAt;
  await g.H.waitSmelt(gen);
  check('server restart mid-batch', g.count('charcoal') === 8 && !ready0 && !g.H.jobs.length, `${g.count('charcoal')} charcoal after the restart, job ${ready0 ? 'wrongly ready at once' : 'still timed right'}`, g);
}

// 4. The fuel's gone (a player took it, or planks dropped with a full pack): the batch can't finish.
{
  const g = makeGame();
  g.addFurnace(house);
  g.give('raw_iron', 8); g.give('oak_planks', 8);
  await g.H.startSmelt(gen, 'ore', 8, 0);
  system.advance(20 * 5);
  g.furnaces.get(key(house)).c.setItem(1, undefined); // fuel taken
  let rounds = 0;
  // What the plan does: collect when ready, else wait; count the rounds until there's no job.
  while (g.H.jobs.length && rounds < 6) { rounds++; if (g.smeltFact().ready) await g.H.collectSmelt(gen); else await g.H.waitSmelt(gen); }
  check('fuel gone mid-batch', !g.H.jobs.length && rounds < 6, `${rounds} wait/collect rounds, ${g.H.jobs.length ? 'still waiting on a furnace that will never finish' : 'gave the job up'}; ${g.count('iron_ingot')} ingots, ${g.count('raw_iron')} raw iron back`, g);
}

// 5. The house furnace is busy (charcoal); now food to cook, and a spare furnace in the pack.
{
  const g = makeGame();
  g.addFurnace(house);
  g.give('oak_log', 16); g.give('oak_planks', 16); g.give('beef', 4); g.give('furnace', 1);
  await g.H.startSmelt(gen, 'log', 12, 0);
  // What the plan sees: a job in the way (it waits), or none (it cooks)?
  const seen = g.smeltFact();
  let tries = 0, ok = false;
  for (; tries < 3 && !ok; tries++) ok = await g.H.startSmelt(gen, 'food', 4, 0);
  check('house furnace busy, food to cook, spare furnace carried', ok && !seen, `plan sees ${seen ? `the busy ${seen.kind} job (it would wait)` : 'no job in the way'}; ${ok ? `cooking in ${g.furnaces.size} furnaces` : `${tries} tries, each "that furnace is still going" (the spare furnace stays in the pack)`}`, g);
}

// 6. Ore cooking at the mine camp; up at the house, torches wanted (charcoal) and the house furnace
// is free. What does the plan say?
{
  const g = makeGame();
  const camp = { x: 30, y: 20, z: 5 };
  g.addFurnace(house); g.addFurnace(camp); g.setCamp(camp);
  g.bot.location = { x: camp.x + 1.5, y: camp.y, z: camp.z + 0.5 };
  g.give('raw_iron', 10); g.give('coal', 2);
  await g.H.startSmelt(gen, 'ore', 10, 0);
  g.walkTo({ x: house.x + 1.5, y: 64, z: house.z + 0.5 });
  const inv = { oak_log: 6, oak_planks: 8, stick: 4, cobblestone: 20, stone_pickaxe: 1, stone_sword: 1, stone_axe: 1, stone_shovel: 1, crafting_table: 1, bed: 1, cooked_beef: 6 };
  const f = { inv, tableDist: 3, time: 3000, furnace: { dist: 2, inHouse: true }, smelt: g.smeltFact(), house: { dist: 2, damage: 0, door: true, bed: true, table: true, furnace: true, chest: true, lit: false, litOutside: false }, sheep: false, animals: 0, armed: true, hungry: false, project: false };
  const step = settleStep(f);
  const good = step.step === 'smelt';
  check('ore at the mine camp, torches wanted at the house', good, `plan says "${step.step}"${step.step === 'wait_smelt' ? ` (the nearest job: the camp's, ${f.smelt.dist.toFixed(0)} blocks off and down the mine)` : ''}; the house furnace is free`, g);
}

// 7. The furnace blown up (a creeper) with a batch in: the job and the memory of it.
{
  const g = makeGame();
  g.addFurnace(house);
  g.give('beef', 4); g.give('oak_planks', 4);
  await g.H.startSmelt(gen, 'food', 4, 0);
  g.furnaces.delete(key(house));
  system.advance(20 * 50);
  await g.H.collectSmelt(gen);
  const remembered = g.a.memory.list('furnace', g.dim.id, g.bot.location).length;
  const p = await g.H.ensureFurnace(gen, 'food');
  check('furnace blown up mid-batch', !g.H.jobs.length && p === null, `job ${g.H.jobs.length ? 'kept' : 'dropped'}; memory had ${remembered} furnace(s) after, next pick ${p ? 'a furnace' : 'none (forgotten)'}`, g);
}

// 8. Several furnaces: the house's, one it put down out exploring (200 away), the camp's. Which does
// it use from where, and does memory keep them straight?
{
  const g = makeGame();
  const camp = { x: 30, y: 20, z: 5 }, field = { x: 205, y: 64, z: 5 };
  g.addFurnace(house); g.addFurnace(camp); g.setCamp(camp);
  g.bot.location = { x: 200.5, y: 64, z: 5.5 };
  g.give('furnace', 1); g.give('beef', 3); g.give('oak_planks', 4);
  const out = await g.H.ensureFurnace(gen, 'food');
  const placedField = out && hd(out, g.bot.location) < 4;
  g.walkTo({ x: house.x + 1.5, y: 64, z: house.z + 0.5 });
  const atHouse = await g.H.ensureFurnace(gen, 'food');
  g.walkTo({ x: camp.x + 1.5, y: camp.y, z: camp.z + 0.5 });
  const atCampOre = await g.H.ensureFurnace(gen, 'ore');
  const mem = g.a.memory.list('furnace', g.dim.id, g.bot.location).map((e) => key(e.pos));
  const ok = placedField && key(atHouse) === key(house) && key(atCampOre) === key(camp) && mem.length === 3;
  check('three furnaces: house, one out exploring, the mine camp', ok, `200 away: ${placedField ? 'put its own down' : `used ${out ? key(out) : 'none'}`}; at the house: ${key(atHouse)}; ore at the camp: ${key(atCampOre)}; remembers ${mem.length}: ${mem.join(' ')}`, g);
}

// 9. The plan and two jobs: charcoal done at the house, ore still cooking at the camp, bot at the camp.
{
  const g = makeGame();
  const camp = { x: 30, y: 20, z: 5 };
  g.addFurnace(house); g.addFurnace(camp); g.setCamp(camp);
  g.bot.location = { x: house.x + 1.5, y: 64, z: house.z + 0.5 };
  g.give('oak_log', 4); g.give('oak_planks', 4); g.give('raw_iron', 20); g.give('coal', 3);
  await g.H.startSmelt(gen, 'log', 2, 0);
  g.walkTo({ x: camp.x + 1.5, y: camp.y, z: camp.z + 0.5 });
  await g.H.startSmelt(gen, 'ore', 20, 0);
  system.advance(20 * 60); // the charcoal's long done (the house is within 64: it cooked)
  const fact = g.smeltFact();
  check('charcoal done at the house, ore cooking at the camp, bot at the camp', true, `the plan sees one job: the ${fact.kind} one (${fact.ready ? 'ready' : 'not ready'}); ${g.H.jobs.filter((j) => system.currentTick >= j.readyAt).length} of ${g.H.jobs.length} jobs are ready`, g);
}

// 10. Out hunting 81 blocks from the house with raw mutton: cook it at the house furnace (as seen in
// game: the walk fell short, the furnace's chunk wasn't loaded, and it forgot the house furnace).
{
  const g = makeGame();
  g.addFurnace(house);
  g.bot.location = { x: 86.5, y: 64, z: 5.5 };
  g.give('mutton', 6); g.give('oak_planks', 6);
  const ok = await g.H.startSmelt(gen, 'food', 6, 0);
  const still = g.a.memory.list('furnace', g.dim.id, g.bot.location).length;
  check('81 blocks from the house furnace, raw meat to cook', ok && still === 1, `${ok ? 'cooking at the house' : 'failed'}; remembers ${still} furnace(s)`, g);
}

const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} as a player would expect`);
