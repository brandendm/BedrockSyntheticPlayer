// Writes the trainer's champion (brain/trainer/champion.json) into core/tunables.js as the new defaults, so it survives a wiped world and ships with the pack.
//   node tools/bake_policy.mjs [--file brain/trainer/champion.json] [--dry]
// Only known keys, only inside their ranges (anything else is skipped and said). Run the unit tests and the gate after; then clear the world's copy (`!bot policy clear`).
import fs from 'node:fs';
import { TUNABLES } from '../behavior_pack/scripts/core/tunables.js';

export function bake(src, champion) {
  const done = [], skipped = [];
  for (const [k, v] of Object.entries(champion ?? {})) {
    const d = TUNABLES[k];
    if (!d || typeof v !== 'number' || !Number.isFinite(v) || v < d.min || v > d.max) { skipped.push(k); continue; }
    // the tow keys live in core/towtune.js (v: ...), the rest in core/tunables.js
    const re = new RegExp(`(\\b${k}:\\s*\\{ v: )[0-9.]+`);
    if (!re.test(src)) { skipped.push(k); continue; }
    src = src.replace(re, `$1${v}`); done.push(k);
  }
  return { src, done, skipped };
}
if ((process.argv[1] ?? '').endsWith('bake_policy.mjs')) {
  const args = process.argv.slice(2), file = args.includes('--file') ? args[args.indexOf('--file') + 1] : new URL('../brain/trainer/champion.json', import.meta.url).pathname;
  const champion = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  let total = [];
  for (const rel of ['core/tunables.js', 'core/towtune.js']) {
    const f = new URL(`../behavior_pack/scripts/${rel}`, import.meta.url).pathname;
    const r = bake(fs.readFileSync(f, 'utf8'), Object.fromEntries(Object.entries(champion).filter(([k]) => (rel === 'core/towtune.js') === (TUNABLES[k]?.group === 'tow'))));
    total = total.concat(r.done);
    if (!args.includes('--dry') && r.done.length) fs.writeFileSync(f, r.src);
  }
  console.log(`baked ${total.length} of ${Object.keys(champion).length}: ${total.join(', ') || '-'}`);
}
