// How robust is the bot to the simulator being a little wrong? Each tow course is run N times with the fitted physics jittered (each constant times 1 +- spread, seeded),
// and the pass rate and time spread are reported. A course that passes on the fitted numbers but fails on a jittered one is a knife edge in the bot, not in the sim.
//   node sim/ensemble.mjs [course ...] [--n 12] [--spread 0.08] [--seed 1]
import { loadParams } from './params.js';
import { FIT } from './calibrate.mjs';
import { runTow } from './run_tow.mjs';
import { TOW_NAMES } from '../behavior_pack/scripts/core/towcourses.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg('--n', 12), spread = arg('--spread', 0.08), seed = arg('--seed', 1);
const names = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));
const rng = (s) => () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };

const base = loadParams();
// --posterior [--scale 3]: draw the constants from the calibration's own uncertainty (sim/posterior.json, written by sim/identify.mjs --write) instead of +-spread on each:
// correlated, narrow where the probes pin a constant down, wide where nothing does (the step heights), times --scale standard errors.
import { readFileSync } from 'node:fs';
import { cholesky } from './linalg.mjs';
let post = null;
if (process.argv.includes('--posterior')) {
  const P = JSON.parse(readFileSync(new URL('./posterior.json', import.meta.url), 'utf8'));
  const L = cholesky(P.cov.map((r, i) => r.map((v, j) => v + (i === j ? 1e-12 : 0))));
  if (!L) throw new Error('posterior.json is not positive definite: rerun sim/identify.mjs --write');
  post = { P, L, scale: arg('--scale', 3) };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
function jittered(r) {
  const o = {};
  if (post) {
    const { P, L, scale } = post, z = P.names.map(() => gauss(r));
    P.names.forEach((p, i) => {
      const d = L[i].reduce((a, v, k) => a + v * z[k], 0) * scale, u = Math.min(1, Math.max(0, P.theta[i] + d));
      const [a, b] = p.split('.'); (o[a] ??= {})[b] = P.lo[i] + u * (P.hi[i] - P.lo[i]);
    });
    return o;
  }
  for (const [p] of FIT) { const [a, b] = p.split('.'); if (a === 'player') continue; (o[a] ??= {})[b] = get(base, p) * (1 + (r() * 2 - 1) * spread); }
  return o; // (the walker is measured to 1 cm: only the boat and the lead are jittered)
}
const results = {};
for (const name of names.length ? names : TOW_NAMES) {
  const r = rng(seed * 7919 + name.length), runs = [];
  for (let i = 0; i < N; i++) {
    const out = await runTow(name, { params: jittered(r) });
    runs.push({ pass: out.pass, secs: out.secs, why: out.m.why }); if (!out.pass && process.argv.includes('--notes')) console.log('   fail:', out.m.notes.join(' | ').slice(0, 400), JSON.stringify(out.boat));
  }
  const ok = runs.filter((x) => x.pass), secs = ok.map((x) => x.secs).sort((a, b) => a - b);
  const whys = {}; for (const x of runs.filter((y) => !y.pass)) whys[x.why.slice(0, 50)] = (whys[x.why.slice(0, 50)] ?? 0) + 1;
  results[name] = { passed: ok.length, n: N, median: secs[Math.floor(secs.length / 2)] ?? null, min: secs[0] ?? null, max: secs[secs.length - 1] ?? null, whys };
  console.log(`${name.padEnd(10)} ${ok.length}/${N} pass  time ${secs[0] ?? '-'}..${secs[secs.length - 1] ?? '-'}s (median ${results[name].median ?? '-'})${Object.keys(whys).length ? `  fails: ${JSON.stringify(whys)}` : ''}`);
}
process.exit(0);
