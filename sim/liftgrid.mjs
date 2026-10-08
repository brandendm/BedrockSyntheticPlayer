// How many jumps does it take to bring a boat to a holder who stands `h` above it, `d` blocks out? (the simulator's lead physics, calibrated to the real probes)
//   node sim/liftgrid.mjs [--json]
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
const SIM = await import('./server.mjs');
const { engine, system, spawnBot, ItemStack } = SIM;

/** h > 0: the boat sits at the foot of a platform h high and the holder stands on it, d from the boat. h <= 0: the boat is on a platform and the holder |h| below it, d out. Returns jumps needed (0 = none ever, with maxJ tries). */
export async function jumpsFor(h, d, { maxJ = 5, x = 100, gy = 150, z = 100, params = {} } = {}) {
  engine.reset({ params, floorY: gy - 1 });
  const hi = Math.max(0, h), lo = Math.max(0, -h), rise = Math.max(hi, lo);
  // floor at gy-1 everywhere; a platform (stone) of height `rise` over the +x side (for h>0) or the -x side (for h<0), with a wall at x
  const cmd = (c) => engine.world.command(c);
  if (h > 0) cmd(`fill ${x} ${gy} ${z - 4} ${x + 14} ${gy + h - 1} ${z + 4} stone`);
  if (h < 0) cmd(`fill ${x - 14} ${gy} ${z - 4} ${x - 1} ${gy - h - 1} ${z + 4} stone`);
  const sim = spawnBot({ x: x + 0.5, y: gy + 1, z: z + 0.5 });
  sim.inv.setItem(0, new ItemStack('lead', 4));
  const bx = h >= 0 ? x - 0.9 : x - 0.9 - 0, by = h >= 0 ? gy : gy + (-h);
  const boat = SIM.dimension.spawnEntity('minecraft:boat', { x: bx, y: by, z: z + 0.5 });
  boat.holder = sim;
  const hx = h >= 0 ? bx + d : bx - d;               // the holder stands d from the boat, on the platform (h>0) or below it (h<0)
  const hy = h >= 0 ? gy + h : gy;
  let result = 0;
  const done = (async () => {
    await system.waitTicks(5);
    sim.teleport({ x: hx, y: hy, z: z + 0.5 }); await system.waitTicks(15);
    for (let j = 1; j <= maxJ; j++) {
      try { sim.jump(); } catch { /* */ }
      await system.waitTicks(18);
      const bl = boat.location, sl = sim.location;
      const closeFlat = Math.hypot(bl.x - sl.x, bl.z - sl.z) <= 5.0;
      const upTo = h > 0 ? bl.y >= gy + h - 0.2 : true;
      if (!boat.holder) { result = -1; break; }
      if (closeFlat && upTo && Math.abs(bl.x - bx) > 1) { result = j; break; }
    }
  })();
  await engine.runUntil(done, 20 * 30, 1);
  return result;
}

if (process.argv[1].endsWith('liftgrid.mjs')) {
  const json = process.argv.includes('--json');
  const hs = [-2, -1, 0, 1, 2, 3], ds = [3, 4, 5, 6, 7, 8, 9, 9.6];
  const grid = {};
  for (const h of hs) { grid[h] = {}; for (const d of ds) grid[h][d] = await jumpsFor(h, d); }
  if (json) console.log(JSON.stringify(grid));
  else {
    console.log('jumps needed (0 = never in 5, -1 = lead broke); rows h (holder above the boat), columns d (flat distance)');
    console.log('h\\d  ' + ds.map((d) => String(d).padStart(4)).join(''));
    for (const h of hs) console.log(String(h).padStart(3) + '  ' + ds.map((d) => String(grid[h][d]).padStart(4)).join(''));
  }
}
