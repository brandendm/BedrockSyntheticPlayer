// Everything that should hold about the iron farm plan (core/ironfarm.js): returns the list of what does not. Pure; tests/ironfarm.test.js runs
// it on the plan and then breaks the plan in each way to see that the check notices.
import {
  PLATFORM, CORNERS, HOLE, POD, SHAFT, ROOM, DOOR, STEP, LAVA, CAMPFIRES, HOPPERS, CHESTS, CHEST_FACING, STAND, SIGNS, SLAB, DOOR_ID, ALLOWED,
  WATER_Y, FLOOR_Y, HOLE_CENTRE, ROOM_SHELL, signSupport, waterSources, opBox, inBox,
} from './ironfarm_geo.js';
import {
  SPAWN_VOLUME, render, passable, solid, outsideAir, exposedTops, golemSpots, waterField, drift, lightField, walkable,
} from './ironfarm_grid.js';

const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
const onPlatformFloor = (x, y, z) => y === FLOOR_Y && x >= PLATFORM.x1 && x <= PLATFORM.x2 && z >= PLATFORM.z1 && z <= PLATFORM.z2;
const isCorner = (x, z) => CORNERS.some(([a, b]) => a === x && b === z);
const isHole = (x, z) => x >= HOLE.x1 && x <= HOLE.x2 && z >= HOLE.z1 && z <= HOLE.z2;

/** Both blocks the game might take a fractional centre to. */
const centreBlocks = (c) => {
  const out = [];
  for (const x of new Set([Math.floor(c.x), Math.ceil(c.x)])) for (const y of new Set([Math.floor(c.y), Math.ceil(c.y)])) for (const z of new Set([Math.floor(c.z), Math.ceil(c.z)])) out.push({ x, y, z });
  return out;
};

export const MAX_COBBLE = 1400;
export const MIN_SPOTS = 200;

export function checkPlan(plan) {
  const bad = [];
  const g = render(plan);
  const id = g.id;
  const bb = plan.bounds;

  // Nothing from the Nether (or anywhere a survival player has not been yet).
  for (const v of g.cells.values()) if (!ALLOWED.includes(v.id)) bad.push(`${v.id} is not an overworld, pre-Nether material`);
  for (const o of plan.ops) if (!ALLOWED.includes(o.id)) bad.push(`${o.id} is not an overworld, pre-Nether material`);

  // The village: 20 whole beds, 10 workstations, 10 villagers with room, all of them able to walk to a bed and a workstation.
  if (plan.beds.length < 20) bad.push(`${plan.beds.length} beds, 20 needed`);
  if (plan.stations.length < 10) bad.push(`${plan.stations.length} workstations, 10 needed`);
  if (plan.villagers.length < 10) bad.push(`${plan.villagers.length} villagers, 10 needed`);
  for (const b of plan.beds) if (id(b.head.x, b.head.y, b.head.z) !== 'bed' || id(b.foot.x, b.foot.y, b.foot.z) !== 'bed') bad.push(`bed at ${b.head.x},${b.head.z} is not whole`);
  const bedCells = new Set(plan.beds.flatMap((b) => [b.head, b.foot]).map((p) => `${p.x},${p.y},${p.z}`));
  if (bedCells.size !== plan.beds.length * 2) bad.push('two beds overlap');
  for (const s of plan.stations) if (id(s.x, s.y, s.z) !== 'composter') bad.push(`no composter at ${s.x},${s.z}`);
  const cells = plan.villagers.map((v) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) }));
  for (const c of cells) if (!passable(id(c.x, c.y, c.z)) || !passable(id(c.x, c.y + 1, c.z))) bad.push(`villager at ${c.x},${c.z} has no room`);
  if (cells.length) {
    const reach = walkable(g, cells[0].y, cells[0]);
    for (const c of cells) if (!reach.has(`${c.x},${c.z}`)) bad.push(`villager at ${c.x},${c.z} cannot walk to the others`);
    const beside = (p) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => reach.has(`${p.x + dx},${p.z + dz}`));
    for (const b of plan.beds) if (!beside(b.head) && !beside(b.foot)) bad.push(`nobody can walk up to the bed at ${b.head.x},${b.head.z}`);
    for (const s of plan.stations) if (!beside(s)) bad.push(`nobody can walk up to the composter at ${s.x},${s.z}`);
  }

  // Every cell of the pod has a roof and a floor (the shaft goes through the floor, not the roof), and the pod is two high.
  for (let x = POD.x1; x <= POD.x2; x++) for (let z = POD.z1; z <= POD.z2; z++) {
    if (!solid(id(x, POD.y2 + 1, z)) && !isHole(x, z)) bad.push(`pod roof missing at ${x},${z}`);
    const inShaft = x >= SHAFT.x1 && x <= SHAFT.x2 && z >= SHAFT.z1 && z <= SHAFT.z2;
    if (!solid(id(x, POD.y1 - 1, z)) && !inShaft) bad.push(`pod floor missing at ${x},${z}`);
  }

  // Light where things could spawn in the dark: torches stand on blocks; every free cell of the pod, the room and the shaft gets some.
  const torches = [...g.cells].filter(([, v]) => v.id === 'torch').map(([k]) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; });
  if (torches.length < 6) bad.push(`${torches.length} torches`);
  for (const t of torches) if (!solid(id(t.x, t.y - 1, t.z))) bad.push(`torch at ${t.x},${t.y},${t.z} has no block under it`);
  const light = lightField(g, [...torches, { ...LAVA, level: 15 }]);
  for (const r of [POD, ROOM, SHAFT]) for (let x = r.x1; x <= r.x2; x++) for (let y = r.y1; y <= r.y2; y++) for (let z = r.z1; z <= r.z2; z++) {
    if (!passable(id(x, y, z))) continue;
    if ((light.get(`${x},${y},${z}`) ?? 0) < 1) bad.push(`no light at ${x},${y},${z}`);
  }

  // Centre against the platform: every platform cell inside the volume round either reading of the centre, whichever block the game rounds to.
  for (const c of plan.centres) for (const k of centreBlocks(c)) {
    for (let x = PLATFORM.x1; x <= PLATFORM.x2; x++) for (let z = PLATFORM.z1; z <= PLATFORM.z2; z++) {
      if (Math.abs(x - k.x) > SPAWN_VOLUME.rx || Math.abs(z - k.z) > SPAWN_VOLUME.rz) bad.push(`platform cell ${x},${z} is outside the volume round the centre ${k.x},${k.y},${k.z}`);
    }
    if (Math.abs(WATER_Y - k.y) > SPAWN_VOLUME.ry) bad.push(`the platform is too far above or below the centre ${k.x},${k.y},${k.z}`);
  }
  for (const o of plan.ops) {
    const q = opBox(o);
    if (q.x1 < bb.x1 || q.x2 > bb.x2 || q.y1 < bb.y1 || q.y2 > bb.y2 || q.z1 < bb.z1 || q.z2 > bb.z2) bad.push(`${o.id} is outside the farm's bounds`);
  }

  // Sealed: no air inside the pod, the room or the shaft is reachable from outside (a hole would let the water, the villagers or the lava out, and mobs in).
  const out = outsideAir(g, bb);
  for (const r of [POD, ROOM, SHAFT]) for (let x = r.x1; x <= r.x2; x++) for (let y = r.y1; y <= r.y2; y++) for (let z = r.z1; z <= r.z2; z++) {
    if (out.has(`${x},${y},${z}`)) bad.push(`the shell has a hole: ${x},${y},${z} is open to the outside`);
  }

  // The platform: 16 x 16, open to the sky, so its walls hold the water and the golems in: solid all round, three high from the floor (a golem climbs one
  // block, not three), the floor under it all (but the hole), the four corners solid.
  if (PLATFORM.x2 - PLATFORM.x1 + 1 !== 16 || PLATFORM.z2 - PLATFORM.z1 + 1 !== 16) bad.push('the platform is not 16 x 16');
  if (PLATFORM.y2 - PLATFORM.y1 + 1 < 3) bad.push('the platform walls are less than three high: a golem could climb out');
  for (let x = PLATFORM.x1 - 1; x <= PLATFORM.x2 + 1; x++) for (let z = PLATFORM.z1 - 1; z <= PLATFORM.z2 + 1; z++) {
    const inside = x >= PLATFORM.x1 && x <= PLATFORM.x2 && z >= PLATFORM.z1 && z <= PLATFORM.z2;
    for (let y = PLATFORM.y1; y <= PLATFORM.y2; y++) {
      if ((!inside || isCorner(x, z)) && !solid(id(x, y, z))) bad.push(`the platform wall has a gap at ${x},${y},${z}`);
    }
    if (!isHole(x, z) && !solid(id(x, FLOOR_Y, z))) bad.push(`the platform floor has a gap at ${x},${z}`);
  }
  for (const s of SIGNS.filter((q) => q.group === 'hole')) {
    const n = g.at(s.x, s.y, s.z);
    if (n?.id !== 'wall_sign') bad.push(`no sign over the shaft at ${s.x},${s.z}: the water would run down it`);
  }

  // Hollow, not a block: how much of the farm's box is solid.
  const boxCells = (bb.x2 - bb.x1 + 1) * (bb.y2 - bb.y1 + 1) * (bb.z2 - bb.z1 + 1);
  const blocks = [...g.cells.values()].filter((v) => v.id === 'cobblestone').length;
  if (blocks > boxCells * 0.4) bad.push(`${blocks} cobblestone in a box of ${boxCells}: that is a lump, not a shell`);
  if (blocks > MAX_COBBLE) bad.push(`${blocks} cobblestone is more than a survival player wants to place`);

  // The only place a golem can spawn is the platform (and plenty of it).
  for (const c of plan.centres) for (const k of centreBlocks(c)) {
    const spots = golemSpots(g, k);
    const onPlat = (p) => p.y === WATER_Y && p.x >= PLATFORM.x1 && p.x <= PLATFORM.x2 && p.z >= PLATFORM.z1 && p.z <= PLATFORM.z2;
    const stray = spots.filter((p) => !onPlat(p));
    if (stray.length) bad.push(`golems could also spawn at ${stray.slice(0, 3).map((p) => `${p.x},${p.y},${p.z}`).join(' ')} (${stray.length} spots)`);
    if (spots.length - stray.length < MIN_SPOTS) bad.push(`only ${spots.length - stray.length} spawn spots on the platform (${MIN_SPOTS} wanted)`);
  }
  const bare = exposedTops(g, bb, onPlatformFloor);
  if (bare.length) bad.push(`${bare.length} bare tops outside (first ${bare[0].x},${bare[0].y},${bare[0].z}): a golem could stand there`);

  // Water: the sources are the platform's edge rows; the field they make reaches every cell, deepest (level 7) in the hole; and a thing drifting
  // with the push of it, from anywhere on the platform, ends up in the middle of the hole.
  const sources = waterSources();
  for (const s of sources) if (id(s.x, WATER_Y, s.z) !== 'water') bad.push(`no water source at ${s.x},${s.z}`);
  const lv = waterField(g, sources, WATER_Y);
  for (let x = PLATFORM.x1; x <= PLATFORM.x2; x++) for (let z = PLATFORM.z1; z <= PLATFORM.z2; z++) {
    if (isCorner(x, z)) continue;
    const l = lv.get(`${x},${z}`);
    if (l === undefined) { bad.push(`no water at ${x},${z}`); continue; }
    if (isHole(x, z) && l !== 7) bad.push(`the hole is level ${l} at ${x},${z}, not 7: the water would not run into it`);
  }
  let lost = 0;
  for (const [k] of lv) {
    const [x, z] = k.split(',').map(Number);
    for (const [ox, oz] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
      const r = drift(lv, x + ox, z + oz, HOLE_CENTRE.x, HOLE_CENTRE.z);
      if (!r.arrived && lost++ < 3) bad.push(`something at ${x + ox},${z + oz} on the platform would not drift to the hole: ${r.why} at ${r.x.toFixed(1)},${r.z.toFixed(1)}`);
    }
  }
  if (lost > 3) bad.push(`${lost} starting points in all would not drift to the hole`);

  // The lava: every side is cobblestone or a wall sign hanging on a block, never air or water (above it is the open shaft: a source does not run up).
  if (id(LAVA.x, LAVA.y, LAVA.z) !== 'lava') bad.push('no lava');
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const q = { x: LAVA.x + dx, y: LAVA.y + dy, z: LAVA.z + dz };
    const n = g.at(q.x, q.y, q.z);
    let ok = n?.id === 'cobblestone' || (dy === 1 && !n);
    if (n?.id === 'wall_sign') {
      const off = signSupport(n.states?.facing_direction);
      ok = !!off && solid(id(q.x + off[0], q.y, q.z + off[1]));
      if (!ok) bad.push(`the sign at ${dx},${dy},${dz} from the lava has nothing behind it to hang on`);
    }
    if (!ok && n?.id !== 'wall_sign') bad.push(`lava has ${n?.id ?? 'air'} beside it at ${dx},${dy},${dz}`);
    if (n?.id === 'water') bad.push('lava touches water');
  }
  for (const [k, v] of g.cells) if (v.id === 'water') { const y = Number(k.split(',')[1]); if (y !== WATER_Y) bad.push(`water at ${k}: only the platform has water`); }
  if (LAVA.y - 2 < SHAFT.y1) bad.push('the lava is too low in the chamber');
  for (const s of SIGNS.filter((q) => q.group === 'lava')) {
    const n = g.at(s.x, s.y, s.z);
    if (n?.id !== 'wall_sign') bad.push(`no sign at ${s.x},${s.y},${s.z} to hold the lava`);
  }

  // The campfires: lit, on the chamber's floor, each over a hopper.
  for (const c of CAMPFIRES) {
    if (id(c.x, c.y, c.z) !== 'campfire') bad.push(`no campfire at ${c.x},${c.y},${c.z}`);
    if (id(c.x, c.y - 1, c.z) !== 'hopper') bad.push(`the campfire at ${c.x},${c.z} is not over a hopper`);
    if (g.at(c.x, c.y, c.z)?.states?.extinguished) bad.push('a campfire is put out');
  }

  // Nothing but campfires and air on the chamber floor over the hoppers (a slab there would stop the items reaching them).
  for (let x = SHAFT.x1; x <= SHAFT.x2; x++) for (let z = SHAFT.z1; z <= SHAFT.z2; z++) {
    const f = id(x, SHAFT.y1, z);
    if (f !== 'air' && f !== 'campfire') bad.push(`the chamber floor has ${f} at ${x},${z}`);
  }

  // The collection: a hopper under each of the chamber's four cells, every hopper leading on to a chest, the chests side by side and facing the same way,
  // with room over them to open, in reach of the viewer.
  for (let x = SHAFT.x1; x <= SHAFT.x2; x++) for (let z = SHAFT.z1; z <= SHAFT.z2; z++) if (id(x, SHAFT.y1 - 1, z) !== 'hopper') bad.push(`no hopper under the chamber at ${x},${z}`);
  const FACE = { 2: [0, -1], 3: [0, 1], 4: [-1, 0], 5: [1, 0] };
  for (const h of HOPPERS) {
    const here = g.at(h.x, h.y, h.z);
    if (here?.id !== 'hopper' || here.states?.facing_direction !== h.facing) { bad.push(`hopper at ${h.x},${h.z} is missing or points the wrong way`); continue; }
    let { x, z } = h, hops = 0;
    while (id(x, h.y, z) === 'hopper' && hops++ < 10) { const f = FACE[g.at(x, h.y, z).states.facing_direction]; if (!f) break; x += f[0]; z += f[1]; }
    if (id(x, h.y, z) !== 'chest') bad.push(`the hopper at ${h.x},${h.z} does not lead to a chest (ends at ${x},${z})`);
  }
  const [c1, c2] = CHESTS;
  if (c2.x !== c1.x + 1 || c2.z !== c1.z || c2.y !== c1.y) bad.push('the two chests are not side by side');
  for (const c of CHESTS) {
    const ch = g.at(c.x, c.y, c.z);
    if (ch?.id !== 'chest') bad.push(`no chest at ${c.x},${c.y},${c.z}`);
    else if (ch.states?.['minecraft:cardinal_direction'] !== CHEST_FACING) bad.push('the chests do not face the same way: they would not make a double chest');
    if (id(c.x, c.y + 1, c.z) !== 'air') bad.push(`something is on top of the chest at ${c.x},${c.z}`);
    const reach = Math.hypot(STAND.x - (c.x + 0.5), STAND.y + 1.62 - (c.y + 0.5), STAND.z - (c.z + 0.5));
    if (reach > 3.5) bad.push(`the chest at ${c.x},${c.z} is ${reach.toFixed(1)} blocks from the viewer's eyes`);
  }

  // The room and the way in: the viewer has room to stand, a window onto the chamber, a door in the room's outer wall with a step up to it.
  const sx = Math.floor(STAND.x), sz = Math.floor(STAND.z);
  if (id(sx, STAND.y, sz) !== 'air' || id(sx, STAND.y + 1, sz) !== 'air' || !solid(id(sx, STAND.y - 1, sz))) bad.push('the viewer has no room to stand');
  if (!inBox(ROOM, sx, STAND.y, sz)) bad.push('the viewer is not in the room');
  for (const [x, y, z] of [[9, -6, 7], [9, -5, 8], [9, -4, 7]]) if (id(x, y, z) !== 'glass') bad.push(`no window at ${x},${y},${z}`);
  const lower = g.at(DOOR.x, DOOR.y, DOOR.z), upper = g.at(DOOR.x, DOOR.y + 1, DOOR.z);
  if (lower?.id !== DOOR_ID || upper?.id !== DOOR_ID || lower.states?.upper_block_bit !== false || upper.states?.upper_block_bit !== true) bad.push('no door (both halves) in the room wall');
  if (DOOR.x !== ROOM_SHELL.x2) bad.push('the door is not in the room\'s outer wall');
  if (id(DOOR.x - 1, DOOR.y, DOOR.z) !== 'air' || id(DOOR.x - 1, DOOR.y + 1, DOOR.z) !== 'air') bad.push('nothing to walk onto inside the door');
  if (id(STEP.x, STEP.y, STEP.z) !== SLAB) bad.push('no step outside the door');
  if (id(DOOR.x + 1, DOOR.y, DOOR.z) !== 'air' || id(DOOR.x + 1, DOOR.y + 1, DOOR.z) !== 'air') bad.push('the door opens onto something');
  return bad;
}
