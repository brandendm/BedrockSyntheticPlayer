// The pathfinding log: every search (who asked, from where to where, how many nodes, how many ticks, whether it
// found the way or only part of it) and every walk (how long the route was, whether it arrived or got stuck, how
// long it took for how far). Batched to the brain (brain/logs/paths.jsonl, the dashboard's Pathfinding panel and
// Copy path log), so a slow or wasteful route can be found by number rather than by feel.
import { system } from '@minecraft/server';
import { sendEvent } from './bridge.js';

const r1 = (v) => Math.round(v * 10) / 10;
const cell = (p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10];

/** Who asked: the first frames of the stack that aren't this file or the agent's plan wrapper ("Skills.goNear < Skills.mine"). */
export function callerOf(stack) {
  const out = [];
  for (const l of String(stack ?? '').split('\n').slice(1)) {
    const m = /at (?:async )?([\w$.<>]+)/.exec(l);
    const name = m?.[1] ?? '';
    if (!name || /^(Agent\.plan|plan|new|Promise|PathLog\.)/.test(name) || /pathlog/.test(l)) continue;
    out.push(name.replace(/^Skills\./, 'S.').replace(/^Homestead\./, 'H.').replace(/^Agent\./, 'A.'));
    if (out.length >= 2) break;
  }
  return out.join(' < ') || '?';
}

export class PathLog {
  constructor() {
    this.rows = [];
    this.n = { plans: 0, nodes: 0, ticks: 0, partial: 0, slow: 0, walks: 0, stuck: 0, blocks: 0, walkTicks: 0 };
    this.lastFlush = 0;
  }

  push(r) {
    this.rows.push(r);
    if (this.rows.length > 3000) this.rows.splice(0, this.rows.length - 3000);
    this.pending = (this.pending ?? []);
    this.pending.push(r);
  }

  /** A search finished. */
  plan({ from, to, tolerance, maxNodes, goalTest, actions, r, ticks, stack }) {
    const n = this.n;
    n.plans++; n.nodes += r.expanded ?? 0; n.ticks += ticks;
    if (!r.complete) n.partial++;
    if (ticks > 40) n.slow++;
    this.push({
      k: 'plan', t: system.currentTick, who: callerOf(stack), from: cell(from), to: to ? cell(to) : null,
      d: to ? r1(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)) : null, tol: tolerance, cap: maxNodes,
      nodes: r.expanded ?? 0, ticks, ok: !!r.complete, len: r.path?.length ?? 0, search: !!goalTest, actions: !!actions,
    });
  }

  /** A walk finished (the motor's promise settled). */
  walk({ wps, result, ticks, from, end }) {
    const n = this.n;
    let len = 0, leaps = 0;
    for (let i = 1; i < wps.length; i++) { len += Math.hypot(wps[i].x - wps[i - 1].x, wps[i].y - wps[i - 1].y, wps[i].z - wps[i - 1].z); if (wps[i].leap) leaps++; }
    n.walks++; n.blocks += len; n.walkTicks += ticks;
    if (result?.status === 'stuck') n.stuck++;
    this.push({
      k: 'walk', t: system.currentTick, from: cell(from), to: wps.length ? cell(wps[wps.length - 1]) : null, end: cell(end), wps: wps.length,
      len: r1(len), leaps, status: result?.status ?? '?', ticks, bps: ticks ? r1((len / ticks) * 20) : null,
      short: wps.length ? r1(Math.hypot(wps[wps.length - 1].x - end.x, wps[wps.length - 1].z - end.z)) : null, // how far from the last waypoint it ended
    });
  }

  /** Send what's new (every ~5 s from the agent's tick). */
  flush(t) {
    if (!this.pending?.length || t - this.lastFlush < 100) return;
    this.lastFlush = t;
    const rows = this.pending.splice(0, this.pending.length);
    sendEvent({ type: 'paths', rows }).catch(() => {});
  }

  /** For the diagnostics: the totals. */
  summary() {
    const n = this.n;
    return {
      plans: n.plans, avgNodes: n.plans ? Math.round(n.nodes / n.plans) : 0, avgTicks: n.plans ? r1(n.ticks / n.plans) : 0,
      partialPct: n.plans ? Math.round((100 * n.partial) / n.plans) : 0, slow: n.slow,
      walks: n.walks, stuckPct: n.walks ? Math.round((100 * n.stuck) / n.walks) : 0, blocksWalked: Math.round(n.blocks),
      avgBlocksPerSec: n.walkTicks ? r1((n.blocks / n.walkTicks) * 20) : 0,
    };
  }
}
