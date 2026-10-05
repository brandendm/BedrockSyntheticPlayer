import test from 'node:test';
import assert from 'node:assert/strict';
import { ironFarmPlan, render, BASE_Y, SLAB } from '../behavior_pack/scripts/core/ironfarm.js';
import { runBuild, splitPlan, reaches, facing, FREE, STAND_ON, handSet } from '../behavior_pack/scripts/core/farmbuild.js';

const key = (x, y, z) => `${x},${y},${z}`;
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * A fake world and a fake bot under a player's rules: a block goes only into a free cell, only within reach, only against a solid neighbour whose face the
 * eye is on the open side of, only from a spot that is solid underfoot with room to head height; and it takes an item from the pack to do it. Every time
 * the engine asks for something the rules forbid, it is written down in `log.violations`.
 */
function fake(plan, { miss = 0, seed = 1, noStand = false, unreach = null, stopAfter = Infinity, world = new Map(), inv = {}, slip = 0, tidy = false } = {}) {
  let bot = null, tick = 0, rnd = seed, placeCalls = 0, grid = null;
  const scaffold = new Set();
  const final = () => (grid ??= render(plan));
  const rand = () => { rnd = (rnd * 1664525 + 1013904223) % 4294967296; return rnd / 4294967296; };
  const log = { violations: /** @type {string[]} */ ([]), said: /** @type {string[]} */ ([]), stands: 0, scaffold: 0, sets: 0, slips: /** @type {string[]} */ ([]), cleared: 0 };
  const idAt = (x, y, z) => (y <= BASE_Y - 1 ? 'stone' : (world.get(key(x, y, z)) ?? 'air'));
  const hands = {
    blockAt: (c) => idAt(c.x, c.y, c.z),
    where: () => bot,
    async stand(s) {
      if (noStand || (unreach && unreach(s, log.stands))) { tick += 20; return false; }
      // (On air, as the game's walkTo does: a pillar under it from what is below, or a bridge block from a solid side; scaffolding, tidied later.)
      if (idAt(s.x, s.y - 1, s.z) === 'air') {
        let h = 1;
        while (h <= 5 && idAt(s.x, s.y - 1 - h, s.z) === 'air') h++;
        const side = DIRS.some(([a, b, d]) => b === 0 && !FREE.has(idAt(s.x + a, s.y - 1, s.z + d)));
        if (side) h = 1;
        if (h > 5) { log.violations.push(`no way onto ${key(s.x, s.y, s.z)}`); return false; }
        for (let i = 1; i <= h; i++) { const k = key(s.x, s.y - i, s.z); world.set(k, plan.shell ?? 'dirt'); scaffold.add(k); log.scaffold++; }
      }
      if (!STAND_ON.has(idAt(s.x, s.y - 1, s.z)) || !FREE.has(idAt(s.x, s.y, s.z)) || !FREE.has(idAt(s.x, s.y + 1, s.z))) { log.violations.push(`stand at ${key(s.x, s.y, s.z)} on ${idAt(s.x, s.y - 1, s.z)}`); return false; }
      bot = { ...s }; tick += 4; log.stands++;
      return true;
    },
    async tidy() {
      const g = final();
      for (const k of [...scaffold]) {
        scaffold.delete(k);
        const want = g.cells.get(k)?.id;
        if (want !== world.get(k)) world.delete(k);
      }
    },
    async place(c, id) {
      tick += 14;
      if (++placeCalls > stopAfter) throw new Error('stopped');
      if (!bot) { log.violations.push('no bot'); return false; }
      if (!reaches(bot, c)) { log.violations.push(`out of reach ${key(c.x, c.y, c.z)} from ${key(bot.x, bot.y, bot.z)}`); return false; }
      if (idAt(c.x, c.y, c.z) !== 'air') { log.violations.push(`occupied ${key(c.x, c.y, c.z)} by ${idAt(c.x, c.y, c.z)}`); return false; }
      if (c.x === bot.x && c.z === bot.z && (c.y === bot.y || c.y === bot.y + 1)) { log.violations.push(`on the bot ${key(c.x, c.y, c.z)}`); return false; }
      // (A slab only on the top of the block under it: anywhere else it could come out a top slab.)
      const face = (id === SLAB ? [[0, -1, 0]] : DIRS).some(([a, b, d]) => { const n = { x: c.x + a, y: c.y + b, z: c.z + d }; return !FREE.has(idAt(n.x, n.y, n.z)) && facing(bot, c, n); });
      if (!face) { log.violations.push(`no face to click for ${key(c.x, c.y, c.z)} (${id}) from ${key(bot.x, bot.y, bot.z)}`); return false; }
      if (!((inv[id] ?? 0) > 0)) { log.violations.push(`out of ${id}`); return false; }
      if (rand() < miss) return false;
      inv[id]--; world.set(key(c.x, c.y, c.z), id);
      // (A slip of the hand: a second block in the free cell in front of the face, toward the bot.)
      if (slip && rand() < slip) {
        const dx = Math.sign(bot.x - c.x), dz = Math.sign(bot.z - c.z);
        const k = key(c.x + dx, c.y, c.z + dz);
        if ((dx || dz) && idAt(c.x + dx, c.y, c.z + dz) === 'air' && !(c.x + dx === bot.x && c.z + dz === bot.z)) { world.set(k, id); log.slips.push(k); }
      }
      return true;
    },
    set(c, id) { world.set(key(c.x, c.y, c.z), id); log.sets++; return true; },
    ...(tidy ? { clear(c) { world.delete(key(c.x, c.y, c.z)); log.cleared++; return true; } } : {}),
    stock(id, n) { inv[id] = Math.max(inv[id] ?? 0, n); },
    now: () => tick,
    check() {},
    yield: async () => {},
    say: (m) => log.said.push(m),
  };
  return { hands, world, log, inv };
}

/** The commands the game runs after each layer, in the fake: the `set` ops at that layer (as the plan makes their cells). */
const afterFor = (plan, world) => {
  const { rest } = splitPlan(plan);
  return async (y) => {
    for (const o of rest.filter((q) => q.y === y)) for (const [k, v] of render({ ops: [o] }).cells) world.set(k, v.id);
  };
};

/** Everything the plan has (but the platform's water) stands, and nothing else is in the farm's box. */
function sameAsPlan(plan, world) {
  const g = render(plan);
  const bad = [];
  for (const [k, v] of g.cells) if (v.id !== 'water' && world.get(k) !== v.id) bad.push(`${k}: ${world.get(k) ?? 'air'}, plan ${v.id}`);
  for (const [k, id] of world) if (!g.cells.has(k) && id !== 'stone') bad.push(`${k}: ${id} where the plan has nothing`);
  return bad;
}

test('the plan splits into what the bot places (the shell, glass, composters, slabs) and what commands set; nothing is in both or in neither', () => {
  const plan = ironFarmPlan();
  const { cells, rest, final } = splitPlan(plan);
  const hand = handSet(plan.shell);
  assert.ok(cells.length > 1100 && cells.length < 1500, `${cells.length} cells for the bot`);
  assert.ok(cells.every((c) => hand.has(c.id)));
  assert.ok(rest.every((o) => !hand.has(o.id)));
  const ids = new Set(rest.map((o) => o.id));
  for (const want of ['bed', 'hopper', 'chest', 'wall_sign', 'fence_gate', 'wooden_door', 'torch', 'campfire', 'lava']) assert.ok(ids.has(want), `${want} is left to commands`);
  assert.ok(cells.some((c) => c.id === SLAB) && cells.some((c) => c.id === 'glass') && cells.some((c) => c.id === 'composter'));
  const covered = new Set(cells.map((c) => key(c.x, c.y, c.z)));
  for (const o of rest) for (const k of render({ ops: [o] }).cells.keys()) covered.add(k);
  for (const o of plan.ops.filter((q) => q.tag === 'water')) for (const k of render({ ops: [o] }).cells.keys()) covered.add(k);
  const missing = [...final.cells.keys()].filter((k) => !covered.has(k));
  assert.deepEqual(missing, [], 'cells of the plan that are neither the bot\'s, nor a command\'s, nor water');
  assert.equal(plan.ops.filter((o) => o.id === 'wall_sign').length, 3, 'the three that hold the lava (u218: none over the hole)');
});

test('reach and faces: the same rules the bot\'s placement uses (the eye 1.52 up, a face you are behind cannot be clicked)', () => {
  const s = { x: 0, y: 0, z: 0 };
  assert.ok(reaches(s, { x: 3, y: 0, z: 0 }));
  assert.ok(!reaches(s, { x: 5, y: 0, z: 0 }));
  assert.ok(!reaches(s, { x: 0, y: 6, z: 0 }));
  // the top face of the block under a cell at the bot's own level: the eye is above it
  assert.ok(facing(s, { x: 2, y: 0, z: 0 }, { x: 2, y: -1, z: 0 }));
  // the top face of a block above the eye cannot be seen from under it: a cell on top of a wall two above the head
  assert.ok(!facing(s, { x: 1, y: 3, z: 0 }, { x: 1, y: 2, z: 0 }));
  // the near side of a neighbour to the west of the cell, the eye east of it: yes; the far side: no
  assert.ok(facing({ x: 3, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }));
  assert.ok(!facing({ x: -3, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }));
});

test('with hands that work, the bot builds the whole shell itself under the rules, and what is left is the plan', async () => {
  for (const shell of ['dirt', 'cobblestone']) {
    const plan = ironFarmPlan({ shell });
    const f = fake(plan);
    const stats = await runBuild(plan, f.hands, { after: afterFor(plan, f.world) });
    assert.deepEqual(f.log.violations, [], 'the engine asked for something a player cannot do');
    assert.deepEqual(sameAsPlan(plan, f.world), []);
    assert.equal(stats.gaveUp, '');
    assert.equal(stats.hand + stats.command + stats.already, stats.cells, 'every cell is accounted for once');
    assert.ok(stats.hand / stats.cells > 0.9, `${stats.hand} of ${stats.cells} by hand (${stats.footing} footings, ${stats.fallback} fallbacks)`);
    assert.equal(stats.fallback, 0);
    assert.equal(stats.repaired, 0);
    assert.ok(stats.footing < 40, `${stats.footing} blocks set by command just to have something to stand on`);
    assert.ok(stats.standMoves < 400, `${stats.standMoves} spots`);
    assert.ok(stats.command <= stats.footing, `${stats.command} by command, ${stats.footing} of them footings`);
    assert.ok(stats.handById[shell] > 700 && stats.handById[SLAB] > 100 && stats.handById.glass === 5 && stats.handById.composter === 10, JSON.stringify(stats.handById));
  }
});

test('misses (u218): a block that will not go down is tried again, not handed to a command; the farm is the same', async () => {
  const plan = ironFarmPlan();
  const f = fake(plan, { miss: 0.3, seed: 7 });
  const stats = await runBuild(plan, f.hands, { after: afterFor(plan, f.world) });
  assert.deepEqual(sameAsPlan(plan, f.world), []);
  assert.ok(stats.misses > 50, `${stats.misses} misses`);
  assert.ok(stats.fallback <= 2, `${stats.fallback} fallbacks`);
  assert.equal(stats.gaveUp, '', 'a 70% hit rate is not a reason to give up');
  assert.ok(stats.hand > stats.cells * 0.95, `${stats.hand} of ${stats.cells} by hand`);
  assert.equal(stats.hand + stats.command + stats.already, stats.cells);
});

test('spots it cannot get to (u218): it tries other spots and comes back; nothing is handed to a command for it', async () => {
  const plan = ironFarmPlan();
  // (one spot in three refuses it the first time it is asked for)
  const asked = new Map();
  const f = fake(plan, { unreach: (s) => { const k = key(s.x, s.y, s.z), n = (asked.get(k) ?? 0) + 1; asked.set(k, n); return n === 1 && (s.x * 7 + s.z * 3 + s.y) % 3 === 0; } });
  const stats = await runBuild(plan, f.hands, { after: afterFor(plan, f.world) });
  assert.deepEqual(f.log.violations, []);
  assert.deepEqual(sameAsPlan(plan, f.world), []);
  assert.ok(stats.standFails > 20, `${stats.standFails} spots refused`);
  assert.equal(stats.gaveUp, '');
  assert.equal(stats.fallback, 0);
  assert.equal(stats.repaired, 0);
  assert.ok(stats.command <= stats.footing, `${stats.command} by command`);
});

test('hands that never work: it says so after two dozen tries and sets the rest by command; the farm is the same', async () => {
  const plan = ironFarmPlan();
  const f = fake(plan, { miss: 1 });
  const stats = await runBuild(plan, f.hands, { after: afterFor(plan, f.world) });
  assert.deepEqual(sameAsPlan(plan, f.world), []);
  assert.match(stats.gaveUp, /only 0 of 24/);
  assert.equal(stats.attempts, 24);
  assert.equal(stats.hand, 0);
  assert.ok(f.log.said.some((m) => /not working at all/.test(m)));
});

test('a bot that cannot be put on its spots: given up after six, the farm is the same', async () => {
  const plan = ironFarmPlan();
  const f = fake(plan, { noStand: true });
  const stats = await runBuild(plan, f.hands, { after: afterFor(plan, f.world) });
  assert.deepEqual(sameAsPlan(plan, f.world), []);
  assert.match(stats.gaveUp, /could not be put/);
  assert.ok(stats.standFails >= 6 && stats.standFails < 40);
});

test('out of time: the rest is done by command', async () => {
  const plan = ironFarmPlan();
  const f = fake(plan);
  const stats = await runBuild(plan, f.hands, { after: afterFor(plan, f.world), maxTicks: 3000 });
  assert.deepEqual(sameAsPlan(plan, f.world), []);
  assert.equal(stats.gaveUp, 'out of time');
  assert.ok(stats.hand > 50 && stats.hand < stats.cells * 0.9);
});

test('stopped halfway and run again on the same world: it carries on, placing only what is missing', async () => {
  const plan = ironFarmPlan();
  const world = new Map(), inv = {};
  const a = fake(plan, { world, inv, stopAfter: 400 });
  await assert.rejects(runBuild(plan, a.hands, { after: afterFor(plan, world) }), /stopped/);
  const had = [...world.values()].filter((id) => id === 'dirt').length;
  assert.ok(had > 300 && had < 600, `${had} dirt after the stop`);
  const b = fake(plan, { world, inv });
  const stats = await runBuild(plan, b.hands, { after: afterFor(plan, world) });
  assert.deepEqual(b.log.violations, []);
  assert.deepEqual(sameAsPlan(plan, world), []);
  assert.ok(stats.already >= had, `${stats.already} already there`);
  assert.ok(stats.hand < stats.cells - had + 5);
});

test('slabs go only on the top of the block under them (anywhere else a click can make a top slab, which mobs spawn on)', async () => {
  const plan = ironFarmPlan();
  const f = fake(plan);
  const stats = await runBuild(plan, f.hands, { after: afterFor(plan, f.world) });
  assert.deepEqual(f.log.violations, []);
  assert.ok(stats.handById[SLAB] > 100, `${stats.handById[SLAB]} slabs by hand`);
});

test('slips of the hand (a second block where the plan has none): the tidy at the end takes every one out, and the farm is the plan', async () => {
  const plan = ironFarmPlan();
  const f = fake(plan, { slip: 0.05, seed: 3, tidy: true });
  const stats = await runBuild(plan, f.hands, { after: afterFor(plan, f.world) });
  assert.ok(f.log.slips.length > 10, `${f.log.slips.length} slips`);
  assert.deepEqual(sameAsPlan(plan, f.world), []);
  assert.ok(stats.strays > 0 && stats.strays <= f.log.slips.length, `${stats.strays} strays for ${f.log.slips.length} slips`);
  assert.equal(stats.hand + stats.command + stats.already, stats.cells);
});

test('the pack always has what the layer needs, and never more than a layer\'s worth is asked for (a bot has 36 slots)', async () => {
  const plan = ironFarmPlan();
  const f = fake(plan);
  const asked = [];
  const stock = f.hands.stock;
  f.hands.stock = (id, n) => { asked.push([id, n]); stock(id, n); };
  await runBuild(plan, f.hands, { after: afterFor(plan, f.world) });
  assert.deepEqual(f.log.violations.filter((v) => /^out of/.test(v)), []);
  const most = Math.max(...asked.filter(([id]) => id === 'dirt').map(([, n]) => n));
  assert.ok(most <= 330, `${most} dirt asked for at once`);
  assert.ok(asked.every(([id, n]) => Math.ceil(n / 64) <= 6), 'no more than six stacks of anything at a time');
});

test('the layers are built bottom to top, the slabs last; the commands for a layer run when its blocks are down', async () => {
  const plan = ironFarmPlan();
  const f = fake(plan);
  const order = [];
  const base = afterFor(plan, f.world);
  const stats = await runBuild(plan, f.hands, { after: async (y) => { order.push(y); await base(y); } });
  const ys = order.filter((y) => y !== 'slabs');
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b));
  assert.equal(order.at(-1), 'slabs');
  assert.deepEqual(ys, Array.from({ length: plan.bounds.y2 - plan.bounds.y1 + 1 }, (_, i) => plan.bounds.y1 + i));
  assert.deepEqual(stats.layers.filter((l) => !l.slabs).map((l) => l.y), [...stats.layers.filter((l) => !l.slabs).map((l) => l.y)].sort((a, b) => a - b));
  // no slab goes down before the last layer of dirt
  const lastDirt = stats.layers.findLastIndex((l) => !l.slabs), firstSlab = stats.layers.findIndex((l) => l.slabs);
  assert.ok(lastDirt < firstSlab);
});

test('quick enough to run in the game: the planning for the whole farm in a fraction of a second of a second Node', async () => {
  const plan = ironFarmPlan();
  const f = fake(plan);
  const t = Date.now();
  await runBuild(plan, f.hands, { after: afterFor(plan, f.world) });
  assert.ok(Date.now() - t < 4000, `${Date.now() - t} ms`);
});
