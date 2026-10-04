// An iron golem farm for Bedrock, as a layout (pure, unit-tested; game/ironfarm.js turns it into commands). A first draft from the Bedrock
// guides (the rules: 10+ villagers, 20+ beds, 75% of the villagers at a workstation, golems spawn at 1/700 a tick on a free spot inside
// 17 x 13 x 17 blocks of the village centre, the centre being the average of the beds and workstations), not something that has run.
//
// u207: made to be something a survival player could build before the Nether. A hollow shell of cobblestone round three rooms (not a solid
// block with rooms carved out of it), nothing but overworld materials (cobblestone, glass, composters, beds, hoppers, a chest, signs, torches,
// a water bucket and a lava bucket), and the lava held by wall signs the way the Bedrock guides do it. The shell has to leave exactly one
// place in the spawn volume where a golem can stand (a free spot is a full solid block with three free blocks above it): every room but the
// platform is two high, and every upward face left bare outside (the roofs) is covered with a slab, which golems do not spawn on.
// Coordinates are the plan's own (x east, y up, z south); the builder shifts them to wherever the farm goes. The farm hangs in the air, so
// there must be no ground within 6 blocks below it either (the builder looks).
//
//   y 7        platform roof
//   y 4-6      the platform (4 x 3 x 4): water from one source in its north-west corner flows to the south-east corner, where the golems end
//              up against the walls; a lava source above that corner, held by three wall signs (they stop lava running and stop nothing
//              walking), burns them there; what they drop falls on a hopper, along another, into a chest in the viewing room
//   y 1-2      the pod (10 x 6 x 2): 20 beds (two rows of ten, the aisle between), 10 composters in the south wall, 10 villagers, torches
//   y 4-5 z12+ the viewing room: a glass window onto the platform, the chest at your feet
//
// Where it is most likely to be wrong (in the order I would look): golems may not spawn on flowing water; the signs may not hold the lava;
// command-placed water may not start flowing (the builder checks and repairs that); the village may want a day or two before it counts the
// villagers as working; the centre may not be where this works it out to be; a slab may not be what stops a spawn.

export const SPAWN_VOLUME = Object.freeze({ rx: 8, ry: 6, rz: 8 });

const box = (x1, y1, z1, x2, y2, z2) => ({ x1, y1, z1, x2, y2, z2 });
export const POD = box(0, 1, 0, 9, 2, 5);
export const PLATFORM = box(3, 4, 7, 6, 6, 10);
export const ROOM = box(3, 4, 12, 7, 5, 13);
/** The outsides of the three rooms: the shell is these boxes with the rooms carved out. They share their touching walls. */
export const SHELLS = Object.freeze([box(-1, 0, -1, 10, 3, 6), box(2, 3, 6, 7, 7, 11), box(2, 3, 11, 8, 6, 14)]);
export const KILL = { x: 6, y: 4, z: 10 };          // the corner the water ends in
export const SOURCE = { x: 3, y: 4, z: 7 };         // the one water source
export const CHEST = { x: 6, y: 3, z: 12 };
export const STAND = { x: 6.5, y: 4, z: 13.5 };     // where the viewer is put: the glass ahead, the chest below
export const POD_VIEW = { x: 4.5, y: 1, z: 2.5 };
export const LAVA = { x: KILL.x, y: KILL.y + 2, z: KILL.z };
/** The three wall signs that hold the lava: where, and which way each faces (2 north, 3 south, 4 west, 5 east; it hangs on the block behind). */
export const SIGNS = Object.freeze([
  { x: KILL.x - 1, y: KILL.y + 2, z: KILL.z, facing: 2, note: 'sign west of the lava, on the south wall' },
  { x: KILL.x, y: KILL.y + 2, z: KILL.z - 1, facing: 4, note: 'sign north of the lava, on the east wall' },
  { x: KILL.x, y: KILL.y + 1, z: KILL.z, facing: 4, note: 'sign under the lava, on the east wall' },
]);
export const SLAB = 'cobblestone_slab';

/** Everything the plan may be made of: all of it is there before the Nether. */
export const ALLOWED = Object.freeze(['air', 'cobblestone', SLAB, 'glass', 'composter', 'bed', 'hopper', 'chest', 'wall_sign', 'torch', 'lava', 'water']);

/** Where a wall sign hangs: the offset from the sign to the block it is attached to, by the way it faces. */
export const signSupport = (facing) => ({ 2: [0, 1], 3: [0, -1], 4: [1, 0], 5: [-1, 0] })[facing] ?? null;

/** The village centre the game works out: the average of the beds and the workstations. (Both halves of a bed or just its head: unknown, so both.) */
export function villageCentre(beds, stations, headsOnly = false) {
  const pts = [...beds.flatMap((b) => (headsOnly ? [b.head] : [b.head, b.foot])), ...stations];
  const n = pts.length || 1;
  return { x: pts.reduce((a, p) => a + p.x, 0) / n, y: pts.reduce((a, p) => a + p.y, 0) / n, z: pts.reduce((a, p) => a + p.z, 0) / n };
}

const hull = (boxes) => box(
  Math.min(...boxes.map((b) => b.x1)), Math.min(...boxes.map((b) => b.y1)), Math.min(...boxes.map((b) => b.z1)),
  Math.max(...boxes.map((b) => b.x2)), Math.max(...boxes.map((b) => b.y2)), Math.max(...boxes.map((b) => b.z2)),
);
const opBox = (o) => (o.op === 'set' ? box(o.x, o.y, o.z, o.x, o.y, o.z) : o.box);

/** The plan: { ops (in order; tag 'sign' | 'lava' | 'water' | 'slab' marks the ones the builder treats with care), beds, stations, villagers, bounds, centre }. */
export function ironFarmPlan() {
  const ops = [];
  const fill = (b, id, note = '', tag = '') => ops.push({ op: 'fill', box: b, id, note, tag });
  const set = (x, y, z, id, states = undefined, note = '', tag = '') => ops.push({ op: 'set', x, y, z, id, states, note, tag });

  // The pod's beds: heads at z 1 and z 5, feet one block north of each (setblock makes the given cell the head: direction 0 = head to the south).
  const beds = [];
  for (let x = POD.x1; x <= POD.x2; x++) for (const hz of [1, 5]) beds.push({ head: { x, y: 1, z: hz }, foot: { x, y: 1, z: hz - 1 } });
  const stations = [];
  for (let x = POD.x1; x <= POD.x2; x++) stations.push({ x, y: 1, z: 6 });
  const villagers = [];
  for (let x = POD.x1; x <= POD.x2; x++) villagers.push({ x: x + 0.5, y: 1, z: x % 2 ? 3.5 : 2.5 });

  const c1 = villageCentre(beds, stations), c2 = villageCentre(beds, stations, true);
  const cx = Math.floor((c1.x + c2.x) / 2), cy = Math.floor((c1.y + c2.y) / 2), cz = Math.floor((c1.z + c2.z) / 2);

  // The shell, then the rooms carved out of it.
  for (const s of SHELLS) fill(s, 'cobblestone', 'shell');
  fill(POD, 'air', 'pod');
  fill(PLATFORM, 'air', 'platform');
  fill(ROOM, 'air', 'viewing room');
  fill(box(PLATFORM.x1, 4, 11, PLATFORM.x2, 5, 11), 'glass', 'window between the room and the platform');

  // Pod: workstations in the south wall (next to the south row of beds), beds, torches in the aisle (nothing hostile spawns in the dark among the villagers).
  for (const s of stations) set(s.x, s.y, s.z, 'composter', undefined, 'workstation');
  for (const b of beds) set(b.head.x, b.head.y, b.head.z, 'bed', { direction: 0, head_piece_bit: true }, 'bed (foot placed with it)');
  for (const [x, z] of [[1, 2], [4, 3], [5, 2], [8, 3]]) set(x, 1, z, 'torch', undefined, 'pod light');
  set(3, 4, 13, 'torch', undefined, 'room light');

  // The collection. (The platform needs no light: it is all water, and the lava glows.)
  set(KILL.x, KILL.y - 1, KILL.z, 'hopper', { facing_direction: 3 }, 'hopper under the corner, to the south');
  set(KILL.x, KILL.y - 1, KILL.z + 1, 'hopper', { facing_direction: 3 }, 'second hopper, to the south');
  set(CHEST.x, CHEST.y, CHEST.z, 'chest', undefined, 'chest');

  // Every upward face left bare outside gets a slab: a golem can spawn on any full block with room above it, and the sky is full of it.
  const bare = exposedTops(render({ ops }), hull(ops.map(opBox)));
  for (const run of runs(bare)) fill(box(run.x1, run.y, run.z, run.x2, run.y, run.z), SLAB, 'slab on a bare roof (no spawns on it)', 'slab');

  // The kill corner: signs first (they only stay on their wall), then the lava, then the water that flows to it.
  for (const s of SIGNS) set(s.x, s.y, s.z, 'wall_sign', { facing_direction: s.facing }, s.note, 'sign');
  set(LAVA.x, LAVA.y, LAVA.z, 'lava', undefined, 'the lava source, at head height of what stands in the corner', 'lava');
  set(SOURCE.x, SOURCE.y, SOURCE.z, 'water', undefined, 'the water source (the only one)', 'water');

  const bounds = hull(ops.map(opBox));
  return { ops, beds, stations, villagers, bounds, centre: { x: cx, y: cy, z: cz }, centres: [c1, c2] };
}

// ---------- the plan as a grid, and what can be checked about it ----------

/** Apply the plan's ops to a map "x,y,z" -> { id, states } (anything not set is air). */
export function render(plan) {
  const g = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (const o of plan.ops) {
    if (o.op === 'fill') {
      for (let x = o.box.x1; x <= o.box.x2; x++) for (let y = o.box.y1; y <= o.box.y2; y++) for (let z = o.box.z1; z <= o.box.z2; z++) {
        if (o.id === 'air') g.delete(key(x, y, z)); else g.set(key(x, y, z), { id: o.id });
      }
    } else {
      g.set(key(o.x, o.y, o.z), { id: o.id, states: o.states });
      if (o.id === 'bed' && o.states?.head_piece_bit) g.set(key(o.x, o.y, o.z - 1), { id: 'bed', states: { direction: 0, head_piece_bit: false } });
    }
  }
  return { at: (x, y, z) => g.get(key(x, y, z)), id: (x, y, z) => g.get(key(x, y, z))?.id ?? 'air', cells: g };
}

const SOLID = new Set(['cobblestone', 'glass', 'composter']);
const FREE = new Set(['air', 'water', 'wall_sign', 'torch']);
/** A cell a golem can stand in or walk through (no collision). Lava is not: nothing is meant to stand in it. */
export const passable = (id) => FREE.has(id);
/** A full block a golem can spawn on (slabs and the like are not). */
export const solid = (id) => SOLID.has(id);

/** The air outside the farm: everything reachable through air from beyond the bounds. */
export function outsideAir(grid, b) {
  const lo = { x: b.x1 - 1, y: b.y1 - 1, z: b.z1 - 1 }, hi = { x: b.x2 + 1, y: b.y2 + 1, z: b.z2 + 1 };
  const seen = new Set([`${lo.x},${lo.y},${lo.z}`]);
  const q = [[lo.x, lo.y, lo.z]];
  for (let i = 0; i < q.length; i++) {
    const [x, y, z] = q[i];
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz, k = `${nx},${ny},${nz}`;
      if (nx < lo.x || nx > hi.x || ny < lo.y || ny > hi.y || nz < lo.z || nz > hi.z || seen.has(k) || grid.id(nx, ny, nz) !== 'air') continue;
      seen.add(k); q.push([nx, ny, nz]);
    }
  }
  return seen;
}

/** The cells of air outside the farm that rest on a full block: a golem could spawn in them (given room above). */
export function exposedTops(grid, b) {
  const out = outsideAir(grid, b);
  const tops = [];
  for (const [k, v] of grid.cells) {
    if (!solid(v.id)) continue;
    const [x, y, z] = k.split(',').map(Number);
    if (out.has(`${x},${y + 1},${z}`)) tops.push({ x, y: y + 1, z });
  }
  return tops;
}

/** Cells in x-runs, per level and row: [{ y, z, x1, x2 }]. */
function runs(cells) {
  const by = new Map();
  for (const c of cells) { const k = `${c.y},${c.z}`; if (!by.has(k)) by.set(k, []); by.get(k).push(c.x); }
  const out = [];
  for (const [k, xs] of by) {
    const [y, z] = k.split(',').map(Number);
    xs.sort((a, b) => a - b);
    let s = xs[0], p = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === p + 1) { p = xs[i]; continue; }
      out.push({ y, z, x1: s, x2: p });
      s = xs[i]; p = xs[i];
    }
  }
  return out.sort((a, b) => a.y - b.y || a.z - b.z || a.x1 - b.x1);
}

/** The free spots a golem could spawn on inside the spawn volume round the centre: full solid floor, three free blocks (feet cell and two above). */
export function golemSpots(grid, centre) {
  const out = [];
  const V = SPAWN_VOLUME;
  for (let x = centre.x - V.rx; x <= centre.x + V.rx; x++) for (let y = centre.y - V.ry; y <= centre.y + V.ry; y++) for (let z = centre.z - V.rz; z <= centre.z + V.rz; z++) {
    if (!solid(grid.id(x, y - 1, z))) continue;
    if (passable(grid.id(x, y, z)) && passable(grid.id(x, y + 1, z)) && passable(grid.id(x, y + 2, z))) out.push({ x, y, z });
  }
  return out;
}

/** How the water spreads from the sources over one layer: Map "x,z" -> level (0 = a source, up to 7), horizontally, through free cells (not signs). */
export function waterField(grid, sources, y) {
  const lv = new Map();
  const q = [];
  for (const s of sources) { lv.set(`${s.x},${s.z}`, 0); q.push([s.x, s.z, 0]); }
  for (let i = 0; i < q.length; i++) {
    const [x, z, l] = q[i];
    if (l >= 7) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, k = `${nx},${nz}`;
      const here = grid.id(nx, y, nz);
      if (lv.has(k) || !passable(here) || here === 'wall_sign') continue;
      lv.set(k, l + 1); q.push([nx, nz, l + 1]);
    }
  }
  return lv;
}

/** What it takes to build it, counted from the plan: blocks by kind, and the survival shopping list as text. */
export function materials(plan) {
  const g = render(plan);
  const n = {};
  for (const v of g.cells.values()) n[v.id] = (n[v.id] ?? 0) + 1;
  n.bed = (n.bed ?? 0) / 2;
  const slabs = n[SLAB] ?? 0, cobble = n.cobblestone ?? 0;
  const cobbleForSlabs = Math.ceil(slabs / 6) * 3;
  const lines = [
    `cobblestone ${cobble} + ${slabs} cobblestone slabs (${cobbleForSlabs} more cobblestone: 3 make 6 slabs) = ${cobble + cobbleForSlabs}`,
    `${n.glass ?? 0} glass`,
    `${n.composter ?? 0} composters (7 wood slabs each)`,
    `${n.bed ?? 0} beds (3 wool + 3 planks each)`,
    `${n.hopper ?? 0} hoppers (5 iron each) and ${n.chest ?? 0} chest`,
    `${n.wall_sign ?? 0} signs`,
    `${n.torch ?? 0} torches`,
    'a water bucket and a lava bucket',
    `${plan.villagers.length} adult villagers`,
  ];
  return { counts: n, cobble: cobble + cobbleForSlabs, text: lines.join('; ') };
}

/** Everything that should hold about the plan; returns the list of what does not. */
export function checkPlan(plan) {
  const bad = [];
  const g = render(plan);
  const id = g.id;
  // Nothing from the Nether (or anywhere a survival player has not been yet).
  for (const v of g.cells.values()) if (!ALLOWED.includes(v.id)) bad.push(`${v.id} is not an overworld, pre-Nether material`);
  for (const o of plan.ops) if (!ALLOWED.includes(o.id)) bad.push(`${o.id} is not an overworld, pre-Nether material`);
  // The village.
  if (plan.beds.length < 20) bad.push(`${plan.beds.length} beds, 20 needed`);
  if (plan.stations.length < 10) bad.push(`${plan.stations.length} workstations, 10 needed`);
  if (plan.villagers.length < 10) bad.push(`${plan.villagers.length} villagers, 10 needed`);
  for (const b of plan.beds) {
    if (id(b.head.x, b.head.y, b.head.z) !== 'bed' || id(b.foot.x, b.foot.y, b.foot.z) !== 'bed') bad.push(`bed at ${b.head.x},${b.head.z} is not whole`);
  }
  const bedCells = new Set(plan.beds.flatMap((b) => [b.head, b.foot]).map((p) => `${p.x},${p.y},${p.z}`));
  if (bedCells.size !== plan.beds.length * 2) bad.push('two beds overlap');
  for (const s of plan.stations) {
    if (id(s.x, s.y, s.z) !== 'composter') bad.push(`no composter at ${s.x},${s.z}`);
    if (!bedCells.has(`${s.x},${s.y},${s.z - 1}`)) bad.push(`composter at ${s.x},${s.z} has no bed to stand on beside it`);
  }
  for (const v of plan.villagers) {
    const x = Math.floor(v.x), y = Math.floor(v.y), z = Math.floor(v.z);
    if (id(x, y, z) !== 'air' || id(x, y + 1, z) !== 'air') bad.push(`villager at ${v.x},${v.z} has no room`);
  }
  // Every cell of the pod has a roof and a floor, and the pod is two high (nothing a golem could stand in).
  for (let x = POD.x1; x <= POD.x2; x++) for (let z = POD.z1; z <= POD.z2; z++) {
    if (!solid(id(x, POD.y2 + 1, z))) bad.push(`pod roof missing at ${x},${z}`);
    if (!solid(id(x, POD.y1 - 1, z))) bad.push(`pod floor missing at ${x},${z}`);
  }
  // Light where things could spawn in the dark: a torch on a block, in the pod and in the viewing room.
  const torches = [...g.cells].filter(([, v]) => v.id === 'torch').map(([k]) => k.split(',').map(Number));
  if (torches.length < 4) bad.push(`${torches.length} torches`);
  for (const [x, y, z] of torches) if (!solid(id(x, y - 1, z))) bad.push(`torch at ${x},${y},${z} has no block under it`);
  if (!torches.some(([x, y, z]) => y >= ROOM.y1 && z >= ROOM.z1)) bad.push('no light in the viewing room');
  // Centre against the platform: every platform cell inside the volume round either reading of the centre, with a block to spare.
  for (const c of plan.centres) {
    for (let x = PLATFORM.x1; x <= PLATFORM.x2; x++) for (let z = PLATFORM.z1; z <= PLATFORM.z2; z++) for (let y = PLATFORM.y1; y <= PLATFORM.y2; y++) {
      if (Math.abs(x - c.x) > SPAWN_VOLUME.rx - 1 || Math.abs(z - c.z) > SPAWN_VOLUME.rz - 1 || Math.abs(y - c.y) > SPAWN_VOLUME.ry - 1) bad.push(`platform cell ${x},${y},${z} too far from the centre ${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}`);
    }
  }
  const bb = plan.bounds;
  for (const o of plan.ops) {
    const q = opBox(o);
    if (q.x1 < bb.x1 || q.x2 > bb.x2 || q.y1 < bb.y1 || q.y2 > bb.y2 || q.z1 < bb.z1 || q.z2 > bb.z2) bad.push(`${o.id} is outside the farm's bounds`);
  }
  // Sealed: no air inside the shell is reachable from outside (a hole would let the water, the villagers or the lava out, and mobs in).
  const out = outsideAir(g, bb);
  for (const r of [POD, PLATFORM, ROOM]) {
    for (let x = r.x1; x <= r.x2; x++) for (let y = r.y1; y <= r.y2; y++) for (let z = r.z1; z <= r.z2; z++) {
      if (out.has(`${x},${y},${z}`)) bad.push(`the shell has a hole: ${x},${y},${z} is open to the outside`);
    }
  }
  // Hollow, not a block: how much of the farm's box is solid.
  const boxCells = (bb.x2 - bb.x1 + 1) * (bb.y2 - bb.y1 + 1) * (bb.z2 - bb.z1 + 1);
  const blocks = [...g.cells.values()].filter((v) => v.id === 'cobblestone').length;
  if (blocks > boxCells * 0.4) bad.push(`${blocks} cobblestone in a box of ${boxCells}: that is a lump, not a shell`);
  if (blocks > 600) bad.push(`${blocks} cobblestone is more than a survival player wants to place`);
  // The only place a golem can spawn is the platform (and enough of it).
  for (const c of plan.centres) {
    const spots = golemSpots(g, { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) });
    const stray = spots.filter((p) => !(p.x >= PLATFORM.x1 && p.x <= PLATFORM.x2 && p.z >= PLATFORM.z1 && p.z <= PLATFORM.z2 && p.y === PLATFORM.y1));
    if (stray.length) bad.push(`golems could also spawn at ${stray.slice(0, 3).map((p) => `${p.x},${p.y},${p.z}`).join(' ')} (${stray.length} spots)`);
    if (spots.length < 12) bad.push(`only ${spots.length} spawn spots on the platform`);
  }
  const bare = exposedTops(g, bb);
  if (bare.length) bad.push(`${bare.length} bare roof cells outside (first ${bare[0].x},${bare[0].y},${bare[0].z}): a golem could stand there`);
  // Water: from the source to every cell of the platform floor, every cell but the corner with a way on that is further from the source.
  const lv = waterField(g, [SOURCE], PLATFORM.y1);
  for (let x = PLATFORM.x1; x <= PLATFORM.x2; x++) for (let z = PLATFORM.z1; z <= PLATFORM.z2; z++) {
    const l = lv.get(`${x},${z}`);
    if (l === undefined) { bad.push(`no water at ${x},${z}`); continue; }
    if (x === KILL.x && z === KILL.z) continue;
    const further = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => (lv.get(`${x + dx},${z + dz}`) ?? -1) > l);
    if (!further) bad.push(`water at ${x},${z} has nothing further on to flow to`);
  }
  const kl = lv.get(`${KILL.x},${KILL.z}`);
  if (kl === undefined || kl > 6) bad.push(`the corner is level ${kl} of 7: too near the end of the water`);
  const top = Math.max(...lv.values());
  if (kl !== top) bad.push(`the corner is level ${kl} but the furthest water is ${top}`);
  if (id(SOURCE.x, SOURCE.y, SOURCE.z) !== 'water') bad.push('no water source');
  // The lava: every side is cobblestone or a wall sign that is hanging on a block, never air or water, and it is not near the water.
  if (id(LAVA.x, LAVA.y, LAVA.z) !== 'lava') bad.push('no lava');
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
    const q = { x: LAVA.x + dx, y: LAVA.y + dy, z: LAVA.z + dz };
    const n = g.at(q.x, q.y, q.z);
    let ok = n?.id === 'cobblestone';
    if (n?.id === 'wall_sign') {
      const off = signSupport(n.states?.facing_direction);
      ok = !!off && solid(id(q.x + off[0], q.y, q.z + off[1]));
      if (!ok) bad.push(`the sign at ${dx},${dy},${dz} from the lava has nothing behind it to hang on`);
    }
    if (!ok && n?.id !== 'wall_sign') bad.push(`lava has ${n?.id ?? 'air'} beside it at ${dx},${dy},${dz}`);
    if (n?.id === 'water') bad.push('lava touches water');
  }
  if (LAVA.y - KILL.y < 2) bad.push('lava too close to the water');
  // The collection: a hopper under the corner pointing south, a second behind it, a chest at the end of them; the chest is in reach of the viewer.
  const h1 = g.at(KILL.x, KILL.y - 1, KILL.z), h2 = g.at(KILL.x, KILL.y - 1, KILL.z + 1), ch = g.at(CHEST.x, CHEST.y, CHEST.z);
  if (h1?.id !== 'hopper' || h1.states?.facing_direction !== 3) bad.push('the hopper under the corner does not point south');
  if (h2?.id !== 'hopper' || h2.states?.facing_direction !== 3) bad.push('the second hopper does not point south');
  if (ch?.id !== 'chest' || CHEST.z !== KILL.z + 2 || CHEST.x !== KILL.x || CHEST.y !== KILL.y - 1) bad.push('the chest is not at the end of the hoppers');
  if (id(STAND.x | 0, STAND.y, STAND.z | 0) !== 'air' || id(STAND.x | 0, STAND.y + 1, STAND.z | 0) !== 'air' || !solid(id(STAND.x | 0, STAND.y - 1, STAND.z | 0))) bad.push('the viewer has no room to stand');
  if (id(CHEST.x, CHEST.y + 1, CHEST.z) !== 'air') bad.push('something is on top of the chest');
  const reach = Math.hypot(STAND.x - (CHEST.x + 0.5), STAND.y + 1.62 - (CHEST.y + 0.5), STAND.z - (CHEST.z + 0.5));
  if (reach > 3.5) bad.push(`the chest is ${reach.toFixed(1)} blocks from the viewer's eyes`);
  return bad;
}

/** A block id with states as a setblock argument, or the bare id. */
export function blockArg(id, states) {
  if (!states) return id;
  const s = Object.entries(states).map(([k, v]) => `"${k}"=${typeof v === 'string' ? `"${v}"` : v}`).join(',');
  return `${id} [${s}]`;
}
