// The recorder (game/demo.js) on stand-in events: what a player does becomes the rows the brain reads,
// only the named player is recorded, and nothing is recorded when it's off.
//   node tools/sim_learn.mjs
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Demo } = await import('../behavior_pack/scripts/game/demo.js');
const { system, world } = MC;

const me = { name: 'Branden', isValid: true, isSprinting: true, isSneaking: false, isOnGround: true, selectedSlotIndex: 0, dimension: { id: 'minecraft:overworld' }, location: { x: 10.123, y: 64, z: -3.5 },
  getComponent: (c) => (c === 'minecraft:health' ? { currentValue: 17.25 } : c === 'minecraft:player.hunger' ? { currentValue: 13 } : c === 'minecraft:inventory' ? { container: { getItem: () => ({ typeId: 'minecraft:stone_pickaxe' }) } } : undefined) };
const other = { name: 'Alex' };
world.getPlayers = () => [me];
const d = new Demo({});
const rows = () => d.buf.map((r) => r.k);

// off: nothing recorded
d.onBreak({ player: me, block: { location: { x: 1, y: 2, z: 3 } }, brokenBlockPermutation: { type: { id: 'minecraft:stone' } } });
const quietWhenOff = d.buf.length === 0;

d.start('Branden');
system.currentTick = 20; d.tick(20);
d.onBreak({ player: me, block: { location: { x: 1, y: -50, z: 3 } }, brokenBlockPermutation: { type: { id: 'minecraft:deepslate_iron_ore' } }, itemStackBeforeBreak: { typeId: 'minecraft:stone_pickaxe' } });
d.onBreak({ player: other, block: { location: { x: 9, y: 9, z: 9 } }, brokenBlockPermutation: { type: { id: 'minecraft:dirt' } } }); // someone else
d.onPlace({ player: me, block: { location: { x: 2, y: -50, z: 3 }, typeId: 'minecraft:torch' } });
d.onEat({ source: me, itemStack: { typeId: 'minecraft:cooked_beef' } });
d.onHurt({ hurtEntity: me, damageSource: { cause: 'entityAttack', damagingEntity: { typeId: 'minecraft:zombie' } }, damage: 3 });
d.onHurt({ hurtEntity: { typeId: 'minecraft:zombie' }, damageSource: { damagingEntity: me }, damage: 7 });
d.onDie({ deadEntity: { typeId: 'minecraft:zombie' }, damageSource: { damagingEntity: me } });
d.onDie({ deadEntity: me, damageSource: { cause: 'fall' } });
const got = d.buf.slice();
const find = (k) => got.find((r) => r.k === k);

const checks = [
  ['nothing recorded while off', quietWhenOff],
  ['a sample has where, health, food, hand, sprint', JSON.stringify(find('s')) && find('s').x === 10.1 && find('s').hp === 17.3 && find('s').food === 13 && find('s').h === 'stone_pickaxe' && find('s').sp === 1],
  ['a break has the block, the place and the tool', find('b')?.id === 'deepslate_iron_ore' && find('b').y === -50 && find('b').tool === 'stone_pickaxe'],
  ["someone else's break is not recorded", got.filter((r) => r.k === 'b').length === 1],
  ['a placed torch', find('p')?.id === 'torch'],
  ['eating', find('eat')?.item === 'cooked_beef'],
  ['being hurt, and by what', find('hurt')?.by === 'zombie' && find('hurt').amt === 3],
  ['hitting something', find('hit')?.target === 'zombie' && find('hit').amt === 7],
  ['a kill and a death', find('kill')?.mob === 'zombie' && find('die')?.cause === 'fall'],
  ['status says what it is doing', /recording Branden/.test(d.status())],
];
d.stop();
checks.push(['stopping is a row, then nothing', d.buf.some((r) => r.k === 'stop') || d.buf.length === 0, ]);
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`);
process.exit(checks.every((c) => c[1]) ? 0 : 1);
