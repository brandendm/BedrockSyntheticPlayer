// Goals that can be switched off (`!bot goal <name> on|off`, the dashboard's checkboxes). Pure.
// All on by default; the settings live in the world (game/agent.js settings()). Off means the
// plan skips it; staying alive (fights, running, getting out of holes, eating when starving) is
// never switched off.

export const GOALS = [
  { key: 'beds', label: 'Sleep at night (a bed, and sheep for its wool)' },
  { key: 'nights', label: 'Go home when it gets dark (off: work through the night, if armed and healthy)' },
  { key: 'house', label: 'Build a house (without one: dig in at night)' },
  { key: 'torches', label: 'Make torches and light the house' },
  { key: 'farm', label: 'Wheat farm (once there is a bucket)' },
  { key: 'iron', label: 'Mine iron for iron tools and armor' },
  { key: 'hunting', label: 'Hunt animals for food (starving: always)' },
  { key: 'storage', label: 'Put spare things away in the chests' },
  { key: 'witches', label: 'Fight witches (off: run from them)' },
  { key: 'villages', label: 'Go looking for a village (beds, chests, food) once armed' },
];

/** The goals after moving in that can be put in any order (`!bot order village farm iron`, the dashboard's arrows). */
export const ORDER_KEYS = ['village', 'farm', 'iron'];
export const DEFAULT_ORDER = ['village', 'farm', 'iron'];

/** An order as typed or saved (names or aliases, any case) -> the full order: what's named first, the rest after in the default order. */
export function parseOrder(input) {
  const words = Array.isArray(input) ? input : String(input ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const alias = { villages: 'village', town: 'village', farming: 'farm', wheat: 'farm', mine: 'iron', mining: 'iron', iron: 'iron' };
  const out = [];
  for (const w of words) { const k = alias[w] ?? w; if (ORDER_KEYS.includes(k) && !out.includes(k)) out.push(k); }
  for (const k of DEFAULT_ORDER) if (!out.includes(k)) out.push(k);
  return out;
}

/** The saved order of the movable goals (settings.order), or the default. */
export const orderOf = (settings = {}) => parseOrder(settings?.order);

/** { key: on } for every goal, from saved settings (missing = on). */
export function goalsOf(settings = {}) {
  const out = {};
  for (const g of GOALS) out[g.key] = settings?.[g.key] !== false;
  return out;
}

/** A goal name as typed ("iron", "Farm", "torch") -> its key, or null. */
export function goalKey(name) {
  const n = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const alias = { sleep: 'beds', bed: 'beds', torch: 'torches', hunt: 'hunting', food: 'hunting', chests: 'storage', store: 'storage', witch: 'witches', village: 'villages', town: 'villages', mining: 'iron', night: 'nights', dark: 'nights', home: 'nights', dusk: 'nights' };
  const k = alias[n] ?? n;
  return GOALS.some((g) => g.key === k) ? k : null;
}
