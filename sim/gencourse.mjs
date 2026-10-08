// Random tow courses for the simulator (seeds >= 1000 are the held-out ones: never tune on them).
// A course is a list of PARTS laid out one after the other along a lane (z-3..z+3 between stone walls): steps of 1 up, gates (3 wide, either side),
// low walls (1 high, 3-5 deep). Pits are left out (they need the bridging path, which has its own course).
// towParts(seed) -> parts; buildCourse(parts, x, gy, z) -> { cmds, boat, start, goal, zone, room, ext, desc }; randomTowCourse(seed, x, gy, z) is both.
// The minimizer (sim/minimize.mjs) drops parts from the list, which is why the layout is relative (each part carries its own gap).
function rng(seed) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// level 1: the easy courses (2-4 parts); level 2: 3-6 parts with pits (a block kit: 32 dirt), which the bot has to bridge with the boat following.
export function towParts(seed, level = 1) {
  const R = rng(seed + 7 + (level - 1) * 100003), ri = (a, b) => a + Math.floor(R() * (b - a + 1));
  const n = level >= 2 ? ri(3, 6) : ri(2, 4), parts = [];
  for (let i = 0; i < n; i++) {
    const kind = level >= 2 ? ['step', 'gate', 'wall', 'pit', 'step'][ri(0, 4)] : ['step', 'step', 'gate', 'wall'][ri(0, 3)];
    if (kind === 'pit') { parts.push({ kind, width: ri(3, 5), gap: i === 0 ? 6 : ri(4, 6) }); continue; }
    if (kind === 'step') { const tread = ri(3, 6); parts.push({ kind, tread, gap: i === 0 ? 5 : ri(2, 5) }); }
    else if (kind === 'gate') { const south = R() < 0.5; parts.push({ kind, south, gap: i === 0 ? 5 : ri(5, 9) }); }
    else parts.push({ kind, depth: ri(6, 9), gap: i === 0 ? 5 : ri(2, 4) + 4 });   // (u272: probewall showed a boat at a wall's foot cannot be slung from the ground, so a wall needs a top to stand on and stretch the lead: 6+ deep)
  }
  // (the old generator drew the gaps after a part, from the same stream: this one puts them in front, so the same seed is a different course than before u271)
  return parts;
}

export function buildCourse(parts, x, gy, z) {
  const cmds = [], w = 10, r = 8;
  const fill = (x1, y1, z1, x2, y2, z2, id) => cmds.push(`fill ${x + x1} ${gy + y1} ${z + z1} ${x + x2} ${gy + y2} ${z + z2} ${id}`);
  let cx = 0, h = 0;
  const placed = parts.map((p) => { cx += p.gap; const q = { ...p, at: cx, h }; if (p.kind === 'step') { h += 1; cx += p.tread; } else if (p.kind === 'gate') cx += 0; else if (p.kind === 'pit') cx += p.width; else cx += p.depth; return q; });
  const end = cx + 9, e = end + 6;
  fill(-w, 0, -r, e, 0, r, 'grass_block');
  fill(-w, 1, -r, e, 9, r, 'air');
  fill(-1, 1, -r, end, 8, -4, 'stone'); fill(-1, 1, 4, end, 8, r, 'stone'); fill(end, 1, -4, end, 8, 4, 'stone');
  for (const p of placed) {
    if (p.kind === 'step') fill(p.at, 1, -3, end - 1, p.h + 1, 3, 'stone');
    else if (p.kind === 'gate') {
      fill(p.at, p.h + 1, -3, p.at, p.h + 4, 3, 'stone');
      if (p.south) fill(p.at, p.h + 1, 1, p.at, p.h + 4, 3, 'air'); else fill(p.at, p.h + 1, -3, p.at, p.h + 4, -1, 'air');
    } else if (p.kind === 'pit') fill(p.at, p.h - 5, -3, p.at + p.width - 1, p.h, 3, 'air');   // (the floor under it dug out: 5 deep)
    else fill(p.at, p.h + 1, -3, p.at + p.depth, p.h + 1, 3, 'stone');
  }
  const gdx = end - 3;
  fill(gdx, h, 0, gdx, h, 0, 'gold_block');
  return {
    cmds, boat: { x: x - 7.5, y: gy + 1, z: z + 0.5 }, start: { x: x - 6, y: gy + 1, z: z + 0.5 },
    goal: { x: x + gdx + 0.5, y: gy + h + 1, z: z + 0.5 }, zone: 3.6, room: 2.5, ext: { w, e, r },
    kit: parts.some((p) => p.kind === 'pit') ? [['lead', 2], ['dirt', 32]] : [['lead', 2]],
    desc: describeParts(parts),
  };
}
export const describeParts = (parts) => parts.map((p) => p.kind === 'step' ? `step(${p.tread})` : p.kind === 'gate' ? `gate${p.south ? 'S' : 'N'}` : p.kind === 'pit' ? `pit(${p.width})` : `wall(${p.depth})`).join(' ') || '(flat)';
export const randomTowCourse = (seed, x, gy, z, level = 1) => buildCourse(towParts(seed, level), x, gy, z);
