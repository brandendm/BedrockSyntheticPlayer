// The smallest course that still fails.   node sim/minimize.mjs <seed> [--timeline]
// Takes the random course for the seed and keeps dropping parts (then shortening what is left) for as long as the bot still fails it.
import { runTow } from './run_tow.mjs';
import { towParts, buildCourse, describeParts } from './gencourse.mjs';
import { timelineText } from './report.mjs';

export async function fails(parts, maxS = 90) {
  const r = await runTow('min', { course: (x, gy, z) => buildCourse(parts, x, gy, z), maxS });
  return { fail: !r.pass, r };
}
export async function minimize(parts, log = () => {}) {
  let cur = parts, changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < cur.length && cur.length > 1; i++) {
      const t = cur.filter((_, k) => k !== i);
      if ((await fails(t)).fail) { log(`drop part ${i} -> ${describeParts(t)}`); cur = t; changed = true; break; }
    }
  }
  // shorter gaps / treads / depths, one notch at a time
  for (let i = 0; i < cur.length; i++) for (const key of ['gap', 'tread', 'depth']) {
    while (cur[i][key] > (key === 'gap' ? 2 : 3)) {
      const t = cur.map((p, k) => k === i ? { ...p, [key]: p[key] - 1 } : p);
      if ((await fails(t)).fail) { cur = t; log(`${key} of part ${i} -> ${cur[i][key]}`); } else break;
    }
  }
  return cur;
}
if ((process.argv[1] ?? '').endsWith('minimize.mjs')) {
  const pi = process.argv.indexOf('--parts');
  const seed = Number(process.argv[2]);
  const start = pi > 0 ? JSON.parse(process.argv[pi + 1]) : towParts(seed);
  const f0 = await fails(start);
  if (!f0.fail) { console.log(`seed ${seed} (${describeParts(start)}) passes: nothing to minimize`); process.exit(0); }
  console.log(`seed ${seed} fails: ${describeParts(start)}`);
  const small = await minimize(start, (m) => console.log('  ' + m));
  const f = await fails(small);
  console.log(`\nminimal failing course: ${describeParts(small)}\n  parts: ${JSON.stringify(small)}\n  re-run: node sim/minimize.mjs --parts '${JSON.stringify(small)}'`);
  if (process.argv.includes('--timeline')) console.log('\n' + timelineText(f.r));
}
