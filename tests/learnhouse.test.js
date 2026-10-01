import { test } from 'node:test';
import assert from 'node:assert/strict';
import { house, plan } from './learn_fixture.js';
import { buildPlan, capture, boxOf, planMaterials, describe, setPlan, getPlan, HOUSE_KIT } from '../behavior_pack/scripts/core/learnhouse.js';
import { blueprint, clearance, footing, furnishings, keepClear, inside, layoutOf, materials, bounds, inTheWay } from '../behavior_pack/scripts/core/house.js';

test('a normal house becomes a plan', () => {
  const r = plan();
  assert.ok(r.ok, JSON.stringify(r.problems));
  const p = r.plan;
  assert.equal(p.floor.length, 5 * 4 - 5);        // the 5x4 room, less the table, furnace, chest and the bed's two
  assert.deepEqual(p.table.length, 2);
  assert.equal(p.chests.length, 1);
  assert.equal(p.furnaces.length, 1);
  assert.ok(r.stats.stone > 0 && r.stats.planks > 0);
  assert.ok(p.shell.every(([, , , m]) => m === 's' || m === 'p'));
  // The door is at lz 1 and the doorstep outside it: nothing of the plan beyond lz 1 but the step.
  assert.ok(p.shell.every(([, lz]) => lz <= 1));
  assert.equal(p.box.lz1, 2);
});

test('the same house turned any way is the same plan (door orientation is learned, not assumed)', () => {
  // Rotate the whole snapshot a quarter turn about the vertical axis, three times.
  const base = house();
  const rot = (cells) => { const m = new Map(); for (const [k, id] of cells) { const [x, y, z] = k.split(',').map(Number); m.set(`${-z},${y},${x}`, id); } return m; };
  const a = buildPlan(capture(base.get, base.box, (x, y, z) => base.heads.has(`${x},${y},${z}`)), { placed: base.placed }).plan;
  let cells = base.cells, placed = base.placed, heads = base.heads, box = base.box;
  for (let i = 0; i < 3; i++) {
    cells = rot(cells); placed = new Set([...placed].map((k) => { const [x, y, z] = k.split(',').map(Number); return `${-z},${y},${x}`; }));
    heads = new Set([...heads].map((k) => { const [x, y, z] = k.split(',').map(Number); return `${-z},${y},${x}`; }));
    const xs = [box.z0, box.z1]; box = { x0: -box.z1, x1: -box.z0, y0: box.y0, y1: box.y1, z0: box.x0, z1: box.x1 }; void xs;
    const b = buildPlan(capture((x, y, z) => cells.get(`${x},${y},${z}`), box, (x, y, z) => heads.has(`${x},${y},${z}`)), { placed });
    assert.ok(b.ok, `${i}: ${JSON.stringify(b.problems)}`);
    assert.equal(b.plan.shell.length, a.shell.length);
    assert.deepEqual(b.plan.shell, a.shell);
    assert.deepEqual(b.plan.table, a.table);
    assert.deepEqual(b.plan.bed, a.bed);
    assert.deepEqual(b.plan.chests, a.chests);
  }
});

test('a hole in the roof is a leak, and it says where', () => {
  const r = plan({ noRoof: true });
  assert.ok(!r.ok);
  assert.match(r.problems.join(' '), /open to the outside|closed room/);
});

test('every missing piece is named', () => {
  assert.match(plan({ noBed: true }).problems.join(), /no bed/);
  assert.match(plan({ noTable: true }).problems.join(), /no crafting table/);
  assert.match(plan({ noFurnace: true }).problems.join(), /no furnace/);
  assert.match(plan({ noChest: true }).problems.join(), /no chest/);
  assert.match(plan({ noDoor: true }).problems.join(), /no door/);
});

test('no torch: it hangs one inside itself, and says so', () => {
  const r = plan({ noTorch: true });
  assert.ok(r.ok, JSON.stringify(r.problems));
  assert.ok(r.plan.torchIn.toward && r.plan.torchIn.on);
  assert.match(r.notes.join(), /no torch inside/);
});

test('things you can\'t reach from the door are caught (a row of chests across the room)', () => {
  const r = plan({ walledChests: true });
  assert.ok(!r.ok);
  assert.match(r.problems.join(), /get to the/);
});

test('window holes up high are left open; glass up high is open; low glass is wall', () => {
  const holes = plan({ windows: 'holes' });
  assert.ok(holes.ok, JSON.stringify(holes.problems));
  assert.equal(holes.plan.open.length, 2);
  const glass = plan({ windows: 'glass' });
  assert.ok(glass.ok, JSON.stringify(glass.problems));
  assert.equal(glass.plan.open.length, 2);
  const low = plan({ windows: 'low' });
  assert.ok(low.ok, JSON.stringify(low.problems));
  assert.equal(low.plan.open.length, 0);
  assert.ok(low.plan.shell.some(([, , h, m]) => h === 1 && m === 'p')); // (glass at h 1: a wall block)
});

test('a hillside wall (natural dirt) is not built; the house is still closed', () => {
  const r = plan({ hill: true });
  assert.ok(r.ok, JSON.stringify(r.problems));
  const full = plan();
  assert.ok(r.plan.shell.length < full.plan.shell.length);
});

test('too big, and too small', () => {
  const big = plan({ W: 19, D: 10 });
  assert.ok(!big.ok);
  assert.match(big.problems.join(), /bigger than 17|out of reach|600/);
  const small = plan({ W: 4, D: 4 });
  assert.ok(!small.ok, JSON.stringify(small.problems));
});

test('only the house\'s cluster is read: a pillar far off doesn\'t stretch the box', () => {
  const h = house();
  const placed = [...h.placed].map((k) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; });
  const far = []; for (let y = 1; y < 8; y++) far.push({ x: 40, y, z: 40 });
  const b = boxOf([...placed, ...far]);
  assert.ok(b.x1 < 20 && b.z1 < 20, JSON.stringify(b));
});

test('the plan drives the house code: blueprint, footing, clearance, furnishings agree with it', () => {
  const r = plan();
  setPlan(r.plan);
  try {
    const o = { x: 100, y: 64, z: 200, dir: 'south', layout: 'learned' };
    assert.equal(layoutOf(o), 'learned');
    const bp = blueprint(o, 'south');
    assert.equal(bp.length, r.plan.shell.length);
    assert.equal(bp.filter((b) => b.material === 'stone').length, r.stats.stone);
    const fur = furnishings(o, 'south');
    assert.equal(fur.door.x, 100); assert.equal(fur.door.z, 201); assert.equal(fur.doorstep.z, 202);
    assert.equal(fur.layout, 'chests');
    assert.equal(fur.chests.length, 1);
    // No blueprint cell is a furnishing's cell, nor in the room's floor.
    const keys = new Set(bp.map((b) => `${b.x},${b.y},${b.z}`));
    for (const c of [fur.table, fur.furnace, fur.bed.foot, fur.bed.head, ...fur.chests, fur.door, fur.stand]) assert.ok(!keys.has(`${c.x},${c.y},${c.z}`), `${JSON.stringify(c)} is in the shell`);
    // Footing under the floor and the doorstep; clearance covers the room and the walls' places.
    const foot = new Set(footing(o, 'south').map((p) => `${p.x},${p.y},${p.z}`));
    assert.ok(foot.has(`${fur.doorstep.x},${fur.doorstep.y - 1},${fur.doorstep.z}`));
    assert.ok(foot.has(`${fur.stand.x},${fur.stand.y - 1},${fur.stand.z}`));
    const clr = new Set(clearance(o, 'south').map((p) => `${p.x},${p.y},${p.z}`));
    for (const b of bp.filter((q) => q.h >= 0)) assert.ok(clr.has(`${b.x},${b.y},${b.z}`));
    // Keep-clear: the furnishings' cells have `want`; the rest of the room is plain; the door is wanted.
    const kc = keepClear(o, 'south');
    assert.equal(kc.find((c) => c.x === fur.table.x && c.y === fur.table.y && c.z === fur.table.z).want, 'crafting_table');
    assert.ok(kc.some((c) => c.want === 'door'));
    assert.ok(!kc.some((c) => keys.has(`${c.x},${c.y},${c.z}`)));
    // A block in the way is found; the table in its own spot isn't.
    assert.ok(inTheWay(kc.find((c) => !c.want), 'cobblestone'));
    assert.ok(!inTheWay(kc.find((c) => c.want === 'crafting_table'), 'crafting_table'));
    // Standing in the room is inside; outside the door isn't.
    assert.ok(inside(o, fur.stand));
    assert.ok(!inside(o, fur.doorstep));
    assert.ok(bounds(o).lz0 <= -3);
    assert.deepEqual(materials('learned'), planMaterials(r.plan));
    // Facing another way, the same shape turned.
    const bpE = blueprint({ ...o, dir: 'east' }, 'east');
    assert.equal(bpE.length, bp.length);
  } finally { setPlan(null); }
  // Without the plan loaded, a "learned" house reads as the old cabin rather than breaking.
  assert.equal(layoutOf({ layout: 'learned' }), 'cabin');
});

test('describe draws it', () => {
  const lines = describe(plan().plan);
  assert.ok(lines.some((l) => /T/.test(l)) && lines.some((l) => /B/.test(l)) && lines.some((l) => /C/.test(l)) && lines.some((l) => /F/.test(l)));
});

test('the kit has what a house takes', () => {
  const ids = HOUSE_KIT.map((k) => k[0]);
  for (const need of ['cobblestone', 'oak_planks', 'oak_door', 'bed', 'crafting_table', 'furnace', 'chest', 'torch']) assert.ok(ids.includes(need), need);
  assert.equal(getPlan(), null);
});
