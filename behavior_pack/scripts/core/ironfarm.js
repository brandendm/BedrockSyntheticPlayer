// An iron golem farm for Bedrock, as a layout (pure, unit-tested; game/ironfarm.js turns it into commands). A draft from the Bedrock guides, not
// something that has run: the rules (10+ villagers, 20+ beds, 75% of the villagers working, a golem spawns at 1/700 a tick on a free spot inside
// 17 x 13 x 17 blocks of the village centre, a free spot being a full block with a 2 x 4 x 2 box of nothing solid over it), the geometry
// (core/ironfarm_geo.js) and the checks (core/ironfarm_check.js, core/ironfarm_grid.js).
//
// u207: a hollow shell of overworld materials instead of a solid block, the lava held by wall signs. u208: the platform open to the sky.
// u209: after the first look in the game: a 16 x 16 platform (4 x 4 was a few percent of what the spawn rule can use), a way in and out (a
// door), a double chest, campfires under the lava, and the farm on the ground rather than in the sky (see geo.js for the layers).
// u211: after the player looked at u209: (1) the water was a still pool: a ring of sources all round the edge makes every cell that touches two of
// them a source (Bedrock's infinite-water rule), cell after cell, so now the sources are the middle twelve of each edge, the corners 2 x 2 solid, and
// the check settles that rule (grid.js settleWater) instead of assuming the water stays flowing; (2) no lava: a mob that falls into or dies
// beside lava can lose its drops, so the chamber has a lit campfire on each of its four cells, over four hoppers.
// u212: after the player watched u211 (his advice): (1) the water ran over the signs on the hole and the currents met there, so golems crept in:
// four open fence gates over the hole (water cannot go into them, so every current ends in the hole); (2) campfires alone kill slowly: a short
// hallway at the bottom with one water source that presses the golem into a corner, where ONE lit campfire stands over a hopper (kept dry by two
// signs) with lava over it at the golem's head height, held by signs; the golem is in the lava, not above it, so what it drops (at its feet) is not.
//
// u214: the player rebuilt the hallway himself and I took his layout (his words: a second campfire next to the first, over the second hopper; the sign
// at the bottom taken out; four hoppers gone, three kept; the second campfire "helped redirect the water current towards the campfire with the
// lava above it"). Read as: the second campfire south of the first (9,-6,8) in place of the south floor sign, the west floor sign (8,-6,7) removed so
// the hallway water runs on into that cell, hoppers under the two campfires and the one under the window into the chest. The model agrees with him:
// every golem ends against the north-east corner standing on both campfires, and nothing it drops is lost with those three hoppers (with the second
// campfire's taken away, what lands on it stays there). Lit campfires standing beside flowing water is his observation, so the check no longer
// assumes water puts a campfire out.
//
// Confirmed by the player: wall signs hold lava and do not burn; golems do spawn on flowing water; the u211 water flows and the farm works; open
// fence gates keep water out (his word, u212).
// Where it is most likely to be wrong (in the order I would look): where the golem really comes to rest in the hallway (it is modelled as a 1.4-wide
// box pushed by the water the way Java does it, and Bedrock may differ), whether the campfire hurts by the block the golem's centre is in or by any
// overlap, whether the gates and signs hold the hallway water off the campfire, the fence gate's block name, the lava's damage (the real killer
// here); the door's direction; whether two chests set by a command pair into a double chest; the village centre may not be where this works it out
// to be (the platform is symmetrical about the average); the village may want a day or two before it counts the villagers as working.
import {
  box, PLATFORM, CORNER_BOXES, POD, POD_SHELL, SHAFT_SHELL, ROOM, ROOM_SHELL, WINDOW, DOOR, STEP, HALL, LAVA, CAMPFIRES, CHAMBER_WATER, GATES,
  GATE_ID, HOPPERS, CHESTS, CHEST_FACING, STAIR, STAIR_ID, STAIR_STATES, SIGNS, SLAB, SHELL, DOOR_ID, FLOOR_Y, WATER_Y, waterSources, villageCentre, hull, opBox,
} from './ironfarm_geo.js';
import { render, exposedTops, runs } from './ironfarm_grid.js';

export * from './ironfarm_geo.js';
export * from './ironfarm_grid.js';
export { checkPlan } from './ironfarm_check.js';

export const BED_X = Object.freeze([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
export const NORTH_STATIONS = Object.freeze([3, 5, 7, 9, 11]);   // composters in the north wall (z 1), villagers beside them at z 2
export const SOUTH_STATIONS = Object.freeze([4, 6, 8, 10, 12]);  // composters in the south wall (z 14), villagers beside them at z 13
export const POD_TORCHES = Object.freeze([[3, 3], [8, 3], [12, 3], [3, 12], [8, 12], [12, 12], [2, 7], [13, 8]]);
export const ROOM_TORCH = Object.freeze({ x: 13, y: -6, z: 9 });

/**
 * The plan: { ops (in order; tag 'sign' | 'gate' | 'lava' | 'campfire' | 'chest' | 'door' | 'water' | 'cwater' | 'slab' marks the ones the builder treats with care),
 * beds, stations, villagers, bounds, centre, centres, shell (what the walls are made of) }. `shell` is SHELL (dirt) unless asked otherwise.
 * @param {{ shell?: string }} [opts]
 */
export function ironFarmPlan({ shell = SHELL } = {}) {
  const ops = [];
  const fill = (b, id, note = '', tag = '') => ops.push({ op: 'fill', box: b, id, note, tag });
  const set = (x, y, z, id, states = undefined, note = '', tag = '') => ops.push({ op: 'set', x, y, z, id, states, note, tag });

  // The village: beds (heads at z 5 and z 11, feet one block north of each; setblock makes the given cell the head, direction 0 = head south),
  // a composter in the wall by the aisle for each of ten villagers.
  const beds = [];
  for (const x of BED_X) for (const hz of [5, 11]) beds.push({ head: { x, y: 1, z: hz }, foot: { x, y: 1, z: hz - 1 } });
  const stations = [...NORTH_STATIONS.map((x) => ({ x, y: 1, z: 1 })), ...SOUTH_STATIONS.map((x) => ({ x, y: 1, z: 14 }))];
  const villagers = [...NORTH_STATIONS.map((x) => ({ x: x + 0.5, y: 1, z: 2.5 })), ...SOUTH_STATIONS.map((x) => ({ x: x + 0.5, y: 1, z: 13.5 }))];

  const c1 = villageCentre(beds, stations), c2 = villageCentre(beds, stations, true);
  const centre = { x: Math.floor((c1.x + c2.x) / 2), y: Math.floor((c1.y + c2.y) / 2), z: Math.floor((c1.z + c2.z) / 2) };

  // The platform: floor (which is also the pod's roof), walls three high all round, the four 2 x 2 inside corners solid, then the hole in the floor.
  fill(box(-1, FLOOR_Y, -1, 16, FLOOR_Y, 16), shell, 'platform floor / pod roof');
  fill(box(-1, FLOOR_Y + 1, -1, 16, FLOOR_Y + 3, -1), shell, 'platform wall, north');
  fill(box(-1, FLOOR_Y + 1, 16, 16, FLOOR_Y + 3, 16), shell, 'platform wall, south');
  fill(box(-1, FLOOR_Y + 1, 0, -1, FLOOR_Y + 3, 15), shell, 'platform wall, west');
  fill(box(16, FLOOR_Y + 1, 0, 16, FLOOR_Y + 3, 15), shell, 'platform wall, east');
  for (const c of CORNER_BOXES) fill(c, shell, 'solid 2 x 2 corner (the water makes a dead pocket in a corner, and a golem pushed into one would stay there)');
  // The pod, the shaft through it and down to the chamber, the room beside the chamber.
  fill(POD_SHELL, shell, 'pod shell');
  fill(POD, 'air', 'pod');
  fill(SHAFT_SHELL, shell, 'shaft, chamber and the base under them');
  fill(box(7, -6, 7, 8, FLOOR_Y, 8), 'air', 'shaft, hallway and the hole in the platform floor');
  fill(HALL, 'air', 'the east half of the hallway (4 high: a golem standing on the campfire is 3.3), cut out of the shaft wall');
  fill(ROOM_SHELL, shell, 'room shell');
  fill(ROOM, 'air', 'room');
  fill(WINDOW, 'glass', 'window between the room and the hallway');
  set(DOOR.x, DOOR.y, DOOR.z, DOOR_ID, { direction: 0, door_hinge_bit: false, open_bit: false, upper_block_bit: false }, 'door, lower half', 'door');
  set(DOOR.x, DOOR.y + 1, DOOR.z, DOOR_ID, { direction: 0, door_hinge_bit: false, open_bit: false, upper_block_bit: true }, 'door, upper half', 'door');

  // Pod: workstations in the walls beside the aisles, beds, torches (nothing hostile spawns in the dark among the villagers).
  for (const s of stations) set(s.x, s.y, s.z, 'composter', undefined, 'workstation');
  for (const b of beds) set(b.head.x, b.head.y, b.head.z, 'bed', { direction: 0, head_piece_bit: true }, 'bed (foot placed with it)');
  for (const [x, z] of POD_TORCHES) set(x, 1, z, 'torch', undefined, 'pod light');
  set(ROOM_TORCH.x, ROOM_TORCH.y, ROOM_TORCH.z, 'torch', undefined, 'room light');

  // The collection: a hopper under each campfire, the first feeding the double chest straight east (u217: no third hopper), an upside-down stair over it.
  for (const h of HOPPERS) set(h.x, h.y, h.z, 'hopper', { facing_direction: h.facing }, 'hopper');
  for (const c of CHESTS) set(c.x, c.y, c.z, 'chest', { 'minecraft:cardinal_direction': CHEST_FACING }, 'chest (two side by side make the double chest)', 'chest');
  set(STAIR.x, STAIR.y, STAIR.z, STAIR_ID, { ...STAIR_STATES }, 'upside-down stair over the first chest, in the window (the chest opens under it; the hallway stays closed off)', 'stair');

  // The signs (the lava's three) and the gates over the hole go in before the slabs (the gates close the shaft off from the sky, which matters to
  // what counts as outside below: u218, no signs in the hole), then the lava, the campfires and the water.
  for (const s of SIGNS) set(s.x, s.y, s.z, 'wall_sign', { facing_direction: s.facing }, s.note, 'sign');
  for (const q of GATES) set(q.x, q.y, q.z, GATE_ID, { direction: 0, open_bit: true, in_wall_bit: false }, 'open fence gate over the hole (water cannot go into it, a golem walks through)', 'gate');

  // Every upward face left bare outside gets a slab: a golem can spawn on any full block with room over it, and the sky is full of it. (The
  // platform's own floor is meant to be bare.)
  const except = (x, y, z) => y === FLOOR_Y && x >= PLATFORM.x1 && x <= PLATFORM.x2 && z >= PLATFORM.z1 && z <= PLATFORM.z2;
  const bare = exposedTops(render({ ops }), hull(ops.map(opBox)), except);
  for (const run of runs(bare)) fill(box(run.x1, run.y, run.z, run.x2, run.y, run.z), SLAB, 'slab on a bare top (no spawns on it)', 'slab');
  set(STEP.x, STEP.y, STEP.z, SLAB, undefined, 'step up to the door (a slab: walk up it)', 'slab');

  // The kill hallway: the lava the signs hold (at the golem's head height, over the first campfire), the two campfires, the hallway's one water source,
  // then the water on the platform (sources only: the rest flows from them).
  set(LAVA.x, LAVA.y, LAVA.z, 'lava', undefined, "the lava source, at the head height of a golem standing in the corner", 'lava');
  for (const c of CAMPFIRES) set(c.x, c.y, c.z, 'campfire', undefined, 'campfire (lit) in the hallway\'s east column, over a hopper', 'campfire');
  set(CHAMBER_WATER.x, CHAMBER_WATER.y, CHAMBER_WATER.z, 'water', undefined, "the hallway's one water source (it flows north and east, along the north wall, which presses the golem into the north-east corner)", 'cwater');
  fill(box(2, WATER_Y, 0, 13, WATER_Y, 0), 'water', 'water sources, north edge', 'water');
  fill(box(2, WATER_Y, 15, 13, WATER_Y, 15), 'water', 'water sources, south edge', 'water');
  fill(box(0, WATER_Y, 2, 0, WATER_Y, 13), 'water', 'water sources, west edge', 'water');
  fill(box(15, WATER_Y, 2, 15, WATER_Y, 13), 'water', 'water sources, east edge', 'water');

  const bounds = hull(ops.map(opBox));
  return { ops, beds, stations, villagers, bounds, centre, centres: [c1, c2], shell };
}

/** What it takes to build it, counted from the plan: blocks by kind, and the survival shopping list as text. */
export function materials(plan) {
  const g = render(plan);
  const n = {};
  for (const v of g.cells.values()) n[v.id] = (n[v.id] ?? 0) + 1;
  n.bed = (n.bed ?? 0) / 2;
  n[DOOR_ID] = (n[DOOR_ID] ?? 0) / 2;
  const shell = plan.shell ?? 'cobblestone';
  const slabs = n[SLAB] ?? 0, walls = n[shell] ?? 0;
  const cobbleForSlabs = Math.ceil(slabs / 6) * 3;
  const sources = waterSources().length;
  const lines = [
    shell === 'cobblestone'
      ? `cobblestone ${walls} + ${slabs} cobblestone slabs (${cobbleForSlabs} more cobblestone: 3 make 6 slabs) = ${walls + cobbleForSlabs}`
      : `${shell} ${walls} (dig it, no pickaxe needed) + ${slabs} cobblestone slabs (${cobbleForSlabs} cobblestone: 3 make 6 slabs)`,
    `${n.glass ?? 0} glass`,
    `${n.composter ?? 0} composters (7 wood slabs each)`,
    `${n.bed ?? 0} beds (3 wool + 3 planks each)`,
    `${n.hopper ?? 0} hoppers (5 iron each = ${(n.hopper ?? 0) * 5} iron) and ${n.chest ?? 0} chests (a double chest)`,
    `${n[STAIR_ID] ?? 0} cobblestone stair, upside down over the chest (6 cobblestone make 4)`,
    `${n.wall_sign ?? 0} signs`,
    `${n.fence_gate ?? 0} fence gates (any wood; 4 sticks and 2 planks each), set open`,
    `${n.campfire ?? 0} campfires (3 sticks, 1 coal, 3 logs each)`,
    `${n[DOOR_ID] ?? 0} door`,
    `${n.torch ?? 0} torches`,
    `a lava bucket (one source) and a water bucket (${sources} water sources on the platform, the middle twelve cells of each edge, none at the corners and none in the second row: a cell that touches two sources becomes one; one more in the hallway)`,
    `${plan.villagers.length} adult villagers`,
  ];
  return { counts: n, shell, walls, cobble: (shell === 'cobblestone' ? walls : 0) + cobbleForSlabs, text: lines.join('; ') };
}
