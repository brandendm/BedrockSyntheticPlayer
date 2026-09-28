// Chopping's drop tracking (game/skills.js noteDrops/strayDrops/grabStrayOnTheWay) against a fake
// world: our drops are known by entity id, waited on only while falling, stepped to only when the
// next log stays in reach, and forgotten once picked up. Other items are never ours.
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const { system } = await import('@minecraft/server');
const { Skills } = await import('../behavior_pack/scripts/game/skills.js');

const items = [];
const item = (id, x, y, z, fall = 0) => ({ id, isValid: true, location: { x, y, z }, getVelocity: () => ({ x: 0, y: -fall, z: 0 }) });
const planned = [];
const dim = {
  getEntities: ({ location: l, maxDistance: r }) => items.filter((e) => e.isValid && Math.hypot(e.location.x - l.x, e.location.y - l.y, e.location.z - l.z) <= r),
  getPlayers: () => [],
};
const s = Object.assign(Object.create(Skills.prototype), {
  ourDrops: new Map(), dropSpots: [], check() {}, log() {},
  a: {
    sim: { location: { x: 0.5, y: 64, z: 0.5 }, id: 'bot', dimension: dim },
    plan: async (f, t) => { planned.push(t); return { complete: true, path: [f, t] }; }, motor: { followPath: async () => {} },
  },
});
let bad = 0;
const expect = (what, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(`${ok ? 'ok ' : 'BAD'} ${what}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

s.noteDrops({ x: 2, y: 64, z: 0 });            // the break; its drop spawns a tick later, falling
items.push(item('a', 2.5, 64.3, 0.5, 0.3));
system.advance(1);
expect('late spawn, still falling', s.strayDrops(3.5).map((d) => d.id), []);
expect('it is tracked by id', [...s.ourDrops.keys()], ['a']);
items[0].getVelocity = () => ({ x: 0, y: 0, z: 0 }); items[0].location.y = 64;
expect('landed, out of pickup range', s.strayDrops(3.5).map((d) => d.id), ['a']);
expect('next log in reach from it: step over', await s.grabStrayOnTheWay(0, { x: 2, y: 66, z: 0 }), true);
items[0].isValid = false;                      // picked up
expect('picked up: forgotten', [s.strayDrops(3.5).length, s.ourDrops.size], [0, 0]);
items.push(item('b', 3.8, 64, 0.5)); s.noteDrops({ x: 3, y: 64, z: 0 });
expect('next log out of reach from it: keep chopping', await s.grabStrayOnTheWay(0, { x: -3, y: 70, z: 0 }), false);
items.push(item('c', 0.5, 64, 3));             // someone else's, nowhere near our breaks
expect('only our own drops', s.strayDrops(6).map((d) => d.id), ['b']);
dim.getPlayers = () => [{ id: 'steve' }];    // a player close: fetch it anyway
expect('player near: fetch it', await s.grabStrayOnTheWay(0, { x: -3, y: 70, z: 0 }), true);
console.log(bad ? `${bad} failed` : 'all ok');
process.exit(bad ? 1 : 0);
