// What goes in the house chest and what stays in the pack. Pure (unit-tested).
//
// The pack keeps what the bot works with: every tool, weapon and piece of armor, the things it's
// about to place (a bed, a table, a furnace, a door, a chest), iron in any form (the plans count
// it from the pack), wool while there's no bed, and a working amount of the everyday stuff:
// torches, food, building blocks, wood, fuel, seeds. Everything else, and anything over those
// amounts, goes in the chest: mob drops, odd stone, ores it has no use for yet, the spare
// cobblestone a quarry turns up.
import { isLog, isPlanks, isWool } from './recipes.js';
import { FOODS } from './settle.js';

/** Free pack slots at or below this: time to put things away (a strip mine fills 36 slots fast). */
export const FULL_SLOTS = 4;

const KEEP_ALL = /(_pickaxe|_axe|_shovel|_sword|_hoe|_helmet|_chestplate|_leggings|_boots)$|^(shield|bucket|water_bucket|lava_bucket|shears|flint_and_steel|bow|arrow|crossbow|lead|raw_iron|iron_ingot|iron_ore|deepslate_iron_ore|bed|crafting_table|furnace|wooden_door|chest|clock|compass|map|filled_map)$/;

/** How many of this item to keep in the pack (Infinity: all of it). */
export function keepCount(id, inv = {}) {
  if (KEEP_ALL.test(id)) return Infinity;
  if (isWool(id)) return (inv.bed ?? 0) > 0 ? 0 : Infinity; // a bed's worth, until there's a bed
  if (id === 'torch') return 32;
  if (id in FOODS) return 16;
  if (id === 'wheat') return 9;              // three bread
  if (id === 'wheat_seeds') return 16;       // enough to replant the farm
  if (id === 'cobblestone' || id === 'cobbled_deepslate') return 64; // tools, repairs, pillars
  if (id === 'dirt') return 16;              // the cheapest block to stand on
  if (isLog(id)) return 16;
  if (isPlanks(id)) return 32;
  if (id === 'stick') return 16;
  if (id === 'charcoal' || id === 'coal') return 16;
  if (/_sapling$|^mangrove_propagule$/.test(id)) return 4;
  return 0;
}

/**
 * What to put in the chest: { id: count }. Amounts to keep are per kind (all logs together, all
 * planks together), so a pack with two kinds of log keeps 16 logs, not 16 of each.
 */
export function depositPlan(inv) {
  const out = {};
  const groupOf = (id) => (isLog(id) ? 'log' : isPlanks(id) ? 'planks' : id in FOODS ? `food:${id}` : id);
  const kept = {};
  // Biggest stacks first: the kind we have most of is the one we keep.
  for (const [id, n] of Object.entries(inv).sort((a, b) => b[1] - a[1])) {
    const keep = keepCount(id, inv);
    if (keep === Infinity) continue;
    const g = groupOf(id);
    const room = Math.max(0, keep - (kept[g] ?? 0));
    const k = Math.min(n, room);
    kept[g] = (kept[g] ?? 0) + k;
    if (n - k > 0) out[id] = n - k;
  }
  return out;
}

/** Items in the chest we'd take back for a job: { id: count } of what the chest can cover. */
export function takePlan(chest, want) {
  const out = {};
  for (const [pred, n] of want) {
    let left = n;
    for (const [id, have] of Object.entries(chest ?? {})) {
      if (left <= 0) break;
      if (!pred(id) || have <= 0) continue;
      const k = Math.min(left, have - (out[id] ?? 0));
      if (k > 0) { out[id] = (out[id] ?? 0) + k; left -= k; }
    }
  }
  return out;
}
