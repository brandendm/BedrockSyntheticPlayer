// The flight recorder (game/flight.js) on a stand-in agent: a bot stuck in place for 90 s must
// trip the watchdog, and the report must carry the steps, the pack, the route and the notes.
//   node tools/sim_flight.mjs
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Flight } = await import('../behavior_pack/scripts/game/flight.js');
const { trace } = await import('../behavior_pack/scripts/game/bridge.js');
const { system } = MC;

const printed = [];
const warn = console.warn; console.warn = (...a) => printed.push(a.join(' '));
const pack = new MC.Container(36); pack.addItem(new MC.ItemStack('cobblestone', 12)); pack.addItem(new MC.ItemStack('stone_pickaxe', 1));
const agent = {
  sim: { isSleeping: false, getComponent: (t) => (t === 'minecraft:inventory' ? { container: pack } : t === 'minecraft:player.hunger' ? { currentValue: 20 } : undefined), location: { x: 5, y: 40, z: 7 } },
  body: { getPos: () => ({ x: 5, y: 40, z: 7 }) }, motor: { busy: false, intent: null },
  health: () => 18, mode: 'none', autoStep: 'get_stone', autoLabel: 'getting 8 cobblestone', autoEnabled: true, task: { kind: 'auto' },
  skills: { isUnderground: () => true, feet: () => ({ x: 5, y: 40, z: 7 }), blockAt: (p) => (p.y < 40 ? 'stone' : p.x === 7 && p.y === 40 ? 'crafting_table' : 'air') }, memory: { data: { quarry: { steps: ['0,63,0', '1,62,0'], fails: 1 } } },
  homestead: { house: null, project: null }, deferred: new Map(), toggles: () => ({ beds: true }), snapshot: () => ({}),
};
const f = new Flight(agent);
let tripped = 0;
for (let t = 0; t <= 20 * 100; t++) {
  system.currentTick = t;
  if (t === 20 * 10) pack.addItem(new MC.ItemStack('crafting_table', 1));
  if (t === 20 * 12) { pack.setItem(pack.slots.findIndex((x) => x?.typeId === 'minecraft:crafting_table'), undefined); }
  if (t === 20 * 20) trace('quarry: couldn\'t get past the damage from step 3 to 9');
  f.tick(t);
  if (printed.some((l) => /FLIGHT REPORT/.test(l)) && !tripped) tripped = t;
}
console.warn = warn;
const lines = printed.filter((l) => l.startsWith('[flight]'));
const has = (re) => lines.some((l) => re.test(l));
const checks = [
  ['watchdog trips on 60+ s in place', tripped > 0 && tripped <= 20 * 80, `at ${(tripped / 20).toFixed(0)} s`],
  ['says what kind of stuck', has(/frozen: in place for 60 s/), ''],
  ['has the steps', has(/steps: get_stone \d+s/), ''],
  ['has the pack', has(/pack: .*cobblestone 12/), ''],
  ['has the quarry', has(/quarry: 2 steps/), ''],
  ['has the decision notes', has(/couldn't get past the damage/), ''],
  ['has the surroundings picture (us, the table two across, stone for a floor)', has(/surroundings:/) && has(/y 40 \(feet\)/) && has(/@\.X/) && has(/\[flight\]   #{11}/), ''],
  ['the pack ledger noted the table coming and going', has(/pack: crafting_table \+1/) && has(/pack: crafting_table -1/), ''],
  ['quiet for 5 minutes after (one report)', lines.filter((l) => /FLIGHT REPORT #/.test(l)).length === 1, ''],
];
for (const [n, ok, d] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ` (${d})` : ''}`);
if (process.env.SHOW) console.log(lines.join('\n'));
process.exit(checks.every((c) => c[1]) ? 0 : 1);
