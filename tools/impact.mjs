// Run only the tests a change can affect.   node tools/impact.mjs [--run] [--base HEAD] [files ...]
// Builds the import graph (static and dynamic import() with literal paths) of every tests/*.test.js and the sim gate, takes the changed files (git diff against --base plus untracked,
// or the files named), and prints which unit tests, the gate and the brain's Python tests are worth running. --run runs them. When in doubt (a changed file nothing imports and not a
// known kind) it says so and selects everything: a wrong "nothing to run" is worse than an extra minute.
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

export function depsOf(file, cache = new Map()) {
  if (cache.has(file)) return cache.get(file);
  const seen = new Set([file]);
  const stack = [file];
  while (stack.length) {
    const f = stack.pop();
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|^import\s+)['"](\.[^'"]+)['"]/gm)) {
      let t = path.resolve(path.dirname(f), m[1]);
      if (!path.extname(t)) t += '.js';
      if (fs.existsSync(t) && !seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  cache.set(file, seen);
  return seen;
}

/** { unit: [test files], gate: bool, brain: bool, all: bool } for a list of changed repo-relative paths. */
export function select(changed, dirRoot = root) {
  const tests = fs.readdirSync(path.join(dirRoot, 'tests')).filter((f) => f.endsWith('.test.js')).map((f) => path.join(dirRoot, 'tests', f));
  const gateEntry = [path.join(dirRoot, 'sim/gate.mjs'), path.join(dirRoot, 'sim/eval_worker.mjs'), path.join(dirRoot, 'sim/run_tow.mjs')];
  const cache = new Map();
  const out = { unit: new Set(), gate: false, brain: false, all: false, notes: [] };
  for (const c of changed) {
    const abs = path.join(dirRoot, c);
    if (c.startsWith('brain/')) { out.brain = true; continue; }
    if (/\.(md|txt|json|bat)$/.test(c) && !c.startsWith('tests/')) { out.notes.push(`${c}: documentation or data, nothing to run`); continue; }
    if (c === 'behavior_pack/scripts/main.js') { out.notes.push(`${c}: loads only in the game; tools/check_imports.mjs (in the gate) is its test`); out.static = true; continue; }
    let hit = false;
    for (const t of tests) if (t === abs || depsOf(t, cache).has(abs)) { out.unit.add(path.relative(dirRoot, t)); hit = true; }
    if (gateEntry.some((g) => g === abs || depsOf(g, cache).has(abs)) || c.startsWith('sim/')) { out.gate = true; hit = true; }
    if (!hit && c.startsWith('tools/')) { out.notes.push(`${c}: a tool nothing imports`); continue; }
    if (!hit) { out.all = true; out.notes.push(`${c}: not reached from any test or the gate: running everything to be safe`); }
  }
  return { unit: [...out.unit].sort(), gate: out.gate || !!out.static, brain: out.brain, all: out.all, notes: out.notes };
}

if (process.argv[1].endsWith('impact.mjs')) {
  let changed = args.filter((a) => !a.startsWith('--') && a !== val('--base', null));
  if (!changed.length) {
    const base = val('--base', 'HEAD');
    const sh = (c) => { try { return execSync(c, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; } };
    changed = [...new Set([...sh(`git diff --name-only ${base}`), ...sh('git ls-files --others --exclude-standard')])];
  }
  const s = select(changed);
  const allTests = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.test.js')).map((f) => `tests/${f}`);
  const unit = s.all ? allTests : s.unit;
  console.log(`changed: ${changed.length} file(s)\nunit tests: ${unit.length}/${allTests.length}${unit.length ? ' -> ' + unit.map((u) => path.basename(u)).join(' ') : ''}\ngate: ${s.gate || s.all ? 'yes (node sim/gate.mjs --quick)' : 'no'}\nbrain python tests: ${s.brain || s.all ? 'yes' : 'no'}`);
  for (const n of s.notes) console.log('  note:', n);
  if (args.includes('--run')) {
    let fail = 0;
    if (unit.length) fail += spawnSync('node', ['--test', ...unit], { cwd: root, stdio: 'inherit' }).status ? 1 : 0;
    if (s.gate || s.all) fail += spawnSync('node', ['sim/gate.mjs', '--quick', '--no-unit'], { cwd: root, stdio: 'inherit' }).status ? 1 : 0;
    if (s.brain || s.all) fail += spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'brain/tests', '-t', '.'], { cwd: root, stdio: 'inherit' }).status ? 1 : 0;
    process.exit(fail ? 1 : 0);
  }
}
