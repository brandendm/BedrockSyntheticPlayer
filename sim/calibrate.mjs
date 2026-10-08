// Fits the simulator's physics to the real game. The same probes (core/probes.js) were run in the real game (`!bot test probewalk,probejump,...`, traces in
// brain/logs/probes.jsonl) and run here (probes_run.mjs); this finds the constants in params.js flagged FIT that make the two traces agree, and writes them to
// calibration.json together with the residuals, so a later run can say whether the sim has drifted from the game (a new Minecraft build, a changed pack).
//   node sim/calibrate.mjs [--real brain/logs/probes.jsonl] [--fit] [--report] [--selftest]
//     (no flags / --report): how far the sim is from the real traces now, per probe, in blocks
//     --fit: Nelder-Mead on the FIT constants, writes calibration.json
//     --selftest: fabricate "real" traces from known constants, fit from the defaults, and show the constants come back (proves the fitter, needs no game data)
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { runProbe } from './probes_run.mjs';
import { loadParams } from './params.js';
import { PROBE_NAMES } from '../behavior_pack/scripts/core/probes.js';

/** The constants the fit may move: path, lower bound, upper bound. */
export const FIT = [
  ['player.groundAccel', 0.04, 0.2], ['player.groundFriction', 0.3, 0.8], ['player.airAccel', 0.005, 0.05], ['player.jump', 0.3, 0.55], ['player.step', 0.3, 1.0],
  ['boat.landFriction', 0.2, 0.9], ['boat.wallKeep', 0, 1], ['boat.impulse', 0.05, 1], ['boat.step', 0.2, 0.8], ['boat.gravity', 0.02, 0.08],
  ['leash.rest', 2.5, 6], ['leash.k', 0.02, 0.6], ['leash.pow', 0.8, 3.5], ['leash.blend', 0.1, 1], ['leash.kVertical', 0.0, 3], ['leash.maxPull', 0.4, 3],
];
const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const toOverrides = (vec) => { const o = {}; FIT.forEach(([p], i) => { const [a, b] = p.split('.'); (o[a] ??= {})[b] = vec[i]; }); return o; };
const clamp = (v, [, lo, hi]) => Math.min(hi, Math.max(lo, v));

/** The real traces: the newest run of each probe in a probes.jsonl. */
export function loadReal(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); const r = e.rows ?? e.capsule?.rows; if (e.name && r?.length && !e.error) out[e.name] = { rows: r, marks: e.marks ?? [], t: e.t, build: e.build }; } catch { /* a cut line */ }
  }
  return out;
}

/** RMS of the position difference (blocks) between two traces, the bot and each watched entity apart. Each real row is matched to the sim row within +-2 ticks that is
 *  nearest (the game's waits land a tick or two off the sim's: a teleport one tick early is not a physics error); a speed error still shows, it grows past 2 ticks of travel. */
export function distance(real, sim, slack = 2) {
  const n = Math.min(real.length, sim.length);
  if (!n) return { rms: 99, parts: [] };
  const cols = Math.max(...real.map((r) => r.length), ...sim.map((r) => r.length));
  const parts = [];
  for (let g = 0; g * 6 < cols; g++) {
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const a = real[i].slice(g * 6, g * 6 + 3);
      if (a.some((v) => v == null)) continue; // not there yet / gone
      let best = Infinity;
      for (let d = -slack; d <= slack; d++) {
        const b = sim[i + d]?.slice(g * 6, g * 6 + 3);
        if (!b || b.some((v) => v == null)) continue;
        best = Math.min(best, (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
      }
      if (best < Infinity) { s += best; c++; }
    }
    parts.push(c ? Math.sqrt(s / c) : 0);
  }
  const miss = Math.max(0, Math.abs(real.length - sim.length) - 2); // a trace of a different length: the missing ticks count as 2 blocks off
  const rms = Math.sqrt(parts.reduce((a, p) => a + p * p, 0) / Math.max(1, parts.length) + (miss ? (miss / Math.max(real.length, sim.length)) * 4 : 0));
  return { rms, parts };
}

async function simTraces(names, params) {
  const out = {};
  for (const n of names) out[n] = await runProbe(n, { params });
  return out;
}

export async function score(real, params, only = null) {
  const names = Object.keys(real).filter((n) => PROBE_NAMES.includes(n) && (!only || only.includes(n)));
  const sim = await simTraces(names, params);
  const per = {};
  let tot = 0;
  for (const n of names) { per[n] = distance(real[n].rows, sim[n].rows); tot += per[n].rms; }
  return { total: names.length ? tot / names.length : 99, per };
}

/** Nelder-Mead over the FIT constants named in `free` (path prefixes; the rest stay as they are), scored on the probes in `only` (all when null); in units of each one's range. */
export async function fit(real, { start = null, iters = 400, log = console.log, free = null, only = null } = {}) {
  const base = loadParams();
  const full = (start ?? FIT.map(([p]) => get(base, p))).map((v, i) => clamp(v, FIT[i]));
  const idx = FIT.map((_, i) => i).filter((i) => !free || free.some((f) => FIT[i][0].startsWith(f)));
  const dim = idx.length;
  const build = (v) => { const out = [...full]; idx.forEach((gi, k) => { out[gi] = clamp(v[k], FIT[gi]); }); return out; };
  const f = async (v) => (await score(real, toOverrides(build(v)), only)).total;
  const x0 = idx.map((i) => full[i]), span = idx.map((i) => FIT[i][2] - FIT[i][1]);
  let simplex = [x0, ...x0.map((_, k) => { const v = [...x0]; v[k] = clamp(v[k] + span[k] * 0.08 * (v[k] + span[k] * 0.08 > FIT[idx[k]][2] ? -1 : 1), FIT[idx[k]]); return v; })];
  let vals = [];
  for (const v of simplex) vals.push(await f(v));
  const cl = (v, k) => clamp(v, FIT[idx[k]]);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = order.map((i) => simplex[i]); vals = order.map((i) => vals[i]);
    if (it % 25 === 0) log(`  fit ${it}/${iters}: residual ${vals[0].toFixed(4)} blocks`);
    if (vals[0] < 0.005 || vals[dim] - vals[0] < 1e-5) break;
    const cen = x0.map((_, j) => simplex.slice(0, dim).reduce((a, s) => a + s[j], 0) / dim);
    const at = (t) => cen.map((c, j) => cl(c + t * (simplex[dim][j] - c), j));
    const xr = at(-1), fr = await f(xr);
    if (fr < vals[0]) { const xe = at(-2), fe = await f(xe); if (fe < fr) { simplex[dim] = xe; vals[dim] = fe; } else { simplex[dim] = xr; vals[dim] = fr; } }
    else if (fr < vals[dim - 1]) { simplex[dim] = xr; vals[dim] = fr; }
    else {
      const xc = at(fr < vals[dim] ? -0.5 : 0.5), fc = await f(xc);
      if (fc < Math.min(fr, vals[dim])) { simplex[dim] = xc; vals[dim] = fc; }
      else for (let i = 1; i <= dim; i++) { simplex[i] = simplex[i].map((c, j) => cl(simplex[0][j] + 0.5 * (c - simplex[0][j]), j)); vals[i] = await f(simplex[i]); }
    }
  }
  const b = vals.indexOf(Math.min(...vals));
  return { vec: build(simplex[b]), residual: vals[b] };
}

function describe(res) {
  return Object.entries(res.per).map(([n, d]) => `  ${n.padEnd(11)} ${d.rms.toFixed(3)} blocks rms  (${d.parts.map((p) => p.toFixed(3)).join(', ')})`).join('\n');
}

const CAL_FILE = new URL('./calibration.json', import.meta.url);

if (process.argv[1].endsWith('calibrate.mjs')) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  if (process.argv.includes('--trace')) {
    // real vs sim, every 10th tick, of one probe: where they part
    const name = arg('--trace'), real = loadReal(arg('--real', fileURLToPath(new URL('../brain/logs/probes.jsonl', import.meta.url))))[name];
    const sim = await runProbe(name, {});
    const f = (r, i) => (r?.[i] == null ? '   -  ' : r[i].toFixed(2).padStart(6));
    for (let t = 0; t < Math.min(real.rows.length, sim.rows.length); t += Number(arg('--step', 10))) {
      const a = real.rows[t], b = sim.rows[t], m = real.marks.filter((k) => k.tick === t).map((k) => k.label).join();
      console.log(`t${String(t).padStart(3)} bot x ${f(a, 0)}|${f(b, 0)} y ${f(a, 1)}|${f(b, 1)} vx ${f(a, 3)}|${f(b, 3)}   ent x ${f(a, 6)}|${f(b, 6)} y ${f(a, 7)}|${f(b, 7)} z ${f(a, 8)}|${f(b, 8)}  ${m}`);
    }
  } else if (process.argv.includes('--selftest')) {
    // fabricate the game: other constants than the defaults
    const truth = { player: { groundAccel: 0.081, groundFriction: 0.58, jump: 0.44 }, boat: { landFriction: 0.42, step: 0.5 }, leash: { rest: 4.8, k: 0.21, kVertical: 0.55, maxPull: 1.1 } };
    const fake = {};
    for (const n of PROBE_NAMES) fake[n] = await runProbe(n, { params: truth });
    console.log('fake-real score against the defaults:', (await score(fake, {})).total.toFixed(3), 'blocks');
    const r = await fit(fake, { iters: Number(arg('--iters', 300)) });
    console.log('fit residual', r.residual.toFixed(4), '\n recovered vs truth:');
    FIT.forEach(([p], i) => console.log(`  ${p.padEnd(22)} ${r.vec[i].toFixed(4)}   (truth ${get(truth, p) ?? '(default)'})`));
  } else {
    const file = arg('--real', fileURLToPath(new URL('../brain/logs/probes.jsonl', import.meta.url)));
    const real = loadReal(file);
    const names = Object.keys(real);
    if (!names.length) { console.log(`no real probe traces in ${file}: run \`!bot test ${PROBE_NAMES.join(',')}\` in the game (brain/inbox/run.json does it) first`); process.exit(0); }
    console.log(`real traces: ${names.map((n) => `${n} (${real[n].build ?? '?'})`).join(', ')}`);
    const before = await score(real, {});
    console.log(`sim vs real now: ${before.total.toFixed(3)} blocks rms on average\n${describe(before)}`);
    if (process.argv.includes('--fit')) {
      // two stages: the walker's own physics from the probes that need no boat, then the boat and the lead with the walker's frozen (one fit trading them off bent the walker to suit the boat)
      const n = Number(arg('--iters', 400));
      const s1 = await fit(real, { iters: n, free: ['player.'], only: ['probewalk', 'probejump', 'probestep'] });
      console.log(`  stage 1 (the walker): ${s1.residual.toFixed(4)} blocks`);
      const r = await fit(real, { iters: n, start: s1.vec, free: ['boat.', 'leash.'] });
      const params = toOverrides(r.vec);
      const after = await score(real, params);
      writeFileSync(CAL_FILE, JSON.stringify({ fittedAt: new Date().toISOString(), builds: [...new Set(names.map((n) => real[n].build))], residual: after.total, perProbe: Object.fromEntries(Object.entries(after.per).map(([k, v]) => [k, v.rms])), params }, null, 1));
      console.log(`\nfitted: ${after.total.toFixed(3)} blocks rms (was ${before.total.toFixed(3)}), written to sim/calibration.json\n${describe(after)}\n${FIT.map(([p], i) => `  ${p} = ${r.vec[i].toFixed(4)}`).join('\n')}`);
    }
  }
}
