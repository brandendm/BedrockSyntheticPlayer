// The starter house: a 5x5 cabin with a 3x3 room inside. Pure data, unit-tested.
//
//   cobblestone corners and bottom row, plank walls, a flat plank roof, a door in the middle of
//   the front, two small windows high up in the side walls (too high for a baby zombie to hop in;
//   glass goes in later), a torch inside and one each side of the door. Inside: a bed along the
//   right wall, a crafting table and a furnace in the left corners, a clear path from the door.
//
// About 23 cobblestone and 46 planks (12 logs), one door, three torches. Built from inside, so
// every block is within reach of the middle of the room and the bot is never outside at night
// while it works. A chest goes in the front corner by the door (a second one against the back
// wall under the torch if the first fills up). Upgrades later: glass in the windows, a slab trim.
//
// Local coordinates: lx across (-2..2), lz front-to-back (+2 is the front wall with the door),
// h height above the floor (0..3, 3 = roof). World = origin + lx * right + lz * forward.

export const DIRS = {
  north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 },
};

/** Local -> world transform for a house whose door faces `dir`. */
export function frame(origin, dir) {
  const f = DIRS[dir];
  const r = { x: -f.z, z: f.x }; // right-hand side looking out of the door
  return (lx, lz, h = 0) => ({ x: origin.x + lx * r.x + lz * f.x, y: origin.y + h, z: origin.z + lx * r.z + lz * f.z });
}

const isCorner = (lx, lz) => Math.abs(lx) === 2 && Math.abs(lz) === 2;
const isWall = (lx, lz) => Math.abs(lx) === 2 || Math.abs(lz) === 2;
export const DOOR = [[0, 2, 0], [0, 2, 1]];
export const WINDOWS = [[-2, 0, 2], [2, 0, 2]];
const skip = (lx, lz, h) => DOOR.some(([a, b, c]) => a === lx && b === lz && c === h) || WINDOWS.some(([a, b, c]) => a === lx && b === lz && c === h);

/**
 * Every block to place, in build order: walls bottom row up, then the roof from the edges inward
 * (each roof block leans on one already placed). material: 'stone' | 'planks'.
 */
export function blueprint(origin, dir) {
  const at = frame(origin, dir);
  const out = [];
  for (let h = 0; h <= 2; h++) {
    for (let lx = -2; lx <= 2; lx++) for (let lz = -2; lz <= 2; lz++) {
      if (!isWall(lx, lz) || skip(lx, lz, h)) continue;
      out.push({ ...at(lx, lz, h), lx, lz, h, material: isCorner(lx, lz) || h === 0 ? 'stone' : 'planks' });
    }
  }
  const roof = [];
  for (let lx = -2; lx <= 2; lx++) for (let lz = -2; lz <= 2; lz++) roof.push({ lx, lz, ring: Math.max(Math.abs(lx), Math.abs(lz)) });
  roof.sort((a, b) => b.ring - a.ring || a.lz - b.lz || a.lx - b.lx);
  for (const c of roof) out.push({ ...at(c.lx, c.lz, 3), lx: c.lx, lz: c.lz, h: 3, material: 'planks' });
  return out;
}

/** Cells that must be clear (air or plants) before building: the whole 5x5 up to the roof, plus the doorstep. */
export function clearance(origin, dir) {
  const at = frame(origin, dir);
  const out = [];
  for (let lx = -2; lx <= 2; lx++) for (let lz = -2; lz <= 3; lz++) {
    if (lz === 3 && lx !== 0) continue;
    for (let h = 0; h <= 3; h++) out.push(at(lx, lz, h));
  }
  return out;
}

/** Ground cells (one below the floor) that must be solid: the 5x5 and the doorstep. */
export function footing(origin, dir) {
  const at = frame(origin, dir);
  const out = [];
  for (let lx = -2; lx <= 2; lx++) for (let lz = -2; lz <= 3; lz++) {
    if (lz === 3 && lx !== 0) continue;
    out.push(at(lx, lz, -1));
  }
  return out;
}

/** Where things go inside, and where to stand to place them. */
export function furnishings(origin, dir) {
  const at = frame(origin, dir);
  return {
    stand: at(0, 0),                   // middle of the room: every wall and roof block is in reach
    doorstep: at(0, 3),
    door: at(0, 2),
    table: at(-1, -1),
    furnace: at(-1, 0),
    bed: { foot: at(1, -1), head: at(1, 0), standAt: at(1, 1) }, // foot at the back, head toward the front; homestead checks both cells after placing
    torchInside: { on: at(0, -2, 1), toward: at(0, -1, 1) },     // wall torch on the back wall
    // Chests: the front corner left of the door, then the middle of the back wall (under the torch).
    // Neither is in the way (door -> middle of the room -> bed side), and both are in reach from
    // the middle of the room. Not side by side, so each stays a single chest of its own.
    chests: [at(-1, 1), at(0, -1)],
    torchesOutside: [-1, 1].map((lx) => ({ on: at(lx, 2, 1), toward: at(lx, 3, 1) })),
  };
}

/** Materials for the shell. */
export function materials() {
  const bp = blueprint({ x: 0, y: 0, z: 0 }, 'north');
  return {
    stone: bp.filter((b) => b.material === 'stone').length,
    planks: bp.filter((b) => b.material === 'planks').length,
    doors: 1,
    torches: 3,
  };
}

/** Is p inside the house's footprint (walls included)? */
export function inside(house, p) {
  const f = DIRS[house.dir];
  const r = { x: -f.z, z: f.x };
  const dx = Math.floor(p.x) - house.x, dz = Math.floor(p.z) - house.z;
  const lx = dx * r.x + dz * r.z, lz = dx * f.x + dz * f.z;
  return Math.abs(lx) <= 2 && Math.abs(lz) <= 2 && Math.floor(p.y) >= house.y - 1 && Math.floor(p.y) <= house.y + 3;
}

// What the site gets cleared of before the walls go up (homestead.buildHouse): plants and air,
// natural ground, trees.
const CLEARED = /^(air|short_grass|tall_grass|fern|large_fern|dead_bush|deadbush|snow_layer|vine|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|allium|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|bush|leaf_litter|wildflowers|pink_petals|short_dry_grass|tall_dry_grass|dirt|grass_block|coarse_dirt|podzol|sand|red_sand|gravel|snow|stone|andesite|diorite|granite|tuff|clay|mud|.*_leaves|.*_log|.*_stem|.*_wood)$/;

/**
 * Does a wall or roof block still have to go in here (id: what's there now)? Anything the clearing
 * takes out first does: a trunk or low leaves where the roof goes, a lump of dirt in a wall's
 * place. (Counting those as built came up short in a forest: 1 in 4 houses there ran out halfway.)
 * Our own cobblestone and planks don't.
 */
export function houseMissing(id) {
  return CLEARED.test(String(id ?? 'air').replace(/^minecraft:/, ''));
}
