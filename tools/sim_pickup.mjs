// Picking up what's lying about (game/skills.js sweep): one route through all the items, walked without
// stopping, against stopping at each. A flat world, items scattered round (a tree's drops, a patch of
// leaf litter), the bot walking at 4.3 blocks/s and picking up anything within a block.
//   node tools/sim_pickup.mjs [N]
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const { system } = await import('@minecraft/server');
const { Skills } = await import('../behavior_pack/scripts/game/skills.js');
const { Cell } = await import('../behavior_pack/scripts/core/pathfinder.js');
const { makeRng } = await import('../behavior_pack/scripts/core/mathutil.js');

const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 30);
const rng = makeRng(77);
let stops = 0;

function run(count, spread) {
  const items = [];
  for (let i = 0; i < count; i++) items.push({ id: `i${i}`, isValid: true, location: { x: rng.range(-spread, spread) + 0.5, y: 64, z: rng.range(-spread, spread) + 0.5 }, getComponent: () => ({ itemStack: { typeId: 'minecraft:leaf_litter' } }) });
  const me = { x: 0.5, y: 64, z: 0.5 };
  const dim = { getEntities: ({ location: l, maxDistance: r }) => items.filter((e) => e.isValid && Math.hypot(e.location.x - l.x, e.location.z - l.z) <= r) };
  let standing = 0, moving = 0;
  const pickUp = () => { for (const e of items) if (e.isValid && Math.hypot(e.location.x - me.x, e.location.z - me.z) < 1.0) e.isValid = false; };
  const s = Object.assign(Object.create(Skills.prototype), {
    unreachableItems: new Map(), ourDrops: new Map(), dropSpots: [], check() {}, log() {}, rememberItems() {},
    wait: async (g, n) => { for (let i = 0; i < n; i++) { system.advance(1); standing++; pickUp(); } },
    a: {
      get sim() { return { location: me, dimension: dim }; },
      classifier: () => (x, y, z) => (y < 64 ? Cell.SOLID : Cell.AIR),
      plan: async (f, t) => ({ complete: true, path: [{ x: Math.floor(f.x), y: 64, z: Math.floor(f.z) }, { x: Math.floor(t.x), y: 64, z: Math.floor(t.z) }] }),
      motor: {
        followPath: async (wps) => {
          for (const p of wps.slice(1)) {
            const tx = p.x + (Number.isInteger(p.x) ? 0.5 : 0), tz = p.z + (Number.isInteger(p.z) ? 0.5 : 0);
            while (Math.hypot(tx - me.x, tz - me.z) > 0.2) {
              const d = Math.hypot(tx - me.x, tz - me.z), st = Math.min(0.215, d);
              me.x += (tx - me.x) / d * st; me.z += (tz - me.z) / d * st;
              system.advance(1); moving++; pickUp();
            }
          }
          return { status: 'arrived' };
        },
      },
    },
  });
  return s.sweep(0, { x: 0, y: 64, z: 0 }, spread + 3, null, 30, false).then(() => ({ left: items.filter((e) => e.isValid).length, ticks: standing + moving, standing }));
}
let tot = { left: 0, ticks: 0, standing: 0 };
for (let k = 0; k < N; k++) { const r = await run(6 + (k % 5) * 2, 6); tot.left += r.left; tot.ticks += r.ticks; tot.standing += r.standing; }
console.log(`${N} scatters of 6-14 items: ${(tot.ticks / N / 20).toFixed(1)} s each, ${(tot.standing / N / 20).toFixed(1)} s of it standing still, ${tot.left} items left behind`);
