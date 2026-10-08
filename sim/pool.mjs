// Runs many tow jobs over a few worker processes. jobs: [{kind:'fixed',name,tune}|{kind:'rand',seed,level,tune}] -> results in the same order.
import { spawn } from 'node:child_process';
import os from 'node:os';
export async function runJobs(jobs, workers = Math.max(1, Math.min(os.cpus().length, 8))) {
  const out = new Array(jobs.length); let next = 0, done = 0; const procs = [];
  const file = new URL('./eval_worker.mjs', import.meta.url).pathname;
  await new Promise((resolve) => {
    if (!jobs.length) return resolve();
    for (let w = 0; w < Math.min(workers, jobs.length); w++) {
      const p = spawn('node', [file], { stdio: ['pipe', 'pipe', 'ignore'] }); procs.push(p);
      let buf = '';
      const feed = () => { if (next < jobs.length) { const id = next++; p.stdin.write(JSON.stringify({ ...jobs[id], id }) + '\n'); } else p.stdin.end(); };
      p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.startsWith('{')) continue; const r = JSON.parse(line); out[r.id] = r; if (++done === jobs.length) resolve(); else feed(); } });
      p.on('close', () => { if (done < jobs.length) { /* a crashed worker: its job is lost */ } });
      feed();
    }
  });
  for (const p of procs) try { p.kill(); } catch { /* */ }
  return out;
}
