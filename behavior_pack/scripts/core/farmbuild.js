// The bot's own build of the iron farm (game/farmbuild.js): which blocks it places by hand, where it stands for each, in what order, and what it
// leaves to commands. Pure: the world is behind a `hands` object, so tests/farmbuild.test.js runs the whole build against a fake world that keeps
// the rules a player is under (a block goes only against a solid neighbour, only on the side the eye is on, only within reach of where the bot
// stands, only from a spot that is solid underfoot with room to head height) and checks that what is left standing is the plan.
//
// What the bot places: the shell (dirt), the glass of the window, the composters, the slabs: nearly every block of the farm. What it does not: beds,
// hoppers, chests, signs, gates, the door, torches, campfires, lava, water, villagers. Those take a particular state (which way a bed or a hopper
// faces, a gate open, a sign on its wall, a campfire lit) and the project has always set them with commands (game/ironfarm_parts.js).
//
// The bot is put on a spot (teleported: this tests how it places blocks, not how it climbs) and places every cell that is in reach and has something
// solid beside it to click; then it is put on the next. A spot is any cell with a full block under it and room for the bot, with the most unplaced cells
// of the layer in reach. Nothing to stand on yet (the first block of a floating floor): that block is set by command and the bot stands on it. A block
// that will not go down by hand is set by command and counted. If the hand keeps missing, or is far too slow, the rest is done by command and it says so.
import { render } from './ironfarm_grid.js';
import { SLAB } from './ironfarm_geo.js';

export const REACH = 4.0;          // (the game's is 4.5: a margin for where in the cell the eye is)
export const EYE = 1.52;
export const JUDGE_AFTER = 24;     // hand attempts before the hit rate is judged
export const MIN_HIT_RATE = 0.3;
export const MAX_TICKS_PER_BLOCK = 240;   // on average, once enough have been tried: more than twelve seconds a block is not worth waiting for

const key = (x, y, z) => `${x},${y},${z}`;
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const BELOW = [[0, -1, 0]];
/** What the bot walks through (and a block can be put into): no collision. */
export const FREE = new Set(['air', 'wall_sign', 'torch', 'fence_gate', 'water', 'flowing_water', 'lava']);
/** What the bot can stand on (full blocks it can also click against). */
export const STAND_ON = new Set(['dirt', 'cobblestone', 'stone', 'smooth_stone', 'glass', 'composter', 'grass_block']);
const clickable = (id) => !FREE.has(id) && id !== 'unloaded';

/** The ids the bot places by hand. */
export const handSet = (shell = 'dirt') => new Set([shell, 'glass', 'composter', SLAB]);

/** The plan split in two: the cells the bot places (final blocks of the hand kinds), and the `set` ops that are left to commands (ones that survive to the end). */
export function splitPlan(plan) {
  const g = render(plan);
  const hand = handSet(plan.shell ?? 'cobblestone');
  const cells = [];
  for (const [k, v] of g.cells) if (hand.has(v.id)) { const [x, y, z] = k.split(',').map(Number); cells.push({ x, y, z, id: v.id }); }
  cells.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const rest = plan.ops.filter((o) => o.op === 'set' && !hand.has(o.id) && g.at(o.x, o.y, o.z)?.id === o.id);
  return { cells, rest, final: g };
}

/** Is cell t within reach of a bot standing with its feet in cell s? */
export function reaches(s, t) {
  const dx = s.x + 0.5 - (t.x + 0.5), dy = s.y + EYE - (t.y + 0.5), dz = s.z + 0.5 - (t.z + 0.5);
  return dx * dx + dy * dy + dz * dz <= REACH * REACH;
}

/** Is the eye, standing at s, on the open side of the face of neighbour n that looks toward cell t? (You cannot click a face you are behind.) */
export function facing(s, t, n) {
  const e = { x: s.x + 0.5, y: s.y + EYE, z: s.z + 0.5 };
  const nx = t.x - n.x, ny = t.y - n.y, nz = t.z - n.z;   // the face's outward normal
  const fc = { x: n.x + 0.5 + nx * 0.5, y: n.y + 0.5 + ny * 0.5, z: n.z + 0.5 + nz * 0.5 };
  return (e.x - fc.x) * nx + (e.y - fc.y) * ny + (e.z - fc.z) * nz > 0.05;
}

/** The counts a build keeps (pass your own to runBuild to read them while it runs). */
export const newStats = () => ({
  cells: 0, hand: 0, command: 0, already: 0, footing: 0, fallback: 0, repaired: 0, gaveUp: '', standMoves: 0, standFails: 0, attempts: 0, hits: 0, handTicks: 0, ticks: 0, strays: 0,
  layer: /** @type {number|string|null} */ (null),
  handById: /** @type {Record<string, number>} */ ({}), commandById: /** @type {Record<string, number>} */ ({}), layers: /** @type {any[]} */ ([]),
});

/**
 * Build it. `hands`:
 *   blockAt({x,y,z}) -> id | null     where({x,y,z}) -> the cell the bot's feet are in
 *   stand({x,y,z}) -> Promise<bool>   put the bot with its feet in that cell
 *   place(cell, id) -> Promise<bool>  place it by hand, read back
 *   set(cell, id) -> bool             set it by command
 *   stock(id, n) -> void              make sure the bot carries at least n
 *   now() -> ticks   check() -> throws when told to stop   yield() -> Promise (a tick)   say(msg)
 * `after(y, stats)` runs once the hand layer y is done and checked (y from the bottom of the plan to the top, then 'slabs' last): the commands for what
 * the bot does not place. Everything is in plan coordinates. Returns the stats.
 * @param {any} plan @param {any} hands @param {{ after?: (y: number|string, stats: any) => Promise<void>, maxTicks?: number, stats?: any }} [opts]
 */
export async function runBuild(plan, hands, { after = null, maxTicks = Infinity, stats = newStats() } = {}) {
  const { cells, final } = splitPlan(plan);
  const finalId = new Map(cells.map((c) => [key(c.x, c.y, c.z), c.id]));
  const bd = plan.bounds;
  stats.cells = cells.length;
  const t0 = hands.now();
  let W = new Map();
  const idAt = (x, y, z) => {
    const k = key(x, y, z);
    let v = W.get(k);
    if (v === undefined) { v = hands.blockAt({ x, y, z }) ?? 'unloaded'; W.set(k, v); }
    return v;
  };
  const bump = (m, id) => { m[id] = (m[id] ?? 0) + 1; };

  const commandPlace = (c, why) => {
    const id = finalId.get(key(c.x, c.y, c.z));
    if (hands.set(c, id)) { W.set(key(c.x, c.y, c.z), id); stats.command++; bump(stats.commandById, id); if (why) stats[why]++; return true; }
    return false;
  };
  // (A slab goes only on the top of the block under it: clicked on a side face's upper half it would be a top slab, on which mobs spawn.)
  const dirsOf = (c) => (c.id === SLAB ? BELOW : DIRS);
  const supportedNow = (c) => dirsOf(c).some(([a, b, d]) => clickable(idAt(c.x + a, c.y + b, c.z + d)));
  /** Placeable from s right now: in reach, free, and some neighbour to click that has the eye on its open side. */
  const placeableFrom = (s, c) => {
    if (!reaches(s, c)) return false;
    if (c.x === s.x && c.z === s.z && (c.y === s.y || c.y === s.y + 1)) return false;
    return dirsOf(c).some(([a, b, d]) => { const n = { x: c.x + a, y: c.y + b, z: c.z + d }; return clickable(idAt(n.x, n.y, n.z)) && facing(s, c, n); });
  };

  /** The best spot to stand to place c: c placeable from it, the most of `near` in reach; null if there is none. */
  const bestStand = (c, near, from) => {
    let best = null, bestScore = -Infinity;
    for (let dy = -3; dy <= 2; dy++) {
      const sy = c.y + dy;
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        const s = { x: c.x + dx, y: sy, z: c.z + dz };
        if (!STAND_ON.has(idAt(s.x, sy - 1, s.z)) || !FREE.has(idAt(s.x, sy, s.z)) || !FREE.has(idAt(s.x, sy + 1, s.z))) continue;
        if (!placeableFrom(s, c)) continue;
        let n = 0;
        for (const t of near) if (reaches(s, t) && !(t.x === s.x && t.z === s.z && (t.y === s.y || t.y === s.y + 1))) n++;
        const score = n * 100 - Math.abs(dx) - Math.abs(dz) - Math.abs(dy) * 2 - (from ? Math.hypot(s.x - from.x, s.y - from.y, s.z - from.z) * 0.1 : 0);
        if (score > bestScore) { bestScore = score; best = s; }
      }
    }
    return best;
  };

  const judge = () => {
    if (stats.gaveUp) return;
    if (hands.now() - t0 > maxTicks) { stats.gaveUp = 'out of time'; return; }
    if (stats.attempts >= JUDGE_AFTER && stats.hits / stats.attempts < MIN_HIT_RATE) stats.gaveUp = `only ${stats.hits} of ${stats.attempts} went down by hand`;
    else if (stats.attempts >= 12 && stats.handTicks / stats.attempts > MAX_TICKS_PER_BLOCK) stats.gaveUp = `${Math.round(stats.handTicks / stats.attempts / 20)} s a block is too slow`;
    if (stats.gaveUp) hands.say(`Placing by hand is not working well enough (${stats.gaveUp}): the rest I set with commands.`);
  };

  /** One layer's cells (those not there yet), by hand where it can be. */
  async function layer(y, slabs) {
    const mine = cells.filter((c) => c.y === y && (c.id === SLAB) === slabs);
    W = new Map();
    const T = new Map();
    for (const c of mine) { if (idAt(c.x, c.y, c.z) === c.id) stats.already++; else T.set(key(c.x, c.y, c.z), c); }
    if (!T.size) return;
    const before = { hand: stats.hand, command: stats.command };
    const need = {};
    for (const c of T.values()) bump(need, c.id);
    for (const [id, n] of Object.entries(need)) hands.stock(id, n);
    let guard = 0;
    while (T.size) {
      hands.check();
      if (++guard > mine.length * 3 + 20) throw new Error(`the build loop did not end on layer ${y}`);
      if (stats.gaveUp) { for (const c of [...T.values()]) { commandPlace(c, 'fallback'); T.delete(key(c.x, c.y, c.z)); } break; }
      const here = hands.where();
      // The next block: one with something to click, nearest to where the bot is.
      let c0 = null, d0 = Infinity;
      for (const c of T.values()) {
        if (!supportedNow(c)) continue;
        const d = here ? Math.hypot(c.x - here.x, (c.y - here.y) * 2, c.z - here.z) : 0;
        if (d < d0) { d0 = d; c0 = c; }
      }
      if (!c0) {                       // nothing to click against anywhere in the layer: the first block is set by command
        let first = null, df = Infinity;
        for (const c of T.values()) { const d = here ? Math.hypot(c.x - here.x, c.y - here.y, c.z - here.z) : c.y; if (d < df) { df = d; first = c; } }
        commandPlace(first, 'footing'); T.delete(key(first.x, first.y, first.z));
        continue;
      }
      const near = [];
      for (const t of T.values()) if (Math.abs(t.x - c0.x) <= 9 && Math.abs(t.z - c0.z) <= 9 && Math.abs(t.y - c0.y) <= 6) near.push(t);
      const s = bestStand(c0, near, here);
      if (!s) {                        // no spot to stand where it can be placed from: by command, and it is a block to stand on from now on
        commandPlace(c0, 'footing'); T.delete(key(c0.x, c0.y, c0.z));
        await hands.yield();
        continue;
      }
      if (!(await hands.stand(s))) {
        stats.standFails++;
        commandPlace(c0, 'fallback'); T.delete(key(c0.x, c0.y, c0.z));
        if (stats.standFails >= 6 && !stats.gaveUp) { stats.gaveUp = 'the bot could not be put on its spots'; hands.say(`Could not put the bot on its spots (${stats.standFails} times): the rest I set with commands.`); }
        continue;
      }
      stats.standMoves++;
      // Everything in reach from this spot that can be placed, lowest first, nearest first.
      for (let inner = 0; inner < 400; inner++) {
        hands.check();
        let k = null, dk = Infinity;
        for (const t of T.values()) {
          if (!placeableFrom(s, t)) continue;
          const d = (t.y - s.y) * 3 + Math.hypot(t.x - s.x, t.z - s.z);
          if (d < dk) { dk = d; k = t; }
        }
        if (!k) break;
        const now = hands.where();
        if (now && (now.x !== s.x || now.y !== s.y || now.z !== s.z)) { if (!(await hands.stand(s))) break; stats.standMoves++; }
        const id = finalId.get(key(k.x, k.y, k.z));
        stats.attempts++;
        const a = hands.now();
        let ok = await hands.place(k, id);
        if (!ok) ok = await hands.place(k, id);
        stats.handTicks += hands.now() - a;
        T.delete(key(k.x, k.y, k.z));
        if (ok) { stats.hand++; stats.hits++; bump(stats.handById, id); W.set(key(k.x, k.y, k.z), id); } else commandPlace(k, 'fallback');
        judge();
        if (stats.gaveUp) break;
        if (inner % 8 === 7) await hands.yield();
      }
      // c0 itself must have gone (it was placeable from s): if it did not, it must not be asked for again.
      if (T.has(key(c0.x, c0.y, c0.z))) { commandPlace(c0, 'fallback'); T.delete(key(c0.x, c0.y, c0.z)); }
    }
    // Read it all back: whatever is not there is set.
    W = new Map();
    for (const c of mine) if (idAt(c.x, c.y, c.z) !== c.id) commandPlace(c, 'repaired');
    stats.layers.push({ y, slabs, cells: mine.length, hand: stats.hand - before.hand, command: stats.command - before.command });
  }

  for (let y = bd.y1; y <= bd.y2; y++) {
    stats.layer = y;
    await layer(y, false);
    if (after) { await after(y, stats); W = new Map(); }
    await hands.yield();
  }
  for (let y = bd.y1; y <= bd.y2; y++) { stats.layer = `slabs ${y}`; await layer(y, true); await hands.yield(); }
  // Tidy: a block of the hand kinds anywhere in (or just round) the farm where the plan has none (a held button that put down a second block before
  // it was let go, a slip of the hand) is taken out again. A layer of the box a tick.
  if (hands.clear) {
    stats.layer = 'tidy';
    const hand = handSet(plan.shell ?? 'cobblestone');
    for (let y = bd.y1; y <= bd.y2 + 2; y++) {
      hands.check();
      for (let x = bd.x1 - 2; x <= bd.x2 + 2; x++) for (let z = bd.z1 - 2; z <= bd.z2 + 2; z++) {
        const want = final.at(x, y, z)?.id;
        if (want && want !== 'air' && !/water/.test(want)) continue;
        const id = hands.blockAt({ x, y, z });
        if (id && (hand.has(id) || id.startsWith(SLAB)) && hands.clear({ x, y, z })) stats.strays++;
      }
      await hands.yield();
    }
  }
  stats.layer = 'slabs';
  if (after) { await after('slabs', stats); W = new Map(); }
  stats.ticks = hands.now() - t0;
  return stats;
}
