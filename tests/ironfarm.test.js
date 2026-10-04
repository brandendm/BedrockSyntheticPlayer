import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ironFarmPlan, checkPlan, render, golemSpots, waterField, settleWater, waterSources, flowAt, drift, lightField, blockArg, villageCentre, materials, exposedTops,
  outsideAir, signSupport, SIGNS, PLATFORM, POD, SPAWN_VOLUME, ALLOWED, SLAB, HOPPERS, CHESTS, CAMPFIRES, DOOR, STEP, HOLE, HOLE_CENTRE, WATER_Y,
  FLOOR_Y, CORNERS,
} from '../behavior_pack/scripts/core/ironfarm.js';
import { MAX_COBBLE as MAX, MIN_SPOTS } from '../behavior_pack/scripts/core/ironfarm_check.js';

const without = (p, pred) => { p.ops = p.ops.filter((o) => !pred(o)); return p; };
const put = (p, x, y, z, id, states) => { p.ops.push({ op: 'set', x, y, z, id, states, note: 'test' }); return p; };
const carve = (p, x1, y1, z1, x2, y2, z2, id = 'air') => { p.ops.push({ op: 'fill', box: { x1, y1, z1, x2, y2, z2 }, id, note: 'test' }); return p; };
const caught = (p, re) => { const bad = checkPlan(p); assert.ok(bad.some((x) => re.test(x)), `${re} not in: ${bad.slice(0, 4).join('; ')}`); };

test('the plan holds together: nothing for checkPlan to complain about', () => {
  assert.deepEqual(checkPlan(ironFarmPlan()), []);
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
  assert.ok(ALLOWED.includes('campfire') && ALLOWED.includes('wooden_door'));
});

test('the shopping list is something a survival player can meet: counted from the plan', () => {
  const m = materials(ironFarmPlan());
  assert.equal(m.counts.bed, 20);
  assert.equal(m.counts.composter, 10);
  assert.equal(m.counts.hopper, 5);
  assert.equal(m.counts.chest, 2);
  assert.equal(m.counts.campfire, 4);
  assert.equal(m.counts.wooden_door, 1);
  assert.equal(m.counts.wall_sign, 4);
  assert.equal(m.counts.lava, undefined);
  assert.equal(m.counts.water, waterSources().length);
  assert.ok(m.counts.cobblestone_slab > 80 && m.counts.cobblestone_slab < 200, `${m.counts.cobblestone_slab} slabs`);
  assert.match(m.text, /20 beds/);
  assert.match(m.text, /a water bucket \(48 water sources/);
  assert.doesNotMatch(m.text, /lava/);
  assert.match(m.text, /double chest/);
  assert.match(m.text, /4 campfires/);
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

test('the pod, the room and the shaft are lit (torches on blocks; the campfires light the chamber), and without the torches the check says where it is dark', () => {
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

test('water: sources on the middle of each edge give level = distance from the edge, 7 over the hole, and the game turns none of the flowing cells into sources; a thing in it drifts to the middle of the hole from anywhere', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(waterSources().length, 48);
  for (const s of waterSources()) assert.ok(s.x >= 2 && s.x <= 13 && s.z >= 2 && s.z <= 13 || ((s.x === 0 || s.x === 15) && s.z >= 2 && s.z <= 13) || ((s.z === 0 || s.z === 15) && s.x >= 2 && s.x <= 13));
  const settled = settleWater(g, waterSources(), WATER_Y);
  assert.deepEqual(settled.converted, [], 'cells would turn into sources');
  assert.equal(settled.sources.length, 48);
  const lv = settled.field;
  assert.deepEqual([...lv].sort(), [...waterField(g, waterSources(), WATER_Y)].sort());
  assert.equal(lv.size, 240);
  for (let x = 0; x <= 15; x++) for (let z = 0; z <= 15; z++) {
    if (CORNERS.some(([a, b]) => a === x && b === z)) { assert.equal(lv.has(`${x},${z}`), false); continue; }
    assert.equal(lv.get(`${x},${z}`), Math.min(x, z, 15 - x, 15 - z), `${x},${z}`);
  }
  for (let x = 7; x <= 8; x++) for (let z = 7; z <= 8; z++) assert.equal(lv.get(`${x},${z}`), 7);
  // The push at (3, 8) is straight east; on the diagonal it is diagonal; in the hole cells it points at the middle of the hole.
  const e = flowAt(lv, 3, 8);
  assert.ok(e.x > 0 && Math.abs(e.z) < 1e-9);
  const d = flowAt(lv, 3, 3);
  assert.ok(d.x > 0 && Math.abs(d.x - d.z) < 1e-9);
  const h = flowAt(lv, 7, 7);
  assert.ok(h.x > 0 && h.z > 0);
  for (const [k] of lv) {
    const [x, z] = k.split(',').map(Number);
    for (const [ox, oz] of [[0.5, 0.5], [0.1, 0.9], [0.9, 0.1], [0.2, 0.2], [0.8, 0.8]]) {
      const r = drift(lv, x + ox, z + oz, HOLE_CENTRE.x, HOLE_CENTRE.z);
      assert.ok(r.arrived, `from ${x + ox},${z + oz}: ${r.why} at ${r.x.toFixed(2)},${r.z.toFixed(2)}`);
    }
  }
  // A corner left open (no solid corner) would be a cell to get stuck in; a missing source row does not reach the hole.
  caught(carve(ironFarmPlan(), 0, 4, 0, 0, 6, 0), /the platform wall has a gap at 0,/);
  caught(carve(ironFarmPlan(), 1, 4, 1, 1, 6, 1), /the platform wall has a gap at 1,/);
  caught(without(ironFarmPlan(), (o) => o.tag === 'water' && o.box.z1 === 15 && o.box.z2 === 15), /no water source/);
});

test('u209\'s ring of 56 sources, with a single solid corner cell, turns the WHOLE platform into sources under the game\'s rule (a flowing cell touching two sources becomes one): still water, no current', () => {
  const base = render(ironFarmPlan());
  // The old corners: only (0,0), (15,0), (0,15), (15,15) solid; the rest of each 2 x 2 open.
  const old = { id: (x, y, z) => ((y === WATER_Y || y === 5 || y === 6) && [[1, 0], [0, 1], [1, 1], [14, 0], [15, 1], [14, 1], [0, 14], [1, 14], [1, 15], [14, 15], [15, 14], [14, 14]].some(([a, b]) => a === x && b === z) ? 'air' : base.id(x, y, z)) };
  const ring = [];
  for (let i = 1; i <= 14; i++) ring.push({ x: i, z: 0 }, { x: i, z: 15 }, { x: 0, z: i }, { x: 15, z: i });
  const r = settleWater(old, ring, WATER_Y);
  assert.equal(ring.length, 56);
  assert.equal(r.converted.length, 192, 'every other cell of the platform but the four over the hole');
  assert.equal(r.field.size, 252);
  // Every cell is a source (level 0) but the four over the hole (level 1, nothing solid under them): no gradient, so nothing to carry a golem to the hole.
  const levels = [...r.field.values()];
  assert.equal(levels.filter((l) => l === 0).length, 248);
  for (let x = 7; x <= 8; x++) for (let z = 7; z <= 8; z++) assert.equal(r.field.get(`${x},${z}`), 1);
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
  assert.ok(lv.size < 240 && !lv.has('14,14'));
  const r = drift(lv, 14.5, 14.5, HOLE_CENTRE.x, HOLE_CENTRE.z);
  assert.equal(r.arrived, false);
});

test('there is no lava anywhere (a mob that dies in or beside lava can lose its drops), and one put in is caught; water is only on the platform', () => {
  const g = render(ironFarmPlan());
  assert.ok(![...g.cells.values()].some((v) => v.id === 'lava'));
  assert.ok(!ALLOWED.includes('lava'));
  assert.ok(SIGNS.every((s) => s.group === 'hole'));
  caught(put(ironFarmPlan(), 7, -4, 7, 'lava'), /lava in the plan/);
  caught(put(ironFarmPlan(), 7, -5, 8, 'water'), /only the platform has water/);
});

test('the signs are placed before the campfires and the campfires before the water, so a sign that will not stay can stop the water going in', () => {
  const p = ironFarmPlan();
  const at = (tag) => p.ops.findIndex((o) => o.tag === tag);
  assert.ok(at('sign') >= 0 && at('sign') < at('slab') && at('campfire') > at('slab') && at('campfire') < at('water'));
  assert.equal(p.ops.filter((o) => o.tag === 'sign').length, 4);
  assert.equal(p.ops.filter((o) => o.tag === 'lava').length, 0);
  assert.equal(p.ops.filter((o) => o.tag === 'water').length, 4);
  assert.deepEqual(p.ops.filter((o) => o.tag === 'sign').map((o) => o.states.facing_direction), SIGNS.map((s) => s.facing));
});

test('campfires: a lit one on each of the chamber\'s four floor cells, each over a hopper, nothing in the shaft above them', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(CAMPFIRES.length, 4);
  assert.deepEqual(CAMPFIRES.map((c) => `${c.x},${c.z}`).sort(), ['7,7', '7,8', '8,7', '8,8']);
  for (const c of CAMPFIRES) { assert.equal(c.y, -6); assert.equal(g.id(c.x, c.y, c.z), 'campfire'); assert.equal(g.id(c.x, c.y - 1, c.z), 'hopper'); assert.equal(g.at(c.x, c.y, c.z).states?.extinguished, undefined); }
  for (let y = -5; y <= 2; y++) for (const [x, z] of [[7, 7], [8, 7], [7, 8], [8, 8]]) assert.equal(g.id(x, y, z), 'air', `${x},${y},${z}`);
  caught(without(ironFarmPlan(), (o) => o.id === 'campfire' && o.x === 7 && o.z === 7), /no campfire/);
  caught(without(ironFarmPlan(), (o) => o.id === 'campfire'), /no campfire/);
  caught(put(ironFarmPlan(), 8, -6, 8, SLAB), /chamber floor/);
  caught(put(ironFarmPlan(), 7, -3, 8, 'cobblestone'), /the shaft is not clear/);
  const off = ironFarmPlan();
  off.ops.find((o) => o.id === 'campfire').states = { extinguished: true };
  caught(off, /put out/);
  // Lit campfires light the chamber (15), and the light gets into the room through the glass.
  const lit = lightField(g, [...CAMPFIRES.map((c) => ({ ...c, level: 15 }))]);
  assert.equal(lit.get('7,-6,7'), 15);
  assert.ok(lit.get('7,-5,7') === 14 && (lit.get('10,-6,7') ?? 0) > 8);
});

test('the hoppers run under the chamber and east into the chests, which are a double chest: side by side, the same way round, room to open, in reach', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(HOPPERS.length, 5);
  for (const h of HOPPERS) assert.equal(g.at(h.x, h.y, h.z).states.facing_direction, h.facing);
  assert.equal(CHESTS.length, 2);
  assert.equal(CHESTS[1].x, CHESTS[0].x + 1);
  const dirs = CHESTS.map((c) => g.at(c.x, c.y, c.z).states['minecraft:cardinal_direction']);
  assert.equal(dirs[0], dirs[1]);
  caught((() => { const q = ironFarmPlan(); q.ops.find((o) => o.id === 'chest' && o.x === 11).states = { 'minecraft:cardinal_direction': 'north' }; return q; })(), /would not make a double chest/);
  caught((() => { const q = ironFarmPlan(); q.ops.find((o) => o.id === 'hopper' && o.x === 8 && o.z === 7).states = { facing_direction: 4 }; return q; })(), /does not lead to a chest/);
  caught(put(ironFarmPlan(), 10, -6, 7, 'cobblestone'), /something is on top of the chest/);
  caught(without(ironFarmPlan(), (o) => o.id === 'hopper' && o.x === 7 && o.z === 8), /no hopper under the chamber|hopper at 7,8/);
});

test('a way in: a door in the room\'s outer wall (both halves), a step up to it, a window onto the chamber; without the door the check says so', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(g.id(DOOR.x, DOOR.y, DOOR.z), 'wooden_door');
  assert.equal(g.at(DOOR.x, DOOR.y, DOOR.z).states.upper_block_bit, false);
  assert.equal(g.at(DOOR.x, DOOR.y + 1, DOOR.z).states.upper_block_bit, true);
  assert.equal(g.at(DOOR.x, DOOR.y, DOOR.z).states.direction, g.at(DOOR.x, DOOR.y + 1, DOOR.z).states.direction);
  assert.equal(g.id(STEP.x, STEP.y, STEP.z), SLAB);
  assert.equal(g.id(9, -6, 7), 'glass');
  assert.equal(g.id(9, -4, 8), 'glass');
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
