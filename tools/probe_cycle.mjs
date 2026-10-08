// One probe, ship -> real game -> compared with the sim.   node tools/probe_cycle.mjs probefoo [--bump] [--wait 150]   (on the PC)
// Runs tools/ship.mjs for the probe, then sim/calibrate.mjs on brain/logs/probes.jsonl and prints that probe's sim-vs-real error per watched thing, and the
// worst-matching moments (node sim/calibrate.mjs --trace <name> --step 10 shows the whole table). Exit 2 = still running: call again with --wait-only.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2), name = args.find((a) => a.startsWith('probe'));
if (!name) { console.log('usage: node tools/probe_cycle.mjs probefoo [--bump] [--wait-only] [--wait 150]'); process.exit(3); }
const pass = args.filter((a, i) => a !== name && (a === '--bump' || a === '--wait-only' || a === '--wait' || args[i - 1] === '--wait'));
const sh = spawnSync('node', ['tools/ship.mjs', '--tests', name, '--note', `probe cycle ${name}`, ...pass], { cwd: root, encoding: 'utf8' });
process.stdout.write((sh.stdout ?? '').split('\n').filter((l) => /synced|queued|SUMMARY|SHIP|no result|run again/.test(l)).join('\n') + '\n');
if (sh.status === 2 || sh.status === 3) process.exit(sh.status);
const cal = spawnSync('node', ['sim/calibrate.mjs', '--real', 'brain/logs/probes.jsonl'], { cwd: root, encoding: 'utf8' });
const lines = (cal.stdout ?? '').split('\n').filter((l) => /sim vs real|real traces/.test(l) || l.trim().startsWith(name));
console.log(lines.join('\n') || `no real trace for ${name} yet`);
