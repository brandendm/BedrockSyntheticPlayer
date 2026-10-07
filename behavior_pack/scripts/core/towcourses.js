// The tow courses (u241): small, different places to lead a boat, each a thing a player does with a lead that the bot has to learn.
// Pure (unit-tested): a course is a list of `fill` / `setblock` commands round the site (x, gy, z: gy is the slab's grass layer, the floor),
// where the boat sits, where the walker stands, and the gold block's standing place. `game/scenarios.js` runs them: you first (and the bot
// watches how you do it: core/towlearn.js), then the bot.
//
//   leadstep   up 1, 2 and 3 steps, each with a flat top: the jump that pulls the boat up, at three heights.
//   leadstair  a staircase, treads 2 deep: the boat is jammed at every riser, and there is little room to stretch the lead.
//   leadledge  a 3-high wall with a top only 2 deep, then a pit 6 wide: no room to stretch, so build forward over the pit, jump, and bring the
//              boat up; then the bridge (blocks given).
//   leadturn   a corridor 4 wide with four corners: the boat is pulled straight at you and clips the inside of each one.
//   leadgate   two walls with a gate in each, on opposite sides of the lane: the boat has to be lined up with each gate before it is pulled.

/** @typedef {{ room?: number, cmds: string[], boat: {x:number,y:number,z:number}, start: {x:number,y:number,z:number}, goal: {x:number,y:number,z:number}, zone: number }} Course */

export const TOW_META = {
  leadstep: {
    short: 'Lead a boat up three steps',
    kit: [['lead', 2]],
    ext: { w: 10, e: 30, r: 8 },
    text: 'A boat at the west end and a course of three steps up, each with a flat top: 1 high, then 2, then 3, wall to wall (no way round). Put a lead on the boat (use the lead on it) and lead it up all three to the gold block on the top: the boat has to end within 3.5 blocks of it. A boat on a lead is jammed by a step: stand above it, walk away until the lead is taut, and jump.',
  },
  leadstair: {
    short: 'Lead a boat up a staircase',
    kit: [['lead', 2]],
    ext: { w: 10, e: 30, r: 8 },
    text: 'A boat at the west end and a staircase of four steps up, each tread only 2 deep (little room to stretch the lead on any of them), then a flat top with the gold block. Put a lead on the boat and lead it up to the gold block: the boat has to end within 3.5 blocks of it.',
  },
  leadledge: {
    short: 'Lead a boat up a short ledge, then across a pit',
    kit: [['lead', 2], ['dirt', 32]],
    ext: { w: 10, e: 30, r: 8 },
    text: 'A boat at the west end, then a 3-high wall (you can climb it by two steps at its north side; the boat cannot) whose top is only 2 deep, then a pit 6 wide and 6 deep across the whole width, then a flat top with the gold block. The top of the wall is too short to stretch the lead on: build forward over the pit to get the room, jump to pull the boat up, then bridge the rest with the boat following. You have 32 dirt. The boat has to end within 3.5 blocks of the gold block.',
  },
  leadturn: {
    short: 'Lead a boat round four corners',
    kit: [['lead', 2]],
    ext: { w: 10, e: 36, r: 16 },
    text: 'A boat at the west end of a stone corridor 4 wide with four corners (south, east, north, east). The boat is pulled straight at you, so it catches on the inside of each corner: go wide, past the corner, and pull it round. Put a lead on the boat and lead it to the gold block at the end: the boat has to end within 3.5 blocks of it.',
  },
  leadgate: {
    short: 'Lead a boat through two offset gates',
    kit: [['lead', 2]],
    ext: { w: 10, e: 36, r: 10 },
    text: 'A boat at the west end of a lane with two walls across it, a gate 3 wide in each, the first at the south side and the second at the north. The boat goes straight at you and the gate is only a little wider than it: line it up with the gate before you pull it through. Put a lead on the boat and lead it to the gold block: the boat has to end within 3.5 blocks of it.',
  },
};
export const TOW_NAMES = Object.keys(TOW_META);

/**
 * The course `name` at site (x, gy, z). The lane is z-3..z+3 between stone walls 8 high at z-4 and z+4 (a corridor course widens its own).
 * @returns {Course}
 */
export function towCourse(name, x, gy, z) {
  const cmds = [];
  const fill = (x1, y1, z1, x2, y2, z2, id) => cmds.push(`fill ${x + x1} ${gy + y1} ${z + z1} ${x + x2} ${gy + y2} ${z + z2} ${id}`);
  const set = (dx, y, dz, id) => cmds.push(`setblock ${x + dx} ${gy + y} ${z + dz} ${id}`);
  const meta = TOW_META[name];
  if (!meta) throw new Error(`no tow course ${name}`);
  const { w, e, r } = meta.ext;
  // The floor and the air over it, the same everywhere; the start end is open grass.
  fill(-w, 0, -r, e, 0, r, 'grass_block');
  fill(-w, 1, -r, e, 9, r, 'air');
  // (u242 live: the lane was thin walls, and the walker went along the OUTSIDE of them (the route search takes the nearest it can get to
  // the goal) while the boat stayed jammed at the west end: everything beside the lane, out to the edge of the site, is solid, and the east end
  // is closed.)
  const lane = (x1, x2) => { fill(x1, 1, -r, x2, 8, -4, 'stone'); fill(x1, 1, 4, x2, 8, r, 'stone'); fill(x2, 1, -4, x2, 8, 4, 'stone'); };
  let goalDx = 0, goalH = 0;
  switch (name) {
    case 'leadstep': {
      lane(-1, 26);
      fill(6, 1, -3, 11, 1, 3, 'stone');
      fill(12, 1, -3, 17, 2, 3, 'stone');
      fill(18, 1, -3, 25, 3, 3, 'stone');
      goalDx = 22; goalH = 3;
      break;
    }
    case 'leadstair': {
      lane(-1, 26);
      for (let k = 0; k < 4; k++) fill(6 + k * 2, 1, -3, 7 + k * 2, 1 + k, 3, 'stone');
      fill(14, 1, -3, 25, 4, 3, 'stone');
      goalDx = 21; goalH = 4;
      break;
    }
    case 'leadledge': {
      lane(-1, 26);
      fill(4, 1, -3, 4, 1, -2, 'stone');                 // a way up for you at the north side: two steps, then the wall's top
      fill(5, 1, -3, 5, 2, -2, 'stone');
      fill(6, 1, -3, 7, 3, 3, 'stone');                 // the wall, its top two deep, across the whole lane (the boat is pulled straight at it)
      fill(8, -5, -3, 13, 0, 3, 'air');                  // the pit, 6 wide and 6 deep (the floor under it dug out)
      fill(14, 1, -3, 25, 3, 3, 'stone');                // the far side, as high as the wall's top
      goalDx = 21; goalH = 3;
      break;
    }
    case 'leadturn': {
      // Solid block, the corridor cut out of it (4 wide): east along z-1..z+2, south at x+4..x+7 down to z+9, east along z+6..z+9, north at x+16..x+19, east.
      fill(-1, 1, -r, 33, 4, r, 'stone');
      fill(-1, 1, -1, 7, 4, 2, 'air');
      fill(4, 1, -1, 7, 4, 9, 'air');
      fill(4, 1, 6, 19, 4, 9, 'air');
      fill(16, 1, -1, 19, 4, 9, 'air');
      fill(16, 1, -1, 30, 4, 2, 'air');
      goalDx = 28; goalH = 0;
      break;
    }
    case 'leadgate': {
      lane(-1, 34);
      fill(10, 1, -3, 10, 4, 3, 'stone');
      fill(10, 1, 1, 10, 4, 3, 'air');                   // gate 1: z+1..z+3 (the south side)
      fill(20, 1, -3, 20, 4, 3, 'stone');
      fill(20, 1, -3, 20, 4, -1, 'air');                 // gate 2: z-3..z-1 (the north side)
      goalDx = 29; goalH = 0;
      break;
    }
    default: throw new Error(`no tow course ${name}`);
  }
  set(goalDx, goalH, 0, 'gold_block');
  return {
    cmds,
    boat: { x: x - 7.5, y: gy + 1, z: z + 0.5 },
    start: { x: x - 6, y: gy + 1, z: z + 0.5 },
    goal: { x: x + goalDx + 0.5, y: gy + goalH + 1, z: z + 0.5 },
    zone: 3.6,                  // (u246 live: the lead's slack leaves the boat 3.1-3.4 behind a walker who stands 1.5 past the gold block: 3 was a hair too tight)
    room: goalDx >= 28 && goalDx < 29 ? 1.5 : 2.5,   // how far past the gold block the walker may stand (the turn course ends 2 beyond it)
  };
}
