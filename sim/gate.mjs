// One command before anything ships:   npm run gate   (node sim/gate.mjs [--update] [--quick] [--no-unit])
// Runs the unit tests, the five fixed tow courses (with no learned memory, and with a player's learned memory), and the random courses
// (seeds 1-20 to work on, 1000-1011 held out), then compares with sim/baseline.json and exits 1 on a regression:
//   - any fixed course that fails, or is more than 25% (+2 s) slower than before;
//   - any random seed that passed before and fails now, or a pass count below the baseline's.
// --update writes the new numbers as the baseline (after a change you meant). --quick: fixed courses and the held-out seeds only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { runTow } from './run_tow.mjs';
import { randomTowCourse } from './gencourse.mjs';

const args = process.argv.slice(2), has = (f) => args.includes(f);
const BASE = new URL('./baseline.json', import.meta.url).pathname;
const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : null;
const LEARNED = '{"walk":{"pullAt":5,"patience":20,"sling":{"flat":{"stretch":4.7}}}}';
const bad = [], now = { fixed: {}, rand: {} };
const log = (s) => console.log(s);

if (!has('--no-unit')) {
  const r = spawnSync('node', ['--test', ...fs.readdirSync(new URL('../tests', import.meta.url).pathname).filter((f) => f.endsWith('.test.js')).map((f) => `tests/${f}`)], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
  const m = /# pass (\d+)[\s\S]*# fail (\d+)/.exec(r.stdout ?? '');
  log(`unit tests: ${m ? `${m[1]} pass, ${m[2]} fail` : 'did not run'}`);
  if (!m || m[2] !== '0') bad.push('unit tests fail');
}

// the game's scenario file must at least load (a module-level mistake takes the whole pack down in the real game)
try { const m = await import('../behavior_pack/scripts/game/scenarios.js'); log(`scenarios.js loads (${typeof m.runTests})`); } catch (e) { log(`scenarios.js DOES NOT LOAD: ${String(e).slice(0, 160)}`); bad.push('scenarios.js does not load'); }

for (const mode of ['fresh', 'learned']) {
  if (mode === 'learned') process.env.LEARNED = LEARNED; else delete process.env.LEARNED;
  for (const c of ['leadledge', 'leadstep', 'leadstair', 'leadturn', 'leadgate']) {
    const r = await runTow(c, { maxS: 120 }), key = `${c}/${mode}`;
    now.fixed[key] = { pass: r.pass, secs: r.secs };
    const b = base?.fixed?.[key];
    let flag = '';
    if (!r.pass) { flag = ' FAIL'; bad.push(`${key} fails`); }
    else if (b?.pass && r.secs > b.secs * 1.25 + 2) { flag = ` SLOWER (was ${b.secs}s)`; bad.push(`${key} slower: ${b.secs}s -> ${r.secs}s`); }
    log(`  ${key.padEnd(18)} ${r.pass ? 'PASS' : 'fail'} ${r.secs}s${flag}`);
  }
}
delete process.env.LEARNED;

const sets = [['held-out', 1000, 1011], ...(has('--quick') ? [] : [['seeds', 1, 20]])];
for (const [label, a, b] of sets) {
  let pass = 0, tot = 0;
  for (let sd = a; sd <= b; sd++) {
    const r = await runTow(`rand${sd}`, { course: (x, gy, z) => randomTowCourse(sd, x, gy, z), maxS: 90 });
    now.rand[sd] = { pass: r.pass, secs: r.secs }; tot++; if (r.pass) pass++;
    if (base?.rand?.[sd]?.pass && !r.pass) bad.push(`seed ${sd} passed before and fails now (node sim/minimize.mjs ${sd})`);
  }
  const bp = base ? Object.entries(base.rand).filter(([k]) => k >= a && k <= b).filter(([, v]) => v.pass).length : null;
  log(`${label} ${a}-${b}: ${pass}/${tot}${bp !== null ? ` (baseline ${bp})` : ''}`);
  if (bp !== null && pass < bp) bad.push(`${label}: ${pass} pass, baseline ${bp}`);
}

if (has('--update') || !base) { fs.writeFileSync(BASE, JSON.stringify({ ...(base ?? {}), ...now, rand: { ...(base?.rand ?? {}), ...now.rand } }, null, 1)); log(`baseline ${base ? 'updated' : 'written'}`); }
if (bad.length) { log('\nGATE FAILED:'); for (const b of [...new Set(bad)]) log('  - ' + b); process.exit(1); }
log('\nGATE OK');
