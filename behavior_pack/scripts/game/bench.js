// The progression benchmark (u296): `!bot test bench [minutes]`. N bots (hired, each with its own notes) are dropped on dry land far apart in the real world, with nothing,
// and left alone to play for the time. Every few seconds each one's inventory is read (core/bench.js Tracker): milestones with their times, stalls, deaths with causes.
// The result goes to the brain as a `bench_result` event (brain/bench.py keeps the leaderboard and the failure list) and back to the test as pass/fail + detail.
import { system, world } from '@minecraft/server';
import { CONFIG } from '../config.js';
import { crew, dismissAll } from './crew.js';
import { WorldMemory } from './memory.js';
import { invCounts } from './inventory.js';
import { sendEvent } from './bridge.js';
import { spreadLand } from './landfinder.js';
import { Tracker, MILESTONES, summarize, weakestLink } from '../core/bench.js';

export const BENCH_BOTS = 3;
export const BENCH_MAX_MIN = 30;

/** @param {import('./agent.js').Agent} primary  @param {{minutes?: number, bots?: number, aborted?: () => boolean}} o */
export async function runBench(primary, o = {}) {
  const minutes = Math.max(2, Math.min(BENCH_MAX_MIN, Math.floor(o.minutes ?? 12)));
  const want = Math.max(1, Math.min(6, Math.floor(o.bots ?? BENCH_BOTS)));
  const dim = primary.dim, aborted = o.aborted ?? (() => false);
  const budgetS = minutes * 60;
  const wasAuto = primary.autoEnabled;
  primary.autoEnabled = false; primary.newTask(null);
  const notes = [];
  const spots = await spreadLand(dim, world.getDefaultSpawnLocation(), want);
  if (spots.length < want) notes.push(`only ${spots.length} of ${want} land spots found`);
  if (!spots.length) { primary.autoEnabled = wasAuto; return { pass: false, detail: 'no dry land found to start from', result: null }; }

  /** @type {Array<{name: string, w: any, tr: Tracker, spot: any, deadSeen: boolean, lastHurt: string|null}>} */
  const bots = [];
  const base = `${CONFIG.botName}B`;
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i], name = `${base}${i + 1}`;
    try {
      const w = crew.factory(name, { dimension: dim, x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 }, primary, { memory: new WorldMemory(null) });
      crew.members.push(w);
      const b = { name, w, tr: new Tracker(), spot, deadSeen: false, lastHurt: null };
      const oh = w.onHurt.bind(w);
      w.onHurt = (e, cause, amount) => { try { b.lastHurt = `${cause}${e ? ` by ${String(e.typeId).replace('minecraft:', '')}` : ''}`; } catch { /* */ } return oh(e, cause, amount); };
      bots.push(b);
    } catch (e) { notes.push(`could not make ${name}: ${e}`); }
    await system.waitTicks(5);
  }
  await system.waitTicks(30);
  for (const b of bots) {
    try { b.w.sim.runCommand('clear @s'); } catch { /* */ }
    try { b.w.sim.runCommand('gamemode survival @s'); } catch { /* */ }
    b.w.autoEnabled = true; b.w.autoDone = false; b.w.nextAutoTry = 0;
    b.w.newTask({ kind: 'auto' });
  }
  const t0 = system.currentTick;
  const sinceS = () => (system.currentTick - t0) / 20;
  const events = [];
  let allDiamond = false;
  while (sinceS() < budgetS && !aborted() && !allDiamond && !primary.testAbort) {
    await system.waitTicks(100);
    allDiamond = bots.length > 0;
    for (const b of bots) {
      const w = b.w;
      if (!w.sim?.isValid) { allDiamond = false; continue; }
      const t = sinceS();
      const dead = w.health() <= 0;
      if (dead && !b.deadSeen) { b.deadSeen = true; events.push({ bot: b.name, ...b.tr.death(t, b.lastHurt, { step: w.autoStep, mode: w.mode }) }); }
      if (!dead) b.deadSeen = false;
      let inv = {};
      try { inv = invCounts(w.sim); } catch { /* between a death and the respawn */ }
      try { const res = w.memory.data.res ?? []; if (res.some((r) => r.c === 'crafting_table')) inv.__placed_table = 1; if (res.some((r) => r.c === 'furnace')) inv.__placed_furnace = 1; } catch { /* */ }
      if (!dead) for (const e of b.tr.update(t, inv, w.sim.location, { step: w.autoStep, mode: w.mode, task: w.task?.kind, where: w.autoWhere })) events.push({ bot: b.name, ...e });
      if (b.tr.achieved.diamond === undefined) allDiamond = false;
    }
  }
  const finalS = sinceS();
  const runs = bots.map((b) => ({ name: b.name, spot: { x: b.spot.x, y: b.spot.y, z: b.spot.z }, ...b.tr.result(budgetS) }));
  const summary = summarize(runs, budgetS);
  dismissAll();
  primary.autoEnabled = wasAuto;
  const result = { build: CONFIG.build, minutes, ran_s: Math.round(finalS), bots: runs.length, runs, summary, events: events.slice(-60), notes };
  try { await sendEvent({ type: 'bench_result', ...result }); } catch { /* the brain may be down: the test detail still has it */ }
  const best = MILESTONES.filter((m) => summary.milestones.find((s) => s.id === m.id)?.reached > 0).pop()?.id ?? 'nothing';
  const weak = weakestLink(summary);
  const detail = `${runs.length} bots, ${Math.round(finalS / 60)} min; score median ${summary.score_median}, best milestone ${best}, next to fix ${weak}; deaths ${summary.deaths}; `
    + `${summary.milestones.filter((m) => m.reached).map((m) => `${m.id} ${m.reached}/${m.of}@${m.median_s}s`).join(', ') || 'no milestones'}; top stall: ${summary.top_stalls[0]?.what ?? 'none'}${notes.length ? `; ${notes.join('; ')}` : ''}`;
  return { pass: summary.milestones.find((m) => m.id === 'wood_pickaxe')?.reached >= Math.ceil(runs.length / 2), detail, result };
}
