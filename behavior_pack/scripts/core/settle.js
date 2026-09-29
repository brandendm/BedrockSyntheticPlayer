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
import { materials, NEW_LAYOUT } from './house.js';
import { planFuel, charcoalInput } from './fuel.js';

export const DUSK = 11500;      // head home (sunset is 12000, mobs from ~13000)
export const DAWN = 23200;      // safe to go out again
export const TORCH_GOAL = 8;
export const FOOD_GOAL = 6;
export const FAR_FROM_HOME = 128; // blocks: further than this at dusk, dig in for the night instead of walking home     // pieces of food to carry before bothering with more hunting
const HOUSE = materials();

const stone = (inv) => count(inv, (id) => TOOL_STONE.has(id));
const wool = (inv) => Math.max(0, ...Object.entries(inv).filter(([id]) => isWool(id)).map(([, n]) => n));
export const FOODS = {
  cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6, cooked_rabbit: 5, cooked_cod: 5,
  cooked_salmon: 6, bread: 5, baked_potato: 5, golden_carrot: 6, apple: 4, carrot: 3, beef: 3, porkchop: 3,
  rabbit: 3, mutton: 2, cod: 2, salmon: 2, sweet_berries: 2, melon_slice: 2, cookie: 2, potato: 1, chicken: 2,
};
export const RAW = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato' };
// Saturation each gives (Minecraft's numbers): what keeps the hunger bar from dropping, and what
// fast healing runs on. A steak is 8 hunger and 12.8 of this; raw beef is 3 and 1.8.
export const SATURATION = {
  cooked_beef: 12.8, cooked_porkchop: 12.8, cooked_mutton: 9.6, cooked_chicken: 7.2, cooked_rabbit: 6, cooked_cod: 6,
  cooked_salmon: 9.6, bread: 6, baked_potato: 6, golden_carrot: 14.4, apple: 2.4, carrot: 3.6, beef: 1.8, porkchop: 1.8,
  rabbit: 1.8, mutton: 1.2, cod: 0.4, salmon: 0.4, sweet_berries: 0.4, melon_slice: 1.2, cookie: 0.4, potato: 0.6, chicken: 1.2,
  rotten_flesh: 0.8,
};
export const foodCount = (inv) => count(inv, (id) => id in FOODS);

/**
 * What to eat now: the most hunger and saturation that actually lands (the bar tops out at 20, and
 * saturation can't go past the hunger level), less what's wasted over the top. So a snack when
 * nearly full, a steak when properly hungry. Raw meat waits while some is cooking nearby (unless
 * starving or hurt badly); raw chicken and rotten flesh only when starving (hunger 6 or less), rotten
 * flesh only with nothing else. Returns an item id, or null (nothing worth eating now).
 * @param {any} inv
 * @param {{ hunger: number, saturation?: number, health?: number, cookingSoon?: boolean }} s
 */
export function chooseFood(inv, { hunger, saturation = 0, health = 20, cookingSoon = false }) {
  const missing = 20 - hunger;
  if (missing <= 0) return null;
  const starving = hunger <= 6, desperate = starving || health <= 8;
  let best = null, bestScore = -Infinity;
  const score = (id, h) => {
    const fill = Math.min(h, missing), waste = Math.max(0, h - missing);
    const sat = Math.max(0, Math.min(SATURATION[id] ?? 0, hunger + fill - saturation));
    return fill + sat - waste;
  };
  for (const [id, h] of Object.entries(FOODS)) {
    if (!inv[id]) continue;
    if (id === 'chicken' && !starving) continue;
    if (id in RAW && cookingSoon && !desperate) continue; // the cooked one's on its way
    const sc = score(id, h);
    if (sc > bestScore) { bestScore = sc; best = id; }
  }
  if (!best && starving && inv.rotten_flesh) return 'rotten_flesh';
  return best;
}
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
 *   beds: boolean                         sleeping at night (and so a bed, and sheep for it); default on
 * }
 * returns { step, ... }
 */
export function settleStep(f) {
  const { inv } = f;
  const torches = inv.torch ?? 0;
  const on = (k) => f.goals?.[k] !== false; // goals switched off (core/toggles.js)

  // The house on fire: put it out before anything (it's gone in a minute otherwise), day or night.
  if (f.house?.fire > 0) return { step: 'fight_fire' };
  // Something in the way in the house (a player's blocks, rubble, water; wherever it came from):
  // out with it, so the way in, the rooms and our things' places are usable.
  if (f.house?.blocked > 0) return { step: 'clear_house' };

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
    // Home unless it's a long walk in the dark (mobs all the way): then dig in where we are.
    if (f.house && (f.house.dist ?? 0) <= FAR_FROM_HOME) return { step: 'go_home', sleep: f.beds !== false };
    if (f.house) return { step: 'shelter' };
    // Walls, roof and a door are enough for a night in: the rest of the fittings can wait for day.
    const need = houseShortfall(inv, null, { fittings: false });
    if (!need && on('house')) return { step: 'build_house' };
    return { step: 'shelter' };
  }

  // Hungry with nothing to eat: food before anything else (bread from wheat, the furnace's cooking,
  // ripe wheat, an animal close by, else go and find some). It only hunted animals it happened to
  // see, so an empty pack in a place with none meant starving while it worked.
  if (f.hungry && foodCount(inv) === 0) {
    if ((inv.wheat ?? 0) >= 3) return craftStep(inv, ['bread'], f.tableDist);
    if (f.smelt?.kind === 'food') return f.smelt.ready ? { step: 'collect_smelt' } : { step: 'wait_smelt' };
    if (f.farmRipe) return { step: 'tend_farm' };
    if (f.armed !== false && f.animals > 0) return { step: 'hunt', what: 'food' };
    if (f.armed !== false) return { step: 'explore', want: 'food' };
  }

  // Still need wool and a sheep's right here: that first (it won't wait; the furnace will).
  // (Beds off, `!bot beds off`: no sleeping, so no bed and no sheep hunted for one.)
  const bedsOn = f.beds !== false && on('beds');
  const needWool = bedsOn && !has(inv, 'bed') && !f.house?.bed && wool(inv) < 3;
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
  if (f.project && !f.house && on('house')) {
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
  if (on('hunting') && armed && f.animals > 0 && foodCount(inv) < FOOD_GOAL && !sheepNow) return { step: 'hunt', what: 'food' };

  // 2. Bed. Crafted at a table that's already there (the wool keeps): not a new table put down
  // wherever the last sheep fell. With none near, it's made at the house's table at bedtime
  // (homestead.nightAtHome), or at the next table it's working at.
  const haveBed = !bedsOn || has(inv, 'bed') || !!f.house?.bed;
  const tableNear = (f.tableDist ?? Infinity) <= 16;
  if (!haveBed) {
    if (wool(inv) >= 3 && tableNear) return craftStep(inv, ['bed'], f.tableDist);
    if (wool(inv) < 3 && armed && f.sheep && !f.bedDeferred) return { step: 'hunt', what: 'sheep', need: 3 - wool(inv) };
  }

  // 3. Torches (charcoal smelting runs in the background).
  const fuel = (inv.charcoal ?? 0) + (inv.coal ?? 0);
  // Enough torches: 8 in hand, or the house is lit (placing them is what they're for).
  if (on('torches') && torches < TORCH_GOAL && !f.house?.lit) {
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
    if (!on('house')) return f.smelt?.ready ? { step: 'collect_smelt' } : { step: 'done' }; // (no house: the rest is the house's)
    if (!f.project) return { step: 'plan_house' };
    const need = houseShortfall(inv, f.shortfall);
    if (need?.stone) return { step: 'get_stone', need: need.stone, why: 'house' };
    if (need?.logs) return { step: 'gather_logs', count: count(inv, isLog) + need.logs, wanted: ['house'] };
    if (!has(inv, 'wooden_door')) return craftStep(inv, ['wooden_door'], f.tableDist);
    if (on('torches') && torches < HOUSE.torches && (f.smelt || fuel)) return { step: 'wait_smelt' };
    return { step: 'build_house' };
  }
  // The house is up: a door, a bed, a table, a furnace and a torch inside before it counts as done.
  if (!f.house.door) {
    if (has(inv, 'wooden_door')) return { step: 'furnish' };
    return craftStep(inv, ['wooden_door'], f.tableDist);
  }
  if (!f.house.bed && bedsOn) {
    if (has(inv, 'bed') || f.house.bedMisplaced) return { step: 'furnish' };
    if (wool(inv) >= 3 && (tableNear || (f.house.dist ?? 0) <= 24)) return craftStep(inv, ['bed'], f.tableDist); // (at the house: its table)
    if (wool(inv) < 3 && armed && f.sheep && !f.bedDeferred) return { step: 'hunt', what: 'sheep', need: 3 - wool(inv) };
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
  // The chest room's signs over the chests: what goes where.
  if (f.house.signs === false) {
    if (Object.keys(inv).some((id) => /_sign$/.test(id) && inv[id] > 0)) return { step: 'furnish' };
    return craftStep(inv, ['oak_sign'], f.tableDist);
  }
  // Pack nearly full: put things away before anything else takes us out again.
  if (on('storage') && f.packFull && f.house.chest && !f.chestFull) return { step: 'store' };
  // (Torches switched off: the house counts as lit.)
  const lit = !on('torches') || f.house.lit !== false, litOutside = !on('torches') || f.house.litOutside !== false;
  if (!lit && torches > 0) return { step: 'furnish' };
  // Cook raw meat while we're at it.
  // Only with something to burn (else it loops failing, sets the furnace job aside and wanders).
  const rawId = Object.keys(RAW).filter((id) => (inv[id] ?? 0) >= 2).sort((a, b) => inv[b] - inv[a])[0];
  const keepSticks = Math.max(0, Math.ceil((TORCH_GOAL - torches) / 4));
  // (A furnace nearby, or one to put down: not an 80-block walk home to cook in the middle of the day.)
  const furnaceHandy = has(inv, 'furnace') || (f.furnace?.dist ?? Infinity) <= 48;
  if (!f.smelt && rawId && furnaceHandy && planFuel(inv, rawId, inv[rawId], { keepSticks })) return { step: 'smelt', input: 'food', n: Object.keys(RAW).reduce((a, id) => a + (inv[id] ?? 0), 0), fuelPlanks: 0 };
  // Not done while something's still missing: no sheep for the bed yet (go and find some:
  // grassland, see core/biomes.js), or the charcoal for the torches is still cooking.
  // Torches by the door first if we have them: seconds of work here, before a long sheep search.
  if (!litOutside && torches > 0) return { step: 'light_outside' };
  // (Given up looking for now, bedDeferred: the rest of the list goes on, farm and iron included,
  // and the search comes back when the wait's over. It used to go on looking for ever, and in a
  // world with no sheep near the farm and the iron never came.)
  if (!f.house.bed && bedsOn && armed && !f.bedDeferred) return { step: 'explore', want: 'sheep' };
  if (!lit) return f.smelt ? { step: 'wait_smelt' } : { step: 'gather_logs', count: count(inv, isLog) + 2, wanted: ['torch'] };
  // Torches either side of the door (fewer mobs spawning at the doorstep).
  if (!litOutside) {
    if (torches > 0) return { step: 'light_outside' };
    if (fuel > 0) return craftStep(inv, ['torch'], f.tableDist);
    if (f.smelt) return { step: 'wait_smelt' };
    if (count(inv, charcoalInput) >= 2) return { step: 'smelt', input: 'log', n: 1, fuelPlanks: 1 };
    return { step: 'gather_logs', count: count(inv, isLog) + 2, wanted: ['torch'] };
  }
  // A second furnace, for food (chest-room houses), last of the house's things (moving in comes
  // first: it was pushing the rest past nightfall): meat never waits on the iron, or the iron on
  // the meat (homestead.furnaceFor gives each its own). 8 cobblestone.
  if (f.house.furnace2 === false && on('house')) {
    if (has(inv, 'furnace')) return { step: 'furnish' };
    if (stone(inv) < 8) return { step: 'get_stone', need: 8 - stone(inv), why: 'food furnace' };
    return craftStep(inv, ['furnace'], f.tableDist);
  }
  if (f.smelt?.ready) return { step: 'collect_smelt' }; // nothing else to do: go and get it now
  return { step: 'done' };
}

/**
 * Planks the house's fittings take, for each one not made yet: the door (6), the bed (3), a
 * crafting table for inside (4), the chests (8 each: one in a cabin, four in the chest room) and
 * the chest room's four signs (6 planks and a stick make 3). Counted with the walls, so one wood
 * trip covers the lot (getting exactly the walls' worth meant a trip back for two logs, then
 * another for one).
 */
export function fittingsPlanks(inv, house = null, layout = NEW_LAYOUT) {
  let n = 0;
  if (!has(inv, 'wooden_door') && !house?.door) n += 6;
  if (!has(inv, 'bed') && !house?.bed) n += 3;
  if (!has(inv, 'crafting_table') && !house?.table) n += 4;
  const chests = layout === 'chests' ? 4 : 1;
  const signs = layout === 'chests' ? 4 : 0;
  const chestsLeft = house?.chest ? 0 : Math.max(0, chests - (inv.chest ?? 0) - (house?.chestsPlaced ?? 0));
  n += 8 * chestsLeft;
  const signsLeft = house?.signs ? 0 : Math.max(0, signs - count(inv, (id) => /_sign$/.test(id)) - (house?.signsPlaced ?? 0));
  if (signsLeft) n += 6 * Math.ceil(signsLeft / 3) + 1; // (+1: a plank's worth of sticks)
  return n;
}

/** Cobblestone the recipes for these items take in all. */
export function stoneFor(items) {
  let n = 0;
  for (const it of items) for (const inp of RECIPES[it]?.inputs ?? []) if (typeof inp.match === 'function' && inp.match('cobblestone')) n += inp.n;
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
  if (p.missing) {
    // Short of cobblestone (a hoe or a spare pickaxe after the house took the lot): go and get it,
    // not 'blocked' (which went exploring for "supplies" and never came back with any).
    const stoneNeed = stoneFor(items) - stone(inv);
    if (stoneNeed > 0) return { step: 'get_stone', need: stoneNeed, why: items.join(', ').replace(/_/g, ' ') };
    return { step: 'blocked', missing: p.missing };
  }
  const needsTable = p.steps.some((s) => ['furnace', 'bed', 'wooden_door'].includes(s) || (RECIPES[s]?.table && !/^(wooden|stone)_(pickaxe|sword|axe|shovel)$/.test(s)));
  return (needsTable && tableStep(inv, tableDist, items)) || { step: 'craft', items, needsTable };
}
