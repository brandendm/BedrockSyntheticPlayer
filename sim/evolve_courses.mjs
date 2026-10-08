// POET-lite for the tow (u292): breed courses that tell good policies from bad ones, keep the hard ones forever.
//   node sim/evolve_courses.mjs [--gens 6] [--pop 16] [--seed 1] [--variants 4] [--out sim/hardcourses.json]
// A course is a list of parts (sim/gencourse.mjs). Each generation mutates the best courses, runs every child under the DEFAULT policy plus a few
// perturbed ones (the variants), and scores it by how much it separates them ("minimal criterion": solvable by some policy, not by all). A course the
// default policy fails but a variant passes is a lesson the search can learn from (kept as `learnable`); one nobody passes is kept apart as `unsolved`
// (probably a simulator or bot gap: a lead for a human, never put into the training sets). The archive is deduplicated by description.
import fs from 'node:fs';
import { runJobs } from './pool.mjs';
import { towParts, describeParts } from './gencourse.mjs';
import { defaults, keysOf, TUNABLES } from '../behavior_pack/scripts/core/tunables.js';

const args = process.argv.slice(2), val = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const gens = Number(val('--gens', 6)), pop = Number(val('--pop', 16)), seed = Number(val('--seed', 1)), nvar = Number(val('--variants', 4));
const out = val('--out', new URL('./hardcourses.json', import.meta.url).pathname);
let s = (seed * 2654435761) >>> 0 || 1;
const R = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const ri = (a, b) => a + Math.floor(R() * (b - a + 1));

/** A mutated copy (never more than 7 parts; the layout is relative so any list is a course). */
export function mutate(parts) {
  const p = parts.map((q) => ({ ...q }));
  const op = ri(0, 4);
  if (op === 0 && p.length < 7) { const kind = ['step', 'gate', 'wall', 'pit'][ri(0, 3)]; p.splice(ri(0, p.length), 0, kind === 'pit' ? { kind, width: ri(3, 5), gap: ri(4, 6) } : kind === 'step' ? { kind, tread: ri(3, 6), gap: ri(2, 5) } : kind === 'gate' ? { kind, south: R() < 0.5, gap: ri(5, 9) } : { kind, depth: ri(6, 9), gap: ri(6, 8) }); }
  else if (op === 1 && p.length > 2) p.splice(ri(0, p.length - 1), 1);
  else if (op === 2 && p.length > 1) { const i = ri(0, p.length - 2); [p[i], p[i + 1]] = [p[i + 1], p[i]]; }
  else { const q = p[ri(0, p.length - 1)]; if (q.kind === 'step') q.tread = ri(3, 6); else if (q.kind === 'gate') q.south = !q.south; else if (q.kind === 'pit') q.width = ri(3, 5); else q.depth = ri(6, 9); q.gap = Math.max(2, q.gap + ri(-1, 1)); }
  return p;
}

/** A few policies away from the default (each a random point inside the ranges, nearer the default than not). */
export function variants(n) {
  const d = defaults(), keys = keysOf('tow'), vs = [d];
  for (let i = 1; i < n; i++) { const v = { ...d }; for (const k of keys) { const t = TUNABLES[k]; const d = (R() * 2 - 1) * 0.6; v[k] = Math.round(Math.min(t.max, Math.max(t.min, t.v + d * (d > 0 ? t.max - t.v : t.v - t.min))) * 1000) / 1000; } vs.push(v); }
  return vs;
}

/** pass[i] for course i under each variant: returns { pass: bool[][], secs } and the criterion score. */
export function criterion(passes) {
  const n = passes.length, p = passes.filter(Boolean).length / n;
  if (p === 0) return { score: 0, kind: 'unsolved' };
  const spread = 4 * p * (1 - p);                                  // 1 when half pass: the course separates the policies
  return { score: spread + (passes[0] ? 0 : 0.5), kind: passes[0] ? 'solved' : 'learnable' };   // the default failing it is worth more
}

async function main() {
  let arch = { courses: [], unsolved: [] };
  try { arch = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* new */ }
  arch.unsolved ??= [];
  const known = new Set([...arch.courses, ...arch.unsolved].map((c) => c.desc));
  let parents = Array.from({ length: pop }, (_, i) => towParts(5000 + seed * 100 + i, 2));
  const vs = variants(nvar);
  for (let g = 0; g < gens; g++) {
    const kids = g === 0 ? parents : Array.from({ length: pop }, (_, i) => mutate(parents[i % parents.length]));
    const jobs = [];
    kids.forEach((parts, ci) => vs.forEach((tune, vi) => jobs.push({ kind: 'parts', parts, tune, ci, vi })));
    const res = await runJobs(jobs);
    const scored = kids.map((parts, ci) => {
      const passes = vs.map((_, vi) => !!res[ci * vs.length + vi]?.pass);
      return { parts, desc: describeParts(parts), ...criterion(passes) };
    });
    for (const c of scored) {
      if (known.has(c.desc)) continue;
      if (c.kind === 'learnable') { arch.courses.push({ parts: c.parts, desc: c.desc, gen: g, seed }); known.add(c.desc); }
      else if (c.kind === 'unsolved') { arch.unsolved.push({ parts: c.parts, desc: c.desc, gen: g, seed }); known.add(c.desc); }
    }
    scored.sort((a, b) => b.score - a.score);
    parents = scored.slice(0, Math.max(2, Math.floor(pop / 3))).map((c) => c.parts);
    console.error(`gen ${g}: best ${scored[0].score.toFixed(2)} (${scored[0].kind}) ${scored[0].desc}; archive ${arch.courses.length} learnable, ${arch.unsolved.length} unsolved`);
  }
  arch.courses = arch.courses.slice(-40); arch.unsolved = arch.unsolved.slice(-40);
  fs.writeFileSync(out, JSON.stringify(arch, null, 1));
  console.log(JSON.stringify({ learnable: arch.courses.length, unsolved: arch.unsolved.length, out }));
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('evolve_courses.mjs')) main();
