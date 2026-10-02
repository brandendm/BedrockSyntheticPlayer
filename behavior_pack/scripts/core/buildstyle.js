// How a player builds, as habits rather than a floor plan (`!bot learn house` records; core/learnhouse.js copies the building,
// this reads the choices): how fast blocks go down, how far and how high they stand from what they place, which faces they click,
// where chests, furnaces, the table, the bed, signs and torches go in relation to the door, the walls and each other, which way
// they face, and how long they stop to decide before a furnishing. Pure (unit-tested).
//
// rows: the placement rows demo.js records: { t (ticks from the start), id, x, y, z, face, st (block states), px, py, pz (the player), g, sn }.
const strip = (id) => String(id ?? '').replace(/^minecraft:/, '');
export const KINDS = {
  chest: /(^|_)chest$|^barrel$/, furnace: /^(furnace|blast_furnace|smoker)$/, table: /^crafting_table$/, bed: /(^|_)bed$/,
  sign: /_sign$|hanging_sign$/, torch: /torch$/, door: /_door$/, ladder: /^ladder$/, anvil: /^anvil$/, lectern: /^(lectern|enchanting_table|brewing_stand|cartography_table|smithing_table|grindstone|stonecutter_block)$/,
};
export const kindOf = (id) => { const b = strip(id); for (const [k, re] of Object.entries(KINDS)) if (re.test(b)) return k; return null; };
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((p, q) => p - q); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const COMPASS = ['north', 'east', 'south', 'west'];

/** Which way a block faces, from its states: 'north'|'east'|'south'|'west'|'up'|'down'|null. */
function facingOf(st) {
  if (!st) return null;
  const c = st['minecraft:cardinal_direction'] ?? st.cardinal_direction;
  if (typeof c === 'string') return c;
  const f = st['minecraft:facing_direction'] ?? st.facing_direction;
  if (Number.isFinite(f)) return ['down', 'up', 'north', 'south', 'west', 'east'][f] ?? null;
  const d = st.direction;
  if (Number.isFinite(d)) return ['south', 'west', 'north', 'east'][d & 3];
  return null;
}
const VEC = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };

export function analyseStyle(rows, { door = null } = {}) {
  const P = (rows ?? []).filter((r) => r && r.k !== 'b' && Number.isFinite(r.x)).sort((a, b) => a.t - b.t);
  if (P.length < 12) return null;
  const kinds = P.map((r) => kindOf(r.id));
  const walls = P.filter((_, i) => kinds[i] === null);
  const key = (r) => `${r.x},${r.y},${r.z}`;
  const solid = new Set(walls.map(key));
  const centre = walls.length ? { x: walls.reduce((s, r) => s + r.x, 0) / walls.length, z: walls.reduce((s, r) => s + r.z, 0) / walls.length } : { x: P[0].x, z: P[0].z };
  let doorRef = null;
  if (typeof door === 'string') { const [x, y, z] = door.split(',').map(Number); doorRef = { x, y, z }; }
  else { const d = P.find((r, i) => kinds[i] === 'door'); if (d) doorRef = { x: d.x, y: d.y, z: d.z }; }
  const floorY = doorRef ? doorRef.y : median(P.filter((_, i) => kinds[i] === 'furnace' || kinds[i] === 'table').map((r) => r.y)) ?? null;

  // Rhythm: gaps between one placement and the next (a burst is gaps under 5 s; the long ones are stops).
  const gaps = [], pauseBefore = {};
  for (let i = 1; i < P.length; i++) {
    const g = P[i].t - P[i - 1].t;
    if (kinds[i] === null && kinds[i - 1] === null && g < 100) gaps.push(g);
    if (kinds[i] !== null && g > 0) (pauseBefore[kinds[i]] ??= []).push(Math.min(g, 1200));
  }
  // Where they stand: eye to the block, how far above, jumping, sneaking, which face they clicked.
  const eye = (r) => ({ x: r.px, y: r.py + 1.62, z: r.pz });
  const dist3 = (r) => { if (!Number.isFinite(r.px)) return null; const e = eye(r); return Math.hypot(e.x - (r.x + 0.5), e.y - (r.y + 0.5), e.z - (r.z + 0.5)); };
  const faces = {};
  for (const r of P) if (r.face) faces[r.face] = (faces[r.face] ?? 0) + 1;
  const nFace = Object.values(faces).reduce((a, b) => a + b, 0) || 1;
  const placeGround = P.filter((r) => Number.isFinite(r.g));
  const out = {
    n: P.length, walls: walls.length, secs: Math.round((P[P.length - 1].t - P[0].t) / 20),
    rhythm: { blockGapTicks: r1(median(gaps)), blocksPerMin: gaps.length ? Math.round(1200 / Math.max(1, median(gaps))) : null },
    stand: {
      reachWalls: r1(median(walls.map(dist3))), reachFurnishings: r1(median(P.filter((_, i) => kinds[i]).map(dist3))),
      above: r1(median(walls.map((r) => (Number.isFinite(r.py) ? r.y - r.py : null)))),
      jumping: placeGround.length ? Math.round((100 * placeGround.filter((r) => !r.g).length) / placeGround.length) / 100 : null,
      sneaking: P.some((r) => Number.isFinite(r.sn)) ? Math.round((100 * P.filter((r) => r.sn).length) / P.length) / 100 : null,
    },
    faces: Object.fromEntries(Object.entries(faces).map(([k, v]) => [k, Math.round((100 * v) / nFace) / 100])),
    furnishings: {},
  };
  const placedF = P.map((r, i) => ({ r, kind: kinds[i] })).filter((x) => x.kind && x.kind !== 'door' && x.kind !== 'torch');
  for (const kind of Object.keys(KINDS)) {
    const list = P.map((r, i) => ({ r, i })).filter((x) => kinds[x.i] === kind);
    if (!list.length) continue;
    const rs = list.map((x) => x.r);
    const near = rs.map((r) => {
      const others = placedF.filter((o) => o.r !== r).map((o) => flat(r, o.r));
      return others.length ? Math.min(...others) : null;
    });
    const wallAdj = rs.map((r) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => solid.has(`${r.x + dx},${r.y},${r.z + dz}`)));
    const facing = rs.map((r) => facingOf(r.st)).filter(Boolean);
    const inward = rs.map((r) => {
      const f = facingOf(r.st); if (!VEC[f]) return null;
      const to = { x: centre.x - r.x, z: centre.z - r.z }, v = VEC[f];
      return v[0] * to.x + v[1] * to.z > 0;
    }).filter((v) => v !== null);
    const e = {
      n: rs.length,
      againstWall: Math.round((100 * wallAdj.filter(Boolean).length) / rs.length) / 100,
      toDoor: doorRef ? r1(median(rs.map((r) => flat(r, doorRef)))) : null,
      toNearestOther: r1(median(near)),
      fromFloor: floorY == null ? null : r1(median(rs.map((r) => r.y - floorY))),
      fromCentre: r1(median(rs.map((r) => flat(r, centre)))),
      facing: facing.length ? Object.fromEntries(COMPASS.concat(['up', 'down']).map((c) => [c, facing.filter((f) => f === c).length]).filter(([, n]) => n)) : null,
      facesInward: inward.length ? Math.round((100 * inward.filter(Boolean).length) / inward.length) / 100 : null,
      pauseBeforeTicks: pauseBefore[kind] ? Math.round(median(pauseBefore[kind])) : null,
    };
    if (kind === 'chest') {
      const chests = rs;
      e.pairedWithChest = Math.round((100 * chests.filter((c) => chests.some((o) => o !== c && o.y === c.y && Math.abs(o.x - c.x) + Math.abs(o.z - c.z) === 1)).length) / chests.length) / 100;
      const fur = placedF.filter((o) => o.kind === 'furnace');
      e.nextToFurnace = fur.length ? Math.round((100 * chests.filter((c) => fur.some((o) => flat(o.r, c) <= 2.1 && Math.abs(o.r.y - c.y) <= 1)).length) / chests.length) / 100 : null;
    }
    if (kind === 'sign') {
      const chests = P.filter((_, i) => kinds[i] === 'chest');
      const rel = rs.map((r) => {
        if (chests.some((c) => c.x === r.x && c.z === r.z && c.y === r.y - 1)) return 'aboveChest';
        if (chests.some((c) => c.y === r.y && Math.abs(c.x - r.x) + Math.abs(c.z - r.z) === 1)) return 'besideChest';
        if (chests.some((c) => flat(c, r) <= 2.5 && Math.abs(c.y - r.y) <= 2)) return 'nearChest';
        return 'free';
      });
      e.relationToChest = Object.fromEntries(['aboveChest', 'besideChest', 'nearChest', 'free'].map((k) => [k, rel.filter((x) => x === k).length]).filter(([, n]) => n));
      e.standing = rs.filter((r) => /standing/.test(strip(r.id))).length > rs.length / 2; // (a post sign rather than one on a wall)
    }
    if (kind === 'bed') e.headToWall = null;
    out.furnishings[kind] = e;
  }
  return out;
}

/** Fold a new recording into what's kept, weighted by how many placements each had. */
export function mergeStyle(old, fresh) {
  if (!fresh) return old ?? null;
  if (!old) return { ...fresh, sessions: 1 };
  const w0 = old.n, w1 = fresh.n, w = w0 + w1 || 1;
  const mix = (a, b) => (a == null ? b : b == null ? a : Math.round(((a * w0 + b * w1) / w) * 100) / 100);
  const mixObj = (a, b) => { if (!a || !b) return b ?? a; const o = {}; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) o[k] = typeof (a[k] ?? b[k]) === 'number' ? mix(a[k], b[k]) : b[k] ?? a[k]; return o; };
  const furnishings = {};
  for (const k of new Set([...Object.keys(old.furnishings ?? {}), ...Object.keys(fresh.furnishings ?? {})])) furnishings[k] = mixObj(old.furnishings?.[k], fresh.furnishings?.[k]);
  return {
    ...fresh, sessions: (old.sessions ?? 1) + 1, n: w, secs: (old.secs ?? 0) + fresh.secs,
    rhythm: mixObj(old.rhythm, fresh.rhythm), stand: mixObj(old.stand, fresh.stand), faces: mixObj(old.faces, fresh.faces), furnishings,
  };
}

/** The style in a few lines for chat. */
export function describeStyle(s) {
  if (!s) return 'No building style learned yet: `!bot learn house`, build, `!bot learn off`.';
  const L = [];
  L.push(`${s.n} placements in ${s.secs} s: blocks ${s.rhythm?.blockGapTicks ?? '?'} ticks apart (~${s.rhythm?.blocksPerMin ?? '?'}/min), stood ${s.stand?.reachWalls ?? '?'} blocks from walls (blocks ${s.stand?.above ?? '?'} above the feet), jumping ${Math.round((s.stand?.jumping ?? 0) * 100)}% of the time, sneaking ${Math.round((s.stand?.sneaking ?? 0) * 100)}%.`);
  const f = s.furnishings ?? {};
  const bit = (name, e, extra = '') => e && `${name}: ${e.n}, ${Math.round((e.againstWall ?? 0) * 100)}% against a wall${e.toDoor != null ? `, ${e.toDoor} from the door` : ''}${e.facesInward != null ? `, ${Math.round(e.facesInward * 100)}% facing in` : ''}${extra}`;
  if (f.chest) L.push(bit('chests', f.chest, `${f.chest.pairedWithChest != null ? `, ${Math.round(f.chest.pairedWithChest * 100)}% in pairs` : ''}${f.chest.nextToFurnace != null ? `, ${Math.round(f.chest.nextToFurnace * 100)}% by a furnace` : ''}`));
  if (f.furnace) L.push(bit('furnaces', f.furnace, f.furnace.toNearestOther != null ? `, ${f.furnace.toNearestOther} from the nearest other furnishing` : ''));
  if (f.table) L.push(bit('crafting table', f.table));
  if (f.bed) L.push(bit('bed', f.bed));
  if (f.sign) L.push(`signs: ${f.sign.n}, ${Object.entries(f.sign.relationToChest ?? {}).map(([k, v]) => `${v} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`).join(', ') || 'none by chests'}${f.sign.standing ? ' (post signs)' : ' (on walls)'}`);
  if (f.torch) L.push(`torches: ${f.torch.n}${f.torch.fromFloor != null ? `, ${f.torch.fromFloor} above the floor` : ''}`);
  const stops = Object.entries(f).filter(([, e]) => e.pauseBeforeTicks != null).map(([k, e]) => `${k} ${Math.round(e.pauseBeforeTicks / 20)} s`);
  if (stops.length) L.push(`stopped to decide before: ${stops.join(', ')}.`);
  return L.join('\n');
}
