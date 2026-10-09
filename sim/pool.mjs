// Runs many tow jobs over a few worker processes. jobs: [{kind:'fixed',name,tune}|{kind:'rand',seed,level,tune}] -> results in the same order.
// A worker that dies (crash, out of memory, node missing) loses only the job it held; the slot starts a new worker, and if workers keep dying with
// nothing done the pool rejects with the stderr tail. (Before u299 a dead worker left the promise pending for ever, and the trainer saw node exit 13
// "unsettled top-level await" with an empty log: the tow search never ran on the PC.)
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';
export async function runJobs(jobs, workers = Math.max(1, Math.min(os.cpus().length, 8)), workerFile = null) {
  const out = new Array(jobs.length).fill(null); let next = 0, settled = 0, deaths = 0; const procs = [];
  const file = workerFile ?? fileURLToPath(new URL('./eval_worker.mjs', import.meta.url));
  const maxDeaths = 4 + jobs.length;
  let errTail = '', errHead = '';
  const why = () => (errHead.length < 700 ? errHead : `${errHead.slice(0, 500)} ... ${errTail}`).trim().replace(/\s*\n\s*/g, ' | ');
  await new Promise((resolve, reject) => {
    if (!jobs.length) return resolve();
    const finish = () => { if (settled >= jobs.length) resolve(); };
    const launch = () => {
      let p;
      try { p = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return reject(new Error(`cannot start a worker: ${e}`)); }
      procs.push(p);
      let buf = '', inflight = null, dead = false;
      p.stderr.on('data', (d) => { if (errHead.length < 700) errHead += d; errTail = (errTail + d).slice(-600); });
      const feed = () => { if (next < jobs.length) { inflight = next++; try { p.stdin.write(JSON.stringify({ ...jobs[inflight], id: inflight }) + '\n'); } catch { /* the close handler deals with it */ } } else { inflight = null; try { p.stdin.end(); } catch { /* */ } } };
      p.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.startsWith('{')) continue;
          let r; try { r = JSON.parse(line); } catch { continue; }
          out[r.id] = r; inflight = null; settled++;
          if (settled >= jobs.length) return finish();
          feed();
        }
      });
      const gone = (why) => {
        if (dead) return; dead = true;
        if (inflight !== null) { out[inflight] = null; inflight = null; settled++; } // (its job is lost: scored as a failure)
        if (settled >= jobs.length) return finish();
        if (next >= jobs.length) return; // (nothing left for a new worker)
        if (++deaths > maxDeaths) return reject(new Error(`eval workers keep dying (${why}): ${why()}`));
        launch();
      };
      p.on('error', (e) => gone(String(e)));
      p.on('close', (code) => gone(`exit ${code}`));
      feed();
    };
    for (let w = 0; w < Math.min(workers, jobs.length); w++) launch();
  });
  for (const p of procs) try { p.kill(); } catch { /* */ }
  if (jobs.length && out.every((x) => x === null)) throw new Error(`eval workers keep dying (no job finished): ${why()}`);
  return out;
}
