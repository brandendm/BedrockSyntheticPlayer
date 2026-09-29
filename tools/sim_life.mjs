// The whole game, first goal to last: game/agent.js's own planStep (the goal ladder, settling in,
// the farm and iron, side jobs, night in the mine, the trader) with the auto loop's own bookkeeping
// (a step that keeps failing set aside for 3 minutes), on a virtual clock, against a model of the
// world that plays each step out: how long it takes (walks, chopping, digging, furnaces, nights),
// whether it works (no sheep about, no trees near, a path that fails), and what happens between
// (hunger, deaths and the things lost, a creeper at the house, a player's blocks, fire).
//
// It hunts for:
//   stuck      the same step over and over with nothing changing, or a cycle of steps going nowhere
//   mismatch   the plan asking for something the world can't do (a craft it can't make, smelting
//              with no furnace, building short of blocks)
//   slow       where the time goes: by step and by milestone (stone tools, bed, house, farm, iron)
//   unfinished never getting to the last goal inside the time allowed
//
//   node tools/sim_life.mjs [runs per world=20] [-v] [--trace world seed]
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Agent } = await import('../behavior_pack/scripts/game/agent.js');
const { planCrafts, applyCraft, count, isLog, isPlanks, TOOL_STONE } = await import('../behavior_pack/scripts/core/recipes.js');
const { fittingsPlanks, isNight, chooseFood, FOODS, RAW } = await import('../behavior_pack/scripts/core/settle.js');
const { materials } = await import('../behavior_pack/scripts/core/house.js');
const { planFuel } = await import('../behavior_pack/scripts/core/fuel.js');
const { IRON_GOAL, ironHave, ARMOR } = await import('../behavior_pack/scripts/core/advance.js');
const { stepKey } = await import('../behavior_pack/scripts/core/focus.js');
const { makeRng } = await import('../behavior_pack/scripts/core/mathutil.js');
const { depositPlan } = await import('../behavior_pack/scripts/core/storage.js');
const { system, world } = MC;

const args = process.argv.slice(2);
const RUNS = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);
const VERBOSE = args.includes('-v');
const TI = args.indexOf('--trace');
const TRACE = TI >= 0 ? { world: args[TI + 1], seed: Number(args[TI + 2] ?? 1) } : null;
const HOUSE = materials();
const DAY = 20 * 60; // seconds in a Minecraft day
const LIMIT_DAYS = 12;
const NOF2 = process.env.NOF2 === '1';
const PLAN_MS = []; // how long each planStep took (the thinking between steps, in Node)
const NOSPLIT = process.env.NOSPLIT === '1'; // no splitting a batch of ore across the two // one furnace at the house (as before the food furnace)

// ---------- the worlds ----------
const WORLDS = {
  plains: { trees: 22, sheep: 0.9, animals: 0.9, stone: 30, water: true, danger: 1 },
  forest: { trees: 6, sheep: 0.5, animals: 0.7, stone: 25, water: true, danger: 1.3 },
  desert: { trees: 60, sheep: 0.1, animals: 0.2, stone: 40, water: false, danger: 1 },
  'no sheep': { trees: 10, sheep: 0, animals: 0.6, stone: 25, water: true, danger: 1 },
  griefed: { trees: 10, sheep: 0.6, animals: 0.7, stone: 25, water: true, danger: 1, grief: true },
  brutal: { trees: 10, sheep: 0.6, animals: 0.7, stone: 25, water: true, danger: 12 },
  deadly: { trees: 10, sheep: 0.6, animals: 0.7, stone: 25, water: true, danger: 4 },
  'hunting off': { trees: 10, sheep: 0.6, animals: 0.7, stone: 25, water: true, danger: 1, settings: { hunting: false } },
  junk: { trees: 10, sheep: 0.6, animals: 0.7, stone: 25, water: true, danger: 1, junk: true },
  'goals off': { trees: 10, sheep: 0.6, animals: 0.7, stone: 25, water: true, danger: 1, settings: { beds: false, torches: false, farm: false } },
};

const RAWMEAT = ['beef', 'porkchop', 'mutton', 'chicken'];
const cooked = (id) => RAW[id];

function simulate(worldName, seed) {
  const Wd = WORLDS[worldName];
  const rng = makeRng(seed * 7919 + worldName.length);
  const chance = (p) => rng() < p;
  // ---- the clock ----
  let t = 0; // seconds
  const tick = () => Math.floor(t * 20);
  const setClock = () => { system.currentTick = tick(); };
  Date.now = () => 1_700_000_000_000 + Math.floor(t * 1000);
  world.getTimeOfDay = () => (1000 + tick()) % 24000;
  const night = () => isNight(world.getTimeOfDay());
  const untilDawn = () => { const tod = world.getTimeOfDay(); return ((23300 - tod + 24000) % 24000) / 20; };
  setClock();

  // ---- the world ----
  const W = {
    inv: {}, worn: [], hunger: 20, health: 20,
    where: 'field', // 'field' (out and about), 'home', 'mine'
    tables: new Set(), // where our crafting tables are: 'field' | 'home' | 'mine'
    furnace: null,  // { where } our furnace outside the house
    house: null, project: null, jobs: [], farm: null, waterNear: Wd.water,
    quarryDepth: 0, // steps of the quarry's stairs dug toward Y 16 (0..160)
    sheepNear: chance(Wd.sheep), animalsNear: chance(Wd.animals), treesKnown: Wd.trees <= 25,
    deaths: 0, lost: 0, events: [], wear: {},
  };
  // Blocks dug wear the best pickaxe down; a worn-out one breaks.
  const wearPick = (n) => {
    // (core/costs.js: the iron pickaxe is kept for the ore that needs it; the stone ones dig.)
    const id = ['stone_pickaxe', 'wooden_pickaxe', 'iron_pickaxe'].find((k) => W.inv[k]);
    if (!id) return;
    W.wear[id] = (W.wear[id] ?? 0) + n;
    while (W.inv[id] && W.wear[id] >= MAXUSE[id]) { add(id, -1); W.wear[id] -= MAXUSE[id]; W.events.push(`${fmt(t)} ${id} broke`); }
    if (!W.inv[id]) W.wear[id] = 0;
  };
  const add = (id, n) => { W.inv[id] = (W.inv[id] ?? 0) + n; if (W.inv[id] <= 0) delete W.inv[id]; };
  const take = (pred, n) => { for (const id of Object.keys(W.inv).filter(pred)) { const k = Math.min(n, W.inv[id]); add(id, -k); n -= k; if (!n) break; } return n === 0; };
  const stacks = () => Object.entries(W.inv).reduce((a, [id, n]) => a + Math.ceil(n / (/(_pickaxe|_sword|_axe|_shovel|_hoe|_spear|bucket|bed|_door|shield|_helmet|_chestplate|_leggings|_boots)$/.test(id) ? 1 : 64)), 0);
  const DIST = { field: { field: 3, home: 40, mine: 50 }, home: { field: 40, home: 3, mine: 20 }, mine: { field: 50, home: 20, mine: 3 } };
  const tableDist = () => (W.tables.size ? Math.min(...[...W.tables].map((w) => DIST[W.where][w])) : Infinity);
  const nearestTableAt = () => [...W.tables].sort((x, y) => DIST[W.where][x] - DIST[W.where][y])[0];
  const walk = (to) => { const s = DIST[W.where][to] / 4.3; W.where = to; return s; };

  // ---- the agent: the real planner on a stand-in body ----
  const a = Object.create(Agent.prototype);
  const MAXUSE = { wooden_pickaxe: 59, stone_pickaxe: 131, iron_pickaxe: 250 };
  const inventoryOf = () => {
    const items = [];
    for (const [id, n] of Object.entries(W.inv)) {
      if (MAXUSE[id]) for (let i = 0; i < n; i++) items.push({ typeId: `minecraft:${id}`, amount: 1, getComponent: () => ({ maxDurability: MAXUSE[id], damage: i === 0 ? W.wear[id] ?? 0 : 0 }) });
      else items.push({ typeId: `minecraft:${id}`, amount: n, getComponent: () => undefined });
    }
    return { size: 36, emptySlotsCount: Math.max(0, 36 - stacks()), getItem: (i) => items[i] };
  };
  Object.assign(a, {
    sim: {
      get location() { return { x: 0, y: W.where === 'mine' ? 16 : 64, z: 0 }; },
      dimension: { id: 'minecraft:overworld' },
      getComponent: (c) => (c === 'minecraft:inventory' ? { container: inventoryOf() } : undefined),
    },
    deferred: new Map(), knownSurfaceStone: Wd.stone <= 25, miningTrip: false, bedDeferredUntil: 0,
    memory: {
      data: { settings: Wd.settings ?? {}, waterNearHouse: W.checkedWater ?? null },
      list(cat) {
        const out = [];
        if (cat === 'furnace' && W.furnace) out.push({ pos: { x: 1, y: 64, z: 1 }, dist: DIST[W.where][W.furnace.where] });
        if (cat === 'furnace' && W.house?.furnace) out.push({ pos: { x: 0, y: 64, z: 0 }, dist: DIST[W.where].home });
        if (cat === 'furnace' && W.house?.furnace2 && !NOF2) out.push({ pos: { x: 0, y: 64, z: 1 }, dist: DIST[W.where].home });
        if (cat === 'sheep' && W.sheepNear) out.push({ pos: {}, dist: 18 });
        if (cat === 'log' && W.treesKnown) out.push({ pos: {}, dist: Math.min(Wd.trees, 30) });
        if (cat === 'stone' && a.knownSurfaceStone) out.push({ pos: {}, dist: Wd.stone });
        return out.sort((x, y) => x.dist - y.dist);
      },
      nearestTable() { return W.tables.size ? { pos: { x: 0, y: 64, z: 0 }, dist: tableDist() } : null; },
      save() {},
    },
    skills: {
      isUnderground: () => W.where === 'mine',
      nearQuarry: () => W.where === 'mine' || W.where === 'home',
      campFurnace: () => (W.camp ? {} : null),
    },
    farm: { state: () => W.farm && { ...W.farm } },
  });
  a.say = a.sayOnce = () => {};
  a.health = () => W.health;
  a.worn = () => [...W.worn];
  const houseState = () => W.house && {
    layout: 'chests', damage: W.house.damage, blocked: W.house.blocked, fire: W.house.fire,
    door: W.house.door, bed: W.house.bed, bedMisplaced: false, table: W.house.table, furnace: W.house.furnace, furnace2: NOF2 ? null : W.house.furnace2,
    chest: W.house.chests >= 4, chestsPlaced: W.house.chests, signs: W.house.signs >= 4, signsPlaced: W.house.signs,
    lit: W.house.lit, litOutside: W.house.litOutside,
  };
  const shortfall = () => {
    // homestead.houseNeeds (with fittings), for a house not started: every block still to place.
    const stone = count(W.inv, (id) => TOOL_STONE.has(id)), wood = count(W.inv, isPlanks) + count(W.inv, isLog) * 4;
    const shortS = Math.max(0, HOUSE.stone - stone), shortP = Math.max(0, HOUSE.planks - wood);
    const spare = Math.max(0, stone - HOUSE.stone) + Math.max(0, wood - HOUSE.planks);
    const walls = shortS + shortP <= spare ? { stone: 0, planks: 0 } : { stone: shortS, planks: shortP };
    const fit = Math.max(0, fittingsPlanks(W.inv) + 4 - Math.max(0, wood - HOUSE.planks));
    return { stone: walls.stone, planks: walls.planks + fit };
  };
  a.homestead = {
    get house() { return W.house ? { x: 0, y: 64, z: 0, dir: 'south', layout: 'chests', ...houseState() } : null; },
    get project() { return W.project; },
    houseState, shortfall: null,
    isHome: () => !!W.house && W.where === 'home',
    // (The house's own repairs: the blocks missing against what we carry, as stone.)
    houseNeeds: () => (W.house ? { stone: Math.max(0, W.house.damage - count(W.inv, (id) => TOOL_STONE.has(id)) - count(W.inv, isPlanks) - count(W.inv, isLog) * 4), planks: 0 } : shortfall()),
    planJob: () => W.jobs.find((j) => DIST[W.where][j.where] <= 24 && tick() >= j.readyAt) ?? W.jobs.find((j) => DIST[W.where][j.where] <= 24) ?? W.jobs[0] ?? null,
    jobs: W.jobs, isCamp: () => false,
    animalsSeen: (types) => {
      if (types.has('wandering_trader')) return W.trader ? [{ d: 12 }] : [];
      if (types.has('sheep') && types.size === 1) return W.sheepNear && W.where === 'field' ? [{ d: 14 }] : [];
      return W.animalsNear && W.where === 'field' ? [{ d: 10 }] : [];
    },
    hunger: () => W.hunger,
    freeSlots: () => Math.max(0, 36 - stacks()),
    oreCooking: () => W.jobs.filter((j) => j.kind === 'ore').reduce((s, j) => s + j.n, 0),
  };
  Object.defineProperty(a.homestead, 'jobs', { get: () => W.jobs });

  // ---- bookkeeping ----
  const log = [];
  const timeBy = {};
  const milestones = {};
  const problems = [];
  const mark = (name, cond) => { if (cond && milestones[name] == null) milestones[name] = t; };
  const spend = (step, s) => { timeBy[step] = (timeBy[step] ?? 0) + s; t += s; setClock(); };
  const toolTier = (kind) => (['iron', 'stone', 'wooden'].find((m) => W.inv[`${m}_${kind}`]) ?? null);

  // Hunger and eating (homestead.maybeEat, core/settle.js chooseFood), as time passes.
  const live = (s) => {
    // (Minecraft's exhaustion: mining, sprinting, jumping and fighting, about a point a minute and a
    // half of work; waiting about, next to nothing.)
    W.hunger = Math.max(0, W.hunger - s / 90);
    if (W.hunger <= 0) W.health = Math.max(0, W.health - s / 4);
    else if (W.hunger >= 18) W.health = Math.min(20, W.health + s / 4);
    if (W.hunger <= 14 || (W.health < 16 && W.hunger < 20)) {
      const cookingSoon = W.jobs.some((j) => j.kind === 'food');
      const f = chooseFood(W.inv, { hunger: Math.floor(W.hunger), health: W.health, cookingSoon });
      if (f) { add(f, -1); W.hunger = Math.min(20, W.hunger + (FOODS[f] ?? 4)); }
    }
    if (W.health <= 0) die('starved');
  };
  const die = (why) => {
    W.deaths++;
    W.causes = [...(W.causes ?? []), why];
    W.events.push(`${fmt(t)} died (${why}) at ${W.where}; food on it: ${Object.keys(W.inv).filter((id) => id in FOODS).map((id) => `${id} ${W.inv[id]}`).join(', ') || 'none'}; wheat ${W.inv.wheat ?? 0}; hunting ${a.toggles().hunting}`);
    const kept = chance(0.65); // recoverDrops: back for its things in time
    if (!kept) { W.lost += Object.values(W.inv).reduce((s, n) => s + n, 0); W.inv = {}; W.worn = []; W.wear = {}; } // (worn armor drops too)
    W.health = 20; W.hunger = 20; W.where = W.house?.bed ? 'home' : 'field';
    if (!kept) a.miningTrip = false;
    spend('death', kept ? 90 : 20);
  };
  // Out in the dark (not home, not holed up): each minute a chance of dying, higher unarmed.
  const exposed = (s, where = W.where) => {
    if (!night() || where === 'home') return;
    const armed = /_sword/.test(Object.keys(W.inv).join());
    const perMin = (where === 'mine' ? 0.004 : 0.02) * Wd.danger * (armed ? 1 : 3) * (W.worn.length ? 0.4 : 1);
    if (chance(1 - Math.pow(1 - perMin, s / 60))) die(`mobs, ${where} at night`);
  };
  // The things that happen at the house now and then.
  const houseEvents = (s) => {
    if (!W.house) return;
    const perDay = Wd.grief ? 0.8 : 0.15;
    if (chance(perDay * s / DAY)) { const k = 3 + Math.floor(rng() * 10); W.house.damage += k; W.events.push(`${fmt(t)} creeper at the house (${k} blocks)`); if (chance(0.5)) { W.house.chests = Math.max(0, W.house.chests - 1); } }
    if (Wd.grief && chance(0.6 * s / DAY)) { const k = 2 + Math.floor(rng() * 12); W.house.blocked += k; W.events.push(`${fmt(t)} a player filled the house (${k} blocks)`); }
    if (Wd.grief && chance(0.3 * s / DAY)) { W.house.fire += 3; W.events.push(`${fmt(t)} the house caught fire`); }
    // Fire left burning eats the house.
    if (W.house.fire > 0) W.house.damage += Math.ceil(s / 20);
  };
  // A pack that fills up the way a player's does: odd stone, flowers, mob drops, whatever it walks over.
  const JUNK = ['dirt', 'andesite', 'diorite', 'granite', 'gravel', 'flint', 'poppy', 'dandelion', 'bone', 'string', 'arrow', 'rotten_flesh', 'feather', 'leather', 'sand', 'tuff', 'oak_sapling', 'birch_sapling', 'spider_eye', 'gunpowder', 'clay_ball', 'sugar_cane', 'kelp', 'pumpkin_seeds', 'beetroot_seeds', 'copper_ore', 'lapis_lazuli', 'redstone', 'deepslate', 'calcite', 'amethyst_shard', 'mossy_cobblestone'];
  const junk = (s) => { if (Wd.junk) for (let i = 0; i < s / 20; i++) if (chance(0.5)) add(JUNK[Math.floor(rng() * JUNK.length)], 1 + Math.floor(rng() * 3)); };
  const pass = (step, s) => { junk(s); spend(step, s); live(s); exposed(s); houseEvents(s); for (const j of W.jobs) if (tick() >= j.readyAt) j.ready = true; if (W.farm) W.farm.ripe = Math.min(W.farm.planted, W.farm.ripe + (s / 600) * W.farm.planted); };

  // ---- the steps, played out ----
  const chopS = () => ({ iron: 0.8, stone: 1.1, wooden: 1.5 }[toolTier('axe')] ?? 3);
  const digS = () => ({ iron: 0.4, stone: 0.6, wooden: 1.15 }[toolTier('pickaxe')] ?? 7.5);
  function run(step) {
    const s0 = t;
    const fail = (why, secs) => { pass(step.step, secs); return { ok: false, why }; };
    switch (step.step) {
      case 'gather_logs': {
        // (game/agent.js: what the goals still need after this comes in the same trip, up to 12.)
        let later = 0;
        try { later = Math.max(0, a.focusFacts(W.inv).need.logs - Math.max(0, step.count - count(W.inv, isLog))); } catch {}
        const target = step.count + (step.opportunity ? 0 : Math.min(12, later));
        const need = Math.max(1, target - count(W.inv, isLog));
        if (!W.treesKnown && !chance(0.6)) return fail('no trees found', 90);
        let secs = walk('field') + (Wd.trees / 4.3) + need * chopS() + Math.ceil(need / 4) * (Math.min(Wd.trees, 20) / 4.3);
        W.treesKnown = true;
        add('oak_log', need); if (chance(0.5)) add('oak_sapling', 1); if (chance(0.2)) add('apple', 1);
        pass('gather_logs', secs);
        return { ok: true };
      }
      case 'get_stone': {
        if (!toolTier('pickaxe')) return fail('no pickaxe', 5);
        const reach = a.knownSurfaceStone ? Wd.stone / 4.3 : 25; // a staircase down if none's in view
        a.knownSurfaceStone = true;
        pass('get_stone', walk(W.house ? 'home' : 'field') + reach + step.need * digS());
        add('cobblestone', step.need);
        wearPick(step.need + (reach > 20 ? 12 : 0));
        if (chance(0.3)) add('coal', 1 + Math.floor(rng() * 3));
        return { ok: true };
      }
      case 'craft': {
        if (step.needsTable && tableDist() > 4) { problems.push(`craft ${step.items} with no table in reach (tables: ${[...W.tables].join(',') || 'none'}, at ${W.where})`); return fail('no table', 3); }
        const p = planCrafts(W.inv, step.items);
        if (p.logsShort || p.missing) { problems.push(`asked to craft ${step.items} but can't (${p.missing ?? `${p.logsShort} logs short`})`); return fail('cannot craft', 3); }
        for (const st of p.steps) W.inv = applyCraft(W.inv, st).inv;
        pass('craft', 2 + step.items.length);
        return { ok: true };
      }
      case 'place_table': if (!take((id) => id === 'crafting_table', 1)) return fail('no table to place', 2); W.tables.add(W.where); pass('place_table', 2); return { ok: true };
      case 'goto_table': pass('goto_table', walk(nearestTableAt())); return { ok: true };
      case 'hunt': {
        if (step.what === 'trader') { W.trader = false; add('lead', 2); pass('hunt', 25); return { ok: true }; }
        const sheep = step.what === 'sheep';
        if (sheep ? !W.sheepNear : !W.animalsNear) return fail('nothing to hunt', 30);
        const n = sheep ? Math.max(1, step.need ?? 3) : 3;
        pass('hunt', walk('field') + n * 12);
        if (sheep) { add('white_wool', n); add('mutton', n); if (chance(0.3)) W.sheepNear = false; }
        else { add(RAWMEAT[Math.floor(rng() * 3)], n); if (chance(0.4)) W.animalsNear = false; }
        return { ok: true };
      }
      case 'explore': {
        pass('explore', walk('field') + 60 + rng() * 90);
        if (step.want === 'sheep') {
          const found = chance(Wd.sheep);
          if (found) W.sheepNear = true;
          a.noteSearch?.('sheep', found); // (game/agent.js, after each explore leg)
          return found ? { ok: true } : { ok: false, why: 'no sheep found' };
        }
        if (step.want === 'food') { if (chance(Wd.animals + 0.2)) { W.animalsNear = true; return { ok: true }; } return { ok: false }; }
        if (step.want === 'log') { W.treesKnown = true; return { ok: true }; }
        return { ok: true };
      }
      case 'smelt': {
        if (!W.furnace && !W.house?.furnace) {
          if (!take((id) => id === 'furnace', 1)) { problems.push('smelt with no furnace'); return fail('no furnace', 2); }
          W.furnace = { where: W.where };
        }
        const where = W.house?.furnace ? 'home' : W.furnace.where;
        // (The house's two furnaces: food in the second, the rest in the first; either if the other's free.)
        const slots = where === 'home' && W.house?.furnace2 && !NOF2 ? (step.input === 'food' ? ['food', 'main'] : ['main', 'food']) : ['main'];
        const slot = slots.find((s) => !W.jobs.some((j) => j.where === where && (j.slot ?? 'main') === s));
        if (!slot) return fail('furnace busy', 5);
        const inId = step.input === 'log' ? Object.keys(W.inv).find(isLog) : step.input === 'ore' ? 'raw_iron' : Object.keys(W.inv).find((id) => RAWMEAT.includes(id));
        if (!inId) { problems.push(`smelt ${step.input} with nothing to put in`); return fail('nothing to smelt', 2); }
        const plan = planFuel(W.inv, inId, Math.min(step.n, W.inv[inId] ?? 0), {});
        if (!plan) { problems.push(`smelt ${inId} with no fuel`); return fail('no fuel', 3); }
        if (plan.plankFrom) { add(plan.plankFrom, -plan.planks); add(plan.fuel, plan.planks * 4); }
        add(inId, -plan.k); add(plan.fuel, -Math.min(plan.n, W.inv[plan.fuel] ?? 0));
        const out = step.input === 'log' ? 'charcoal' : step.input === 'ore' ? 'iron_ingot' : cooked(inId);
        pass('smelt', walk(where) + 3);
        // (agent.js: a big batch of ore with the other house furnace free goes half in each.)
        const other = slots.find((s) => s !== slot && !W.jobs.some((j) => j.where === where && (j.slot ?? 'main') === s));
        if (step.input === 'ore' && plan.k >= 8 && other && !NOSPLIT) {
          const h1 = Math.ceil(plan.k / 2);
          W.jobs.push({ where, slot, kind: 'ore', n: h1, out, readyAt: tick() + h1 * 200 + 20, pos: { x: 1, y: where === 'mine' ? 16 : 64, z: 1 } });
          W.jobs.push({ where, slot: other, kind: 'ore', n: plan.k - h1, out, readyAt: tick() + (plan.k - h1) * 200 + 20, pos: { x: 1, y: where === 'mine' ? 16 : 64, z: 2 } });
        } else W.jobs.push({ where, slot, kind: step.input, n: plan.k, out, readyAt: tick() + plan.k * 200 + 20, pos: { x: 1, y: where === 'mine' ? 16 : 64, z: 1 } });
        return { ok: true };
      }
      case 'wait_smelt': case 'collect_smelt': {
        const j = a.homestead.planJob();
        if (!j) { problems.push(`${step.step} with nothing smelting`); return fail('nothing smelting', 3); }
        let secs = walk(j.where);
        if (tick() < j.readyAt) secs += (j.readyAt - tick()) / 20;
        pass(step.step === 'wait_smelt' ? `wait_smelt (${night() ? 'night' : 'day'}, ${j.kind})` : step.step, secs + 2);
        add(j.out, j.n);
        W.jobs.splice(W.jobs.indexOf(j), 1);
        return { ok: true };
      }
      case 'plan_house': W.project = { x: 0, y: 64, z: 0, dir: 'south', d: 'minecraft:overworld' }; pass('plan_house', 20); return { ok: true };
      case 'build_house': {
        const need = shortfall();
        if (need.stone || need.planks - fittingsPlanks(W.inv) - 4 > 0) { problems.push(`build_house while short ${JSON.stringify(need)}`); return fail('short', 5); }
        take((id) => TOOL_STONE.has(id), HOUSE.stone);
        while (count(W.inv, isPlanks) < HOUSE.planks && count(W.inv, isLog)) W.inv = applyCraft(W.inv, 'planks').inv;
        if (!take(isPlanks, HOUSE.planks)) problems.push('ran out of planks building the walls');
        W.project = null;
        W.house = { damage: 0, blocked: 0, fire: 0, door: false, bed: false, table: false, furnace: false, furnace2: false, chests: 0, signs: 0, lit: false, litOutside: false };
        pass('build_house', walk('home') + 120);
        furnish();
        return { ok: true };
      }
      case 'furnish': { pass('furnish', walk('home') + 15); furnish(); return { ok: true }; }
      case 'repair_house': {
        const n = W.house.damage;
        if (count(W.inv, (id) => TOOL_STONE.has(id)) + count(W.inv, isPlanks) + count(W.inv, isLog) * 4 < n) return fail('short for repairs', 10);
        for (let i = 0; i < n; i++) if (!take((id) => TOOL_STONE.has(id), 1)) { if (!take(isPlanks, 1)) W.inv = applyCraft(W.inv, 'planks').inv, take(isPlanks, 1); }
        W.house.damage = 0; pass('repair_house', walk('home') + n * 1.5 + 10); return { ok: true };
      }
      case 'clear_house': { pass('clear_house', walk('home') + W.house.blocked * 2); add('cobblestone', W.house.blocked); W.house.blocked = 0; return { ok: true }; }
      case 'fight_fire': { pass('fight_fire', walk('home') + W.house.fire * 3); W.house.fire = 0; return { ok: true }; }
      case 'light_outside': if (!take((id) => id === 'torch', 2)) { problems.push('light_outside short of torches'); return fail('no torches', 3); } W.house.litOutside = true; pass('light_outside', walk('home') + 6); return { ok: true };
      case 'store': {
        // homestead.storeItems: core/storage.js depositPlan, into the chests there are.
        const plan = depositPlan({ ...W.inv });
        if (!Object.keys(plan).length) { a.memory.data.nothingToStoreAt = Date.now(); pass('store', 1); return { ok: true }; }
        pass('store', walk('home') + 12);
        if (!W.house.chests) return { ok: false, why: 'no chest' };
        for (const [id, n] of Object.entries(plan)) add(id, -n);
        return { ok: true };
      }
      case 'check_water': a.memory.data.waterNearHouse = W.waterNear; pass('check_water', walk('home') + 10); return { ok: true };
      case 'make_farm': {
        if (!W.waterNear && !W.inv.water_bucket) return fail('no water', 30);
        const seeds = W.inv.wheat_seeds ?? 0;
        pass('make_farm', walk('home') + 90 + (seeds < 8 ? 40 : 0)); // (swiping grass for seeds on the way)
        add('wheat_seeds', 12);
        W.farm = { tiles: 24, planted: Math.min(24, (W.inv.wheat_seeds ?? 0)), ripe: 0 };
        add('wheat_seeds', -W.farm.planted);
        if (!W.waterNear) { add('water_bucket', -1); add('bucket', 1); }
        return { ok: true };
      }
      case 'tend_farm': {
        const ripe = Math.floor(W.farm.ripe);
        pass('tend_farm', walk('home') + 20 + W.farm.tiles * 0.5);
        add('wheat', ripe); add('wheat_seeds', ripe * 2);
        const empty = W.farm.tiles - (W.farm.planted - ripe);
        const sow = Math.min(empty, W.inv.wheat_seeds ?? 0);
        add('wheat_seeds', -sow);
        W.farm = { ...W.farm, planted: W.farm.planted - ripe + sow, ripe: 0 };
        return { ok: true };
      }
      case 'get_iron': {
        if (!toolTier('pickaxe')) return fail('no pickaxe', 5);
        a.miningTrip = true;
        let secs = walk('mine');
        // The stairs to Y 16 (once): ~160 steps; the camp at the foot.
        if (W.quarryDepth < 160) { const d = Math.min(160 - W.quarryDepth, 100); secs += d * (digS() * 2 + 0.4); W.quarryDepth += d; wearPick(d * 2); if (W.quarryDepth >= 160) W.camp = true; }
        if (W.quarryDepth < 160) { pass('get_iron', secs); return { ok: true }; }
        // (skills.getIron stops when it has what it came for, the vein it's on finished: a few over.)
        const rate = 1 / (18 * digS() / 0.6) * (0.6 + rng() * 0.8); // raw iron a second
        const cap = step.need + Math.floor(rng() * 4);
        const stint = Math.min(240, night() ? untilDawn() : 240, cap / rate);
        const got = Math.min(cap, Math.max(0, Math.round(stint * rate)));
        pass('get_iron', secs + stint);
        add('raw_iron', got); add('coal', Math.round(got * 1.5)); add('cobblestone', Math.min(64 - (W.inv.cobblestone ?? 0), Math.round(stint / digS() * 0.5)));
        wearPick(Math.round(stint / (digS() + 0.3)));
        return { ok: true };
      }
      case 'fill_bucket': if (!W.inv.bucket) return fail('no bucket', 2); add('bucket', -1); add('water_bucket', 1); pass('fill_bucket', 20); return { ok: true };
      case 'equip': for (const id of [...ARMOR, 'shield']) if (W.inv[id]) { add(id, -1); W.worn.push(id); } pass('equip', 2); return { ok: true };
      case 'go_home': {
        pass('go_home', walk('home'));
        if (!night()) return { ok: true };
        const s = untilDawn();
        spend('night at home', s); live(s * 0.1); houseEvents(s);
        return { ok: true };
      }
      case 'shelter': {
        const s = night() ? untilDawn() : 5;
        spend('shelter', s); live(s * 0.1); if (W.where !== 'mine') exposed(s * 0.1);
        return { ok: true };
      }
      case 'done': pass('idle', 30); return { ok: true };
      case 'blocked': problems.push(`blocked on a recipe: ${step.missing}`); return fail('blocked', 60);
      default: problems.push(`step the sim doesn't know: ${step.step}`); return fail('unknown', 10);
    }
  }
  function furnish() {
    const h = W.house;
    if (!h.door && take((id) => id === 'wooden_door', 1)) h.door = true;
    if (!h.table && !W.inv.crafting_table && count(W.inv, isPlanks) + count(W.inv, isLog) * 4 >= 4) { const p = planCrafts(W.inv, ['crafting_table']); for (const st of p.steps) W.inv = applyCraft(W.inv, st).inv; }
    if (!h.table && take((id) => id === 'crafting_table', 1)) { h.table = true; W.tables.add('home'); }
    if (!h.furnace && (W.inv.furnace || (W.furnace && !W.jobs.some((j) => j.where === W.furnace.where)))) { if (!take((id) => id === 'furnace', 1)) W.furnace = null; h.furnace = true; }
    if (h.furnace && !h.furnace2 && !NOF2 && take((id) => id === 'furnace', 1)) h.furnace2 = true;
    if (!h.bed && take((id) => id === 'bed', 1)) h.bed = true;
    while (h.chests < 4 && take((id) => id === 'chest', 1)) h.chests++;
    while (h.signs < 4 && h.chests >= 4 && take((id) => /_sign$/.test(id), 1)) h.signs++;
    if (!h.lit && take((id) => id === 'torch', 2)) h.lit = true;
  }

  // ---- the auto loop (game/agent.js runAuto's bookkeeping) ----
  const EXEMPT = ['go_home', 'shelter', 'wait_smelt', 'explore', 'get_iron', 'make_farm', 'tend_farm', 'check_water', 'equip'];
  let last = '', repeats = 0, same = 0, lastSig = '', steps = 0, finished = null;
  const recent = [];
  const stuck = [];
  while (t < LIMIT_DAYS * DAY) {
    steps++;
    if (chance(0.01)) W.trader = true;
    let step;
    const tp0 = performance.now();
    try { step = a.planStep({ ...W.inv }, tableDist(), 0); } catch (e) { problems.push(`planStep threw: ${e.message}`); break; }
    PLAN_MS.push(performance.now() - tp0);
    // (runAuto: a mining trip lasts till the plan has us doing something that isn't done down there.)
    if (step.step === 'get_iron') a.miningTrip = true;
    else if (!['get_iron', 'get_stone', 'smelt', 'collect_smelt', 'craft', 'equip'].includes(step.step) && step.step !== 'shelter') a.miningTrip = false;
    const key = stepKey(step) + (step.count ?? '');
    // (runAuto: a repeat is the same step with the pack unchanged; 8 of the same in a row regardless.
    // 'done' ends the loop there, so it never counts.)
    const sig = JSON.stringify(W.inv);
    same = key === last ? same + 1 : 0;
    repeats = key === last && sig === lastSig ? repeats + 1 : 0;
    last = step.step === 'done' ? '' : key; lastSig = sig;
    if ((repeats >= 3 || same >= 8) && !EXEMPT.includes(step.step)) {
      a.deferred.set(stepKey(step), { until: Date.now() + 180000, step: step.step });
      if (step.step === 'hunt' && step.what === 'sheep') a.bedDeferredUntil = Date.now() + 300000;
      log.push(`${fmt(t)} set aside ${key}`);
      repeats = 0; same = 0; last = '';
      continue;
    }
    const before = JSON.stringify([W.inv, W.house, W.jobs.length, W.farm, W.where]);
    const r = run(step);
    const after = JSON.stringify([W.inv, W.house, W.jobs.length, W.farm, W.where]);
    if (TRACE) console.log(`${fmt(t).padStart(9)} ${night() ? 'N' : ' '} ${W.where.padEnd(5)} ${key}${step.step === 'smelt' ? ` [${W.jobs.map((j) => `${j.kind} ${j.n} at ${j.where}`).join(', ')}]` : ''}${step.step === 'wait_smelt' ? ` [raw ${W.inv.raw_iron ?? 0}, iron have ${ironHave(W.inv, W.worn)}/${IRON_GOAL}]` : ''}${step.opportunity ? ` (side: ${step.opportunity})` : ''}${step.setAside ? ` (aside: ${step.setAside})` : ''} ${r.ok ? '' : `FAILED ${r.why}`}`);
    log.push(`${fmt(t)} ${key}${r.ok ? '' : ` FAILED ${r.why}`}`);
    // Stuck: nothing changed for 8 steps in a row (time passing alone isn't progress), not counting
    // waiting out a night or a furnace.
    recent.push({ key, changed: before !== after || ['go_home', 'shelter', 'wait_smelt', 'done'].includes(step.step) });
    if (recent.length > 8) recent.shift();
    if (recent.length === 8 && recent.every((x) => !x.changed)) { stuck.push(`${fmt(t)}: ${[...new Set(recent.map((x) => x.key))].join(' / ')}`); recent.length = 0; }
    // Milestones.
    const tools = ['stone_pickaxe', 'stone_sword', 'stone_axe'].every((id) => W.inv[id]) || milestones['stone tools'] != null;
    mark('stone tools', tools);
    mark('furnace', !!W.furnace || !!W.house?.furnace);
    mark('bed', !!W.inv.bed || !!W.house?.bed);
    mark('house built', !!W.house);
    mark('moved in', W.house && W.house.door && (W.house.bed || Wd.settings?.beds === false || Wd.sheep === 0) && W.house.table && W.house.furnace && W.house.chests >= 4 && (W.house.lit || Wd.settings?.torches === false));
    mark('farm', !!W.farm || Wd.settings?.farm === false);
    mark('iron pickaxe', !!W.inv.iron_pickaxe);
    mark('iron gear', ironHave(W.inv, W.worn) >= IRON_GOAL && ARMOR.every((id) => W.worn.includes(id)));
    // (Finished: every goal met. With no sheep in the world it goes on looking for them, rightly.)
    if (milestones['iron gear'] != null && milestones['moved in'] != null && (step.step === 'done' || Wd.sheep === 0)) { finished = t; break; }
    if (steps > 6000) { problems.push('over 6000 steps'); break; }
  }
  return { worldName, seed, finished, t, steps, timeBy, milestones, problems: [...new Set(problems)], stuck, deaths: W.deaths, causes: W.causes ?? [], lost: W.lost, events: W.events, log };
}
function fmt(s) { const d = Math.floor(s / DAY); const m = Math.floor((s % DAY) / 60); return `d${d + 1} ${String(m).padStart(2, '0')}m`; }

// ---------- run ----------
if (TRACE) {
  const r = simulate(TRACE.world, TRACE.seed);
  console.log(`\n${r.finished ? `finished in ${fmt(r.finished)}` : 'NOT finished'}; deaths ${r.deaths}; problems: ${r.problems.join('; ') || 'none'}; stuck: ${r.stuck.join(' | ') || 'none'}`);
  for (const e of r.events) console.log(`  ${e}`);
  process.exit(0);
}
const MS = ['stone tools', 'furnace', 'bed', 'house built', 'moved in', 'farm', 'iron pickaxe', 'iron gear'];
const med = (xs) => { const s = xs.filter((x) => x != null).sort((p, q) => p - q); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mins = (s) => (s == null ? '   -' : String(Math.round(s / 60)).padStart(4));
let anyBad = 0;
const allProblems = new Map(), allStuck = new Map(), causes = new Map(), fails = new Map(), asides = new Map();
console.log(`world         done  median  deaths  ${MS.map((m) => m.padStart(12)).join('')}   (minutes of game time; a day is 20)`);
const timeTot = {};
const ONLY = args.includes('--world') ? args[args.indexOf('--world') + 1] : null;
for (const w of Object.keys(WORLDS).filter((x) => !ONLY || x === ONLY)) {
  const rs = [];
  for (let s = 1; s <= RUNS; s++) rs.push(simulate(w, s));
  const done = rs.filter((r) => r.finished != null);
  for (const r of rs) {
    for (const p of r.problems) { const k = `${w}: ${p}`; allProblems.set(k, (allProblems.get(k) ?? 0) + 1); }
    for (const st of r.stuck) { const k = `${w}: ${st.replace(/^d\d+ \d+m: /, '')}`; allStuck.set(k, [...(allStuck.get(k) ?? []), `seed ${r.seed} ${st.split(':')[0]}`]); }
    for (const [k, v] of Object.entries(r.timeBy)) timeTot[k] = (timeTot[k] ?? 0) + v;
    for (const c of r.causes) causes.set(c, (causes.get(c) ?? 0) + 1);
    for (const l of r.log) {
      const m = / FAILED (.*)$/.exec(l); if (m) { const k = `${l.split(' ')[2].replace(/[0-9]+$/, '')}: ${m[1]}`; fails.set(k, (fails.get(k) ?? 0) + 1); }
      const s = / set aside (.*)$/.exec(l); if (s) { const k = s[1].replace(/[0-9]+$/, ''); asides.set(k, (asides.get(k) ?? 0) + 1); }
    }
  }
  if (done.length < rs.length) anyBad++;
  console.log(`${w.padEnd(12)} ${String(done.length).padStart(3)}/${rs.length} ${mins(med(done.map((r) => r.finished))).padStart(6)}  ${(rs.reduce((s, r) => s + r.deaths, 0) / rs.length).toFixed(1).padStart(6)}  ${MS.map((m) => mins(med(rs.map((r) => r.milestones[m]))).padStart(12)).join('')}`);
  if (VERBOSE) for (const r of rs.filter((x) => x.finished == null)) console.log(`    seed ${r.seed}: stopped at ${fmt(r.t)}, last: ${r.log.slice(-3).join(' | ')}`);
}
const total = Object.values(timeTot).reduce((a, b) => a + b, 0);
{ const s = [...PLAN_MS].sort((x, y) => x - y); console.log(`\nthinking: planStep ${s.length} calls, median ${s[Math.floor(s.length / 2)].toFixed(3)} ms, 99th ${s[Math.floor(s.length * 0.99)].toFixed(2)} ms, worst ${s[s.length - 1].toFixed(1)} ms`); }
console.log(`\nwhere the time goes (all runs):`);
for (const [k, v] of Object.entries(timeTot).sort((p, q) => q[1] - p[1]).slice(0, 14)) console.log(`  ${k.padEnd(18)} ${(100 * v / total).toFixed(1).padStart(5)}%`);
console.log(`\ndeaths by cause: ${[...causes].sort((p, q) => q[1] - p[1]).map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}`);
console.log(`\nfailed steps (per run): ${[...fails].sort((p, q) => q[1] - p[1]).slice(0, 10).map(([k, n]) => `${k} ${(n / RUNS / Object.keys(WORLDS).length).toFixed(1)}`).join(' | ')}`);
console.log(`set aside (per run): ${[...asides].sort((p, q) => q[1] - p[1]).slice(0, 10).map(([k, n]) => `${k} ${(n / RUNS / Object.keys(WORLDS).length).toFixed(2)}`).join(' | ') || 'none'}`);
console.log(`\nproblems (plan asked for what the world can't do):${allProblems.size ? '' : ' none'}`);
for (const [k, n] of allProblems) console.log(`  ${n}x ${k}`);
console.log(`stuck (8 steps, nothing changing):${allStuck.size ? '' : ' none'}`);
for (const [k, where] of [...allStuck].sort((p, q) => q[1].length - p[1].length).slice(0, 20)) console.log(`  ${where.length}x ${k}   [${where.slice(0, 3).join(', ')}]`);
process.exit(anyBad || allProblems.size || allStuck.size ? 1 : 0);
