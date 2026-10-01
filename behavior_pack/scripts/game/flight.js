// The flight recorder. A sample of the bot's state every second (6 minutes kept), every decision
// note (core trace) and chat line it said (8 minutes), and the last damage it took. Nothing is
// printed until something goes wrong; then `dump(reason)` prints one report to the server console
// (the `[flight]` lines of the log you paste) and sends it to the brain (brain/logs/flight.jsonl):
//
//   a watchdog (core/flight.js diagnose): frozen, pacing, spinning, starving
//   dying, the loop-breaker firing, a test failing, `!bot dump [why]` typed by hand
//
// so a stuck run is one paste with the evidence in it, not a guess from the chat lines.
import { system, world } from '@minecraft/server';
import { CONFIG } from '../config.js';
import { diagnose, stepLine, invDiff, pathAndNet } from '../core/flight.js';
import { invCounts } from './inventory.js';
import { onTrace, sendEvent } from './bridge.js';

const SAMPLE_EVERY = 20;       // ticks
const KEEP_SAMPLES = 360;      // 6 minutes
const KEEP_NOTES = 400;
const WATCH_EVERY = 200;       // ticks between watchdog looks
const QUIET_AFTER_DUMP = 6000; // ticks before the watchdog dumps again (5 minutes)

export class Flight {
  constructor(agent) {
    this.a = agent;
    this.samples = [];
    this.notes = [];       // { t, k: 'trace'|'say'|'hurt'|'event', msg }
    this.lastDump = -1e9;
    this.dumps = 0;
    this.invAt = new Map(); // tick -> pack (for "what changed since")
    onTrace((tick, msg) => this.note('trace', msg, tick));
  }

  note(k, msg, tick = system.currentTick) {
    this.notes.push({ t: tick, k, msg: String(msg).slice(0, 220) });
    if (this.notes.length > KEEP_NOTES) this.notes.splice(0, this.notes.length - KEEP_NOTES);
  }

  /** Every SAMPLE_EVERY ticks (from agent.tick). */
  tick(t) {
    if (t % SAMPLE_EVERY !== 0) return;
    const a = this.a;
    try {
      const p = a.body.getPos();
      const inv = invCounts(a.sim);
      const sig = Object.keys(inv).sort().map((k) => `${k}:${inv[k]}`).join(',');
      this.samples.push({
        t, x: p.x, y: p.y, z: p.z, hp: a.health(), food: this.food(), step: a.autoStep ?? null, mode: a.mode, task: a.task?.kind ?? 'idle',
        busy: !!a.motor.busy, path: a.motor.intent?.kind === 'path', inv: sig, sleeping: !!a.sim.isSleeping,
        under: this.under(), night: this.night(),
      });
      if (this.samples.length > KEEP_SAMPLES) this.samples.splice(0, this.samples.length - KEEP_SAMPLES);
      if (t % (SAMPLE_EVERY * 30) === 0) this.invAt.set(t, inv);
      for (const k of this.invAt.keys()) if (t - k > 8000) this.invAt.delete(k);
    } catch { /* between a death and the respawn */ }
    if (t % WATCH_EVERY === 0 && t - this.lastDump > QUIET_AFTER_DUMP && a.autoEnabled !== false && !a.testHold) {
      const d = diagnose(this.samples);
      if (d) this.dump(`${d.kind}: ${d.why}`);
    }
  }

  food() { try { return this.a.sim.getComponent('minecraft:player.hunger')?.currentValue ?? null; } catch { return null; } }
  under() { try { return this.a.skills.isUnderground(); } catch { return null; } }
  night() { try { const t = world.getTimeOfDay(); return t >= 12542 && t <= 23460; } catch { return null; } }

  /**
   * The report. Printed as `[flight]` lines (the server console) and sent to the brain.
   * `why` is the first line; the rest is what was going on: the plan's steps, the last notes, the
   * pack and what changed in it, where it went, the state of the quarry, the house, the memory.
   */
  dump(why, { quiet = false } = {}) {
    const a = this.a;
    const t = system.currentTick;
    this.lastDump = t;
    this.dumps++;
    const lines = [];
    const S = this.samples;
    const last = S[S.length - 1];
    const p = a.body.getPos();
    lines.push(`=== FLIGHT REPORT #${this.dumps} build ${CONFIG.build}: ${why}`);
    lines.push(`at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)} tick ${t} time ${this.timeOfDay()} hp ${a.health()} food ${this.food()} mode ${a.mode} task ${a.task?.kind ?? 'idle'} step ${a.autoStep ?? '-'} (${a.autoLabel ?? ''})`);
    if (S.length) {
      const { path, net } = pathAndNet(S.slice(-60));
      lines.push(`last 60 s: walked ${Math.round(path)} blocks, ${net.toFixed(1)} from where it was; steps: ${stepLine(S.slice(-240), 1, 12)}`);
    }
    // The pack now, and what changed over the last few minutes.
    const inv = invCounts(a.sim);
    lines.push(`pack: ${Object.entries(inv).sort((x, y) => y[1] - x[1]).slice(0, 18).map(([k, n]) => `${k} ${n}`).join(', ') || 'empty'}`);
    const oldest = [...this.invAt.entries()].sort((x, y) => x[0] - y[0])[0];
    if (oldest) lines.push(`pack since ${Math.round((t - oldest[0]) / 20)} s ago: ${invDiff(oldest[1], inv)}`);
    // Where it was every 30 s.
    const route = [];
    for (let i = Math.max(0, S.length - 180); i < S.length; i += 30) route.push(`${Math.floor(S[i].x)},${Math.floor(S[i].y)},${Math.floor(S[i].z)}`);
    if (route.length) lines.push(`route (30 s apart): ${route.join(' > ')}`);
    // The state of the things it depends on.
    try {
      const q = a.memory.data.quarry;
      if (q) lines.push(`quarry: ${q.steps.length} steps from ${q.steps[0]} down to ${q.steps[q.steps.length - 1]}, fails ${q.fails ?? 0}`);
      const h = a.homestead.house;
      lines.push(h ? `house: at ${h.x} ${h.y} ${h.z} ${h.dir} bed ${!!h.bed} table ${!!h.table} furnace ${!!h.furnace} chest ${!!h.chest}` : `house: ${a.homestead.project ? 'being built' : 'none'}`);
      const def = [...a.deferred.values()].filter((d) => d.until > Date.now()).map((d) => d.step);
      if (def.length) lines.push(`set aside: ${def.join(', ')}`);
      lines.push(`toggles: ${JSON.stringify(a.toggles())}`);
    } catch { /* partial is fine */ }
    // The decisions and the chat, newest 30, oldest first.
    for (const n of this.notes.slice(-30)) lines.push(`${String(Math.round((t - n.t) / 20)).padStart(4)}s ago ${n.k === 'trace' ? '' : `[${n.k}] `}${n.msg}`);
    lines.push('=== END FLIGHT REPORT');
    if (!quiet) for (const l of lines) console.warn(`[flight] ${l}`);
    sendEvent({ type: 'flight', build: CONFIG.build, why, report: lines, state: a.snapshot() }).catch(() => {});
    return lines;
  }

  timeOfDay() { try { return world.getTimeOfDay(); } catch { return -1; } }
}
