import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ironFarmPlan, checkPlan, render, golemSpots, waterField, settleWater, waterSources, flowAt, drift, pushBox, supported, lightField, blockArg, villageCentre,
  materials, exposedTops, outsideAir, signSupport, SIGNS, PLATFORM, POD, SPAWN_VOLUME, ALLOWED, SLAB, HOPPERS, CHESTS, CAMPFIRES, DOOR, STEP, HOLE,
  HOLE_CENTRE, WATER_Y, FLOOR_Y, CORNERS, GATES, GATE_ID, LAVA, CHAMBER_WATER, CHAMBER_WET, CHAMBER, HALL, CHAMBER_FLOOR_Y,
} from '../behavior_pack/scripts/core/ironfarm.js';
import { MAX_COBBLE as MAX, MIN_SPOTS } from '../behavior_pack/scripts/core/ironfarm_check.js';

const without = (p, pred) => { p.ops = p.ops.filter((o) => !pred(o)); return p; };
const put = (p, x, y, z, id, states) => { p.ops.push({ op: 'set', x, y, z, id, states, note: 'test' }); return p; };
const carve = (p, x1, y1, z1, x2, y2, z2, id = 'air') => { p.ops.push({ op: 'fill', box: { x1, y1, z1, x2, y2, z2 }, id, note: 'test' }); return p; };
const caught = (p, re) => { const bad = checkPlan(p); assert.ok(bad.some((x) => re.test(x)), `${re} not in: ${bad.slice(0, 4).join('; ')}`); };

test('the plan holds together: nothing for checkPlan to complain about (all of it, and the quick form the game runs)', () => {
  assert.deepEqual(checkPlan(ironFarmPlan()), []);
  assert.deepEqual(checkPlan(ironFarmPlan(), { deep: false }), []);
  assert.ok(MAX >= 1200 && MAX <= 2000);
});

test('it is a hollow tower, not a lump: about a thousand cobblestone, nothing like the 13,000-block cube it was', () => {
  const p = ironFarmPlan();
  const m = materials(p);
  assert.ok(m.counts.cobblestone > 700 && m.counts.cobblestone < MAX, `${m.counts.cobblestone} cobblestone`);
  const b = p.bounds;
  const cells = (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) * (b.z2 - b.z1 + 1);
  assert.ok(m.counts.cobblestone < cells * 0.4);
  const lump = ironFarmPlan();
  lump.ops.unshift({ op: 'fill', box: b, id: 'cobblestone', note: 'solid' });
  assert.ok(checkPlan(lump).some((x) => /lump|more than a survival player/.test(x)));
});

test('it is made of overworld things only: nothing from the Nether, and a Nether block put in is caught', () => {
  const p = ironFarmPlan();
  const g = render(p);
  for (const id of new Set([...g.cells.values()].map((v) => v.id))) assert.ok(ALLOWED.includes(id), id);
  for (const o of p.ops) assert.ok(!/crimson|warped|nether|glowstone|blackstone|basalt|soul|shroom|quartz|magma|ancient|netherite/.test(o.id), o.id);
  caught(put(ironFarmPlan(), 4, 1, 3, 'glowstone'), /glowstone is not an overworld/);
  caught(put(ironFarmPlan(), 5, 6, 10, 'crimson_fence_gate'), /crimson_fence_gate is not an overworld/);
  assert.ok(ALLOWED.includes('campfire') && ALLOWED.includes('wooden_door') && ALLOWED.includes('fence_gate') && ALLOWED.includes('lava'));
});

test('the shopping list is something a survival player can meet: counted from the plan', () => {
  const m = materials(ironFarmPlan());
  assert.equal(m.counts.bed, 20);
  assert.equal(m.counts.composter, 10);
  assert.equal(m.counts.hopper, 3);
  assert.equal(m.counts.chest, 2);
  assert.equal(m.counts.campfire, 2);
  assert.equal(m.counts.wooden_door, 1);
  assert.equal(m.counts.wall_sign, 7);
  assert.equal(m.counts.fence_gate, 4);
  assert.equal(m.counts.lava, 1);
  assert.equal(m.counts.water, waterSources().length + 1);
  assert.ok(m.counts.cobblestone_slab > 80 && m.counts.cobblestone_slab < 200, `${m.counts.cobblestone_slab} slabs`);
  assert.match(m.text, /20 beds/);
  assert.match(m.text, /a lava bucket \(one source\) and a water bucket \(48 water sources/);
  assert.match(m.text, /double chest/);
  assert.match(m.text, /2 campfires/);
  assert.match(m.text, /3 hoppers \(5 iron each = 15 iron\)/);
  assert.match(m.text, /4 fence gates/);
  assert.match(m.text, /7 signs/);
});

test('the village: 20 whole beds in two rows, 10 composters, 10 villagers with room, all able to walk to a bed and a workstation', () => {
  const p = ironFarmPlan();
  assert.equal(p.beds.length, 20);
  assert.equal(p.stations.length, 10);
  assert.equal(p.villagers.length, 10);
  const g = render(p);
  for (const b of p.beds) { assert.equal(g.id(b.head.x, b.head.y, b.head.z), 'bed'); assert.equal(g.id(b.foot.x, b.foot.y, b.foot.z), 'bed'); }
  assert.equal(new Set(p.beds.map((b) => b.head.z)).size, 2);
  // Block the north aisle off from the rest of the pod and the check sees villagers who cannot get anywhere.
  const walled = ironFarmPlan();
  carve(walled, 2, 1, 3, 13, 2, 3, 'cobblestone');
  carve(walled, 2, 1, 2, 2, 2, 2, 'air');
  assert.ok(checkPlan(walled).some((b) => /cannot walk|nobody can walk/.test(b)), checkPlan(walled).slice(0, 3).join('; '));
});

test('a bed is set at its head with direction 0: the foot is one block north of it (what the bot learned in the game)', () => {
  const p = ironFarmPlan();
  const o = p.ops.find((q) => q.id === 'bed');
  assert.deepEqual(o.states, { direction: 0, head_piece_bit: true });
  assert.equal(p.beds[0].foot.z, p.beds[0].head.z - 1);
});

test('the pod, the room and the shaft are lit (torches on blocks; the campfire and the lava light the hallway), and without the torches the check says where it is dark', () => {
  const p = ironFarmPlan();
  const g = render(p);
  const torches = [...g.cells].filter(([, v]) => v.id === 'torch').map(([k]) => k.split(',').map(Number));
  assert.ok(torches.filter(([, y]) => y === 1).length >= 6 && torches.some(([, y]) => y === -6));
  for (const [x, y, z] of torches) assert.equal(g.id(x, y - 1, z), 'cobblestone');
  for (const v of p.villagers) assert.ok(!torches.some(([x, , z]) => x === Math.floor(v.x) && z === Math.floor(v.z)));
  const lv = lightField(g, torches.map(([x, y, z]) => ({ x, y, z })));
  assert.equal(lv.get(`${torches[0][0]},${torches[0][1]},${torches[0][2]}`), 14);
  caught(without(ironFarmPlan(), (o) => o.id === 'torch' && o.y === 1), /torches|no light at/);
});

test('the centre is the average of the beds and workstations, in the middle of the platform: the whole platform is in the volume either way the game rounds it', () => {
  const p = ironFarmPlan();
  const c = villageCentre(p.beds, p.stations);
  assert.ok(Math.abs(c.x - 7.5) < 1e-9 && Math.abs(c.z - 7.5) < 1e-9);
  for (const k of p.centres) {
    for (const bx of [Math.floor(k.x), Math.ceil(k.x)]) for (const bz of [Math.floor(k.z), Math.ceil(k.z)]) {
      for (let x = PLATFORM.x1; x <= PLATFORM.x2; x++) for (let z = PLATFORM.z1; z <= PLATFORM.z2; z++) {
        assert.ok(Math.abs(x - bx) <= SPAWN_VOLUME.rx && Math.abs(z - bz) <= SPAWN_VOLUME.rz, `${x},${z} vs ${bx},${bz}`);
      }
    }
  }
  assert.equal(PLATFORM.x2 - PLATFORM.x1 + 1, 16);
  assert.equal(PLATFORM.z2 - PLATFORM.z1 + 1, 16);
});

test('the golem spawn rule: a full block under, a 2 x 4 x 2 box free over it; the platform has 205 spots, nowhere else has any, and slabs are why', () => {
  const p = ironFarmPlan();
  const g = render(p);
  for (const k of [{ x: 7, y: 1, z: 7 }, { x: 8, y: 1, z: 8 }]) {
    const spots = golemSpots(g, k);
    assert.equal(spots.length, 205);
    for (const s of spots) assert.ok(s.y === WATER_Y && s.x >= 1 && s.x <= 15 && s.z >= 1 && s.z <= 15, `stray spot ${s.x},${s.y},${s.z}`);
    assert.ok(spots.length >= MIN_SPOTS);
  }
  // Another reading of the centre (a bed's pillow at the edge of the beds) still finds well over a hundred on the platform.
  assert.ok(golemSpots(g, { x: 3, y: 1, z: 5 }).length > 100 && golemSpots(g, { x: 12, y: 1, z: 11 }).length > 100);
  assert.deepEqual(exposedTops(g, p.bounds, (x, y, z) => y === FLOOR_Y && x >= 0 && x <= 15 && z >= 0 && z <= 15), []);
  // The 2 x 4 x 2 box: one solid block in it ruins the spot (four feet cells have it in their box); the block's own top is a new spot, off the water.
  const pillar = render(put(ironFarmPlan(), 5, 5, 5, 'cobblestone'));
  const ps = golemSpots(pillar, { x: 7, y: 1, z: 7 });
  assert.equal(ps.filter((s) => s.y === WATER_Y).length, 205 - 4);
  assert.deepEqual(ps.filter((s) => s.y !== WATER_Y), [{ x: 5, y: 6, z: 5 }]);
  caught(put(ironFarmPlan(), 5, 5, 5, 'cobblestone'), /golems could also spawn at 5,6,5/);
  // A slab in the box is not a free box either (and a slab is not something to spawn on).
  const slabbed = render(put(ironFarmPlan(), 5, 5, 5, SLAB));
  assert.equal(golemSpots(slabbed, { x: 7, y: 1, z: 7 }).filter((s) => s.y === WATER_Y).length, 205 - 4);
  assert.equal(golemSpots(slabbed, { x: 7, y: 1, z: 7 }).filter((s) => s.y !== WATER_Y).length, 0);
});

test('without the slabs the tops are places to spawn (the check does see them): this is what the slabs are for', () => {
  const p = without(ironFarmPlan(), (o) => o.tag === 'slab');
  const g = render(p);
  const bare = exposedTops(g, p.bounds, (x, y, z) => y === FLOOR_Y && x >= 0 && x <= 15 && z >= 0 && z <= 15);
  assert.ok(bare.length > 90 && bare.length < 120, `${bare.length} bare tops`);
  caught(p, /golems could also spawn/);
  caught(p, /bare tops/);
  // One slab per bare top, no more, all of the one kind, and the step is one of them.
  const slabbed = ironFarmPlan();
  const n = slabbed.ops.filter((o) => o.tag === 'slab' && o.op === 'fill').reduce((a, o) => a + (o.box.x2 - o.box.x1 + 1), 0);
  assert.equal(n, bare.length);
  assert.ok(slabbed.ops.filter((o) => o.tag === 'slab').every((o) => o.id === SLAB));
  // None of them inside the shaft or the chamber (the chamber floor is hoppers and campfires, not slabs).
  const wet = render(slabbed);
  for (let x = 7; x <= 8; x++) for (let z = 7; z <= 8; z++) for (let y = -6; y <= 2; y++) assert.notEqual(wet.id(x, y, z), SLAB, `slab in the shaft at ${x},${y},${z}`);
  assert.equal(render(slabbed).id(STEP.x, STEP.y, STEP.z), SLAB);
  // The rim of the platform and the room's roof are slabbed.
  const g2 = render(slabbed);
  for (const [x, y, z] of [[-1, 7, 5], [16, 7, 5], [5, 7, -1], [5, 7, 16], [0, 7, 0], [12, -2, 8], [10, -2, 5]]) assert.equal(g2.id(x, y, z), SLAB, `${x},${y},${z}`);
});

test('a pod with a three-high ceiling would be a leak (the check does see one)', () => {
  const p = carve(ironFarmPlan(), 2, 3, 2, 3, 3, 3);
  const bad = checkPlan(p);
  assert.ok(bad.some((b) => /platform floor has a gap|pod roof missing/.test(b)), bad.slice(0, 3).join('; '));
});

test('the pod, the room and the shaft are sealed (a hole in a wall is caught); the platform is open to the sky and its walls and corners are what hold it', () => {
  const p = ironFarmPlan();
  const g = render(p);
  const out = outsideAir(g, p.bounds);
  assert.ok(out.has('-2,0,-2'));
  assert.ok(!out.has('4,1,3'), 'the pod is open to the outside');
  assert.ok(!out.has('11,-5,8'), 'the room is open to the outside');
  assert.ok(!out.has('7,-3,7'), 'the shaft is open to the outside');
  assert.ok(!out.has('9,-5,7') && !out.has('9,-3,8'), 'the hallway is open to the outside');
  assert.ok(out.has('5,6,5') && out.has('5,4,5'), 'the platform is not open from above');
  caught(carve(ironFarmPlan(), 1, 1, 5, 1, 1, 5), /the shell has a hole/);
  caught(carve(ironFarmPlan(), 16, 5, 5, 16, 5, 5), /the platform wall has a gap at 16,5,5/);
  caught(carve(ironFarmPlan(), 3, 3, 3, 3, 3, 3), /the platform floor has a gap at 3,3/);
  caught(carve(ironFarmPlan(), 0, 5, 0, 0, 5, 0), /the platform wall has a gap at 0,5,0/);
  caught(carve(ironFarmPlan(), -1, 6, -1, 16, 6, -1), /the platform wall has a gap at -1,6,-1/);
  assert.equal(PLATFORM.y2 - PLATFORM.y1 + 1, 3);
  assert.equal(CORNERS.length, 16);
  for (const [x, z] of CORNERS) for (let y = 4; y <= 6; y++) assert.equal(g.id(x, y, z), 'cobblestone', `corner ${x},${z}`);
});

test('the hole in the floor is 2 x 2 over the shaft, capped by four wall signs hanging on the floor beside it (water cannot go through a sign)', () => {
  const p = ironFarmPlan();
  const g = render(p);
  const hole = SIGNS.filter((s) => s.group === 'hole');
  assert.equal(hole.length, 4);
  for (const s of hole) {
    assert.equal(g.id(s.x, s.y, s.z), 'wall_sign');
    assert.ok(s.x >= HOLE.x1 && s.x <= HOLE.x2 && s.z >= HOLE.z1 && s.z <= HOLE.z2 && s.y === FLOOR_Y);
    const off = signSupport(s.facing);
    assert.equal(g.id(s.x + off[0], s.y, s.z + off[1]), 'cobblestone', `behind the sign at ${s.x},${s.z}`);
  }
  caught(without(ironFarmPlan(), (o) => o.id === 'wall_sign' && o.y === FLOOR_Y && o.x === 7 && o.z === 7), /no sign over the shaft|the shell has a hole/);
});

test('water: sources on the middle of each edge give level = distance from the edge, the gates keep it out of the hole so the rim is level 6, the game turns none of the flowing cells into sources, and a golem (a 1.4-wide box) is carried into the hole from anywhere', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(waterSources().length, 48);
  for (const s of waterSources()) assert.ok(s.x >= 2 && s.x <= 13 && s.z >= 2 && s.z <= 13 || ((s.x === 0 || s.x === 15) && s.z >= 2 && s.z <= 13) || ((s.z === 0 || s.z === 15) && s.x >= 2 && s.x <= 13));
  const settled = settleWater(g, waterSources(), WATER_Y);
  assert.deepEqual(settled.converted, [], 'cells would turn into sources');
  assert.equal(settled.sources.length, 48);
  const lv = settled.field;
  assert.deepEqual([...lv].sort(), [...waterField(g, waterSources(), WATER_Y)].sort());
  assert.equal(lv.size, 236, '240 cells less the four the gates keep dry');
  for (let x = 0; x <= 15; x++) for (let z = 0; z <= 15; z++) {
    if (CORNERS.some(([a, b]) => a === x && b === z)) { assert.equal(lv.has(`${x},${z}`), false); continue; }
    if (x >= 7 && x <= 8 && z >= 7 && z <= 8) { assert.equal(lv.has(`${x},${z}`), false, `water over the hole at ${x},${z}`); continue; }
    assert.equal(lv.get(`${x},${z}`), Math.min(x, z, 15 - x, 15 - z), `${x},${z}`);
  }
  for (const [x, z] of [[6, 6], [6, 7], [6, 8], [6, 9], [7, 6], [8, 6], [9, 6], [9, 7], [9, 8], [9, 9], [7, 9], [8, 9]]) assert.equal(lv.get(`${x},${z}`), 6, `rim ${x},${z}`);
  // The push at (3, 8) is straight east; on the diagonal it is diagonal; every rim cell points into the hole (a dry neighbour pushes nothing, so nothing cancels).
  const e = flowAt(lv, 3, 8);
  assert.ok(e.x > 0 && Math.abs(e.z) < 1e-9);
  const d = flowAt(lv, 3, 3);
  assert.ok(d.x > 0 && Math.abs(d.x - d.z) < 1e-9);
  assert.ok(flowAt(lv, 6, 7).x > 0 && Math.abs(flowAt(lv, 6, 7).z) < 1e-9);
  assert.ok(flowAt(lv, 9, 8).x < 0 && Math.abs(flowAt(lv, 9, 8).z) < 1e-9);
  assert.ok(flowAt(lv, 8, 6).z > 0 && Math.abs(flowAt(lv, 8, 6).x) < 1e-9);
  assert.ok(flowAt(lv, 6, 6).x > 0 && flowAt(lv, 6, 6).z > 0);
  assert.equal(flowAt(lv, 7, 7), null, 'no water in the hole cells');
  let farthest = 0;
  for (const [k] of lv) {
    const [x, z] = k.split(',').map(Number);
    for (const [ox, oz] of [[0.5, 0.5], [0.1, 0.9], [0.9, 0.1], [0.2, 0.2], [0.8, 0.8]]) {
      const r = pushBox(g, lv, WATER_Y, x + ox, z + oz);
      assert.ok(!r.wet, `from ${x + ox},${z + oz}: ${r.why} at ${r.x.toFixed(2)},${r.z.toFixed(2)}`);
      assert.ok(!supported(g, WATER_Y, r.x, r.z), `from ${x + ox},${z + oz} it stops on the floor at ${r.x.toFixed(2)},${r.z.toFixed(2)}`);
      assert.ok(r.x >= 7.65 && r.x <= 8.35 && r.z >= 7.65 && r.z <= 8.35, `ends at ${r.x},${r.z}`);
      farthest = Math.max(farthest, r.steps);
    }
  }
  assert.ok(farthest * 0.05 < 12, `${farthest * 0.05} blocks is a long way`);
  // A corner left open (no solid corner) would be a cell to get stuck in; a missing source row does not reach the hole.
  caught(carve(ironFarmPlan(), 0, 4, 0, 0, 6, 0), /the platform wall has a gap at 0,/);
  caught(carve(ironFarmPlan(), 1, 4, 1, 1, 6, 1), /the platform wall has a gap at 1,/);
  caught(without(ironFarmPlan(), (o) => o.tag === 'water' && o.box.z1 === 15 && o.box.z2 === 15), /no water source/);
});

test('the gates: an open fence gate over each cell of the hole, at the water layer; without them (or shut) the check sees the currents meet over the hole and the golems held up', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(GATES.length, 4);
  assert.deepEqual(GATES.map((q) => `${q.x},${q.z}`).sort(), ['7,7', '7,8', '8,7', '8,8']);
  for (const q of GATES) {
    assert.equal(q.y, WATER_Y);
    assert.equal(g.id(q.x, q.y, q.z), GATE_ID);
    assert.equal(g.at(q.x, q.y, q.z).states.open_bit, true);
    assert.equal(g.id(q.x, q.y - 1, q.z), 'wall_sign', 'the sign stays under the gate');
  }
  assert.equal(p.ops.filter((o) => o.tag === 'gate').length, 4);
  const noGates = without(ironFarmPlan(), (o) => o.tag === 'gate');
  caught(noGates, /no fence gate over the hole/);
  caught(noGates, /water over the hole/);
  caught(noGates, /would not be carried into the hole/);
  // Without the gates the model reproduces what the player saw in u211: a golem comes to rest over the hole with the water still pushing on it from all sides.
  const lvOld = settleWater(render(noGates), waterSources(), WATER_Y).field;
  assert.equal(lvOld.size, 240);
  const stuck = pushBox(render(noGates), lvOld, WATER_Y, 3.5, 8.5);
  assert.equal(stuck.wet, true);
  caught((() => { const q = ironFarmPlan(); q.ops.find((o) => o.tag === 'gate').states.open_bit = false; return q; })(), /gate over the hole at 7,7 is shut/);
  caught(put(without(ironFarmPlan(), (o) => o.tag === 'gate' && o.x === 8 && o.z === 8), 8, 4, 8, 'cobblestone'), /no fence gate over the hole at 8,8|the platform|spawn/);
  // A gate stops water but not a golem or a villager: it is free for the body and not something to stand on.
  assert.equal(supported(g, WATER_Y, 7.5, 7.5, 0.1), false);
  assert.equal(golemSpots(g, { x: 7, y: 1, z: 7 }).length, 205, 'the gates do not change the spawn spots');
});

test('pushBox: a 1.4-wide box is pushed by the average of the wet cells it overlaps, held by walls, and stops where it overlaps no water', () => {
  // A channel (a row of water levelled 0..4 going east) between walls, with a dry cell at the end.
  const cells = new Map();
  const put1 = (x, z, id) => cells.set(`${x},${z}`, id);
  for (let x = -1; x <= 7; x++) for (let z = -1; z <= 3; z++) put1(x, z, 'cobblestone');
  for (let x = 0; x <= 6; x++) for (let z = 0; z <= 2; z++) put1(x, z, 'air');
  const grid = { id: (x, y, z) => (y >= 4 && y <= 8 ? cells.get(`${x},${z}`) ?? 'air' : y === 3 ? 'cobblestone' : 'air') };
  const lv = new Map();
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 2; z++) lv.set(`${x},${z}`, x);   // level 0 at x 0 (higher water), 4 at x 4
  const r = pushBox(grid, lv, 4, 1.2, 1.5);
  assert.equal(r.wet, false, 'it leaves the water at the east end');
  assert.ok(r.x - 0.7 >= 4.9 && r.x - 0.7 <= 5.1, `left edge at ${r.x - 0.7}`);
  // Held by a wall while the water still pushes: the east end walled in, the water going on to the wall.
  const wall = new Map(lv);
  for (let x = 5; x <= 6; x++) for (let z = 0; z <= 2; z++) wall.set(`${x},${z}`, x);
  const g2 = { id: (x, y, z) => (x >= 7 && y >= 4 ? 'cobblestone' : grid.id(x, y, z)) };
  const held = pushBox(g2, wall, 4, 1.2, 1.5);
  assert.equal(held.rested, true);
  assert.ok(Math.abs(held.x + 0.7 - 7) < 0.06, `pressed against the wall at 7: ${held.x}`);
  // No water at all: nothing happens; a box starting in a wall is put where it fits.
  assert.equal(pushBox(grid, new Map(), 4, 2.5, 1.5).steps, 0);
  assert.ok(pushBox(grid, lv, 4, 0.1, 1.5).x >= 0.7 - 1e-9);
});

test('u209\'s ring of 56 sources, with a single solid corner cell, turns the WHOLE platform into sources under the game\'s rule (a flowing cell touching two sources becomes one): still water, no current', () => {
  const base = render(ironFarmPlan());
  // The old corners: only (0,0), (15,0), (0,15), (15,15) solid; the rest of each 2 x 2 open.
  const old = { id: (x, y, z) => ((y === WATER_Y || y === 5 || y === 6) && [[1, 0], [0, 1], [1, 1], [14, 0], [15, 1], [14, 1], [0, 14], [1, 14], [1, 15], [14, 15], [15, 14], [14, 14]].some(([a, b]) => a === x && b === z) ? 'air' : base.id(x, y, z)) };
  const ring = [];
  for (let i = 1; i <= 14; i++) ring.push({ x: i, z: 0 }, { x: i, z: 15 }, { x: 0, z: i }, { x: 15, z: i });
  const r = settleWater(old, ring, WATER_Y);
  assert.equal(ring.length, 56);
  assert.equal(r.converted.length, 192, 'every other cell of the platform');
  assert.equal(r.field.size, 248);
  // Every cell is a source (level 0): no gradient, so nothing to carry a golem to the hole. (The four over the hole are not wet at all now: the gates.)
  const levels = [...r.field.values()];
  assert.equal(levels.filter((l) => l === 0).length, 248);
  assert.ok(flowAt(r.field, 3, 3).x === 0 || Math.abs(flowAt(r.field, 3, 3).x) < 1e-9, 'a push where all is source');
  // And the new layout's check does notice a source dropped where it makes a neighbour touch two.
  caught(put(ironFarmPlan(), 3, 4, 1, 'water'), /water cells would turn into sources/);
  caught(put(ironFarmPlan(), 2, 4, 1, 'water'), /water cells would turn into sources/);
  // With a 1 x 1 corner and the new rows (2..13) nothing converts, but the corner pocket (1,1) is a dead end: a thing in it is not pushed anywhere.
  const pocket = settleWater(old, waterSources(), WATER_Y);
  assert.deepEqual(pocket.converted, []);
  assert.equal(drift(pocket.field, 1.5, 1.5, HOLE_CENTRE.x, HOLE_CENTRE.z).arrived, false);
});

test('sources on two walls only would leave the far side dry (why there are sources on all four edges)', () => {
  const g = render(ironFarmPlan());
  const lv = waterField(g, waterSources().filter((s) => s.x === 0 || s.z === 0), WATER_Y);
  assert.ok(lv.size < 236 && !lv.has('14,14'));
  const r = drift(lv, 14.5, 14.5, HOLE_CENTRE.x, HOLE_CENTRE.z);
  assert.equal(r.arrived, false);
});

test('the lava: one source over the first campfire at the golem\'s head height, held by three signs, glass to the east and the wall to the north; one that is not held is caught; water is only on the platform and the hallway\'s one source', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal([...g.cells.values()].filter((v) => v.id === 'lava').length, 1);
  assert.equal(g.id(LAVA.x, LAVA.y, LAVA.z), 'lava');
  assert.equal(LAVA.y - CHAMBER_FLOOR_Y, 2, 'two up from the floor: the head of something 2.9 tall');
  assert.deepEqual([LAVA.x, LAVA.z], [CAMPFIRES[0].x, CAMPFIRES[0].z]);
  assert.ok(ALLOWED.includes('lava'));
  assert.deepEqual(SIGNS.map((s) => s.group).sort(), ['hole', 'hole', 'hole', 'hole', 'lava', 'lava', 'lava']);
  const around = [[1, 0, 0, 'glass'], [0, 0, -1, 'cobblestone'], [0, 0, 1, 'wall_sign'], [-1, 0, 0, 'wall_sign'], [0, -1, 0, 'wall_sign']];
  for (const [dx, dy, dz, want] of around) assert.equal(g.id(LAVA.x + dx, LAVA.y + dy, LAVA.z + dz), want, `${dx},${dy},${dz} from the lava`);
  for (const s of SIGNS) { const off = signSupport(s.facing); assert.equal(g.id(s.x + off[0], s.y, s.z + off[1]) !== 'air', true, `behind ${s.group} sign ${s.x},${s.y},${s.z}`); }
  // Not held: a missing sign, lava elsewhere, a second lava, water over it, lava too low or too high.
  caught(without(ironFarmPlan(), (o) => o.tag === 'sign' && o.x === 9 && o.y === -5 && o.z === 7), /lava has air beside it at 0,-1,0|no sign at 9,-5,7/);
  caught(without(ironFarmPlan(), (o) => o.tag === 'sign' && o.x === 8 && o.y === -4 && o.z === 7), /lava has air beside it at -1,0,0|no sign at 8,-4,7/);
  caught(put(ironFarmPlan(), 9, -3, 7, 'lava'), /more than one lava/);
  caught(put(ironFarmPlan(), 9, -3, 7, 'water'), /water over the lava|only the platform/);
  caught(without(ironFarmPlan(), (o) => o.tag === 'lava'), /no lava/);
  const low = ironFarmPlan(); low.ops.find((o) => o.tag === 'lava').y = -5;
  caught(low, /below the golem's head|lava has/);
  const gone = ironFarmPlan(); gone.ops.find((o) => o.tag === 'lava').x = 8;
  caught(gone, /not over the first campfire|lava has/);
  caught(put(ironFarmPlan(), 7, -5, 8, 'water'), /only the platform and the hallway's one source/);
  // Lava gives light: the pod-side and hallway cells are lit even without the campfire.
  const lit = lightField(g, [{ ...LAVA, level: 15 }]);
  assert.equal(lit.get(`${LAVA.x},${LAVA.y},${LAVA.z}`), 15);
});

test('the order of building: signs, then gates and slabs, then lava, campfire and the hallway water, then the platform water; a sign that will not stay can stop the lava and the water going in', () => {
  const p = ironFarmPlan();
  const at = (tag) => p.ops.findIndex((o) => o.tag === tag);
  assert.ok(at('sign') >= 0 && at('sign') < at('gate') && at('gate') < at('slab') && at('lava') > at('slab') && at('campfire') > at('slab'));
  assert.ok(at('cwater') > at('campfire') && at('water') > at('cwater'));
  assert.equal(p.ops.filter((o) => o.tag === 'sign').length, 7);
  assert.equal(p.ops.filter((o) => o.tag === 'lava').length, 1);
  assert.equal(p.ops.filter((o) => o.tag === 'gate').length, 4);
  assert.equal(p.ops.filter((o) => o.tag === 'water').length, 4);
  assert.equal(p.ops.filter((o) => o.tag === 'cwater').length, 1);
  assert.deepEqual(p.ops.filter((o) => o.tag === 'sign').map((o) => o.states.facing_direction), SIGNS.map((s) => s.facing));
});

test('the hallway: one water source in the south-west corner wets three more cells (the two campfires in the east column stop it), and a golem landing anywhere in the shaft is pressed into the north-east corner, in the first campfire\'s cell, with its box in the lava and over the second campfire', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.deepEqual(CHAMBER_WATER, { x: 7, y: -6, z: 8 });
  assert.equal(g.id(CHAMBER_WATER.x, CHAMBER_WATER.y, CHAMBER_WATER.z), 'water');
  const set = settleWater(g, [CHAMBER_WATER], CHAMBER_FLOOR_Y);
  assert.deepEqual(set.converted, []);
  assert.deepEqual([...set.field].sort(), CHAMBER_WET.map((c) => [`${c.x},${c.z}`, c.level]).sort());
  assert.equal(set.field.has('9,7') || set.field.has('9,8'), false, 'the campfires\' cells are dry');
  assert.equal(set.field.get('8,7'), 2, 'the current ends in the cell west of the first campfire');
  const lv = set.field;
  // Flows: every wet cell runs north-east (the source toward the two it feeds, those toward the cell they both feed, which toward the campfire).
  for (const [x, z] of [[7, 8], [7, 7], [8, 8], [8, 7]]) { const f = flowAt(lv, x, z); assert.ok(f.x > 0 && f.z < 0, `flow at ${x},${z}: ${f.x.toFixed(3)} ${f.z.toFixed(3)}`); }
  // Landing anywhere a 1.4-wide box can land in the 2 x 2 shaft (centre between 7.7 and 8.3 each way).
  const ends = [];
  for (let a = 0; a <= 12; a++) for (let b = 0; b <= 12; b++) {
    const sx = 7.7 + a * 0.05, sz = 7.7 + b * 0.05;
    const r = pushBox(g, lv, CHAMBER_FLOOR_Y, sx, sz, { tall: 4 });
    ends.push(r);
    assert.equal(Math.floor(r.x), 9, `from ${sx.toFixed(2)},${sz.toFixed(2)} ends at x ${r.x.toFixed(2)}`);
    assert.equal(Math.floor(r.z), 7, `from ${sx.toFixed(2)},${sz.toFixed(2)} ends at z ${r.z.toFixed(2)}`);
    assert.ok(Math.floor(r.x + 0.7 - 1e-6) >= LAVA.x && Math.floor(r.z - 0.7 + 1e-6) <= LAVA.z && Math.floor(r.z + 0.7 - 1e-6) >= LAVA.z, 'its box is over the lava');
    const second = CAMPFIRES[1];
    const over = Math.max(0, Math.min(r.z + 0.7, second.z + 1) - Math.max(r.z - 0.7, second.z)) * Math.max(0, Math.min(r.x + 0.7, second.x + 1) - Math.max(r.x - 0.7, second.x));
    assert.ok(over > 0.3, `its box is over the second campfire by ${over.toFixed(2)}`);
  }
  assert.ok(Math.max(...ends.map((r) => r.z)) < 7.95, `the south-most it rests is ${Math.max(...ends.map((r) => r.z)).toFixed(2)}: 7.73 in my model`);
  assert.ok(Math.min(...ends.map((r) => r.x)) > 9.2);
  // Drops (0.25 boxes) from anywhere in the hallway end over a hopper.
  const overHopper = (r) => { for (let i = Math.floor(r.x - 0.125 + 1e-6); i <= Math.floor(r.x + 0.125 - 1e-6); i++) for (let j = Math.floor(r.z - 0.125 + 1e-6); j <= Math.floor(r.z + 0.125 - 1e-6); j++) if (g.id(i, -7, j) === 'hopper') return true; return false; };
  for (let x = CHAMBER.x1; x <= CHAMBER.x2; x++) for (let z = CHAMBER.z1; z <= CHAMBER.z2; z++) for (const [ox, oz] of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
    const r = pushBox(g, lv, CHAMBER_FLOOR_Y, x + ox, z + oz, { half: 0.125, tall: 1 });
    assert.ok(overHopper(r), `drop at ${x + ox},${z + oz} ends at ${r.x.toFixed(2)},${r.z.toFixed(2)}`);
  }
  // And what is dropped within 0.6 of where the golem stands (items fly a little when they come out) reaches a hopper too.
  let scattered = 0;
  for (const e of ends.filter((_, i) => i % 7 === 0)) for (let dx = -0.6; dx <= 0.601; dx += 0.15) for (let dz = -0.6; dz <= 0.601; dz += 0.15) {
    const sx = e.x + dx, sz = e.z + dz;
    if (sx < 7 || sx >= 10 || sz < 7 || sz >= 9) continue;
    const r = pushBox(g, lv, CHAMBER_FLOOR_Y, sx, sz, { half: 0.125, tall: 1 });
    scattered++;
    assert.ok(overHopper(r), `a drop at ${sx.toFixed(2)},${sz.toFixed(2)} ends at ${r.x.toFixed(2)},${r.z.toFixed(2)}`);
  }
  assert.ok(scattered > 100, `${scattered} scattered drops tried`);
  // Break it each way and the check says so.
  caught(without(ironFarmPlan(), (o) => o.id === 'campfire' && o.x === 9 && o.z === 8), /the hallway water reaches 9,8/);
  caught(put(ironFarmPlan(), 8, -6, 7, 'wall_sign'), /the hallway cell 8,7 is dry/);
  caught(without(ironFarmPlan(), (o) => o.tag === 'cwater'), /hallway has 0 water sources/);
  caught(put(ironFarmPlan(), 8, -6, 8, 'water'), /hallway has 2 water sources|turn into more sources/);
  const moved = ironFarmPlan(); const w = moved.ops.find((o) => o.tag === 'cwater'); w.x = 7; w.z = 7;
  caught(moved, /hallway has 1 water sources, 1 wanted at 7,8|not in the first campfire's cell|wanted level/);
  caught(put(ironFarmPlan(), 9, -5, 8, 'cobblestone'), /the hallway is blocked at 9,-5,8/);
  caught(put(ironFarmPlan(), 9, -3, 7, 'cobblestone'), /the hallway is blocked at 9,-3,7/);
});

test('without the second campfire\'s hopper what lands on it stays there (the model\'s reading of the three hoppers), and the check says so', () => {
  const q = without(ironFarmPlan(), (o) => o.id === 'hopper' && o.x === 9 && o.z === 8);
  const bad = checkPlan(q);
  assert.ok(bad.some((b) => /hopper/.test(b)), bad.join(' | '));
  assert.ok(bad.some((b) => /not over a hopper|not reach a hopper/.test(b)), bad.join(' | '));
  const g = render(q);
  const lv = settleWater(g, [CHAMBER_WATER], CHAMBER_FLOOR_Y).field;
  let lost = 0;
  for (let dx = -0.6; dx <= 0.601; dx += 0.15) for (let dz = -0.6; dz <= 0.601; dz += 0.15) {
    const sx = 9.28 + dx, sz = 7.72 + dz;
    if (sx >= 10 || sz >= 9) continue;
    const r = pushBox(g, lv, CHAMBER_FLOOR_Y, sx, sz, { half: 0.125, tall: 1 });
    let on = false;
    for (let i = Math.floor(r.x - 0.125 + 1e-6); i <= Math.floor(r.x + 0.125 - 1e-6); i++) for (let j = Math.floor(r.z - 0.125 + 1e-6); j <= Math.floor(r.z + 0.125 - 1e-6); j++) if (g.id(i, -7, j) === 'hopper') on = true;
    if (!on) lost++;
  }
  assert.ok(lost > 0, 'some drops are lost on the second campfire with no hopper under it');
});

test('campfires: TWO, lit, side by side in the hallway\'s east column (the first in the north-east corner), each over a hopper, nothing else on the floor there, the shaft above clear but for the sign that holds the lava', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(CAMPFIRES.length, 2);
  assert.deepEqual(CAMPFIRES.map((c) => `${c.x},${c.z}`), ['9,7', '9,8']);
  for (const c of CAMPFIRES) { assert.equal(c.y, -6); assert.equal(g.id(c.x, c.y, c.z), 'campfire'); assert.equal(g.id(c.x, c.y - 1, c.z), 'hopper'); assert.equal(g.at(c.x, c.y, c.z).states?.extinguished, undefined); }
  for (let y = -5; y <= 2; y++) for (const [x, z] of [[7, 7], [8, 7], [7, 8], [8, 8]]) {
    const id = g.id(x, y, z);
    assert.ok(id === 'air' || (id === 'wall_sign' && SIGNS.some((s) => s.x === x && s.y === y && s.z === z)), `${x},${y},${z} is ${id}`);
  }
  for (let y = -6; y <= -3; y++) for (const z of [7, 8]) assert.notEqual(g.id(9, y, z), 'cobblestone', `hall cell 9,${y},${z}`);
  caught(without(ironFarmPlan(), (o) => o.id === 'campfire'), /no campfire|0 campfires/);
  caught(without(ironFarmPlan(), (o) => o.id === 'campfire' && o.z === 8), /1 campfires in the plan|no campfire/);
  caught(put(ironFarmPlan(), 7, -6, 7, 'campfire'), /3 campfires in the plan/);
  caught(put(ironFarmPlan(), 7, -3, 8, 'cobblestone'), /the shaft is not clear/);
  const off = ironFarmPlan();
  off.ops.find((o) => o.id === 'campfire' && o.z === 8).states = { extinguished: true };
  caught(off, /put out/);
  // Lit, they light the hallway (15), and the light gets into the room through the glass.
  const lit = lightField(g, [...CAMPFIRES.map((c) => ({ ...c, level: 15 }))]);
  assert.equal(lit.get('9,-6,7'), 15);
  assert.equal(lit.get('9,-6,8'), 15);
  assert.ok(lit.get('9,-5,7') === 14 && (lit.get('11,-6,7') ?? 0) > 8);
});

test('three hoppers (the player\'s count): one under each campfire, the south one feeding the north one, which feeds one under the window that runs east into the chests, which are a double chest: side by side, the same way round, room to open, in reach', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(HOPPERS.length, 3);
  assert.equal([...g.cells.values()].filter((v) => v.id === 'hopper').length, 3);
  for (const h of HOPPERS) assert.equal(g.at(h.x, h.y, h.z).states.facing_direction, h.facing);
  for (const c of CAMPFIRES) assert.equal(g.id(c.x, -7, c.z), 'hopper', `under the campfire at ${c.x},${c.z}`);
  assert.deepEqual(HOPPERS.map((h) => `${h.x},${h.z},${h.facing}`), ['9,7,5', '9,8,2', '10,7,5']);
  // Under the four cells of the shaft's foot there is only floor: what lands there is carried to the campfires by the water.
  for (const [x, z] of [[7, 7], [8, 7], [7, 8], [8, 8]]) assert.equal(g.id(x, -7, z), 'cobblestone', `under ${x},${z}`);
  assert.equal(CHESTS.length, 2);
  assert.equal(CHESTS[1].x, CHESTS[0].x + 1);
  const dirs = CHESTS.map((c) => g.at(c.x, c.y, c.z).states['minecraft:cardinal_direction']);
  assert.equal(dirs[0], dirs[1]);
  caught((() => { const q = ironFarmPlan(); q.ops.find((o) => o.id === 'chest' && o.x === 11).states = { 'minecraft:cardinal_direction': 'north' }; return q; })(), /would not make a double chest/);
  caught((() => { const q = ironFarmPlan(); q.ops.find((o) => o.id === 'hopper' && o.x === 9 && o.z === 8).states = { facing_direction: 4 }; return q; })(), /points the wrong way|does not lead to a chest/);
  caught(put(ironFarmPlan(), 11, -6, 7, 'cobblestone'), /something is on top of the chest/);
  caught(without(ironFarmPlan(), (o) => o.id === 'hopper' && o.x === 9 && o.z === 8), /hopper at 9,8|not over a hopper/);
  caught(put(ironFarmPlan(), 8, -7, 7, 'hopper'), /4 hoppers in the plan, 3 listed/);
});

test('a way in: a door in the room\'s outer wall (both halves), a step up to it, a window onto the hallway; without the door the check says so', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(g.id(DOOR.x, DOOR.y, DOOR.z), 'wooden_door');
  assert.equal(g.at(DOOR.x, DOOR.y, DOOR.z).states.upper_block_bit, false);
  assert.equal(g.at(DOOR.x, DOOR.y + 1, DOOR.z).states.upper_block_bit, true);
  assert.equal(g.at(DOOR.x, DOOR.y, DOOR.z).states.direction, g.at(DOOR.x, DOOR.y + 1, DOOR.z).states.direction);
  assert.equal(g.id(STEP.x, STEP.y, STEP.z), SLAB);
  assert.equal(g.id(10, -6, 7), 'glass');
  assert.equal(g.id(10, -4, 8), 'glass');
  assert.equal(HALL.x1, 9);
  caught(without(ironFarmPlan(), (o) => o.tag === 'door'), /no door/);
  caught(without(ironFarmPlan(), (o) => o.tag === 'slab' && o.op === 'set'), /no step/);
});

test('a bigger hole than 2 x 2 is caught (the pod would have no roof round the shaft), and the pod is 12 x 12 inside', () => {
  caught(carve(ironFarmPlan(), 6, 3, 6, 9, 3, 9), /pod roof missing/);
  assert.equal(POD.x2 - POD.x1 + 1, 12);
  assert.equal(POD.z2 - POD.z1 + 1, 12);
});

test('every placement is inside the farm box, which is the tower and the step', () => {
  const p = ironFarmPlan();
  const c = p.bounds;
  for (const o of p.ops) {
    const pts = o.op === 'set' ? [[o.x, o.y, o.z]] : [[o.box.x1, o.box.y1, o.box.z1], [o.box.x2, o.box.y2, o.box.z2]];
    for (const [x, y, z] of pts) assert.ok(x >= c.x1 && x <= c.x2 && y >= c.y1 && y <= c.y2 && z >= c.z1 && z <= c.z2);
  }
  assert.deepEqual([c.x1, c.y1, c.z1, c.x2, c.y2, c.z2], [-1, -7, -1, 16, 7, 16]);
});

test('setblock arguments: states quoted the way the game wants them', () => {
  assert.equal(blockArg('cobblestone'), 'cobblestone');
  assert.equal(blockArg('bed', { direction: 0, head_piece_bit: true }), 'bed ["direction"=0,"head_piece_bit"=true]');
  assert.equal(blockArg('hopper', { facing_direction: 3 }), 'hopper ["facing_direction"=3]');
  assert.equal(blockArg('wall_sign', { facing_direction: 4 }), 'wall_sign ["facing_direction"=4]');
  assert.equal(blockArg('chest', { 'minecraft:cardinal_direction': 'south' }), 'chest ["minecraft:cardinal_direction"="south"]');
  assert.equal(blockArg('x', { a: 'b' }), 'x ["a"="b"]');
});

test('the game builds with the quick check only: the deep one (golems and drops moved through the water from thousands of points) hung the game\'s script engine for 10 s in u212 and the watchdog killed the build', () => {
  const src = readFileSync(new URL('../behavior_pack/scripts/game/ironfarm.js', import.meta.url), 'utf8');
  assert.match(src, /checkPlan\(plan, \{ deep: false \}\)/);
  assert.doesNotMatch(src, /checkPlan\(plan\)/);
  // The quick form still catches what is structural, and leaves out only the moving.
  assert.ok(checkPlan(without(ironFarmPlan(), (o) => o.tag === 'gate'), { deep: false }).some((b) => /no fence gate over the hole/.test(b)));
  assert.ok(checkPlan(without(ironFarmPlan(), (o) => o.id === 'campfire' && o.x === 9 && o.z === 8), { deep: false }).some((b) => /the hallway water reaches 9,8/.test(b)));
  // Nothing else in the game's code walks the water with pushBox or drift.
  for (const f of ['ironfarm.js', 'ironfarm_parts.js', 'ironfarm_aids.js', 'ironfarm_world.js']) {
    const g = readFileSync(new URL(`../behavior_pack/scripts/game/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(g, /pushBox|drift\(/, f);
  }
});
