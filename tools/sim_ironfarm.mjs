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
const { ironFarmPlan, render, settleWater, waterSources, PLATFORM, WATER_Y, SIGNS, CAMPFIRES, CHESTS, DOOR, BASE_Y, GATES, LAVA, CHAMBER_WATER, CHAMBER_WET } = await import('../behavior_pack/scripts/core/ironfarm.js');
const VERBOSE = process.argv.includes('-v');
const G = globalThis.__ifw;
const plan = ironFarmPlan();
const ref = render(plan);
const cellsPlan = ref.cells;
const SLABS = [...cellsPlan.values()].filter((v) => v.id === 'cobblestone_slab').length;
const OPPOSITE = { 2: 3, 3: 2, 4: 5, 5: 4 };

function reset(knobs = {}) {
  G.grid.clear(); G.log.length = 0; G.tick = 0; G.entities.length = 0; G.awake.clear(); G.knobs = knobs; G.intervals.clear(); G.time = 0; G.tickRate = undefined; G.rts = undefined;
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
let x4;
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
const FIELD = settleWater(ref, waterSources(), WATER_Y);
const wetNow = (o, c) => { const x = at(o, c.x, c.y, c.z); return !!x && (x.id === 'water' || x.id === 'flowing_water'); };
const hallWet = (o) => CHAMBER_WET.filter((c) => wetNow(o, c)).length;
const wetCells = (o) => [...FIELD.field.keys()].filter((k) => { const [x, z] = k.split(',').map(Number); const c = at(o, x, WATER_Y, z); return c && (c.id === 'water' || c.id === 'flowing_water'); }).length;
const WANT_WET = FIELD.field.size;
/** Source blocks (depth 0) on the platform layer of a built farm. */
const sourceCells = (o) => [...G.grid].filter(([k, c]) => { const y = Number(k.split(',')[1]); return y === o.y + WATER_Y && (c.id === 'water' || c.id === 'flowing_water') && (c.states?.liquid_depth ?? 0) === 0; }).length;

t('everything is where the plan says: water over the whole platform (48 sources, none made by the game, the hole itself dry), four open gates over the hole, the hallway with its one water source, TWO campfires, the lava held by its signs, nothing extra', async () => {
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
  ok(FIELD.converted.length === 0, `the plan's water would convert ${FIELD.converted.length} cells`);
  ok(WANT_WET === 236 && wetCells(o) === 236, `${wetCells(o)} wet cells of ${WANT_WET}`);
  ok(sourceCells(o) === 48, `${sourceCells(o)} source blocks on the platform: the water has pooled`);
  ok([...G.grid.values()].filter((c) => c.id === 'lava').length === 1 && at(o, LAVA.x, LAVA.y, LAVA.z)?.id === 'lava', 'the lava is not the one block');
  ok(GATES.every((q) => at(o, q.x, q.y, q.z)?.id === 'fence_gate' && at(o, q.x, q.y, q.z).states.open_bit === true), 'a gate is missing or shut');
  ok(!(x4 = [7, 8].flatMap((x) => [7, 8].map((z) => at(o, x, WATER_Y, z)))).some((c) => c && /water/.test(c.id)), 'water over the hole');
  ok(hallWet(o) === 4 && wetNow(o, CHAMBER_WATER), `${hallWet(o)} wet hallway cells`);
  ok(CAMPFIRES.every((c) => !wetNow(o, c)), 'water in a campfire\'s cell');
  ok(CAMPFIRES.length === 2, `${CAMPFIRES.length} campfires`);
  ok(CAMPFIRES.every((c) => at(o, c.x, c.y - 1, c.z)?.id === 'hopper'), 'a campfire without a hopper under it');
  ok(SIGNS.every((s) => at(o, s.x, s.y, s.z)?.id === 'wall_sign'), 'a sign is missing');
  ok(CAMPFIRES.every((c) => at(o, c.x, c.y, c.z)?.id === 'campfire'), 'a campfire is missing');
  ok(at(o, DOOR.x, DOOR.y, DOOR.z)?.id === 'wooden_door' && at(o, DOOR.x, DOOR.y + 1, DOOR.z)?.id === 'wooden_door', 'no door');
  ok(chat().some((l) => /Water: flowing over the whole platform.*the hole itself dry/.test(l)), `the water report is wrong: ${chat().filter((l) => /Water:/.test(l))}`);
  ok(chat().some((l) => /Hallway water: running \(north and east of its source, along the north wall\) \(4 of 4 cells wet\)/.test(l)), `the hallway report: ${chat().filter((l) => /Hallway/.test(l))}`);
  ok(chat().some((l) => /a double chest \(54 slots\)/.test(l)), `no word of the double chest: ${chat().filter((l) => /Chest/.test(l))}`);
  ok(chat().some((l) => /Golem spawn spots.*centre 7,1,7: 205 on the platform, 0 elsewhere.*centre 8,1,8: 205 on the platform, 0 elsewhere/.test(l)), `the spawn scan: ${chat().filter((l) => /Golem spawn spots/.test(l))}`);
  ok(chat().some((l) => new RegExp(`Slabs: ${SLABS} placed`).test(l)), `the slab count: ${chat().filter((l) => /Slabs/.test(l))}`);
  ok(!chat().some((l) => /NOT|Not as planned|failed/.test(l)), `something reported trouble: ${chat().filter((l) => /NOT|Not as planned|failed/.test(l))}`);
  ok(tele.length >= 1, 'not teleported');
});

t('a game that names the sign side the other way round: the signs are turned, stay, and the water goes in', async () => {
  const o = await built({ invertSigns: true });
  ok(SIGNS.every((s) => at(o, s.x, s.y, s.z)?.id === 'wall_sign'), 'a sign is missing');
  ok(wetCells(o) === WANT_WET, 'no water');
  ok(chat().some((l) => /the other way round/.test(l)), 'no word about the turn');
  ok(SIGNS.every((s) => at(o, s.x, s.y, s.z).states.facing_direction === OPPOSITE[s.facing]), 'not turned');
});

t('signs that will not be placed (no spelling accepted): no lava, and it says so; the water still goes in (u218: the gates, not signs, keep it out of the hole)', async () => {
  const o = await built({ noSignName: ['wall_sign', 'oak_wall_sign', 'spruce_wall_sign'] });
  ok(o, 'it did not build');
  ok(wetCells(o) >= 236, `${wetCells(o)} wet cells: the platform water was held back`);
  ok(![...G.grid.values()].some((c) => c.id === 'lava'), 'lava was put in with nothing to hold it');
  ok(hallWet(o) === 4, `${hallWet(o)} hallway cells wet: the campfires, not signs, hold the hallway water, so it goes in`);
  ok(chat().some((l) => /lava was NOT placed/i.test(l)) && !chat().some((l) => /Hallway water: not placed/.test(l)), `no word about the lava, or the hallway water was held back: ${chat().filter((l) => /lava|Hallway/i.test(l))}`);
});

t('water that only spreads after a block update: the nudge from a neighbour does it', async () => {
  const o = await built({ water: 'needsKick' });
  ok(wetCells(o) === WANT_WET, `${wetCells(o)} wet cells`);
  ok(chat().some((l) => /block update beside the sources: 236 of 236/.test(l)), chat().filter((l) => /Water/.test(l)).join(' | '));
  ok(!chat().some((l) => /by hand/.test(l)), 'laid by hand when it did not need to be');
});

t('water that never spreads: laid by hand, cell by cell, at the depths it would have, and reported as such', async () => {
  const o = await built({ water: 'never' });
  ok(wetCells(o) === WANT_WET, `${wetCells(o)} wet cells`);
  const lv = FIELD.field;
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
  ok(slabs.length === SLABS && SLABS > 100, `${slabs.length} slabs in the plan`);
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

t('a hill nearby: refused as uneven, and "build force" builds with dirt under the room', async () => {
  const hill = (x) => (x >= 105 ? 99 : 69);
  const o = await built({ groundAt: hill });
  ok(!o && chat().some((l) => /uneven/.test(l)), chat().join(' | '));
  const f = await built({ groundAt: hill }, ['build', 'force']);
  ok(f, 'forced build did not build');
  ok(f.y + BASE_Y === 100, `floor at ${f.y + BASE_Y}`);
  ok(at(f, 10, -30, 7)?.id === 'dirt' && at(f, 10, -8, 7)?.id === 'dirt', 'no foundation under the room');
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
  ok(wetCells(o) === WANT_WET && CAMPFIRES.every((c) => at(o, c.x, c.y, c.z)?.id === 'campfire'), 'forced build is not whole');
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
  ok(at(o, -1, 6, 7)?.id === 'dirt' && at(o, -1, 7, 7)?.id === 'cobblestone_slab', 'nothing to stand on at the top view');
  ok(pod.y === o.y + 1 && pod.x === o.x + 2.5 && pod.z === o.z + 8.5 && !at(o, 2, 1, 8) && at(o, 2, 0, 8)?.id === 'dirt', 'pod view');
  ok(out.x === o.x + 17.5 && out.y === o.y - 7 && !at(o, 17, -7, 7), 'out view is not on open ground');
  ok(room.y === o.y - 6 && !at(o, 11, -6, 8) && at(o, 11, -7, 8)?.id === 'dirt', 'room view');
});

t('clear takes the water first and then the whole box, leaving nothing', async () => {
  const o = await built();
  ok(o, 'it did not build');
  const mark = G.log.length;
  ironFarmCommand(player, ['clear']);
  await settle(/Cleared/);
  ok(G.grid.size === 0, `${G.grid.size} blocks left`);
  const fills = G.log.map((l, i) => ({ l, i })).filter((q) => q.i >= mark && /^fill .* air$/.test(q.l));
  const water = fills.filter((q) => { const m = q.l.split(' '); return Number(m[2]) === o.y + WATER_Y && Number(m[5]) === o.y + WATER_Y; });
  const whole = fills.find((q) => { const m = q.l.split(' '); return Number(m[5]) - Number(m[2]) > 10; });
  ok(water.length === 4 && whole && water.every((q) => q.i < whole.i), `water rows out at ${water.map((q) => q.i)}, the whole box at ${whole?.i}`);
  const lavaOut = G.log.findIndex((l, i) => i >= mark && l === `setblock ${o.x + LAVA.x} ${o.y + LAVA.y} ${o.z + LAVA.z} air`);
  const hallOut = G.log.findIndex((l, i) => i >= mark && l === `setblock ${o.x + CHAMBER_WATER.x} ${o.y + CHAMBER_WATER.y} ${o.z + CHAMBER_WATER.z} air`);
  ok(lavaOut > 0 && hallOut > 0 && lavaOut < whole.i && hallOut < whole.i, `the lava out at ${lavaOut}, the hallway water at ${hallOut}, the whole box at ${whole.i}`);
});

/** u209's corner put back on the north-west of a built farm: (0,0) solid, sources at (1,0) and (0,1), (1,1) open water between them. */
function oldCorner(o) {
  const set = (x, z, c) => { const k = `${o.x + x},${o.y + WATER_Y},${o.z + z}`; G.grid.set(k, c); G.awake.add(k); };
  set(1, 0, { id: 'water', states: { liquid_depth: 0 } });
  set(0, 1, { id: 'water', states: { liquid_depth: 0 } });
  set(1, 1, { id: 'flowing_water', states: { liquid_depth: 2 } });
}

t('water that has pooled (cells turned into sources) is noticed: the status and the watcher say so', async () => {
  const o = await built();
  ok(sourceCells(o) === 48, `${sourceCells(o)} sources to start with`);
  // A source dropped into the second row: its neighbour touches two sources and becomes one, and so on along the row.
  const k = `${o.x + 3},${o.y + WATER_Y},${o.z + 1}`;
  G.grid.set(k, { id: 'water', states: { liquid_depth: 0 } });
  G.awake.add(k);
  await MC.system.waitTicks(400);
  ok(sourceCells(o) > 48, `the water did not pool in the model: ${sourceCells(o)} sources`);
  ironFarmCommand(player, ['status']);
  await settle(/Built .* min ago/);
  ok(chat().some((l) => /POOLING/.test(l)), `status does not say pooling: ${chat().filter((l) => /Water on/.test(l))}`);
  ok(chat().some((l) => /platform water is pooling/.test(l)), 'the watcher did not say pooling');
});

t('the model of the game\'s water rule has teeth: u209\'s corner (two edge sources and open water between them) turns the whole platform into sources', async () => {
  const o = await built();
  ok(o, 'it did not build');
  oldCorner(o);
  await MC.system.waitTicks(1000);
  ok(sourceCells(o) > 200, `${sourceCells(o)} sources: the corner did not turn the platform to sources`);
  ironFarmCommand(player, ['status']);
  await settle(/Built .* min ago/);
  ok(chat().some((l) => /POOLING/.test(l)), 'the status does not say pooling');
});

t('fence gates the game does not know: the farm is built without them and without the platform water (u218: nothing else keeps it out of the hole), says so, and does not stop', async () => {
  const o = await built({ noGateName: ['fence_gate', 'oak_fence_gate'] });
  ok(o, 'it did not build');
  ok(GATES.every((q) => !/gate/.test(at(o, q.x, q.y, q.z)?.id ?? '')), 'a gate is there');
  ok(wetCells(o) === 0, `${wetCells(o)} wet cells: the water went in with nothing over the hole`);
  ok(chat().some((l) => /gates over the hole are not all there/.test(l)), `no word about the water: ${chat().filter((l) => /Water|gates/.test(l))}`);
  ok(chat().some((l) => /Only 0 of 4 gates over the hole are in and open/.test(l)), `no word about the gates: ${chat().filter((l) => /gate/i.test(l))}`);
  ok(hallWet(o) === 4, 'the hallway did not get built');
});

t('a game with no "direction" state on fence gates: the next way of saying "open" is found, and all four gates are in and open', async () => {
  const o = await built({ gateNoDirection: true });
  ok(GATES.every((q) => at(o, q.x, q.y, q.z)?.id === 'fence_gate' && at(o, q.x, q.y, q.z).states.open_bit === true), 'a gate is missing or shut');
  ok(!chat().some((l) => /Only \d of 4 gates/.test(l)), 'it reported the gates as failed');
});

t('gates that read back shut whatever they are told: it says so, every spelling tried', async () => {
  const o = await built({ gateShut: true });
  ok(o, 'it did not build');
  ok(chat().some((l) => /reads back shut/.test(l)) && chat().some((l) => /Only 0 of 4 gates over the hole are in and open/.test(l)), `no word about the gates: ${chat().filter((l) => /gate/i.test(l))}`);
});

t('the lava: put in only with its signs; a sign gone (burned) and the watcher takes the lava out and says so; "lava on" refuses until it is back; "lava off" and "on" work', async () => {
  const o = await built();
  ok(at(o, LAVA.x, LAVA.y, LAVA.z)?.id === 'lava', 'no lava');
  const lavaSign = SIGNS.find((s) => s.group === 'lava');
  const key = `${o.x + lavaSign.x},${o.y + lavaSign.y},${o.z + lavaSign.z}`;
  const saved = G.grid.get(key);
  G.grid.delete(key);
  await MC.system.waitTicks(100);
  ok(!at(o, LAVA.x, LAVA.y, LAVA.z), 'the lava is still there with a sign gone');
  ok(chat().some((l) => /signs holding the lava is gone.*I have taken the lava out/.test(l)), `no word: ${chat().filter((l) => /lava/.test(l))}`);
  ironFarmCommand(player, ['lava', 'on']);
  await settle(/Not putting the lava in/);
  ok(!at(o, LAVA.x, LAVA.y, LAVA.z), 'lava went in with a sign missing');
  G.grid.set(key, saved);
  ironFarmCommand(player, ['lava', 'on']);
  await settle(/Lava back/);
  ok(at(o, LAVA.x, LAVA.y, LAVA.z)?.id === 'lava', 'lava not back');
  ironFarmCommand(player, ['lava', 'off']);
  await settle(/Lava removed/);
  ok(!at(o, LAVA.x, LAVA.y, LAVA.z), 'lava not removed');
});

t('the watcher notices a gate gone and a hallway campfire gone, once each', async () => {
  const o = await built();
  const gate = GATES[0];
  G.grid.delete(`${o.x + gate.x},${o.y + gate.y},${o.z + gate.z}`);
  const cs = CAMPFIRES[1];
  G.grid.delete(`${o.x + cs.x},${o.y + cs.y},${o.z + cs.z}`);
  await MC.system.waitTicks(400);
  ok(chat().filter((l) => /gates over the hole is gone or shut/.test(l)).length === 1, `gate warnings: ${chat().filter((l) => /gate/.test(l))}`);
  ok(chat().filter((l) => /1 of the 2 campfires in the hallway is gone or out/.test(l)).length === 1, `campfire warnings: ${chat().filter((l) => /campfire/.test(l))}`);
});

t('hallway water that never spreads: the three flowing cells are laid by hand and the report says so', async () => {
  const o = await built({ water: 'never' });
  ok(hallWet(o) === 4, `${hallWet(o)} wet hallway cells`);
  for (const c of CHAMBER_WET) ok((at(o, c.x, c.y, c.z).states?.liquid_depth ?? 0) === c.level, `hallway cell ${c.x},${c.z}: depth ${at(o, c.x, c.y, c.z).states?.liquid_depth}, wanted ${c.level}`);
  ok(chat().some((l) => /Hallway water: running.*placed by hand/.test(l)), chat().filter((l) => /Hallway/.test(l)).join(' | '));
});

t('status says how the gates, the hallway, the lava and the campfires are', async () => {
  await built();
  ironFarmCommand(player, ['status']);
  await settle(/Built .* min ago/);
  const l = chat().find((q) => /Built .* min ago/.test(q));
  ok(/0 of the 4 cells over the hole wet \(0 is right\)/.test(l) && /Gates over the hole: 4 in, 4 open/.test(l) && /Hallway: 4 of 4 cells wet/.test(l) && /Lava on/.test(l) && /Campfires lit\/lit\./.test(l), l);
  ok(!/Not as planned/.test(l), l);
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
  ok(G.rts === 5 && chat().some((l) => /Random ticks x5.*it was 1.*NOT the tick rate/.test(l)), `random tick speed ${G.rts}: ${chat().filter((l) => /Random/.test(l))}`);
  const before = G.time;
  await MC.system.waitTicks(10);
  ok(G.time - before === 10 * 4, `the clock moved ${G.time - before}`);
  ironFarmCommand(player, ['speed', 'normal']);
  await settle(/Speed back to normal/);
  ok(G.rts === 1, `random tick speed ${G.rts} after normal`);
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
