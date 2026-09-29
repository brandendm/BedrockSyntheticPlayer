// Parkour: the real planner and motor on a body with Minecraft's movement physics (tests/helpers.js
// McBody: momentum, air drag, the sprint-jump boost), over jump courses.
//
//   --jumps   every single jump on its own: gap 1-4, landing 1 up to 3 down, from a run-up or from
//             standing on a 1x1 pillar; 40 tries each with the body turned a random way to start.
//             Shows which jumps are reliable (what the planner may use).
//   courses   (default) random courses of 12 jumps: platforms 1-3 long (1 = a pillar), turns on
//             them, gaps and heights mixed. SAFE=1: a floor 4 below (a miss costs the course, not a
//             life; the planner will only jump survivable gaps then). Otherwise void under the lot.
//             HARD=1: 20 jumps, mostly 1x1 pillars, turning on most of them.
//
//   node tools/sim_parkour.mjs [--jumps] [N] [-v]
import { MotorController } from '../behavior_pack/scripts/core/motor.js';
import { findPath, smoothPath, Cell, DEFAULT_COSTS } from '../behavior_pack/scripts/core/pathfinder.js';
import { makeRng } from '../behavior_pack/scripts/core/mathutil.js';
import { McBody, runMotor } from '../tests/helpers.js';

const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 100);
const VERBOSE = process.argv.includes('-v');
const SAFE = process.env.SAFE === '1';
// HARD=1: 20 jumps, mostly off and onto 1x1 pillars, turning more often.
const HARD = process.env.HARD === '1';
const JUMPS = HARD ? 20 : 12;
const key = (x, y, z) => `${x},${y},${z}`;

function world(blocks, floorY = null) {
  const S = new Set(blocks.map(([x, y, z]) => key(x, y, z)));
  return { classify: (x, y, z) => (S.has(key(x, y, z)) || (floorY !== null && y === floorY) ? Cell.SOLID : Cell.AIR), S };
}

// ---------- single jumps ----------
if (process.argv.includes('--jumps')) {
  const rng = makeRng(5);
  const rows = [];
  for (const runup of [3, 0]) {
    for (const dy of [1, 0, -1, -2, -3]) {
      const cells = [];
      for (let gap = 1; gap <= 4; gap++) {
        let ok = 0;
        const TR = 40;
        for (let k = 0; k < TR; k++) {
          const blocks = [];
          for (let x = -runup; x <= 0; x++) blocks.push([x, 69, 0]);
          const lx = gap + 1;
          for (let x = lx; x <= lx + 2; x++) blocks.push([x, 69 + dy, 0]);
          const w = world(blocks);
          const start = { x: -runup + 0.5, y: 70, z: 0.5 };
          const body = new McBody(w, start, rng.range(-180, 180));
          const m = new MotorController(body, {}, makeRng(k + 1));
          const wps = [start, ...(runup ? [{ x: 0.5, y: 70, z: 0.5 }] : []), { x: lx + 0.5, y: 70 + dy, z: 0.5, leap: gap }, { x: lx + 2.5, y: 70 + dy, z: 0.5 }];
          const { result } = await runMotor(m, body, m.followPath(wps), 400);
          if (result?.status === 'arrived' && body.pos.y >= 70 + dy - 0.1) ok++;
        }
        cells.push(`${String(Math.round(100 * ok / TR)).padStart(3)}%`);
      }
      rows.push(`${runup ? 'run-up  ' : 'standing'} ${dy > 0 ? '+' : ''}${dy}`.padEnd(14) + cells.join('  '));
    }
  }
  console.log('landing        gap 1  gap 2  gap 3  gap 4');
  for (const r of rows) console.log(r);
  process.exit(0);
}

// ---------- courses ----------
/** A course: platforms joined by jumps, turning now and then. Returns { blocks, start, goal, jumps }. */
function course(r) {
  const blocks = [];
  let x = 0, y = 70, z = 0, dir = [1, 0];
  const plat = (len) => { const cells = []; for (let i = 0; i < len; i++) { blocks.push([x, y - 1, z]); cells.push([x, z]); if (i < len - 1) { x += dir[0]; z += dir[1]; } } return cells; };
  plat(3);
  const start = { x: 0.5, y, z: 0.5 };
  const jumps = [];
  for (let j = 0; j < JUMPS; j++) {
    // Turn on the platform we're on (not on the first one).
    if (j > 0 && r() < (HARD ? 0.6 : 0.4)) dir = r() < 0.5 ? [-dir[1], dir[0]] : [dir[1], -dir[0]];
    const dy = [1, 0, 0, 0, -1, -1, -2, -3][r.int(0, 7)];
    const maxGap = dy > 0 ? 2 : dy === 0 ? 3 : 3;
    const gap = r.int(1, maxGap);
    x += dir[0] * (gap + 1); z += dir[1] * (gap + 1); y += dy;
    y = Math.max(58, Math.min(84, y));
    const len = HARD && r() < 0.7 ? 1 : r.int(1, 3);
    jumps.push(`${gap}${dy ? (dy > 0 ? '+' : '') + dy : ''}${len === 1 ? 'p' : ''}`);
    plat(len);
  }
  const goal = { x: x + 0.5, y, z: z + 0.5 };
  // (One that crosses back over itself, a platform in another's headroom or in a jump's arc: not a
  // fair course. Another is drawn.)
  const cols = new Set(blocks.map(([bx, , bz]) => `${bx},${bz}`));
  if (cols.size < blocks.length) return null;
  return { blocks, start, goal, jumps };
}

const rng = makeRng(20260929);
const st = { found: 0, done: 0, fell: 0, stuck: 0, secs: 0, nodes: 0, ms: 0, worstMs: 0, jumps: 0, n: 0 };
const bad = [];
for (let i = 0; i < N; i++) {
  const seed = rng.int(1, 1e9);
  const r = makeRng(seed);
  let c = course(r);
  while (!c) c = course(r);
  const w = world(c.blocks, SAFE ? 60 : null);
  const t0 = performance.now();
  const p = findPath(w.classify, c.start, c.goal, { maxNodes: 20000 });
  const ms = performance.now() - t0;
  st.n++; st.ms += ms; st.worstMs = Math.max(st.worstMs, ms); st.nodes += p.expanded ?? 0;
  if (!p.complete) {
    // How far along it does get: the first platform block it can't reach.
    let far = '';
    for (const [bx, by, bz] of c.blocks) { const q = findPath(w.classify, c.start, { x: bx + 0.5, y: by + 1, z: bz + 0.5 }, { maxNodes: 20000 }); if (!q.complete) { far = ` first unreachable ${bx},${by + 1},${bz}`; break; } }
    if (process.env.WHY && far) {
      const [fx, fy, fz] = far.trim().split(' ').pop().split(',').map(Number);
      console.log(`#${i} near ${fx},${fy},${fz}:`, c.blocks.filter(([bx, by, bz]) => Math.abs(bx - fx) <= 5 && Math.abs(bz - fz) <= 5 && Math.abs(by + 1 - fy) <= 4).map((b) => b.join(',')).join(' '));
    }
    bad.push(`#${i} no path (${c.jumps.join(' ')})${far}`); continue;
  }
  st.found++;
  const body = new McBody(w, c.start, makeRng(seed).range(-180, 180));
  const m = new MotorController(body, {}, makeRng(seed));
  const wps = smoothPath(w.classify, p.path);
  const ONE = process.env.ONE != null ? Number(process.env.ONE) : null;
  if (ONE !== null && ONE !== i) continue;
  if (ONE !== null) { console.log('waypoints', wps.map((q) => `${q.x},${q.y},${q.z}${q.leap ? ` leap${q.leap}` : ''}${q.tight ? ' tight' : ''}`).join(' | ')); const st0 = body.step.bind(body); let tk = 0; body.step = () => { st0(); tk++; if (!process.env.FROM || tk >= Number(process.env.FROM)) if (tk < (Number(process.env.FROM) || 0) + Number(process.env.WIN ?? 120)) console.log(tk, body.pos.x.toFixed(2), body.pos.y.toFixed(2), body.pos.z.toFixed(2), 'v', body.vx.toFixed(2), body.vz.toFixed(2), body.onGround ? 'G' : 'air', body.sprint ? 'S' : '', 'wp', m.intent?.it?.idx ?? m.it?.idx ?? ''); }; }
  // (Where it last stood, and heading for which waypoint: the jump that went wrong.)
  let lastGround = null;
  const st1 = body.step.bind(body);
  body.step = () => { st1(); if (body.onGround) lastGround = { pos: { ...body.pos }, idx: m.intent?.idx }; if (body.pos.y < 40) m.stop?.(); };
  const { result, ticks } = await runMotor(m, body, m.followPath(wps), 3000);
  const wpDesc = (k) => { const q = wps[k]; return q ? `${q.x},${q.y},${q.z}${q.leap ? ` leap${q.leap}` : ''}${q.tight ? ' tight' : ''}` : '-'; };
  const failAt = lastGround ? ` last stood ${lastGround.pos.x.toFixed(2)},${lastGround.pos.y.toFixed(0)},${lastGround.pos.z.toFixed(2)} heading ${wpDesc(lastGround.idx - 1)} -> ${wpDesc(lastGround.idx)}` : '';
  const fell = body.pos.y < 50 || (SAFE && body.pos.y < 62);
  if (result?.status === 'arrived') { st.done++; st.secs += ticks / 20; }
  else if (fell) { st.fell++; bad.push(`#${i} fell (${c.jumps.join(' ')}):${failAt}`); }
  else { st.stuck++; bad.push(`#${i} ${result?.status ?? 'timeout'} (${c.jumps.join(' ')}) at ${body.pos.x.toFixed(1)},${body.pos.y.toFixed(1)},${body.pos.z.toFixed(1)}`); }
}
console.log(`${N} courses of ${JUMPS} jumps${HARD ? ' (hard: mostly pillars)' : ''}${SAFE ? ' (a floor 4 below)' : ' (void below)'}: path found ${st.found}, finished ${st.done}, fell ${st.fell}, stuck ${st.stuck}; ${(st.secs / Math.max(1, st.done)).toFixed(1)} s a course; plan ${(st.ms / st.n).toFixed(1)} ms avg, worst ${st.worstMs.toFixed(0)} ms, ${(st.nodes / st.n).toFixed(0)} nodes`);
for (const b of bad.slice(0, VERBOSE ? 60 : 10)) console.log(`  - ${b}`);
