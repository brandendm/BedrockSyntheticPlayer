// The sim half of the trainer.   node sim/train.mjs --group combat|tow [--gens 12] [--pop 10] [--seed 1] [--base '{"fightMargin":0.6}'] [--out file.json]
// Separable CMA-ES (sim/cmaes.mjs) over the group's tunables (core/tunables.js), scored by the simulators (sim/evals.mjs):
//   * common random numbers: every candidate in a generation is scored on the same jobs;
//   * successive halving: all candidates run the first third of the jobs, only the better half run the rest (the cost is the same simulators, a third less of it);
//   * a held-out set the search never sees: the winner is only `accepted` if it beats the starting policy there too and loses no scenario the start passed.
// Writes the result as JSON ({ accepted, best (changed keys only), costs, ... }) to --out and prints a summary. The real game has the last word (brain/trainer.py).
import fs from 'node:fs';
import os from 'node:os';
import { SepCMA } from './cmaes.mjs';
import { jobSets, scorePolicy } from './evals.mjs';
import { keysOf, toUnit, fromUnit, defaults, TUNABLES } from '../behavior_pack/scripts/core/tunables.js';

const args = process.argv.slice(2), val = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const group = val('--group', 'combat'), gens = Number(val('--gens', 12)), pop = Number(val('--pop', 10)), seed = Number(val('--seed', 1));
const base = { ...defaults(), ...(val('--base') ? JSON.parse(val('--base')) : {}) };
const out = val('--out');
const log = (m) => console.error(m);

const keys = keysOf(group);
const { train, held } = jobSets(group);
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const conc = group === 'combat' ? Math.max(1, Math.floor(os.cpus().length / 2)) : 1;
async function pMap(items, fn, c) { const res = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(c, items.length) }, async () => { for (;;) { const k = i++; if (k >= items.length) return; res[k] = await fn(items[k], k); } })); return res; }

let evals = 0;
/** Costs for a generation with successive halving on the train jobs. */
async function generation(policies) {
  const cut = Math.max(1, Math.ceil(train.length / 3));
  const stage1 = await pMap(policies, async (p) => { evals++; return scorePolicy(group, p, train.slice(0, cut)); }, conc);
  const m1 = stage1.map((s) => mean(s.costs));
  const order = m1.map((c, i) => i).sort((a, b) => m1[a] - m1[b]);
  const keep = new Set(order.slice(0, Math.max(2, Math.ceil(policies.length / 2))));
  const full = new Array(policies.length).fill(null);
  await pMap([...keep], async (i) => { evals++; const rest = train.length > cut ? await scorePolicy(group, policies[i], train.slice(cut)) : { costs: [] }; full[i] = mean([...stage1[i].costs, ...rest.costs]); }, conc);
  const worst = Math.max(...full.filter((c) => c !== null));
  return policies.map((_, i) => (full[i] !== null ? full[i] : worst + 0.01 + m1[i]));
}

const t0 = Date.now();
const baseTrain = await scorePolicy(group, base, train), baseHeld = await scorePolicy(group, base, held);
log(`${group}: start policy train ${mean(baseTrain.costs).toFixed(3)} held ${mean(baseHeld.costs).toFixed(3)} (${keys.length} parameters, ${train.length}+${held.length} jobs)`);
const es = new SepCMA(toUnit(base, keys), 0.2, { lambda: pop, seed });
let best = { policy: base, cost: mean(baseTrain.costs) };
const history = [];
for (let g = 0; g < gens; g++) {
  const pts = es.ask(), policies = pts.map((u) => fromUnit(u, keys, base));
  const costs = await generation(policies);
  es.tell(pts, costs);
  const bi = costs.indexOf(Math.min(...costs));
  if (costs[bi] < best.cost - 1e-9 && costs[bi] < 1e8) best = { policy: policies[bi], cost: costs[bi] };
  history.push({ gen: g, best: Math.min(...costs), mean: mean(costs), sigma: es.sigma });
  log(`gen ${g + 1}/${gens}: best ${Math.min(...costs).toFixed(3)} mean ${mean(costs).toFixed(3)} sigma ${es.sigma.toFixed(3)} (${evals} evaluations, ${Math.round((Date.now() - t0) / 1000)}s)`);
}
// the winner must have been scored on ALL the train jobs (halving scored losers on a part): rescore, then the held-out set
const finalTrain = await scorePolicy(group, best.policy, train), finalHeld = await scorePolicy(group, best.policy, held);
const trainCost = mean(finalTrain.costs), heldCost = mean(finalHeld.costs);
const newlyLost = finalHeld.lost.filter((l) => !baseHeld.lost.includes(l)).concat(finalTrain.lost.filter((l) => !baseTrain.lost.includes(l)));
const accepted = trainCost < mean(baseTrain.costs) - 0.01 && heldCost < mean(baseHeld.costs) * 0.98 - 0.005 && newlyLost.length === 0;
const changed = {};
for (const k of keys) if (Math.abs(best.policy[k] - base[k]) > 1e-3) changed[k] = Math.round(best.policy[k] * 1000) / 1000;
const result = {
  at: new Date().toISOString(), group, accepted, best: changed, base: Object.fromEntries(keys.map((k) => [k, base[k]])),
  train: [mean(baseTrain.costs), trainCost], held: [mean(baseHeld.costs), heldCost], newlyLost, evals, seconds: Math.round((Date.now() - t0) / 1000), history,
  lost: { base: baseHeld.lost, best: finalHeld.lost },
};
console.log(`${group}: train ${result.train[0].toFixed(3)} -> ${trainCost.toFixed(3)}, held-out ${result.held[0].toFixed(3)} -> ${heldCost.toFixed(3)}, ${evals} evaluations in ${result.seconds}s: ${accepted ? 'ACCEPTED' : 'not accepted' + (newlyLost.length ? ` (newly lost: ${newlyLost.join(', ')})` : '')}`);
console.log(`changed: ${JSON.stringify(changed)}`);
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1));
void TUNABLES;
