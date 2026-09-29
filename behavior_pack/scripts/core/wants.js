// What the bot wants, and how much, right now: one place for "is this worth it?". Blocks worth
// mining when they turn up (coal in a tunnel wall, iron in the quarry), items on the ground worth a
// detour (armor someone dropped, a better sword, iron, coal), and armor worth putting on. Pure.
//
// Values are rough "blocks of walking it's worth": 0 means leave it (copper ore: no use for it yet;
// string, bones, odd stone: not worth the steps). A thing already covered (64 coal in the pack) is
// worth less than one that's short.
import { weaponDamage } from './threat.js';
import { IRON_GOAL, ironHave } from './advance.js';
import { FOODS } from './settle.js';

const n = (inv, re) => Object.entries(inv).filter(([id]) => re.test(id)).reduce((a, [, k]) => a + k, 0);

/** Armor pieces by slot and tier (Minecraft's defense points: what it's worth to wear). */
export const ARMOR_SLOTS = { helmet: 'Head', chestplate: 'Chest', leggings: 'Legs', boots: 'Feet' };
const ARMOR_POINTS = {
  leather: { helmet: 1, chestplate: 3, leggings: 2, boots: 1 },
  golden: { helmet: 2, chestplate: 5, leggings: 3, boots: 1 },
  chainmail: { helmet: 2, chestplate: 5, leggings: 4, boots: 1 },
  iron: { helmet: 2, chestplate: 6, leggings: 5, boots: 2 },
  diamond: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 },
  netherite: { helmet: 3, chestplate: 8, leggings: 6, boots: 3.5 },
  turtle: { helmet: 2 },
};
const TOUGHNESS = { diamond: 2, netherite: 3 };
/** What's worn adds up to: { points (0-20), toughness } (Minecraft's numbers; worn: item ids). */
export function armorTotal(worn = []) {
  let points = 0, toughness = 0;
  for (const id of worn) {
    const a = armorInfo(id);
    if (!a) continue;
    points += a.points;
    toughness += TOUGHNESS[/^(?:minecraft:)?([a-z]+)_/.exec(String(id))?.[1] ?? ''] ?? 0;
  }
  return { points: Math.min(20, points), toughness };
}

/** { slot, points } for an armor item id, or null. */
export function armorInfo(id) {
  const m = /^(leather|golden|chainmail|iron|diamond|netherite|turtle)_(helmet|chestplate|leggings|boots)$/.exec(String(id).replace(/^minecraft:/, ''));
  if (!m) return null;
  const points = ARMOR_POINTS[m[1]]?.[m[2]];
  return points == null ? null : { slot: m[2], points };
}

/**
 * Armor to put on: for each slot, the best piece in the pack if it beats what's worn there.
 * worn: ids worn. Returns [{ id, slot, replaces }].
 */
/** @param {any} inv @param {string[]} [worn] */
export function armorUpgrades(inv, worn = []) {
  const out = [];
  for (const slot of Object.keys(ARMOR_SLOTS)) {
    const on = worn.map((id) => ({ id, a: armorInfo(id) })).find((w) => w.a?.slot === slot);
    let best = null;
    for (const id of Object.keys(inv)) {
      const a = armorInfo(id);
      if (a?.slot === slot && (inv[id] ?? 0) > 0 && a.points > (best?.points ?? on?.a.points ?? 0)) best = { id, points: a.points };
    }
    if (best) out.push({ id: best.id, slot, replaces: on?.id ?? null });
  }
  return out;
}

const TOOL_TIER = { wooden: 1, golden: 1, stone: 2, copper: 2, iron: 3, diamond: 4, netherite: 5 };
const toolTier = (id) => { const m = /^(wooden|golden|stone|copper|iron|diamond|netherite)_(pickaxe|axe|shovel|hoe)$/.exec(id); return m ? { kind: m[2], tier: TOOL_TIER[m[1]] } : null; };
const bestTier = (inv, kind) => Math.max(0, ...Object.keys(inv).map(toolTier).filter((t) => t?.kind === kind).map((t) => t.tier));

/**
 * A block, if it turned up in a wall we're working (ore): worth mining? ctx: { inv, worn }.
 * Needs the right pickaxe for a drop (the caller checks that); this is whether we want it at all.
 */
/** @param {string} id @param {{ inv?: any, worn?: string[] }} [ctx] */
export function blockValue(id, { inv = {}, worn = [] } = {}) {
  const b = String(id).replace(/^minecraft:/, '').replace(/^deepslate_/, '');
  if (b === 'coal_ore') {
    // Torches (a coal and a stick make 4) and the furnace: never too much of it early on.
    const fuel = n(inv, /^(coal|charcoal)$/);
    return fuel < 32 ? 6 : fuel < 96 ? 3 : 1;
  }
  if (b === 'iron_ore') return ironHave(inv, worn) < IRON_GOAL + 6 ? 8 : 3; // (spares: a bucket, a shield, shears)
  if (b === 'diamond_ore') return bestTier(inv, 'pickaxe') >= 3 ? 10 : 0;   // (needs an iron pickaxe to drop)
  // Copper, gold, redstone, lapis, emerald, quartz: nothing it makes with them yet.
  return 0;
}

/**
 * An item lying on the ground: worth a detour to pick up? ctx: { inv, worn, needs: { wool, logs,
 * stone, food } } (core/focus.js needs, if known). Anything it walks over it picks up anyway; this
 * is what's worth going out of the way for.
 */
/** @param {string} id @param {{ inv?: any, worn?: string[], needs?: any }} [ctx] */
export function itemValue(id, { inv = {}, worn = [], needs = {} } = {}) {
  const it = String(id).replace(/^minecraft:/, '');
  // Armor that beats what's worn in its slot (a player's gift, a zombie's drop): well worth it.
  const a = armorInfo(it);
  if (a) {
    const on = Math.max(0, ...[...worn, ...Object.keys(inv)].map(armorInfo).filter((x) => x?.slot === a.slot).map((x) => x.points));
    return a.points > on ? 12 + a.points : 0;
  }
  // A better weapon or tool than any we have.
  if (/_sword$/.test(it)) return weaponDamage(it) > Math.max(1, ...Object.keys(inv).filter((k) => /_sword$|_axe$/.test(k)).map(weaponDamage)) ? 10 : 0;
  const t = toolTier(it);
  if (t) return t.tier > bestTier(inv, t.kind) ? 8 : 0;
  if (it === 'shield') return inv.shield || worn.includes('shield') ? 0 : 10;
  if (/^(diamond|emerald)$/.test(it)) return 8;
  if (/^(iron_ingot|raw_iron|iron_ore|deepslate_iron_ore)$/.test(it)) return ironHave(inv, worn) < IRON_GOAL + 6 ? 7 : 3;
  if (it === 'bucket' || it === 'water_bucket') return inv.bucket || inv.water_bucket ? 1 : 7;
  if (/^(coal|charcoal)$/.test(it)) return blockValue('coal_ore', { inv, worn }) - 1;
  if (it === 'torch') return (inv.torch ?? 0) < 32 ? 3 : 0;
  if (/_wool$/.test(it)) return (needs.wool ?? 0) > 0 ? 5 : 0;
  if (it in FOODS) { const f = Object.keys(FOODS).reduce((s, k) => s + (inv[k] ?? 0), 0); return f < 8 ? 4 : f < 24 ? 2 : 0; }
  if (/(_log|_planks)$/.test(it)) return (needs.logs ?? 0) > 0 ? 2 : 0;
  if (/^(cobblestone|cobbled_deepslate)$/.test(it)) return (needs.stone ?? 0) > 0 ? 1.5 : 0;
  if (it === 'wheat_seeds') return (inv.wheat_seeds ?? 0) < 16 ? 1 : 0;
  if (it === 'bow') return inv.bow ? 0 : 5;
  if (it === 'arrow') return inv.bow && (inv.arrow ?? 0) < 32 ? 2 : 0;
  if (/^(ender_pearl|golden_apple|enchanted_golden_apple|totem_of_undying)$/.test(it)) return 10;
  return 0; // string, bones, odd stone, flowers, copper: not worth the steps
}
