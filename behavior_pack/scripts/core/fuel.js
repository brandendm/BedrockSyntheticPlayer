// Furnace fuel, the Bedrock way. Pure (unit-tested).
//
// Items smelted per fuel item (Bedrock Edition): leaf litter 0.5 (one per layer, breaks instantly), coal / charcoal 8, block of coal 80, dried kelp
// block 20, blaze rod 12, planks / logs / wood / wooden slabs (1.5 on Bedrock, 0.75 on Java) /
// crafting table / ladder 1.5, wooden tools 1, sticks / saplings / bowls / wool 0.5, bamboo 0.25.
// Crimson and warped wood (stems, hyphae, planks, slabs) doesn't burn at all, and nether stems
// don't smelt into charcoal either.
//
// Practice:
// - Never burn a log as it is: made into 4 planks it burns 6 items instead of 1.5.
// - A burning fuel item finishes even with nothing left to cook, so pick the fuel whose units
//   fit the batch (2 planks for 3 items, 1 coal for 8) and burn junk first: saplings, spare
//   sticks, wooden tools we've outgrown.
// - Coal and charcoal only for batches that use most of an item (6+): a charcoal is 4 torches.
// - Two logs and nothing else to burn: plank one of them, cook the other.

import { isSapling, keepForPlanting } from './saplings.js';

const NETHER_WOOD = /^(crimson|warped)_/;

/** Items one of `id` smelts, Bedrock values (0: not a fuel). */
export function burnsFor(id) {
  if (NETHER_WOOD.test(id) || /^stripped_(crimson|warped)_/.test(id)) return 0;
  if (id === 'coal' || id === 'charcoal') return 8;
  if (id === 'coal_block') return 80;
  if (id === 'dried_kelp_block') return 20;
  if (id === 'blaze_rod') return 12;
  if (/_planks$/.test(id) || /(_log|_wood)$/.test(id) || /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo)_slab$/.test(id) || /^wooden_slab$/.test(id)) return 1.5;
  if (id === 'crafting_table' || id === 'ladder' || id === 'bamboo_block') return 1.5;
  if (/^wooden_(pickaxe|axe|shovel|hoe|sword)$/.test(id)) return 1;
  if (id === 'leaf_litter') return 0.5; // 5 s of burn, per layer picked up
  if (id === 'stick' || id === 'bowl' || /_sapling$/.test(id) || id === 'mangrove_propagule' || /_wool$/.test(id) || id === 'wool') return 0.5;
  if (id === 'bamboo') return 0.25;
  return 0;
}

/** Can this be smelted into charcoal? (overworld logs and wood, stripped too; not nether stems) */
export const charcoalInput = (id) => /(_log|_wood)$/.test(id) && !/(crimson|warped)/.test(id);

const BETTER = ['stone', 'iron', 'golden', 'diamond', 'netherite'];

/**
 * How much we mind burning one of `id` (lower burns first). Things we still need are Infinity:
 * the crafting table, wool (the bed), sticks the torches want, a wooden tool with no better one.
 */
function worth(id, inv, keepSticks) {
  const tool = /^wooden_(pickaxe|axe|shovel|hoe|sword)$/.exec(id);
  if (tool) return BETTER.some((t) => (inv[`${t}_${tool[1]}`] ?? 0) > 0) ? 0.05 : Infinity;
  if (/_sapling$/.test(id) || id === 'mangrove_propagule') return 0.05;
  if (id === 'bamboo') return 0.05;
  // Worth is about the seconds of work a piece cost: a plank ~1 (a 3.8 s log makes 4), leaf litter
  // ~0.25 (one instant break, 1-4 layers, picked up where we already were).
  if (id === 'leaf_litter') return 0.25;
  if (id === 'stick') return (inv.stick ?? 0) > keepSticks ? 0.2 : Infinity;
  if (id === 'bowl') return 0.3;
  if (/_planks$/.test(id) || /_slab$/.test(id)) return 1;
  // 4 torches each while coal is short; a quarry turns up far more than the torches use (24 coal in the pack, and
  // three spruce logs planked for a batch of 18 iron, logs it then had to climb for).
  if (id === 'coal' || id === 'charcoal') return (inv.coal ?? 0) + (inv.charcoal ?? 0) >= 16 ? 1.5 : 5;
  if (id === 'dried_kelp_block') return 3;
  return Infinity; // logs (plank them), crafting table, ladders, wool, blaze rods, coal blocks
}

/**
 * The fuel for a batch.
 * inv: what we carry; input: the item going in; k: how many we'd like to cook;
 * keepSticks: sticks to hold back (for torches).
 * returns null (nothing to burn), or { k, fuel, n, plankFrom, planks }:
 *   k: how many to cook (fewer than asked if the fuel only covers that much),
 *   fuel/n: what goes in the fuel slot, and how many,
 *   plankFrom/planks: craft that many logs of this kind into planks first (4 each) for the fuel.
 */
export function planFuel(inv, input, k, { keepSticks = 0 } = {}) {
  k = Math.min(k, inv[input] ?? 0);
  if (k <= 0) return null;
  const opts = [];
  for (const [id, have] of Object.entries(inv)) {
    if (id === input || have <= 0) continue;
    const per = burnsFor(id);
    if (!per) continue;
    const w = worth(id, inv, keepSticks);
    if (!Number.isFinite(w)) continue;
    let usable = have;
    if (id === 'stick') usable = have - keepSticks;
    if (isSapling(id)) usable = have - keepForPlanting(id); // a couple kept back for replanting
    if (usable <= 0) continue;
    opts.push({ id, per, w, have: usable });
  }
  // Logs we could plank for fuel: other kinds first, then the kind we're cooking, keeping enough
  // of it to cook. Only overworld wood burns.
  const logKinds = Object.entries(inv).filter(([id, n]) => n > 0 && /(_log|_wood)$/.test(id) && burnsFor(id) > 0);
  const plankOf = (logId) => logId.replace(/^stripped_/, '').replace(/_(log|wood)$/, '_planks');

  /** Cost of cooking `kk` with fuel option o: units needed, what's wasted, what it's worth. */
  const price = (o, kk) => {
    const n = Math.ceil(kk / o.per);
    if (n > o.have) return null;
    const unitsWasted = n * o.per - kk;
    // Coal or charcoal on a small batch throws most of it away.
    if (o.per >= 8 && kk < 6) return null;
    return { n, cost: n * o.w + unitsWasted * 0.3 };
  };
  let best = null;
  for (const o of opts) {
    const p = price(o, k);
    if (p && (!best || p.cost < best.cost)) best = { k, fuel: o.id, n: p.n, cost: p.cost, plankFrom: null, planks: 0 };
  }
  // Planks made from logs: 1 log -> 4 planks (6 items). Costs the logs (worth 4 planks each, a
  // little more for the crafting) and must leave `k` of the input.
  for (const [logId, have] of logKinds) {
    const spare = logId === input ? have - k : have;
    const plankId = plankOf(logId);
    const already = inv[plankId] ?? 0;
    const need = Math.max(0, Math.ceil(k / 1.5) - already);
    const logs = Math.ceil(need / 4);
    if (logs <= 0 || logs > spare) continue;
    const n = Math.ceil(k / 1.5);
    const cost = logs * 4.2 + (n * 1.5 - k) * 0.3;
    if (!best || cost < best.cost) best = { k, fuel: plankId, n, cost, plankFrom: logId, planks: logs };
  }
  if (best) { const { cost, ...r } = best; return r; }
  // Nothing covers the whole batch: cook what we can.
  //   Only logs of the kind we're cooking: plank one (6 items of fuel), cook the rest.
  if (charcoalInput(input) && burnsFor(input) > 0 && (inv[input] ?? 0) >= 2 && !opts.some((o) => o.per < 8)) {
    const kk = Math.min(k, inv[input] - 1, 6);
    return { k: kk, fuel: plankOf(input), n: Math.ceil(kk / 1.5), plankFrom: input, planks: 1 };
  }
  //   Otherwise the fuel that cooks the most (coal on a small batch is fine here: better than nothing).
  let most = null;
  for (const o of opts) {
    const kk = Math.min(k, Math.floor(o.have * o.per));
    if (kk < 1) continue;
    const n = Math.ceil(kk / o.per);
    if (!most || kk > most.k || (kk === most.k && n * o.w < most.n * most.w)) most = { k: kk, fuel: o.id, n, w: o.w };
  }
  if (most) return { k: most.k, fuel: most.fuel, n: most.n, plankFrom: null, planks: 0 };
  // Coal/charcoal were held back only for being wasteful: still better than not cooking.
  for (const id of ['coal', 'charcoal']) if ((inv[id] ?? 0) > 0 && id !== input) return { k, fuel: id, n: Math.ceil(k / 8), plankFrom: null, planks: 0 };
  return null;
}
