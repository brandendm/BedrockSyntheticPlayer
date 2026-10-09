// The swim-out reflex: when the bot, in water and not busy, is pulled out of it (game/agent.js checkWater). Pure, unit-tested (tests/water.test.js).
//
// The u204 leadboat run died at 42 s with "the task was replaced (swim_out -> none)": the test course starts with a pond, the tow walks in
// it with raw moves (the motor is not busy), and 0.6 s in water was all the reflex wanted before it took the task. A bot that is in water
// on purpose (a test, a tow, an arena, a boat crossing) is left to its own routine: the reflex only comes for it when it is really drowning.

/** Tasks that run their own movement and may be in water on purpose (the pond of a tow course, a lake to cross, a dive tank). */
export const OWN_WATER_TASKS = new Set(['test', 'tow', 'arena', 'calibrate']);

/** Air left (0..1) under which the reflex takes the bot for air. */
export const AIR_FLOOR = 0.5;      // an ordinary job
export const OWN_AIR_FLOOR = 0.3;  // a job of its own in water: about 4.5 s of breath left, a swim up is 1-2 s
export const SWIM_AIR_FLOOR = 0.25; // an arena that swims on purpose (the dive)

/** Ticks in water with nothing moving the bot before it is taken to shore (u307: was 10, 0.5 s -- it swam out of anything it was floating in on purpose; drowning is the air floors below, this is only for a bot that would float idle for ever). */
export const SHORE_IDLE_TICKS = 100;

/** Does this job work in water by itself? */
export const ownsWater = (task, crossing = false) => !!crossing || OWN_WATER_TASKS.has(task);

/** The air level under which the reflex comes for a bot doing `task`. */
export function airFloor(task, swims = false, crossing = false) {
  if (swims) return SWIM_AIR_FLOOR;
  return ownsWater(task, crossing) ? OWN_AIR_FLOOR : AIR_FLOOR;
}

/**
 * What the reflex does now. State: { task (kind of the current job), crossing (our own boat crossing is under way), inBoat, inWater,
 * headUnder, air (0..1), swims (an arena that dives), motorBusy, onGround, idle (ticks in water with nothing going on, so far), step
 * (ticks between checks) }. Returns { act: 'air' | 'shore' | null, idle }: 'air' = up for air at once, 'shore' = swim to the nearest land.
 */
export function waterReflex(s) {
  if (s.inBoat) return { act: null, idle: 0 };                       // sitting in a boat on the water: nothing to swim out of
  const own = ownsWater(s.task, s.crossing);
  // Running out of air, whatever we are doing (a flooded shaft, a route through water): drop it and get the head into air.
  if (s.task !== 'swim_out' && s.headUnder && s.air < airFloor(s.task, s.swims, s.crossing)) return { act: 'air', idle: s.idle };
  if (!s.inWater || s.swims || s.motorBusy || s.task === 'swim_out' || own) return { act: null, idle: 0 };
  // Standing on the bottom with the head in the air (a shallow pool, a puddle): not swimming, nothing to swim out of.
  if (s.onGround && !s.headUnder) return { act: null, idle: 0 };
  const idle = s.idle + s.step;
  return idle < SHORE_IDLE_TICKS ? { act: null, idle } : { act: 'shore', idle: 0 };
}
