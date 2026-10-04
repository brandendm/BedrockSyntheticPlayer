// The iron farm builder (game/ironfarm.js) run in Node against a fake world that takes `fill` / `setblock` (tools/mock/server_ironfarm.mjs), made
// awkward in the ways the builder has to cope with: signs that only hang the other way round, signs that will not stay at all, water that only
// spreads after a block update (or never), a slab or a door spelt differently or not at all, chests that will not pair, ground in the way or
// uneven, something in the way. Each case says what a player would expect to find. No game involved: what the game really does with any of this
// is for the in-game run.
//
//   node tools/sim_ironfarm.mjs [-v]
import { register } from 'node:module';
register('./mock/hooks_ironfarm.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { ironFarmCommand } = await import('../behavior_pack/scripts/game/ironfarm.js');
const { ironFarmPlan, render, waterField, waterSources, PLATFORM, WATER_Y, LAVA, SIGNS, CAMPFIRES, CHESTS, DOOR, BASE_Y } = await import('../behavior_pack/scripts/core/ironfarm.js');
const VERBOSE = process.argv.includes('-v');
const G = globalThis.__ifw;
const plan = ironFarmPlan();
const ref = render(plan);
const cellsPlan = ref.cells;
const OPPOSITE = { 2: 3, 3: 2, 4: 5, 5: 4 };

function reset(knobs = {}) {
  G.grid.clear(); G.log.length = 0; G.tick = 0; G.entities.length = 0; G.awake.clear(); G.knobs = knobs; G.intervals.clear(); G.time = 0; G.tickRate = undefined;
}
const tele = [];
const player = { location: { x: 100.5, y: 70, z: 100.5 }, dimension: MC.dimension, teleport(l) { tele.push(l); } };
G.players = [player];
const settle = async (until, max = 600) => { for (let i = 0; i < max; i++) { await new Promise((r) => setImmediate(r)); if (G.log.some((l) => until.test(l))) { await new Promise((r) => setImmediate(r)); return true; } } return false; };
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

const DONE = /You are in the room at the bottom|in the way|Too high|fails its own|is uneven/;
async function built(knobs = {}, args = ['build']) {
  reset(knobs);
  ironFarmCommand(player, args);
  await settle(DONE);
  return origin();
}
const wetCells = (o) => [...waterField(ref, waterSources(), WATER_Y).keys()].filter((k) => { const [x, z] = k.split(',').map(Number); const c = at(o, x, WATER_Y, z); return c && (c.id === 'water' || c.id === 'flowing_water'); }).length;
const WANT_WET = waterField(ref, waterSources(), WATER_Y).size;

t('everything is where the plan says, water over the whole platform, lava in, nothing extra', async () => {
  const o = await built();
  ok(o, 'it did not build');
  ok(o.y + BASE_Y === 70, `the tower's floor is at y ${o.y + BASE_Y}, the ground top was 69`);
  for (const [k, v] of cellsPlan) {
    const [x, y, z] = k.split(',').map(Number);
    const c = at(o, x, y, z);
    ok(c, `nothing at ${k} (wanted ${v.id})`);
    ok(c.id === v.id, `${k}: ${c.id}, wanted ${v.id}`);
  }
  const extra = [...G.grid.keys()].filter((k) => { const [x, y, z] = k.split(',').map(Number); return !cellsPlan.has(`${x - o.x},${y - o.y},${z - o.z}`); });
  ok(extra.every((k) => G.grid.get(k).id === 'flowing_water'), `extra blocks: ${extra.filter((k) => G.grid.get(k).id !== 'flowing_water').slice(0, 3)}`);
  ok(WANT_WET === 252 && wetCells(o) === 252, `${wetCells(o)} wet cells of ${WANT_WET}`);
  ok(at(o, LAVA.x, LAVA.y, LAVA.z).id === 'lava', 'no lava');
  ok(SIGNS.every((s) => at(o, s.x, s.y, s.z)?.id === 'wall_sign'), 'a sign is missing');
  ok(CAMPFIRES.every((c) => at(o, c.x, c.y, c.z)?.id === 'campfire'), 'a campfire is missing');
  ok(at(o, DOOR.x, DOOR.y, DOOR.z)?.id === 'wooden_door' && at(o, DOOR.x, DOOR.y + 1, DOOR.z)?.id === 'wooden_door', 'no door');
  ok(chat().some((l) => /Water: flowing over the whole platform/.test(l)), 'the water report is wrong');
  ok(chat().some((l) => /a double chest \(54 slots\)/.test(l)), `no word of the double chest: ${chat().filter((l) => /Chest/.test(l))}`);
  ok(chat().some((l) => /Golem spawn spots.*centre 7,1,7: 217 on the platform, 0 elsewhere.*centre 8,1,8: 217 on the platform, 0 elsewhere/.test(l)), `the spawn scan: ${chat().filter((l) => /Golem spawn spots/.test(l))}`);
  ok(chat().some((l) => /Slabs: 99 placed/.test(l)), `the slab count: ${chat().filter((l) => /Slabs/.test(l))}`);
  ok(!chat().some((l) => /NOT|Not as planned|failed/.test(l)), `something reported trouble: ${chat().filter((l) => /NOT|Not as planned|failed/.test(l))}`);
  ok(tele.length >= 1, 'not teleported');
});

t('a game that names the sign side the other way round: the signs are turned, stay, and the lava and water go in', async () => {
  const o = await built({ invertSigns: true });
  ok(SIGNS.every((s) => at(o, s.x, s.y, s.z)?.id === 'wall_sign'), 'a sign is missing');
  ok(at(o, LAVA.x, LAVA.y, LAVA.z)?.id === 'lava', 'no lava');
  ok(wetCells(o) === WANT_WET, 'no water');
  ok(chat().some((l) => /the other way round/.test(l)), 'no word about the turn');
  ok(SIGNS.every((s) => at(o, s.x, s.y, s.z).states.facing_direction === OPPOSITE[s.facing]), 'not turned');
});

t('signs that will not be placed (no spelling accepted): no lava and no water are put in, and it says so', async () => {
  const o = await built({ noSignName: ['wall_sign', 'oak_wall_sign', 'spruce_wall_sign'] });
  ok(o, 'it did not build');
  ok(!at(o, LAVA.x, LAVA.y, LAVA.z), 'lava was placed with no signs');
  ok(chat().some((l) => /lava was NOT placed/i.test(l)), 'no word about the lava');
  ok(chat().some((l) => /signs over the hole did not stay/i.test(l)), 'no word about the water');
  ok(!G.log.some((l) => /setblock .* lava$/.test(l)), 'a lava command was sent');
  ok(wetCells(o) === 0, 'water was put in with nothing to stop it going down the shaft');
});

t('water that only spreads after a block update: the nudge from a neighbour does it', async () => {
  const o = await built({ water: 'needsKick' });
  ok(wetCells(o) === WANT_WET, `${wetCells(o)} wet cells`);
  ok(chat().some((l) => /block update beside the sources: 252 of 252/.test(l)), chat().filter((l) => /Water/.test(l)).join(' | '));
  ok(!chat().some((l) => /by hand/.test(l)), 'laid by hand when it did not need to be');
});

t('water that never spreads: laid by hand, cell by cell, at the depths it would have, and reported as such', async () => {
  const o = await built({ water: 'never' });
  ok(wetCells(o) === WANT_WET, `${wetCells(o)} wet cells`);
  const lv = waterField(ref, waterSources(), WATER_Y);
  for (const [k, l] of lv) {
    const [x, z] = k.split(',').map(Number);
    const c = at(o, x, WATER_Y, z);
    ok((c.states?.liquid_depth ?? 0) === l, `${k}: depth ${c.states?.liquid_depth}, wanted ${l}`);
  }
  ok(chat().some((l) => /laid by hand/.test(l) && /Water: flowing/.test(l)), chat().filter((l) => /Water/.test(l)).join(' | '));
});

t('a slab that has another name: the next spelling is found and used for every top, the step too', async () => {
  const o = await built({ noSlabName: ['cobblestone_slab'] });
  const slabs = [...cellsPlan].filter(([, v]) => v.id === 'cobblestone_slab');
  ok(slabs.length === 99, `${slabs.length} slabs in the plan`);
  for (const [k] of slabs) { const [x, y, z] = k.split(',').map(Number); ok(at(o, x, y, z)?.id === 'stone_block_slab', `slab at ${k}: ${at(o, x, y, z)?.id}`); }
});

t('no slab name accepted: it builds the rest, says the tops are bare, and the spawn scan finds the golem spots that leaves', async () => {
  const o = await built({ noSlabName: ['cobblestone_slab', 'stone_block_slab', 'oak_slab', 'wooden_slab'] });
  ok(o, 'it did not build');
  ok(chat().some((l) => /NO slab spelling/.test(l)), 'no word about the slabs');
  ok(at(o, 3, 1, 3)?.id === 'torch' && at(o, 3, 4, 0)?.id === 'water' && at(o, 6, 1, 5)?.id === 'bed', 'the rest did not get built');
  ok(chat().some((l) => /Golem spawn spots.*[1-9]\d* elsewhere/.test(l)), `the scan should have found stray spots: ${chat().filter((l) => /Golem spawn spots/.test(l))}`);
});

t('a door the game will not take: an open doorway is left, and it says so', async () => {
  const o = await built({ noDoorName: ['wooden_door', 'oak_door'] });
  ok(o, 'it did not build');
  ok(!at(o, DOOR.x, DOOR.y, DOOR.z) && !at(o, DOOR.x, DOOR.y + 1, DOOR.z), 'something in the doorway');
  ok(chat().some((l) => /NO door was accepted/.test(l)), 'no word about the door');
});

t('chests that will not join: it tries again, then says they are two single chests', async () => {
  const o = await built({ noPair: true });
  ok(o, 'it did not build');
  ok(CHESTS.every((c) => at(o, c.x, c.y, c.z)?.id === 'chest'), 'a chest is missing');
  ok(chat().some((l) => /did NOT join into a double chest/.test(l)), chat().filter((l) => /Chest/.test(l)).join(' | '));
});

t('ground that rises a little: the tower stands on it, higher, and says so', async () => {
  const o = await built({ groundAt: () => 75 });
  ok(o, 'it did not build');
  ok(o.y + BASE_Y === 76, `floor at ${o.y + BASE_Y}`);
  ok(chat().some((l) => /ground rises 6 blocks/.test(l)), 'no word about the rise');
});

t('a hill nearby: refused as uneven, and "build force" builds with cobblestone under the room', async () => {
  const hill = (x) => (x >= 105 ? 99 : 69);
  const o = await built({ groundAt: hill });
  ok(!o && chat().some((l) => /uneven/.test(l)), chat().join(' | '));
  const f = await built({ groundAt: hill }, ['build', 'force']);
  ok(f, 'forced build did not build');
  ok(f.y + BASE_Y === 100, `floor at ${f.y + BASE_Y}`);
  ok(at(f, 10, -30, 7)?.id === 'cobblestone' && at(f, 10, -8, 7)?.id === 'cobblestone', 'no foundation under the room');
  ironFarmCommand(player, ['clear']);
  await settle(/Cleared/);
  ok(G.grid.size === 0, `${G.grid.size} blocks left (foundation not cleared?)`);
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
  await settle(/You are in the room/);
  ok(wetCells(o) === WANT_WET && at(o, LAVA.x, LAVA.y, LAVA.z)?.id === 'lava', 'forced build is not whole');
});

t('view top / pod / out / the room put you on the platform wall, among the villagers, outside the door, behind the glass', async () => {
  const o = await built();
  tele.length = 0;
  for (const m of ['top', 'pod', 'out']) ironFarmCommand(player, ['view', m]);
  ironFarmCommand(player, ['view']);
  await settle(/room at the bottom\.$/);
  ok(tele.length === 4, `${tele.length} teleports`);
  const [top, pod, out, room] = tele;
  ok(top.x === o.x - 0.5 && top.y === o.y + 7.5 && top.z === o.z + 7.5, 'top view is not on the wall');
  ok(at(o, -1, 6, 7)?.id === 'cobblestone' && at(o, -1, 7, 7)?.id === 'cobblestone_slab', 'nothing to stand on at the top view');
  ok(pod.y === o.y + 1 && pod.x === o.x + 2.5 && pod.z === o.z + 8.5 && !at(o, 2, 1, 8) && at(o, 2, 0, 8)?.id === 'cobblestone', 'pod view');
  ok(out.x === o.x + 16.5 && out.y === o.y - 7 && !at(o, 16, -7, 7), 'out view is not on open ground');
  ok(room.y === o.y - 6 && !at(o, 11, -6, 8) && at(o, 11, -7, 8)?.id === 'cobblestone', 'room view');
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

t('time: day / night set the time; fast runs the clock x N until normal', async () => {
  await built();
  ironFarmCommand(player, ['time', 'night']);
  await settle(/Time set to night/);
  ok(G.time === 13000, `time ${G.time}`);
  ironFarmCommand(player, ['time', 'fast', '20']);
  await settle(/clock now runs x20/);
  const before = G.time;
  await MC.system.waitTicks(10);
  ok(G.time - before === 10 * 19, `the clock moved ${G.time - before} in 10 ticks`);
  ironFarmCommand(player, ['time', 'normal']);
  await settle(/Clock back to normal/);
  const after = G.time;
  await MC.system.waitTicks(10);
  ok(G.time === after, 'the clock is still running fast');
});

t('speed: Bedrock has no /tick, so it says so and runs the clock; where the game has it, it uses it', async () => {
  await built();
  ironFarmCommand(player, ['speed', '5']);
  await settle(/no \/tick|would not take/);
  ok(chat().some((l) => /Bedrock has no \/tick/.test(l)), chat().filter((l) => /tick/.test(l)).join(' | '));
  const before = G.time;
  await MC.system.waitTicks(10);
  ok(G.time - before === 10 * 4, `the clock moved ${G.time - before}`);
  ironFarmCommand(player, ['speed', 'normal']);
  await settle(/Speed back to normal/);
  const t1 = G.time;
  await MC.system.waitTicks(5);
  ok(G.time === t1, 'still fast');
  await built({ tickRate: true });
  ironFarmCommand(player, ['speed', '5']);
  await settle(/Game speed x5/);
  ok(G.tickRate === 100, `tick rate ${G.tickRate}`);
});

t('golem: test golems are put on the platform cells that are not corners or the hole; auto makes more; off stops it', async () => {
  const o = await built();
  ironFarmCommand(player, ['golem', '3']);
  await settle(/3 test golems/);
  const gs = G.entities.filter((e) => e.typeId === 'minecraft:iron_golem');
  ok(gs.length === 3, `${gs.length} golems`);
  for (const e of gs) {
    const x = Math.floor(e.location.x - o.x), z = Math.floor(e.location.z - o.z);
    ok(e.location.y === o.y + WATER_Y && x >= PLATFORM.x1 && x <= PLATFORM.x2 && z >= PLATFORM.z1 && z <= PLATFORM.z2, `golem at ${x},${z}`);
    ok(!((x === 0 || x === 15) && (z === 0 || z === 15)) && !(x >= 7 && x <= 8 && z >= 7 && z <= 8), `golem in a corner or the hole: ${x},${z}`);
  }
  ironFarmCommand(player, ['golem', 'auto', '10']);
  await settle(/every 10 s/);
  ok(G.entities.filter((e) => e.typeId === 'minecraft:iron_golem').length === 4, 'no golem straight away');
  await MC.system.waitTicks(200);
  ok(G.entities.filter((e) => e.typeId === 'minecraft:iron_golem').length === 5, 'no second golem after 10 s');
  ironFarmCommand(player, ['golem', 'off']);
  await settle(/No more test golems/);
  await MC.system.waitTicks(400);
  ok(G.entities.filter((e) => e.typeId === 'minecraft:iron_golem').length === 5, 'still making golems');
  await MC.system.waitTicks(40);
  ok(chat().some((l) => /A TEST golem has been put/.test(l)), 'the watcher did not report the test golem');
});

for (const c of cases) {
  try { await c.fn(); console.log(`ok   ${c.name}`); } catch (e) { failed++; console.log(`FAIL ${c.name}\n     ${e.message}`); if (VERBOSE) console.log(chat().join('\n')); }
}
console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} cases pass`);
process.exit(failed ? 1 : 0);
