// The bot's own build of the iron farm (game/farmbuild.js): which blocks it places by hand, where it stands for each, in what order, and what it
// leaves to commands. Pure: the world is behind a `hands` object, so tests/farmbuild.test.js runs the whole build against a fake world that keeps
// the rules a player is under (a block goes only against a solid neighbour, only on the side the eye is on, only within reach of where the bot
// stands, only from a spot that is solid underfoot with room to head height) and checks that what is left standing is the plan.
//
// What the bot places: the shell (dirt), the glass of the window, the composters, the slabs: nearly every block of the farm. What it does not: beds,
// hoppers, chests, signs, gates, the door, torches, campfires, lava, water, villagers. Those take a particular state (which way a bed or a hopper
// faces, a gate open, a sign on its wall, a campfire lit) and the project has always set them with commands (game/ironfarm_parts.js).
//
// The bot goes to a spot (u217: on its own feet, walking, jumping up onto the course it has just laid, dropping down, pillaring or bridging with a
// block of the shell where there is nothing to stand on; never teleported) and places every cell that is in reach and has something solid beside it
// to click; then it goes to the next. A spot is a cell with room for the bot and a full block under it (or, failing that, one it can make a floor
// for), with the most unplaced cells of the layer in reach, near where it is, and not in the air the farm closes in. If it has walled itself in, it
// breaks its way out and the blocks it broke are put back by hand. Each layer ends with the bot taking its scaffolding down. A block with nowhere at
// all to stand to place it is set by command and counted. u218: a spot it cannot get to, or a block that will not go down, is not handed to a command:
// it tries another spot, leaves the block for later in the layer and comes back to it (three rounds, the spots it failed to reach forgotten between
// rounds); only what is still not down after that is set by command, counted and named in the report. Only hands that never work at all (nothing
// down in two dozen tries) or the time cap hand the rest over.
import { render, outsideAir } from './ironfarm_grid.js';
import { SLAB } from './ironfarm_geo.js';

export const REACH = 4.0;          // (the game's is 4.5: a margin for where in the cell the eye is)
export const EYE = 1.52;
export const JUDGE_AFTER = 24;     // hand attempts before the hit rate is judged
export const ROUNDS = 5;           // passes over a layer's leftovers (blocks it could not get to or that would not go down) before a command does them
export const TRIES = 3;
export const SCAFFOLD_COST = 200;  // a block of scaffolding to stand on (u220: it pillared where it could have stayed put)
export const ENCLOSED_COST = 400;
export const PEND_COST = 20;       // a spot in a cell the layer still has to fill (u232: standing where the next block goes)
export const LOW_COST = 200;        // per level its feet are below the course it lays (u224)
export const CLIMB_COST = 100;     // a spot it cannot walk to from where it is: a climb (u222)  // a spot in air the farm closes in (the pod, the room, the shaft)            // spots tried for one block in a pass before it is left for the next pass

const key = (x, y, z) => `${x},${y},${z}`;
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const BELOW = [[0, -1, 0]];
/** What the bot walks through (and a block can be put into): no collision. */
export const FREE = new Set(['air', 'wall_sign', 'torch', 'fence_gate', 'water', 'flowing_water', 'lava']);
/** What the bot can stand on (full blocks it can also click against). */
// (not a composter: its top is a bowl it sinks into, and then every route starts inside a block (u229 live: it stood in the pod's wall
// composters, could not get out, and fell off the wall))
export const STAND_ON = new Set(['dirt', 'cobblestone', 'stone', 'smooth_stone', 'glass', 'grass_block']);
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
  const dx = s.x + 0.5 - (t.x + 0.5), dy = s.y + (s.up ?? 0) + EYE - (t.y + 0.5), dz = s.z + 0.5 - (t.z + 0.5);
  return dx * dx + dy * dy + dz * dz <= REACH * REACH;
}

/** Is the eye, standing at s, on the open side of the face of neighbour n that looks toward cell t? (You cannot click a face you are behind.) */
export function facing(s, t, n) {
  const e = { x: s.x + 0.5, y: s.y + (s.up ?? 0) + EYE, z: s.z + 0.5 };
  const nx = t.x - n.x, ny = t.y - n.y, nz = t.z - n.z;   // the face's outward normal
  const fc = { x: n.x + 0.5 + nx * 0.5, y: n.y + 0.5 + ny * 0.5, z: n.z + 0.5 + nz * 0.5 };
  return (e.x - fc.x) * nx + (e.y - fc.y) * ny + (e.z - fc.z) * nz > 0.05;
}

/**
 * A cell beside the block the bot stands on, at that block's level: a player puts it against the side of the block under its feet, crouched at the
 * edge with the eye out over it (bridging). (u220: the floors of the pod and the platform were laid from scaffolding under them instead.)
 */
export function edge(s, t) {
  return t.y === s.y - 1 && Math.abs(t.x - s.x) + Math.abs(t.z - s.z) === 1;
}

/** The counts a build keeps (pass your own to runBuild to read them while it runs). */
export const newStats = () => ({
  cells: 0, hand: 0, command: 0, already: 0, footing: 0, fallback: 0, repaired: 0, gaveUp: '', standMoves: 0, standFails: 0, attempts: 0, hits: 0, handTicks: 0, ticks: 0, strays: 0,
  broken: 0, putBack: 0,
  layer: /** @type {number|string|null} */ (null),
  handById: /** @type {Record<string, number>} */ ({}), commandById: /** @type {Record<string, number>} */ ({}), layers: /** @type {any[]} */ ([]),
});

/**
 * The straight run of cells of `T` through c (along x or along z, whichever is longer), ordered from the end nearer `from` to the other: a line as a
 * player lays it. (u220)
 */
export function lineThrough(T, c, from) {
  const runs = [[1, 0], [0, 1]].map(([dx, dz]) => {
    const out = [c];
    for (let i = 1; T.has(key(c.x + dx * i, c.y, c.z + dz * i)); i++) out.push(T.get(key(c.x + dx * i, c.y, c.z + dz * i)));
    for (let i = 1; T.has(key(c.x - dx * i, c.y, c.z - dz * i)); i++) out.unshift(T.get(key(c.x - dx * i, c.y, c.z - dz * i)));
    return out;
  });
  const run = runs[0].length >= runs[1].length ? runs[0] : runs[1];
  if (from) {
    const d = (q) => Math.abs(q.x - from.x) + Math.abs(q.z - from.z);
    if (d(run[run.length - 1]) < d(run[0])) run.reverse();
  }
  return run;
}

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
 * @param {any} plan @param {any} hands @param {{ after?: (y: number|string, stats: any) => Promise<void>, maxTicks?: number, stats?: any, avoid?: Set<string> }} [opts]
 */
export async function runBuild(plan, hands, { after = null, maxTicks = Infinity, stats = newStats(), avoid = new Set() } = {}) {
  const { cells, final } = splitPlan(plan);
  const finalId = new Map(cells.map((c) => [key(c.x, c.y, c.z), c.id]));
  const bd = plan.bounds;
  const shellId = plan.shell ?? 'cobblestone';
  // (u231, the player: "when making the line with the composters it walks on top of where it's going to place": the gap a part (a composter,
  // a bed, a hopper, a chest) waits in is no place to stand, nor the cell over it.)
  const handIds = handSet(shellId);
  const partAt = new Set();
  for (const [k, v] of final.cells) if (v.id !== 'air' && !handIds.has(v.id) && !/water|lava|torch|sign|gate/.test(v.id)) partAt.add(k);
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
    if (hands.set(c, id)) {
      W.set(key(c.x, c.y, c.z), id); stats.command++; bump(stats.commandById, id); if (why) stats[why]++;
      hands.note?.(`COMMAND ${id} at ${c.x} ${c.y} ${c.z} (${why || 'set'}), layer ${stats.layer}, bot at ${JSON.stringify(hands.where())}`);
      return true;
    }
    return false;
  };
  // (A slab goes only on the top of the block under it: clicked on a side face's upper half it would be a top slab, on which mobs spawn.)
  const dirsOf = (c) => (c.id === SLAB ? BELOW : DIRS);
  /** The cells of the layer being laid (and any carried up into it): one with one of them under it waits for it (u228). */
  let curT = new Map();
  const waitsBelow = (c) => curT.has(key(c.x, c.y - 1, c.z));
  const supportedNow = (c) => FREE.has(idAt(c.x, c.y, c.z)) && !waitsBelow(c) && dirsOf(c).some(([a, b, d]) => clickable(idAt(c.x + a, c.y + b, c.z + d)));
  /** Placeable from s right now: in reach, free, and some neighbour to click that has the eye on its open side. */
  const placeableFrom = (s, c) => {
    if (!reaches(s, c)) return false;
    if (!FREE.has(idAt(c.x, c.y, c.z))) return false;   // (something there already: scaffolding of its own, taken down at the end)
    if (waitsBelow(c)) return false;
    if (!s.up && c.id !== SLAB && edge(s, c) && clickable(idAt(s.x, s.y - 1, s.z))) return true;
    if (c.x === s.x && c.z === s.z && (c.y === s.y || c.y === s.y + 1 || (s.up && c.y === s.y + 2))) return false;
    return dirsOf(c).some(([a, b, d]) => { const n = { x: c.x + a, y: c.y + b, z: c.z + d }; return clickable(idAt(n.x, n.y, n.z)) && facing(s, c, n); });
  };

  // Air the finished farm closes in (the pod, the room, the shaft, the hallway): a spot there is taken only when there is no other, since the bot could
  // wall itself in (it then breaks its way out and puts the block back, but a player would not stand there to start with).
  const enclosed = (() => {
    const out = outsideAir(final, bd), s = new Set();
    for (let x = bd.x1; x <= bd.x2; x++) for (let y = bd.y1; y <= bd.y2; y++) for (let z = bd.z1; z <= bd.z2; z++) {
      const k = key(x, y, z);
      if (!out.has(k) && !final.cells.has(k)) s.add(k);
    }
    return s;
  })();
  /**
   * The best spot to stand to place c: c placeable from it, the most of `near` in reach, near where the bot is (it walks there), not in the farm's
   * closed-in air; with `scaffold`, also a spot with nothing under it yet (the bot pillars or bridges to it with a block of the shell), at a cost.
   * null if there is none.
   */
  // Where the bot can walk to from where it is (u222, the player: "it created a pillar it didn't need, then went back to remove it and pillared
  // again to get back up"): spots with room and a floor, one block up with a jump or down a drop of up to three, round the bot. A spot it cannot
  // walk to costs as much as a pillar, so it builds from where its feet already take it.
  let reach = null, reachFrom = '';
  const standable = (x, y, z) => FREE.has(idAt(x, y, z)) && FREE.has(idAt(x, y + 1, z)) && STAND_ON.has(idAt(x, y - 1, z))
    // (or on a bottom slab in that cell, half a block up: it walks over the slabs it has laid)
    || (idAt(x, y, z) === SLAB && FREE.has(idAt(x, y + 1, z)) && FREE.has(idAt(x, y + 2, z)));
  const walkable = (from) => {
    const k0 = from ? key(from.x, from.y, from.z) : '';
    if (reach && reachFrom === k0) return reach;
    const seen = new Set();
    if (from) {
      const q = [from];
      seen.add(k0);
      for (let i = 0; i < q.length && seen.size < 6000; i++) {
        const c = q[i];
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (let dy = 1; dy >= -3; dy--) {
            const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
            if (Math.abs(n.x - from.x) > 12 || Math.abs(n.z - from.z) > 12 || Math.abs(n.y - from.y) > 8) continue;
            if (dy === 1 && !FREE.has(idAt(c.x, c.y + 2, c.z))) continue;   // (head room for the jump)
            if (dy < 0 && !(FREE.has(idAt(n.x, c.y, n.z)) && FREE.has(idAt(n.x, c.y + 1, n.z)))) continue;   // (the way over the edge)
            if (!standable(n.x, n.y, n.z) || avoid.has(key(n.x, n.y, n.z)) || avoid.has(key(n.x, n.y - 1, n.z))) continue;
            const k = key(n.x, n.y, n.z);
            if (!seen.has(k)) { seen.add(k); q.push(n); }
            break;
          }
        }
      }
    }
    reach = seen; reachFrom = k0;
    return seen;
  };
  /** Spots the bot could not get to in this pass over the layer (u218): not offered again until the next pass. */
  let unreachable = new Set();
  const bestStand = (c, near, from, { scaffold = false } = {}) => {
    let best = null, bestScore = -Infinity;
    for (let dy = -3; dy <= 2; dy++) {
      const sy = c.y + dy;
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        const s = { x: c.x + dx, y: sy, z: c.z + dz };
        if (unreachable.has(key(s.x, sy, s.z))) continue;
        if (avoid.has(key(s.x, sy, s.z)) || avoid.has(key(s.x, sy + 1, s.z)) || avoid.has(key(s.x, sy - 1, s.z))) continue;   // (the beds' cells, u223)
        if ((partAt.has(key(s.x, sy, s.z)) || partAt.has(key(s.x, sy + 1, s.z))) && FREE.has(idAt(s.x, sy, s.z))) continue;   // (a part's empty cell, u231)
        // (u224: on a bottom slab it has laid, half a block up, as a player walks the rim it has slabbed)
        if (idAt(s.x, sy, s.z) === SLAB && FREE.has(idAt(s.x, sy + 1, s.z)) && FREE.has(idAt(s.x, sy + 2, s.z))) s.up = 0.5;
        else if (!FREE.has(idAt(s.x, sy, s.z)) || !FREE.has(idAt(s.x, sy + 1, s.z))) continue;
        const under = idAt(s.x, sy - 1, s.z);
        let cost = 0;
        if (!s.up && !STAND_ON.has(under)) {
          if (!scaffold || under !== 'air') continue;
          // (A floor to make: one block under it, bridged from a neighbour that is solid, or a short pillar from what is below.)
          let h = 1;
          while (h <= 4 && idAt(s.x, sy - 1 - h, s.z) === 'air') h++;
          const side = DIRS.some(([a, b, d]) => b === 0 && clickable(idAt(s.x + a, sy - 1, s.z + d)));
          if (!side && h > 4) continue;
          // (Never scaffolding in a cell the farm wants something else in: a composter, the glass, a slab, a bed, a chest.)
          let clash = false;
          for (let i = 1; i <= (side ? 1 : h); i++) { const w = final.at(s.x, sy - i, s.z)?.id; if (w && w !== 'air' && w !== shellId) clash = true; }
          if (clash) continue;
          cost = side ? SCAFFOLD_COST : SCAFFOLD_COST * h;
        }
        if (!placeableFrom(s, c)) continue;
        // (not a spot its feet take it to from here: a climb it would have to pillar for)
        if (!cost && from && !walkable(from).has(key(s.x, sy, s.z))) cost = CLIMB_COST;
        let n = 0;
        for (const t of near) if (reaches(s, t) && !(t.x === s.x && t.z === s.z && (t.y === s.y || t.y === s.y + 1))) n++;
        // (u220, the player's way: stay up on what it has built and carry on from there. A spot on the farm's own blocks, near, not lower than
        // where it is (down is a climb back up later), no scaffolding unless there is nothing else: each of those weighs more than covering a few
        // more blocks of the line from one spot.)
        const walk = from ? Math.abs(s.x - from.x) + Math.abs(s.z - from.z) + Math.abs(s.y - from.y) * 2 : 0;
        const down = from && sy < from.y ? from.y - sy : 0;
        const onBuild = final.cells.has(key(s.x, sy - 1, s.z)) && !cost ? 1 : 0;
        // (u224: up on the course below the one it lays, feet level with it, not under it: from below, the next layer up is out of a jump's
        // reach and it pillars to it.)
        const low = sy < c.y ? (c.y - sy) * LOW_COST : 0;
        const pend = curT.has(key(s.x, sy, s.z)) || curT.has(key(s.x, sy + 1, s.z)) ? PEND_COST : 0;
        const score = n * 40 - pend - Math.abs(dx) - Math.abs(dz) - walk * 6 - down * 60 - cost + onBuild * 20 - low - (enclosed.has(key(s.x, s.y, s.z)) ? ENCLOSED_COST : 0);
        if (score > bestScore) { bestScore = score; best = s; }
      }
    }
    return best;
  };

  // (u218: only hands that do not work at all, or the time cap, hand the rest to commands; a low hit rate or a slow hand is retried, not replaced.)
  const judge = () => {
    if (stats.gaveUp) return;
    if (hands.now() - t0 > maxTicks) { stats.gaveUp = 'out of time'; return; }
    if (stats.attempts >= JUDGE_AFTER && stats.hits === 0) stats.gaveUp = `only ${stats.hits} of ${stats.attempts} went down by hand`;
    else if (stats.standFails >= JUDGE_AFTER && stats.standMoves === 0) stats.gaveUp = `the bot could not be put on any of ${stats.standFails} spots`;
    if (stats.gaveUp) hands.say(`Placing by hand is not working at all (${stats.gaveUp}): the rest I set with commands.`);
  };

  /** Hand cells the bot broke to get out of somewhere (stand reports them): put back by hand in the layer it is on. */
  const redo = new Map();
  /** Put the bot on s (walking, climbing, bridging: the hands decide how). True when it is there; what it broke on the way is queued to put back. */
  /**
   * `climb`: may it pillar, bridge or dig to get there (u223: only for a spot that needs it (nothing under it yet), or on a later pass over a layer's
   * leftovers; a plain spot its feet do not take it to is given up at once and another one tried, not pillared to).
   */
  const goStand = async (s, climb = false) => {
    const r = await hands.stand(s, { climb });
    const ok = typeof r === 'object' ? !!r?.ok : !!r;
    for (const c of (typeof r === 'object' && r?.broke) || []) {
      const id = finalId.get(key(c.x, c.y, c.z));
      if (id) { redo.set(key(c.x, c.y, c.z), { x: c.x, y: c.y, z: c.z, id }); stats.broken++; }
    }
    W = new Map();   // (it walked, climbed or broke its way: what the cache knew may have changed)
    reach = null;
    return ok;
  };

  /** One layer's cells (those not there yet), by hand where it can be. */
  /**
   * u228: blocks of a layer it cannot get to on foot (the top course of the shaft inside the three-high pod, once it is up on the pod's walls) are
   * carried up into the next layer and laid from it (from the pod's roof as it bridges in over them), not climbed to or set by command; only the
   * top layer climbs or commands. Returns what it carries up.
   */
  async function layer(y, slabs, carried = []) {
    const mine = [...cells.filter((c) => c.y === y && (c.id === SLAB) === slabs), ...carried];
    const canCarry = !slabs && y < bd.y2;
    const carryOut = [];
    /** Blocks that would not go down by hand (as against spots it could not get to): those are not carried up, u228. */
    const handMissed = new Set();
    W = new Map();
    const T = new Map();
    curT = T;
    for (const c of mine) { if (idAt(c.x, c.y, c.z) === c.id) stats.already++; else T.set(key(c.x, c.y, c.z), c); }
    if (!T.size) return carryOut;
    const before = { hand: stats.hand, command: stats.command };
    const need = {};
    for (const c of T.values()) bump(need, c.id);
    for (const [id, n] of Object.entries(need)) hands.stock(id, n);
    const back = [];
    const takeRedo = () => {
      for (const [k, c] of redo) { if (!T.has(k)) { T.set(k, c); back.push(c); hands.stock(c.id, 1 + (need[c.id] ?? 0)); } }
      redo.clear();
    };
    // (u218) A block it could not get a spot for, or that would not go down, is tried again from elsewhere; after TRIES it waits for the next pass
    // (`later`), when the spots it failed to reach are forgotten (it may have built its way to them since). After ROUNDS passes, a command.
    const later = new Map();
    let tried = new Map();
    const fail = (c) => {
      const k = key(c.x, c.y, c.z), n = (tried.get(k) ?? 0) + 1;
      tried.set(k, n);
      if (n >= TRIES) { T.delete(k); later.set(k, c); }
    };
    // Cells its own scaffolding stands in: the right block already (kept, its own hand put it there), or a block in the way, which waits for the tidy.
    const blocked = new Map();
    let forced = 0;
    const settle = () => {
      for (const [k, c] of T) {
        const now = idAt(c.x, c.y, c.z);
        if (now === c.id) { T.delete(k); stats.hand++; bump(stats.handById, c.id); }
        else if (!FREE.has(now) && now !== 'unloaded') { T.delete(k); blocked.set(k, c); }
      }
    };
    unreachable = new Set();
    for (let pass = 0; pass < 2; pass++) {
    if (pass) {
      // The second pass: just the blocks of its own in the way taken out (u222: not all its scaffolding, which sent it down for its pillars and up
      // on new ones), and those cells built.
      for (const c of blocked.values()) { if (hands.unblock) await hands.unblock(c); else if (hands.tidy) { await hands.tidy(); break; } }
      W = new Map(); reach = null;
      for (const [k, c] of blocked) T.set(k, c);
      blocked.clear();
      if (!T.size) break;
    }
    for (let round = 0; ; round++) {
      takeRedo();
      let guard = 0;
      const cap = (T.size + back.length) * (TRIES + 2) + 40;
      /** The run of blocks it is laying (u220: in lines, as a player lays a course, not whatever is in reach all round). */
      let line = null;
      while (T.size) {
        hands.check();
        takeRedo();
        if (++guard > cap) throw new Error(`the build loop did not end on layer ${y}`);
        settle();
        if (!T.size) break;
        if (stats.gaveUp) { for (const c of [...T.values(), ...later.values(), ...blocked.values()]) commandPlace(c, 'fallback'); T.clear(); later.clear(); blocked.clear(); break; }
        const here = hands.where();
        let climbNow = false;
        // The next block: the next one of the line it is laying; else the start of a new line, at the block with something to click nearest to
        // where the bot is (so one line leads on to the next round a corner).
        let c0 = null;
        if (line) {
          line = line.filter((c) => T.has(key(c.x, c.y, c.z)));
          c0 = line.find((c) => supportedNow(c)) ?? null;
          if (!c0) line = null;
        }
        if (!c0) {
          // (u227 live: the nearest block with something to click was often one it could only get to over open air (the far wall of the pod from
          // the shaft's top), so it asked for spot after spot it could not walk to. The nearest few are tried for one it can walk to a spot for.)
          const cand = [];
          for (const c of T.values()) {
            if (!supportedNow(c)) continue;
            cand.push({ c, d: here ? Math.hypot(c.x - here.x, (c.y - here.y) * 2, c.z - here.z) : 0 });
          }
          cand.sort((a, b) => a.d - b.d);
          const reachHere = here ? walkable(here) : null;
          for (const { c } of cand.slice(0, 16)) {
            const st = bestStand(c, [c], here);
            if (st && (!reachHere || reachHere.has(key(st.x, st.y, st.z)))) { c0 = c; break; }
          }
          // (none of those from where it can walk: if the layer can carry them up, the rest that can be clicked are left for later at once, without
          // asking for spots it cannot reach, u228)
          // (u229 live: from the pad at the start, 14 blocks off, every block of the first layer was "out of reach" of its 12-block look round and
          // all of it went up a layer. Only when they are all close to it and it is up at the layer, not fallen off below it.)
          const close = here && cand.every(({ c }) => Math.abs(c.x - here.x) <= 9 && Math.abs(c.z - here.z) <= 9 && Math.abs(c.y - here.y) <= 3);
          const stranded = !c0 && cand.length && reachHere && !cand.slice(16).some(({ c }) => { const st = bestStand(c, [c], here); return st && reachHere.has(key(st.x, st.y, st.z)); });
          // (u230 live: stranded on the shaft's top in the middle of the pod, it carried the whole top course of the pod's walls up; the platform
          // floor then had nothing to rest on and went in by command a block at a time, a checkerboard. Carried up only when it is all that is
          // left of the layer and a small part of it; otherwise it climbs over to the rest, as a player would.)
          if (stranded && canCarry && close && cand.length === T.size && cand.length * 3 <= mine.length) {
            for (const { c } of cand) { tried.set(key(c.x, c.y, c.z), TRIES - 1); fail(c); }
            continue;
          }
          if (stranded) climbNow = true;
          if (!c0 && cand.length) c0 = cand[0].c;
          if (c0) { line = lineThrough(T, c0, here); c0 = line.find((c) => supportedNow(c)) ?? c0; }
        }
        if (!c0) {
          // Nothing to click against: if what is left for later is what it rests on, the next pass first; else the first block by command.
          if (later.size || blocked.size) break;
          let first = null, df = Infinity;
          for (const c of T.values()) { const d = here ? Math.hypot(c.x - here.x, c.y - here.y, c.z - here.z) : c.y; if (d < df) { df = d; first = c; } }
          commandPlace(first, 'footing'); T.delete(key(first.x, first.y, first.z));
          continue;
        }
        const near = line && line.length ? line.slice(line.indexOf(c0)) : [c0];
        // (scaffolding only when there is no plain spot at all, not when the plain ones are ones it failed to reach this pass, u228)
        const s = bestStand(c0, near, here) ?? (unreachable.size && canCarry ? null : bestStand(c0, near, here, { scaffold: true }));
        if (!s) {
          // No spot left to try: for later if it failed to reach some this pass, else there is none at all and a command sets it (a footing).
          if (unreachable.size) { tried.set(key(c0.x, c0.y, c0.z), TRIES - 1); fail(c0); continue; }
          commandPlace(c0, 'footing'); T.delete(key(c0.x, c0.y, c0.z));
          await hands.yield();
          continue;
        }
        if (here && STAND_ON.has(idAt(s.x, s.y - 1, s.z)) && !walkable(here).has(key(s.x, s.y, s.z))) stats.climbs = (stats.climbs ?? 0) + 1;
        // (u225: climbing only on the last pass over the leftovers, or to a spot with nothing under it yet; the earlier passes find another spot on foot)
        // (climbing: on the last pass of the top layer, to a spot with nothing under it yet, or when it has fallen off well below the layer it
        // is laying (u229 live: it fell off the pod's wall to the pad, nine down, and could only get back up by climbing))
        const fallen = !!here && here.y < y - 3;
        if (!(await goStand(s, climbNow || fallen || round + 1 >= ROUNDS || (!s.up && !STAND_ON.has(idAt(s.x, s.y - 1, s.z)))))) {
          stats.standFails++;
          unreachable.add(key(s.x, s.y, s.z));
          fail(c0);
          judge();
          await hands.yield();
          continue;
        }
        stats.standMoves++;
        // Along the line from this spot, in order, as far as it reaches (one that would not go down is tried again later; the cell it stands in
        // is skipped and comes round again once it has moved on).
        const missed = new Set();
        const tryPlace = async (k) => {
          const now = hands.where();
          if (now && (now.x !== s.x || now.y !== s.y || now.z !== s.z)) { if (!(await goStand(s))) return false; stats.standMoves++; }
          const id = finalId.get(key(k.x, k.y, k.z));
          stats.attempts++;
          const a = hands.now();
          let ok = await hands.place(k, id);
          if (!ok) ok = await hands.place(k, id);
          stats.handTicks += hands.now() - a;
          if (ok) {
            T.delete(key(k.x, k.y, k.z));
            stats.hand++; stats.hits++; bump(stats.handById, id); W.set(key(k.x, k.y, k.z), id); reach = null; if (back.includes(k)) stats.putBack++;
          } else { missed.add(key(k.x, k.y, k.z)); handMissed.add(key(k.x, k.y, k.z)); stats.misses = (stats.misses ?? 0) + 1; fail(k); W = new Map(); }
          judge();
          return true;
        };
        // (u232 live: a row of slabs laid nearest-first, each one just laid hid the face of the next from the eye ("no line to the Up face", 236 tries
        // at the room's roof). Slabs go farthest-first from the spot, back toward it, as a player lays a row of them walking backward.)
        const farFirst = c0.id === SLAB;
        const dist = (t) => Math.hypot(t.x - s.x, t.z - s.z) + Math.abs(t.y - s.y) * 0.5;
        const order = farFirst ? [...(line ?? [c0])].sort((a, b) => dist(b) - dist(a)) : (line ?? [c0]);
        let at = farFirst ? 0 : Math.max(0, order.indexOf(c0));
        for (let inner = 0; inner < 400; inner++) {
          hands.check();
          let k = null;
          while (at < order.length) {
            const t = order[at];
            if (!T.has(key(t.x, t.y, t.z)) || missed.has(key(t.x, t.y, t.z))) { at++; continue; }
            if (t.x === s.x && t.z === s.z && (t.y === s.y || t.y === s.y + 1)) { at++; continue; }
            if (placeableFrom(s, t)) { k = t; break; }
            if (farFirst) { at++; continue; }
            break;
          }
          if (!k) break;
          if (!(await tryPlace(k))) break;
          if (stats.gaveUp) break;
          if (inner % 8 === 7) await hands.yield();
        }
        // (u232, the player: "it places them so inefficiently it has to come back"): everything else of the layer in reach from this spot, with a
        // line to a face, is put down while it is here, not only the line it was laying.
        let last = order.length ? order[Math.min(at, order.length - 1)] : c0;
        for (;;) {
          if (stats.gaveUp) break;
          let pick = null, pd = Infinity;
          for (const t of T.values()) {
            const tk = key(t.x, t.y, t.z);
            if (missed.has(tk) || tk === key(c0.x, c0.y, c0.z)) continue;
            if (t.x === s.x && t.z === s.z && (t.y === s.y || t.y === s.y + 1)) continue;
            const near = Math.abs(t.x - last.x) + Math.abs(t.y - last.y) * 2 + Math.abs(t.z - last.z);
            const slabFar = farFirst && t.id === SLAB;
            const d = slabFar ? -dist(t) : near;
            if (d >= pd || (!slabFar && near > 3) || !supportedNow(t) || !placeableFrom(s, t)) continue;
            pick = t; pd = d;
          }
          if (!pick) break;
          hands.check();
          if (!(await tryPlace(pick))) break;
          last = pick;
        }
        // c0 itself should have gone (it was placeable from s): if not, it counts as a try from here.
        if (T.has(key(c0.x, c0.y, c0.z)) && !missed.has(key(c0.x, c0.y, c0.z))) fail(c0);
      }
      if (!later.size) break;
      if (round + 1 >= ROUNDS) {
        const lowNow = hands.where();
        const up = canCarry && !(lowNow && lowNow.y < y - 3) ? [...later.values()].filter((c) => !handMissed.has(key(c.x, c.y, c.z))) : [];
        if (up.length) { for (const c of up) carryOut.push(c); stats.carried = (stats.carried ?? 0) + up.length; hands.note?.(`CARRY ${up.length} of layer ${y} up to the next: ${up.map((c) => `${c.x} ${c.y} ${c.z}`).join(', ')}`); }
        const upK = new Set(up.map((c) => key(c.x, c.y, c.z)));
        for (const c of later.values()) if (!upK.has(key(c.x, c.y, c.z))) { commandPlace(c, 'fallback'); forced++; }
        later.clear();
        if (!T.size) break;
        continue;   // (what was waiting on them)
      }
      for (const [k, c] of later) T.set(k, c);
      later.clear();
      tried = new Map();
      unreachable = new Set();
      W = new Map();
    }
    }
    if (forced) hands.say(`${forced} blocks of layer ${y}${slabs ? ' (slabs)' : ''} would not go down by hand after ${ROUNDS} passes: set by command.`);
    // Read it all back: whatever is not there is set. Then the bot's scaffolding comes down (by its own hand).
    W = new Map();
    const out = new Set(carryOut.map((c) => key(c.x, c.y, c.z)));
    for (const c of [...mine, ...back]) if (!out.has(key(c.x, c.y, c.z)) && idAt(c.x, c.y, c.z) !== c.id) commandPlace(c, 'repaired');
    stats.layers.push({ y, slabs, cells: mine.length, hand: stats.hand - before.hand, command: stats.command - before.command });
    curT = new Map();
    return carryOut;
  }

  // Layer by layer, each one's slabs with it (u224, the player: "it didn't remember the layer when it was at that layer": the slabs on the room's
  // roof left to the end meant a trip back down from the top of the platform, pillars and all). It walks over the slabs it has laid.
  let carry = [];
  for (let y = bd.y1; y <= bd.y2; y++) {
    stats.layer = y;
    carry = await layer(y, false, carry);
    stats.layer = `slabs ${y}`;
    await layer(y, true);
    if (after) { await after(y, stats); W = new Map(); }
    await hands.yield();
  }
  // Its scaffolding down, once, at the end (u220: not after every layer, which sent it back down the hole for its pillars and up again on new
  // ones; it reuses what it put up as it goes).
  if (hands.tidy) { stats.layer = 'scaffolding'; await hands.tidy(); }
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
