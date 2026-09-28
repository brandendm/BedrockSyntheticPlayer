// What to do next: priority jobs first, then the cheapest doable job among everything the goals
// still need. Pure (unit-tested).
//
// The goal ladder (recipes.js, settle.js) says what comes next in order. On its own it walks
// past sheep while it's out for stone, and when its step keeps failing it wanders off. This
// looks at the whole remaining list instead: if something a later goal needs is right here and
// cheap (sheep in sight, a tree 10 blocks off), get it now; if the ladder's step keeps failing,
// set it aside for a while and do the cheapest other thing, exploring only when nothing is doable.
//
// Priority jobs are never pre-empted: night (home, shelter), collecting a furnace that's done,
// building/furnishing the house we started, crafting (it's instant), and the crafting table.
import { count, has, isLog, isPlanks, isWool, TOOL_STONE } from './recipes.js';
import { materials, layoutOf, NEW_LAYOUT } from './house.js';
import { FOOD_GOAL, TORCH_GOAL, foodCount, fittingsPlanks } from './settle.js';
import { upkeepNeeds } from './advance.js';

const HOUSE = materials();
export const PRIORITY = new Set(['repair_house', 'go_home', 'shelter', 'collect_smelt', 'build_house', 'plan_house', 'furnish', 'store', 'craft', 'place_table', 'goto_table', 'wait_smelt', 'smelt', 'done']);
/** How close a resource must be to be worth a detour, in blocks. */
export const RADIUS = { sheep: 24, food: 16, log: 20, stone: 16 };
const WORK = { sheep: 8, food: 6, log: 14, stone: 10 }; // rough effort on top of walking there (log: ~4 logs chopped)
const EXPLORE = 60;
const DIG = 30;       // dig a staircase down to stone: always possible with a pickaxe   // "go and find one": what a step costs when nothing's known
const STICKY = 10;    // the ladder's own step wins ties by this much, so it doesn't flip-flop

export const stepKey = (s) => s.step + (s.items ? s.items.join() : '') + (s.what ?? '') + (s.why ?? '');

/**
 * Everything the remaining goals still need, net of what we carry.
 * f: { inv, haveFurnace, house: {bed, table, furnace}|null, project: bool, shortfall: {stone, planks}|null }
 */
export function needs(f) {
  const inv = f.inv;
  const cobble = count(inv, (id) => TOOL_STONE.has(id));
  const logs = count(inv, isLog), planks = count(inv, isPlanks);
  const wool = Math.max(0, ...Object.entries(inv).filter(([id]) => isWool(id)).map(([, n]) => n));
  const tier = (kind) => ['stone', 'iron', 'diamond', 'netherite'].some((t) => has(inv, `${t}_${kind}`));
  const kit = /** @type {Array<[string, number]>} */ ([['pickaxe', 3], ['sword', 2], ['axe', 3], ['shovel', 1]]).reduce((a, [k, n]) => a + (tier(k) ? 0 : n), 0);
  const furnace = f.haveFurnace ? 0 : 8;
  const built = !!f.house;
  // House: the site's exact count when we've started one (already net of what we carry).
  const noHouse = f.goals?.house === false; // (switched off: none to gather for)
  const houseStone = built || noHouse ? 0 : f.project && f.shortfall ? f.shortfall.stone + cobble : HOUSE.stone + 4;
  const housePlanks = built || noHouse ? 0 : f.project && f.shortfall ? f.shortfall.planks + planks : HOUSE.planks;
  const bed = f.beds === false || f.goals?.beds === false || has(inv, 'bed') || !!f.house?.bed; // (beds off: no wool wanted)
  const torches = inv.torch ?? 0;
  // The fittings (door, bed, table, chest) not made yet, and once moved in, the kit for the farm
  // and the mine (hoe, spare pickaxes, iron tool handles, shield): all wood, one trip.
  const later = built ? upkeepNeeds(inv, f.worn ?? []) : { planks: 0, stone: 0 };
  const planksNeed = housePlanks + (noHouse && !built ? 0 : fittingsPlanks(inv, f.house, f.house ? layoutOf(f.house) : NEW_LAYOUT)) + later.planks; // (a house already up keeps its own layout)
  const charcoalLogs = torches >= TORCH_GOAL || f.house?.lit ? 0 : Math.ceil((TORCH_GOAL - torches) / 4);
  return {
    stone: Math.max(0, kit + furnace + houseStone + later.stone - cobble),
    logs: Math.max(0, Math.ceil(Math.max(0, planksNeed - planks) / 4) + charcoalLogs - logs),
    wool: bed ? 0 : Math.max(0, 3 - wool),
    food: Math.max(0, FOOD_GOAL - foodCount(inv)),
  };
}

/** What kind of resource a gathering step goes for (null: not a gathering step). */
function kindOf(s) {
  if (s.step === 'gather_logs') return 'log';
  if (s.step === 'get_stone') return 'stone';
  if (s.step === 'hunt') return s.what === 'sheep' ? 'sheep' : 'food';
  if (s.step === 'smelt' && s.input === 'log') return 'log';
  return null;
}

/**
 * main: the ladder's step. f: {
 *   inv, need: needs(...),
 *   seen: { sheep, food, log, stone }   distance to the nearest one in sight / remembered, or null
 *   deferred: Set of stepKeys set aside (they kept failing)
 *   bedDeferred, canMineStone
 * }
 * returns the step to do, with `opportunity: kind` and `why` when it isn't the ladder's.
 */
export function chooseStep(main, f) {
  const deferred = f.deferred?.has(stepKey(main));
  if (PRIORITY.has(main.step) && !deferred) return main;
  const seen = f.seen ?? {}, need = f.need;
  const mainKind = kindOf(main);
  // Stone is never a search with a pickaxe: dig down to it (or the quarry) if none is in sight.
  const known = mainKind === 'stone' && f.canMineStone ? Math.min(seen.stone ?? Infinity, DIG) : seen[mainKind];
  const mainCost = deferred ? Infinity : mainKind ? (known ?? EXPLORE) + WORK[mainKind] : main.step === 'blocked' ? 2 * EXPLORE : 0;

  const inv = f.inv;
  const options = [];
  const near = (k) => seen[k] != null && seen[k] <= RADIUS[k];
  if (need.wool > 0 && f.canHunt !== false && near('sheep') && !f.bedDeferred) {
    options.push({ kind: 'sheep', cost: seen.sheep + WORK.sheep, step: { step: 'hunt', what: 'sheep', need: need.wool } });
  }
  if (need.food > 0 && f.canHunt !== false && f.goals?.hunting !== false && near('food')) {
    options.push({ kind: 'food', cost: seen.food + WORK.food, step: { step: 'hunt', what: 'food' } });
  }
  if (need.logs > 0 && near('log')) {
    options.push({ kind: 'log', cost: seen.log + WORK.log, step: { step: 'gather_logs', count: count(inv, isLog) + Math.min(need.logs, 12), wanted: ['later'] } });
  }
  if (need.stone > 0 && f.canMineStone && near('stone')) {
    options.push({ kind: 'stone', cost: seen.stone + WORK.stone, step: { step: 'get_stone', need: Math.min(need.stone, 16), why: 'later' } });
  }
  // The ladder's step is set aside (it kept failing): anything on the list we can still get at
  // counts, however far. Stone always can be (a quarry we know, or dig down: never explore for it).
  if (deferred) {
    const has = (k) => options.some((o) => o.kind === k);
    if (need.stone > 0 && f.canMineStone && !has('stone')) {
      options.push({ kind: 'stone', cost: (seen.stone ?? DIG) + WORK.stone, step: { step: 'get_stone', need: Math.min(need.stone, 16), why: 'later' } });
    }
    if (need.logs > 0 && seen.log != null && !has('log')) {
      options.push({ kind: 'log', cost: seen.log + WORK.log, step: { step: 'gather_logs', count: count(inv, isLog) + Math.min(need.logs, 12), wanted: ['later'] } });
    }
    if (need.wool > 0 && f.canHunt !== false && seen.sheep != null && !f.bedDeferred && !has('sheep')) {
      options.push({ kind: 'sheep', cost: seen.sheep + WORK.sheep, step: { step: 'hunt', what: 'sheep', need: need.wool } });
    }
  }
  const gathering = main.step !== 'smelt' ? mainKind : null; // a failing smelt can still be helped by fetching logs
  const others = options.filter((o) => o.kind !== gathering && !f.deferred?.has(stepKey(o.step))).sort((a, b) => a.cost - b.cost);
  const best = others[0];
  // Before stone tools exist, the ladder's step is the priority: a side job must be much cheaper.
  const sticky = f.early ? 25 : STICKY;
  if (best && best.cost + sticky < mainCost) {
    return { ...best.step, opportunity: best.kind, why: best.step.why ?? 'later', near: seen[best.kind] != null ? Math.round(seen[best.kind]) : null, setAside: deferred ? main.step : null };
  }
  if (deferred) {
    // Nothing on the list is doable from here: go looking, for what the set-aside step needed
    // (or the first thing still needed that exploring can find: never stone, we dig for that).
    // Only for something still needed (a set-aside furnace job with logs already in hand doesn't
    // want trees: that sent it 'looking for trees' in a loop, stopping at every one it saw).
    // (Not sheep while the bed's on hold: that's what looking for them and getting nowhere does.)
    const needOf = { log: need.logs, sheep: f.bedDeferred ? 0 : need.wool, food: need.food, stone: 0 };
    const want = mainKind && needOf[mainKind] > 0 ? mainKind : need.logs > 0 ? 'log' : needOf.sheep > 0 && f.canHunt !== false ? 'sheep' : need.food > 0 && f.canHunt !== false ? 'food' : null;
    return { step: 'explore', want, setAside: main.step };
  }
  return main;
}
