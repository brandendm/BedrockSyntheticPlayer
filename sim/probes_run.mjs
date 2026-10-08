// The physics probes (behavior_pack/scripts/core/probes.js) run on the simulator: the same script, the same per-tick sampling as the real game's runner (game/scenarios.js),
// so a sim trace and a real trace are rows of the same shape and can be laid side by side (sim/calibrate.mjs).
//   node sim/probes_run.mjs [name ...]      (prints each probe's key numbers)
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
const SIM = await import('./server.mjs');
const { engine, system, spawnBot, ItemStack } = SIM;
const { PROBES, PROBE_NAMES } = await import('../behavior_pack/scripts/core/probes.js');

const r3 = (v) => Math.round(v * 1000) / 1000;

/** One probe on a fresh world. Returns { name, ticks, marks: [{tick,label}], rows: [[bx,by,bz,bvx,bvy,bvz, (watched: x,y,z,vx,vy,vz)...]], error, unimplemented }. */
export async function runProbe(name, { params = {}, x = 100, gy = 150, z = 100 } = {}) {
  const pr = PROBES[name];
  if (!pr) throw new Error(`no probe ${name}`);
  engine.reset({ params, floorY: gy - 1 });
  for (const c of [...pr.floor(x, gy, z), ...(pr.cmds ? pr.cmds(x, gy, z) : [])]) engine.world.command(c);
  const sim = spawnBot({ x: x + 0.5, y: gy + 1, z: z + 0.5 });
  sim.inv.setItem(0, new ItemStack('lead', 4));
  const rows = [], marks = [], watched = [];
  const leash = (e) => {
    sim.selectedSlotIndex = 0;
    try { sim.interactWithEntity(e); } catch { /* */ }
    if (e.holder) return true;
    try { e.getComponent('minecraft:leashable')?.leashTo(sim); } catch { /* */ }
    return !!e.holder;
  };
  const ctx = {
    sim, dim: SIM.dimension, x, gy, z, cmd: (c) => { engine.world.command(c); return true; },
    wait: (n) => system.waitTicks(n),
    spawn: (type, loc) => SIM.dimension.spawnEntity(type, loc),
    leash, give() {}, mark: (label) => marks.push({ tick: rows.length, label }), watch: (e) => watched.push(e),
  };
  let live = true;
  const sampler = (async () => {
    while (live) {
      const l = sim.location, v = sim.getVelocity();
      const row = [r3(l.x - x), r3(l.y - gy), r3(l.z - z), r3(v.x), r3(v.y), r3(v.z)];
      for (const e of watched) { try { const p = e.location, w = e.getVelocity(); row.push(r3(p.x - x), r3(p.y - gy), r3(p.z - z), r3(w.x), r3(w.y), r3(w.z)); } catch { row.push(null, null, null, null, null, null); } }
      rows.push(row);
      await system.waitTicks(1);
    }
  })();
  let error = '';
  await engine.runUntil((async () => { try { await pr.run(ctx); } catch (e) { error = String(e.stack ?? e); } live = false; await system.waitTicks(2); })(), 20 * Math.max(120, (pr.secs ?? 0) + 20), 1);
  void sampler;
  return { name, ticks: rows.length, marks, rows, error, unimplemented: Object.fromEntries(engine.unimplemented) };
}

if (process.argv[1].endsWith('probes_run.mjs')) {
  const names = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  for (const n of names.length ? names : PROBE_NAMES) {
    const r = await runProbe(n);
    const last = r.rows[r.rows.length - 1];
    console.log(`${n}: ${r.ticks} ticks, marks ${r.marks.map((m) => `${m.label}@${m.tick}`).join(', ')}${r.error ? `\n  ERROR ${r.error.split('\n').slice(0, 3).join(' | ')}` : ''}\n  last row ${JSON.stringify(last)}  not built: ${JSON.stringify(r.unimplemented)}`);
  }
}
