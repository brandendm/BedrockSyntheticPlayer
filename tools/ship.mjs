// One command from "I changed the bot" to "here is what the real game did":
//   node tools/ship.mjs [--bump] [--commit "message"] [--tests a,b,c] [--note "why"] [--wait 150] [--wait-only] [--no-run]
//   1. --bump: config.js build uNNN -> uNNN+1.
//   2. copies behavior_pack/ into the server's copy (server/development_behavior_packs/BedrockAgent) and checks the two are identical.
//   3. writes brain/inbox/run.json (reload, expect_build = the build, the tests; default the five tow courses). The brain's autorun must be enabled.
//   4. waits for brain/inbox/result.txt from THAT build and prints its summary (a result from another build is ignored: no stale answers).
//   5. --commit "msg": git add + commit, moving aside the .lock files git leaves where deleting is not allowed.
// Exit 0 = ran and every test passed, 1 = a test failed, 2 = still running (run again with --wait-only), 3 = could not ship (mismatch, no autorun).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2), has = (f) => args.includes(f), val = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const cfg = path.join(root, 'behavior_pack/scripts/config.js'), pack = path.join(root, 'behavior_pack');
const server = path.join(root, 'server/development_behavior_packs/BedrockAgent'), inbox = path.join(root, 'brain/inbox');
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o });
const build = () => /build:\s*'(u\d+)'/.exec(fs.readFileSync(cfg, 'utf8'))?.[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const files = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]);
const hash = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const die = (m, code = 3) => { console.log(m); process.exit(code); };

if (has('--bump')) { const b = build(); const n = `u${Number(b.slice(1)) + 1}`; fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(`build: '${b}'`, `build: '${n}'`)); console.log(`build ${b} -> ${n}`); }
const B = build();
const tests = (val('--tests', 'leadledge,leadstep,leadstair,leadturn,leadgate')).split(',');

if (!has('--wait-only')) {
  fs.cpSync(pack, server, { recursive: true, force: true });
  const bad = files(pack).filter((f) => !fs.existsSync(path.join(server, f)) || hash(path.join(pack, f)) !== hash(path.join(server, f)));
  if (bad.length) die(`NOT SYNCED: ${bad.slice(0, 5).join(', ')}`);
  console.log(`synced ${files(pack).length} files, build ${B}`);
  if (has('--commit')) {
    const gd = path.join(root, '.git'), aside = path.join(gd, 'stale-ship');
    fs.mkdirSync(aside, { recursive: true });
    const locks = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === 'stale-ship' || e.name === 'stale-262' ? [] : e.isDirectory() ? locks(path.join(d, e.name)) : /\.lock$/.test(e.name) ? [path.join(d, e.name)] : []);
    for (const l of locks(gd)) fs.renameSync(l, path.join(aside, `${path.basename(l)}-${Date.now()}`));
    sh('git', ['add', '-A', 'behavior_pack', 'sim', 'tools', 'tests', 'brain', 'README.md', 'package.json'], { stdio: 'pipe' });
    const msg = `${val('--commit')}\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01WP9dMv8FVgHzM89ehGX9gW`;
    try { sh('git', ['-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'commit', '-q', '-m', msg]); } catch (e) { console.log('commit: ' + String(e.stderr ?? e).split('\n').filter((l) => !/unable to unlink/.test(l)).join(' ').slice(0, 200)); }
    console.log('committed: ' + sh('git', ['log', '--oneline', '-1']).trim());
  }
  if (has('--no-run')) process.exit(0);
  fs.writeFileSync(path.join(inbox, 'run.json'), JSON.stringify({ tests, reload: true, expect_build: B, note: val('--note', `ship ${B}`), workers: Number(val('--workers', 1)) }));
  console.log(`queued ${tests.join(', ')} (expect ${B})`);
}

const t0 = fs.existsSync(path.join(inbox, 'run.json')) ? fs.statSync(path.join(inbox, 'run.json')).mtimeMs : Date.now();
const deadline = Date.now() + Number(val('--wait', 150)) * 1000, rf = path.join(inbox, 'result.txt');
let text = null;
while (Date.now() < deadline) {
  if (fs.existsSync(rf) && fs.statSync(rf).mtimeMs >= t0) { const t = fs.readFileSync(rf, 'utf8'); if (new RegExp(`game build ${B}\\b`).test(t.split('\n', 1)[0] ?? '')) { text = t; break; } else if (/AUTO RUN RESULT/.test(t.split('\n', 1)[0] ?? '') && new RegExp(`expecting ${B}\\b`).test(t)) { text = t; break; } }
  await sleep(2000);
}
if (!text) die(`no result for ${B} yet: still running, or the autorun is off (dashboard "enabled" switch), or the game/brain is down.\nrun again: node tools/ship.mjs --wait-only --wait 150`, 2);
const lines = text.split('\n');
console.log(lines.slice(0, 4).join('\n'));
for (const l of lines) if (/^\s+(SUMMARY|run) /.test(l)) console.log(l.slice(0, 200));
for (const l of lines) if (/^\s+\S+: (PASS|FAIL)/.test(l)) console.log(l.slice(0, 170));
const failed = lines.some((l) => /^\s+SUMMARY \S+: (?!PASS)/.test(l)) || !/outcome: ok/.test(text);
console.log(failed ? '\nSHIP: FAILED (full report: brain/inbox/result.txt)' : '\nSHIP: ALL PASS');
process.exit(failed ? 1 : 0);
