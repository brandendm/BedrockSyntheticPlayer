// After "Move in": a farm, then iron. Pure (unit-tested).
//
//   1. A farm. Water within ~24 blocks of the house: farm there first (no iron needed, and the
//      wheat grows while we mine). No water near: 3 iron for a bucket first, then a farm by the
//      house with one bucket of water (one water block keeps a 9x9 patch wet).
//   2. Iron, about 40: iron armor is 24 ingots, pickaxe/sword/axe/shovel 9, a bucket 3, a shield
//      1. Exposed ore first (a cave wall, a mountainside), else a branch mine at Y 15-16 (the peak
//      of the underground iron band) off the quarry by the house.
//   3. Smelt it (coal from the same mine burns 8 items a piece), craft: the shield first (one ingot,
//      it takes arrows and blasts), the pickaxe (it mines everything faster), sword, bucket, axe,
//      shovel, then armor, chest plate first.
//   4. Wear the armor; bread from the wheat when food runs low; harvest and replant ripe wheat.
import { count, has, isPlanks, isLog } from './recipes.js';
import { planFuel } from './fuel.js';
import { craftStep, foodCount, FOOD_GOAL } from './settle.js';

/** Ingots each iron item is made of. */
export const IRON_IN = {
  iron_pickaxe: 3, iron_sword: 2, iron_axe: 3, iron_shovel: 1, bucket: 3, water_bucket: 3, shield: 1,
  iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4,
};
/**
 * What to make, in order: the shield first (one ingot, and it stops arrows and most of a creeper's
 * blast), the pickaxe (faster mining for the rest), armor last.
 */
export const IRON_ORDER = ['shield', 'iron_pickaxe', 'iron_sword', 'bucket', 'iron_axe', 'iron_shovel', 'iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots'];
export const IRON_GOAL = IRON_ORDER.reduce((a, id) => a + IRON_IN[id], 0); // 37
export const ARMOR = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
const FARM_TILES = 24;

/** An item already made (in the pack or worn). water_bucket counts as the bucket. */
const made = (inv, worn, id) => has(inv, id) || (worn ?? []).includes(id) || (id === 'bucket' && has(inv, 'water_bucket'));

/** Iron we have in any form, in ingots: raw, ingots, and what's already been made. */
export function ironHave(inv, worn = []) {
  let n = (inv.raw_iron ?? 0) + (inv.iron_ingot ?? 0) + (inv.iron_ore ?? 0) + (inv.deepslate_iron_ore ?? 0);
  for (const id of IRON_ORDER) if (made(inv, worn, id)) n += IRON_IN[id];
  return n;
}

/**
 * f: {
 *   inv, worn: [armor ids worn], tableDist,
 *   waterNearHouse: boolean | null (not checked yet),
 *   farm: null | { tiles, planted, ripe }     our farm, if made
 *   smelt: null | { ready, kind, dist }        a furnace job
 *   furnaceDist: number                        our furnace (Infinity if none)
 *   seeds: number                              wheat seeds (in inv too; convenience)
 *   canFillBucket: boolean                     water to fill it from (not the Nether, no recent failure)
 * }
 */
export function advanceStep(f) {
  const inv = f.inv, worn = f.worn ?? [];
  const ingots = inv.iron_ingot ?? 0, raw = (inv.raw_iron ?? 0);
  // Iron in the furnaces (the house's and the mine camp's) is ours already.
  const cooking = f.oreCooking ?? (f.smelt?.kind === 'ore' ? f.smelt.n ?? 0 : 0);
  const haveBucket = made(inv, worn, 'bucket');

  // A finished furnace near us: empty it (the iron is what everything below waits on). Not from
  // down the mine while there's still iron to dig: it keeps till we're up anyway.
  const stillShort = IRON_GOAL - ironHave(inv, worn) - cooking > 0;
  // (At the mine camp the furnace is right there: collect whenever it's done.)
  if (f.smelt?.ready && !(f.underground && stillShort && !f.camp) && ((f.smelt.dist ?? 0) <= 24 || f.smelt.kind === 'ore')) return { step: 'collect_smelt' };

  // Armor we made but aren't wearing: put it on (a moment, and it's the point of making it).
  if ([...ARMOR, 'shield'].some((id) => has(inv, id) && !worn.includes(id))) return { step: 'equip' };

  // A water bucket in the pack, always: it breaks a long fall (game/agent.js fallTick). Filled up
  // top when it's empty (after the farm's pool, after a fall it couldn't scoop back). Not down the
  // mine (it would climb out for it), not in the Nether (water boils away), not if the last try
  // found no water (f.canFillBucket).
  if (has(inv, 'bucket') && !has(inv, 'water_bucket') && !f.underground && f.canFillBucket === true) return { step: 'fill_bucket' };

  // Hungry and wheat in hand: bread.
  if (foodCount(inv) < 3 && (inv.wheat ?? 0) >= 3) return craftStep(inv, ['bread'], f.tableDist);

  // Ripe wheat on the farm: harvest and replant (quick, and the seeds and bread keep coming).
  // Most of what's planted is ripe, or there are empty tiles and seeds to sow them with.
  // Or it needs seeing to: a tree over it, torches missing, no pool by it yet.
  if (f.farm && (f.farm.upkeep || f.farm.ripe >= Math.max(2, Math.ceil((f.farm.planted ?? f.farm.tiles) * 0.6)) || (f.farm.planted < f.farm.tiles && (inv.wheat_seeds ?? 0) >= 4))) return { step: 'tend_farm' };

  // 1. The farm (unless it just failed: iron meanwhile, the farm gets another go in 10 minutes).
  if (!f.farm && !f.farmBlocked) {
    if (f.waterNearHouse == null) return { step: 'check_water' };
    if (!f.waterNearHouse && !haveBucket) {
      if (ingots >= 3) return craftStep(inv, ['bucket'], f.tableDist);
      if (ingots + cooking >= 3) return f.smelt?.ready ? { step: 'collect_smelt' } : { step: 'wait_smelt' };
      if (ingots + raw + cooking >= 3) return smeltOre(f, raw, 3 - ingots - cooking);
      return ironTrip(f, 3 - ingots - raw - cooking, 'bucket');
    }
    if (!has(inv, 'stone_hoe') && !has(inv, 'wooden_hoe') && !has(inv, 'iron_hoe')) return craftStep(inv, ['stone_hoe'], f.tableDist);
    return { step: 'make_farm', water: f.waterNearHouse ? 'near' : 'bucket', tiles: FARM_TILES };
  }

  // 2-3. Iron, then the iron things, in order, as the ingots come in.
  let spare = ingots;
  for (const id of IRON_ORDER) {
    if (made(inv, worn, id)) continue;
    if (spare >= IRON_IN[id]) {
      // Needs planks too: with no wood on us, make the next thing now and the shield once we have
      // some (its ingot kept back).
      if (id === 'shield' && count(inv, isPlanks) < 6 && count(inv, (x) => /(_log|_wood)$/.test(x)) < 2) { spare -= IRON_IN[id]; continue; }
      return craftStep(inv, [id], f.tableDist);
    }
    break; // the next thing needs more ingots: go get them
  }
  // Mining goes on while a batch smelts (in parallel): at the surface with raw iron and the furnace
  // free, load it before going back down, so the iron pickaxe (and the rest) come as we go rather
  // than all at the end.
  // Down at the mine camp the same: its furnace, with the coal we've just mined.
  if ((!f.underground || f.camp) && raw >= 3 && !f.smelt && planFuel(inv, 'raw_iron', raw)) return smeltOre(f, raw, raw);
  // Only what's still unaccounted for is short.
  const short = Math.max(0, IRON_GOAL - ironHave(inv, worn) - cooking);
  if (short > 0) return ironTrip(f, short, 'iron gear');
  if (raw > 0) return smeltOre(f, raw, raw);
  if (f.smelt) return { step: 'wait_smelt' };
  return { step: 'done' };
}

/**
 * Down the mine for iron, with spare pickaxes: a stone one lasts 131 blocks, and the stairs to
 * Y 16 alone are ~160, before any branch mining. Three stone ones (9 cobblestone) or an iron one
 * plus a stone spare.
 */
export function pickaxes(inv) {
  return Object.entries(inv).filter(([id]) => /^(stone|iron|diamond|netherite)_pickaxe$/.test(id)).reduce((a, [, n]) => a + n, 0);
}
function ironTrip(f, need, why) {
  const inv = f.inv;
  const want = has(inv, 'iron_pickaxe') || has(inv, 'diamond_pickaxe') ? 2 : 3;
  // Spares are made before a trip, at the surface; down the mine one pickaxe is enough to carry on
  // (climbing out to craft a spare costs more than it saves).
  // Wear counts, not just how many: two pickaxes with a handful of uses left between them are no
  // spare at all. A trip is ~160 blocks of stairs to Y 16 plus the mine: 200 uses to set off with.
  const wornOut = f.pickUses != null && f.pickUses < 200;
  // At the mine camp there's a table: spares get made down there too, from the cobblestone we're mining.
  const short = f.underground && !f.camp ? pickaxes(inv) < 1 : pickaxes(inv) < want || wornOut;
  if (short && count(inv, (id) => id === 'cobblestone' || id === 'cobbled_deepslate') >= 3) {
    const c = craftStep(inv, ['stone_pickaxe'], f.tableDist);
    // Down the mine with no wood for a handle: carry on with the pickaxe we have, rather than climb
    // all the way out for a log.
    if (!(f.underground && c.step === 'gather_logs')) return c;
  }
  // Torches for the mine before going down (made from what coal we have, no table needed): a dark
  // tunnel is where mobs spawn, and making them down there needs sticks we may not have left.
  if (!f.underground && (inv.torch ?? 0) < 8 && (inv.coal ?? 0) + (inv.charcoal ?? 0) > 0) {
    const t = craftStep(inv, ['torch'], f.tableDist);
    if (t.step === 'craft') return t;
  }
  return { step: 'get_iron', need, why };
}

/** Get raw iron smelting (or collect / wait on the batch that's in). */
function smeltOre(f, raw, want) {
  if (f.smelt?.ready) return { step: 'collect_smelt' };
  if (f.smelt) return { step: 'wait_smelt' };
  const n = Math.max(want, raw);
  // Something to burn first: coal from the mine, else wood (a log makes 4 planks: 6 items). With
  // neither, loading the furnace just failed and the step came straight back, over and over.
  if (!planFuel(f.inv, 'raw_iron', Math.min(n, raw))) {
    return { step: 'gather_logs', count: count(f.inv, isLog) + Math.max(1, Math.ceil(Math.min(n, raw) / 6)), wanted: ['furnace fuel'] };
  }
  return { step: 'smelt', input: 'ore', n, fuelPlanks: 0 };
}

/**
 * Wood and stone the moved-in goals will still take, besides iron: a hoe for the farm, spare
 * pickaxes for the mine, handles for the iron tools, planks for the shield. Counted up front so a
 * wood or stone trip brings enough for all of it: { planks, stone } (planks net of sticks carried).
 */
export function upkeepNeeds(inv, worn = []) {
  let sticks = 0, planks = 0, stone = 0;
  if (!has(inv, 'wooden_hoe') && !has(inv, 'stone_hoe') && !has(inv, 'iron_hoe')) { sticks += 2; stone += 2; }
  const want = has(inv, 'iron_pickaxe') || has(inv, 'diamond_pickaxe') ? 2 : 3;
  const spare = Math.max(0, want - pickaxes(inv));
  sticks += spare * 2; stone += spare * 3;
  for (const [id, n] of /** @type {Array<[string, number]>} */ ([['iron_pickaxe', 2], ['iron_sword', 1], ['iron_axe', 2], ['iron_shovel', 2]])) if (!made(inv, worn, id)) sticks += n;
  if (!made(inv, worn, 'shield')) planks += 6;
  sticks = Math.max(0, sticks - (inv.stick ?? 0));
  planks += Math.ceil(sticks / 4) * 2;
  return { planks, stone };
}

/** For the dashboard: the three new goals and where each stands. */
export function advanceProgress(f) {
  const inv = f.inv, worn = f.worn ?? [];
  const iron = ironHave(inv, worn);
  return {
    farm: !!f.farm,
    iron: Math.min(iron, IRON_GOAL),
    ironGoal: IRON_GOAL,
    tools: ['iron_pickaxe', 'iron_sword', 'iron_axe', 'iron_shovel'].filter((id) => made(inv, worn, id)).length,
    armor: ARMOR.filter((id) => worn.includes(id)).length,
    bucket: made(inv, worn, 'bucket'),
    shield: made(inv, worn, 'shield'),
  };
}

export { FOOD_GOAL };
