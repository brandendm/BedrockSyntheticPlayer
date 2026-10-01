// Task chains, the way AltoClef has them: ask for an item ("get iron_pickaxe") and the bot works out
// what that takes, in what order, from what it already has: logs, a table, a wooden pickaxe, stone,
// a stone pickaxe, iron ore, a furnace and fuel, ingots, the pickaxe. Pure (unit-tested).
//
// chainStep() is asked every planning pass and returns the planner's next step toward the goal (the
// same steps the ladder uses: gather_logs, get_stone, get_iron, smelt, craft...), or null when the
// goal is met. It looks only at what's in the pack, so a half-done chain picks up where it was.
import { count, has, isLog, isPlanks, isWool, RECIPES, TOOL_STONE } from './recipes.js';
import { craftStep } from './settle.js';
import { planFuel } from './fuel.js';

const ALIAS = { logs: 'log', wood: 'log', stone: 'cobblestone', cobble: 'cobblestone', iron: 'iron_ingot', ingot: 'iron_ingot', ingots: 'iron_ingot', ore: 'raw_iron', table: 'crafting_table', sticks: 'stick', plank: 'planks', wool: 'wool', horse: 'saddled_horse', tame: 'saddled_horse', ride: 'riding_horse', riding: 'riding_horse', mount: 'riding_horse', ride_horse: 'riding_horse', ride_a_horse: 'riding_horse', tame_horse: 'saddled_horse' };

/** A name as typed ("Iron Pickaxe", "minecraft:logs") -> an item id the chain knows, or null. */
export function chainItem(name) {
  const id = String(name ?? '').toLowerCase().replace(/^minecraft:/, '').trim().replace(/[\s-]+/g, '_');
  const k = ALIAS[id] ?? id;
  if (['log', 'cobblestone', 'raw_iron', 'iron_ingot', 'saddled_horse', 'riding_horse'].includes(k) || RECIPES[k]) return k;
  return null;
}

const tier = (inv) => (['iron', 'diamond', 'netherite'].some((t) => has(inv, `${t}_pickaxe`)) ? 3 : has(inv, 'stone_pickaxe') ? 2 : has(inv, 'wooden_pickaxe') ? 1 : 0);

/** How many of `item` we hold. */
export function held(inv, item) {
  if (item === 'log') return count(inv, isLog);
  if (item === 'planks') return count(inv, isPlanks);
  if (item === 'cobblestone') return count(inv, (id) => TOOL_STONE.has(id));
  if (item === 'raw_iron') return (inv.raw_iron ?? 0) + (inv.iron_ore ?? 0) + (inv.deepslate_iron_ore ?? 0);
  return inv[item] ?? 0;
}

/**
 * The next step toward having n of `item`, or null if we do. f: { inv, tableDist, furnaceKnown,
 * smelt ({ready,...}|null), oreCooking }. A { step: 'blocked', missing } when the chain can't
 * get there (something it has no way to collect yet).
 */
export function chainStep(item, n, f) {
  const inv = f.inv;
  // A horse (game/horse.js): tame it, saddle it (a saddle can't be crafted: loot or a trade), get on.
  if (item === 'saddled_horse' || item === 'riding_horse') {
    const h = f.horse ?? { found: false };
    if (item === 'riding_horse' && h.mounted) return null;
    if (item === 'saddled_horse' && h.tamed && h.saddled) return null;
    if (!h.found) return { step: 'blocked', missing: 'a horse within 64 blocks' };
    if (!h.tamed) return { step: 'horse', do: 'tame' };
    if (!h.saddled) return h.saddleInPack ? { step: 'horse', do: 'saddle' } : { step: 'blocked', missing: 'a saddle (they cannot be crafted: loot or a trade)' };
    return { step: 'horse', do: 'mount' };
  }
  const have = held(inv, item);
  if (item === 'crafting_table' && Number.isFinite(f.tableDist)) return null;
  if (item === 'furnace' && (f.furnaceKnown || have > 0)) return null;
  if (have >= n) return null;
  const short = n - have;
  switch (item) {
    case 'log': return { step: 'gather_logs', count: have + short, wanted: ['the chain'] };
    case 'cobblestone': return tier(inv) >= 1 ? { step: 'get_stone', need: short, why: 'the chain' } : chainStep('wooden_pickaxe', 1, f);
    case 'raw_iron': return tier(inv) >= 2 ? { step: 'get_iron', need: short, why: 'the chain' } : chainStep('stone_pickaxe', 1, f);
    case 'iron_ingot': {
      if (f.smelt?.ready) return { step: 'collect_smelt' };
      const cooking = f.oreCooking ?? 0;
      if (f.smelt && have + cooking >= n) return { step: 'wait_smelt' };
      const raw = held(inv, 'raw_iron');
      const rawNeed = Math.max(0, short - cooking);
      if (raw < rawNeed) return chainStep('raw_iron', rawNeed, f);
      if (raw === 0) return f.smelt ? { step: 'wait_smelt' } : null;
      const fur = chainStep('furnace', 1, f);
      if (fur) return fur;
      if (!planFuel(inv, 'raw_iron', raw)) return { step: 'gather_logs', count: count(inv, isLog) + Math.max(1, Math.ceil(raw / 6)), wanted: ['furnace fuel'] };
      return { step: 'smelt', input: 'ore', n: raw, fuelPlanks: 0 };
    }
    default: {
      const r = RECIPES[item];
      if (!r) return { step: 'blocked', missing: item };
      const crafts = Math.ceil(short / r.out);
      for (const inp of r.inputs) {
        const total = inp.n * crafts;
        if (inp.match === 'iron_ingot') { const s = chainStep('iron_ingot', total, f); if (s) return s; }
        else if (typeof inp.match === 'function' && inp.match('cobblestone') && !inp.match('oak_planks')) { const s = chainStep('cobblestone', total, f); if (s) return s; }
        else if (typeof inp.match === 'function' && inp.match('white_wool')) { if (count(inv, isWool) < total) return { step: 'hunt', what: 'sheep', need: total - count(inv, isWool) }; }
        else if (inp.match === 'wheat') { if ((inv.wheat ?? 0) < total) return { step: 'blocked', missing: 'wheat' }; }
        else if (typeof inp.match === 'function' && inp.match('coal') && !inp.match('oak_planks')) { if (held(inv, 'coal') + held(inv, 'charcoal') < total) return { step: 'blocked', missing: 'coal' }; }
      }
      const items = Array(Math.min(crafts, 8)).fill(item);
      return craftStep(inv, items, f.tableDist);
    }
  }
}

/**
 * The chain laid out for show, in the order it's worked: ['log', 'crafting_table', 'wooden_pickaxe',
 * 'cobblestone', 'stone_pickaxe', 'raw_iron', 'furnace', 'iron_ingot', 'iron_pickaxe'].
 */
export function chainOutline(item) {
  if (item === 'saddled_horse') return ['find a horse', 'tame it', 'saddle it'];
  if (item === 'riding_horse') return ['find a horse', 'tame it', 'saddle it', 'get on'];
  const out = [];
  const add = (x) => { if (!out.includes(x)) out.push(x); };
  const visit = (x) => {
    if (x === 'log') return add('log');
    if (x === 'cobblestone') { visit('wooden_pickaxe'); return add('cobblestone'); }
    if (x === 'raw_iron') { visit('stone_pickaxe'); return add('raw_iron'); }
    if (x === 'iron_ingot') { visit('raw_iron'); visit('furnace'); return add('iron_ingot'); }
    const r = RECIPES[x];
    if (!r) return add(x);
    if (r.table) visit('crafting_table');
    for (const inp of r.inputs) {
      if (inp.match === 'iron_ingot') visit('iron_ingot');
      else if (typeof inp.match === 'function' && inp.match('cobblestone') && !inp.match('oak_planks')) visit('cobblestone');
      else if (typeof inp.match === 'function' && inp.match('white_wool')) add('wool');
      else if (inp.match === 'wheat') add('wheat');
      else add('log');
    }
    add(x);
  };
  visit(item);
  return out;
}
