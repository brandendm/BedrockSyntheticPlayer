import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ironFarmPlan, checkPlan, render, golemSpots, waterField, blockArg, villageCentre, materials, exposedTops, outsideAir, signSupport,
  SOURCE, KILL, LAVA, SIGNS, PLATFORM, POD, SPAWN_VOLUME, ALLOWED, SLAB, SHELLS,
} from '../behavior_pack/scripts/core/ironfarm.js';

const without = (p, pred) => { p.ops = p.ops.filter((o) => !pred(o)); return p; };

test('the plan holds together: nothing for checkPlan to complain about', () => {
  assert.deepEqual(checkPlan(ironFarmPlan()), []);
});

test('it is a hollow shell, not a lump: a few hundred cobblestone round the rooms, nothing like the 13,000-block cube it was', () => {
  const p = ironFarmPlan();
  const m = materials(p);
  assert.ok(m.counts.cobblestone > 300 && m.counts.cobblestone < 600, `${m.counts.cobblestone} cobblestone`);
  assert.ok(m.cobble < 700, `${m.cobble} cobblestone with the slabs`);
  const b = p.bounds;
  const cells = (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) * (b.z2 - b.z1 + 1);
  assert.ok(m.counts.cobblestone < cells * 0.4);
  // The old way of doing it (everything solid first, rooms carved out) is what checkPlan calls a lump.
  const lump = ironFarmPlan();
  lump.ops.unshift({ op: 'fill', box: b, id: 'cobblestone', note: 'solid' });
  assert.ok(checkPlan(lump).some((x) => /lump|more than a survival player/.test(x)), checkPlan(lump).join('; '));
});

test('it is made of overworld things only: no crimson, no glowstone, nothing from the Nether, and a Nether block put in is caught', () => {
  const p = ironFarmPlan();
  const g = render(p);
  const used = new Set([...g.cells.values()].map((v) => v.id));
  for (const id of used) assert.ok(ALLOWED.includes(id), id);
  for (const o of p.ops) assert.ok(!/crimson|warped|nether|glowstone|blackstone|basalt|soul|shroom|quartz|magma|ancient|netherite/.test(o.id), o.id);
  const bad = ironFarmPlan();
  bad.ops.push({ op: 'set', x: 4, y: 1, z: 2, id: 'glowstone', note: 'light' });
  assert.ok(checkPlan(bad).some((x) => /glowstone is not an overworld/.test(x)));
  const gate = ironFarmPlan();
  gate.ops.push({ op: 'set', x: 5, y: 6, z: 10, id: 'crimson_fence_gate', states: { open_bit: true }, note: 'gate' });
  assert.ok(checkPlan(gate).some((x) => /crimson_fence_gate is not an overworld/.test(x)));
});

test('the shopping list is something a survival player can meet: what is needed is counted from the plan', () => {
  const m = materials(ironFarmPlan());
  assert.equal(m.counts.bed, 20);
  assert.equal(m.counts.composter, 10);
  assert.equal(m.counts.hopper, 2);
  assert.equal(m.counts.wall_sign, 3);
  assert.equal(m.counts.chest, 1);
  assert.ok(m.counts.cobblestone_slab > 50 && m.counts.cobblestone_slab < 250, `${m.counts.cobblestone_slab} slabs`);
  assert.match(m.text, /20 beds/);
  assert.match(m.text, /lava bucket/);
});

test('the village: 20 whole beds in two rows, 10 composters each beside a bed, 10 villagers with room', () => {
  const p = ironFarmPlan();
  assert.equal(p.beds.length, 20);
  assert.equal(p.stations.length, 10);
  assert.equal(p.villagers.length, 10);
  const g = render(p);
  for (const b of p.beds) { assert.equal(g.id(b.head.x, b.head.y, b.head.z), 'bed'); assert.equal(g.id(b.foot.x, b.foot.y, b.foot.z), 'bed'); }
  assert.equal(new Set(p.beds.map((b) => b.head.z)).size, 2);
});

test('a bed is set at its head with direction 0: the foot is one block north of it (what the bot learned in the game)', () => {
  const p = ironFarmPlan();
  const o = p.ops.find((q) => q.id === 'bed');
  assert.deepEqual(o.states, { direction: 0, head_piece_bit: true });
  const b = p.beds[0];
  assert.equal(b.foot.z, b.head.z - 1);
});

test('the pod is lit so nothing spawns among the villagers, and so is the viewing room; the torches stand on blocks', () => {
  const p = ironFarmPlan();
  const g = render(p);
  const torches = [...g.cells].filter(([, v]) => v.id === 'torch').map(([k]) => k.split(',').map(Number));
  assert.ok(torches.filter(([, y]) => y === 1).length >= 4);
  assert.ok(torches.some(([, y]) => y === 4));
  for (const [x, y, z] of torches) assert.equal(g.id(x, y - 1, z), 'cobblestone');
  // None of them is where a villager is put.
  for (const v of p.villagers) assert.ok(!torches.some(([x, , z]) => x === Math.floor(v.x) && z === Math.floor(v.z)));
});

test('the centre is the average of the beds and workstations, and the platform is well inside the spawn volume round it', () => {
  const p = ironFarmPlan();
  const c = villageCentre(p.beds, p.stations);
  assert.ok(Math.abs(c.x - 4.5) < 1e-9);
  assert.ok(c.z > 3 && c.z < 4.2, `z ${c.z}`);
  for (const k of p.centres) {
    for (let x = PLATFORM.x1; x <= PLATFORM.x2; x++) for (let z = PLATFORM.z1; z <= PLATFORM.z2; z++) {
      assert.ok(Math.abs(x - k.x) <= SPAWN_VOLUME.rx - 1 && Math.abs(z - k.z) <= SPAWN_VOLUME.rz - 1);
    }
  }
});

test('the only free spots in the spawn volume are on the platform: the pod and the room are two high, and every bare roof is slabbed', () => {
  const p = ironFarmPlan();
  const g = render(p);
  for (const k of p.centres) {
    const spots = golemSpots(g, { x: Math.floor(k.x), y: Math.floor(k.y), z: Math.floor(k.z) });
    assert.ok(spots.length >= 12, `${spots.length} spots`);
    for (const s of spots) assert.ok(s.y === PLATFORM.y1 && s.x >= PLATFORM.x1 && s.x <= PLATFORM.x2 && s.z >= PLATFORM.z1 && s.z <= PLATFORM.z2, `stray spot ${s.x},${s.y},${s.z}`);
  }
  assert.deepEqual(exposedTops(g, p.bounds), []);
});

test('without the slabs the roofs are places to spawn (the check does see them): this is what the slabs are for', () => {
  const p = without(ironFarmPlan(), (o) => o.tag === 'slab');
  const g = render(p);
  const bare = exposedTops(g, p.bounds);
  assert.ok(bare.length > 100 && bare.length < 200, `${bare.length} bare roof cells`);
  const bad = checkPlan(p);
  assert.ok(bad.some((x) => /golems could also spawn/.test(x)), bad.join('; '));
  assert.ok(bad.some((x) => /bare roof/.test(x)));
  // And they are slabs of the one kind, one per bare cell, no more.
  const slabbed = ironFarmPlan();
  const n = slabbed.ops.filter((o) => o.tag === 'slab').reduce((a, o) => a + (o.box.x2 - o.box.x1 + 1), 0);
  assert.equal(n, bare.length);
  assert.ok(slabbed.ops.filter((o) => o.tag === 'slab').every((o) => o.id === SLAB));
});

test('a pod with a three-high ceiling would be a leak (the check does see one)', () => {
  const p = ironFarmPlan();
  p.ops.push({ op: 'fill', box: { x1: 0, y1: 3, z1: 0, x2: 9, y2: 3, z2: 5 }, id: 'air', note: 'raise the roof' });
  const bad = checkPlan(p);
  assert.ok(bad.some((b) => /spawn at/.test(b) || /roof missing/.test(b) || /golems could also spawn/.test(b)), bad.join('; '));
});

test('the pod and the viewing room are sealed (a hole in a wall is caught); the platform is open to the sky, and its walls are what hold it', () => {
  const p = ironFarmPlan();
  const g = render(p);
  const out = outsideAir(g, p.bounds);
  assert.ok(out.has('-2,0,-2'));
  assert.ok(!out.has('4,1,3'), 'the pod is open to the outside');
  assert.ok(!out.has('5,4,13'), 'the viewing room is open to the outside');
  assert.ok(out.has('3,6,8') && out.has('3,4,8'), 'the platform is not open from above');
  const hole = ironFarmPlan();
  hole.ops.push({ op: 'fill', box: { x1: -1, y1: 1, z1: 3, x2: -1, y2: 1, z2: 3 }, id: 'air', note: 'knocked out' });
  assert.ok(checkPlan(hole).some((b) => /the shell has a hole/.test(b)), checkPlan(hole).join('; '));
  // A gap in the platform's wall, or a floor cell missing, lets the water and the golems out.
  const wall = ironFarmPlan();
  wall.ops.push({ op: 'fill', box: { x1: 2, y1: 5, z1: 8, x2: 2, y2: 5, z2: 8 }, id: 'air', note: 'knocked out' });
  assert.ok(checkPlan(wall).some((b) => /the platform wall has a gap at 2,5,8/.test(b)), checkPlan(wall).join('; '));
  const floor = ironFarmPlan();
  floor.ops.push({ op: 'fill', box: { x1: 4, y1: 3, z1: 8, x2: 4, y2: 3, z2: 8 }, id: 'air', note: 'knocked out' });
  assert.ok(checkPlan(floor).some((b) => /the platform floor has a gap at 4,8/.test(b)), checkPlan(floor).join('; '));
  // Three high from the floor to the top of the wall: the walls come up to the top of the platform, which is 3 layers.
  assert.equal(PLATFORM.y2 - PLATFORM.y1 + 1, 3);
  assert.equal(SHELLS[1].y2, PLATFORM.y2);
  // The tops of those walls are bare roof like any other, and slabbed; the platform's own floor is not.
  const slabAt = (x, y, z) => g.id(x, y, z) === SLAB;
  assert.ok(slabAt(2, PLATFORM.y2 + 1, 8) && slabAt(7, PLATFORM.y2 + 1, 8) && slabAt(4, PLATFORM.y2 + 1, 6) && slabAt(4, PLATFORM.y2 + 1, 11));
  assert.ok(!slabAt(4, PLATFORM.y1, 8) && g.id(4, PLATFORM.y1, 8) === 'air');
});

test('the lava has open sky above it and that is fine (a source does not run up); but air at its side is not', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(g.id(LAVA.x, LAVA.y + 1, LAVA.z), 'air');
  assert.deepEqual(checkPlan(p), []);
  const side = without(ironFarmPlan(), (o) => o.id === 'wall_sign' && o.x === LAVA.x - 1);
  assert.ok(checkPlan(side).some((b) => /lava has air beside it at -1,0,0/.test(b)), checkPlan(side).join('; '));
});

test('water from the one source reaches every cell of the platform floor, flowing on toward the south-east corner, which is the furthest and level 6 of 7', () => {
  const p = ironFarmPlan();
  const g = render(p);
  const lv = waterField(g, [SOURCE], PLATFORM.y1);
  assert.equal(lv.size, 16);
  assert.equal(lv.get(`${KILL.x},${KILL.z}`), 6);
  assert.equal(Math.max(...lv.values()), 6);
  // From any cell, always stepping to a further one, the corner is where it ends.
  for (const k of lv.keys()) {
    let [x, z] = k.split(',').map(Number), n = 0;
    while (n++ < 20) {
      const here = lv.get(`${x},${z}`);
      const next = [[1, 0], [0, 1], [-1, 0], [0, -1]].map(([dx, dz]) => [x + dx, z + dz]).find(([a, b]) => (lv.get(`${a},${b}`) ?? -1) > here);
      if (!next) break;
      [x, z] = next;
    }
    assert.deepEqual([x, z], [KILL.x, KILL.z], `from ${k}`);
  }
});

test('two sources along two walls would not do: the water would pile up on the diagonal (why there is one source)', () => {
  const p = ironFarmPlan();
  const g = render(p);
  const lv = waterField(g, [{ x: 3, z: 7 }, { x: 3, z: 8 }, { x: 3, z: 9 }, { x: 3, z: 10 }, { x: 4, z: 7 }, { x: 5, z: 7 }, { x: 6, z: 7 }], PLATFORM.y1);
  const ends = [...lv.keys()].filter((k) => {
    const [x, z] = k.split(',').map(Number), here = lv.get(k);
    return ![[1, 0], [0, 1], [-1, 0], [0, -1]].some(([dx, dz]) => (lv.get(`${x + dx},${z + dz}`) ?? -1) > here);
  });
  assert.ok(ends.length > 1, `ends ${ends.join(' ')}`);
});

test('the lava is held on every side by cobblestone or a wall sign hanging on a block, two blocks above the water; a missing sign or one with nothing behind it is caught', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(g.id(LAVA.x, LAVA.y, LAVA.z), 'lava');
  assert.equal(LAVA.y - KILL.y, 2);
  for (const s of SIGNS) {
    assert.equal(g.id(s.x, s.y, s.z), 'wall_sign');
    const off = signSupport(s.facing);
    assert.equal(g.id(s.x + off[0], s.y, s.z + off[1]), 'cobblestone', `behind the sign at ${s.x},${s.y},${s.z}`);
  }
  // Three signs: west, north and under the lava; east, south and the roof are cobblestone.
  assert.equal(SIGNS.length, 3);
  const turned = ironFarmPlan();
  turned.ops.find((o) => o.id === 'wall_sign').states = { facing_direction: 3 };
  assert.ok(checkPlan(turned).some((b) => /nothing behind it/.test(b)), checkPlan(turned).join('; '));
  const gone = without(ironFarmPlan(), (o) => o.id === 'wall_sign' && o.y === LAVA.y - 1);
  assert.ok(checkPlan(gone).some((b) => /lava has air/.test(b)), checkPlan(gone).join('; '));
});

test('the signs are placed before the lava and the lava before the water, so a sign that will not stay can stop the lava going in', () => {
  const p = ironFarmPlan();
  const at = (tag) => p.ops.findIndex((o) => o.tag === tag);
  assert.ok(at('sign') >= 0 && at('sign') < at('lava') && at('lava') < at('water'));
  assert.equal(p.ops.filter((o) => o.tag === 'sign').length, 3);
  assert.equal(p.ops.filter((o) => o.tag === 'lava').length, 1);
  assert.equal(p.ops.filter((o) => o.tag === 'water').length, 1);
  assert.deepEqual(p.ops.filter((o) => o.tag === 'sign').map((o) => o.states.facing_direction), SIGNS.map((s) => s.facing));
});

test('the hoppers run south from under the corner into the chest in the viewing room, and the viewer can reach it', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(g.at(KILL.x, KILL.y - 1, KILL.z).states.facing_direction, 3);
  assert.equal(g.at(KILL.x, KILL.y - 1, KILL.z + 1).states.facing_direction, 3);
  assert.equal(g.id(KILL.x, KILL.y - 1, KILL.z + 2), 'chest');
});

test('every placement is inside the farm box, which is just the three shells and the slabs on them', () => {
  const p = ironFarmPlan();
  const c = p.bounds;
  for (const o of p.ops) {
    const pts = o.op === 'set' ? [[o.x, o.y, o.z]] : [[o.box.x1, o.box.y1, o.box.z1], [o.box.x2, o.box.y2, o.box.z2]];
    for (const [x, y, z] of pts) assert.ok(x >= c.x1 && x <= c.x2 && y >= c.y1 && y <= c.y2 && z >= c.z1 && z <= c.z2);
  }
  assert.equal(POD.x2 - POD.x1 + 1, 10);
  assert.equal(c.x1, Math.min(...SHELLS.map((s) => s.x1)));
  assert.equal(c.y2, Math.max(...SHELLS.map((s) => s.y2)) + 1);
});

test('setblock arguments: states quoted the way the game wants them', () => {
  assert.equal(blockArg('cobblestone'), 'cobblestone');
  assert.equal(blockArg('bed', { direction: 0, head_piece_bit: true }), 'bed ["direction"=0,"head_piece_bit"=true]');
  assert.equal(blockArg('hopper', { facing_direction: 3 }), 'hopper ["facing_direction"=3]');
  assert.equal(blockArg('wall_sign', { facing_direction: 4 }), 'wall_sign ["facing_direction"=4]');
  assert.equal(blockArg('x', { a: 'b' }), 'x ["a"="b"]');
});
