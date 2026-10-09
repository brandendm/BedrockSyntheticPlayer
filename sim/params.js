// Every physics constant the simulator uses, in one place, each with where it came from. `fit: true` means the calibration (sim/calibrate.mjs) may move it; the
// rest are the game's own numbers (measured, or from the Java source the Bedrock engine follows). calibration.json (next to this file) overrides these: it is what the
// fitting writes. A constant is never edited here to make a test pass: it is measured (sim/probes) and fitted against the real game's traces.

export const PARAMS = {
  player: {
    halfWidth: 0.3, height: 1.8, eye: 1.52,                // (measured: game/calibrate.js)
    groundAccel: 0.098, groundFriction: 0.546,             // (tests/helpers.js McBody: walk 4.3 b/s)
    airAccel: 0.0196, airFriction: 0.91,
    gravity: 0.08, drag: 0.98, jump: 0.42, sprintJump: 0.2,
    step: 0.6,                                             // a ground step it walks up without a jump
    waterGravity: 0.019, waterDrag: 0.8, waterAccel: 0.02, swimUp: 0.04,
    buoy: 0.036, buoyDepth: 1.23, entryBrake: 0.11, brakeDepth: 3.0,           // (fit to probewater, build u307: the raw body floats with its feet ~1.3 under the surface; a fast fall in is braked)
  },
  boat: {
    halfWidth: 0.7, height: 0.455,                         // (a boat is 1.4 across)
    step: 0.45,                                            // (core/towline.js BOAT_CLIMB, measured)
    landFriction: 0.5, airFriction: 0.98, gravity: 0.04,
    waterBuoyancy: 0.5,
    wallKeep: 0.9, spawnDx: 0.2, spawnDz: 0.2,                                          // (probes: a boat spawned at z.5 sits at z.7)
    impulse: 0.3,                                          // (fit: applyImpulse on a boat moves it about a third as far as on a free body)
  },
  leash: {
    rest: 4.7, k: 0.14, pow: 1, blend: 0.5, yank: 0, yankAt: 6, kVertical: 0.3, maxPull: 1.4,      // (fit: rest = LEAD_SLACK; k from the sling peak 25 b/s at stretch 8.4)
    soft: 2, hard: 4, max: 12, snap: 10,                   // (the leashable component's own numbers)
  },
  item: { pickupRange: 1.0, useGapTicks: 10 },
};

const merge = (a, b) => { for (const [k, v] of Object.entries(b ?? {})) { if (v && typeof v === 'object') merge(a[k] ??= {}, v); else a[k] = v; } };
/** What the last calibration fitted ({ player: {...}, boat: {...}, leash: {...} }), or nothing. */
export let CAL = {};
try { const { readFileSync } = await import('node:fs'); CAL = JSON.parse(readFileSync(new URL('./calibration.json', import.meta.url), 'utf8')).params ?? {}; } catch { /* none yet */ }

/** A deep copy with calibration.json's values laid over it. */
export function loadParams(overrides = {}) {
  const p = JSON.parse(JSON.stringify(PARAMS));
  merge(p, CAL);
  merge(p, overrides);
  return p;
}
