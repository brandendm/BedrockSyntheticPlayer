// Items, recipes, tool choice and the early-game progression plan. Pure: inventories are plain
// objects { itemId: count } with ids lacking the "minecraft:" prefix.

// ---------- item families ----------

export const isLog = (id) => /(_log|_wood|_stem|_hyphae)$/.test(id) && !id.startsWith('stripped_') || /^stripped_.*(_log|_wood|_stem|_hyphae)$/.test(id);
export const isPlanks = (id) => id.endsWith('_planks');
export const isWool = (id) => id.endsWith('_wool') || id === 'wool';
export const planksForLog = (id) =>
  id.replace(/^stripped_/, '').replace(/_(log|wood)$/, '_planks').replace(/_(stem|hyphae)$/, '_planks');

// Stone that a pickaxe turns into something stone tools accept.
export const TOOL_STONE = new Set(['cobblestone', 'cobbled_deepslate', 'blackstone']);
// Stone to mine for cobblestone: only the natural kinds. Cobblestone in the world is almost always
// someone's build (or our own house), never a quarry.
export const STONE_TARGETS = new Set(['stone', 'deepslate']);

// Blocks a shovel is right for (fists work too, just slower).
export const SHOVEL_BLOCKS = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'rooted_dirt', 'mud', 'dirt_with_roots',
  'sand', 'red_sand', 'gravel', 'clay', 'snow', 'snow_layer', 'soul_sand', 'soul_soil', 'farmland', 'grass_path',
]);
// Needs a pickaxe to drop anything.
export const PICKAXE_BLOCKS = /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|dripstone_block|sandstone|red_sandstone|.*_ore|blackstone|basalt|netherrack|mossy_cobblestone|smooth_stone)$/;

export function count(inv, pred) {
  let n = 0;
  for (const [id, c] of Object.entries(inv)) if (pred(id)) n += c;
  return n;
}
export const has = (inv, id) => (inv[id] ?? 0) > 0;

// ---------- recipes ----------
// inputs: [{ match: id | predicate, n }]; `table` = needs a crafting table (3x3).

export const RECIPES = {
  planks: { out: 4, table: false, inputs: [{ match: isLog, n: 1 }] },
  stick: { out: 4, table: false, inputs: [{ match: isPlanks, n: 2 }] },
  crafting_table: { out: 1, table: false, inputs: [{ match: isPlanks, n: 4 }] },
  wooden_pickaxe: { out: 1, table: true, inputs: [{ match: isPlanks, n: 3 }, { match: 'stick', n: 2 }] },
  wooden_shovel: { out: 1, table: true, inputs: [{ match: isPlanks, n: 1 }, { match: 'stick', n: 2 }] },
  wooden_sword: { out: 1, table: true, inputs: [{ match: isPlanks, n: 2 }, { match: 'stick', n: 1 }] },
  stone_pickaxe: { out: 1, table: true, inputs: [{ match: (id) => TOOL_STONE.has(id), n: 3 }, { match: 'stick', n: 2 }] },
  stone_sword: { out: 1, table: true, inputs: [{ match: (id) => TOOL_STONE.has(id), n: 2 }, { match: 'stick', n: 1 }] },
  stone_axe: { out: 1, table: true, inputs: [{ match: (id) => TOOL_STONE.has(id), n: 3 }, { match: 'stick', n: 2 }] },
  stone_shovel: { out: 1, table: true, inputs: [{ match: (id) => TOOL_STONE.has(id), n: 1 }, { match: 'stick', n: 2 }] },
  // Spears (minecraft.wiki: one of the material and two sticks, on a diagonal): a jab reaches 4, so it
  // hits a creeper from outside its fuse range (core/tactics.js).
  stone_spear: { out: 1, table: true, inputs: [{ match: (id) => TOOL_STONE.has(id), n: 1 }, { match: 'stick', n: 2 }] },
  wooden_spear: { out: 1, table: true, inputs: [{ match: isPlanks, n: 1 }, { match: 'stick', n: 2 }] },
  wooden_axe: { out: 1, table: true, inputs: [{ match: isPlanks, n: 3 }, { match: 'stick', n: 2 }] },
  furnace: { out: 1, table: true, inputs: [{ match: (id) => TOOL_STONE.has(id), n: 8 }] },
  torch: { out: 4, table: false, inputs: [{ match: (id) => id === 'charcoal' || id === 'coal', n: 1 }, { match: 'stick', n: 1 }] },
  bed: { out: 1, table: true, inputs: [{ match: (id) => isWool(id), n: 3, sameId: true }, { match: isPlanks, n: 3 }] },
  wooden_door: { out: 3, table: true, inputs: [{ match: isPlanks, n: 6 }] },
  chest: { out: 1, table: true, inputs: [{ match: isPlanks, n: 8 }] },
  oak_sign: { out: 3, table: true, inputs: [{ match: isPlanks, n: 6 }, { match: 'stick', n: 1 }] }, // (for the chest room's labels)
  // Farming.
  wooden_hoe: { out: 1, table: true, inputs: [{ match: isPlanks, n: 2 }, { match: 'stick', n: 2 }] },
  stone_hoe: { out: 1, table: true, inputs: [{ match: (id) => TOOL_STONE.has(id), n: 2 }, { match: 'stick', n: 2 }] },
  bread: { out: 1, table: true, inputs: [{ match: 'wheat', n: 3 }] },
  // Iron.
  iron_pickaxe: { out: 1, table: true, inputs: [{ match: 'iron_ingot', n: 3 }, { match: 'stick', n: 2 }] },
  iron_sword: { out: 1, table: true, inputs: [{ match: 'iron_ingot', n: 2 }, { match: 'stick', n: 1 }] },
  iron_axe: { out: 1, table: true, inputs: [{ match: 'iron_ingot', n: 3 }, { match: 'stick', n: 2 }] },
  iron_shovel: { out: 1, table: true, inputs: [{ match: 'iron_ingot', n: 1 }, { match: 'stick', n: 2 }] },
  bucket: { out: 1, table: true, inputs: [{ match: 'iron_ingot', n: 3 }] },
  shield: { out: 1, table: true, inputs: [{ match: 'iron_ingot', n: 1 }, { match: isPlanks, n: 6 }] },
  iron_helmet: { out: 1, table: true, inputs: [{ match: 'iron_ingot', n: 5 }] },
  iron_chestplate: { out: 1, table: true, inputs: [{ match: 'iron_ingot', n: 8 }] },
  iron_leggings: { out: 1, table: true, inputs: [{ match: 'iron_ingot', n: 7 }] },
  iron_boots: { out: 1, table: true, inputs: [{ match: 'iron_ingot', n: 4 }] },
};

const matches = (m, id) => (typeof m === 'string' ? m === id : m(id));
/** How many of an input we can use: all matching items, or the biggest single stack id if it must be one kind. */
const available = (inv, inp) => (inp.sameId
  ? Math.max(0, ...Object.entries(inv).filter(([id]) => matches(inp.match, id)).map(([, n]) => n))
  : count(inv, (id) => matches(inp.match, id)));

/** Can we craft `name` once right now (ignoring the table requirement)? */
export function canCraft(inv, name) {
  return RECIPES[name].inputs.every((inp) => available(inv, inp) >= inp.n);
}

/** Apply one craft to an inventory copy. Returns { inv, used: {id: n}, made: {id: n} }. */
export function applyCraft(inv, name, plankId = 'oak_planks') {
  const r = RECIPES[name];
  const next = { ...inv };
  const used = {};
  for (const inp of r.inputs) {
    let need = inp.n;
    let ids = Object.keys(next).filter((id) => matches(inp.match, id) && next[id] > 0);
    if (inp.sameId) ids = ids.sort((a, b) => next[b] - next[a]).slice(0, 1); // one colour of wool: the one we have most of
    for (const id of ids) {
      if (need === 0) break;
      if (!matches(inp.match, id) || next[id] <= 0) continue;
      const take = Math.min(need, next[id]);
      next[id] -= take;
      used[id] = (used[id] ?? 0) + take;
      need -= take;
      if (next[id] === 0) delete next[id];
    }
    if (need > 0) throw new Error(`missing ${inp.n} for ${name}`);
  }
  let outId = name;
  if (name === 'planks') outId = planksForLog(Object.keys(used)[0]) || plankId;
  next[outId] = (next[outId] ?? 0) + r.out;
  return { inv: next, used, made: { [outId]: r.out } };
}

/**
 * Ordered list of crafts to make every item in `targets`, making planks and sticks as needed.
 * Returns { steps: [name], logsShort: n } where logsShort > 0 means gather that many more logs first.
 */
export function planCrafts(inv, targets) {
  let cur = { ...inv };
  const steps = [];
  let logsShort = 0;
  const ensure = (pred, n, make) => {
    while (count(cur, pred) < n) {
      if (!make()) return false;
    }
    return true;
  };
  const makePlanks = () => {
    if (count(cur, isLog) < 1) { logsShort++; cur = { ...cur, oak_log: 1 }; }
    const r = applyCraft(cur, 'planks');
    cur = r.inv; steps.push('planks');
    return true;
  };
  const makeSticks = () => {
    ensure(isPlanks, 2, makePlanks);
    cur = applyCraft(cur, 'stick').inv; steps.push('stick');
    return true;
  };
  for (const t of targets) {
    const r = RECIPES[t];
    for (const inp of r.inputs) {
      if (inp.match === 'stick') ensure((id) => id === 'stick', inp.n, makeSticks);
    }
    for (const inp of r.inputs) {
      if (inp.match === isPlanks) ensure(isPlanks, inp.n, makePlanks);
      else if (inp.match !== 'stick' && available(cur, inp) < inp.n) {
        return { steps, logsShort, missing: t };
      }
    }
    cur = applyCraft(cur, t).inv;
    steps.push(t);
  }
  return { steps: logsShort ? [] : steps, logsShort, inv: cur };
}

// ---------- tools ----------

const TIER = { wooden: 1, stone: 2, iron: 3, golden: 1, diamond: 4, netherite: 5 };

export function bestTool(inv, kind) {
  let best = null, bt = 0;
  for (const id of Object.keys(inv)) {
    const m = id.match(/^(\w+)_(pickaxe|shovel|axe|sword)$/);
    if (m && m[2] === kind && (TIER[m[1]] ?? 0) > bt) { bt = TIER[m[1]]; best = id; }
  }
  return best;
}

/**
 * Which item to hold when breaking a block. null = bare hand.
 * The pickaxe is never used on dirt: it's no faster than a fist there and wastes durability.
 */
export function toolFor(blockId, inv) {
  if (PICKAXE_BLOCKS.test(blockId)) return bestTool(inv, 'pickaxe');
  if (SHOVEL_BLOCKS.has(blockId)) return bestTool(inv, 'shovel');
  if (isLog(blockId) || isPlanks(blockId) || blockId === 'crafting_table') return bestTool(inv, 'axe');
  return null;
}

// Break times in seconds (Bedrock: hardness * 1.5 / tool speed when the tool is right).
export const DIRT_HAND_S = 0.75;          // hardness 0.5
export const DIRT_WOOD_SHOVEL_S = 0.375;  // wooden tools are speed 2
export const CRAFT_AT_TABLE_S = 1.5;      // open table, click through, close

/**
 * Fists or a wooden shovel for the dirt between us and stone, whichever finishes first.
 * blocksToDig: dirt-like blocks we expect to break (a 1-wide staircase breaks 3 per step).
 * spareLogs/Planks decide whether the shovel's 1 plank + 2 sticks cost a trip for more wood.
 */
export const LOG_BY_HAND_S = 3;          // hardness 2 * 1.5, plus it's already at the tree
export function shovelWorthIt({ blocksToDig, canAffordFromInventory, extraLogs = 1, alreadyAtTree = false, logTripS = 20 }) {
  const hand = blocksToDig * DIRT_HAND_S;
  const woodCost = canAffordFromInventory ? 0 : alreadyAtTree ? extraLogs * (LOG_BY_HAND_S + 0.5) : logTripS;
  const shovel = CRAFT_AT_TABLE_S + woodCost + blocksToDig * DIRT_WOOD_SHOVEL_S;
  return { craft: shovel < hand, handS: hand, shovelS: shovel };
}

// ---------- progression ----------

export const COBBLE_GOAL = 10; // stone pickaxe 3 + sword 2 + axe 3 + shovel 1 + spear 1
export const TABLE_RADIUS = 4;          // close enough to use without walking
export const WALK_SPEED = 4.3;          // blocks/s
export const WOOD_VALUE_S = 3.5;        // a log costs about this much time to replace (fist, at a tree)
export const LOG_TRIP_S = 20;           // no wood on us: find a tree and chop one

/**
 * Walk back to the nearest remembered crafting table, or make a new one here?
 * Compares walking time (one way: we carry on from wherever the table is) with the cost of a
 * new table: placing it, crafting it, and the wood it eats. No remembered table -> craft.
 */
export function tableDecision({ dist, inv, dy = 0 }) {
  if (dist <= TABLE_RADIUS) return { choice: 'use', walkS: 0, newS: 0 };
  // Height costs far more than distance: a table 13 blocks down is in a cave, not a stroll away.
  const walkS = Number.isFinite(dist) ? (dist + Math.max(0, Math.abs(dy) - 2) * 4) / WALK_SPEED : Infinity;
  const planks = count(inv, isPlanks), logs = count(inv, isLog);
  const newS = has(inv, 'crafting_table') ? 1.5
    : planks >= 4 ? 2 + WOOD_VALUE_S
    : logs >= 1 ? 2.5 + WOOD_VALUE_S
    : LOG_TRIP_S + 2.5;
  return { choice: walkS <= newS ? 'walk' : 'new', walkS, newS };
}

/** What to do when the next craft needs a table. */
export function tableStep(inv, tableDist, wantedAfter, tableDy = 0) {
  const d = tableDecision({ dist: tableDist, inv, dy: tableDy });
  if (d.choice === 'use') return null;
  if (d.choice === 'walk') return { step: 'goto_table', dist: tableDist, why: `walk ${d.walkS.toFixed(0)}s < new table ${d.newS.toFixed(0)}s` };
  if (has(inv, 'crafting_table')) return { step: 'place_table' };
  const p = planCrafts(inv, ['crafting_table', ...wantedAfter]);
  if (p.logsShort > 0) return { step: 'gather_logs', count: count(inv, isLog) + p.logsShort, wanted: ['crafting_table', ...wantedAfter] };
  return { step: 'craft', items: ['crafting_table'], needsTable: false };
}

/**
 * The next thing to do on the road to stone tools.
 * facts: { inv, tableDist (blocks to the nearest known table, Infinity if none), exposedStoneKnown }
 * returns { step, ... }: gather_logs {count, wanted}, craft {items, needsTable}, place_table,
 *   goto_table {dist}, get_stone {need}, done
 */
export function nextStep({ inv, tableDist = Infinity, exposedStoneKnown, tableDy = 0, spears = true }) {
  const cobble = count(inv, (id) => TOOL_STONE.has(id));
  const hasWoodPick = !!bestTool(inv, 'pickaxe');
  const hasStonePick = ['stone', 'iron', 'diamond', 'netherite'].some((t) => has(inv, `${t}_pickaxe`));

  if (!hasWoodPick) {
    // Wooden tier: only the pickaxe (to get to stone). A wooden sword or shovel is a waste of
    // logs and time: stone ones come a few minutes later, and nothing gets hunted till then.
    const wanted = ['wooden_pickaxe'];
    const needNewTable = tableDecision({ dist: tableDist, inv, dy: tableDy }).choice === 'new' && !has(inv, 'crafting_table');
    const withTable = (list) => (needNewTable ? ['crafting_table', ...list] : list);
    const p = planCrafts(inv, withTable(wanted));
    if (p.logsShort > 0) return { step: 'gather_logs', count: count(inv, isLog) + p.logsShort, wanted: withTable(wanted) };
    return tableStep(inv, tableDist, wanted, tableDy) ?? { step: 'craft', items: wanted, needsTable: true };
  }
  // Stone tools, the full set in one table visit: pickaxe, sword, axe (logs 2x faster than a
  // fist), shovel (dirt, sand, gravel), spear (creepers, from 4 blocks out: one cobblestone). Each is
  // only made if we don't have one as good already.
  const better = (kind) => ['stone', 'copper', 'iron', 'diamond', 'netherite'].some((t) => has(inv, `${t}_${kind}`));
  const stoneKit = /** @type {Array<[string, number]>} */ ([['pickaxe', 3], ['sword', 2], ['axe', 3], ['shovel', 1], ['spear', 1]]).filter(([k]) => !better(k) && (spears || k !== 'spear'));
  const kitCobble = stoneKit.reduce((a, [, n]) => a + n, 0);
  if (stoneKit.length && cobble < kitCobble) return { step: 'get_stone', need: kitCobble - cobble };
  if (stoneKit.length) {
    const items = stoneKit.map(([k]) => `stone_${k}`);
    // Sticks come from planks: may need another log first.
    const p = planCrafts(inv, items);
    if (p.logsShort > 0) return { step: 'gather_logs', count: count(inv, isLog) + p.logsShort, wanted: items };
    return tableStep(inv, tableDist, items, tableDy) ?? { step: 'craft', items, needsTable: true };
  }
  return { step: 'done' };
}
