// An iron golem farm for Bedrock, as a layout (pure, unit-tested; game/ironfarm.js turns it into commands). A first draft from the Bedrock
// guides (the rules: 10+ villagers, 20+ beds, 75% of the villagers at a workstation, golems spawn at 1/700 a tick on a free spot inside
// 17 x 13 x 17 blocks of the village centre, the centre being the average of the beds and workstations), not something that has run.
//
// Everything is carved out of one solid block of stone, so the platform is the ONLY place in the spawn volume a golem could stand (a free
// spot is a solid floor with three free blocks above it; every other room here is two high). Coordinates are the plan's own (x east, y up,
// z south); the builder shifts them to wherever the farm goes.
//
//   y 7        roof
//   y 4-6      the platform (4 x 3 x 4): water from one source in its north-west corner flows to the south-east corner, where the golems end
//              up against the walls; a lava source above that corner, held by open crimson fence gates (they stop lava running and stop
//              nothing walking), burns them there; what they drop falls on a hopper, along another, into a chest in the viewing room
//   y 1-2      the pod (10 x 6 x 2): 20 beds (two rows of ten, the aisle between), 10 composters in the south wall, 10 villagers
//   y 4-5 z12+ the viewing room: a glass window onto the platform, the chest at your feet
//
// Where it is most likely to be wrong (in the order I would look): golems may not spawn on flowing water; the gates may not hold the lava;
// the village may want a day or two before it counts the villagers as working; the centre may not be where this works it out to be.

export const SPAWN_VOLUME = Object.freeze({ rx: 8, ry: 6, rz: 8 });
export const SAFETY = Object.freeze({ x: 4, y: 4, z: 4 });   // extra solid stone round the volume, in case the centre is a block or two off

const box = (x1, y1, z1, x2, y2, z2) => ({ x1, y1, z1, x2, y2, z2 });
export const POD = box(0, 1, 0, 9, 2, 5);
export const PLATFORM = box(3, 4, 7, 6, 6, 10);
export const ROOM = box(3, 4, 12, 7, 5, 13);
export const KILL = { x: 6, y: 4, z: 10 };          // the corner the water ends in
export const SOURCE = { x: 3, y: 4, z: 7 };         // the one water source
export const CHEST = { x: 6, y: 3, z: 12 };
export const STAND = { x: 6.5, y: 4, z: 13.5 };     // where the viewer is put: the glass ahead, the chest below
export const POD_VIEW = { x: 4.5, y: 1, z: 2.5 };

/** The village centre the game works out: the average of the beds and the workstations. (Both halves of a bed or just its head: unknown, so both.) */
export function villageCentre(beds, stations, headsOnly = false) {
  const pts = [...beds.flatMap((b) => (headsOnly ? [b.head] : [b.head, b.foot])), ...stations];
  const n = pts.length || 1;
  return { x: pts.reduce((a, p) => a + p.x, 0) / n, y: pts.reduce((a, p) => a + p.y, 0) / n, z: pts.reduce((a, p) => a + p.z, 0) / n };
}

/** The plan: { ops (in order), beds, stations, villagers, cube (the solid block), centre }. */
export function ironFarmPlan() {
  const ops = [];
  const fill = (b, id, note = '') => ops.push({ op: 'fill', box: b, id, note });
  const set = (x, y, z, id, states = undefined, note = '') => ops.push({ op: 'set', x, y, z, id, states, note });

  // The pod's beds: heads at z 1 and z 5, feet one block north of each (setblock makes the given cell the head: direction 0 = head to the south).
  const beds = [];
  for (let x = POD.x1; x <= POD.x2; x++) for (const hz of [1, 5]) beds.push({ head: { x, y: 1, z: hz }, foot: { x, y: 1, z: hz - 1 } });
  const stations = [];
  for (let x = POD.x1; x <= POD.x2; x++) stations.push({ x, y: 1, z: 6 });
  const villagers = [];
  for (let x = POD.x1; x <= POD.x2; x++) villagers.push({ x: x + 0.5, y: 1, z: x % 2 ? 3.5 : 2.5 });

  const c1 = villageCentre(beds, stations), c2 = villageCentre(beds, stations, true);
  const cx = Math.floor((c1.x + c2.x) / 2), cy = Math.floor((c1.y + c2.y) / 2), cz = Math.floor((c1.z + c2.z) / 2);
  const cube = box(
    cx - SPAWN_VOLUME.rx - SAFETY.x, cy - SPAWN_VOLUME.ry - SAFETY.y, cz - SPAWN_VOLUME.rz - SAFETY.z,
    cx + SPAWN_VOLUME.rx + SAFETY.x, cy + SPAWN_VOLUME.ry + SAFETY.y, cz + SPAWN_VOLUME.rz + SAFETY.z,
  );
  fill(cube, 'stone', 'the solid block everything is carved from');

  // Rooms.
  fill(POD, 'air', 'pod');
  fill(PLATFORM, 'air', 'platform');
  fill(ROOM, 'air', 'viewing room');
  fill(box(PLATFORM.x1, 4, 11, PLATFORM.x2, 5, 11), 'glass', 'window between the room and the platform');

  // Pod: workstations in the south wall (next to the south row of beds), light in the roof, beds.
  for (const s of stations) set(s.x, s.y, s.z, 'composter', undefined, 'workstation');
  for (const [x, z] of [[2, 1], [7, 1], [2, 4], [7, 4]]) set(x, 3, z, 'glowstone', undefined, 'pod light');
  for (const b of beds) set(b.head.x, b.head.y, b.head.z, 'bed', { direction: 0, head_piece_bit: true }, 'bed (foot placed with it)');
  // Light in the platform and the room: nothing hostile spawns, and a golem is not picky.
  set(4, 7, 8, 'glowstone', undefined, 'platform light');
  set(5, 7, 9, 'glowstone', undefined, 'platform light');
  set(5, 6, 12, 'glowstone', undefined, 'room light');

  // The kill corner and the collection.
  set(KILL.x, KILL.y - 1, KILL.z, 'hopper', { facing_direction: 3 }, 'hopper under the corner, to the south');
  set(KILL.x, KILL.y - 1, KILL.z + 1, 'hopper', { facing_direction: 3 }, 'second hopper, to the south');
  set(CHEST.x, CHEST.y, CHEST.z, 'chest', undefined, 'chest');
  for (const [x, y, z] of [[KILL.x - 1, KILL.y + 2, KILL.z], [KILL.x, KILL.y + 2, KILL.z - 1], [KILL.x, KILL.y + 1, KILL.z]]) {
    set(x, y, z, 'crimson_fence_gate', { open_bit: true }, 'open gate holding the lava (not wood that burns)');
  }
  set(KILL.x, KILL.y + 2, KILL.z, 'lava', undefined, 'the lava source, at head height of what stands in the corner');
  set(SOURCE.x, SOURCE.y, SOURCE.z, 'water', undefined, 'the water source (the only one)');

  return { ops, beds, stations, villagers, cube, centre: { x: cx, y: cy, z: cz }, centres: [c1, c2] };
}

// ---------- the plan as a grid, and what can be checked about it ----------

/** Apply the plan's ops to a map "x,y,z" -> { id, states } (anything outside the cube is air). */
export function render(plan) {
  const g = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (const o of plan.ops) {
    if (o.op === 'fill') {
      for (let x = o.box.x1; x <= o.box.x2; x++) for (let y = o.box.y1; y <= o.box.y2; y++) for (let z = o.box.z1; z <= o.box.z2; z++) g.set(key(x, y, z), { id: o.id });
    } else {
      g.set(key(o.x, o.y, o.z), { id: o.id, states: o.states });
      if (o.id === 'bed' && o.states?.head_piece_bit) g.set(key(o.x, o.y, o.z - 1), { id: 'bed', states: { direction: 0, head_piece_bit: false } });
    }
  }
  return { at: (x, y, z) => g.get(key(x, y, z)), id: (x, y, z) => g.get(key(x, y, z))?.id ?? 'air', cells: g };
}

const SOLID = new Set(['stone', 'glowstone', 'composter', 'glass']);
export const passable = (id) => id === 'air' || id === 'water' || id === 'crimson_fence_gate';
export const solid = (id) => SOLID.has(id);

/** The free spots a golem could spawn on inside the spawn volume round the centre: solid floor, three free blocks (feet cell and two above). */
export function golemSpots(grid, centre) {
  const out = [];
  const V = SPAWN_VOLUME;
  for (let x = centre.x - V.rx; x <= centre.x + V.rx; x++) for (let y = centre.y - V.ry; y <= centre.y + V.ry; y++) for (let z = centre.z - V.rz; z <= centre.z + V.rz; z++) {
    if (!solid(grid.id(x, y - 1, z))) continue;
    if (passable(grid.id(x, y, z)) && passable(grid.id(x, y + 1, z)) && passable(grid.id(x, y + 2, z))) out.push({ x, y, z });
  }
  return out;
}

/** How the water spreads from the sources over one layer: Map "x,z" -> level (0 = a source, up to 7), horizontally, through free cells. */
export function waterField(grid, sources, y) {
  const lv = new Map();
  const q = [];
  for (const s of sources) { lv.set(`${s.x},${s.z}`, 0); q.push([s.x, s.z, 0]); }
  for (let i = 0; i < q.length; i++) {
    const [x, z, l] = q[i];
    if (l >= 7) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, k = `${nx},${nz}`;
      if (lv.has(k) || !passable(grid.id(nx, y, nz)) || grid.id(nx, y, nz) === 'crimson_fence_gate') continue;
      lv.set(k, l + 1); q.push([nx, nz, l + 1]);
    }
  }
  return lv;
}

/** Everything that should hold about the plan; returns the list of what does not. */
export function checkPlan(plan) {
  const bad = [];
  const g = render(plan);
  const id = g.id;
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
  // Every cell of the pod is open air, bed, or a workstation, with a roof; and it is two high (nothing a golem could stand in).
  for (let x = POD.x1; x <= POD.x2; x++) for (let z = POD.z1; z <= POD.z2; z++) {
    const roof = id(x, 3, z);
    if (!solid(roof)) bad.push(`pod roof missing at ${x},${z}`);
  }
  // Centre against the platform: every platform cell inside the volume round either reading of the centre, with a block to spare.
  for (const c of plan.centres) {
    for (let x = PLATFORM.x1; x <= PLATFORM.x2; x++) for (let z = PLATFORM.z1; z <= PLATFORM.z2; z++) for (let y = PLATFORM.y1; y <= PLATFORM.y2; y++) {
      if (Math.abs(x - c.x) > SPAWN_VOLUME.rx - 1 || Math.abs(z - c.z) > SPAWN_VOLUME.rz - 1 || Math.abs(y - c.y) > SPAWN_VOLUME.ry - 1) bad.push(`platform cell ${x},${y},${z} too far from the centre ${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}`);
    }
  }
  const cb = plan.cube, cc = plan.centre;
  for (const [lo, hi, v, need, n] of [[cb.x1, cb.x2, cc.x, SPAWN_VOLUME.rx + SAFETY.x, 'x'], [cb.y1, cb.y2, cc.y, SPAWN_VOLUME.ry + SAFETY.y, 'y'], [cb.z1, cb.z2, cc.z, SPAWN_VOLUME.rz + SAFETY.z, 'z']]) {
    if (v - lo < need || hi - v < need) bad.push(`the solid block is not wide enough round the centre on ${n}`);
  }
  for (const o of plan.ops) {
    const pts = o.op === 'set' ? [[o.x, o.y, o.z]] : [[o.box.x1, o.box.y1, o.box.z1], [o.box.x2, o.box.y2, o.box.z2]];
    for (const [x, y, z] of pts) if (x < cb.x1 || x > cb.x2 || y < cb.y1 || y > cb.y2 || z < cb.z1 || z > cb.z2) bad.push(`${o.id} at ${x},${y},${z} is outside the solid block`);
  }
  // The only place a golem can spawn is the platform (and enough of it).
  for (const c of plan.centres) {
    const spots = golemSpots(g, { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) });
    const stray = spots.filter((p) => !(p.x >= PLATFORM.x1 && p.x <= PLATFORM.x2 && p.z >= PLATFORM.z1 && p.z <= PLATFORM.z2 && p.y === PLATFORM.y1));
    if (stray.length) bad.push(`golems could also spawn at ${stray.slice(0, 3).map((p) => `${p.x},${p.y},${p.z}`).join(' ')} (${stray.length} spots)`);
    if (spots.length < 12) bad.push(`only ${spots.length} spawn spots on the platform`);
  }
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
  // The lava: every side is stone or an open gate, never air or water, and it touches no water.
  const L = { x: KILL.x, y: KILL.y + 2, z: KILL.z };
  if (id(L.x, L.y, L.z) !== 'lava') bad.push('no lava');
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
    const n = g.at(L.x + dx, L.y + dy, L.z + dz);
    const ok = n && (n.id === 'stone' || (n.id === 'crimson_fence_gate' && n.states?.open_bit === true));
    if (!ok) bad.push(`lava has ${n?.id ?? 'air'} beside it at ${dx},${dy},${dz}`);
    if (n?.id === 'water') bad.push('lava touches water');
  }
  // The collection: a hopper under the corner pointing south, a second behind it, a chest at the end of them; the chest is in reach of the viewer.
  const h1 = g.at(KILL.x, KILL.y - 1, KILL.z), h2 = g.at(KILL.x, KILL.y - 1, KILL.z + 1), ch = g.at(CHEST.x, CHEST.y, CHEST.z);
  if (h1?.id !== 'hopper' || h1.states?.facing_direction !== 3) bad.push('the hopper under the corner does not point south');
  if (h2?.id !== 'hopper' || h2.states?.facing_direction !== 3) bad.push('the second hopper does not point south');
  if (ch?.id !== 'chest' || CHEST.z !== KILL.z + 2 || CHEST.x !== KILL.x || CHEST.y !== KILL.y - 1) bad.push('the chest is not at the end of the hoppers');
  if (id(STAND.x | 0, STAND.y, STAND.z | 0) !== 'air' || id(STAND.x | 0, STAND.y + 1, STAND.z | 0) !== 'air' || !solid(id(STAND.x | 0, STAND.y - 1, STAND.z | 0))) bad.push('the viewer has no room to stand');
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
