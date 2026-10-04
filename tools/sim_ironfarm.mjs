// The iron farm builder (game/ironfarm.js) run in Node against a fake world that takes `fill` / `setblock` (tools/mock/server_ironfarm.mjs), made
// awkward in the ways the builder has to cope with: signs that only hang the other way round, signs that will not stay at all, water that only
// spreads after a block update (or never), a slab spelt differently, ground in the way, something in the way. Each case says what a player
// would expect to find. No game involved: what the game really does with any of this is for the in-game run.
//
//   node tools/sim_ironfarm.mjs [-v]
import { register } from 'node:module';
register('./mock/hooks_ironfarm.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { ironFarmCommand } = await import('../behavior_pack/scripts/game/ironfarm.js');
const { ironFarmPlan, render, waterField, PLATFORM, SOURCE, LAVA, SIGNS } = await import('../behavior_pack/scripts/core/ironfarm.js');
const VERBOSE = process.argv.includes('-v');
const G = globalThis.__ifw;
const plan = ironFarmPlan();
const ref = render(plan);
const cellsPlan = ref.cells;

function reset(knobs = {}) {
  G.grid.clear(); G.log.length = 0; G.tick = 0; G.entities.length = 0; G.awake.clear(); G.knobs = knobs;
}
const tele = [];
const player = { location: { x: 100.5, y: 70, z: 100.5 }, dimension: MC.dimension, teleport(l) { tele.push(l); } };
G.players = [player];
const settle = async (until, max = 400) => { for (let i = 0; i < max; i++) { await new Promise((r) => setImmediate(r)); if (G.log.some((l) => until.test(l))) { await new Promise((r) => setImmediate(r)); return true; } } return false; };
const chat = () => G.log.filter((l) => l.startsWith('CHAT ')).map((l) => l.slice(5));
const origin = () => {
  const m = chat().map((l) => /Building at (-?\d+) (-?\d+) (-?\d+)/.exec(l)).find(Boolean);
  return m ? { x: Number(m[1]) - plan.bounds.x1, y: Number(m[2]) - plan.bounds.y1, z: Number(m[3]) - plan.bounds.z1 } : null;
};
const at = (o, x, y, z) => G.grid.get(`${x + o.x},${y + o.y},${z + o.z}`);

let failed = 0;
const cases = [];
const t = (name, fn) => cases.push({ name, fn });
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

async function built(knobs = {}, args = ['build']) {
  reset(knobs);
  ironFarmCommand(player, args);
  await settle(/viewing room|in the way|Too high|fails its own/);
  return origin();
}
const waterCells = (o) => [...waterField(ref, [SOURCE], PLATFORM.y1).keys()].filter((k) => { const [x, z] = k.split(',').map(Number); const c = at(o, x, PLATFORM.y1, z); return c && (c.id === 'water' || c.id === 'flowing_water'); }).length;

t('everything is where the plan says, water over the whole platform, lava in, nothing extra', async () => {
  const o = await built();
  ok(o, 'it did not build');
  for (const [k, v] of cellsPlan) {
    const [x, y, z] = k.split(',').map(Number);
    const c = at(o, x, y, z);
    ok(c, `nothing at ${k} (wanted ${v.id})`);
    ok(c.id === v.id, `${k}: ${c.id}, wanted ${v.id}`);
  }
  const extra = [...G.grid.keys()].filter((k) => { const [x, y, z] = k.split(',').map(Number); return !cellsPlan.has(`${x - o.x},${y - o.y},${z - o.z}`); });
  ok(extra.every((k) => G.grid.get(k).id === 'flowing_water'), `extra blocks: ${extra.filter((k) => G.grid.get(k).id !== 'flowing_water').slice(0, 3)}`);
  ok(waterCells(o) === 16, `${waterCells(o)} wet cells`);
  ok(at(o, LAVA.x, LAVA.y, LAVA.z).id === 'lava', 'no lava');
  ok(SIGNS.every((s) => at(o, s.x, s.y, s.z)?.id === 'wall_sign'), 'a sign is missing');
  ok(chat().some((l) => /Water: flowing over the whole platform/.test(l)), 'the water report is wrong');
  ok(!chat().some((l) => /NOT/.test(l)), `something reported NOT: ${chat().filter((l) => /NOT/.test(l))}`);
});

t('a game that names the sign side the other way round: the signs are turned, stay, and the lava goes in', async () => {
  const o = await built({ invertSigns: true });
  ok(SIGNS.every((s) => at(o, s.x, s.y, s.z)?.id === 'wall_sign'), 'a sign is missing');
  ok(at(o, LAVA.x, LAVA.y, LAVA.z)?.id === 'lava', 'no lava');
  ok(chat().some((l) => /the other way round/.test(l)), 'no word about the turn');
  ok(SIGNS.every((s) => at(o, s.x, s.y, s.z).states.facing_direction === ({ 2: 3, 3: 2, 4: 5, 5: 4 })[s.facing]), 'not turned');
});

t('signs that will not be placed (no spelling accepted): no lava is put in, and it says so', async () => {
  const o = await built({ noSignName: ['wall_sign', 'oak_wall_sign', 'spruce_wall_sign'] });
  ok(o, 'it did not build');
  ok(!at(o, LAVA.x, LAVA.y, LAVA.z), 'lava was placed with no signs');
  ok(chat().some((l) => /lava was NOT placed/i.test(l)), 'no word about the lava');
  ok(!G.log.some((l) => /setblock .* lava$/.test(l)), 'a lava command was sent');
});

t('water that only spreads after a block update: the nudge from a neighbour does it', async () => {
  const o = await built({ water: 'needsKick' });
  ok(waterCells(o) === 16, `${waterCells(o)} wet cells`);
  ok(chat().some((l) => /block update beside the source: 16 of 16/.test(l)), chat().filter((l) => /Water/.test(l)).join(' | '));
  ok(!chat().some((l) => /by hand/.test(l)), 'laid by hand when it did not need to be');
});

t('water that never spreads: laid by hand, cell by cell, at the depths it would have, and reported as such', async () => {
  const o = await built({ water: 'never' });
  ok(waterCells(o) === 16, `${waterCells(o)} wet cells`);
  const lv = waterField(ref, [SOURCE], PLATFORM.y1);
  for (const [k, l] of lv) {
    const [x, z] = k.split(',').map(Number);
    const c = at(o, x, PLATFORM.y1, z);
    ok((c.states?.liquid_depth ?? 0) === l, `${k}: depth ${c.states?.liquid_depth}, wanted ${l}`);
  }
  ok(chat().some((l) => /laid by hand/.test(l) && /Water: flowing/.test(l)), chat().filter((l) => /Water/.test(l)).join(' | '));
});

t('a slab that has another name: the next spelling is found and used for every roof', async () => {
  const o = await built({ noSlabName: ['cobblestone_slab'] });
  const slabs = [...cellsPlan].filter(([, v]) => v.id === 'cobblestone_slab');
  ok(slabs.length > 100, 'no slabs in the plan?');
  for (const [k] of slabs) { const [x, y, z] = k.split(',').map(Number); ok(at(o, x, y, z)?.id === 'stone_block_slab', `slab at ${k}: ${at(o, x, y, z)?.id}`); }
});

t('no slab name accepted: it builds the rest and says the roofs are bare', async () => {
  const o = await built({ noSlabName: ['cobblestone_slab', 'stone_block_slab', 'oak_slab', 'wooden_slab'] });
  ok(o, 'it did not build');
  ok(chat().some((l) => /NO slab spelling/.test(l)), 'no word about the slabs');
  ok(at(o, 3, 1, 3) === undefined && at(o, 4, 1, 3)?.id === 'torch' && at(o, 3, 4, 7)?.id === 'water' && at(o, 6, 1, 0)?.id === 'bed', 'the rest did not get built');
});

t('ground in the way of the spawn volume: the farm is built higher', async () => {
  const o = await built({ groundAt: () => 200 });
  ok(o, 'it did not build');
  ok(o.y + plan.centre.y - 6 >= 200 + 4, `centre at ${o.y + plan.centre.y}, ground 200`);
  ok(chat().some((l) => /Raised to clear the ground/.test(l)), 'no word about being raised');
});

t('ground too high to build above: it refuses', async () => {
  const o = await built({ groundAt: () => 310 });
  ok(!o && chat().some((l) => /Too high/.test(l)), chat().join(' | '));
});

t('something in the way: it refuses, and "build force" builds anyway', async () => {
  const o = await built();
  ironFarmCommand(player, ['clear']);
  await settle(/Cleared/);
  G.log.length = 0;
  const lo = `${o.x + plan.bounds.x1},${o.y + plan.bounds.y1},${o.z + plan.bounds.z1}`;
  G.grid.set(lo, { id: 'cobblestone' });
  ironFarmCommand(player, ['build']);
  await settle(/in the way/);
  ok(chat().some((l) => /in the way/.test(l)), 'did not refuse');
  ok(!G.log.some((l) => l.startsWith('fill')), 'it built anyway');
  G.log.length = 0;
  ironFarmCommand(player, ['build', 'force']);
  await settle(/viewing room/);
  ok(waterCells(o) === 16 && at(o, LAVA.x, LAVA.y, LAVA.z)?.id === 'lava', 'forced build is not whole');
});

t('view top / pod / the viewing room put you on the platform wall, among the villagers, behind the glass', async () => {
  const o = await built();
  tele.length = 0;
  ironFarmCommand(player, ['view', 'top']);
  ironFarmCommand(player, ['view', 'pod']);
  ironFarmCommand(player, ['view']);
  await settle(/viewing room\.$/);
  ok(tele.length === 3, `${tele.length} teleports`);
  const [top, pod, room] = tele;
  ok(top.x === o.x + 2.5 && top.y === o.y + 7.5 && top.z === o.z + 8.5, 'top view is not on the wall');
  ok(at(o, 2, 6, 8)?.id === 'cobblestone' && at(o, 2, 7, 8)?.id === 'cobblestone_slab', 'nothing to stand on at the top view');
  ok(pod.y === o.y + 1 && room.y === o.y + 4, 'pod / room heights');
});

t('clear takes the lava and water first and then the whole box, leaving nothing', async () => {
  const o = await built();
  ok(o, 'it did not build');
  ironFarmCommand(player, ['clear']);
  await settle(/Cleared/);
  ok(G.grid.size === 0, `${G.grid.size} blocks left`);
  const lavaAt = G.log.findIndex((l) => /setblock .* air$/.test(l) && l.includes(`${LAVA.x + o.x} ${LAVA.y + o.y} ${LAVA.z + o.z}`));
  const fillAt = G.log.findIndex((l, i) => i > lavaAt && /^fill .* air$/.test(l));
  ok(lavaAt >= 0 && fillAt > lavaAt, `lava out at ${lavaAt}, fill at ${fillAt}`);
});

for (const c of cases) {
  try { await c.fn(); console.log(`ok   ${c.name}`); } catch (e) { failed++; console.log(`FAIL ${c.name}\n     ${e.message}`); if (VERBOSE) console.log(chat().join('\n')); }
}
console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} cases pass`);
process.exit(failed ? 1 : 0);
