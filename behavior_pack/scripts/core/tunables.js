// Every constant the trainer (brain/trainer.py + sim/train.mjs) may move, in one place (u290). Pure (unit-tested).
//
// A tunable has a default (what the real game has proven), a range (what a search may try, never outside it) and a group (which evaluator can score it:
// 'tow' by the tow simulator, 'combat' by tools/sim_combat.mjs, 'cave' only by the real game's cave tests). The bot reads the values through `live`, which
// `applyPolicy` rewrites in place: nothing is imported by value, so a policy takes effect at once, with no reload (`!bot policy {json}`; the trainer sends it).
//
// What may NOT be here: physics (measured, never tuned to pass a test: sim/params.js), and anything a wrong value makes unsafe without a test that would catch
// it. Adding a constant is adding a line.
import { TOW_TUNE } from './towtune.js';

export const TUNABLES = {
  // --- the tow (scored by the tow simulator) ---
  ...Object.fromEntries(Object.entries(TOW_TUNE).map(([k, d]) => [k, { ...d, group: 'tow' }])),
  // --- fight or run (scored by the combat simulator, then the cave tests) ---
  fightMargin:        { v: 0.6, min: 0.35, max: 1.0, group: 'combat' },    // start a fight when the time to kill is under this fraction of the time to die
  keepFightingMargin: { v: 0.9, min: 0.6, max: 1.3, group: 'combat' },    // once engaged, keep going unless clearly losing
  committedMargin:    { v: 1.3, min: 0.9, max: 1.8, group: 'combat' },    // toe to toe with a melee mob: running gives it free hits
  fleeHealth:         { v: 6, min: 3, max: 9, group: 'combat' },          // run below this many hit points (before armor)
  // --- caves (scored only by the real game: tests cavewalk, cavemobs, caveescape, cavedeep) ---
  caveTorchEvery:     { v: 7, min: 4, max: 12, group: 'cave' },           // blocks between torches laid in the dark
  caveFleeLight:      { v: 4, min: 0, max: 8, group: 'cave' },            // light level at which a dark pocket counts as a mob spawner worth leaving
};

export const GROUPS = ['tow', 'combat', 'cave'];
export const defaults = () => Object.fromEntries(Object.entries(TUNABLES).map(([k, d]) => [k, d.v]));
const clamp = (k, v) => Math.min(TUNABLES[k].max, Math.max(TUNABLES[k].min, v));

/** The values in force: read these (`live.fightMargin`), never copy them. */
export const live = defaults();

/** Lay a policy over the defaults, in place: known keys only, finite numbers only, clamped to their ranges. Returns the policy as applied. */
export function applyPolicy(over) {
  const d = defaults();
  for (const k of Object.keys(live)) live[k] = d[k];
  for (const [k, v] of Object.entries(over ?? {})) if (TUNABLES[k] && typeof v === 'number' && Number.isFinite(v)) live[k] = clamp(k, v);
  return { ...live };
}

/** Only the values that differ from the defaults (what a champion file holds). */
export function diffFromDefaults(values = live) {
  const out = {};
  for (const [k, d] of Object.entries(TUNABLES)) if (typeof values[k] === 'number' && Math.abs(values[k] - d.v) > 1e-9) out[k] = values[k];
  return out;
}

/** The keys of a group (or all). */
export const keysOf = (group) => Object.keys(TUNABLES).filter((k) => !group || TUNABLES[k].group === group);

/** A policy as a point in the unit cube (for the search) and back. */
export const toUnit = (policy, keys) => keys.map((k) => { const d = TUNABLES[k], v = policy[k] ?? d.v; return (clamp(k, v) - d.min) / (d.max - d.min); });
export const fromUnit = (u, keys, base = {}) => { const out = { ...base }; keys.forEach((k, i) => { const d = TUNABLES[k]; out[k] = Math.round((d.min + Math.min(1, Math.max(0, u[i])) * (d.max - d.min)) * 1000) / 1000; }); return out; };
