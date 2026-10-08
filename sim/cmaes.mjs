// Separable CMA-ES (Ros & Hansen 2008): an evolution strategy that adapts a step size and a per-dimension scale as it goes. For a few dozen parameters that need not
// be tuned one at a time: each generation tries `lambda` points, keeps the best half, and moves the mean, the scales and the step size toward what worked. Searches
// the unit cube (core/tunables.js toUnit/fromUnit); points outside it are put back on the edge. Pure and seeded (unit-tested on a sphere and a stretched ellipsoid).
import { makeRng } from '../behavior_pack/scripts/core/mathutil.js';

export class SepCMA {
  constructor(x0, sigma0 = 0.25, { lambda, seed = 1 } = {}) {
    const n = this.n = x0.length;
    this.rng = makeRng(seed);
    this.lambda = lambda ?? 4 + Math.floor(3 * Math.log(n));
    const mu = this.mu = Math.floor(this.lambda / 2);
    const w = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1));
    const sw = w.reduce((a, b) => a + b, 0);
    this.w = w.map((x) => x / sw);
    this.mueff = 1 / this.w.reduce((a, b) => a + b * b, 0);
    const { mueff } = this;
    this.cc = (4 + mueff / n) / (n + 4 + 2 * mueff / n);
    this.cs = (mueff + 2) / (n + mueff + 5);
    const sepScale = (n + 2) / 3;
    this.c1 = Math.min(1, (2 / ((n + 1.3) ** 2 + mueff)) * sepScale);
    this.cmu = Math.min(1 - this.c1, (2 * (mueff - 2 + 1 / mueff) / ((n + 2) ** 2 + mueff)) * sepScale);
    this.damps = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + this.cs;
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    this.m = x0.slice(); this.sigma = sigma0;
    this.C = new Array(n).fill(1); this.pc = new Array(n).fill(0); this.ps = new Array(n).fill(0);
    this.gen = 0;
  }
  gauss() { let u = 0, v = 0; while (u === 0) u = this.rng(); v = this.rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  /** lambda points in the unit cube. */
  ask() {
    const pts = [];
    for (let k = 0; k < this.lambda; k++) pts.push(this.m.map((mi, i) => Math.min(1, Math.max(0, mi + this.sigma * Math.sqrt(this.C[i]) * this.gauss()))));
    return pts;
  }
  /** costs[k] belongs to the point ask() returned at k (lower is better). */
  tell(pts, costs) {
    const n = this.n, idx = costs.map((c, i) => i).sort((a, b) => costs[a] - costs[b]);
    const y = idx.slice(0, this.mu).map((k) => pts[k].map((x, i) => (x - this.m[i]) / this.sigma));
    const ym = new Array(n).fill(0);
    y.forEach((yk, j) => yk.forEach((v, i) => { ym[i] += this.w[j] * v; }));
    const oldM = this.m;
    this.m = oldM.map((mi, i) => Math.min(1, Math.max(0, mi + this.sigma * ym[i])));
    const { cs, cc, c1, cmu, mueff } = this;
    this.ps = this.ps.map((p, i) => (1 - cs) * p + Math.sqrt(cs * (2 - cs) * mueff) * ym[i] / Math.sqrt(this.C[i]));
    const psn = Math.sqrt(this.ps.reduce((a, b) => a + b * b, 0));
    this.gen++;
    const hsig = psn / Math.sqrt(1 - (1 - cs) ** (2 * this.gen)) / this.chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    this.pc = this.pc.map((p, i) => (1 - cc) * p + hsig * Math.sqrt(cc * (2 - cc) * mueff) * ym[i]);
    this.C = this.C.map((c, i) => {
      let rank = 0; y.forEach((yk, j) => { rank += this.w[j] * yk[i] * yk[i]; });
      return Math.max(1e-6, (1 - c1 - cmu) * c + c1 * (this.pc[i] ** 2 + (1 - hsig) * cc * (2 - cc) * c) + cmu * rank);
    });
    this.sigma = Math.min(0.6, Math.max(1e-3, this.sigma * Math.exp((cs / this.damps) * (psn / this.chiN - 1))));
    return idx[0];
  }
}
