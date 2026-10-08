// The tow's tunable constants in one place (u274), so sim/tune.mjs can search them offline and the bot can read better ones from its memory
// (memory.data.leadTune overrides these). Pure. The ranges are what the search may try; the defaults are what the real game has proven.
export const TOW_TUNE = {
  loFloor:        { v: 5.4, min: 4.8, max: 6.2 },   // never treat the lead as pulling before this many apart (the engine's is ~5.6)
  guardMax:       { v: 8.8, min: 8.0, max: 9.4 },   // never stretch past this (a lead broke at 10.1)
  patienceMin:    { v: 12, min: 6, max: 24 },       // ticks a stretched boat may sit still before it counts as jammed
  patienceDef:    { v: 20, min: 10, max: 40 },
  groundTarget:   { v: 8.3, min: 7.0, max: 9.0 },   // the one jump from the ground before climbing
  yankMargin:     { v: 1.5, min: 0.8, max: 2.5 },   // a yank on the flat stretches at least this much past the pull distance
  stretchFrac:    { v: 0.7, min: 0.5, max: 0.9 },   // with no calibration, sling at this fraction of the lead's maximum
  slingStep:      { v: 1.0, min: 0.4, max: 1.6 },   // each failed sling stretches this much further
};
export const tuneDefaults = () => Object.fromEntries(Object.entries(TOW_TUNE).map(([k, d]) => [k, d.v]));
/** The constants in force: defaults, then whatever memory.data.leadTune holds (clamped to the ranges; anything unknown ignored). */
export function towTune(over) {
  const out = tuneDefaults();
  for (const [k, v] of Object.entries(over ?? {})) if (TOW_TUNE[k] && Number.isFinite(v)) out[k] = Math.min(TOW_TUNE[k].max, Math.max(TOW_TUNE[k].min, v));
  return out;
}
