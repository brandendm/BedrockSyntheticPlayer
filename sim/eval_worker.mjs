// A worker for the searches: reads one job per line on stdin ({id, kind, seed|name, level, tune}), runs it, writes {id, pass, secs} on stdout.
import { runTow } from './run_tow.mjs';
import { randomTowCourse } from './gencourse.mjs';
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const origLog = console.log; console.log = () => {}; console.error = () => {};
for await (const line of rl) {
  const j = JSON.parse(line);
  let r;
  try {
    r = j.kind === 'fixed' ? await runTow(j.name, { tune: j.tune, maxS: 120 })
      : await runTow(`rand${j.seed}`, { course: (x, gy, z) => randomTowCourse(j.seed, x, gy, z, j.level), tune: j.tune, maxS: 90 });
    origLog(JSON.stringify({ id: j.id, pass: r.pass, secs: r.secs, why: r.m?.why ?? '' }));
  } catch (e) { origLog(JSON.stringify({ id: j.id, pass: false, secs: 120, why: 'crash: ' + String(e).slice(0, 100) })); }
}
