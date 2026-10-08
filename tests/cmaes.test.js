import test from 'node:test';
import assert from 'node:assert/strict';
import { SepCMA } from '../sim/cmaes.mjs';

function run(f, n, gens, seed, x0) {
  const es = new SepCMA(x0 ?? new Array(n).fill(0.8), 0.3, { seed });
  let best = Infinity;
  for (let g = 0; g < gens; g++) { const pts = es.ask(), costs = pts.map(f); best = Math.min(best, ...costs); es.tell(pts, costs); }
  return { best, mean: es.m };
}
test('finds the minimum of a sphere in the unit cube', () => {
  const f = (x) => x.reduce((a, v) => a + (v - 0.3) ** 2, 0);
  const r = run(f, 8, 150, 3);
  assert.ok(r.best < 1e-3, `best ${r.best}`);
  assert.ok(r.mean.every((v) => Math.abs(v - 0.3) < 0.08));
});
test('copes with a stretched ellipsoid (dimensions that matter very unequally)', () => {
  const f = (x) => x.reduce((a, v, i) => a + 10 ** (3 * i / (x.length - 1)) * (v - 0.6) ** 2, 0);
  const r = run(f, 6, 250, 5);
  assert.ok(r.best < 0.01, `best ${r.best}`);
});
test('stays inside the cube and is repeatable for a seed', () => {
  const es = new SepCMA([0.5, 0.5, 0.5], 0.6, { seed: 9 });
  for (const p of es.ask()) assert.ok(p.every((v) => v >= 0 && v <= 1));
  const a = new SepCMA([0.5, 0.5], 0.3, { seed: 4 }).ask(), b = new SepCMA([0.5, 0.5], 0.3, { seed: 4 }).ask();
  assert.deepEqual(a, b);
});
test('a flat cost does not blow up', () => {
  const r = run(() => 1, 4, 30, 2);
  assert.equal(r.best, 1);
  assert.ok(r.mean.every((v) => v >= 0 && v <= 1));
});
