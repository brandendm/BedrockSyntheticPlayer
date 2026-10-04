import test from 'node:test';
import assert from 'node:assert/strict';
import { ironFarmPlan, checkPlan, render, golemSpots, waterField, blockArg, villageCentre, SOURCE, KILL, PLATFORM, POD, SPAWN_VOLUME } from '../behavior_pack/scripts/core/ironfarm.js';

test('the plan holds together: nothing for checkPlan to complain about', () => {
  assert.deepEqual(checkPlan(ironFarmPlan()), []);
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

test('the only free spots in the spawn volume are on the platform: the pod and the viewing room are two high, the rest is stone', () => {
  const p = ironFarmPlan();
  const g = render(p);
  for (const k of p.centres) {
    const spots = golemSpots(g, { x: Math.floor(k.x), y: Math.floor(k.y), z: Math.floor(k.z) });
    assert.ok(spots.length >= 12, `${spots.length} spots`);
    for (const s of spots) assert.ok(s.y === PLATFORM.y1 && s.x >= PLATFORM.x1 && s.x <= PLATFORM.x2 && s.z >= PLATFORM.z1 && s.z <= PLATFORM.z2, `stray spot ${s.x},${s.y},${s.z}`);
  }
});

test('a pod with a three-high ceiling would be a leak (the check does see one)', () => {
  const p = ironFarmPlan();
  p.ops.push({ op: 'fill', box: { x1: 0, y1: 3, z1: 0, x2: 9, y2: 3, z2: 5 }, id: 'air', note: 'raise the roof' });
  const bad = checkPlan(p);
  assert.ok(bad.some((b) => /spawn at/.test(b) || /roof missing/.test(b)), bad.join('; '));
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

test('the lava is held on every side by stone or an open crimson gate, and touches no water; a closed gate or a missing one is caught', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(g.id(KILL.x, KILL.y + 2, KILL.z), 'lava');
  assert.equal(g.at(KILL.x, KILL.y + 1, KILL.z).id, 'crimson_fence_gate');
  assert.equal(g.at(KILL.x, KILL.y + 1, KILL.z).states.open_bit, true);
  const shut = ironFarmPlan();
  shut.ops.find((o) => o.id === 'crimson_fence_gate').states = { open_bit: false };
  assert.ok(checkPlan(shut).some((b) => /lava has/.test(b)));
  const gone = ironFarmPlan();
  gone.ops = gone.ops.filter((o) => !(o.id === 'crimson_fence_gate' && o.y === KILL.y + 1));
  assert.ok(checkPlan(gone).some((b) => /lava has air/.test(b)));
});

test('the hoppers run south from under the corner into the chest in the viewing room, and the viewer can reach it', () => {
  const p = ironFarmPlan();
  const g = render(p);
  assert.equal(g.at(KILL.x, KILL.y - 1, KILL.z).states.facing_direction, 3);
  assert.equal(g.at(KILL.x, KILL.y - 1, KILL.z + 1).states.facing_direction, 3);
  assert.equal(g.id(KILL.x, KILL.y - 1, KILL.z + 2), 'chest');
});

test('every placement is inside the solid block, so the carved rooms are the whole of what is open', () => {
  const p = ironFarmPlan();
  const c = p.cube;
  for (const o of p.ops.slice(1)) {
    const pts = o.op === 'set' ? [[o.x, o.y, o.z]] : [[o.box.x1, o.box.y1, o.box.z1], [o.box.x2, o.box.y2, o.box.z2]];
    for (const [x, y, z] of pts) assert.ok(x >= c.x1 && x <= c.x2 && y >= c.y1 && y <= c.y2 && z >= c.z1 && z <= c.z2);
  }
  assert.equal(POD.x2 - POD.x1 + 1, 10);
});

test('setblock arguments: states quoted the way the game wants them', () => {
  assert.equal(blockArg('stone'), 'stone');
  assert.equal(blockArg('bed', { direction: 0, head_piece_bit: true }), 'bed ["direction"=0,"head_piece_bit"=true]');
  assert.equal(blockArg('hopper', { facing_direction: 3 }), 'hopper ["facing_direction"=3]');
  assert.equal(blockArg('x', { a: 'b' }), 'x ["a"="b"]');
});
