// The overnight loop.   node tools/nightly.mjs [--seeds 24] [--tune] [--minimize 5]
// While nobody is playing: (1) the gate (unit tests, fixed courses, level-1 random courses); (2) today's FRESH random courses (seeds from the date, levels 1 and 2:
// new ones every night, so what it passes is not what it has been fixed on); (3) every failure shrunk to the smallest course that still fails (sim/minimize.mjs),
// with its second-by-second timeline; (4) with --tune, the constant search (sim/tune.mjs). Writes brain/reports/nightly-YYYY-MM-DD.md: read it in the morning.
// It changes nothing in the bot: a fix is a decision (and goes through the gate and tools/ship.mjs).
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runJobs } from '../sim/pool.mjs';
import { towParts, buildCourse, describeParts } from '../sim/gencourse.mjs';
import { minimize, fails } from '../sim/minimize.mjs';
import { timelineText } from '../sim/report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(new URL(import.meta.url))), '..');
const args = process.argv.slice(2), val = (f, d) => (args.includes(f) ? Number(args[args.indexOf(f) + 1]) : d);
const day = new Date().toISOString().slice(0, 10), dayN = Math.floor(Date.now() / 86400000);
const out = [`# Nightly ${day}`, ''];
const sh = (a) => spawnSync('node', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
const t0 = Date.now();

// 1. the gate
const g = sh(['sim/gate.mjs']);
const gl = (g.stdout ?? '').split('\n').filter((l) => !l.startsWith('[') && l.trim());
out.push(`## Gate: ${g.status === 0 ? 'OK' : 'FAILED'}`, '```', ...gl.slice(-18), '```', '');

// 2. fresh seeds
const n = val('--seeds', 24), base = 5000 + (dayN % 1000) * 40;
const jobs = [];
for (let i = 0; i < n; i++) jobs.push({ kind: 'rand', seed: base + i, level: i % 3 === 2 ? 1 : 2 });
const res = await runJobs(jobs);
const failed = jobs.map((j, i) => ({ ...j, ...res[i] })).filter((r) => !r.pass);
out.push(`## Fresh courses (seeds ${base}-${base + n - 1}): ${n - failed.length}/${n} pass`, '');
for (const level of [1, 2]) { const L = jobs.map((j, i) => ({ ...j, ...res[i] })).filter((r) => r.level === level); out.push(`- level ${level}: ${L.filter((r) => r.pass).length}/${L.length} pass, mean ${(L.filter((r) => r.pass).reduce((a, r) => a + r.secs, 0) / Math.max(1, L.filter((r) => r.pass).length)).toFixed(1)} s on passes`); }
out.push('');

// 3. minimize the failures
const why = {};
out.push('## Failures, shrunk', '');
for (const f of failed.slice(0, val('--minimize', 5))) {
  const start = towParts(f.seed, f.level);
  const small = await minimize(start);
  const r = (await fails(small)).r;
  const key = (r.m?.why ?? f.why ?? '').replace(/\d+(\.\d+)?/g, '#').slice(0, 60); why[key] = (why[key] ?? 0) + 1;
  out.push(`### seed ${f.seed} (level ${f.level}): ${describeParts(start)}`, `minimal: **${describeParts(small)}**  \`${JSON.stringify(small)}\`  (re-run: \`node sim/minimize.mjs --parts '${JSON.stringify(small)}' --timeline\`)`, '```', timelineText(r, { every: 2, maxTrace: 24 }), '```', '');
}
if (failed.length > val('--minimize', 5)) out.push(`(${failed.length - val('--minimize', 5)} more failures not shrunk: seeds ${failed.slice(5).map((f) => f.seed).join(', ')})`, '');
if (Object.keys(why).length) out.push('Failure reasons: ' + Object.entries(why).map(([k, v]) => `${v}x "${k}"`).join('; '), '');

// 4. the constant search
if (args.includes('--tune')) {
  const t = sh(['sim/tune.mjs', '--evals', '60']);
  out.push('## Tuning', '```', ...(t.stdout ?? '').split('\n').filter((l) => !l.startsWith('[') && l.trim()).slice(-12), '```', '');
}
out.push(`(took ${Math.round((Date.now() - t0) / 60000)} min)`);
fs.mkdirSync(path.join(root, 'brain/reports'), { recursive: true });
const f = path.join(root, `brain/reports/nightly-${day}.md`);
fs.writeFileSync(f, out.join('\n'));
console.log(`wrote ${f}: gate ${g.status === 0 ? 'OK' : 'FAILED'}, ${n - failed.length}/${n} fresh pass`);
process.exit(g.status === 0 ? 0 : 1);
