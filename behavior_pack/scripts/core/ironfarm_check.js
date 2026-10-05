// Everything that should hold about the iron farm plan (core/ironfarm.js): returns the list of what does not. Pure; tests/ironfarm.test.js runs
// it on the plan and then breaks the plan in each way to see that the check notices.
import {
  PLATFORM, CORNERS, HOLE, POD, SHAFT, HALL, CHAMBER, ROOM, DOOR, STEP, CAMPFIRES, LAVA, CHAMBER_WATER, CHAMBER_WET, CHAMBER_FLOOR_Y, GATES, GATE_ID,
  HOPPERS, CHESTS, CHEST_FACING, STAIR, STAIR_ID, STAND, SIGNS, SLAB, SHELLS, DOOR_ID, ALLOWED, WATER_Y, FLOOR_Y, ROOM_SHELL, signSupport, waterSources, opBox, inBox,
} from './ironfarm_geo.js';
import {
  SPAWN_VOLUME, render, passable, solid, outsideAir, exposedTops, golemSpots, settleWater, pushBox, supported, lightField, walkable,
} from './ironfarm_grid.js';

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

/**
 * Every problem with the plan, as a list of sentences ([] when there is none). `deep` (the default) also moves a golem and drops through the water from
 * thousands of starting points (pushBox): that takes half a second in Node and far longer in the game's own script engine, which kills a script that
 * runs ten seconds (u212 hung on it in the game), so game/ironfarm.js asks for `{ deep: false }` and the tests and tools/sim_ironfarm.mjs ask for all of it.
 * @param {any} plan @param {{ deep?: boolean }} [opts]
 */
export function checkPlan(plan, { deep = true } = {}) {
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
  const fires = [...g.cells].filter(([, v]) => v.id === 'campfire' && !v.states?.extinguished).map(([k]) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z, level: 15 }; });
  const lavas = [...g.cells].filter(([, v]) => v.id === 'lava').map(([k]) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z, level: 15 }; });
  const light = lightField(g, [...torches, ...fires, ...lavas]);
  for (const r of [POD, ROOM, SHAFT, HALL]) for (let x = r.x1; x <= r.x2; x++) for (let y = r.y1; y <= r.y2; y++) for (let z = r.z1; z <= r.z2; z++) {
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

  // Sealed: no air inside the pod, the room, the shaft or the hallway is reachable from outside (a hole would let the water, the villagers or the lava out, and mobs in).
  const out = outsideAir(g, bb);
  for (const r of [POD, ROOM, SHAFT, HALL]) for (let x = r.x1; x <= r.x2; x++) for (let y = r.y1; y <= r.y2; y++) for (let z = r.z1; z <= r.z2; z++) {
    if (out.has(`${x},${y},${z}`)) bad.push(`the shell has a hole: ${x},${y},${z} is open to the outside`);
  }

  // The platform: 16 x 16, open to the sky, so its walls hold the water and the golems in: solid all round, three high from the floor (a golem climbs one
  // block, not three), the floor under it all (but the hole), the four 2 x 2 corners solid.
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
  // The gates: one open fence gate over each cell of the hole, at the water layer. Open: a golem walks through; water does not go in, so every
  // current on the platform ends at the hole instead of meeting over it.
  if (GATES.length !== 4) bad.push(`${GATES.length} gates listed, 4 wanted`);
  for (let x = HOLE.x1; x <= HOLE.x2; x++) for (let z = HOLE.z1; z <= HOLE.z2; z++) {
    const n = g.at(x, WATER_Y, z);
    if (n?.id !== GATE_ID) bad.push(`no fence gate over the hole at ${x},${z} (${n?.id ?? 'air'})`);
    else if (n.states?.open_bit !== true) bad.push(`the gate over the hole at ${x},${z} is shut: it would stop the golems`);
  }
  // Every sign, of any group, hangs on a full block.
  for (const s of SIGNS) {
    const n = g.at(s.x, s.y, s.z), off = signSupport(s.facing);
    if (n?.id !== 'wall_sign') bad.push(`no sign at ${s.x},${s.y},${s.z} (${s.group})`);
    else if (!off || !solid(id(s.x + off[0], s.y, s.z + off[1]))) bad.push(`the ${s.group} sign at ${s.x},${s.y},${s.z} has nothing behind it to hang on`);
  }

  // Hollow, not a block: how much of the farm's box is solid.
  const boxCells = (bb.x2 - bb.x1 + 1) * (bb.y2 - bb.y1 + 1) * (bb.z2 - bb.z1 + 1);
  const blocks = [...g.cells.values()].filter((v) => SHELLS.includes(v.id)).length;
  if (blocks > boxCells * 0.4) bad.push(`${blocks} blocks of shell in a box of ${boxCells}: that is a lump, not a shell`);
  if (blocks > MAX_COBBLE) bad.push(`${blocks} blocks of shell is more than a survival player wants to place`);
  if (plan.shell && !SHELLS.includes(plan.shell)) bad.push(`${plan.shell} is not a shell material`);

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

  // Water: the sources are the middle of the platform's edge rows. Bedrock turns a flowing cell that touches two sources into a source (u209 had a ring
  // of sources and the whole platform went still), so first settle that rule: nothing may be converted. Then the field they make reaches every cell but
  // the hole (the gates keep it out, so its rim is level 6), and a golem pushed by it (a 1.4-wide box, the way the game pushes things), from anywhere
  // on the platform, ends up with nothing under it: over the hole, where it falls.
  const planned = waterSources();
  for (const s of planned) if (id(s.x, WATER_Y, s.z) !== 'water') bad.push(`no water source at ${s.x},${s.z}`);
  // (Every water block the plan lays on the platform layer is a source, the planned ones or not: all of them go into the rule.)
  const sources = [...planned];
  const seen = new Set(planned.map((q) => `${q.x},${q.z}`));
  for (const [k, v] of g.cells) {
    if (v.id !== 'water') continue;
    const [x, y, z] = k.split(',').map(Number);
    if (y === WATER_Y && !seen.has(`${x},${z}`)) { seen.add(`${x},${z}`); sources.push({ x, z }); }
  }
  const settled = settleWater(g, sources, WATER_Y);
  if (settled.converted.length) {
    bad.push(`${settled.converted.length} water cells would turn into sources (each touches two), first ${settled.converted.slice(0, 3).map((c) => `${c.x},${c.z}`).join(' ')}: the platform would go still`);
  }
  const lv = settled.field;
  for (let x = PLATFORM.x1; x <= PLATFORM.x2; x++) for (let z = PLATFORM.z1; z <= PLATFORM.z2; z++) {
    if (isCorner(x, z)) continue;
    const l = lv.get(`${x},${z}`);
    if (isHole(x, z)) { if (l !== undefined) bad.push(`water over the hole at ${x},${z}: the gate does not keep it out`); continue; }
    if (l === undefined) bad.push(`no water at ${x},${z}`);
  }
  let lost = 0;
  for (const [k] of deep ? lv : []) {
    const [x, z] = k.split(',').map(Number);
    for (const [ox, oz] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) {
      const r = pushBox(g, lv, WATER_Y, x + ox, z + oz);
      if ((r.wet || supported(g, WATER_Y, r.x, r.z)) && lost++ < 3) bad.push(`a golem at ${x + ox},${z + oz} on the platform would not be carried into the hole: ${r.wet ? r.why : 'it stops on the floor'} at ${r.x.toFixed(2)},${r.z.toFixed(2)}`);
    }
  }
  if (lost > 3) bad.push(`${lost} starting points in all would not be carried into the hole`);
  for (const [k, v] of g.cells) {
    if (v.id !== 'water') continue;
    const [x, y, z] = k.split(',').map(Number);
    if (y !== WATER_Y && !(x === CHAMBER_WATER.x && y === CHAMBER_WATER.y && z === CHAMBER_WATER.z)) bad.push(`water at ${k}: only the platform and the hallway's one source have water`);
  }

  // The hallway's water: one source, nothing it makes turns into a source, and it wets exactly the cells it should (the campfires in the east column
  // stop it there, so it runs along the north wall to the cell beside the first campfire and nowhere else).
  const csrc = [...g.cells].filter(([k, v]) => v.id === 'water' && Number(k.split(',')[1]) === CHAMBER_FLOOR_Y).map(([k]) => { const [x, , z] = k.split(',').map(Number); return { x, z }; });
  if (csrc.length !== 1 || csrc[0].x !== CHAMBER_WATER.x || csrc[0].z !== CHAMBER_WATER.z) bad.push(`the hallway has ${csrc.length} water sources, 1 wanted at ${CHAMBER_WATER.x},${CHAMBER_WATER.z}`);
  const cset = settleWater(g, csrc, CHAMBER_FLOOR_Y);
  if (cset.converted.length) bad.push('the hallway water would turn into more sources');
  const clv = cset.field;
  const want = new Map(CHAMBER_WET.map((q) => [`${q.x},${q.z}`, q.level]));
  for (const [k, l] of want) if (clv.get(k) !== l) bad.push(`the hallway cell ${k} is ${clv.has(k) ? `level ${clv.get(k)}` : 'dry'}, wanted level ${l}`);
  for (const [k] of clv) if (!want.has(k)) bad.push(`the hallway water reaches ${k}, which should stay dry`);
  for (const c of CAMPFIRES) if (id(c.x, CHAMBER_FLOOR_Y, c.z) !== 'campfire') bad.push(`water reaches the campfire's cell at ${c.x},${c.z} (there is no campfire in it to stop it)`);

  // The golem in the hallway: it lands anywhere inside the shaft's foot (its box is 1.4 wide in a 2-wide shaft, so its middle is between 7.7 and 8.3),
  // is pushed by that water, and must end up held against the north-east corner with its middle over the first campfire, its box over the lava and
  // over the second campfire as well.
  const fire = CAMPFIRES[0];
  const overlap = (r, c) => Math.max(0, Math.min(r.x + 0.7, c.x + 1) - Math.max(r.x - 0.7, c.x)) * Math.max(0, Math.min(r.z + 0.7, c.z + 1) - Math.max(r.z - 0.7, c.z));
  let off = 0, noLava = 0, oneFire = 0;
  for (let a = 0; a <= (deep ? 6 : -1); a++) for (let b = 0; b <= 6; b++) {
    const r = pushBox(g, clv, CHAMBER_FLOOR_Y, HOLE.x1 + 0.7 + a * 0.1, HOLE.z1 + 0.7 + b * 0.1, { tall: 4 });
    if (Math.floor(r.x) !== fire.x || Math.floor(r.z) !== fire.z) { if (off++ < 3) bad.push(`a golem landing at ${(HOLE.x1 + 0.7 + a * 0.1).toFixed(1)},${(HOLE.z1 + 0.7 + b * 0.1).toFixed(1)} ends at ${r.x.toFixed(2)},${r.z.toFixed(2)}, not in the first campfire's cell (${r.why})`); }
    if (Math.floor(r.x - 0.7 + 1e-6) > LAVA.x || Math.floor(r.x + 0.7 - 1e-6) < LAVA.x || Math.floor(r.z - 0.7 + 1e-6) > LAVA.z || Math.floor(r.z + 0.7 - 1e-6) < LAVA.z) noLava++;
    if (CAMPFIRES.some((c) => overlap(r, c) < 0.2)) oneFire++;
  }
  if (off > 3) bad.push(`${off} of 49 landing spots end outside the first campfire's cell`);
  if (noLava) bad.push(`${noLava} of 49 landing spots leave the golem's box beside the lava`);
  if (oneFire) bad.push(`${oneFire} of 49 landing spots leave the golem's box off one of the two campfires`);
  // Drops (an item is a 0.25 box, dropped at the golem's feet and pushed the same way) end over a hopper wherever in the hallway they start.
  let lostItems = 0;
  for (let x = CHAMBER.x1; x <= CHAMBER.x2; x++) for (let z = CHAMBER.z1; z <= CHAMBER.z2; z++) for (const [ox, oz] of deep ? [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]] : []) {
    const r = pushBox(g, clv, CHAMBER_FLOOR_Y, x + ox, z + oz, { half: 0.125, tall: 1 });
    let on = false;
    for (let i = Math.floor(r.x - 0.125 + 1e-6); i <= Math.floor(r.x + 0.125 - 1e-6); i++) for (let j = Math.floor(r.z - 0.125 + 1e-6); j <= Math.floor(r.z + 0.125 - 1e-6); j++) if (id(i, CHAMBER_FLOOR_Y - 1, j) === 'hopper') on = true;
    if (!on && lostItems++ < 3) bad.push(`something dropped at ${x + ox},${z + oz} in the hallway ends at ${r.x.toFixed(2)},${r.z.toFixed(2)}, not over a hopper`);
  }
  if (lostItems > 3) bad.push(`${lostItems} dropped items in all would not reach a hopper`);

  // The lava: at the head height of what stands on the floor (its box is 2.9 high: lava from two blocks up is in its head), directly over the first campfire,
  // every side shell, glass or a wall sign that hangs on something (above it is the open hallway: a source does not run up).
  if (id(LAVA.x, LAVA.y, LAVA.z) !== 'lava') bad.push('no lava');
  if (LAVA.y - CHAMBER_FLOOR_Y < 2) bad.push('the lava is below the golem\'s head');
  if (LAVA.y - CHAMBER_FLOOR_Y > 2) bad.push('the lava is above the golem\'s head');
  if (LAVA.x !== fire.x || LAVA.z !== fire.z) bad.push('the lava is not over the first campfire');
  if ([...g.cells.values()].filter((v) => v.id === 'lava').length !== 1) bad.push('more than one lava block');
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
    const q = { x: LAVA.x + dx, y: LAVA.y + dy, z: LAVA.z + dz };
    const n = g.at(q.x, q.y, q.z);
    if (n?.id === 'wall_sign') {
      const off = signSupport(n.states?.facing_direction);
      if (!off || !solid(id(q.x + off[0], q.y, q.z + off[1]))) bad.push(`the sign at ${dx},${dy},${dz} from the lava has nothing behind it to hang on`);
    } else if (!(n && (SHELLS.includes(n.id) || n.id === 'glass'))) bad.push(`lava has ${n?.id ?? 'air'} beside it at ${dx},${dy},${dz}`);
  }
  const above = id(LAVA.x, LAVA.y + 1, LAVA.z);
  if (above === 'water') bad.push('water over the lava');
  for (const s of SIGNS.filter((q) => q.group === 'lava')) if (g.at(s.x, s.y, s.z)?.id !== 'wall_sign') bad.push(`no sign at ${s.x},${s.y},${s.z} to hold the lava`);
  // Headroom: a golem standing on the campfire (7/16 up) is 3.3 high: the four layers over every cell of the hallway's east half are clear (but for the lava and its signs).
  for (let x = HALL.x1; x <= HALL.x2; x++) for (let y = HALL.y1; y <= HALL.y2; y++) for (let z = HALL.z1; z <= HALL.z2; z++) {
    const here = id(x, y, z);
    if (SHELLS.includes(here) || here === 'glass' || here === 'hopper') bad.push(`the hallway is blocked at ${x},${y},${z} (${here})`);
  }

  // The campfires: TWO, lit, side by side in the hallway's east column (the first in the north-east corner, under the lava), each over a hopper; none
  // anywhere else (one on the floor of the rest of the hallway would be in the water's way).
  const fireCells = [...g.cells].filter(([, v]) => v.id === 'campfire').map(([k, v]) => ({ k, v }));
  if (fireCells.length !== 2) bad.push(`${fireCells.length} campfires in the plan, 2 wanted`);
  if (CAMPFIRES.length !== 2) bad.push(`${CAMPFIRES.length} campfires listed, 2 wanted`);
  if (CAMPFIRES.length === 2 && (CAMPFIRES[0].x !== CAMPFIRES[1].x || Math.abs(CAMPFIRES[0].z - CAMPFIRES[1].z) !== 1)) bad.push('the two campfires are not side by side');
  for (const c of CAMPFIRES) {
    if (id(c.x, c.y, c.z) !== 'campfire') bad.push(`no campfire at ${c.x},${c.y},${c.z}`);
    if (id(c.x, c.y - 1, c.z) !== 'hopper') bad.push(`the campfire at ${c.x},${c.z} is not over a hopper`);
    if (g.at(c.x, c.y, c.z)?.states?.extinguished) bad.push('the campfire is put out');
  }
  // Nothing in the shaft above the floor but air (and the one sign that holds the lava): a golem falls to the floor, and what drops can reach a hopper.
  // Water never comes down.
  for (let x = SHAFT.x1; x <= SHAFT.x2; x++) for (let z = SHAFT.z1; z <= SHAFT.z2; z++) for (let y = SHAFT.y1 + 1; y <= SHAFT.y2; y++) {
    const listed = SIGNS.some((q) => q.x === x && q.y === y && q.z === z);
    if (id(x, y, z) !== 'air' && !(listed && id(x, y, z) === 'wall_sign')) bad.push(`the shaft is not clear at ${x},${y},${z} (${id(x, y, z)})`);
  }

  // The collection: a hopper under each campfire (the drops reach the others by the water: the item sim above), every hopper leading on to a chest, no
  // other hopper, the chests side by side and facing the same way, with room over them to open, in reach of the viewer.
  const hopperCells = [...g.cells].filter(([, v]) => v.id === 'hopper').length;
  if (hopperCells !== HOPPERS.length) bad.push(`${hopperCells} hoppers in the plan, ${HOPPERS.length} listed`);
  if (HOPPERS.length !== 2) bad.push(`${HOPPERS.length} hoppers listed, 2 wanted (one under each campfire)`);
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
    // (Air over it, or the upside-down stair: a chest opens under either.)
    const top = g.at(c.x, c.y + 1, c.z);
    const stairOk = c.x === STAIR.x && c.y + 1 === STAIR.y && c.z === STAIR.z && top?.id === STAIR_ID && top.states?.upside_down_bit === true;
    if (id(c.x, c.y + 1, c.z) !== 'air' && !stairOk) bad.push(`something is on top of the chest at ${c.x},${c.z} that it would not open under`);
    const reach = Math.hypot(STAND.x - (c.x + 0.5), STAND.y + 1.62 - (c.y + 0.5), STAND.z - (c.z + 0.5));
    if (reach > 3.5) bad.push(`the chest at ${c.x},${c.z} is ${reach.toFixed(1)} blocks from the viewer's eyes`);
  }

  // The room and the way in: the viewer has room to stand, a window onto the hallway, a door in the room's outer wall with a step up to it.
  const sx = Math.floor(STAND.x), sz = Math.floor(STAND.z);
  if (id(sx, STAND.y, sz) !== 'air' || id(sx, STAND.y + 1, sz) !== 'air' || !solid(id(sx, STAND.y - 1, sz))) bad.push('the viewer has no room to stand');
  if (!inBox(ROOM, sx, STAND.y, sz)) bad.push('the viewer is not in the room');
  for (const [x, y, z] of [[10, -6, 8], [10, -5, 8], [10, -4, 7]]) if (id(x, y, z) !== 'glass') bad.push(`no window at ${x},${y},${z}`);
  if (g.at(STAIR.x, STAIR.y, STAIR.z)?.id !== STAIR_ID) bad.push('no upside-down stair over the first chest');
  const lower = g.at(DOOR.x, DOOR.y, DOOR.z), upper = g.at(DOOR.x, DOOR.y + 1, DOOR.z);
  if (lower?.id !== DOOR_ID || upper?.id !== DOOR_ID || lower.states?.upper_block_bit !== false || upper.states?.upper_block_bit !== true) bad.push('no door (both halves) in the room wall');
  if (DOOR.x !== ROOM_SHELL.x2) bad.push('the door is not in the room\'s outer wall');
  if (id(DOOR.x - 1, DOOR.y, DOOR.z) !== 'air' || id(DOOR.x - 1, DOOR.y + 1, DOOR.z) !== 'air') bad.push('nothing to walk onto inside the door');
  if (id(STEP.x, STEP.y, STEP.z) !== SLAB) bad.push('no step outside the door');
  if (id(DOOR.x + 1, DOOR.y, DOOR.z) !== 'air' || id(DOOR.x + 1, DOOR.y + 1, DOOR.z) !== 'air') bad.push('the door opens onto something');
  return bad;
}
