// A new physics probe in one step.   node tools/new_probe.mjs probefoo "what it measures" [--ext 4,28,4]
// Adds a template probe to core/probes.js, registers it in game/scenarios.js's probe case, runs it once in the sim to prove it executes, and tells you the
// next command (tools/probe_cycle.mjs, on the PC: ship, run in the real game, compare to the sim). Edit the template's run() to do the experiment.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(new URL(import.meta.url))), '..');
const [name, what = 'TODO: what it measures'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ei = process.argv.indexOf('--ext'); const [w, e, r] = (ei > 0 ? process.argv[ei + 1] : '4,28,4').split(',').map(Number);
if (!/^probe[a-z0-9]+$/.test(name ?? '')) { console.log('usage: node tools/new_probe.mjs probefoo "what it measures" [--ext w,e,r]  (name: probe + lowercase letters/digits)'); process.exit(3); }
const pf = path.join(root, 'behavior_pack/scripts/core/probes.js'), sf = path.join(root, 'behavior_pack/scripts/game/scenarios.js');
let p = fs.readFileSync(pf, 'utf8'), s = fs.readFileSync(sf, 'utf8');
if (new RegExp(`\\b${name}:`).test(p)) { console.log(`${name} already exists`); process.exit(3); }
const tpl = `  // ${what}
  ${name}: {
    ext: { w: ${w}, e: ${e}, r: ${r} }, floor: floor(${w}, ${e}, ${r}), secs: 30,
    async run(ctx) {
      // ctx.cmd('fill ...') builds; ctx.spawn(type, pos) / ctx.leash(entity) / ctx.watch(entity) / ctx.mark(label) / ctx.wait(ticks) / ctx.sim.teleport|move|jump|stopMoving.
      // The floor is y = ctx.gy, you stand at ctx.gy + 1, the site's west edge is ctx.x - ${w}. Every tick of the bot and the watched entities is recorded.
      ctx.sim.teleport({ x: ctx.x + 0.5, y: ctx.gy + 1, z: ctx.z + 0.5 }); await ctx.wait(5);
      ctx.mark('start'); await ctx.wait(40);
    },
  },
`;
const end = p.lastIndexOf('};\nexport const PROBE_NAMES');
if (end < 0) { console.log('cannot find the end of PROBES in probes.js'); process.exit(3); }
p = p.slice(0, end) + tpl + p.slice(end);
const m = /case 'probewall': \{/.exec(s) ?? /case 'probelift': \{/.exec(s);
if (!m) { console.log('cannot find the probe case in scenarios.js'); process.exit(3); }
s = s.slice(0, m.index) + `case '${name}': ` + s.slice(m.index);
fs.writeFileSync(pf, p); fs.writeFileSync(sf, s);
try { console.log(execFileSync('node', ['sim/probes_run.mjs', name], { cwd: root, encoding: 'utf8' }).split('\n').filter((l) => !l.startsWith('[')).slice(0, 3).join('\n')); } catch (err) { console.log('the sim run failed: ' + String(err.stdout ?? err).slice(0, 300)); process.exit(1); }
console.log(`\n${name} added. 1) edit its run() in behavior_pack/scripts/core/probes.js  2) node sim/probes_run.mjs ${name}  3) on the PC: node tools/probe_cycle.mjs ${name} --bump  (ship, run in the real game, compare)`);
