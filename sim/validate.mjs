// Outcome calibration: does the simulator get the COURSES right (pass or fail, and how long), not just the probe traces? The real game's bot runs of each tow course
// (brain/logs/tests*.jsonl, test_run events) against the sim's: pass rate, median time with a bootstrap 90% interval, and the ratio sim/real. A ratio far from 1, or a
// pass in the sim where the game fails, is a gap the probes did not catch (e.g. README: leadstep 9 s in the sim, 13 in the game) - the thing to fit next.
//   node sim/validate.mjs [course ...] [--log file ...] [--n 5] [--posterior] [--json]
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { runTow } from './run_tow.mjs';
import { TOW_NAMES } from '../behavior_pack/scripts/core/towcourses.js';

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

/** test_run events of the bot on a course: [{name, pass, secs}] from jsonl text. */
export function readRuns(text) {
  const out = [], seen = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.type !== 'test_run' || e.stopped || !e.name || !e.who || e.who === 'human') continue;
      const k = `${e.t}|${e.name}|${e.who}`; if (seen.has(k)) continue; seen.add(k); // (tests.jsonl rolls into .prev, history repeats)
      const secs = typeof e.summary?.secs === 'number' ? e.summary.secs : typeof e.secs === 'number' ? e.secs : null;
      out.push({ name: String(e.name).replace(/horse$/, ''), horse: /horse$/.test(e.name), pass: !!e.pass, secs });
    } catch { /* a cut line */ }
  }
  return out;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
/** Bootstrap interval of the median (seeded, so the same data gives the same answer). */
export function bootMedian(a, B = 400, q = 0.9) {
  if (a.length < 3) return null;
  let s = 12345; const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const m = []; for (let b = 0; b < B; b++) m.push(median(a.map(() => a[Math.floor(r() * a.length)])));
  m.sort((x, y) => x - y); return [m[Math.floor(B * (1 - q) / 2)], m[Math.ceil(B * (1 + q) / 2) - 1]];
}
/** One course: real runs vs sim runs -> a verdict line's numbers. */
export function compare(real, sim) {
  const rp = real.filter((r) => r.pass).map((r) => r.secs).filter(Boolean), sp = sim.filter((r) => r.pass).map((r) => r.secs).filter(Boolean);
  const rm = median(rp), sm = median(sp), ci = bootMedian(rp);
  const realRate = real.length ? real.filter((r) => r.pass).length / real.length : null, simRate = sim.length ? sim.filter((r) => r.pass).length / sim.length : null;
  const ratio = rm && sm ? sm / rm : null;
  let verdict = 'ok';
  if (!real.length) verdict = 'no real runs';
  else if (simRate === 1 && realRate !== null && realRate < 0.5) verdict = 'SIM TOO EASY (passes where the game fails)';
  else if (simRate === 0 && realRate > 0.5) verdict = 'SIM TOO HARD';
  else if (ratio && (ratio < 0.75 || ratio > 1.33)) verdict = ratio < 1 ? 'sim too fast' : 'sim too slow';
  else if (ci && sm && (sm < ci[0] * 0.9 || sm > ci[1] * 1.1)) verdict = 'sim time outside the real interval';
  return { n: real.length, realRate, simRate, realMedian: rm, simMedian: sm, ci, ratio, verdict };
}

if (process.argv[1].endsWith('validate.mjs')) {
  const logs = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--log') logs.push(argv[i + 1]);
  if (!logs.length) { const dir = fileURLToPath(new URL('../brain/logs/', import.meta.url)); if (existsSync(dir)) for (const f of readdirSync(dir)) if (/^tests.*\.jsonl$/.test(f) || f === 'test_history.jsonl') logs.push(dir + f); }
  const real = readRuns(logs.filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n')).filter((r) => !r.horse);
  const names = argv.filter((a, i) => !a.startsWith('--') && !['--log', '--n'].includes(argv[i - 1]) && TOW_NAMES.includes(a));
  const N = Number(val('--n', 5)), rows = {};
  for (const name of names.length ? names : TOW_NAMES) {
    const sim = [];
    for (let i = 0; i < N; i++) { const o = await runTow(name, {}); sim.push({ pass: o.pass, secs: o.secs }); if (i === 0 && !flag('--posterior')) break; }
    rows[name] = compare(real.filter((r) => r.name === name), sim);
  }
  if (flag('--json')) console.log(JSON.stringify(rows, null, 1));
  else {
    console.log(`real bot runs read: ${real.length} from ${logs.length} file(s)\ncourse       real pass   sim pass   real med (90% CI)      sim med   ratio   verdict`);
    for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(10)} ${v.realRate == null ? '   -   ' : `${Math.round(v.realRate * 100)}% n=${v.n}`.padStart(9)}   ${v.simRate == null ? '-' : `${Math.round(v.simRate * 100)}%`.padStart(6)}   ${v.realMedian ? `${v.realMedian.toFixed(1)} s${v.ci ? ` (${v.ci[0].toFixed(1)}-${v.ci[1].toFixed(1)})` : ''}`.padEnd(20) : '-'.padEnd(20)} ${v.simMedian ? `${v.simMedian.toFixed(1)} s` : '-'}   ${v.ratio ? v.ratio.toFixed(2) : '-'}   ${v.verdict}`);
  }
  process.exit(0);
}
