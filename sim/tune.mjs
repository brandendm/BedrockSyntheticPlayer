// Searches the tow's constants (core/towtune.js) offline.   node sim/tune.mjs [--evals 120] [--apply]
// Coordinate search (each constant up/down by a quarter, then a tenth of its range, keeping what lowers the cost) over a TRAIN set of the five fixed courses +
// random courses at levels 1 and 2 (seeds 2001-2012 / 2001-2010); cost = mean seconds, a failed course counting 120. The result is then checked on a held-out
// set (seeds 1000-1011 / 1000-1009, never searched on): it is written to sim/tuned.json only if it wins there too, with no course lost.
// A player's runs only seeded the defaults (the learned memory); nothing here imitates anyone. --apply also copies the values into core/towtune.js's defaults.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { runJobs } from './pool.mjs';
import { TOW_TUNE, tuneDefaults } from '../behavior_pack/scripts/core/towtune.js';

const args = process.argv.slice(2), val = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const FIXED = ['leadledge', 'leadstep', 'leadstair', 'leadturn', 'leadgate'];
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const sets = {
  train: [...FIXED.map((name) => ({ kind: 'fixed', name })), ...range(2001, 2012).map((seed) => ({ kind: 'rand', seed, level: 1 })), ...range(2001, 2010).map((seed) => ({ kind: 'rand', seed, level: 2 }))],
  held: [...FIXED.map((name) => ({ kind: 'fixed', name })), ...range(1000, 1011).map((seed) => ({ kind: 'rand', seed, level: 1 })), ...range(1000, 1009).map((seed) => ({ kind: 'rand', seed, level: 2 }))],
};
let evals = 0;
async function score(tune, set) {
  evals++;
  const r = await runJobs(set.map((j) => ({ ...j, tune })));
  const pass = r.filter((x) => x?.pass).length;
  const cost = r.reduce((a, x) => a + (x?.pass ? x.secs : 120), 0) / set.length;
  return { cost, pass, n: set.length, lost: set.map((j, i) => (r[i]?.pass ? null : (j.name ?? `L${j.level}:${j.seed}`))).filter(Boolean) };
}
const budget = Number(val('--evals', 120));
let best = tuneDefaults(), bestS = await score(best, sets.train);
const base = { tune: { ...best }, train: bestS, held: await score(best, sets.held) };
console.log(`default: train cost ${bestS.cost.toFixed(2)} (${bestS.pass}/${bestS.n}), held-out cost ${base.held.cost.toFixed(2)} (${base.held.pass}/${base.held.n})`);
for (const frac of [0.25, 0.1]) for (let round = 0; round < 2; round++) {
  let improved = false;
  for (const [k, d] of Object.entries(TOW_TUNE)) {
    if (evals >= budget) break;
    for (const dir of [1, -1]) {
      const v = Math.min(d.max, Math.max(d.min, Math.round((best[k] + dir * frac * (d.max - d.min)) * 100) / 100));
      if (v === best[k]) continue;
      const t = { ...best, [k]: v }, s = await score(t, sets.train);
      if (s.pass >= bestS.pass && s.cost < bestS.cost - 0.01) { console.log(`  ${k} ${best[k]} -> ${v}: cost ${bestS.cost.toFixed(2)} -> ${s.cost.toFixed(2)} (${s.pass}/${s.n})`); best = t; bestS = s; improved = true; break; }
    }
  }
  if (!improved || evals >= budget) break;
}
const held = await score(best, sets.held);
console.log(`\ntuned:   train cost ${bestS.cost.toFixed(2)} (${bestS.pass}/${bestS.n}), held-out cost ${held.cost.toFixed(2)} (${held.pass}/${held.n}), ${evals} evaluations`);
console.log(`values:  ${JSON.stringify(best)}`);
const wins = held.pass >= base.held.pass && held.cost < base.held.cost * 0.98 && held.lost.every((l) => base.held.lost.includes(l));
console.log(wins ? `WINS on held-out: ${base.held.cost.toFixed(2)} -> ${held.cost.toFixed(2)}` : 'does not clearly win on held-out: nothing written');
if (wins) {
  fs.writeFileSync(fileURLToPath(new URL('./tuned.json', import.meta.url)), JSON.stringify({ at: new Date().toISOString(), tune: best, default: base.tune, trainCost: [base.train.cost, bestS.cost], heldCost: [base.held.cost, held.cost], heldPass: [base.held.pass, held.pass] }, null, 1));
  console.log('wrote sim/tuned.json');
  if (args.includes('--apply')) {
    const f = fileURLToPath(new URL('../behavior_pack/scripts/core/towtune.js', import.meta.url)); let s = fs.readFileSync(f, 'utf8');
    for (const [k, v] of Object.entries(best)) s = s.replace(new RegExp(`(${k}:\\s*\\{ v: )[0-9.]+`), `$1${v}`);
    fs.writeFileSync(f, s); console.log('applied to core/towtune.js');
  }
}
