// No fighting from bed: game/agent.js's survive() (the combat tick) on a bot lying in bed with a
// zombie about. Further off: it stays in bed (the walls keep it out). One that's hit it, or is right
// by the bed: out of bed first, and the fight starts once it's on its feet, never a swing lying down.
//
//   node tools/sim_bed.mjs
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
await import('@minecraft/server');
const { Agent } = await import('../behavior_pack/scripts/game/agent.js');

let bad = 0;
const expect = (what, ok, detail) => { if (!ok) bad++; console.log(`${ok ? 'ok ' : 'BAD'} ${what}: ${detail}`); };
function makeBot(mob) {
  const a = Object.create(Agent.prototype);
  const log = { swings: 0, gotUp: 0 };
  Object.assign(a, {
    sim: { isSleeping: true, isInWater: false, isSneaking: false, selectedSlotIndex: 0, getComponent: () => undefined, stopInteracting() { a.sim.isSleeping = false; log.gotUp++; } },
    attackers: new Map(), lastSeen: new Map(), mode: 'none', flips: [], damage: 7, shield: false, weaponId: 'iron_sword',
    body: { jump() {}, headUnderwater: () => false, airRatio: () => 1 },
    motor: { setFocus() {}, stop() {} }, creeperSt: new Map(), stale: { reset() {} },
    task: { kind: 'auto' }, calmSince: 0, lastShout: -1e9, nextRoute: 0,
  });
  a.scanMobs = () => [mob];
  a.health = () => 20; a.isNight = () => true; a.slotHolds = () => 'weapon'; a.toggles = () => ({ witches: true });
  a.say = () => {}; a.emit = () => {}; a.checkWater = () => false; a.newTask = (t) => { a.task = t; return 1; };
  a.fight = () => { if (a.sim.isSleeping) log.swings++; else log.fought = true; };
  a.flee = () => {};
  return { a, log };
}
const zombie = (dist, attackedMe = false) => ({ id: 'z', type: 'zombie', dist, visible: true, attackedMe, targetingMe: true, pos: { x: dist, y: 64, z: 0 } });

{
  const { a, log } = makeBot(zombie(6));
  for (let t = 1; t <= 5; t++) a.survive(t * 10);
  expect('zombie outside, 6 away', a.sim.isSleeping && !log.swings && a.mode === 'none', `still in bed: ${a.sim.isSleeping}, swings from bed ${log.swings}, mode ${a.mode}`);
}
{
  const { a, log } = makeBot(zombie(1.5, true));
  a.survive(10);
  const upFirst = !a.sim.isSleeping && log.gotUp === 1 && !log.swings;
  a.survive(20);
  expect('zombie at the bed, hit us', upFirst && !log.swings && log.fought, `out of bed first ${upFirst}, swings from bed ${log.swings}, fought on its feet ${!!log.fought}`);
}
console.log(bad ? `${bad} failed` : 'all ok');
process.exit(bad ? 1 : 0);
