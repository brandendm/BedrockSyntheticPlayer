// After stone tools: settle in before the first night. Pure, unit-tested.
//
//   1. a furnace (8 cobblestone)
//   2. a bed: 3 wool of one colour from sheep (plus any easy meat from animals close by)
//   3. torches: logs smelted into charcoal (planks as fuel), charcoal + sticks
//   4. a house (core/house.js): cobblestone, planks, a door, torches; bed, table, furnace, chest inside
//
// Smelting runs on its own: load the furnace, go do the next thing, come back when it's done.
// Night overrides everything: from dusk the bot goes home (or builds the house now if it has
// what it needs, or digs in for the night if it doesn't).
import { count, has, isLog, isPlanks, isWool, planCrafts, tableStep, TOOL_STONE, RECIPES } from './recipes.js';
import { materials } from './house.js';
import { planFuel, charcoalInput } from './fuel.js';

export const DUSK = 11500;      // head home (sunset is 12000, mobs from ~13000)
export const DAWN = 23200;      // safe to go out again
export const TORCH_GOAL = 8;
export const FOOD_GOAL = 6;     // pieces of food to carry before bothering with more hunting
const HOUSE = materials();

const stone = (inv) => count(inv, (id) => TOOL_STONE.has(id));
const wool = (inv) => Math.max(0, ...Object.entries(inv).filter(([id]) => isWool(id)).map(([, n]) => n));
export const FOODS = {
  cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6, cooked_rabbit: 5, cooked_cod: 5,
  cooked_salmon: 6, bread: 5, baked_potato: 5, golden_carrot: 6, apple: 4, carrot: 3, beef: 3, porkchop: 3,
  rabbit: 3, mutton: 2, cod: 2, salmon: 2, sweet_berries: 2, melon_slice: 2, cookie: 2, potato: 1, chicken: 2,
};
export const RAW = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato' };
export const foodCount = (inv) => count(inv, (id) => id in FOODS);
export const isNight = (time) => time >= DUSK && time < DAWN;

/**
 * facts: {
 *   inv, tableDist, time (0..24000),
 *   furnace: null | { dist, inHouse }    nearest placed furnace we know of
 *   smelt: null | { ready }               a furnace we loaded
 *   house: null | { dist, bed, furnace, table }
 *   sheep: boolean                        sheep in sight or remembered nearby
 *   animals: number                       food animals in sight within ~16 blocks
 *   bedDeferred: boolean                  looked for sheep recently and found none
 * }
 * returns { step, ... }
 */
export function settleStep(f) {
  const { inv } = f;
  const torches = inv.torch ?? 0;

  // A house with holes in it (a creeper, a player): patch it before anything else, day or night;
  // with the exact blocks it's short of fetched first.
  if (f.house?.damage > 0) {
    const need = houseShortfall(inv, f.repairShort ?? { stone: 0, planks: 0 });
    if (!need) return { step: 'repair_house' };
    if (!isNight(f.time)) {
      if (need.stone) return { step: 'get_stone', need: need.stone, why: 'house repairs' };
      if (need.logs) return { step: 'gather_logs', count: count(inv, isLog) + need.logs, wanted: ['house repairs'] };
    }
  }

  // Night first.
  if (isNight(f.time)) {
    if (f.house) return { step: 'go_home', sleep: true };
    // Walls, roof and a door are enough for a night in: the rest of the fittings can wait for day.
    const need = houseShortfall(inv, null, { fittings: false });
    if (!need) return { step: 'build_house' };
    return { step: 'shelter' };
  }

  // Still need wool and a sheep's right here: that first (it won't wait; the furnace will).
  const needWool = !has(inv, 'bed') && !f.house?.bed && wool(inv) < 3;
  const sheepNow = f.armed !== false && needWool && f.sheep && !f.bedDeferred;
  // A finished furnace waits for us (it keeps its output): collect when we're near it anyway,
  // or when we're out of food and it's cooking some. Not a walk home in the middle of a sheep
  // search. (Charcoal the torches are waiting on is fetched by wait_smelt when that's next.)
  const smeltNear = (f.smelt?.dist ?? 0) <= 16;
  const smeltNeeded = f.smelt?.kind === 'food' && foodCount(inv) === 0;
  if (f.smelt?.ready && !sheepNow && (smeltNear || smeltNeeded)) return { step: 'collect_smelt' };

  // 1. Furnace.
  const haveFurnace = has(inv, 'furnace') || !!f.furnace || !!f.house?.furnace;
  if (!haveFurnace) {
    if (stone(inv) < 8) return { step: 'get_stone', need: 8 - stone(inv), why: 'furnace' };
    return craftStep(inv, ['furnace'], f.tableDist);
  }

  // A house we've started comes first: no wandering off after sheep with the walls half up.
  if (f.project && !f.house) {
    const need = houseShortfall(inv, f.shortfall);
    if (need?.stone) return { step: 'get_stone', need: need.stone, why: 'house' };
    if (need?.logs) return { step: 'gather_logs', count: count(inv, isLog) + need.logs, wanted: ['house'] };
    if (!has(inv, 'wooden_door')) return craftStep(inv, ['wooden_door'], f.tableDist);
    return { step: 'build_house' };
  }

  // Easy meat: animals right here and not much food on us.
  // Hunting only with a proper sword (stone or better): punching a cow is a waste of time.
  const armed = f.armed !== false;
  // Sheep first while we need wool: they're food too (mutton), other animals can wait.
  if (sheepNow && wool(inv) < 3 && !f.house) return { step: 'hunt', what: 'sheep', need: 3 - wool(inv) };
  if (armed && f.animals > 0 && foodCount(inv) < FOOD_GOAL && !sheepNow) return { step: 'hunt', what: 'food' };

  // 2. Bed.
  const haveBed = has(inv, 'bed') || !!f.house?.bed;
  if (!haveBed) {
    if (wool(inv) >= 3) return craftStep(inv, ['bed'], f.tableDist);
    if (armed && f.sheep && !f.bedDeferred) return { step: 'hunt', what: 'sheep', need: 3 - wool(inv) };
  }

  // 3. Torches (charcoal smelting runs in the background).
  const fuel = (inv.charcoal ?? 0) + (inv.coal ?? 0);
  // Enough torches: 8 in hand, or the house is lit (placing them is what they're for).
  if (torches < TORCH_GOAL && !f.house?.lit) {
    if (fuel > 0) return craftStep(inv, ['torch'], f.tableDist);
    if (!f.smelt) {
      const n = Math.ceil((TORCH_GOAL - torches) / 4);
      const fuelPlanks = Math.ceil(n / 1.5);
      const logsNeeded = n + Math.max(0, Math.ceil((fuelPlanks - count(inv, isPlanks)) / 4));
      if (count(inv, charcoalInput) < logsNeeded) return { step: 'gather_logs', count: logsNeeded, wanted: ['charcoal'] };
      return { step: 'smelt', input: 'log', n, fuelPlanks };
    }
  }

  // 4. House. Pick the spot first, so what we gather is counted block by block for that spot.
  if (!f.house) {
    if (!f.project) return { step: 'plan_house' };
    const need = houseShortfall(inv, f.shortfall);
    if (need?.stone) return { step: 'get_stone', need: need.stone, why: 'house' };
    if (need?.logs) return { step: 'gather_logs', count: count(inv, isLog) + need.logs, wanted: ['house'] };
    if (!has(inv, 'wooden_door')) return craftStep(inv, ['wooden_door'], f.tableDist);
    if (torches < HOUSE.torches && (f.smelt || fuel)) return { step: 'wait_smelt' };
    return { step: 'build_house' };
  }
  // The house is up: a door, a bed, a table, a furnace and a torch inside before it counts as done.
  if (!f.house.door) {
    if (has(inv, 'wooden_door')) return { step: 'furnish' };
    return craftStep(inv, ['wooden_door'], f.tableDist);
  }
  if (!f.house.bed) {
    if (has(inv, 'bed') || f.house.bedMisplaced) return { step: 'furnish' };
    if (wool(inv) >= 3) return craftStep(inv, ['bed'], f.tableDist);
    if (armed && f.sheep && !f.bedDeferred) return { step: 'hunt', what: 'sheep', need: 3 - wool(inv) };
  }
  // A crafting table and a furnace belong inside the house.
  if (!f.house.table) {
    if (has(inv, 'crafting_table') || count(inv, isPlanks) >= 4 || count(inv, isLog) >= 1) return { step: 'furnish' };
    return { step: 'gather_logs', count: 1, wanted: ['crafting_table'] };
  }
  if (!f.house.furnace) {
    if (has(inv, 'furnace') || (f.furnace && !f.furnace.inHouse && !f.smelt)) return { step: 'furnish' };
    if (f.smelt) return { step: 'wait_smelt' }; // it's cooking: collect, then carry the furnace home
    if (!f.furnace) {
      if (stone(inv) < 8) return { step: 'get_stone', need: 8 - stone(inv), why: 'furnace' };
      return craftStep(inv, ['furnace'], f.tableDist);
    }
  }
  // A chest by the door: somewhere to put things (and room in the pack for the next trip).
  if (f.house.chest === false) {
    if (has(inv, 'chest')) return { step: 'furnish' };
    return craftStep(inv, ['chest'], f.tableDist);
  }
  // Pack nearly full: put things away before anything else takes us out again.
  if (f.packFull && f.house.chest && !f.chestFull) return { step: 'store' };
  if (f.house.lit === false && torches > 0) return { step: 'furnish' };
  // Cook raw meat while we're at it.
  // Only with something to burn (else it loops failing, sets the furnace job aside and wanders).
  const rawId = Object.keys(RAW).filter((id) => (inv[id] ?? 0) >= 2).sort((a, b) => inv[b] - inv[a])[0];
  const keepSticks = Math.max(0, Math.ceil((TORCH_GOAL - torches) / 4));
  if (!f.smelt && rawId && planFuel(inv, rawId, inv[rawId], { keepSticks })) return { step: 'smelt', input: 'food', n: Object.keys(RAW).reduce((a, id) => a + (inv[id] ?? 0), 0), fuelPlanks: 0 };
  // Not done while something's still missing: no sheep for the bed yet (go and find some:
  // grassland, see core/biomes.js), or the charcoal for the torches is still cooking.
  // Torches by the door first if we have them: seconds of work here, before a long sheep search.
  if (f.house.litOutside === false && torches > 0) return { step: 'light_outside' };
  if (!f.house.bed && armed) return { step: 'explore', want: 'sheep' };
  if (f.house.lit === false) return f.smelt ? { step: 'wait_smelt' } : { step: 'gather_logs', count: count(inv, isLog) + 2, wanted: ['torch'] };
  // Torches either side of the door (fewer mobs spawning at the doorstep).
  if (f.house.litOutside === false) {
    if (torches > 0) return { step: 'light_outside' };
    if (fuel > 0) return craftStep(inv, ['torch'], f.tableDist);
    if (f.smelt) return { step: 'wait_smelt' };
    if (count(inv, charcoalInput) >= 2) return { step: 'smelt', input: 'log', n: 1, fuelPlanks: 1 };
    return { step: 'gather_logs', count: count(inv, isLog) + 2, wanted: ['torch'] };
  }
  if (f.smelt?.ready) return { step: 'collect_smelt' }; // nothing else to do: go and get it now
  return { step: 'done' };
}

/**
 * Planks the house's fittings take, for each one not made yet: the door (6), the bed (3), a
 * crafting table for inside (4) and the chest (8). Counted with the walls, so one wood trip covers
 * the lot (getting exactly the walls' worth meant a trip back for two logs, then another for one).
 */
export function fittingsPlanks(inv, house = null) {
  let n = 0;
  if (!has(inv, 'wooden_door') && !house?.door) n += 6;
  if (!has(inv, 'bed') && !house?.bed) n += 3;
  if (!has(inv, 'crafting_table') && !house?.table) n += 4;
  if (!has(inv, 'chest') && !house?.chest) n += 8;
  return n;
}

/** What's still missing for the house and its fittings: { stone, logs } or null if we have it all. */
export function houseShortfall(inv, exact = null, { fittings = true } = {}) {
  // exact: what the house we started still needs, counted block by block at the site (with the
  // fittings' planks: homestead.houseNeeds counts them against the same pile).
  if (exact) {
    if (!exact.stone && !exact.planks) return null;
    return { stone: exact.stone, logs: Math.ceil(exact.planks / 4) };
  }
  const stoneShort = Math.max(0, HOUSE.stone + 4 - stone(inv)); // a few spare for levelling the site
  const planksNeeded = HOUSE.planks + (fittings ? fittingsPlanks(inv) : has(inv, 'wooden_door') ? 0 : 6);
  const planksShort = Math.max(0, planksNeeded - count(inv, isPlanks));
  const logsShort = Math.max(0, Math.ceil(planksShort / 4) - count(inv, isLog));
  if (!stoneShort && !logsShort) return null;
  return { stone: stoneShort, logs: logsShort };
}

export function craftStep(inv, items, tableDist) {
  const p = planCrafts(inv, items);
  if (p.logsShort > 0) return { step: 'gather_logs', count: count(inv, isLog) + p.logsShort, wanted: items };
  if (p.missing) return { step: 'blocked', missing: p.missing };
  const needsTable = p.steps.some((s) => ['furnace', 'bed', 'wooden_door'].includes(s) || (RECIPES[s]?.table && !/^(wooden|stone)_(pickaxe|sword|axe|shovel)$/.test(s)));
  return (needsTable && tableStep(inv, tableDist, items)) || { step: 'craft', items, needsTable };
}
