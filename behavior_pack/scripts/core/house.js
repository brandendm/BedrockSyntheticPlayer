// The starter house. Pure data, unit-tested. Two layouts:
//
//   'chests' (every house built from now on): 5 wide, 9 deep. The front room is the old cabin's
//     3x3 (a bed along the right wall, a crafting table and a furnace in the left corners, a clear
//     path from the door); a partition with an open doorway in the middle leads to a 3x3 chest
//     room at the back: a chest in each corner (never side by side, so each stays a single chest
//     of its own), a sign on the wall over each saying what goes in it, a torch on the back wall.
//     About 32 cobblestone and 91 planks (23 logs).
//   'cabin' (houses built before): a 5x5 with a 3x3 room, a chest in the front corner by the door
//     (a second against the back wall when the first fills). A house saved without a layout is one
//     of these, so the bot never tears out or "finishes" a house it already built.
//
// Both: cobblestone corners and bottom row, plank walls, a flat plank roof, a door in the middle of
// the front, two small windows high up in the front room's side walls (too high for a baby zombie
// to hop in), a torch inside and one each side of the door. Built from inside: every block is in
// reach from the middle of a room (the chest room has its own spot), so the bot is never outside
// at night while it works.
//
// Local coordinates: lx across (-2..2), lz front-to-back (+2 is the front wall with the door, the
// back wall is -2 in a cabin and -6 with the chest room), h height above the floor (0..3, 3 = the
// roof). World = origin + lx * right + lz * forward.

export const DIRS = {
  north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 },
};

/** The layout new houses get. */
export const NEW_LAYOUT = 'chests';
/** A house's (or site's) layout: 'chests', or 'cabin' for one saved before there was a choice. */
export const layoutOf = (o) => (o?.layout === 'chests' ? 'chests' : 'cabin');
const backOf = (layout) => (layout === 'chests' ? -6 : -2);

/** Local -> world transform for a house whose door faces `dir`. */
export function frame(origin, dir) {
  const f = DIRS[dir];
  const r = { x: -f.z, z: f.x }; // right-hand side looking out of the door
  return (lx, lz, h = 0) => ({ x: origin.x + lx * r.x + lz * f.x, y: origin.y + h, z: origin.z + lx * r.z + lz * f.z });
}

export const DOOR = [[0, 2, 0], [0, 2, 1]];
export const WINDOWS = [[-2, 0, 2], [2, 0, 2]];
// The chest room's doorway: open, two high, in the middle of the partition.
const DOORWAY = [[0, -2, 0], [0, -2, 1]];

/** The layout's walls (outside and the partition) and what's left open in them. */
function shape(layout) {
  const back = backOf(layout);
  const isWall = (lx, lz) => Math.abs(lx) === 2 || lz === 2 || lz === back || (layout === 'chests' && lz === -2);
  const isCorner = (lx, lz) => Math.abs(lx) === 2 && (lz === 2 || lz === back);
  const open = [...DOOR, ...WINDOWS, ...(layout === 'chests' ? DOORWAY : [])];
  const skip = (lx, lz, h) => open.some(([a, b, c]) => a === lx && b === lz && c === h);
  return { back, isWall, isCorner, skip };
}

/**
 * Every block to place, in build order: walls bottom row up, then the roof from the edges inward
 * (each roof block leans on one already placed). material: 'stone' | 'planks'.
 */
export function blueprint(origin, dir) {
  const layout = layoutOf(origin);
  const { back, isWall, isCorner, skip } = shape(layout);
  const at = frame(origin, dir);
  const out = [];
  for (let h = 0; h <= 2; h++) {
    for (let lx = -2; lx <= 2; lx++) for (let lz = back; lz <= 2; lz++) {
      if (!isWall(lx, lz) || skip(lx, lz, h)) continue;
      out.push({ ...at(lx, lz, h), lx, lz, h, material: isCorner(lx, lz) || h === 0 ? 'stone' : 'planks' });
    }
  }
  const roof = [];
  // Distance in from the nearest outside wall (the partition holds the roof up too, but the edges
  // go first either way).
  for (let lx = -2; lx <= 2; lx++) for (let lz = back; lz <= 2; lz++) roof.push({ lx, lz, ring: Math.min(2 - Math.abs(lx), 2 - lz, lz - back) });
  roof.sort((a, b) => a.ring - b.ring || b.lz - a.lz || a.lx - b.lx);
  for (const c of roof) out.push({ ...at(c.lx, c.lz, 3), lx: c.lx, lz: c.lz, h: 3, material: 'planks' });
  return out;
}

/** Cells that must be clear (air or plants) before building: the whole footprint up to the roof, plus the doorstep. */
export function clearance(origin, dir) {
  const at = frame(origin, dir), back = backOf(layoutOf(origin));
  const out = [];
  for (let lx = -2; lx <= 2; lx++) for (let lz = back; lz <= 3; lz++) {
    if (lz === 3 && lx !== 0) continue;
    for (let h = 0; h <= 3; h++) out.push(at(lx, lz, h));
  }
  return out;
}

/** Ground cells (one below the floor) that must be solid: the footprint and the doorstep. */
export function footing(origin, dir) {
  const at = frame(origin, dir), back = backOf(layoutOf(origin));
  const out = [];
  for (let lx = -2; lx <= 2; lx++) for (let lz = back; lz <= 3; lz++) {
    if (lz === 3 && lx !== 0) continue;
    out.push(at(lx, lz, -1));
  }
  return out;
}

/** What goes in each chest of the chest room (core/storage.js sorts by the same keys), and its sign. */
export const CHEST_KINDS = [
  { kind: 'stone', sign: 'Stone\n& ores' },
  { kind: 'wood', sign: 'Wood\n& plants' },
  { kind: 'food', sign: 'Food\n& farm' },
  { kind: 'misc', sign: 'Mob drops\n& other' },
];

/** Where things go inside, and where to stand to place them. */
export function furnishings(origin, dir) {
  const at = frame(origin, dir);
  const layout = layoutOf(origin);
  const common = {
    stand: at(0, 0),                   // middle of the front room: its walls and roof are in reach
    doorstep: at(0, 3),
    door: at(0, 2),
    table: at(-1, -1),
    furnace: at(-1, 0),
    bed: { foot: at(1, -1), head: at(1, 0), standAt: at(1, 1) }, // foot at the back, head toward the front; homestead checks both cells after placing
    torchesOutside: [-1, 1].map((lx) => ({ on: at(lx, 2, 1), toward: at(lx, 3, 1) })),
  };
  if (layout === 'chests') {
    // Chests in the chest room's corners, each with a sign on the side wall over it (facing the
    // path down the middle); the torches on the partition (over the bed's foot) and the back wall.
    const corners = [[-1, -5], [1, -5], [-1, -3], [1, -3]];
    return {
      ...common,
      layout,
      // A second furnace, for food (the first does ore and charcoal): the front room's free corner by the door.
      furnace2: at(-1, 1),
      stands: [at(0, 0), at(0, -4)],
      chestStand: at(0, -4),
      torchInside: { on: at(1, -2, 1), toward: at(1, -1, 1) },
      torchChests: { on: at(0, -6, 1), toward: at(0, -5, 1) },
      chests: corners.map(([lx, lz]) => at(lx, lz)),
      signs: corners.map(([lx, lz], i) => ({ cell: at(lx, lz, 1), on: at(Math.sign(lx) * 2, lz, 1), text: CHEST_KINDS[i].sign, kind: CHEST_KINDS[i].kind })),
    };
  }
  return {
    ...common,
    layout,
    furnace2: null, // (no room for a second in a cabin)
    stands: [at(0, 0)],
    chestStand: at(0, 0),
    torchInside: { on: at(0, -2, 1), toward: at(0, -1, 1) },     // wall torch on the back wall
    torchChests: null,
    // Chests: the front corner left of the door, then the middle of the back wall (under the torch).
    // Neither is in the way (door -> middle of the room -> bed side), and both are in reach from
    // the middle of the room. Not side by side, so each stays a single chest of its own.
    chests: [at(-1, 1), at(0, -1)],
    signs: [],
  };
}

/**
 * Every cell of the house that has to stay usable: the rooms floor to ceiling, the doorways, the
 * doorstep and the space over it. A cell with `want` is where something of ours goes (the table,
 * the furnace, the bed, a chest, a sign, a torch, the door): that thing or nothing. Every other one
 * is for walking and working in: nothing solid. Anything else found in one (a player's blocks, a
 * creeper's crater filled with junk, a block of ours left behind) is in the way and comes out.
 */
export function keepClear(origin, dir) {
  const at = frame(origin, dir), layout = layoutOf(origin), back = backOf(layout);
  const fur = furnishings(origin, dir);
  const k = (p) => `${p.x},${p.y},${p.z}`;
  const want = new Map();
  want.set(k(fur.table), 'crafting_table');
  want.set(k(fur.furnace), 'furnace');
  if (fur.furnace2) want.set(k(fur.furnace2), 'furnace');
  want.set(k(fur.bed.foot), 'bed');
  want.set(k(fur.bed.head), 'bed');
  for (const c of fur.chests) want.set(k(c), 'chest');
  for (const s of fur.signs) want.set(k(s.cell), 'sign');
  for (const t of [fur.torchInside, fur.torchChests, ...fur.torchesOutside].filter(Boolean)) want.set(k(t.toward), 'torch');
  want.set(k(fur.door), 'door');
  want.set(k({ ...fur.door, y: fur.door.y + 1 }), 'door');
  const { isWall, skip } = shape(layout);
  const out = [];
  const add = (p) => { const w = want.get(k(p)); out.push(w ? { ...p, want: w } : { ...p }); };
  for (let lx = -2; lx <= 2; lx++) for (let lz = back; lz <= 3; lz++) for (let h = 0; h <= 2; h++) {
    if (lz === 3) { if (lx === 0 && h <= 1) add(at(lx, lz, h)); continue; } // the doorstep
    // Inside the walls, and the openings in them we walk through (the door, the chest room's doorway).
    if (isWall(lx, lz) && !(skip(lx, lz, h) && lx === 0)) continue;
    add(at(lx, lz, h));
  }
  // The torches outside hang off the front wall over the ground either side of the door.
  for (const t of fur.torchesOutside) if (!out.some((c) => k(c) === k(t.toward))) out.push({ ...t.toward, want: 'torch' });
  return out;
}

/** Can something stand in a keep-clear cell without being in the way (air, plants, a torch, a carpet)? */
export const HARMLESS = /^(air|short_grass|tall_grass|fern|large_fern|dead_bush|deadbush|snow_layer|vine|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|allium|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|bush|leaf_litter|wildflowers|pink_petals|short_dry_grass|tall_dry_grass|torch|wall_torch|soul_torch|.*_carpet|carpet|.*_pressure_plate|.*_button|lever|rail|redstone_wire|light_block.*|structure_void)$/;

/** Is block `id` in keep-clear cell `c` in the way? (Fire is its own job: see the house's fire watch.) */
export function inTheWay(c, id) {
  const b = String(id ?? 'air').replace(/^minecraft:/, '');
  if (/^(fire|soul_fire)$/.test(b)) return false;
  if (c.want) {
    if (b.includes(c.want === 'crafting_table' ? 'crafting_table' : c.want)) return false;
    if (c.want === 'torch' && /torch/.test(b)) return false;
  }
  return !HARMLESS.test(b);
}

/** The spot to build or reach `cell` from: whichever room's middle is nearer. */
export function standFor(fur, cell) {
  let best = fur.stand, bd = Infinity;
  for (const s of fur.stands ?? [fur.stand]) { const d = Math.hypot(cell.x - s.x, cell.z - s.z); if (d < bd) { bd = d; best = s; } }
  return best;
}

/** Materials for the shell (a new house's unless `layout` says otherwise). */
export function materials(layout = NEW_LAYOUT) {
  const bp = blueprint({ x: 0, y: 0, z: 0, layout }, 'north');
  return {
    stone: bp.filter((b) => b.material === 'stone').length,
    planks: bp.filter((b) => b.material === 'planks').length,
    doors: 1,
    torches: layout === 'chests' ? 4 : 3,
    chests: layout === 'chests' ? 4 : 1,
    signs: layout === 'chests' ? 4 : 0,
  };
}

/** Is p inside the house's footprint (walls included)? */
export function inside(house, p) {
  const f = DIRS[house.dir];
  const r = { x: -f.z, z: f.x };
  const dx = Math.floor(p.x) - house.x, dz = Math.floor(p.z) - house.z;
  const lx = dx * r.x + dz * r.z, lz = dx * f.x + dz * f.z;
  return Math.abs(lx) <= 2 && lz <= 2 && lz >= backOf(layoutOf(house)) && Math.floor(p.y) >= house.y - 1 && Math.floor(p.y) <= house.y + 3;
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
