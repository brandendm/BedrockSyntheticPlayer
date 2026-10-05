// Where everything is in the iron farm (u212). Plan coordinates: x east, y up, z south; the builder shifts them to wherever the farm goes. The
// farm is a tower on the ground: the golems spawn on a big open platform up top, the water takes them to a hole in its middle (four open fence
// gates over the hole keep the water out of it, so every current ends in it), they fall down a shaft into a small hallway at the bottom: a little
// water there presses the golem into one corner, where two lit campfires side by side stand over two hoppers, with lava on signs at the golem's
// head height over one of them (u214: the second campfire and the shape of the hallway are the player's own redesign of u212). What it drops goes
// through the hoppers into a double chest in a small room behind glass, with a door: you stand at the bottom, not up in the sky. Layers (y):
//
//   y 7        slabs on the tops of the platform's walls (golems do not spawn on slabs)
//   y 4-6      the platform: 16 x 16, open to the sky, walls 3 high (a golem cannot climb out); water sources along the middle of each edge make
//              the water run toward the middle; the four 2 x 2 corners are solid (see waterSources for why). In its middle, at y 4, the four gates
//   y 3        the platform's floor (also the pod's roof); in its middle the 2 x 2 hole, each cell capped with a wall sign (signs stop water, not golems)
//   y 1-2      the pod (12 x 12 inside, 2 high): 20 beds in two rows, 10 composters in the walls, 10 villagers, torches; the shaft goes through it
//   y -6..2    the shaft (2 x 2) and, at the bottom of it, the kill hallway (x 7-9, z 7-8, y -6..-3): one water source; the two campfires in its east
//              column (they stop the water, so it runs on to the north-east corner), the lava over the north-east one
//   y -7       the tower's floor, on the ground; hoppers in it under the hallway, a double chest in the room
//   y -6..-4   the room (3 x 3, 3 high) east of the hallway: glass window onto it, the chests at your feet, a door in the east wall
//
// The village is the pod; its centre works out at the middle of the platform, so the platform is in the spawn volume (17 x 13 x 17 blocks, 8 each
// way) wherever Bedrock puts the centre. The ground must stay out of that volume (golems spawn there too): the builder puts the tower's floor
// above the highest ground within reach of the volume.

export const box = (x1, y1, z1, x2, y2, z2) => ({ x1, y1, z1, x2, y2, z2 });

export const FLOOR_Y = 3;                                 // the platform's floor layer (and the pod's roof)
export const WATER_Y = 4;                                 // the platform's water layer: feet level of what spawns there
export const RIM_Y = 7;                                   // slabs on the tops of the walls
export const BASE_Y = -7;                                 // the tower's floor layer, on the ground
export const PLATFORM = box(0, 4, 0, 15, 6, 15);          // inside the walls
export const PLATFORM_SHELL = box(-1, 3, -1, 16, 6, 16);
/** The four 2 x 2 corners of the platform, solid to the walls' top (the water cannot make a dead pocket there, and nothing stands in one). */
export const CORNER_BOXES = Object.freeze([box(0, 4, 0, 1, 6, 1), box(14, 4, 0, 15, 6, 1), box(0, 4, 14, 1, 6, 15), box(14, 4, 14, 15, 6, 15)]);
/** Every platform cell in a corner: [[x, z], ...]. */
export const CORNERS = Object.freeze(CORNER_BOXES.flatMap((b) => { const o = []; for (let x = b.x1; x <= b.x2; x++) for (let z = b.z1; z <= b.z2; z++) o.push([x, z]); return o; }));
export const HOLE = box(7, 3, 7, 8, 3, 8);                // the 2 x 2 hole in the floor
export const HOLE_CENTRE = Object.freeze({ x: 8, z: 8 });
export const POD = box(2, 1, 2, 13, 2, 13);               // inside
export const POD_SHELL = box(1, 0, 1, 14, 2, 14);
export const SHAFT = box(7, -6, 7, 8, 2, 8);              // the 2 x 2 shaft, chamber at its foot
export const SHAFT_SHELL = box(6, -7, 6, 9, 2, 9);
export const ROOM = box(11, -6, 6, 13, -4, 9);           // inside
export const ROOM_SHELL = box(10, -7, 5, 14, -3, 10);
export const WINDOW = box(10, -6, 7, 10, -4, 8);          // glass between the room and the hallway
export const DOOR = Object.freeze({ x: 14, y: -6, z: 7 }); // lower half; the upper half is above it
export const STEP = Object.freeze({ x: 15, y: -7, z: 7 }); // a slab outside the door, at the ground
export const CHAMBER_FLOOR_Y = -6;
/** The kill hallway: the shaft's foot and the cells east of it (x 7-9, z 7-8), the floor layer; its east half is 4 high (y -6..-3) for the golem and the campfire it stands on. */
export const HALL = box(9, -6, 7, 9, -3, 8);               // the part carved out of the shaft's east wall
export const CHAMBER = box(7, -6, 7, 9, -6, 8);             // the floor layer of the whole hallway
/**
 * The two campfires, lit, side by side in the hallway's east column (u214, the player's redesign): the first is in the north-east corner, under the
 * lava, where the water presses the golem; the second is south of it. A campfire does not let the water in (lit ones stood in the player's water),
 * so the two close the east column to it and the current runs along the north wall into the first. Each has a hopper under it.
 */
export const CAMPFIRES = Object.freeze([{ x: 9, y: -6, z: 7 }, { x: 9, y: -6, z: 8 }]);
/** The lava, at the golem's head height (two blocks up from its feet) directly over the campfire, held by three signs; the walls and the glass hold the rest. */
export const LAVA = Object.freeze({ x: 9, y: -4, z: 7 });
/** The hallway's one water source, in the south-west corner: it runs north and east (the campfires in the east column stop it), which presses the golem north-east. */
export const CHAMBER_WATER = Object.freeze({ x: 7, y: -6, z: 8 });
/** The hallway's water cells in all: the source, the two it feeds and the cell they both feed (north-west of the first campfire, where the current ends). */
export const CHAMBER_WET = Object.freeze([{ x: 7, y: -6, z: 8, level: 0 }, { x: 7, y: -6, z: 7, level: 1 }, { x: 8, y: -6, z: 8, level: 1 }, { x: 8, y: -6, z: 7, level: 2 }]);
/** The four open fence gates over the hole, at the platform's water layer: water cannot go into them, so the currents end there; a golem walks through. */
export const GATES = Object.freeze([{ x: 7, y: 4, z: 7 }, { x: 8, y: 4, z: 7 }, { x: 7, y: 4, z: 8 }, { x: 8, y: 4, z: 8 }]);
export const GATE_ID = 'fence_gate';
/**
 * The hoppers (u214: three, the player's count; u212 had seven under every cell): one under each campfire, the south one feeding the north one, and the
 * north one feeding a third under the window that runs east into the chests (facing: 2 north, 3 south, 4 west, 5 east, 0 down). What is dropped
 * west of the campfires is carried by the water to them (checked), so nothing is under the four cells of the shaft's foot.
 */
export const HOPPERS = Object.freeze([
  { x: 9, y: -7, z: 7, facing: 5 }, { x: 9, y: -7, z: 8, facing: 2 },
]);
/**
 * The two chests side by side that make the double chest, in the floor layer; both face the same way so they pair. u217 (the player's idea): the first
 * is right against the hallway, under the window's lower north cell, so the first hopper feeds it directly and the third hopper is gone; over it, in
 * place of that pane of glass, an upside-down stair (a chest opens under one; its full top half and its lower step on the hallway side close the
 * hallway off as the glass did, the open quarter is on the room side).
 */
export const CHESTS = Object.freeze([{ x: 10, y: -7, z: 7 }, { x: 11, y: -7, z: 7 }]);
/** The upside-down stair over the first chest. Bedrock's cobblestone stair is `stone_stairs`; weirdo_direction 1 puts its lower step on the west (hallway) side. */
export const STAIR = Object.freeze({ x: 10, y: -6, z: 7 });
export const STAIR_ID = 'stone_stairs';
export const STAIR_STATES = Object.freeze({ weirdo_direction: 1, upside_down_bit: true });
export const CHEST_FACING = 'south';
export const STAND = Object.freeze({ x: 12.5, y: -6, z: 8.5 });   // where the viewer is put: in the room, the window ahead
export const POD_VIEW = Object.freeze({ x: 2.5, y: 1, z: 8.5 });
export const TOP_VIEW = Object.freeze({ x: -0.5, y: 7.5, z: 7.5 }); // on the platform's west wall (slab on top)
export const OUT_VIEW = Object.freeze({ x: 17.5, y: -7, z: 7.5 });  // on the ground outside the door
export const SPAWN_COLUMNS = box(-3, 0, -3, 18, 0, 18);           // the ground within reach of the spawn volume, in x and z

/**
 * The signs: where, which way each faces (2 north, 3 south, 4 west, 5 east; it hangs on the block behind it), and what for. 'hole' ones cap the hole
 * in the platform's floor (water cannot go through a sign, a golem can); 'lava' ones hold the lava (below it, south of it, west of it; north is the
 * wall, east the glass, above it the open hallway: a source does not run up). (u212 had two more on the hallway floor to keep the water off the
 * campfire; the player took them out in his redesign: the campfires themselves keep it off each other.)
 */
export const SIGNS = Object.freeze([
  { x: 7, y: 3, z: 7, facing: 5, group: 'hole', note: 'sign over the shaft (north-west cell of the hole), hung on the floor to its west' },
  { x: 7, y: 3, z: 8, facing: 5, group: 'hole', note: 'sign over the shaft (south-west cell of the hole)' },
  { x: 8, y: 3, z: 7, facing: 4, group: 'hole', note: 'sign over the shaft (north-east cell of the hole), hung on the floor to its east' },
  { x: 8, y: 3, z: 8, facing: 4, group: 'hole', note: 'sign over the shaft (south-east cell of the hole)' },
  { x: LAVA.x, y: LAVA.y - 1, z: LAVA.z, facing: 3, group: 'lava', note: 'sign under the lava, hung on the north wall' },
  { x: LAVA.x, y: LAVA.y, z: LAVA.z + 1, facing: 2, group: 'lava', note: 'sign south of the lava, hung on the south wall' },
  { x: LAVA.x - 1, y: LAVA.y, z: LAVA.z, facing: 3, group: 'lava', note: 'sign west of the lava, hung on the north wall' },
]);
export const SLAB = 'cobblestone_slab';
/**
 * What the shell (walls, floors, roofs, foundation) is made of. u215: dirt, not cobblestone (the player's call: cheaper in survival, appearance be damned;
 * the slabs stay cobblestone). Mechanically the same here: a full opaque block a golem can spawn on, a wall sign hangs on it, lava does not burn it, water
 * does not wash it away. What it gives up: blast resistance, and an Enderman can pick a dirt block up (rare, and only at night/in the dark).
 * `ironFarmPlan({ shell: 'cobblestone' })` is the old look.
 */
export const SHELL = 'dirt';
/** Every full block the checks accept as a wall of the farm. */
export const SHELLS = Object.freeze(['cobblestone', 'dirt']);
export const DOOR_ID = 'wooden_door';

/** Everything the plan may be made of: all of it is there before the Nether. */
export const ALLOWED = Object.freeze(['air', 'cobblestone', 'dirt', SLAB, 'glass', 'composter', 'bed', 'hopper', 'chest', 'wall_sign', 'torch', 'lava', 'water', 'campfire', GATE_ID, DOOR_ID, STAIR_ID]);

/** Where a wall sign hangs: the offset from the sign to the block it is attached to, by the way it faces. */
export const signSupport = (facing) => ({ 2: [0, 1], 3: [0, -1], 4: [1, 0], 5: [-1, 0] })[facing] ?? null;

/**
 * The water sources: the middle twelve cells of each of the platform's four edge rows (x or z 2..13). Not the whole ring. Bedrock turns a flowing
 * cell that touches two sources into a source itself (and so on, cell after cell): a ring of sources right round the edge did that from the corners
 * in, and the whole platform went to still water (u209). With the corners solid and the rows stopping two cells short, no cell touches two sources
 * unless it is one: the rows' neighbours (x, 1) touch only (x, 0). Each cell's level is then its distance from the nearest edge, so the water runs
 * downhill to the middle and is level 7 over the hole.
 */
export function waterSources() {
  const out = [];
  for (let i = 2; i <= 13; i++) out.push({ x: i, z: 0 }, { x: i, z: 15 }, { x: 0, z: i }, { x: 15, z: i });
  return out;
}

/** The village centre the game works out: the average of the beds and the workstations (both halves of a bed, or just its head). */
export function villageCentre(beds, stations, headsOnly = false) {
  const pts = [...beds.flatMap((b) => (headsOnly ? [b.head] : [b.head, b.foot])), ...stations];
  const n = pts.length || 1;
  return { x: pts.reduce((a, p) => a + p.x, 0) / n, y: pts.reduce((a, p) => a + p.y, 0) / n, z: pts.reduce((a, p) => a + p.z, 0) / n };
}

export const hull = (boxes) => box(
  Math.min(...boxes.map((b) => b.x1)), Math.min(...boxes.map((b) => b.y1)), Math.min(...boxes.map((b) => b.z1)),
  Math.max(...boxes.map((b) => b.x2)), Math.max(...boxes.map((b) => b.y2)), Math.max(...boxes.map((b) => b.z2)),
);
export const opBox = (o) => (o.op === 'set' ? box(o.x, o.y, o.z, o.x, o.y, o.z) : o.box);
export const inBox = (b, x, y, z) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2 && z >= b.z1 && z <= b.z2;
