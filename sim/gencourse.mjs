// Random tow courses for the simulator (never used to tune on when the seed is >= 1000: those are the held-out ones).
// A lane (z-3..z+3 between stone walls) made of 2-4 segments in a row: steps up, a gate (3 wide, either side), a low wall to jump with a
// flat top, a bend-free narrowing. Pits are left out (they need the bridging/building path, which has its own course). Same shape as
// core/towcourses.js's towCourse(): { cmds, boat, start, goal, zone, room, ext }.
function rng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

export function randomTowCourse(seed, x, gy, z) {
  const R = rng(seed + 7), ri = (a, b) => a + Math.floor(R() * (b - a + 1));
  const cmds = [], w = 10, r = 8;
  const fill = (x1, y1, z1, x2, y2, z2, id) => cmds.push(`fill ${x + x1} ${gy + y1} ${z + z1} ${x + x2} ${gy + y2} ${z + z2} ${id}`);
  const nSeg = ri(2, 4);
  const segs = [];
  let cx = 5, h = 0;
  const parts = [];
  for (let i = 0; i < nSeg; i++) {
    const kind = ['step', 'step', 'gate', 'wall'][ri(0, 3)];
    if (kind === 'step') { const up = 1; const tread = ri(3, 6); parts.push({ kind, at: cx, up, tread, h }); h += up; cx += tread + ri(2, 5); }
    else if (kind === 'gate') { const south = R() < 0.5; parts.push({ kind, at: cx, south, h }); cx += ri(5, 9); }
    else { const hh = 1; parts.push({ kind, at: cx, hh, depth: ri(3, 5), h }); h += 0; cx += ri(2, 4) + 4; }
    segs.push(kind);
  }
  const end = cx + 6, e = end + 6;
  fill(-w, 0, -r, e, 0, r, 'grass_block');
  fill(-w, 1, -r, e, 9, r, 'air');
  fill(-1, 1, -r, end, 8, -4, 'stone'); fill(-1, 1, 4, end, 8, r, 'stone'); fill(end, 1, -4, end, 8, 4, 'stone');
  for (const p of parts) {
    if (p.kind === 'step') { fill(p.at, 1, -3, end - 1, p.h + p.up, 3, 'stone'); }
    else if (p.kind === 'gate') {
      fill(p.at, p.h + 1, -3, p.at, p.h + 4, 3, 'stone');
      if (p.south) fill(p.at, p.h + 1, 1, p.at, p.h + 4, 3, 'air'); else fill(p.at, p.h + 1, -3, p.at, p.h + 4, -1, 'air');
    } else { fill(p.at, p.h + 1, -3, p.at + p.depth, p.h + p.hh, 3, 'stone'); }
  }
  // steps were drawn as solid blocks to the end of the lane; re-clear nothing: later (higher) steps overwrite earlier ones, which is the stair
  const gdx = end - 3;
  fill(gdx, h, 0, gdx, h, 0, 'gold_block');
  return {
    cmds,
    boat: { x: x - 7.5, y: gy + 1, z: z + 0.5 },
    start: { x: x - 6, y: gy + 1, z: z + 0.5 },
    goal: { x: x + gdx + 0.5, y: gy + h + 1, z: z + 0.5 },
    zone: 3.6, room: 2.5,
    ext: { w, e, r }, desc: parts.map((p) => p.kind === 'step' ? `step+${p.up}@${p.at}` : p.kind === 'gate' ? `gate${p.south ? 'S' : 'N'}@${p.at}` : `wall@${p.at}`).join(' '),
  };
}
