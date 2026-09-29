// Following a player: game/agent.js's own escort rules (only what's fighting us or them, what they
// hit, and creepers getting close) and the boat (into the other seat while they're in one, out
// when they get out). Stand-in entities; no world.
//
//   node tools/sim_follow.mjs
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Agent } = await import('../behavior_pack/scripts/game/agent.js');
const { system } = MC;

let pass = 0, fail = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (ok) pass++; else fail++; };

const player = { id: 'p1', typeId: 'minecraft:player', name: 'Steve', location: { x: 0, y: 64, z: 0 }, isValid: true, riding: null,
  getComponent: (c) => (c === 'minecraft:riding' ? (player.riding ? { entityRidingOn: player.riding } : undefined) : undefined), getHeadLocation: () => ({ x: 0, y: 65.6, z: 0 }) };
const bot = { id: 'b1', typeId: 'minecraft:player', name: 'Scout', location: { x: 2, y: 64, z: 0 }, isValid: true, riding: null,
  getComponent: (c) => (c === 'minecraft:riding' ? (bot.riding ? { entityRidingOn: bot.riding } : undefined) : undefined) };
MC.world.getPlayers = () => [player];

const A = Object.create(Agent.prototype);
Object.assign(A, { sim: bot, task: { kind: 'follow', player: 'Steve' }, escort: new Map(), taskGen: 1, said: [] });
A.say = (m) => A.said.push(m);
A.body = { getPos: () => bot.location, resetProbe() {} };
A.motor = { busy: false, stop() {}, followPath() {}, glanceAt() {} };
A.plan = async () => ({ path: [], complete: true });
A.classifier = () => () => 0;

// ---- escort ----
const mob = (id, type, dist, extra = {}) => ({ id, type, dist, pos: { x: 2 + dist, y: 64, z: 0 }, attackedMe: false, lit: false, ...extra });
const t = system.currentTick;
const zombieIdle = mob('z1', 'zombie', 5);
const zombieHitMe = mob('z2', 'zombie', 5, { attackedMe: true });
const skelHitPlayer = mob('s1', 'skeleton', 12);
const zombiePlayerHit = mob('z3', 'zombie', 9);
const creeperNear = mob('c1', 'creeper', 5);
const creeperFar = mob('c2', 'creeper', 14);
const creeperByPlayer = { ...mob('c3', 'creeper', 9), pos: { x: -4, y: 64, z: 0 } }; // 4 from the player, 9 from us
A.onEscortHurt(player, { id: 's1', typeId: 'minecraft:skeleton' });           // it shot the player
A.onEscortHurt({ id: 'z3', typeId: 'minecraft:zombie' }, player);             // the player hit it
A.onEscortHurt({ id: 'x9', typeId: 'minecraft:player', name: 'Alex' }, player); // (a friend: never)
const kept = A.escortMobs([zombieIdle, zombieHitMe, skelHitPlayer, zombiePlayerHit, creeperNear, creeperFar, creeperByPlayer], t).map((m) => m.id);
check(!kept.includes('z1'), 'a zombie that has done nothing yet is left to the player');
check(kept.includes('z2'), 'one that hit us is fought');
check(kept.includes('s1'), 'one that shot the player is fought');
check(kept.includes('z3'), 'one the player hit is fought');
check(kept.includes('c1') && kept.includes('c3') && !kept.includes('c2'), 'creepers within 6 of us or the player are kept off; one far off is left');
check(!A.escort.has('x9'), 'another player the player hit is never marked');
system.advance(401);
check(!A.escortMobs([skelHitPlayer], system.currentTick).length, 'marks wear off after 20 s');

// ---- the boat ----
const boat = { id: 'boat1', typeId: 'minecraft:boat', isValid: true, location: { x: 1, y: 63.5, z: 0 }, riders: [] };
boat.getComponent = (c) => (c === 'minecraft:rideable' ? {
  seatCount: 2,
  getRiders: () => boat.riders,
  addRider: (e) => { if (boat.riders.length >= 2) return false; boat.riders.push(e); e.riding = boat; return true; },
  ejectRider: (e) => { boat.riders = boat.riders.filter((r) => r !== e); e.riding = null; },
} : undefined);
player.riding = boat; boat.riders.push(player);
const r1 = await A.followBoat(player);
check(r1 && bot.riding === boat, 'the player gets in a boat: into the other seat');
const r2 = await A.followBoat(player);
check(r2 && bot.riding === boat, 'and sits tight while they are in it');
player.riding = null; boat.riders = boat.riders.filter((r) => r !== player);
const r3 = await A.followBoat(player);
check(!r3 && bot.riding === null, 'they get out: out too, following on foot');
// A chest boat: one seat, taken.
const cboat = { ...boat, id: 'cb', typeId: 'minecraft:chest_boat', riders: [player] };
cboat.getComponent = (c) => (c === 'minecraft:rideable' ? { seatCount: 1, getRiders: () => cboat.riders, addRider: () => false, ejectRider() {} } : undefined);
player.riding = cboat;
const r4 = await A.followBoat(player);
check(!r4 && bot.riding === null && A.said.some((m) => /No seat/.test(m)), 'a chest boat (one seat): follows along instead');
// Far from the boat: walks over first, doesn't get in from across the lake.
player.riding = boat; boat.riders = [player]; boat.location = { x: 20, y: 63.5, z: 0 };
let walked = false;
A.plan = async () => { walked = true; return { path: [{ x: 2, y: 64, z: 0 }, { x: 19, y: 63, z: 0 }], complete: true }; };
const r5 = await A.followBoat(player);
check(r5 && walked && bot.riding === null, 'the boat 18 away: over to it first');

console.log(`\n${pass}/${pass + fail} as expected`);
process.exit(fail ? 1 : 0);
