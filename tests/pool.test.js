import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJobs } from '../sim/pool.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
const write = (n, src) => { const f = path.join(dir, n); fs.writeFileSync(f, src); return f; };
const echo = write('echo.mjs', "import rl from 'node:readline'; for await (const l of rl.createInterface({ input: process.stdin })) { const j = JSON.parse(l); console.log(JSON.stringify({ id: j.id, pass: true, secs: j.n })); }");
const crash = write('crash.mjs', "process.stderr.write('boom\\n'); process.exit(3);");
const crashOnce = write('once.mjs', "import rl from 'node:readline'; for await (const l of rl.createInterface({ input: process.stdin })) { const j = JSON.parse(l); if (j.die) process.exit(1); console.log(JSON.stringify({ id: j.id, pass: true, secs: j.n })); }");

test('results come back in job order', async () => {
  const r = await runJobs([{ n: 1 }, { n: 2 }, { n: 3 }], 2, echo);
  assert.deepEqual(r.map((x) => x.secs), [1, 2, 3]);
});
test('workers that always die reject instead of hanging (the exit-13 bug)', async () => {
  await assert.rejects(runJobs([{ n: 1 }, { n: 2 }], 2, crash), /keep dying.*boom/s);
});
test('a worker dying on one job loses only that job', async () => {
  const r = await runJobs([{ n: 1 }, { n: 2, die: true }, { n: 3 }, { n: 4 }], 1, crashOnce);
  assert.equal(r[1], null);
  assert.deepEqual([r[0], r[2], r[3]].map((x) => x.secs), [1, 3, 4]);
});
