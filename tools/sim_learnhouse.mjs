// Learning your house (game/demo.js house mode) on a stand-in player and world: `learn house` puts your
// things aside and gives the kit, the placed blocks are tracked, `learn off` reads the world, builds the
// plan and gives your things back, exactly as they were. Also: a house that fails the checks, your things
// when the server restarted mid-way, and coming back after leaving.
//   node tools/sim_learnhouse.mjs
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Demo } = await import('../behavior_pack/scripts/game/demo.js');
const { WorldMemory } = await import('../behavior_pack/scripts/game/memory.js');
const { getPlan, setPlan } = await import('../behavior_pack/scripts/core/learnhouse.js');
const { house } = await import('../tests/learn_fixture.js');
const { world } = MC;

// A pack that hands back the very objects it holds (the game's stacks keep their enchantments and names).
class Pack extends MC.Container {
  getItem(i) { return this.slots[i]; }
  setItem(i, it) { this.slots[i] = it; }
}
const stack = (id, n, extra = {}) => Object.assign(new MC.ItemStack(id, n), extra);
function player() {
  const pack = new Pack(36);
  pack.setItem(0, stack('diamond_pickaxe', 1, { nameTag: 'Old Faithful', enchants: ['efficiency 5'] }));
  pack.setItem(1, stack('cooked_beef', 40));
  pack.setItem(9, stack('written_book', 1, { pages: ['a note'] }));
  pack.setItem(35, stack('diamond', 12));
  return { name: 'Branden', id: 'p1', isValid: true, isSprinting: false, isSneaking: false, isOnGround: true, selectedSlotIndex: 0, dimension: null, location: { x: 0, y: 64, z: 0 }, sent: [],
    sendMessage(t) { this.sent.push(t); }, getComponent: (c) => (c === 'minecraft:inventory' ? { container: pack } : undefined), pack };
}
const idsOf = (pack) => { const o = {}; for (let i = 0; i < pack.size; i++) { const it = pack.getItem(i); if (it) o[it.typeId.replace('minecraft:', '')] = (o[it.typeId.replace('minecraft:', '')] ?? 0) + it.amount; } return o; };

async function run(label, opts, fn) {
  const h = house(opts);
  const dim = { id: 'overworld', getBlock: (p) => { const id = h.get(p.x, p.y, p.z) ?? 'air'; return { typeId: `minecraft:${id}`, permutation: { getState: () => h.heads.has(`${p.x},${p.y},${p.z}`) } }; } };
  const me = player();
  me.dimension = dim;
  world.getPlayers = () => [me];
  const said = [];
  const agent = { memory: new WorldMemory(), say: (t) => said.push(t), dim };
  const d = new Demo(agent);
  return fn({ h, me, d, said, agent, dim });
}
const checks = [];
const ok = (n, c, det = '') => checks.push([n, !!c, det]);

// 1. A good house.
await run('good', {}, async ({ h, me, d, said, agent }) => {
  setPlan(null);
  const before = idsOf(me.pack);
  const msg = d.startHouse(me);
  const during = idsOf(me.pack);
  ok('your things are put aside', !during.diamond_pickaxe && !during.diamond && !during.cooked_beef && !during.written_book, JSON.stringify(during));
  ok('you were given the kit', during.cobblestone >= 128 && during.oak_door === 2 && during.bed === 1 && during.furnace === 2 && during.chest === 4 && during.torch === 16, JSON.stringify(during));
  ok('recording in house mode', d.on && d.mode === 'house' && /house/.test(msg));
  ok('put aside in the world memory too (a restart)', agent.memory.data.learnKit?.slots?.length === 4);
  // Build: every placed block, a stray block placed and broken again, a pillar far off.
  for (const k of h.placed) { const [x, y, z] = k.split(',').map(Number); d.onPlace({ player: me, block: { location: { x, y, z }, typeId: `minecraft:${h.get(x, y, z)}` } }); }
  d.onPlace({ player: me, block: { location: { x: 3, y: 1, z: 3 }, typeId: 'minecraft:dirt' } });
  d.onBreak({ player: me, block: { location: { x: 3, y: 1, z: 3 } }, brokenBlockPermutation: { type: { id: 'minecraft:dirt' } } });
  for (let y = 1; y < 6; y++) d.onPlace({ player: me, block: { location: { x: 50, y, z: 50 }, typeId: 'minecraft:cobblestone' } });
  d.stop();
  await new Promise((r) => setTimeout(r, 30));
  ok('the plan was learned and kept', !!getPlan() && typeof MC.world.getDynamicProperty('agent:houseplan') === 'string', said.join(' | '));
  ok('it told you', said.some((t) => /Learned your house/.test(t)), said.join(' | '));
  ok('your things are back, the very same stacks', idsOf(me.pack).diamond_pickaxe === 1 && me.pack.getItem(0).nameTag === 'Old Faithful' && me.pack.getItem(0).enchants[0] === 'efficiency 5' && me.pack.getItem(9).pages[0] === 'a note' && idsOf(me.pack).cooked_beef === 40 && idsOf(me.pack).diamond === 12, JSON.stringify(idsOf(me.pack)));
  ok('and the kit is gone', !idsOf(me.pack).cobblestone && !idsOf(me.pack).oak_door, JSON.stringify(idsOf(me.pack)));
  ok('slots are as they were', me.pack.getItem(35)?.typeId.endsWith('diamond') && me.pack.getItem(9)?.typeId.endsWith('written_book'));
  ok('nothing left put aside', !agent.memory.data.learnKit);
  void before;
});

// 2. A house with no bed: not learned (the starter stays), your things back all the same.
await run('no bed', { noBed: true }, async ({ h, me, d, said, agent }) => {
  setPlan(null);
  d.startHouse(me);
  for (const k of h.placed) { const [x, y, z] = k.split(',').map(Number); d.onPlace({ player: me, block: { location: { x, y, z }, typeId: `minecraft:${h.get(x, y, z)}` } }); }
  d.stop();
  await new Promise((r) => setTimeout(r, 30));
  ok('a house with no bed is not learned', getPlan() === null && said.some((t) => /no bed/.test(t)), said.join(' | '));
  ok('and your things are back', idsOf(me.pack).diamond_pickaxe === 1 && idsOf(me.pack).diamond === 12);
});

// 3. Nothing placed.
await run('nothing', {}, async ({ me, d, said }) => {
  d.startHouse(me);
  d.stop();
  await new Promise((r) => setTimeout(r, 30));
  ok('nothing placed: says so, things back', said.some((t) => /Nothing was placed/.test(t)) && idsOf(me.pack).diamond === 12);
});

// 4. The server restarted between: the stash in memory is gone, the saved copy puts it back; a second start while pending is refused.
await run('restart', {}, async ({ me, d, agent }) => {
  d.startHouse(me);
  const msg2 = d.startHouse(me);
  ok('a second start while one is pending is refused', /still put aside/.test(msg2));
  d.stash = null; d.name = null; d.mode = null; // (a restart: the stacks in memory are gone, the world memory stays)
  ok('restore from the saved copy', d.restoreFor(me) && idsOf(me.pack).diamond === 12 && idsOf(me.pack).diamond_pickaxe === 1 && !idsOf(me.pack).cobblestone);
});

// 5. They left mid-recording and came back: restored on rejoin.
await run('rejoin', {}, async ({ me, d, agent }) => {
  d.startHouse(me);
  d.name = null; d.mode = null; d.stash = null; // (it stopped when they left; the finish couldn't hand anything back)
  d.restoreOnJoin(me);
  ok('rejoining gives your things back', idsOf(me.pack).diamond === 12 && !agent.memory.data.learnKit && me.sent.some((t) => /back/.test(t)));
});

for (const [n, c, d] of checks) console.log(`${c ? 'PASS' : 'FAIL'} ${n}${!c && d ? ` (${d})` : ''}`);
process.exit(checks.every((c) => c[1]) ? 0 : 1);
