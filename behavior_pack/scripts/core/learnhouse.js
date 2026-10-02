// Learning your house from watching you build it. Pure (unit-tested).
//
// While `!bot learn house` is on, game/demo.js gives you everything a house needs, you build one,
// and at the end it reads what is actually standing where you built (a snapshot of the blocks, not a
// replay of clicks: doors, beds and chests come out right that way) and turns it into a plan:
//
//   origin  the cell just inside the door, at floor level
//   lx      across (right-hand side looking out of the door), lz toward the door and out
//           (the door is at lz 1, the doorstep at lz 2), h up from the floor
//   shell   the wall, roof and floor blocks that make the room, each as 's' (stone-like) or 'p'
//           (wood-like): the bot builds the shape in its own cheap blocks, not your palette
//   open    window holes left open (high up, one block, like the starter house's)
//   floor   the cells you walk on, inside
//   the bed, table, furnaces, chests, the torch inside and the ones by the door
//
// `buildPlan` only returns a plan when it passes the same things the starter house is held to
// (core/house.js and homestead.js): a closed room (nothing can walk in but through the door), a door
// with a doorstep, a bed, a crafting table, a furnace and a chest you can reach from the door, floor
// under it all, room to stand and place every block from inside, and a size it can afford.
// Otherwise it says why, and the starter house stays.

/** @type {Array<[string, number]>} */
export const HOUSE_KIT = [
  ['cobblestone', 384], ['oak_planks', 384], ['oak_log', 128], ['dirt', 64], ['glass', 64], ['glass_pane', 32], ['stone_bricks', 64],
  ['oak_stairs', 64], ['stone_stairs', 64], ['oak_slab', 64], ['cobblestone_slab', 64],
  ['oak_door', 4], ['bed', 2], ['crafting_table', 2], ['furnace', 4], ['chest', 8], ['oak_sign', 12], ['torch', 64], ['ladder', 16], ['oak_fence', 32],
  ['stone_pickaxe', 1], ['stone_axe', 1], ['stone_shovel', 1], ['bread', 16],
];

const strip = (id) => String(id ?? 'air').replace(/^minecraft:/, '');

// ---------- what a block is ----------
const PASSABLE = /^(air|cave_air|void_air|torch|wall_torch|soul_torch|redstone_torch|short_grass|tall_grass|fern|large_fern|dead_bush|deadbush|snow_layer|vine|.*_carpet|carpet|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|allium|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|.*_button|lever|redstone_wire|.*_pressure_plate|.*sign|ladder|.*_banner|lantern|soul_lantern|candle|.*_candle|flower_pot|item_frame|glow_item_frame|light_block.*)$/;
const TORCH = /^(torch|wall_torch|soul_torch)$/;
const FURN = { table: /^crafting_table$/, furnace: /^(furnace|lit_furnace|blast_furnace|smoker|lit_blast_furnace|lit_smoker)$/, chest: /^(chest|trapped_chest|barrel)$/, bed: /(^|_)bed$/ };
const furnishingOf = (id) => Object.keys(FURN).find((k) => FURN[k].test(id)) ?? null;
const DOOR = /(^|_)door$/;
const GLASS = /^(glass|glass_pane|.*_stained_glass|.*_stained_glass_pane|tinted_glass)$/;
const NATURAL = /^(stone|dirt|grass_block|coarse_dirt|podzol|sand|red_sand|gravel|clay|mud|andesite|diorite|granite|tuff|deepslate|snow|ice|packed_ice|sandstone|netherrack|water|lava|bedrock|dirt_with_roots|mycelium|moss_block)$/;
const STONEISH = /(stone|brick|deepslate|andesite|diorite|granite|concrete|terracotta|blackstone|tuff|obsidian|sandstone|quartz|netherrack|prismarine|purpur|copper|basalt)/;

const K = (x, y, z) => `${x},${y},${z}`;
const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * Read a box of world into a snapshot: get(x, y, z) -> block id (or undefined), box { x0, x1, y0, y1, z0, z1 }
 * (inclusive). Air isn't stored. `heads(x, y, z)` (optional) says a bed block is its head piece.
 */
export function capture(get, box, heads = null) {
  const cells = new Map(), head = new Set();
  for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) {
    const id = strip(get(x, y, z));
    if (id === 'air') continue;
    cells.set(K(x, y, z), id);
    if (heads && FURN.bed.test(id) && heads(x, y, z)) head.add(K(x, y, z));
  }
  return { cells, box, head };
}

/** The box to read for a build: the placed blocks' cluster (the biggest group touching within 3) plus a margin. */
export function boxOf(placed, margin = 3) {
  if (!placed.length) return null;
  const pts = placed.map((p) => [p.x, p.y, p.z]);
  // Clusters: blocks within 3 of each other (a pillar you climbed on, far from the house, drops out).
  const seen = new Array(pts.length).fill(false);
  let best = [];
  for (let i = 0; i < pts.length; i++) {
    if (seen[i]) continue;
    const comp = [], q = [i];
    seen[i] = true;
    while (q.length) {
      const a = q.pop();
      comp.push(pts[a]);
      for (let j = 0; j < pts.length; j++) if (!seen[j] && Math.abs(pts[a][0] - pts[j][0]) <= 3 && Math.abs(pts[a][1] - pts[j][1]) <= 3 && Math.abs(pts[a][2] - pts[j][2]) <= 3) { seen[j] = true; q.push(j); }
    }
    if (comp.length > best.length) best = comp;
  }
  const xs = best.map((p) => p[0]), ys = best.map((p) => p[1]), zs = best.map((p) => p[2]);
  return { x0: Math.min(...xs) - margin, x1: Math.max(...xs) + margin, y0: Math.min(...ys) - 2, y1: Math.max(...ys) + margin, z0: Math.min(...zs) - margin, z1: Math.max(...zs) + margin, n: best.length };
}

/**
 * Turn a snapshot into a plan.
 *   snap       { cells: Map, box, head: Set }  (capture)
 *   opts.placed   Set of "x,y,z" the player placed (blocks that are theirs, whatever the id); default: every non-natural block
 *   opts.firstDoor  "x,y,z" of the first door they placed (the entrance, if it has a room behind it)
 * Returns { ok, plan, problems: [string], notes: [string], stats }.
 */
export function buildPlan(snap, opts = {}) {
  const problems = [], notes = [];
  const { cells, box } = snap;
  const idAt = (x, y, z) => cells.get(K(x, y, z)) ?? 'air';
  const inBox = (x, y, z) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1;
  const placed = opts.placed ?? null;
  const mine = (x, y, z) => (placed ? placed.has(K(x, y, z)) || (DOOR.test(idAt(x, y, z)) && placed.has(K(x, y - 1, z))) : !NATURAL.test(idAt(x, y, z)));

  // ---- 1. the entrance: a door with a closed room on exactly one side
  const doors = [];
  for (const [k, id] of cells) {
    if (!DOOR.test(id)) continue;
    const [x, y, z] = k.split(',').map(Number);
    if (DOOR.test(idAt(x, y - 1, z))) continue; // the upper half
    if (!DOOR.test(idAt(x, y + 1, z))) continue; // half a door
    doors.push({ x, y, z });
  }
  if (!doors.length) return fail(['no door: build one so it knows where the front is']);
  // The first one placed is tried first.
  doors.sort((a, b) => (K(a.x, a.y, a.z) === opts.firstDoor ? -1 : 0) - (K(b.x, b.y, b.z) === opts.firstDoor ? -1 : 0));

  const isOpenCell = (x, y, z) => {
    const id = idAt(x, y, z);
    return PASSABLE.test(id) || furnishingOf(id) !== null;
  };
  /** Cells that are one-block holes in a wall high up (the starter house's windows): sealed for the purposes of "closed". */
  const windowHoles = (floorY) => {
    const w = new Set();
    for (let x = box.x0 + 1; x < box.x1; x++) for (let y = floorY + 2; y < box.y1; y++) for (let z = box.z0 + 1; z < box.z1; z++) {
      if (idAt(x, y, z) !== 'air') continue;
      const sol = (a, b, c) => { const id = idAt(a, b, c); return !PASSABLE.test(id) && furnishingOf(id) === null; };
      if (!(sol(x, y + 1, z) && sol(x, y - 1, z))) continue;
      if ((sol(x + 1, y, z) && sol(x - 1, y, z)) || (sol(x, y, z + 1) && sol(x, y, z - 1))) w.add(K(x, y, z));
    }
    return w;
  };
  /** Flood the room behind a door from the cell inside it. */
  const room = (start, floorY, windows, door) => {
    const seen = new Set([K(...start)]), q = [start];
    let leak = null;
    const doorCells = new Set([K(door.x, door.y, door.z), K(door.x, door.y + 1, door.z)]);
    while (q.length) {
      const [x, y, z] = q.pop();
      for (const [a, b, c] of N6) {
        const n = [x + a, y + b, z + c];
        const nk = K(...n);
        if (seen.has(nk)) continue;
        if (!inBox(...n)) { leak = leak ?? { at: [x, y, z] }; continue; }
        if (doorCells.has(nk) || windows.has(nk)) continue; // a closed door, a window hole (sealed: see windowHoles)
        if (!isOpenCell(...n)) continue;
        if (n[0] <= box.x0 || n[0] >= box.x1 || n[2] <= box.z0 || n[2] >= box.z1 || n[1] >= box.y1) { leak = leak ?? { at: n }; continue; }
        seen.add(nk); q.push(n);
        if (seen.size > 2500) return { seen, leak: leak ?? { at: n, big: true } };
      }
    }
    return { seen, leak };
  };

  let chosen = null;
  const why = [];
  for (const d of doors) {
    for (const [fx, fz] of H4) {
      const inside = [d.x - fx, d.y, d.z - fz], outside = [d.x + fx, d.y, d.z + fz];
      if (!isOpenCell(...inside) || !isOpenCell(...outside)) continue;
      const windows = windowHoles(d.y);
      const r = room(inside, d.y, windows, d);
      const o = room(outside, d.y, windows, d);
      // A room behind it, and the other side not another closed room.
      if (!r.leak && r.seen.size >= 6 && o.leak) { chosen = { d, f: [fx, fz], inside, outside, r, windows }; break; }
      if (r.leak) why.push(`the room behind the door at ${d.x} ${d.y} ${d.z} is open to the outside near ${r.leak.at.join(' ')}${r.leak.big ? ' (or just too big)' : ''}`);
    }
    if (chosen) break;
  }
  if (!chosen) return fail(why.length ? [...new Set(why)].slice(0, 3) : ['no door with a closed room behind it']);

  const { d: door, f, inside, outside, r, windows } = chosen;
  const floorY = door.y;
  // Local frame: origin = inside; lz along f (out of the door); lx to the right looking out.
  const rt = [-f[1], f[0]];
  const loc = (x, y, z) => { const dx = x - inside[0], dz = z - inside[2]; return [(dx * rt[0] + dz * rt[1]) || 0, (dx * f[0] + dz * f[1]) || 0, y - floorY]; };
  const world = (lx, lz, h) => [inside[0] + lx * rt[0] + lz * f[0], floorY + h, inside[2] + lx * rt[1] + lz * f[1]];

  // ---- 2. the doorstep, and what stands on the floor
  const stepBelow = idAt(outside[0], outside[1] - 1, outside[2]);
  if (PASSABLE.test(stepBelow) || /^(water|lava)$/.test(stepBelow)) problems.push('nothing solid to stand on outside the door');
  if (!isOpenCell(outside[0], outside[1] + 1, outside[2])) problems.push('the doorstep has no headroom');

  const interior = [...r.seen].map((k) => k.split(',').map(Number));
  const things = { table: [], furnace: [], chest: [], bed: [] };
  const floorSet = new Set();
  for (const c of interior) {
    const [x, y, z] = c;
    if (y !== floorY) continue;
    const id = idAt(x, y, z);
    const fk = furnishingOf(id);
    if (fk) { things[fk].push({ x, y, z, id }); continue; }
    const below = idAt(x, y - 1, z);
    const headroom = r.seen.has(K(x, y + 1, z)) && furnishingOf(idAt(x, y + 1, z)) === null;
    if (!PASSABLE.test(below) && !/^(water|lava)$/.test(below) && headroom) floorSet.add(K(x, y, z));
  }
  const hMax = Math.max(0, ...interior.map((c) => c[1] - floorY));
  if (floorSet.size < 9) problems.push(`the room is too small to live in (${floorSet.size} cells of floor)`);

  // ---- 3. walking: from the door, to everything
  const reach = new Set();
  { const s = K(...inside); if (floorSet.has(s)) { reach.add(s); const q = [inside]; while (q.length) { const [x, y, z] = q.pop(); for (const [a, b] of H4) { const n = K(x + a, y, z + b); if (floorSet.has(n) && !reach.has(n)) { reach.add(n); q.push([x + a, y, z + b]); } } } } else problems.push('no way to stand just inside the door'); }
  const near = (c) => H4.some(([a, b]) => reach.has(K(c.x + a, c.y, c.z + b)));
  // Beds come as two blocks side by side.
  let bed = null;
  if (things.bed.length >= 2) {
    const bs = things.bed;
    const pair = bs.map((a) => ({ a, b: bs.find((b) => b !== a && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1) })).find((p) => p.b);
    if (pair) {
      const hd = snap.head ?? new Set();
      const headFirst = hd.has(K(pair.a.x, pair.a.y, pair.a.z));
      const [foot, head] = hd.size ? (headFirst ? [pair.b, pair.a] : [pair.a, pair.b]) : (Math.abs(pair.a.x - inside[0]) + Math.abs(pair.a.z - inside[2]) > Math.abs(pair.b.x - inside[0]) + Math.abs(pair.b.z - inside[2]) ? [pair.a, pair.b] : [pair.b, pair.a]);
      const standAt = [foot, head].flatMap((c) => H4.map(([a, b]) => ({ x: c.x + a, y: c.y, z: c.z + b }))).find((c) => reach.has(K(c.x, c.y, c.z)));
      if (standAt) bed = { foot, head, standAt };
      else problems.push('you can\'t get to the bed from the door');
    }
  }
  if (!bed && !problems.some((p) => /bed/.test(p))) problems.push('no bed');
  if (!things.table.length) problems.push('no crafting table');
  else if (!near(things.table[0])) problems.push('you can\'t get to the crafting table from the door');
  if (!things.furnace.length) problems.push('no furnace');
  else if (!things.furnace.some(near)) problems.push('you can\'t get to the furnace from the door');
  const chests = things.chest.filter(near);
  if (!things.chest.length) problems.push('no chest');
  else if (!chests.length) problems.push('you can\'t get to the chest from the door');

  // ---- 4. the shell: man-made solid blocks touching the room (26 neighbours), minus the door
  const shell = new Map(), open = new Map();
  const doorCells = new Set([K(door.x, door.y, door.z), K(door.x, door.y + 1, door.z)]);
  const consider = (x, y, z) => {
    const k = K(x, y, z);
    if (r.seen.has(k) || shell.has(k) || open.has(k) || doorCells.has(k)) return;
    const id = idAt(x, y, z);
    if (windows.has(k)) { open.set(k, [x, y, z]); return; }
    if (PASSABLE.test(id) || furnishingOf(id) !== null) return;
    if (!mine(x, y, z)) return;
    const h = y - floorY;
    if (GLASS.test(id) && h >= 2) { open.set(k, [x, y, z]); return; }
    shell.set(k, { c: [x, y, z], m: GLASS.test(id) || !STONEISH.test(id) ? 'p' : 's' });
  };
  for (const c of interior) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let e = -1; e <= 1; e++) if (a || b || e) consider(c[0] + a, c[1] + b, c[2] + e);
  // The floor under the room if it's yours (a plank floor): the ground stays footing.
  for (const k of floorSet) { const [x, y, z] = k.split(',').map(Number); consider(x, y - 1, z); }

  // ---- 5. size and stands
  const sh = [...shell.values()].map((s) => ({ l: loc(...s.c), m: s.m }));
  const fl = [...floorSet].map((k) => loc(...k.split(',').map(Number)));
  const lxs = [...sh.map((s) => s.l[0]), ...fl.map((c) => c[0])], lzs = [...sh.map((s) => s.l[1]), ...fl.map((c) => c[1])];
  const boxL = { lx0: Math.min(...lxs), lx1: Math.max(...lxs), lz0: Math.min(...lzs), lz1: Math.max(...lzs, 2), h1: Math.max(0, ...sh.map((s) => s.l[2]), hMax) };
  if (boxL.lx1 - boxL.lx0 + 1 > 17 || boxL.lz1 - boxL.lz0 + 1 > 17) problems.push(`it's ${boxL.lx1 - boxL.lx0 + 1} by ${boxL.lz1 - boxL.lz0 + 1}: bigger than 17 either way`);
  if (boxL.h1 > 8) problems.push(`it's ${boxL.h1} blocks high: over 8`);
  if (sh.length > 600) problems.push(`${sh.length} wall and roof blocks: over 600`);
  if (sh.length < 20) problems.push('hardly any walls');

  // Where to stand to place everything: inside, from reach. Greedy cover over the room's floor.
  const eyeH = 1.62, REACH = 4.2;
  const cand = [...reach].map((k) => loc(...k.split(',').map(Number)));
  const targets = [...sh.map((s) => s.l), ...[...things.table, ...things.furnace, ...things.chest].map((t) => loc(t.x, t.y, t.z))];
  const can = (s, t) => Math.hypot(s[0] + 0.5 - (t[0] + 0.5), s[1] + 0.5 - (t[1] + 0.5), eyeH - (t[2] + 0.5)) <= REACH;
  const stands = [];
  let left = targets.slice();
  while (left.length && stands.length < 6 && cand.length) {
    let best = null, bn = 0;
    for (const s of cand) { const n = left.filter((t) => can(s, t)).length; if (n > bn || (n === bn && best && Math.hypot(s[0], s[1]) < Math.hypot(best[0], best[1]))) { best = s; bn = n; } }
    if (!best || !bn) break;
    stands.push([best[0], best[1]]);
    left = left.filter((t) => !can(best, t));
  }
  const covered = targets.length ? 1 - left.length / targets.length : 1;
  if (covered < 0.85) problems.push(`only ${Math.round(covered * 100)}% of it can be reached from inside: too big to build from the room`);
  else if (left.length) notes.push(`${left.length} block(s) out of reach from inside; the bot will step out for them`);

  // ---- 6. torches
  const interiorTorches = interior.filter((c) => TORCH.test(idAt(...c))).map((c) => loc(...c));
  const hang = (c) => { // the solid block a torch at c (local) hangs on: a horizontal neighbour, else below
    for (const [a, b] of H4) { const w = world(c[0] + a, c[1] + b, c[2]); const id = idAt(...w); if (!PASSABLE.test(id) && furnishingOf(id) === null) return [c[0] + a, c[1] + b, c[2]]; }
    return [c[0], c[1], c[2] - 1];
  };
  let torchIn = null;
  const t0 = interiorTorches.find((c) => c[2] >= 1 && c[2] <= 2) ?? interiorTorches[0];
  if (t0) torchIn = { on: hang(t0), toward: t0 };
  else {
    // None: one on the wall at head height in the floor cell nearest a wall, far from the door.
    const opts2 = [...floorSet].map((k) => loc(...k.split(',').map(Number))).flatMap((c) => H4.map(([a, b]) => ({ c, on: world(c[0] + a, c[1] + b, 1) })).filter((o2) => shell.has(K(...o2.on))).map((o2) => ({ toward: [c[0], c[1], 1], on: loc(...o2.on), d: Math.hypot(c[0], c[1]) })));
    opts2.sort((p, q) => q.d - p.d);
    if (opts2[0]) { torchIn = { on: opts2[0].on, toward: opts2[0].toward }; notes.push('no torch inside: it will hang one on the far wall'); }
    else problems.push('no wall to hang a torch on inside');
  }
  const torchOut = [];
  for (const sd of [-1, 1]) {
    const on = [sd, 1, 1], toward = [sd, 2, 1];
    if (shell.has(K(...world(...on))) && PASSABLE.test(idAt(...world(...toward))) && !r.seen.has(K(...world(...toward)))) torchOut.push({ on, toward });
  }

  const stats = { shell: sh.length, floor: fl.length, box: boxL, stone: sh.filter((s) => s.m === 's').length, planks: sh.filter((s) => s.m === 'p').length, covered: Math.round(covered * 100) };
  if (problems.length) return { ok: false, problems, notes, stats };

  const pt = (c) => { const l = loc(c.x, c.y, c.z); return [l[0], l[1]]; };
  const kinds = { 1: ['misc'], 2: ['stone', 'misc'], 3: ['stone', 'food', 'misc'], 4: ['stone', 'wood', 'food', 'misc'] };
  const plan = {
    v: 1,
    shell: sh.map((s) => [s.l[0], s.l[1], s.l[2], s.m]).sort((a, b) => a[2] - b[2] || b[1] - a[1] || a[0] - b[0]),
    open: [...open.values()].map((w) => loc(...w)),
    floor: fl.map((c) => [c[0], c[1]]),
    air: interior.map((c) => loc(...c)).filter((c) => c[2] >= 0),
    table: pt(things.table[0]),
    furnaces: things.furnace.slice(0, 2).map(pt),
    bed: { foot: pt(bed.foot), head: pt(bed.head), standAt: pt(bed.standAt) },
    chests: chests.slice(0, 4).map(pt),
    chestKinds: kinds[Math.min(4, chests.length)],
    torchIn, torchOut,
    stands: stands.length ? stands : [[0, 0]],
    box: boxL,
  };
  plan.at = opts.at ?? 0;
  return { ok: true, plan, problems, notes, stats };

  function fail(p) { return { ok: false, problems: p, notes, stats: null }; }
}

// ---------- the plan in use ----------
let ACTIVE = null;
/** The plan houses of layout 'learned' are built from (set when it's loaded; null: none). */
export const setPlan = (p) => { ACTIVE = p ?? null; };
export const getPlan = () => ACTIVE;

/** How many blocks of each kind the plan's shell takes, and the fittings. */
export function planMaterials(plan) {
  const sh = plan.shell;
  return { stone: sh.filter((s) => s[3] === 's').length, planks: sh.filter((s) => s[3] === 'p').length, doors: 1, torches: 1 + plan.torchOut.length, chests: plan.chests.length, signs: 0 };
}

/** A few lines of text for the chat or the dashboard: each floor-level layer as a picture. */
export function describe(plan) {
  const b = plan.box;
  const rows = [];
  const grid = (h) => {
    const out = [];
    for (let lz = b.lz1; lz >= b.lz0; lz--) {
      let s = '';
      for (let lx = b.lx0; lx <= b.lx1; lx++) {
        const sh = plan.shell.find((c) => c[0] === lx && c[1] === lz && c[2] === h);
        const f = h === 0 ? thing(plan, lx, lz) : null;
        s += f ?? (sh ? (sh[3] === 's' ? '#' : '=') : plan.open.some((o) => o[0] === lx && o[1] === lz && o[2] === h) ? 'o' : (h === 0 && lx === 0 && lz === 1) ? 'D' : (h === 0 && plan.floor.some((c) => c[0] === lx && c[1] === lz)) ? '.' : ' ');
      }
      out.push(s);
    }
    return out;
  };
  for (const h of [0, 1, Math.max(2, b.h1)]) rows.push(`h=${h}`, ...grid(h));
  return rows;
}
function thing(plan, lx, lz) {
  if (plan.table[0] === lx && plan.table[1] === lz) return 'T';
  if (plan.furnaces.some((c) => c[0] === lx && c[1] === lz)) return 'F';
  if (plan.chests.some((c) => c[0] === lx && c[1] === lz)) return 'C';
  if ((plan.bed.foot[0] === lx && plan.bed.foot[1] === lz) || (plan.bed.head[0] === lx && plan.bed.head[1] === lz)) return 'B';
  return null;
}

// ---------- the plan as the house code wants it (world cells from an origin and a facing) ----------
const DIRS = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };
/** (lx, lz, h) -> world, for a house whose door faces `dir` and whose origin is the cell inside it. */
export function planFrame(origin, dir) {
  const f = DIRS[dir], r = { x: -f.z, z: f.x };
  return (lx, lz, h = 0) => ({ x: origin.x + lx * r.x + lz * f.x, y: origin.y + h, z: origin.z + lx * r.z + lz * f.z });
}
