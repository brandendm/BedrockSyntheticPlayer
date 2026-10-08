// Static link check for the game's modules: every named import from a relative module must be something that module exports, and every relative import must resolve.
// main.js cannot be loaded off the game (it needs the GameTest API), so a misspelt import there would only show up when the pack fails to start. Run by the gate.
//   node tools/check_imports.mjs [dir]       exit 1 on any problem
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

export function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop(); if (n) names.add(n); }
  if (/^export\s+default\b/m.test(src)) names.add('default');
  for (const m of src.matchAll(/^export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)) names.add(`*${m[1]}`);
  return names;
}
export function importsOf(src) {
  const out = [];
  for (const m of src.matchAll(/^import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+[\w$]+\s*)?from\s*['"]([^'"]+)['"]/gm)) {
    const named = (m[2] ?? '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    out.push({ spec: m[3], named, def: m[1] ?? null });
  }
  return out;
}
export function check(dir) {
  const problems = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  const cache = new Map();
  const exp = (f) => { if (!cache.has(f)) cache.set(f, exportsOf(fs.readFileSync(f, 'utf8'))); return cache.get(f); };
  for (const f of walk(dir)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const im of importsOf(src)) {
      if (!im.spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(f), im.spec);
      if (!fs.existsSync(target)) { problems.push(`${path.relative(dir, f)}: imports ${im.spec}, which does not exist`); continue; }
      const have = exp(target);
      if ([...have].some((n) => n.startsWith('*'))) continue; // (re-exports: not followed)
      for (const n of im.named) if (!have.has(n)) problems.push(`${path.relative(dir, f)}: imports { ${n} } from ${im.spec}, which does not export it`);
      if (im.def && !have.has('default')) problems.push(`${path.relative(dir, f)}: default import from ${im.spec}, which has no default export`);
    }
  }
  return problems;
}
if (process.argv[1].endsWith('check_imports.mjs')) {
  const dir = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../behavior_pack/scripts', import.meta.url)));
  const p = check(dir);
  console.log(p.length ? p.join('\n') : `imports ok (${dir})`);
  process.exit(p.length ? 1 : 0);
}
