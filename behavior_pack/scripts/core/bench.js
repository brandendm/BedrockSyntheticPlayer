// The progression benchmark (u296): how far does the bot get in a real world, left alone? Milestones from a fresh start (wood, a table, tools, iron, diamond), the time each was
// reached, stalls (no progress for a minute) and deaths, with what the bot was doing. Pure and unit-tested; game/bench.js runs the bots, brain/bench.py keeps the results.
const count = (inv, re) => Object.entries(inv).filter(([id]) => re.test(id)).reduce((a, [, n]) => a + n, 0);

/** In order of the usual game; weight = how much it counts in the score. `test(inv)` is on the inventory counts (ever seen: a milestone is never un-reached). */
export const MILESTONES = [
  { id: 'log', w: 1, test: (i) => count(i, /_log$|_stem$/) > 0 },
  { id: 'planks', w: 1, test: (i) => count(i, /_planks$/) > 0 || (i.crafting_table ?? 0) > 0 || (i.stick ?? 0) > 0 },
  { id: 'table', w: 1, test: (i) => (i.crafting_table ?? 0) > 0 || (i.__placed_table ?? 0) > 0 },
  { id: 'wood_pickaxe', w: 2, test: (i) => (i.wooden_pickaxe ?? 0) > 0 },
  { id: 'cobblestone', w: 1, test: (i) => (i.cobblestone ?? 0) >= 3 },
  { id: 'stone_pickaxe', w: 2, test: (i) => (i.stone_pickaxe ?? 0) > 0 },
  { id: 'furnace', w: 2, test: (i) => (i.furnace ?? 0) > 0 || (i.__placed_furnace ?? 0) > 0 },
  { id: 'iron_ore', w: 3, test: (i) => (i.raw_iron ?? 0) + (i.iron_ingot ?? 0) > 0 },
  { id: 'iron_ingot', w: 3, test: (i) => (i.iron_ingot ?? 0) > 0 },
  { id: 'iron_pickaxe', w: 4, test: (i) => (i.iron_pickaxe ?? 0) > 0 },
  { id: 'diamond', w: 6, test: (i) => (i.diamond ?? 0) > 0 || (i.diamond_pickaxe ?? 0) > 0 },
];

export class Tracker {
  /** @param {{stallSecs?: number, moveRadius?: number, maxStalls?: number}} o */
  constructor(o = {}) {
    this.stallSecs = o.stallSecs ?? 60; this.moveRadius = o.moveRadius ?? 6; this.maxStalls = o.maxStalls ?? 30;
    this.achieved = {}; this.stalls = []; this.deaths = [];
    this.lastProgress = 0; this.anchor = null; this.sig = '';
  }

  /** Call every few seconds. t in seconds since the start; inv: counts by id (without 'minecraft:'); pos {x,y,z}; ctx {step, mode, task} for the record. Returns the new events. */
  update(t, inv, pos, ctx = {}) {
    const ev = [];
    for (const m of MILESTONES) if (this.achieved[m.id] === undefined && m.test(inv)) { this.achieved[m.id] = Math.round(t); ev.push({ type: 'milestone', id: m.id, t: Math.round(t) }); this.lastProgress = t; }
    const sig = Object.entries(inv).filter(([k]) => !k.startsWith('__')).sort().map(([k, n]) => `${k}:${n}`).join(',');
    if (sig !== this.sig) { this.sig = sig; this.lastProgress = Math.max(this.lastProgress, t - this.stallSecs * 0.5); }   // (carrying something new is half a minute of life)
    if (pos) {
      if (!this.anchor || Math.hypot(pos.x - this.anchor.x, pos.z - this.anchor.z) + Math.abs(pos.y - this.anchor.y) * 0.5 >= this.moveRadius) { this.anchor = { x: pos.x, y: pos.y, z: pos.z }; this.lastProgress = Math.max(this.lastProgress, t - this.stallSecs * 0.25); }
    }
    if (t - this.lastProgress >= this.stallSecs && this.stalls.length < this.maxStalls) {
      const s = { t: Math.round(t), step: ctx.step ?? null, mode: ctx.mode ?? null, task: ctx.task ?? null, last: lastMilestone(this.achieved) };
      this.stalls.push(s); ev.push({ type: 'stall', ...s }); this.lastProgress = t;
    }
    return ev;
  }

  death(t, cause = null, ctx = {}) { const d = { t: Math.round(t), cause, step: ctx.step ?? null, mode: ctx.mode ?? null, last: lastMilestone(this.achieved) }; this.deaths.push(d); return d; }

  result(budgetS) { return { achieved: { ...this.achieved }, stalls: this.stalls.slice(), deaths: this.deaths.slice(), score: score(this.achieved, this.deaths.length, budgetS) }; }
}

function lastMilestone(achieved) { let best = null; for (const m of MILESTONES) if (achieved[m.id] !== undefined) best = m.id; return best; }

/** Weighted milestones, earlier is worth more (down to half at the end of the budget), minus 0.5 a death. Max is about 27. */
export function score(achieved, deaths, budgetS) {
  let s = 0;
  for (const m of MILESTONES) if (achieved[m.id] !== undefined) s += m.w * (1 - 0.5 * Math.min(1, achieved[m.id] / Math.max(1, budgetS)));
  return Math.round((s - 0.5 * deaths) * 100) / 100;
}

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : Math.round((s[h - 1] + s[h]) / 2); };

/** Many runs (the results of Tracker.result) -> the table the digest shows. */
export function summarize(runs, budgetS) {
  const n = runs.length;
  const milestones = MILESTONES.map((m) => {
    const ts = runs.map((r) => r.achieved?.[m.id]).filter((x) => x !== undefined);
    return { id: m.id, reached: ts.length, of: n, median_s: median(ts) };
  });
  const groups = {};
  for (const r of runs) for (const s of r.stalls ?? []) { const k = `${s.step ?? '-'} / ${s.mode ?? '-'}`; groups[k] = (groups[k] ?? 0) + 1; }
  const deaths = {};
  for (const r of runs) for (const d of r.deaths ?? []) { const k = `${d.cause ?? '?'} (after ${d.last ?? 'nothing'})`; deaths[k] = (deaths[k] ?? 0) + 1; }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => ({ what: k, count: c }));
  return { runs: n, budget_s: budgetS, score_median: median(runs.map((r) => r.score)), score_mean: n ? Math.round(runs.reduce((a, r) => a + r.score, 0) / n * 100) / 100 : null, milestones, top_stalls: top(groups), top_deaths: top(deaths), deaths: runs.reduce((a, r) => a + (r.deaths?.length ?? 0), 0) };
}

/** The milestone the runs most often stop before: the next thing to work on. */
export function weakestLink(summary) {
  const rows = summary.milestones;
  for (let i = 0; i < rows.length; i++) if (rows[i].reached < rows[i].of) return rows[i].id;
  return null;
}
