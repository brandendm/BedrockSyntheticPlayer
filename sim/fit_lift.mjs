// Fit the jump formula (core/liftmodel.js) to real (or simulated) `probejumps` traces.
//   node sim/fit_lift.mjs [--real brain/logs/probes.jsonl] [--apply] [--sim]
// --sim fits to the simulator's own run of the probe instead (proves the pipeline; the simulator has no two-jump regime). --apply rewrites LIFT in core/liftmodel.js.
import fs from 'node:fs';
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
const { fitLift, LIFT, jumpsNeeded } = await import('../behavior_pack/scripts/core/liftmodel.js');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') ? true : process.argv[i + 1] ?? true); };

/** [{ h, d, jumps }] from one probejumps record ({ marks, rows }): the k-th trial's boat is the k-th watched thing (columns 6 + 6k .. ). */
export function trialsOf(rec) {
  const marks = rec.marks, rows = rec.rows, out = [];
  let k = -1;
  for (let i = 0; i < marks.length; i++) {
    const m = /^h (\d+) d ([\d.]+)$/.exec(marks[i].label);
    if (!m) continue;
    k++;
    const h = +m[1], d = +m[2], c = 6 + 6 * k;
    let jumps = 0;
    for (let j = 1; j <= 4; j++) {
      const jm = marks.find((x, ix) => ix > i && x.label === `jump ${j}`);
      if (!jm) break;
      const end = rows[jm.tick + 24] ? jm.tick + 24 : rows.length - 1;
      const y = rows[end]?.[c + 1];
      if (Number.isFinite(y) && y >= 1 + h - 0.3) { jumps = j; break; }
    }
    out.push({ h, d, jumps });
  }
  return out;
}

if (process.argv[1].endsWith('fit_lift.mjs')) {
  let rec = null;
  if (arg('--sim')) {
    const { runProbe } = await import('./probes_run.mjs');
    rec = await runProbe('probejumps');
  } else {
    const file = arg('--real', new URL('../brain/logs/probes.jsonl', import.meta.url).pathname);
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) { try { const e = JSON.parse(l); if (e.name === 'probejumps') rec = e; } catch { /* */ } }
    if (!rec) { console.log('no probejumps in', file, '(run `!bot test probejumps` in the real game first)'); process.exit(3); }
  }
  const T = trialsOf(rec);
  console.log(`${T.length} trials${rec.build ? ` (build ${rec.build})` : ''}:`);
  for (const h of [1, 2, 3]) console.log(`  h ${h}: ` + T.filter((t) => t.h === h).map((t) => `${t.d}→${t.jumps || '-'}`).join('  '));
  const f = fitLift(T);
  const cur = T.filter((t) => { const p = jumpsNeeded(t.h, t.d); return (Number.isFinite(p) ? p : 0) !== t.jumps; }).length;
  console.log(`current LIFT ${JSON.stringify(LIFT)} gets ${T.length - cur}/${T.length} right`);
  console.log(`best fit ${JSON.stringify(f.model)} gets ${f.total - f.wrong}/${f.total} right`);
  if (arg('--apply') && !arg('--sim')) {
    const p = new URL('../behavior_pack/scripts/core/liftmodel.js', import.meta.url).pathname;
    const src = fs.readFileSync(p, 'utf8').replace(/export const LIFT = \{[^}]*\};/, `export const LIFT = { pull: ${f.model.pull}, jump: ${f.model.jump}, need0: ${f.model.need0}, needPerH: ${f.model.needPerH}, maxJumps: ${LIFT.maxJumps} };`);
    fs.writeFileSync(p, src);
    console.log('written to core/liftmodel.js');
  }
}
