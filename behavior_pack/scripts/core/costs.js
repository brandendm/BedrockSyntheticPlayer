// What things cost, in seconds, so the bot can weigh its options the way a player does:
// "dirt comes out fast with my fist and costs nothing; don't wear the pickaxe on it", "stand on
// dirt, keep the cobblestone for tools". Pure, unit-tested.

import { HARDNESS_DATA } from './hardness_data.js';

// Hardness (Bedrock). Break time = hardness * 1.5 / toolSpeed with the right tool,
// hardness * 5 by hand on blocks that need a tool to drop anything.
/** @type {Array<[RegExp, number]>} */
const HARDNESS = [
  [/^(obsidian|crying_obsidian|respawn_anchor|netherite_block|ender_chest)$/, 50],
  [/^ancient_debris$/, 30],
  [/^(dirt|coarse_dirt|grass_block|podzol|mycelium|rooted_dirt|farmland|grass_path|dirt_path|sand|red_sand|clay|mud|soul_sand|soul_soil)$/, 0.5],
  [/^(gravel|suspicious_gravel)$/, 0.6],
  [/^(snow_layer)$/, 0.1],
  [/^(snow)$/, 0.2],
  [/leaves$/, 0.2],
  [/^(mangrove_roots|muddy_mangrove_roots)$/, 0.7],
  [/^(moss_block|moss_carpet)$/, 0.1],
  [/^(netherrack)$/, 0.4],
  [/^(sandstone|red_sandstone|calcite)$/, 0.8],
  [/^(stone|andesite|diorite|granite|tuff|blackstone|basalt|smooth_basalt|dripstone_block|mossy_cobblestone)$/, 1.5],
  [/^(cobblestone|cobbled_deepslate|smooth_stone)$/, 2],
  [/^(deepslate)$/, 3],
  [/^deepslate_.*_ore$/, 4.5],
  [/_ore$/, 3],
  [/(_log|_wood|_stem|_hyphae|_planks)$/, 2],
  [/^crafting_table$/, 2.5],
  [/^(furnace|lit_furnace|blast_furnace|lit_blast_furnace|smoker|lit_smoker)$/, 3.5],
  [/^obsidian$/, 50],
];

// Never breakable by a player in survival, whatever they hold.
const NEVER_BREAKS = /^(bedrock|barrier|command_block|chain_command_block|repeating_command_block|structure_block|structure_void|jigsaw|end_portal_frame|end_portal|end_gateway|portal|reinforced_deepslate|allow|deny|border_block|light_block.*)$/;
// Only with a diamond pickaxe or better (anything less takes minutes and drops nothing).
const DIAMOND_ONLY = /^(obsidian|crying_obsidian|respawn_anchor|netherite_block|ancient_debris|ender_chest)$/;

/**
 * Can we break this with what we carry, in a reasonable time? (Obsidian without a diamond pickaxe:
 * ~250 s and nothing for it; bedrock: never.) The bot never starts on one it can't.
 */
export function canBreak(id, inv = {}) {
  const b = String(id ?? '').replace(/^minecraft:/, '');
  if (NEVER_BREAKS.test(b)) return false;
  if (DIAMOND_ONLY.test(b)) return Object.keys(inv).some((k) => /^(diamond|netherite)_pickaxe$/.test(k) && inv[k] > 0);
  return true;
}

export function hardness(id) {
  const d = HARDNESS_DATA[id];
  if (d !== undefined) return d; // (u303: the real values, tools/gen_hardness.mjs; the patterns below are for names the data does not have)
  for (const [re, h] of HARDNESS) if (re.test(id)) return h;
  return 1;
}

/** @type {Array<[RegExp, string]>} */
export const TOOL_KIND = [
  [/^(dirt|coarse_dirt|grass_block|podzol|mycelium|rooted_dirt|farmland|grass_path|dirt_path|sand|red_sand|clay|mud|soul_sand|soul_soil|gravel|suspicious_gravel|snow|snow_layer)$/, 'shovel'],
  [/(_log|_wood|_stem|_hyphae|_planks)$|^crafting_table$|^mangrove_roots$/, 'axe'],
  [/^muddy_mangrove_roots$/, 'shovel'],
  [/^(stone|cobblestone|cobbled_deepslate|deepslate|andesite|diorite|granite|tuff|calcite|blackstone|basalt|smooth_basalt|dripstone_block|sandstone|red_sandstone|netherrack|mossy_cobblestone|smooth_stone|obsidian|crying_obsidian|respawn_anchor|netherite_block|ancient_debris|ender_chest|furnace|lit_furnace|blast_furnace|lit_blast_furnace|smoker|lit_smoker)$|_ore$/, 'pickaxe'],
];

export function toolKindFor(id) {
  for (const [re, k] of TOOL_KIND) if (re.test(id)) return k;
  return null;
}

/** Blocks that give nothing unless mined with a pickaxe. */
export const needsPickaxe = (id) => toolKindFor(id) === 'pickaxe';

const SPEED = { wooden: 2, stone: 4, iron: 6, diamond: 8, netherite: 9, golden: 12 };
const TIER = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
// Seconds-equivalent of one use of a tool: what it cost to make / how many uses it has.
const WEAR = { wooden: 0.1, stone: 0.1, golden: 0.4, iron: 0.25, diamond: 0.2, netherite: 0.25 };

const parseTool = (id) => {
  const m = id?.match(/^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|shovel|axe|sword|hoe)$/);
  return m ? { tier: m[1], kind: m[2] } : null;
};

/** Seconds to break `id` holding `tool` (null = bare hand). */
export function breakSeconds(id, tool) {
  const h = hardness(id);
  const t = parseTool(tool);
  const kind = toolKindFor(id);
  if (t && t.kind === kind) return (h * 1.5) / SPEED[t.tier];
  return kind === 'pickaxe' ? h * 5 : h * 1.5;
}

/** Does breaking `id` with `tool` give us the block/item? */
export function dropsWith(id, tool) {
  if (!needsPickaxe(id)) return true;
  const t = parseTool(tool);
  if (!t || t.kind !== 'pickaxe') return false;
  if (/^(iron|copper|lapis)_ore$|^deepslate_(iron|copper|lapis)_ore$/.test(id)) return TIER[t.tier] >= 2;
  if (/(gold|diamond|redstone|emerald)_ore$/.test(id)) return TIER[t.tier] >= 3;
  if (id === 'obsidian') return TIER[t.tier] >= 4;
  return true;
}

/**
 * Cheapest way to break a block with what we carry: bare hand or one of our tools, counting break
 * time plus tool wear. If we need the drop, only options that give it count.
 * Returns { tool: id|null, seconds, cost } or null if we can't get the drop at all.
 */
export function chooseTool(id, inv, { needDrop = true } = {}) {
  const options = [null, ...Object.keys(inv).filter((k) => parseTool(k))];
  const pick = (allowPrecious) => {
    let best = null;
    for (const tool of options) {
      if (needDrop && !dropsWith(id, tool)) continue;
      const t = parseTool(tool);
      // A tool that isn't the right kind is no faster than a fist and still wears down: skip it.
      if (t && t.kind !== toolKindFor(id)) continue;
      if (!allowPrecious && isPrecious(tool) && !needsPrecious(id)) continue;
      const seconds = breakSeconds(id, tool);
      const cost = seconds + (t ? WEAR[t.tier] : 0);
      if (!best || cost < best.cost) best = { tool, seconds, cost };
    }
    return best;
  };
  // The iron pickaxe only on what needs it. With no stone one to hand (all worn out), it does the
  // stone rather than a bare fist (7.5 s a block): the plan makes a stone one again straight off.
  const best = pick(false);
  if (best && !(best.tool === null && toolKindFor(id) === 'pickaxe' && !workPickaxe(inv))) return best;
  return pick(true) ?? best;
}

/**
 * Iron and better pickaxes are kept for what only they can mine (gold, diamond, redstone and
 * emerald ore; obsidian) while iron is scarce: the rest is a stone pickaxe's job. Set
 * TOOL_POLICY.sparePrecious = false once iron's plentiful (an iron farm) to use them on anything.
 */
export const TOOL_POLICY = { sparePrecious: true };
const isPrecious = (tool) => TOOL_POLICY.sparePrecious && /^(iron|diamond|netherite)_pickaxe$/.test(tool ?? '');
/** Does mining `id` need better than a stone pickaxe (to drop anything)? */
export const needsPrecious = (id) => needsPickaxe(id) && !dropsWith(id, 'stone_pickaxe');
/** A pickaxe for everyday digging (stone, the stairs, tunnels): not one kept for ore. */
export const isWorkPickaxe = (id) => /_pickaxe$/.test(id) && !!parseTool(id) && !isPrecious(id);
const workPickaxe = (inv) => Object.keys(inv).some((k) => (inv[k] ?? 0) > 0 && isWorkPickaxe(k));

// How much we'd rather keep an item than build with it (seconds to get another, plus what it's
// good for). Dirt is free filler; cobblestone makes tools and furnaces; planks make everything.
export const ITEM_VALUE = {
  dirt: 0, coarse_dirt: 0, netherrack: 0.1, gravel: 0.3, andesite: 0.4, diorite: 0.4, granite: 0.4,
  tuff: 0.4, sand: 0.6, red_sand: 0.6, cobbled_deepslate: 1.2, cobblestone: 1.5, sandstone: 1, red_sandstone: 1,
  blackstone: 1.2, stone: 2, deepslate: 2,
};
export const PLACEABLE = new Set(Object.keys(ITEM_VALUE).concat(['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks']));
export const itemValue = (id) => ITEM_VALUE[id] ?? (id.endsWith('_planks') ? 4 : 99);

/**
 * Which block to put down: the least valuable one we have, never dipping into `reserve`
 * (e.g. { cobblestone: 8 } while we still need cobblestone for stone tools) unless nothing else is left.
 */
export function cheapestPlaceable(inv, reserve = {}) {
  const ids = Object.keys(inv).filter((id) => PLACEABLE.has(id) && inv[id] > 0).sort((a, b) => itemValue(a) - itemValue(b));
  return ids.find((id) => inv[id] > (reserve[id] ?? 0)) ?? ids[0] ?? null;
}

/**
 * Planks are never a throwaway block (a pillar, a bridge, a hole filled): they're the house, its
 * door, bed, table and chest, and the handles of every tool. Counted by the plan, so spending them
 * on a pillar up a tree meant running out halfway through the house. A reserve of all of them.
 */
export function plankReserve(inv) {
  const r = {};
  for (const [id, n] of Object.entries(inv)) if (id.endsWith('_planks')) r[id] = n;
  return r;
}

/** Placeable blocks we can spend without touching the reserve. */
export function spendableBlocks(inv, reserve = {}) {
  let n = 0;
  for (const id of Object.keys(inv)) if (PLACEABLE.has(id)) n += Math.max(0, inv[id] - (reserve[id] ?? 0));
  return n;
}

/**
 * Cost of getting one placeable block by mining `id` at `dist` blocks away: walking, breaking
 * with the best tool, wear, minus nothing (a block to stand on is a block to stand on), plus how
 * much we'd have preferred to keep what drops. Infinity if it drops nothing usable.
 */
export function blockSourceCost(id, inv, dist = 0) {
  const pick = chooseTool(id, inv, { needDrop: true });
  const drop = id === 'stone' ? 'cobblestone' : id === 'deepslate' ? 'cobbled_deepslate' : id === 'grass_block' ? 'dirt' : id;
  if (!pick || !PLACEABLE.has(drop)) return Infinity;
  return pick.cost + dist / 4.3 + itemValue(drop) * 0.5;
}
