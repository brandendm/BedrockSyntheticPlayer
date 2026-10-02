// The goal chain, for showing: every goal the bot works through in order, the tasks each needs,
// what it has against what it needs, and which one it's on. Pure (unit-tested); it reads the same
// facts the planners use, so what the dashboard shows is what the bot is really going by.
import { count, isLog, isPlanks, isWool, TOOL_STONE, has } from './recipes.js';
import { materials } from './house.js';
import { TORCH_GOAL } from './settle.js';

const HOUSE = materials();
const better = (inv, kind, tiers) => tiers.some((t) => has(inv, `${t}_${kind}`));
const STONE_UP = ['stone', 'iron', 'diamond', 'netherite'];
const ANY = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];

/** A task: counted ({have, need}) or a yes/no ({done}). `step` = the planner steps that work on it. */
const counted = (name, have, need, steps) => ({ name, have: Math.min(have, need), need, done: have >= need, steps });
const check = (name, done, steps) => ({ name, done: !!done, steps });

/**
 * facts: { inv, tableKnown, furnaceKnown, house: {bed, furnace, table}|null,
 *          project: {placed, total, needs:{stone, planks}}|null, step: current planner step }
 * returns [{ goal, status: 'done'|'current'|'todo', tasks: [...], currentTask }]
 */
export function goalChain(f) {
  const inv = f.inv;
  const logs = count(inv, isLog), planks = count(inv, isPlanks), cobble = count(inv, (id) => TOOL_STONE.has(id));
  const wool = Math.max(0, ...Object.entries(inv).filter(([id]) => isWool(id)).map(([, n]) => n));
  /** @type {Array<any>} */
  const goals = [];

  // 1. Wooden tools
  const pick = better(inv, 'pickaxe', ANY);
  goals.push({
    goal: 'Wooden pickaxe',
    done: pick,
    tasks: [
      counted('Logs', logs + Math.floor(planks / 4), 2, ['gather_logs']),
      check('Crafting table', f.tableKnown || has(inv, 'crafting_table'), ['place_table', 'goto_table']),
      check('Wooden pickaxe', pick, ['craft']),
    ],
  });

  // 2. Stone tools
  const kit = /** @type {Array<[string, number]>} */ ([['pickaxe', 3], ['sword', 2], ['axe', 3], ['shovel', 1]]);
  const missing = kit.filter(([k]) => !better(inv, k, STONE_UP));
  const kitCobble = missing.reduce((a, [, n]) => a + n, 0);
  goals.push({
    goal: 'Stone tools',
    done: missing.length === 0,
    tasks: [
      counted('Cobblestone', missing.length ? cobble : kitCobble, kitCobble || 9, ['get_stone']),
      ...kit.map(([k]) => check(`Stone ${k}`, better(inv, k, STONE_UP), ['craft'])),
    ],
  });

  // 3. Furnace
  const furnace = has(inv, 'furnace') || f.furnaceKnown || !!f.house?.furnace;
  goals.push({
    goal: 'Furnace',
    done: furnace,
    tasks: [counted('Cobblestone', furnace ? 8 : cobble, 8, ['get_stone']), check('Furnace', furnace, ['craft'])],
  });

  // 4. Bed
  const bed = has(inv, 'bed') || !!f.house?.bed;
  goals.push({
    goal: 'Bed',
    done: bed,
    tasks: [
      counted('Wool (one colour)', bed ? 3 : wool, 3, ['hunt']),
      counted('Planks', bed ? 3 : planks + logs * 4, 3, ['gather_logs']),
      check('Bed', bed, ['craft']),
    ],
  });

  // 5. Torches
  const torches = inv.torch ?? 0;
  goals.push({
    goal: 'Torches',
    done: torches >= TORCH_GOAL || !!f.house?.lit,
    tasks: [
      counted('Charcoal', torches >= TORCH_GOAL ? 2 : (inv.charcoal ?? 0) + (inv.coal ?? 0), Math.ceil(Math.max(0, TORCH_GOAL - torches) / 4) || 2, ['smelt', 'collect_smelt', 'wait_smelt', 'gather_logs']),
      counted('Torches', torches, TORCH_GOAL, ['craft']),
    ],
  });

  // 6. House
  const built = !!f.house, p = f.project;
  const stoneNeed = built ? 0 : p ? p.needs?.stone ?? 0 : Math.max(0, HOUSE.stone + 4 - cobble);
  const planksNeed = built ? 0 : p ? p.needs?.planks ?? 0 : Math.max(0, HOUSE.planks - planks - logs * 4);
  goals.push({
    goal: 'House',
    done: built,
    tasks: [
      check('Pick a flat spot', built || !!p, ['plan_house']),
      counted('Cobblestone', built ? 1 : cobble, built ? 1 : cobble + stoneNeed, ['get_stone']),
      counted('Planks', built ? 1 : planks + logs * 4, built ? 1 : planks + logs * 4 + planksNeed, ['gather_logs']),
      check('Door', !!f.house?.door || has(inv, 'wooden_door'), ['craft']),
      counted('Blocks placed', built ? p?.total ?? 69 : p?.placed ?? 0, p?.total ?? 69, ['build_house']),
    ],
  });

  // 7. Move in
  goals.push({
    goal: 'Move in',
    done: built && !f.house.damage && !f.house.blocked && !f.house.fire && !!f.house.bed && !!f.house.furnace && !!f.house.table && f.house.chest !== false && !!f.house.door && !!f.house.lit && f.house.litOutside !== false,
    tasks: [
      check('House intact', built && !f.house.damage, ['repair_house', 'get_stone', 'gather_logs']),
      check('Nothing in the way inside', built && !f.house.blocked, ['clear_house']),
      check('Not on fire', built && !f.house.fire, ['fight_fire']),
      check('Door hung', f.house?.door, ['furnish', 'craft']),
      check('Crafting table inside', f.house?.table, ['furnish']),
      check('Furnace inside', f.house?.furnace, ['furnish']),
      check('Chest inside', !!f.house && f.house.chest !== false, ['furnish', 'craft']),
      check('Bed inside', f.house?.bed, ['furnish', 'hunt']),
      check('Torch inside', f.house?.lit, ['furnish', 'wait_smelt']),
      check('Torches by the door', f.house?.litOutside !== false && !!f.house, ['light_outside']),
    ],
  });

  // 8-10. After moving in: a farm, iron, iron gear (core/advance.js).
  const a = f.advance;
  if (a) {
    goals.push({
      goal: 'Farm',
      done: a.farm,
      tasks: [
        check('Water by the farm', a.farm || a.waterKnown, ['check_water', 'get_iron', 'smelt', 'craft']),
        check('Hoe', a.farm || ['wooden_hoe', 'stone_hoe', 'iron_hoe'].some((id) => has(inv, id)), ['craft']),
        check('Wheat planted', a.farm, ['make_farm']),
      ],
    });
    goals.push({
      goal: 'Iron',
      done: a.iron >= a.ironGoal,
      tasks: [counted('Iron (raw, ingots, made)', a.iron, a.ironGoal, ['get_iron', 'smelt', 'collect_smelt', 'wait_smelt'])],
    });
    goals.push({
      goal: 'Iron gear',
      done: a.tools >= 4 && a.armor >= 4 && a.bucket && a.shield,
      tasks: [
        counted('Iron tools', a.tools, 4, ['craft']),
        check('Bucket', a.bucket, ['craft']),
        check('Shield', a.shield, ['craft', 'equip']),
        counted('Iron armor worn', a.armor, 4, ['craft', 'equip']),
      ],
    });
  }

  // Switched off (core/toggles.js): not part of the plan, so not "current" and not waiting its turn. A goal already
  // done stays done. Move in goes with the house, the iron gear with iron.
  const SWITCH = { 'Bed': 'beds', 'Torches': 'torches', 'House': 'house', 'Move in': 'house', 'Farm': 'farm', 'Iron': 'iron', 'Iron gear': 'iron' };
  for (const g of goals) g.off = !!(f.toggles && SWITCH[g.goal] && f.toggles[SWITCH[g.goal]] === false && !g.done);

  // Status: goals are worked in order; the current one is the first not done.
  // Normally the first unfinished one; but if the bot is working on a later one (no sheep around
  // yet, so the bed waits), the one its current step belongs to.
  // A later goal only takes over the display when the step clearly belongs to it and not to the
  // first unfinished goal (generic steps like explore or craft never move it: that made the
  // dashboard flip between "Wooden pickaxe" and "Bed inside" with every glance).
  const first = goals.findIndex((g) => !g.done && !g.off);
  // Only steps that belong to one goal can pull the display ahead (hunting sheep: the bed;
  // the furnace jobs: torches; house steps). Logs and stone feed half the goals: never.
  const DISTINCT = new Set(['hunt', 'smelt', 'collect_smelt', 'wait_smelt', 'plan_house', 'build_house', 'repair_house', 'make_farm', 'get_iron', 'check_water', 'tend_farm', 'store']);
  const mine = (g) => g.tasks.some((t) => !t.done && t.steps.includes(f.step));
  let current = first;
  if (first >= 0 && DISTINCT.has(f.step) && !mine(goals[first])) {
    const later = goals.findIndex((g, i) => i > first && !g.done && !g.off && mine(g));
    if (later >= 0) current = later;
  }
  return goals.map((g, i) => {
    const status = g.done ? 'done' : g.off ? 'off' : i === current ? 'current' : 'todo';
    let currentTask = null;
    if (status === 'current') {
      const byStep = g.tasks.findIndex((t) => !t.done && t.steps.includes(f.step));
      currentTask = byStep >= 0 ? byStep : g.tasks.findIndex((t) => !t.done);
    }
    // A finished goal is finished: every task ticked (it may have used up the logs it counted).
    const tasks = g.tasks.map(({ steps, ...t }) => /** @type {any} */ (t)).map((t) => (g.done ? { ...t, done: true, ...(t.need != null ? { have: t.need } : {}) } : t));
    return { goal: g.goal, status, currentTask, tasks };
  });
}
