// The real game, every scenario, one build against the last good one.   node tools/regress.mjs ...   (run on the PC; the brain's autorun must be enabled)
//   --start [--set tow|probes|core|all] [--chunk 6] [--slow]   begin a run (core = the scenarios that are neither tow nor probes; --slow adds the slow ones)
//   --continue [--wait 150]                                    carry on (each call waits up to --wait seconds, then says what is left: call again)
//   --update                                                   after a finished run: make it the baseline (brain/regress_baseline.json)
//   --status                                                   where a run is
// Per scenario it keeps pass/fail and seconds, and at the end lists REGRESSIONS (passed before, fails now), SLOWER (>25% + 3 s), FASTER, NEW, to brain/reports/regress-<build>.md.
// Exit 0 = nothing regressed, 1 = regressions, 2 = unfinished.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2), has = (f) => args.includes(f), val = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const inbox = path.join(root, 'brain/inbox'), stateF = path.join(inbox, 'regress_state.json'), baseF = path.join(root, 'brain/regress_baseline.json');
const build = () => /build:\s*'(u\d+)'/.exec(fs.readFileSync(path.join(root, 'behavior_pack/scripts/config.js'), 'utf8'))?.[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const save = (s) => fs.writeFileSync(stateF, JSON.stringify(s, null, 1));

async function names(set, slow) {
  const src = fs.readFileSync(path.join(root, 'behavior_pack/scripts/game/scenarios.js'), 'utf8');
  const all = [...(/const NAMES = \[([^\]]*)\]/.exec(src)?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  const SLOW = new Set([...(/const SLOW = new Set\(\[([^\]]*)\]/.exec(src)?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
  const { TOW_NAMES } = await import(path.join(root, 'behavior_pack/scripts/core/towcourses.js'));
  const { PROBE_NAMES } = await import(path.join(root, 'behavior_pack/scripts/core/probes.js'));
  const tow = new Set(TOW_NAMES), pr = new Set(PROBE_NAMES);
  const pick = { tow: [...tow], probes: [...pr], core: all.filter((n) => !tow.has(n) && !pr.has(n)), all: [...new Set([...all, ...tow, ...pr])] }[set];
  if (!pick) throw new Error(`unknown set ${set}`);
  return pick.filter((n) => slow || set === 'tow' || set === 'probes' || !SLOW.has(n));
}
function parse(text) {
  const out = {};
  for (const l of text.split('\n')) {
    let m = /^\s+SUMMARY (\w+): (PASS|FAIL|\w+)/.exec(l); if (m) (out[m[1]] ??= {}).pass = m[2] === 'PASS';
    m = /^\s+run (\w+): ([\d.]+) s/.exec(l); if (m) (out[m[1]] ??= {}).secs = Number(m[2]);
  }
  return out;
}
function report(st) {
  const base = readJ(baseF, null), rows = [], bad = [];
  for (const [n, r] of Object.entries(st.done)) {
    const b = base?.results?.[n]; let tag = '';
    if (b?.pass && !r.pass) { tag = 'REGRESSION'; bad.push(n); }
    else if (!b) tag = 'new';
    else if (r.pass && b.secs != null && r.secs != null && r.secs > b.secs * 1.25 + 3) tag = `SLOWER (was ${b.secs}s)`;
    else if (r.pass && b.secs != null && r.secs != null && r.secs < b.secs * 0.8 - 1) tag = `faster (was ${b.secs}s)`;
    else if (!b.pass && r.pass) tag = 'FIXED';
    rows.push(`| ${n} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.secs ?? '-'} | ${tag} |`);
  }
  const passN = Object.values(st.done).filter((r) => r.pass).length;
  const md = [`# Regression ${st.build} (${st.set})`, `vs baseline ${base?.build ?? '(none)'}: ${passN}/${rows.length} pass, ${bad.length} regressions`, '', '| scenario | result | secs | vs baseline |', '|---|---|---|---|', ...rows, ''].join('\n');
  fs.mkdirSync(path.join(root, 'brain/reports'), { recursive: true });
  fs.writeFileSync(path.join(root, `brain/reports/regress-${st.build}.md`), md);
  console.log(md);
  return bad.length;
}

if (has('--status')) { const s = readJ(stateF, null); console.log(s ? `${s.build} ${s.set}: ${Object.keys(s.done).length} done, ${s.queue.length} queued, current ${s.current.join(',') || '-'}` : 'no run'); process.exit(0); }
if (has('--update')) { const s = readJ(stateF, null); if (!s || s.queue.length || s.current.length) { console.log('no finished run to adopt'); process.exit(3); } fs.writeFileSync(baseF, JSON.stringify({ build: s.build, set: s.set, results: { ...(readJ(baseF, {}).results ?? {}), ...s.done } }, null, 1)); console.log(`baseline = ${s.build} (${Object.keys(s.done).length} scenarios)`); process.exit(0); }

let st = readJ(stateF, null);
if (has('--start')) {
  const set = val('--set', 'tow'), q = await names(set, has('--slow'));
  st = { build: build(), set, chunk: Number(val('--chunk', 6)), queue: q, current: [], done: {}, sentAt: 0, first: true };
  save(st); console.log(`regression ${st.build}: ${q.length} scenarios (${set}) in chunks of ${st.chunk}`);
}
if (!st) { console.log('no run: --start first'); process.exit(3); }
if (st.build !== build()) { console.log(`the run is for ${st.build} but config.js says ${build()}: start again`); process.exit(3); }

const deadline = Date.now() + Number(val('--wait', 150)) * 1000;
while (Date.now() < deadline || (!st.current.length && st.queue.length)) {
  if (!st.current.length) {
    if (!st.queue.length) break;
    st.current = st.queue.splice(0, st.chunk);
    fs.writeFileSync(path.join(inbox, 'run.json'), JSON.stringify({ tests: st.current, reload: st.first, expect_build: st.build, note: `regress ${st.set}` }));
    st.first = false; st.sentAt = Date.now(); save(st); console.log(`sent: ${st.current.join(', ')}`);
  }
  const rf = path.join(inbox, 'result.txt');
  if (fs.existsSync(rf) && fs.statSync(rf).mtimeMs >= st.sentAt) {
    const text = fs.readFileSync(rf, 'utf8');
    if (new RegExp(`game build ${st.build}\\b`).test(text.split('\n', 1)[0])) {
      const got = parse(text);
      for (const n of st.current) st.done[n] = { pass: got[n]?.pass ?? false, secs: got[n]?.secs ?? null };
      console.log(`done: ${st.current.map((n) => `${n} ${st.done[n].pass ? 'PASS' : 'FAIL'}`).join(', ')}`);
      st.current = []; save(st); continue;
    }
  }
  await sleep(3000);
}
if (st.current.length || st.queue.length) { console.log(`unfinished: ${Object.keys(st.done).length} done, ${st.current.length + st.queue.length} to go: call again with --continue`); process.exit(2); }
process.exit(report(st) ? 1 : 0);
