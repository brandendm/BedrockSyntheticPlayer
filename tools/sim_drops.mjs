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

// Taking down old pillars: one standing in a pit below us is left (going down to its foot put the bot
// back in the pit, and the escape built it up again); one at our own level comes down.
{
  const mem = { scaffold: [], save() {} };
  const mined = [], goneTo = [];
  const blocks = new Map();
  const c = Object.assign(Object.create(Skills.prototype), {
    check() {}, log() {}, ourDrops: new Map(),
    blockAt: (p) => blocks.get(`${p.x},${p.y},${p.z}`) ?? 'air',
    inReach: () => true, feet: () => ({ x: Math.floor(c.a.sim.location.x), y: Math.floor(c.a.sim.location.y), z: Math.floor(c.a.sim.location.z) }),
    goNear: async (g, p) => { goneTo.push(p); return true; },
    mine: async (g, p) => { mined.push(p); blocks.set(`${p.x},${p.y},${p.z}`, 'air'); return true; },
    a: { dim: { id: 'overworld' }, memory: { data: mem, save() {} }, sayOnce() {}, sim: { location: { x: 0.5, y: 68, z: 3.5 } } },
  });
  Object.defineProperty(c, 'dim', { get: () => ({ id: 'overworld' }) });
  for (const y of [65, 66, 67]) { blocks.set(`0,${y},0`, 'dirt'); mem.scaffold.push({ d: 'overworld', x: 0, y, z: 0, id: 'dirt', tries: 0 }); }
  const n = await c.cleanupScaffold(0);
  expect('a pillar in a pit below us is left: nothing mined, never walked down to it', [n, mined.length, goneTo.length, mem.scaffold.length], [0, 0, 0, 0]);
  for (const y of [68, 69]) { blocks.set(`5,${y},0`, 'dirt'); mem.scaffold.push({ d: 'overworld', x: 5, y, z: 0, id: 'dirt', tries: 0 }); }
  const m = await c.cleanupScaffold(0);
  expect('one at our own level comes down', [m, mined.length], [2, 2]);
}
console.log(bad ? `${bad} failed` : 'all ok');
process.exit(bad ? 1 : 0);
