import test from 'node:test';
import assert from 'node:assert/strict';
import { rng, forestPlan, treeFills, oreLayout, ORE_POINTS, rank, winnerOf, clock, clockLeft, parkourPlan, boatPlan, boatDrive, ARENA_INFO, ARENA_NAMES } from '../behavior_pack/scripts/core/arena.js';

const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

test('the seeded generator repeats itself', () => {
  const a = rng(3), b = rng(3), c = rng(4);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs, [c(), c(), c()]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('forest: the same for both corners, nothing on the starts, no two trees too close', () => {
  const plan = forestPlan();
  assert.equal(plan.starts.length, 2);
  assert.ok(plan.trees.length >= 50, `${plan.trees.length} trees`);
  const last = plan.size - 1;
  const key = (t) => `${t.x},${t.z},${t.h}`;
  const have = new Set(plan.trees.map(key));
  for (const t of plan.trees) assert.ok(have.has(key({ x: last - t.x, z: last - t.z, h: t.h })), `twin of ${key(t)}`); // point-symmetric
  for (const t of plan.trees) for (const s of plan.starts) assert.ok(cheb(t, s) >= 5, 'start kept clear');
  for (let i = 0; i < plan.trees.length; i++) for (let j = i + 1; j < plan.trees.length; j++) assert.ok(cheb(plan.trees[i], plan.trees[j]) >= 3, 'trees apart');
  assert.deepEqual(forestPlan(), plan);
  assert.notDeepEqual(forestPlan({ seed: 12 }), plan);
});

test('a tree is a trunk with leaves from the top down', () => {
  const f = treeFills({ x: 5, z: 7, h: 5 }, 10);
  const log = f.find((x) => x.kind === 'log');
  assert.deepEqual(log.box, [5, 11, 7, 5, 15, 7]);
  assert.ok(f.filter((x) => x.kind === 'leaves').every((x) => x.box[1] >= 10 + 4)); // none below head height
});

test('ore: same cells for both tanks, none in the keep-out, valuable first', () => {
  const keepOut = [0, 1, 2].flatMap((x) => [0, 1, 2].map((z) => ({ x, z })));
  const ores = oreLayout({ keepOut });
  assert.deepEqual(oreLayout({ keepOut }), ores);
  const seen = new Set();
  for (const o of ores) {
    assert.ok(o.x >= 0 && o.x < 14 && o.z >= 0 && o.z < 14);
    assert.ok(!keepOut.some((c) => c.x === o.x && c.z === o.z), 'not under the ledge');
    const k = `${o.layer},${o.x},${o.z}`;
    assert.ok(!seen.has(k), 'one ore per cell and layer');
    seen.add(k);
    assert.ok(o.kind in ORE_POINTS);
  }
  assert.equal(ores.filter((o) => o.layer === 0 && o.kind === 'diamond_ore').length, 3);
  assert.equal(ores.filter((o) => o.layer === 1 && o.kind === 'diamond_ore').length, 4);
});

test('ranking and winners', () => {
  const e = [{ name: 'a', value: 5 }, { name: 'b', value: 9 }, { name: 'c', value: null }];
  assert.deepEqual(rank(e).map((x) => x.name), ['b', 'a', 'c']);
  assert.deepEqual(rank(e, 'low').map((x) => x.name), ['a', 'b', 'c']);
  assert.equal(winnerOf(e), 'b');
  assert.equal(winnerOf(e, 'low'), 'a');
  assert.equal(winnerOf([{ name: 'a', value: 4 }, { name: 'b', value: 4 }]), null); // a tie
  assert.equal(winnerOf([{ name: 'a', value: 0 }, { name: 'b', value: 0 }]), null);
  assert.equal(winnerOf([{ name: 'a', value: null }, { name: 'b', value: null }], 'low'), null);
  assert.equal(winnerOf([{ name: 'a', value: 1200 }, { name: 'b', value: 1e6 + 3000 }], 'low'), 'a'); // finished beats not finished
});

test('clocks read like clocks', () => {
  assert.equal(clock(0), '0:00.0');
  assert.equal(clock(20 * 65 + 6), '1:05.3');
  assert.equal(clockLeft(20 * 94 - 3), '1:34');
  assert.equal(clockLeft(0), '0:00');
});

test('every arena has a description', () => {
  for (const n of ['forest', 'golem', 'ender', 'dive', 'parkour', 'boat']) assert.ok(ARENA_INFO[n], n);
  assert.deepEqual(ARENA_NAMES, Object.keys(ARENA_INFO));
});

// ---------- the parkour course ----------

test('parkour: the hill goes up in single steps, the descent in drops a body survives', () => {
  const p = parkourPlan();
  assert.equal(p.L, p.h.length);
  const a = p.seg.ascent;
  for (let z = a.z0; z <= p.seg.plateau.z1; z++) assert.ok(p.h[z] - p.h[z - 1] <= 1 && p.h[z] >= p.h[z - 1], `hill step at ${z}`);
  assert.equal(p.h[p.seg.plateau.z1], 9);
  for (let z = p.seg.descent.z0; z <= p.seg.descent.z1; z++) {
    const drop = p.h[z - 1] - p.h[z];
    assert.ok(drop >= 0 && drop <= 3, `descent drop ${drop} at ${z}`);
  }
  assert.equal(p.h[p.seg.descent.z1], 0);
  for (let z = p.seg.flat1.z0; z < p.L; z++) assert.equal(p.h[z], 0, `flat from the bottom on (${z})`);
});

test('parkour: the wall is 7 above the hill and its vines run the whole way up', () => {
  const p = parkourPlan();
  assert.equal(p.wall.top - 9, 7);
  assert.equal(p.vines.z, p.wall.z0 - 1);
  assert.equal(p.vines.y0, 10);
  assert.equal(p.vines.y1, p.wall.top); // the highest vine hangs on the wall's top block
  assert.ok(p.vines.xs.length >= 3);
  for (let z = p.wall.z0; z <= p.wall.z1; z++) assert.equal(p.h[z], p.wall.top);
  assert.equal(p.h[p.vines.z], 9); // they hang over the hill's top
});

test('parkour: trees never touch, so there is always a way through the field', () => {
  for (const seed of [1, 7, 12, 99]) {
    const p = parkourPlan({ seed });
    const f = p.seg.trees;
    assert.ok(p.trees.length >= 16, `${p.trees.length} trees (seed ${seed})`);
    for (const t of p.trees) { assert.ok(t.z >= f.z0 && t.z <= f.z1 && t.x >= 1 && t.x <= p.W - 2); assert.ok(t.h >= 4 && t.h <= 6); }
    for (let i = 0; i < p.trees.length; i++) for (let j = i + 1; j < p.trees.length; j++) assert.ok(cheb(p.trees[i], p.trees[j]) >= 2);
    // Flood from the first row to the last across the free cells.
    const blocked = new Set(p.trees.map((t) => `${t.x},${t.z}`));
    const seen = new Set(), q = [];
    for (let x = 0; x < p.W; x++) if (!blocked.has(`${x},${f.z0}`)) { q.push([x, f.z0]); seen.add(`${x},${f.z0}`); }
    let through = false;
    while (q.length) {
      const [x, z] = q.pop();
      if (z === f.z1) through = true;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz, k = `${nx},${nz}`;
        if (nx < 0 || nx >= p.W || nz < f.z0 || nz > f.z1 || blocked.has(k) || seen.has(k)) continue;
        seen.add(k); q.push([nx, nz]);
      }
    }
    assert.ok(through, `a way through the trees (seed ${seed})`);
  }
});

test('parkour: each hole has a ramp out and a way round it', () => {
  const p = parkourPlan();
  assert.equal(p.holes.length, 2);
  for (const hl of p.holes) {
    assert.equal(hl.depth.length, hl.z1 - hl.z0 + 1);
    assert.equal(hl.depth[hl.depth.length - 1], 0);
    for (let i = 1; i < hl.depth.length; i++) assert.ok(hl.depth[i - 1] - hl.depth[i] <= 1 && hl.depth[i] <= hl.depth[i - 1], 'a ramp: one step at a time');
    assert.ok(hl.depth[0] >= 4, 'deep enough to hurt');
    const wide = p.W - (hl.x1 - hl.x0 + 1);
    assert.ok(wide >= 5, `${wide} columns left beside the hole`);
  }
  // The two holes are on different sides, so the way round the first is not the way round the second.
  assert.ok(p.holes[0].x1 < p.holes[1].x0);
  for (const m of p.mobs) if (m.kind === 'zombie') assert.ok(p.holes.some((hl) => m.x >= hl.x0 && m.x <= hl.x1 && m.z >= hl.z0 && m.z <= hl.z1), 'zombies are down the holes');
  for (const m of p.mobs) if (m.kind === 'husk') assert.ok(m.z >= p.seg.trees.z0 && m.z <= p.seg.trees.z1 && !p.trees.some((t) => cheb(t, m) < 2));
});

test('parkour: the lava can be crossed, every gap two blocks or less', () => {
  const p = parkourPlan();
  const lv = p.lava;
  assert.equal(lv.islands.length, 2);
  let prev = lv.z0 - 1; // the last row of the edge
  for (const isl of lv.islands) {
    assert.ok(isl.z0 - prev - 1 <= 2 && isl.z0 - prev - 1 >= 1, `gap before the island at ${isl.z0}`);
    assert.ok(isl.x1 - isl.x0 + 1 >= 4, 'wide enough to land on');
    prev = isl.z1;
  }
  assert.ok(p.finishZ - prev - 1 <= 2, 'gap before the gold');
  assert.equal(p.finishZ, lv.z1 + 1);
  assert.ok(p.L - p.finishZ >= 4);
});

test('parkour: the route runs forward along the course and stays inside it', () => {
  for (const seed of [1, 7, 12]) {
    const p = parkourPlan({ seed });
    let z = -1;
    for (const c of p.route) {
      assert.ok(c.z > z, `route goes forward (${c.z} after ${z})`);
      z = c.z;
      assert.ok(c.x >= 0 && c.x < p.W && c.z < p.L);
      assert.equal(c.h, p.h[c.z], `route height at ${c.z}`);
      assert.ok(!p.trees.some((t) => t.x === c.x && t.z === c.z));
      for (const hl of p.holes) assert.ok(!(c.x >= hl.x0 && c.x <= hl.x1 && c.z >= hl.z0 && c.z <= hl.z1), `route not in a hole at ${c.z}`);
    }
  }
  assert.deepEqual(parkourPlan(), parkourPlan());
  assert.notDeepEqual(parkourPlan({ seed: 8 }).trees, parkourPlan().trees);
});

// ---------- the boat course ----------

test('boat: the canal runs from the start to the gold through every leg, and every post leaves room', () => {
  const p = boatPlan();
  const inRect = (x, z) => p.rects.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
  const post = new Set(p.posts.map((q) => `${q.x},${q.z}`));
  const water = (x, z) => inRect(x, z) && !post.has(`${x},${z}`);
  assert.ok(water(p.start.x, p.start.z) && water(p.tow.x, p.tow.z), 'both boats start on water');
  assert.ok(p.tow.z < p.start.z && p.start.z < p.gateZ, 'the villagers\' boat is behind, the gate in front');
  // Flood from the start; the finish must be reached, and the legs in order.
  const seen = new Set([`${p.start.x},${p.start.z}`]), q = [[p.start.x, p.start.z]];
  while (q.length) {
    const [x, z] = q.pop();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + dx},${z + dz}`;
      if (seen.has(k) || !water(x + dx, z + dz)) continue;
      seen.add(k); q.push([x + dx, z + dz]);
    }
  }
  for (let x = p.finish.x0; x <= p.finish.x1; x++) assert.ok(seen.has(`${x},${p.finish.z0}`), 'the gold line is reachable');
  // The separators are solid: leg 1 and leg 3 meet only through legs/basins (no straight shortcut).
  for (let z = 6; z < 40; z++) for (const x of [6, 7, 8, 14, 15, 16]) assert.ok(!water(x, z), `wall at ${x},${z}`);
  // Room round each post: at least three free columns across the leg on its row.
  for (const q2 of p.posts) {
    const r = p.rects.find((rr) => rr.name.startsWith('leg') && q2.x >= rr.x0 && q2.x <= rr.x1);
    let free = 0; for (let x = r.x0; x <= r.x1; x++) if (water(x, q2.z)) free++;
    assert.ok(free >= 3, `${free} free columns at post ${q2.x},${q2.z}`);
    assert.ok(q2.z > p.gateZ + 4 && q2.z < p.finish.z0 - 4);
  }
  assert.ok(p.finish.z0 > p.posts.reduce((m, o) => Math.max(m, o.z), 0), 'no posts in the finish');
  assert.ok(p.finish.x0 > p.rects.find((r) => r.name === 'leg2').x1, 'the gold is in the last leg');
  assert.ok(p.w >= p.finish.x1 + 2 && p.d >= p.finish.z1 + 2, 'walls fit in the box');
  // A bot standing to watch is on the wall between legs 2 and 3, not in the water.
  assert.ok(!water(p.watch.x, p.watch.z));
  assert.ok(p.route.every((c) => water(c.x, c.z)));
});

test('boat: the lap is long enough to be a race', () => {
  const p = boatPlan();
  let len = 0; let prev = p.start;
  for (const c of p.route) { len += Math.abs(c.x - prev.x) + Math.abs(c.z - prev.z); prev = c; }
  assert.ok(len >= 150, `${len} blocks`);
});

test('boat: the line round the canal has room for a boat all the way and never touches a post', () => {
  const p = boatPlan();
  const line = boatDrive(p);
  const post = new Set(p.posts.map((q) => `${q.x},${q.z}`));
  const water = (x, z) => p.rects.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) && !post.has(`${x},${z}`);
  // A boat is a disc of radius 0.7: eight points round it and its middle must all be over water.
  const room = (x, z, r = 0.72) => {
    for (const [a, b] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]]) if (!water(Math.floor(x + a), Math.floor(z + b))) return false;
    return true;
  };
  assert.ok(line.length >= 30);
  assert.ok(line[0].z > p.start.z - 1 && line[0].z < p.gateZ, 'starts behind the gate');
  assert.ok(line.at(-1).z >= p.finish.z0 + 3 && line.at(-1).x >= p.finish.x0 && line.at(-1).x <= p.finish.x1 + 1, 'ends on the gold');
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.25);
    for (let k = 0; k <= n; k++) {
      const x = a.x + (b.x - a.x) * k / n, z = a.z + (b.z - a.z) * k / n;
      assert.ok(room(x, z), `no room at ${x.toFixed(2)},${z.toFixed(2)} between waypoints ${i - 1} and ${i}`);
    }
  }
  // It goes up leg 1, down leg 2, up leg 3, and passes the gold only at the end.
  const zs = line.map((q) => q.z);
  assert.ok(Math.max(...zs.slice(0, 14)) >= 50 && zs.at(-1) > zs.at(-5), 'goes up the last leg');
  assert.ok(line.filter((q) => q.slow).length >= 12, 'the bends are marked');
});
