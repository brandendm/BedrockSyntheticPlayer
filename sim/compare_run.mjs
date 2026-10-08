// A tow course in the sim against the bot's own real run of it (the newest `test_run` of the bot in brain/logs/tests.jsonl): the bot's path, side by side every second.
//   node sim/compare_run.mjs leadledge [--file brain/logs/tests.jsonl]
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
const { runTow } = await import('./run_tow.mjs');
const SIM = await import('./server.mjs');
const name = process.argv[2] ?? 'leadledge';
const fi = process.argv.indexOf('--file');
const file = fi > 0 ? process.argv[fi + 1] : new URL('../brain/logs/tests.jsonl', import.meta.url).pathname;
let real = null;
for (const l of readFileSync(file, 'utf8').split('\n')) { try { const e = JSON.parse(l); if (e.type === 'test_run' && e.name === name && e.who === 'bot' && e.trace?.path?.length) real = e; } catch { /* */ } }
if (!real) { console.log('no real bot run of', name); process.exit(0); }
const rp = real.trace.path; // [t, x, y, z, ...]
const { towCourse } = await import('../behavior_pack/scripts/core/towcourses.js');
const C = towCourse(name, 100, 150, 100);
const ox = C.start.x - rp[0][1], oz = C.start.z - rp[0][3];
const simPath = [];
const iv = setInterval(() => {}, 1e9);
const hookInterval = SIM.system.runInterval; // sample after the engine is reset by runTow: wrap the engine step
const step = SIM.engine.step.bind(SIM.engine);
SIM.engine.step = function () { step(); const p = SIM.engine.players[0]; if (p && SIM.system.currentTick % 10 === 0) simPath.push([SIM.system.currentTick / 20, p.x, p.y, p.z]); };
const r = await runTow(name, {});
clearInterval(iv);
const at = (path, t) => path.reduce((b, p) => (Math.abs(p[0] - t) < Math.abs(b[0] - t) ? p : b), path[0]);
console.log(`${name}: real ${real.summary.secs}s (${real.pass ? 'pass' : 'fail'}), sim ${r.secs}s (${r.pass ? 'pass' : 'fail'}); real bot path -> sim coordinates (+${ox}, +${oz})`);
for (let t = 0; t <= Math.max(real.summary.secs, r.secs) + 1; t += 1) {
  const a = at(rp, t), b = at(simPath, t);
  console.log(`t${String(t).padStart(3)}s  real x ${(a[1] + ox).toFixed(1).padStart(6)} y ${a[2].toFixed(1).padStart(5)} z ${(a[3] + oz).toFixed(1).padStart(6)}   sim x ${b[1].toFixed(1).padStart(6)} y ${b[2].toFixed(1).padStart(5)} z ${b[3].toFixed(1).padStart(6)}`);
}
console.log('sim notes:', r.m.notes.join(' | '));
process.exit(0);
