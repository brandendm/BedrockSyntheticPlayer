// Village sense (game/villages.js) on a stand-in agent and a constructed world: the lookout's glances
// (block ids), the villager query, raiders, the memory, the pick, and a visit that takes a bed and
// the chests' iron and bread.
//   node tools/sim_village.mjs
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Villages } = await import('../behavior_pack/scripts/game/villages.js');
const { WorldMemory } = await import('../behavior_pack/scripts/game/memory.js');

const ents = [];
const chestPack = new MC.Container(27);
for (const [id, n] of [['iron_ingot', 5], ['stick', 9], ['bread', 3], ['oak_sapling', 2], ['emerald', 1]]) chestPack.addItem(new MC.ItemStack(id, n));
const pack = new MC.Container(36);
const says = [];
const world = new Map([['bed', { id: 'red_bed', x: 205, y: 64, z: -296 }], ['chest', { id: 'chest', x: 210, y: 64, z: -300 }]]);
let mined = null;
const agent = {
  memory: new WorldMemory(),
  dim: { id: 'overworld', getEntities: () => ents, getBlock: (p) => (p.x === 210 && p.z === -300 ? { getComponent: () => ({ container: chestPack }) } : undefined) },
  sim: { location: { x: 120, y: 64, z: -180 }, getComponent: () => ({ container: pack }) },
  sayOnce: (k, t) => says.push(t), say: (t) => says.push(t),
  homestead: { house: null },
  motor: { lookAt: async () => {} },
  skills: {
    check: () => {}, wait: async () => {}, packUp: async () => {},
    travelToward: async (g, t) => { agent.sim.location = { x: t.x - 4, y: t.y, z: t.z - 4 }; return true; },
    scan: async () => [...world.values()], goNear: async () => true, reach: async () => true,
    mine: async (g, b) => { mined = b; pack.addItem(new MC.ItemStack('bed', 1)); return true; },
  },
};
const V = new Villages(agent);
const ev = (type, x, z) => ({ typeId: `minecraft:${type}`, location: { x, y: 64, z } });
const checks = [];
const ok = (n, c, d = '') => checks.push([n, !!c, d]);

// 1. Glances: paths and farmland far off, one at a time (the lookout's 3 s turns).
for (const [id, x, z] of [['dirt_path', 195, -300], ['dirt_path', 200, -303], ['hay_block', 208, -296], ['farmland', 212, -294], ['wheat', 213, -294], ['oak_planks', 220, -290], ['stone', 0, 0]]) {
  const e = V.seeBlock(id, x, 64, z);
  if (e) V.feed([e]);
}
ok('paths + hay are a village', V.known.length === 1, JSON.stringify(V.known[0]?.kinds));
ok('remembered in the world memory', agent.memory.data.villages?.length === 1);
ok('planks and stone are not evidence', V.seeBlock('oak_planks', 0, 0, 0) === null && V.seeBlock('stone', 0, 0, 0) === null);
ok('it said so', says.some((t) => /village/.test(t)));
ok('on the dashboard list', V.status().length === 1 && V.status()[0].x > 190 && !V.status()[0].danger);

// 2. Villagers in the entity query add to it.
ents.push(ev('villager', 203, -299), ev('villager', 207, -297), ev('zombie', 100, 0), ev('villager_v2', 220, -280));
const r = V.scanEntities();
ok('counts villagers, not zombies', r.villagers === 3 && r.raiders === 0, JSON.stringify(r));
ok('the score went up', V.known[0].score >= 20, `score ${V.known[0].score}`);

// 3. Pick: it's what we'd go to for a bed and for food.
ok('pick for sheep', V.pick('sheep')?.x > 190, JSON.stringify(V.pick('sheep')?.dist));

// 4. A visit: takes a bed, and the chest's iron/bread/emerald but not sticks or saplings.
const res = await V.visit(1, V.pick('sheep'), 'sheep');
const inv = {}; for (let i = 0; i < pack.size; i++) { const it = pack.getItem(i); if (it) inv[it.typeId.replace('minecraft:', '')] = (inv[it.typeId.replace('minecraft:', '')] ?? 0) + it.amount; }
ok('took the bed', inv.bed === 1 && mined?.id === 'red_bed', JSON.stringify(inv));
ok('took iron, bread and the emerald', inv.iron_ingot === 5 && inv.bread === 3 && inv.emerald === 1, JSON.stringify(inv));
ok('left the sticks and the sapling', !inv.stick && !inv.oak_sapling, '');
ok('says what it did', /bed/.test(res) && /item/.test(res), res);
ok('marked visited: not again for 15 minutes', V.pick('sheep') === null && V.known[0].visited > 0);

// 5. Raiders turn up: the place is marked, and visiting backs off.
agent.sim.location = { x: 120, y: 64, z: -180 };
V.known[0].visited = 0;
ents.push(ev('pillager', 215, -290));
V.scanEntities();
ok('raiders: danger on the list', V.status()[0].danger === true);
ok('raiders: not picked', V.pick('sheep') === null && V.pick('food') === null);
pack.setItem(0, undefined);
const res2 = await V.visit(1, { ...V.known[0], dist: 280 }, 'sheep');
ok('raiders: visit leaves it alone', res2 === 'raiders', res2);

// 6. Nothing but a lone farm: not a village.
const V2 = new Villages({ ...agent, memory: new WorldMemory() });
agent.memory = agent.memory; V2.a.memory.data.villages = [];
V2.feed([V2.seeBlock('farmland', 500, 64, 500), V2.seeBlock('wheat', 501, 64, 500), V2.seeBlock('farmland', 502, 64, 500)]);
ok('a lone farm is not a village', V2.known.length === 0);

for (const [n, c, d] of checks) console.log(`${c ? 'PASS' : 'FAIL'} ${n}${d && !c ? ` (${d})` : ''}`);
process.exit(checks.every((c) => c[1]) ? 0 : 1);
