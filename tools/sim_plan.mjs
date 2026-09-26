// Plays the goal ladder forward from nothing to "all done", with every step succeeding the way it
// would in game, and checks the chain holds together: no loops, no craft asked for that the
// inventory can't make, and how many separate trips for wood and stone it takes.
//
//   node tools/sim_plan.mjs            summary for each scenario
//   node tools/sim_plan.mjs --trace    every step
//
// Pure planners only (core/*); the game side is modelled crudely: what matters here is that the
// plan's own bookkeeping is consistent, not how long anything takes.
import { nextStep, planCrafts, applyCraft, count, isLog, isPlanks, TOOL_STONE } from '../behavior_pack/scripts/core/recipes.js';
import { settleStep, TORCH_GOAL, fittingsPlanks } from '../behavior_pack/scripts/core/settle.js';
import { advanceStep } from '../behavior_pack/scripts/core/advance.js';
import { chooseStep, needs } from '../behavior_pack/scripts/core/focus.js';
import { materials } from '../behavior_pack/scripts/core/house.js';
import { planFuel } from '../behavior_pack/scripts/core/fuel.js';

const TRACE = process.argv.includes('--trace');
const HOUSE = materials();

function run({ name, waterNearHouse = true, sheep = true, oppo = true }) {
  const s = {
    inv: {}, tableDist: Infinity, house: null, project: null, furnace: null, smelt: null, time: 1000,
    farm: null, worn: [], waterNearHouse: null, sheepFound: sheep,
  };
  const trips = { gather_logs: 0, get_stone: 0 };
  const problems = [];
  const seen = new Map();
  let last = '';
  const add = (id, n) => { s.inv[id] = (s.inv[id] ?? 0) + n; if (s.inv[id] <= 0) delete s.inv[id]; };
  const take = (pred, n) => {
    for (const id of Object.keys(s.inv).filter(pred)) { const k = Math.min(n, s.inv[id]); add(id, -k); n -= k; if (!n) break; }
    return n === 0;
  };
  const houseState = () => s.house && { dist: 3, damage: 0, ...s.house };
  const shortfall = () => {
    // homestead.houseNeeds with fittings, for a house not started (all blocks missing).
    const stone = count(s.inv, (id) => TOOL_STONE.has(id)), wood = count(s.inv, isPlanks) + count(s.inv, isLog) * 4;
    const shortS = Math.max(0, HOUSE.stone - stone), shortP = Math.max(0, HOUSE.planks - wood);
    const spare = Math.max(0, stone - HOUSE.stone) + Math.max(0, wood - HOUSE.planks);
    const walls = shortS + shortP <= spare ? { stone: 0, planks: 0 } : { stone: shortS, planks: shortP };
    const fit = Math.max(0, fittingsPlanks(s.inv) + 4 - Math.max(0, wood - HOUSE.planks));
    return { stone: walls.stone, planks: walls.planks + fit };
  };

  for (let i = 0; i < 400; i++) {
    const inv = s.inv;
    let step = nextStep({ inv, tableDist: s.tableDist, exposedStoneKnown: false });
    if (step.step === 'done') {
      step = settleStep({
        inv, tableDist: s.tableDist, time: s.time, furnace: s.furnace, smelt: s.smelt, house: houseState(),
        repairShort: { stone: 0, planks: 0 }, sheep: s.sheepFound, animals: 0, bedDeferred: !s.sheepFound, armed: true,
        project: !!s.project, shortfall: s.project ? shortfall() : null, packFull: false, chestFull: false,
      });
    }
    if (step.step === 'done' && s.house) {
      step = advanceStep({ inv, tableDist: s.tableDist, worn: s.worn, waterNearHouse: s.waterNearHouse, farmBlocked: false, underground: false,
        farm: s.farm, smelt: s.smelt && { ...s.smelt, dist: 3 }, furnaceDist: 3 });
    }
    if (oppo) {
      const need = needs({ inv, haveFurnace: !!s.furnace || !!inv.furnace || !!s.house?.furnace, house: houseState(), project: !!s.project, shortfall: s.project ? shortfall() : null, worn: s.worn });
      step = chooseStep(step, { inv, need, seen: { log: 6 }, canMineStone: !!Object.keys(inv).find((id) => /_pickaxe$/.test(id)), canHunt: true, deferred: new Map() });
    }
    const key = `${step.step}:${step.items ?? ''}:${step.count ?? step.need ?? ''}`;
    const sig = `${key}|${JSON.stringify(s.inv)}|${JSON.stringify(s.house)}|${!!s.smelt}|${JSON.stringify(s.farm)}`;
    if (seen.has(sig)) { problems.push(`loop at step ${i}: ${key} (same state as step ${seen.get(sig)})`); break; }
    seen.set(sig, i);
    if (TRACE) console.log(`${String(i).padStart(3)} ${key}${step.opportunity ? ' (side job)' : ''}   ${JSON.stringify(s.inv)}`);
    if (step.step in trips && key.split(':')[0] !== last) trips[step.step]++;
    last = key.split(':')[0];

    switch (step.step) {
      case 'gather_logs': {
        // agent.js: the step's count plus up to 12 more for the rest of the list, in one trip.
        const need = needs({ inv, haveFurnace: !!s.furnace || !!inv.furnace || !!s.house?.furnace, house: houseState(), project: !!s.project, shortfall: s.project ? shortfall() : null, worn: s.worn });
        const later = Math.max(0, need.logs - Math.max(0, step.count - count(inv, isLog)));
        const target = step.count + (step.opportunity ? 0 : Math.min(12, later));
        add('oak_log', Math.max(1, target - count(inv, isLog)));
        break;
      }
      case 'get_stone': add('cobblestone', step.need); break;
      case 'craft': {
        const p = planCrafts(s.inv, step.items);
        if (p.logsShort || p.missing) { problems.push(`step ${i}: asked to craft ${step.items} but can't (${p.missing ?? `${p.logsShort} logs short`})`); break; }
        if (step.needsTable && s.tableDist > 4) { problems.push(`step ${i}: craft ${step.items} needs a table, none in reach`); break; }
        for (const st of p.steps) s.inv = applyCraft(s.inv, st).inv;
        break;
      }
      case 'place_table': take((id) => id === 'crafting_table', 1); s.tableDist = 0; break;
      case 'goto_table': s.tableDist = 0; break;
      case 'hunt': if (step.what === 'sheep') { add('white_wool', step.need ?? 3); add('mutton', 2); } else add('beef', 3); break;
      case 'explore': if (step.want === 'sheep') s.sheepFound = true; else problems.push(`step ${i}: explore for ${step.want}`); break;
      case 'smelt': {
        if (!s.furnace && !s.inv.furnace) { problems.push(`step ${i}: smelt with no furnace`); break; }
        if (s.inv.furnace && !s.furnace) { take((id) => id === 'furnace', 1); s.furnace = { dist: 3, inHouse: false }; }
        const inId = step.input === 'log' ? 'oak_log' : step.input === 'ore' ? 'raw_iron' : Object.keys(s.inv).find((id) => ['beef', 'mutton'].includes(id));
        const plan = planFuel(s.inv, inId, Math.min(step.n, s.inv[inId] ?? 0), {});
        if (!plan) { problems.push(`step ${i}: smelt ${inId} with no fuel`); break; }
        if (plan.plankFrom) { add(plan.plankFrom, -plan.planks); add(plan.fuel, plan.planks * 4); }
        add(inId, -plan.k); add(plan.fuel, -Math.min(plan.n, s.inv[plan.fuel] ?? 0));
        s.smelt = { ready: false, kind: step.input, n: plan.k, out: step.input === 'log' ? 'charcoal' : step.input === 'ore' ? 'iron_ingot' : 'cooked_mutton' };
        break;
      }
      case 'wait_smelt': case 'collect_smelt':
        if (!s.smelt) { problems.push(`step ${i}: ${step.step} with nothing smelting`); break; }
        add(s.smelt.out, s.smelt.n); s.smelt = null; break;
      case 'plan_house': s.project = { x: 0 }; break;
      case 'build_house': {
        const need = shortfall();
        if (need.stone || need.planks - fittingsPlanks(s.inv) - 4 > 0) { problems.push(`step ${i}: build_house while short ${JSON.stringify(need)}`); break; }
        // Walls: stone, planks (made from logs as needed).
        take((id) => TOOL_STONE.has(id), HOUSE.stone);
        while (count(s.inv, isPlanks) < HOUSE.planks && count(s.inv, isLog)) s.inv = applyCraft(s.inv, 'planks').inv;
        if (!take(isPlanks, HOUSE.planks)) problems.push(`step ${i}: ran out of planks building the walls`);
        s.project = null;
        s.house = { door: false, bed: false, table: false, furnace: false, chest: false, lit: false, litOutside: false };
        // falls through to furnish, like buildHouse does
      }
      // eslint-disable-next-line no-fallthrough
      case 'furnish': {
        const h = s.house;
        if (!h.door && take((id) => id === 'wooden_door', 1)) h.door = true;
        if (!h.table && !s.inv.crafting_table && count(s.inv, isPlanks) + count(s.inv, isLog) * 4 >= 4) { const p = planCrafts(s.inv, ['crafting_table']); for (const st of p.steps) s.inv = applyCraft(s.inv, st).inv; }
        if (!h.table && take((id) => id === 'crafting_table', 1)) { h.table = true; s.tableDist = 0; }
        if (!h.furnace && (s.inv.furnace || (s.furnace && !s.smelt))) { if (!take((id) => id === 'furnace', 1)) s.furnace = null; h.furnace = true; s.furnace = { dist: 3, inHouse: true }; }
        if (!h.bed && take((id) => id === 'bed', 1)) h.bed = true;
        if (!h.chest && take((id) => id === 'chest', 1)) h.chest = true;
        if (!h.lit && take((id) => id === 'torch', 1)) h.lit = true;
        if (step.step === 'build_house' && !h.litOutside && (s.inv.torch ?? 0) >= 2) { take((id) => id === 'torch', 2); h.litOutside = true; }
        break;
      }
      case 'light_outside': if (take((id) => id === 'torch', 2)) s.house.litOutside = true; else problems.push(`step ${i}: light_outside short of torches`); break;
      case 'check_water': s.waterNearHouse = waterNearHouse; break;
      case 'make_farm': s.farm = { tiles: 24, planted: 24, ripe: 0 }; take((id) => id === 'wheat_seeds', 0); break;
      case 'tend_farm': s.farm = { ...s.farm, planted: s.farm.tiles, ripe: 0 }; add('wheat', 6); break;
      case 'get_iron': add('raw_iron', Math.min(step.need, 12)); break;
      case 'equip': for (const id of Object.keys(s.inv)) if (/^iron_(helmet|chestplate|leggings|boots)$|^shield$/.test(id)) { s.worn.push(id); add(id, -1); } break;
      case 'store': break;
      case 'done': return { name, steps: i, trips, problems, inv: s.inv };
      default: problems.push(`step ${i}: unexpected step ${step.step}`);
    }
    if (problems.length > 5) break;
  }
  if (!problems.length) problems.push('never reached done in 400 steps');
  return { name, steps: 400, trips, problems, inv: s.inv };
}

let bad = 0;
for (const sc of [
  { name: 'water by the house, sheep around' },
  { name: 'no water near: bucket first', waterNearHouse: false },
  { name: 'no side jobs (ladder only)', oppo: false },
]) {
  const r = run(sc);
  bad += r.problems.length;
  console.log(`${r.name}: ${r.problems.length ? 'PROBLEMS' : 'ok'} in ${r.steps} steps; trips for wood ${r.trips.gather_logs}, for stone ${r.trips.get_stone}`);
  for (const p of r.problems) console.log(`  - ${p}`);
}
process.exitCode = bad ? 1 : 0;
