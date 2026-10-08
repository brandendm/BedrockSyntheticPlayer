// Which of the simulator's constants do the probes actually pin down, how well, and which probe would teach us the most next?
// Fisher-information analysis of the calibration: needs no game data (sensitivity depends on the model, not on the real traces).
//   node sim/identify.mjs [--noise 0.05] [--step 0.02] [--probes a,b] [--json] [--write]
// Per probe, the residual vector is every sampled position (bot and watched entities) over time; J = d(residual)/d(constant) by central differences, constants scaled to
// their FIT range (0..1) so they compare. Information I = sum over probes of JᵀJ / noise². With a ridge (a weak prior of one range) so an unseen constant shows as "not pinned down"
// instead of blowing up. Reports: standard error per constant (% of its range), the weakest combinations of constants (sloppy directions), what each probe is worth
// (log-determinant lost if dropped, per second of game time), and the covariance the ensemble samples from (--write -> sim/posterior.json).
import { writeFileSync } from 'node:fs';
import { runProbe } from './probes_run.mjs';
import { loadParams } from './params.js';
import { FIT } from './calibrate.mjs';
import { PROBES, PROBE_NAMES } from '../behavior_pack/scripts/core/probes.js';
import { gram, eigSym, invSym, logdet, zeros } from './linalg.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
// the noise to assume: what the fit actually leaves over (the model error dominates the game's own jitter), else 0.1 blocks
let resid = 0.1;
try { const { readFileSync } = await import('node:fs'); resid = JSON.parse(readFileSync(new URL('./calibration.json', import.meta.url), 'utf8')).residual ?? resid; } catch { /* none */ }
const NOISE = Number(arg('--noise', Math.max(0.05, resid))), H = Number(arg('--step', 0.02));
const only = arg('--probes', '') ? arg('--probes').split(',') : null;
const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const n = FIT.length;
const base = loadParams();
const norm = (i, v) => (v - FIT[i][1]) / (FIT[i][2] - FIT[i][1]);
const denorm = (i, u) => FIT[i][1] + u * (FIT[i][2] - FIT[i][1]);
const theta0 = FIT.map(([p], i) => Math.min(1, Math.max(0, norm(i, get(base, p)))));
const overrides = (theta) => { const o = {}; FIT.forEach(([p], i) => { const [a, b] = p.split('.'); (o[a] ??= {})[b] = denorm(i, theta[i]); }); return o; };

/** The position samples of a trace as one flat vector, padded/truncated to `len` rows (the last row repeats), unseen entities as 0. */
function flat(rows, len) {
  const out = [];
  for (let t = 0; t < len; t++) {
    const r = rows[Math.min(t, rows.length - 1)] ?? [];
    for (let g = 0; g * 6 < Math.max(6, r.length); g++) for (let k = 0; k < 3; k++) out.push(r[g * 6 + k] ?? 0);
  }
  return out;
}
const trace = async (name, theta) => (await runProbe(name, { params: overrides(theta) }));

const names = (only ?? PROBE_NAMES).filter((p) => PROBES[p]);
const perProbe = {};
for (const name of names) {
  const t0 = await trace(name, theta0);
  const len = t0.rows.length, ref = flat(t0.rows, len);
  const cols = [];
  for (let i = 0; i < n; i++) {
    const up = [...theta0], dn = [...theta0];
    up[i] = Math.min(1, theta0[i] + H); dn[i] = Math.max(0, theta0[i] - H);
    const [a, b] = [flat((await trace(name, up)).rows, len), flat((await trace(name, dn)).rows, len)];
    const d = up[i] - dn[i] || 1;
    cols.push(a.map((v, k) => (v - b[k]) / d));
  }
  // J rows = residual samples, columns = constants
  const J = ref.map((_, k) => cols.map((c) => c[k]));
  perProbe[name] = { I: gram(J, n).map((r) => r.map((v) => v / NOISE ** 2)), secs: PROBES[name].secs ?? t0.ticks / 20, ticks: len, error: t0.error ? t0.error.split('\n')[0] : '' };
}

const RIDGE = 1; // weak prior: one range of uncertainty on every constant (in scaled units that's variance 1)
const total = zeros(n);
for (const p of Object.values(perProbe)) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) total[i][j] += p.I[i][j];
const withPrior = (I) => I.map((r, i) => r.map((v, j) => v + (i === j ? RIDGE : 0)));
const cov = invSym(withPrior(total));
const se = FIT.map((_, i) => Math.sqrt(Math.max(0, cov[i][i])));
const eig = eigSym(total);

const out = { noise: NOISE, step: H, constants: FIT.map(([p, lo, hi], i) => ({ name: p, value: denorm(i, theta0[i]), seRangePct: Math.round(se[i] * 1000) / 10, se: se[i] * (hi - lo), pinned: se[i] < 0.1, flat: total[i][i] < 1e-9 })) };
out.sloppy = eig.values.map((v, k) => ({ info: v, vec: FIT.map(([p], i) => ({ p, w: eig.vectors[i][k] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 4) })).slice(-4).reverse();
const full = logdet(withPrior(total));
out.probes = names.map((name) => {
  const rest = zeros(n); for (const [m, p] of Object.entries(perProbe)) if (m !== name) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) rest[i][j] += p.I[i][j];
  const lost = full - logdet(withPrior(rest)), p = perProbe[name];
  const best = FIT.map(([q], i) => ({ q, v: p.I[i][i] })).sort((a, b) => b.v - a.v).slice(0, 3).map((x) => x.q);
  return { name, secs: p.secs, ticks: p.ticks, logdetLost: Math.round(lost * 100) / 100, perSec: Math.round(lost / Math.max(1, p.secs) * 1000) / 1000, teaches: best, error: p.error };
}).sort((a, b) => b.logdetLost - a.logdetLost);

if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`noise ${NOISE.toFixed(3)} blocks/sample (the fit's own residual), step ${H} of range, ${names.length} probes, ${n} constants\n`);
  console.log('constant                value      se (% of range)');
  for (const c of out.constants) console.log(`  ${c.name.padEnd(20)} ${c.value.toFixed(4).padStart(8)}   ${String(c.seRangePct).padStart(5)}%  ${c.flat ? '<- NO probe moves it (a threshold no probe straddles: its value is a guess)' : c.pinned ? '' : '<- not pinned down'}`);
  console.log('\nweakest combinations (information, then the constants that make it up):');
  for (const s of out.sloppy) console.log(`  ${s.info.toExponential(1).padStart(8)}  ${s.vec.map((x) => `${x.w >= 0 ? '+' : '-'}${Math.abs(x.w).toFixed(2)} ${x.p}`).join('  ')}`);
  console.log('\n(linear, local: a probe that adds nothing here may still catch a regime the model gets wrong)\nprobe                  game s   log-det lost if dropped   per s   teaches most');
  for (const p of out.probes) console.log(`  ${p.name.padEnd(18)} ${String(Math.round(p.secs)).padStart(5)}   ${String(p.logdetLost).padStart(10)}   ${String(p.perSec).padStart(14)}   ${p.teaches.join(', ')}${p.error ? `  [error: ${p.error.slice(0, 60)}]` : ''}`);
}
if (process.argv.includes('--write')) {
  writeFileSync(new URL('./posterior.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), noise: NOISE, names: FIT.map(([p]) => p), theta: theta0, lo: FIT.map((f) => f[1]), hi: FIT.map((f) => f[2]), cov }, null, 0));
  console.log('\nwrote sim/posterior.json');
}
process.exit(0);
