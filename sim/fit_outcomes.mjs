// Fit the simulator to what happened in the real game at the level of COURSES: how long the bot's real runs of each tow course took, against the sim's.
// The probe fit (sim/calibrate.mjs) matches traces; this closes the gap it leaves (validate.mjs: the sim 13-48% faster than the game on the same course).
//   node sim/fit_outcomes.mjs [--gens 12] [--apply]
// A few physics constants that decide how fast a tow goes (the lead's stiffness and pull limit, the boat's friction and impulse) are moved by separable CMA-ES
// (sim/cmaes.mjs) inside +-35% of their calibrated values, to make the sim's time on each course match the median of the real runs. Cross-checked: fitted on the even
// real runs' medians, scored on the odd ones' (and the reverse); the fit is only kept (--apply writes sim/calibration.json's `outcome` overlay) if it helps on both.
import fs from 'node:fs';
import { runTow } from './run_tow.mjs';
import { SepCMA } from './cmaes.mjs';
import { readRuns } from './validate.mjs';
import { loadParams } from './params.js';
import { TOW_NAMES } from '../behavior_pack/scripts/core/towcourses.js';

const argv = process.argv.slice(2), val = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const KEYS = ['leash.k', 'leash.maxPull', 'leash.rest', 'boat.landFriction', 'boat.impulse'];
const base = loadParams();
const get = (o, p) => p.split('.').reduce((a, k) => a[k], o);
const bounds = KEYS.map((p) => [get(base, p) * 0.65, get(base, p) * 1.35]);
const toParams = (u) => { const o = {}; KEYS.forEach((p, i) => { const [a, b] = p.split('.'); (o[a] ??= {})[b] = bounds[i][0] + u[i] * (bounds[i][1] - bounds[i][0]); }); return o; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

const dir = new URL('../brain/logs/', import.meta.url).pathname;
const text = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^tests.*\.jsonl/.test(f)).map((f) => fs.readFileSync(dir + f, 'utf8')).join('\n') : '';
const real = readRuns(text).filter((r) => !r.horse && r.pass && r.secs);
const courses = TOW_NAMES.filter((n) => real.filter((r) => r.name === n).length >= 6);
const fold = (k) => Object.fromEntries(courses.map((n) => [n, median(real.filter((r) => r.name === n).filter((_, i) => i % 2 === k).map((r) => r.secs))]));
const targets = [fold(0), fold(1)];
console.log(`real runs: ${real.length}; courses with enough: ${courses.join(', ') || 'none'}`);
if (!courses.length) process.exit(0);

async function simTimes(u) {
  const params = toParams(u), out = {};
  for (const n of courses) { const r = await runTow(n, { params }); out[n] = r.pass ? r.secs : 120; }
  return out;
}
const loss = (times, target) => courses.reduce((a, n) => a + Math.log(times[n] / target[n]) ** 2, 0) / courses.length;
const x0 = KEYS.map((p, i) => (get(base, p) - bounds[i][0]) / (bounds[i][1] - bounds[i][0]));
const t0 = await simTimes(x0);
console.log('start:', courses.map((n) => `${n} sim ${t0[n]}s real ${targets[0][n]?.toFixed(1)}/${targets[1][n]?.toFixed(1)}s`).join(' | '));
const results = [];
for (const k of [0, 1]) {
  const es = new SepCMA(x0, 0.25, { lambda: 8, seed: 3 + k });
  let best = { u: x0, l: loss(t0, targets[k]) };
  for (let g = 0; g < Number(val('--gens', 10)); g++) {
    const pts = es.ask(), costs = [];
    for (const u of pts) costs.push(loss(await simTimes(u), targets[k]));
    es.tell(pts, costs);
    const i = costs.indexOf(Math.min(...costs));
    if (costs[i] < best.l) best = { u: pts[i], l: costs[i] };
  }
  const tt = await simTimes(best.u), t00 = t0;
  results.push({ fitFold: k, u: best.u, trainBefore: loss(t00, targets[k]), trainAfter: best.l, testBefore: loss(t00, targets[1 - k]), testAfter: loss(tt, targets[1 - k]) });
  console.log(`fold ${k}: fit loss ${loss(t00, targets[k]).toFixed(4)} -> ${best.l.toFixed(4)}; on the other half ${loss(t00, targets[1 - k]).toFixed(4)} -> ${loss(tt, targets[1 - k]).toFixed(4)}`);
}
const helps = results.every((r) => r.testAfter < r.testBefore * 0.95);
console.log(helps ? 'the fit helps on held-out real runs in both folds' : 'the fit does not clearly help on held-out runs: nothing written');
if (helps && argv.includes('--apply')) {
  // fit on all the real runs' medians this time
  const all = Object.fromEntries(courses.map((n) => [n, median(real.filter((r) => r.name === n).map((r) => r.secs))]));
  const es = new SepCMA(x0, 0.2, { lambda: 8, seed: 11 });
  let best = { u: x0, l: loss(t0, all) };
  for (let g = 0; g < Number(val('--gens', 10)); g++) { const pts = es.ask(), costs = []; for (const u of pts) costs.push(loss(await simTimes(u), all)); es.tell(pts, costs); const i = costs.indexOf(Math.min(...costs)); if (costs[i] < best.l) best = { u: pts[i], l: costs[i] }; }
  const f = new URL('./calibration.json', import.meta.url).pathname, cal = JSON.parse(fs.readFileSync(f, 'utf8'));
  const p = toParams(best.u);
  for (const [a, o] of Object.entries(p)) for (const [b, v] of Object.entries(o)) { cal.params[a] ??= {}; cal.params[a][b] = Math.round(v * 10000) / 10000; }
  cal.outcomeFit = { at: new Date().toISOString(), courses, loss: [loss(t0, all), best.l] };
  fs.writeFileSync(f, JSON.stringify(cal, null, 1));
  console.log(`applied: loss ${loss(t0, all).toFixed(4)} -> ${best.l.toFixed(4)}; wrote sim/calibration.json`);
}
