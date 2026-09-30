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
];

/** { key: on } for every goal, from saved settings (missing = on). */
export function goalsOf(settings = {}) {
  const out = {};
  for (const g of GOALS) out[g.key] = settings?.[g.key] !== false;
  return out;
}

/** A goal name as typed ("iron", "Farm", "torch") -> its key, or null. */
export function goalKey(name) {
  const n = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const alias = { sleep: 'beds', bed: 'beds', torch: 'torches', hunt: 'hunting', food: 'hunting', chests: 'storage', store: 'storage', witch: 'witches', mining: 'iron', night: 'nights', dark: 'nights', home: 'nights', dusk: 'nights' };
  const k = alias[n] ?? n;
  return GOALS.some((g) => g.key === k) ? k : null;
}
