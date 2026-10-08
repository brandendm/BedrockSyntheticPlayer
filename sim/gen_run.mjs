// node sim/gen_run.mjs [from] [to]   -- the bot's real code on random courses; seeds >= 1000 are the held-out set
import { runTow } from './run_tow.mjs';
import { randomTowCourse } from './gencourse.mjs';
const a = Number(process.argv[2] ?? 1), b = Number(process.argv[3] ?? 10);
let pass = 0, tot = 0, secs = 0;
for (let sd = a; sd <= b; sd++) {
  let d = ''; const r = await runTow(`rand${sd}`, { course: (x, gy, z) => { const c = randomTowCourse(sd, x, gy, z); d = c.desc; return c; }, maxS: 120 });
  tot++; if (r.pass) { pass++; secs += r.secs; }
  console.log(`seed ${sd}: ${r.pass ? 'PASS' : 'FAIL'} ${r.secs}s  [${d}]${r.pass ? '' : ' why=' + r.m.why}`);
}
console.log(`pass ${pass}/${tot}, mean ${(secs / Math.max(1, pass)).toFixed(1)}s on passes`);
