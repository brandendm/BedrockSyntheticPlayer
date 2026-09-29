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

/**
 * A house adapted round blocks it can't shift (someone's obsidian, bedrock): fields kept on the
 * house object (planAroundFixed). doorLx: where along the front wall the door is (0, else -1 or 1);
 * doorwayLx: the chest room's doorway along the partition; moved: { name: [lx, lz] } a thing's
 * new spot (or null: no room for it); accepted: [[lx, lz, h]] cells left as they are.
 */
const adapt = (origin) => ({ d: origin?.doorLx ?? 0, dw: origin?.doorwayLx ?? 0, moved: origin?.moved ?? {}, accepted: origin?.accepted ?? [] });

/** The house's local coordinates of world point p (the inverse of frame). */
export function toLocal(origin, dir, p) {
  const f = DIRS[dir], r = { x: -f.z, z: f.x };
  const dx = Math.floor(p.x) - origin.x, dz = Math.floor(p.z) - origin.z;
  return [dx * r.x + dz * r.z, dx * f.x + dz * f.z, Math.floor(p.y) - origin.y];
}

/** The layout's walls (outside and the partition) and what's left open in them. */
function shape(layout, d = 0, dw = 0) {
  const back = backOf(layout);
  const isWall = (lx, lz) => Math.abs(lx) === 2 || lz === 2 || lz === back || (layout === 'chests' && lz === -2);
  const isCorner = (lx, lz) => Math.abs(lx) === 2 && (lz === 2 || lz === back);
  const open = [...DOOR.map(([, b, c]) => [d, b, c]), ...WINDOWS, ...(layout === 'chests' ? DOORWAY.map(([, b, c]) => [dw, b, c]) : [])];
  const skip = (lx, lz, h) => open.some(([a, b, c]) => a === lx && b === lz && c === h);
  return { back, isWall, isCorner, skip };
}

/**
 * Every block to place, in build order: walls bottom row up, then the roof from the edges inward
 * (each roof block leans on one already placed). material: 'stone' | 'planks'.
 */
export function blueprint(origin, dir) {
  const layout = layoutOf(origin);
  const A = adapt(origin);
  const { back, isWall, isCorner, skip } = shape(layout, A.d, A.dw);
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
  const at = frame(origin, dir), back = backOf(layoutOf(origin)), d = adapt(origin).d;
  const out = [];
  for (let lx = -2; lx <= 2; lx++) for (let lz = back; lz <= 3; lz++) {
    if (lz === 3 && lx !== d) continue;
    for (let h = 0; h <= 3; h++) out.push(at(lx, lz, h));
  }
  return out;
}

/** Ground cells (one below the floor) that must be solid: the footprint and the doorstep. */
export function footing(origin, dir) {
  const at = frame(origin, dir), back = backOf(layoutOf(origin)), d = adapt(origin).d;
  const out = [];
  for (let lx = -2; lx <= 2; lx++) for (let lz = back; lz <= 3; lz++) {
    if (lz === 3 && lx !== d) continue;
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
  const at0 = frame(origin, dir);
  const layout = layoutOf(origin);
  const A = adapt(origin);
  const at = at0;
  // A thing's spot: where it was moved to (planAroundFixed), else its own.
  const spot = (name, lx, lz, h = 0) => { const m = A.moved[name]; return m ? at0(m[0], m[1], h) : at0(lx, lz, h); };
  const bedM = A.moved.bed;
  const common = {
    stand: spot('stand', 0, 0),        // middle of the front room: its walls and roof are in reach
    doorstep: at(A.d, 3),
    door: at(A.d, 2),
    table: spot('table', -1, -1),
    furnace: spot('furnace', -1, 0),
    // foot at the back, head toward the front; homestead checks both cells after placing
    bed: bedM ? { foot: at0(bedM.foot[0], bedM.foot[1]), head: at0(bedM.head[0], bedM.head[1]), standAt: at0(bedM.standAt[0], bedM.standAt[1]) } : { foot: at(1, -1), head: at(1, 0), standAt: at(1, 1) },
    torchesOutside: [A.d - 1, A.d + 1].filter((lx) => Math.abs(lx) <= 2).map((lx) => ({ on: at(lx, 2, 1), toward: at(lx, 3, 1) })),
    // Things there's no room for at all (a spot taken for good, nowhere else in the room): the
    // house counts as having them (homestead.houseState), so nothing waits on them.
    noRoom: [...Object.keys(A.moved).filter((k) => A.moved[k] === null), ...(A.moved.bedNone ? ['bed'] : [])],
  };
  if (layout === 'chests') {
    // Chests in the chest room's corners, each with a sign on the side wall over it (facing the
    // path down the middle); the torches on the partition (over the bed's foot) and the back wall.
    const corners = [[-1, -5], [1, -5], [-1, -3], [1, -3]];
    const chestAt = (i) => A.moved[`chest${i}`] ?? corners[i];
    // (A chest that had to move keeps no sign: there's no wall beside its new spot to hang it on.)
    const signed = [0, 1, 2, 3].filter((i) => !A.moved[`chest${i}`] && A.moved[`chest${i}`] !== null);
    const stand2 = spot('stand2', 0, -4);
    return {
      ...common,
      layout,
      // A second furnace, for food (the first does ore and charcoal): the front room's free corner by the door.
      furnace2: A.moved.furnace2 === null ? null : spot('furnace2', -1, 1),
      stands: [common.stand, stand2],
      chestStand: stand2,
      torchInside: { on: at(1, -2, 1), toward: at(1, -1, 1) },
      torchChests: { on: at(0, -6, 1), toward: at(0, -5, 1) },
      chests: [0, 1, 2, 3].filter((i) => A.moved[`chest${i}`] !== null).map((i) => at0(chestAt(i)[0], chestAt(i)[1])),
      chestKinds: [0, 1, 2, 3].filter((i) => A.moved[`chest${i}`] !== null).map((i) => CHEST_KINDS[i].kind),
      signs: signed.map((i) => { const [lx, lz] = corners[i]; return { cell: at(lx, lz, 1), on: at(Math.sign(lx) * 2, lz, 1), text: CHEST_KINDS[i].sign, kind: CHEST_KINDS[i].kind }; }),
      doorway: at(A.dw, -2),
    };
  }
  return {
    ...common,
    layout,
    furnace2: null, // (no room for a second in a cabin)
    stands: [common.stand],
    chestStand: common.stand,
    torchInside: { on: at(0, -2, 1), toward: at(0, -1, 1) },     // wall torch on the back wall
    torchChests: null,
    // Chests: the front corner left of the door, then the middle of the back wall (under the torch).
    // Neither is in the way (door -> middle of the room -> bed side), and both are in reach from
    // the middle of the room. Not side by side, so each stays a single chest of its own.
    chests: [0, 1].filter((i) => A.moved[`chest${i}`] !== null).map((i) => { const m = A.moved[`chest${i}`]; const d = [[-1, 1], [0, -1]][i]; return m ? at0(m[0], m[1]) : at0(d[0], d[1]); }),
    signs: [],
    chestKinds: null,
    doorway: null,
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
  const A = adapt(origin);
  const { isWall, skip } = shape(layout, A.d, A.dw);
  const acc = new Set(A.accepted.map((c) => c.join(',')));
  const out = [];
  const add = (p, local) => { if (acc.has(local.join(','))) return; const w = want.get(k(p)); out.push(w ? { ...p, want: w } : { ...p }); };
  for (let lx = -2; lx <= 2; lx++) for (let lz = back; lz <= 3; lz++) for (let h = 0; h <= 2; h++) {
    if (lz === 3) { if (lx === A.d && h <= 1) add(at(lx, lz, h), [lx, lz, h]); continue; } // the doorstep
    // Inside the walls, and the openings in them we walk through (the door, the chest room's doorway).
    if (isWall(lx, lz) && !(skip(lx, lz, h) && (lz === 2 ? lx === A.d : lz === -2 ? lx === A.dw : false))) continue;
    add(at(lx, lz, h), [lx, lz, h]);
  }
  // The torches outside hang off the front wall over the ground either side of the door.
  for (const t of fur.torchesOutside) {
    if (acc.has(toLocal(origin, dir, t.toward).join(','))) continue;
    if (!out.some((c) => k(c) === k(t.toward))) out.push({ ...t.toward, want: 'torch' });
  }
  return out;
}

/**
 * Blocks in the house we can't shift (obsidian without a diamond pickaxe, bedrock: `fixed`, world
 * cells): make the house work round them, as a player would, rather than try and fail for ever.
 *  - the doorway or doorstep taken: the door moves along the front wall (the old doorway's walled
 *    up, the block in it part of the wall); the chest room's doorway the same along the partition;
 *  - where one of our things goes (the table, a furnace, a chest, the bed): it moves to the nearest
 *    free spot in the same room that keeps the way through open (none: noRoom, and it's done without);
 *  - anywhere else it's left be (accepted), if the rooms can still be walked through.
 * Returns the house's new fields { doorLx, doorwayLx, moved, accepted } (the old ones kept).
 */
export function planAroundFixed(origin, dir, fixed) {
  const layout = layoutOf(origin), back = backOf(layout);
  const A = adapt(origin);
  let d = A.d, dw = A.dw;
  const moved = { ...A.moved };
  const accepted = [...A.accepted];
  const F = new Set(fixed.map((p) => toLocal(origin, dir, p).join(',')));
  const blocked = (lx, lz, h) => F.has(`${lx},${lz},${h}`);
  const walk = (lx, lz) => !blocked(lx, lz, 0) && !blocked(lx, lz, 1);
  const inRoom = (lx, lz) => Math.abs(lx) <= 1 && lz > back && lz < 2 && !(layout === 'chests' && lz === -2);
  const roomOf = (lz) => (layout === 'chests' && lz < -2 ? 'chests' : 'front');
  // 1. The door: its cells, the doorstep and the step inside it, all clear.
  const doorOk = (x) => walk(x, 2) && walk(x, 3) && walk(x, 1);
  if (!doorOk(d)) { const nd = [0, 1, -1].find((x) => x !== d && doorOk(x)); if (nd !== undefined) d = nd; }
  if (layout === 'chests' && !(walk(dw, -2) && walk(dw, -1) && walk(dw, -3))) { const nw = [0, 1, -1].find((x) => x !== dw && walk(x, -2) && walk(x, -1) && walk(x, -3)); if (nw !== undefined) dw = nw; }
  // Where things stand now (local), with the moves so far.
  const def = { stand: [0, 0], table: [-1, -1], furnace: [-1, 0], ...(layout === 'chests' ? { furnace2: [-1, 1], stand2: [0, -4], chest0: [-1, -5], chest1: [1, -5], chest2: [-1, -3], chest3: [1, -3] } : { chest0: [-1, 1], chest1: [0, -1] }) };
  const cur = (n) => (moved[n] !== undefined ? moved[n] : def[n]);
  const bed = () => moved.bed ?? { foot: [1, -1], head: [1, 0], standAt: [1, 1] };
  // Cells to keep for walking: the step in from the door, the stands, the bed's side, the doorway's
  // either side; and things' spots taken.
  const keepWalk = () => new Set([[d, 1], cur('stand'), bed().standAt, ...(layout === 'chests' ? [cur('stand2'), [dw, -1], [dw, -3]] : [])].filter(Boolean).map((c) => c.join(',')));
  const things = () => new Set([...Object.keys(def).filter((n) => !/^stand/.test(n)).map(cur), bed().foot, bed().head].filter(Boolean).map((c) => c.join(',')));
  // Can every stand, the bed side and the door step reach each other over walkable cells?
  const connected = (extraBlocked = new Set()) => {
    const free = (lx, lz) => (inRoom(lx, lz) || (lx === d && lz === 1) || (layout === 'chests' && lz === -2 && lx === dw)) && walk(lx, lz) && !extraBlocked.has(`${lx},${lz}`) && !things().has(`${lx},${lz}`);
    const start = [d, 1];
    if (!free(...start)) return false;
    const seen = new Set([start.join(',')]), q = [start];
    while (q.length) {
      const [x, z] = q.shift();
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = [x + a, z + b]; if (!seen.has(n.join(',')) && free(...n)) { seen.add(n.join(',')); q.push(n); } }
    }
    return [...keepWalk()].every((c) => seen.has(c));
  };
  // 2. A stand that's taken: the nearest free cell in its room.
  for (const s of layout === 'chests' ? ['stand', 'stand2'] : ['stand']) {
    const [sx, sz] = cur(s);
    if (walk(sx, sz)) continue;
    const opts = [];
    for (let lx = -1; lx <= 1; lx++) for (let lz = back + 1; lz <= 1; lz++) if (inRoom(lx, lz) && roomOf(lz) === roomOf(sz) && walk(lx, lz) && !things().has(`${lx},${lz}`)) opts.push([lx, lz]);
    opts.sort((a, b) => Math.hypot(a[0] - sx, a[1] - sz) - Math.hypot(b[0] - sx, b[1] - sz));
    if (opts[0]) moved[s] = opts[0];
  }
  // 3. Our things whose spot is taken (or now in the way of the door): the nearest free spot in the
  // room, else in the other room (the chest room's front room is full: the table goes by the chests).
  const relocate = (n) => {
    const [ox, oz] = cur(n);
    const opts = [];
    for (let lx = -1; lx <= 1; lx++) for (let lz = back + 1; lz <= 1; lz++) {
      if (!inRoom(lx, lz) || blocked(lx, lz, 0) || keepWalk().has(`${lx},${lz}`) || things().has(`${lx},${lz}`)) continue;
      if (!connected(new Set([`${lx},${lz}`]))) continue;
      opts.push([lx, lz]);
    }
    const cost = (c) => (roomOf(c[1]) === roomOf(oz) ? 0 : 100) + Math.hypot(c[0] - ox, c[1] - oz);
    opts.sort((a, b) => cost(a) - cost(b));
    moved[n] = opts[0] ?? null;
  };
  for (const n of Object.keys(def).filter((x) => !/^stand/.test(x))) {
    const c = cur(n);
    if (!c) continue;
    if (blocked(c[0], c[1], 0) || keepWalk().has(c.join(','))) relocate(n);
  }
  // The bed: two cells side by side and a free one beside it to get in from.
  const b0 = bed();
  if ([b0.foot, b0.head].some(([x, z]) => blocked(x, z, 0)) || !walk(...b0.standAt) || keepWalk().has(b0.foot.join(',')) || keepWalk().has(b0.head.join(','))) {
    let found = null;
    for (let lx = -1; lx <= 1 && !found; lx++) for (let lz = -1; lz <= 1 && !found; lz++) for (const [a, b] of [[0, 1], [1, 0]]) {
      const foot = [lx, lz], head = [lx + a, lz + b];
      if (!inRoom(...foot) || !inRoom(...head) || roomOf(foot[1]) !== 'front' || roomOf(head[1]) !== 'front') continue;
      if ([foot, head].some(([x, z]) => blocked(x, z, 0) || things().has(`${x},${z}`) || [d, 1].join(',') === `${x},${z}` || cur('stand').join(',') === `${x},${z}`)) continue;
      const standAt = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([p, q]) => [foot[0] + p, foot[1] + q]).find(([x, z]) => inRoom(x, z) && walk(x, z) && ![foot, head].some((c) => c[0] === x && c[1] === z) && !things().has(`${x},${z}`));
      if (standAt) found = { foot, head, standAt };
    }
    moved.bed = found ?? b0; // (nowhere: left as it is; it'll be done without a bed)
    if (!found) moved.bedNone = true;
  }
  // 4. Whatever's left where it is: accepted.
  for (const k of F) { const c = k.split(',').map(Number); if (!accepted.some((a) => a.join(',') === k)) accepted.push(c); }
  return { doorLx: d, doorwayLx: dw, moved, accepted };
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
