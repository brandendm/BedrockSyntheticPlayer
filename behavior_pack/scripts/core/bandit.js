// A tactic bandit (u301): where the bot has two or more ways to do a thing and the cost model only guesses which is better (stairs or a pillar on the way up),
// it keeps score of how each really went, per situation, and drifts to what works. Thompson sampling on Beta(win+1, loss+1) with the model's choice given a head
// start of a few pseudo-wins, so with no evidence it does what the model says, and with evidence the record wins. The scores are saved with the world memory.
// Pure; the store is a plain object ({ctx: {arm: {w, n}}}).
const PRIOR_WINS = 3;

function gamma(shape, rng) { // Marsaglia-Tsang (shape >= 1 here: win+1 and loss+1 are at least 1)
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = Math.max(rng(), 1e-12), u2 = rng(); x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
export function betaSample(a, b, rng = Math.random) { const x = gamma(a, rng), y = gamma(b, rng); return x / (x + y); }

export class Bandit {
  /** @param {Record<string, Record<string, {w: number, n: number}>>} store  @param {() => number} rng */
  constructor(store = {}, rng = Math.random) { this.store = store; this.rng = rng; }
  stat(ctx, arm) { return ((this.store[ctx] ??= {})[arm] ??= { w: 0, n: 0 }); }
  /** The arm to try among `arms` (the ones that can be used at all); `prior` is the model's choice. */
  pick(ctx, arms, prior = arms[0]) {
    if (arms.length <= 1) return arms[0];
    let best = arms[0], bv = -1;
    for (const a of arms) {
      const s = this.stat(ctx, a), w = s.w + (a === prior ? PRIOR_WINS : 0), l = s.n - s.w;
      const v = betaSample(1 + w, 1 + l, this.rng);
      if (v > bv) { bv = v; best = a; }
    }
    return best;
  }
  report(ctx, arm, success) { const s = this.stat(ctx, arm); s.n++; if (success) s.w++; if (s.n > 400) { s.n = Math.round(s.n / 2); s.w = Math.round(s.w / 2); } }
  summary() { return Object.entries(this.store).map(([c, arms]) => `${c}: ${Object.entries(arms).map(([a, s]) => `${a} ${s.w}/${s.n}`).join(', ')}`).join('; '); }
}
