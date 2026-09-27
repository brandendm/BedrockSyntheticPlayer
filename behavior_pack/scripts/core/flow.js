// One action leading into the next, the way a player's hand moves: across a wall face or a patch of
// grass the crosshair sweeps from each block to its neighbour, never back and forth. Pure (tested).
//
//   sweepOrder(eye, look, cells, { mode, supported })
//     eye: {x, y, z}; look: {yaw, pitch} in radians (where we're looking now); cells: [{x, y, z}]
//     mode 'break': within a column top first (a tunnel is cut head then feet; sand and gravel come
//       down); 'place': bottom up, and only a cell with something to place it against
//       (supported(cell, placedSoFar) -> bool) comes next
//   Greedy: each next cell is the smallest turn of the head from the last, edges first (Warnsdorff:
//   the cell with fewest untouched neighbours wins a near tie) so no block is left stranded to jump
//   back to. Returns the cells in order (place: ones that never get support are left out).

const DIR = (eye, c) => {
  const dx = c.x + 0.5 - eye.x, dy = c.y + 0.5 - eye.y, dz = c.z + 0.5 - eye.z;
  return { yaw: Math.atan2(dz, dx), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
};
/** Angle between two view directions (radians). */
export function turn(a, b, pitchWeight = 1) {
  const dyaw = Math.atan2(Math.sin(a.yaw - b.yaw), Math.cos(a.yaw - b.yaw));
  return Math.hypot(dyaw * Math.cos((a.pitch + b.pitch) / 2), (a.pitch - b.pitch) * pitchWeight);
}

export function sweepOrder(eye, look, cells, { mode = 'break', supported = null } = {}) {
  const left = cells.map((c) => ({ c, d: DIR(eye, c) }));
  const out = [], placed = new Set();
  const key = (c) => `${c.x},${c.y},${c.z}`;
  const remaining = new Set(cells.map(key));
  // Untouched cells next to c (any of the 26 around it): working the edges first (Warnsdorff)
  // never strands a block to come back to across the face (the cliff: sweep, then a jump back).
  const neighbours = (c) => {
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if ((dx || dy || dz) && remaining.has(`${c.x + dx},${c.y + dy},${c.z + dz}`)) n++;
    }
    return n;
  };
  let cur = look;
  while (left.length) {
    let bi = -1, bs = Infinity;
    for (let i = 0; i < left.length; i++) {
      const { c, d } = left[i];
      // Breaking: a block with one still to break right above it waits (a tunnel is cut head then
      // feet; sand and gravel come down). Placing: bottom up, and only against something.
      if (mode === 'break' && remaining.has(`${c.x},${c.y + 1},${c.z}`)) continue;
      if (mode === 'place' && remaining.has(`${c.x},${c.y - 1},${c.z}`)) continue;
      if (mode === 'place' && supported && !supported(c, placed)) continue;
      // (Placing, up or down costs more than along: a wall goes up a course at a time, like bricks.)
      const s = turn(cur, d, mode === 'place' ? 3 : 1) + 0.08 * neighbours(c);
      if (s < bs) { bs = s; bi = i; }
    }
    if (bi < 0) break; // (placing: nothing left we can put against anything)
    const [{ c, d }] = left.splice(bi, 1);
    out.push(c);
    placed.add(key(c));
    remaining.delete(key(c));
    cur = d;
  }
  return out;
}

/** How far the head turns going through cells in this order, starting from look (radians). */
export function sweepLength(eye, look, cells) {
  let cur = look, n = 0;
  for (const c of cells) { const d = DIR(eye, c); n += turn(cur, d); cur = d; }
  return n;
}
