// What a policy is worth in the simulators: one cost per job (lower is better), plus the names of any scenario it lost. Two groups: 'tow' (the tow simulator,
// sim/pool.mjs) and 'combat' (tools/sim_combat.mjs, the fight-or-run logic against zombies, creepers and a fixed suite of nasty terrain). 'cave' has no simulator
// (it has no mobs): those constants are scored only by the real game (brain/trainer.py).
import { spawn } from 'node:child_process';
import { runJobs } from './pool.mjs';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const FIXED = ['leadledge', 'leadstep', 'leadstair', 'leadturn', 'leadgate'];

/** The job lists. Train is what the search sees; held is never searched on (other seeds, other courses). */
export function jobSets(group) {
  if (group === 'tow') return {
    train: [...FIXED.map((name) => ({ kind: 'fixed', name })), ...range(2001, 2012).map((seed) => ({ kind: 'rand', seed, level: 1 })), ...range(2001, 2010).map((seed) => ({ kind: 'rand', seed, level: 2 }))],
    held: [...FIXED.map((name) => ({ kind: 'fixed', name })), ...range(1000, 1011).map((seed) => ({ kind: 'rand', seed, level: 1 })), ...range(1000, 1009).map((seed) => ({ kind: 'rand', seed, level: 2 }))],
  };
  if (group === 'combat') return {
    train: [{ kind: 'base' }, ...range(1, 3).map((s) => ({ kind: 'zombies', seed: s, n: 40 })), ...range(1, 2).map((s) => ({ kind: 'creepers', seed: s, n: 40 }))],
    held: [{ kind: 'base' }, ...range(11, 13).map((s) => ({ kind: 'zombies', seed: s, n: 40 })), ...range(11, 12).map((s) => ({ kind: 'creepers', seed: s, n: 40 }))],
  };
  return { train: [], held: [] };
}

function runNode(args, env, timeoutMs = 240000) {
  return new Promise((resolve) => {
    const p = spawn('node', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; const t = setTimeout(() => { try { p.kill(); } catch { /* */ } }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => { clearTimeout(t); resolve(out); });
  });
}
const COMBAT = new URL('../tools/sim_combat.mjs', import.meta.url).pathname;

/** Parse sim_combat's output for a job into { cost, lost }. Exported for the tests. */
export function parseCombat(job, out) {
  if (job.kind === 'base') {
    let cost = 0; const lost = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^(ok|FAIL)\s+(.*)$/);
      if (!m) continue;
      const cut = Math.max(m[2].lastIndexOf(': lived ('), m[2].lastIndexOf(': DIED'));
      const name = cut > 0 ? m[2].slice(0, cut) : m[2], tail = cut > 0 ? m[2].slice(cut) : '';
      if (m[1] === 'FAIL') { cost += 3; lost.push(name); }
      if (/^: DIED/.test(tail)) cost += 4;
      cost += 0.15 * Number(tail.match(/hits taken (\d+)/)?.[1] ?? 0);
    }
    return { cost, lost };
  }
  if (job.kind === 'zombies') {
    const m = out.match(/([\d.]+) hits taken a fight.*?killed (\d+)\/(\d+), ([\d.]+) s a fight, died (\d+)/);
    if (!m) return { cost: 99, lost: ['unparsed'] };
    return { cost: Number(m[1]) * 6 + Number(m[5]) * 10 + (1 - Number(m[2]) / Math.max(1, Number(m[3]))) * 3 + Number(m[4]) / 40, lost: [] };
  }
  if (job.kind === 'creepers') {
    const m = out.match(/(\d+)\/(\d+) without an explosion.*?(\d+) died/);
    if (!m) return { cost: 99, lost: ['unparsed'] };
    return { cost: (1 - Number(m[1]) / Math.max(1, Number(m[2]))) * 10 + Number(m[3]) * 5, lost: [] };
  }
  return { cost: 99, lost: ['unknown job'] };
}

/** Score one policy on a job list. Returns { costs: number[], lost: string[] } (lost: scenarios failed). */
export async function scorePolicy(group, policy, jobs) {
  if (group === 'tow') {
    const r = await runJobs(jobs.map((j) => ({ ...j, tune: policy })));
    return { costs: r.map((x) => (x?.pass ? x.secs : 120)), lost: jobs.map((j, i) => (r[i]?.pass ? null : (j.name ?? `L${j.level}:${j.seed}`))).filter(Boolean) };
  }
  if (group === 'combat') {
    const rs = await Promise.all(jobs.map(async (j) => {
      const args = j.kind === 'base' ? [COMBAT] : [COMBAT, `--${j.kind}`, String(j.n)];
      return parseCombat(j, await runNode(args, { POLICY: JSON.stringify(policy), SEED: String(j.seed ?? 0) }));
    }));
    return { costs: rs.map((r) => r.cost), lost: rs.flatMap((r) => r.lost) };
  }
  throw new Error(`no simulator for group ${group}`);
}
