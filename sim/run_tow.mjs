// One tow course, played by the bot's real code (game/leadtow.js through game/agent.js) on the simulator: the same steps game/scenarios.js's runOne takes.
//   node sim/run_tow.mjs leadstep [-v]
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
const SIM = await import('./server.mjs');
const { engine, system, spawnBot, ItemStack } = SIM;
const { Agent } = await import('../behavior_pack/scripts/game/agent.js');
const { towCourse } = await import('../behavior_pack/scripts/core/towcourses.js');

export async function runTow(name, { params = {}, gy = 150, verbose = false, x = 100, z = 100, maxS = 200 } = {}) {
  engine.reset({ params, floorY: gy - 1 });
  const C = towCourse(name, x, gy, z);
  for (const c of C.cmds) engine.world.command(c);
  const sim = spawnBot({ x: C.start.x - 0.5, y: C.start.y, z: C.start.z - 0.5 });
  sim.inv.setItem(0, new ItemStack('lead', 2));
  const agent = new Agent(sim);
  // (what main.js does: the agent's own tick, every tick, which drives the motor)
  const tickErrors = new Map();
  system.runInterval(() => { try { agent.tick(); } catch (e) { const k = String(e).slice(0, 120); tickErrors.set(k, (tickErrors.get(k) ?? 0) + 1); } }, 1);
  const boat = SIM.dimension.spawnEntity('minecraft:boat', C.boat);
  const inZone = (b) => b.isValid && Math.hypot(b.location.x - C.goal.x, b.location.z - C.goal.z) <= C.zone && b.location.y >= C.goal.y - 1.3;
  const gen = agent.newTask({ kind: 'test' });
  const how = agent.tow.attach(boat);
  if (!how) throw new Error('no lead on the boat');
  const t0 = system.currentTick;
  if (verbose) system.runInterval(() => { const b = boat.location, p = sim.location; console.log(`t${system.currentTick} bot ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} boat ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)} v ${boat.vx.toFixed(2)},${boat.vz.toFixed(2)} ${boat.holder ? 'leashed' : 'FREE'}`); }, 20);
  const m = await engine.runUntil((async () => {
    const m = await agent.tow.run(gen, boat, C.goal, { maxS, walkTo: { x: C.goal.x + (C.room ?? 1.5), y: C.goal.y, z: C.goal.z }, boatZone: C.zone });
    for (let i = 0; i < 160 && boat.isValid && !inZone(boat) && !m.snapped; i++) {
      const sep = Math.hypot(sim.location.x - boat.location.x, sim.location.z - boat.location.z);
      if (sep < 6 && sim.location.x < C.goal.x + 2) sim.moveToLocation({ x: C.goal.x + 2, y: C.goal.y, z: C.goal.z }, { speed: 0.4 }); else sim.stopMoving();
      await system.waitTicks(1);
    }
    return m;
  })());
  const pass = inZone(boat) && !m.snapped;
  return { name, pass, secs: Math.round((system.currentTick - t0) / 20 * 10) / 10, m, boat: boat.location, goal: C.goal, unimplemented: Object.fromEntries(engine.unimplemented), tickErrors: Object.fromEntries(tickErrors) };
}

if (process.argv[1].endsWith('run_tow.mjs')) {
  const name = process.argv[2] ?? 'leadstep';
  const r = await runTow(name, { verbose: process.argv.includes('-v') });
  console.log(`${name}: ${r.pass ? 'PASS' : 'FAIL'} in ${r.secs}s; arrived=${r.m.arrived} why=${r.m.why} slings=${r.m.slingOk}/${r.m.slings} unstuck=${r.m.tugs} boat=${JSON.stringify(r.boat)}`);
  console.log('notes:', r.m.notes.join(' | '));
  console.log('not built yet:', JSON.stringify(r.unimplemented));
  console.log('agent tick errors:', JSON.stringify(r.tickErrors));
}
