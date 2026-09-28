// Building the house where the trees are: plains, an ordinary forest, a dense dark-oak forest (2x2
// trunks, a low roof of leaves), a jungle edge (tall trunks, bushes on the ground). Bumps and dips
// in the ground, the odd puddle. Runs the game's own site choice (the rough height pass, then
// core/site.js siteWork/siteScore on the best 24, all four facings) and its build (homestead.js:
// count what's missing, fetch exactly that, plank the logs, clear the site top down, fill the dips,
// walls and roof), and checks the counting: does it ever run out halfway?
//
//   node tools/sim_house.mjs [N] [-v]
//   FIXCOUNT=0  the count as it was: anything solid where a wall or roof block goes (a trunk, low
//               leaves, a lump of dirt) counted as already built
import { siteWork, siteScore, BUILD_S } from '../behavior_pack/scripts/core/site.js';
import { blueprint, clearance, footing } from '../behavior_pack/scripts/core/house.js';
import { cheapestPlaceable, plankReserve } from '../behavior_pack/scripts/core/costs.js';
import { fittingsPlanks } from '../behavior_pack/scripts/core/settle.js';
import { isLog, isPlanks, TOOL_STONE, count } from '../behavior_pack/scripts/core/recipes.js';
import { houseMissing } from '../behavior_pack/scripts/core/house.js';
import { makeRng } from '../behavior_pack/scripts/core/mathutil.js';

const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 400);
const VERBOSE = process.argv.includes('-v');
const FIXCOUNT = process.env.FIXCOUNT !== '0';
// homestead.js's lists.
const SOFT = /^(air|short_grass|tall_grass|fern|large_fern|dead_bush|deadbush|snow_layer|vine|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|allium|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|bush|leaf_litter|wildflowers|pink_petals|short_dry_grass|tall_dry_grass)$/;
const DIGGABLE_SITE = /^(dirt|grass_block|coarse_dirt|podzol|sand|red_sand|gravel|snow|stone|andesite|diorite|granite|tuff|clay|mud)$/;
const NATURAL = /^(stone|dirt|grass_block|coarse_dirt|podzol|sand|gravel|clay|mud|andesite|diorite|granite)$/;

// ---------- the land ----------
const KINDS = {
  plains: { biome: 'plains', tree: 0.004, big: false, bush: 0 },
  forest: { biome: 'forest', tree: 0.045, big: false, bush: 0 },
  dense: { biome: 'dark_forest', tree: 0.075, big: true, bush: 0.01 },
  jungle: { biome: 'jungle_edge', tree: 0.035, big: false, tall: true, bush: 0.08 },
};
function makeWorld(kind, rng) {
  const K = KINDS[kind];
  const blocks = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const ph = [rng() * 6, rng() * 6, rng() * 6];
  const hRaw = (x, z) => 64 + Math.round(1.3 * Math.sin(x / 5.3 + ph[0]) + 1.1 * Math.cos(z / 4.1 + ph[1]) + 0.6 * Math.sin((x + z) / 2.3 + ph[2]));
  // Dips and puddles.
  const dips = new Map();
  for (let i = 0; i < 18; i++) { const x = Math.floor(rng() * 60 - 30), z = Math.floor(rng() * 60 - 30); dips.set(`${x},${z}`, rng() < 0.2 ? 'water' : 1 + Math.floor(rng() * 2)); }
  const H = (x, z) => { const d = dips.get(`${x},${z}`); return hRaw(x, z) - (typeof d === 'number' ? d : 0); };
  const set = (x, y, z, id, over = false) => { const k = key(x, y, z); if (over || !blocks.has(k) || /leaves$/.test(blocks.get(k))) blocks.set(k, id); };
  // Trees.
  for (let x = -34; x <= 34; x++) for (let z = -34; z <= 34; z++) {
    if (Math.abs(x) + Math.abs(z) < 2) continue; // not on the bot
    const r = rng();
    const g = H(x, z) + 1;
    if (dips.get(`${x},${z}`) === 'water') continue;
    if (r < K.tree) {
      if (K.big) {
        // Dark oak: a 2x2 trunk 6-8 high, a wide flat canopy from 4 up (a low roof of leaves).
        const top = g + 6 + Math.floor(rng() * 3);
        for (let y = g; y < top; y++) for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) set(x + a, y, z + b, 'dark_oak_log', true);
        for (let y = top - 3; y <= top; y++) {
          const rad = y === top ? 2 : 3;
          for (let a = -rad; a <= rad + 1; a++) for (let b = -rad; b <= rad + 1; b++) if (Math.hypot(a - 0.5, b - 0.5) <= rad + 0.3) set(x + a, y, z + b, 'dark_oak_leaves');
        }
      } else {
        const tall = K.tall && rng() < 0.4;
        const top = g + (tall ? 8 + Math.floor(rng() * 4) : 4 + Math.floor(rng() * 3));
        const log = K.tall ? 'jungle_log' : rng() < 0.3 ? 'birch_log' : 'oak_log';
        for (let y = g; y < top; y++) set(x, y, z, log, true);
        for (let y = top - 3; y <= top; y++) {
          const rad = y >= top - 1 ? 1 : 2;
          for (let a = -rad; a <= rad; a++) for (let b = -rad; b <= rad; b++) if (!(Math.abs(a) === rad && Math.abs(b) === rad && rng() < 0.6)) set(x + a, y, z + b, log.replace('_log', '_leaves'));
        }
      }
    } else if (r < K.tree + K.bush) {
      // A bush: leaves on the ground 1-2 high (jungle edge, dark forest floor).
      const hh = 1 + Math.floor(rng() * 2);
      for (let y = g; y < g + hh; y++) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (rng() < 0.7) set(x + a, y, z + b, 'oak_leaves');
    } else if (r < K.tree + K.bush + 0.25) set(x, g, z, 'short_grass');
  }
  const blockAt = (p) => {
    const b = blocks.get(key(p.x, p.y, p.z));
    if (b) return b;
    const g = H(p.x, p.z), d = dips.get(`${p.x},${p.z}`);
    if (d === 'water' && p.y === hRaw(p.x, p.z)) return 'water';
    if (p.y > g) return 'air';
    if (p.y === g) return 'grass_block';
    return p.y > g - 3 ? 'dirt' : 'stone';
  };
  const setAt = (p, id) => blocks.set(key(p.x, p.y, p.z), id);
  // homestead: groundTop skips trees (the top natural block).
  const groundTop = (x, z) => { for (let y = 90; y > 40; y--) if (NATURAL.test(blockAt({ x, y, z }))) return y; return -Infinity; };
  return { blockAt, setAt, groundTop, biome: K.biome };
}

// ---------- the game's site choice (homestead.findSite) ----------
function findSite(w, f, inv, secondsLeft) {
  const cands = [];
  for (let r = 0; r <= 20; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const x = f.x + dx, z = f.z + dz, g = w.groundTop(x, z);
    let work = 0, bad = false;
    for (let a = -2; a <= 2 && !bad; a++) for (let b = -2; b <= 2 && !bad; b++) { const h = w.groundTop(x + a, z + b); if (Math.abs(h - g) > 2) bad = true; else work += Math.abs(h - g); }
    if (!bad) cands.push({ x, y: g + 1, z, rough: work * 1.2 + r / 4.3 });
  }
  cands.sort((a, b) => a.rough - b.rough);
  let best = null;
  for (const c of cands.slice(0, 24)) for (const dir of ['south', 'north', 'east', 'west']) {
    const work = siteWork(siteCells(w, c, dir), inv);
    const score = siteScore(work, { dist: Math.hypot(c.x - f.x, c.z - f.z), biome: w.biome, secondsLeft });
    if (score < (best?.score ?? Infinity)) best = { ...c, dir, score, work };
  }
  return best && Number.isFinite(best.score) ? best : null;
}
function siteCells(w, o, dir) {
  const cells = clearance(o, dir).map((p) => ({ id: w.blockAt(p), part: 'clear' }));
  for (const p of footing(o, dir)) cells.push({ id: w.blockAt(p), part: 'foot', below: w.blockAt({ ...p, y: p.y - 1 }), below2: w.blockAt({ ...p, y: p.y - 2 }) });
  return cells;
}

// ---------- the game's count (homestead.houseNeedsNow) ----------
function houseNeeds(w, site, dir, inv, { fittings = false } = {}) {
  let stone = 0, planks = 0;
  // Old: missing = nothing solid there. New (core/house.js houseMissing): natural blocks and trees
  // in a wall's place are cleared first, so they're missing too.
  const missing = (p) => (FIXCOUNT ? houseMissing(w.blockAt(p)) : SOFT.test(w.blockAt(p)));
  for (const b of blueprint(site, dir)) if (missing(b)) b.material === 'stone' ? stone++ : planks++;
  for (const p of footing(site, dir)) if (SOFT.test(w.blockAt(p))) { stone++; if (SOFT.test(w.blockAt({ ...p, y: p.y - 1 }))) stone++; }
  const haveStone = count(inv, (id) => TOOL_STONE.has(id)), havePlanks = count(inv, isPlanks) + count(inv, isLog) * 4;
  const shortStone = Math.max(0, stone - haveStone), shortPlanks = Math.max(0, planks - havePlanks);
  const spare = Math.max(0, haveStone - stone) + Math.max(0, havePlanks - planks);
  const walls = shortStone + shortPlanks <= spare ? { stone: 0, planks: 0 } : { stone: shortStone, planks: shortPlanks };
  if (!fittings) return walls;
  const fitShort = Math.max(0, fittingsPlanks(inv) + 4 - Math.max(0, havePlanks - planks));
  return { stone: walls.stone, planks: walls.planks + fitShort };
}
const add = (inv, id, n = 1) => { inv[id] = (inv[id] ?? 0) + n; if (inv[id] <= 0) delete inv[id]; };
const logId = (inv) => Object.keys(inv).find(isLog);
const plankOf = (log) => log.replace(/_log$/, '_planks');
/** A trip for what's short: cobblestone from the quarry, logs from the trees (4 planks each). */
function fetch(inv, need) {
  if (need.stone) add(inv, 'cobblestone', need.stone);
  if (need.planks) add(inv, 'oak_log', Math.ceil(need.planks / 4));
}
/** homestead.plankUp: logs into planks for what's left of the plank blocks. */
function plankUp(w, site, dir, inv) {
  let left = 0;
  for (const b of blueprint(site, dir)) if (b.material === 'planks' && (FIXCOUNT ? houseMissing(w.blockAt(b)) : SOFT.test(w.blockAt(b)))) left++;
  while (count(inv, isPlanks) < left && logId(inv)) { const l = logId(inv); add(inv, l, -1); add(inv, plankOf(l), 4); }
}
function materialFor(inv, kind) {
  const pick = (pred) => Object.entries(inv).filter(([id]) => pred(id)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const stone = pick((id) => TOOL_STONE.has(id)), planks = pick(isPlanks);
  return kind === 'stone' ? stone ?? planks : planks ?? stone;
}

/** homestead.buildHouse, from "everything in hand" on. Returns { outOf, cleared: {logs, leaves, ground}, filled }. */
function build(w, site, dir, inv) {
  plankUp(w, site, dir, inv);
  const cleared = { logs: 0, leaves: 0, ground: 0 };
  for (const p of clearance(site, dir)) {
    const id = w.blockAt(p);
    if (id === 'air') continue;
    if (isLog(id)) { add(inv, id); cleared.logs++; } else if (/leaves$/.test(id)) cleared.leaves++;
    else if (DIGGABLE_SITE.test(id)) { add(inv, id === 'grass_block' ? 'dirt' : id === 'stone' ? 'cobblestone' : id); cleared.ground++; }
    else if (!SOFT.test(id)) continue;
    w.setAt(p, 'air');
  }
  let filled = 0;
  for (const p of footing(site, dir)) for (const q of [{ ...p, y: p.y - 1 }, p]) {
    if (!SOFT.test(w.blockAt(q))) continue;
    if (q.y < p.y && !SOFT.test(w.blockAt(p))) continue;
    const filler = cheapestPlaceable(inv, plankReserve(inv)) ?? materialFor(inv, 'stone');
    if (filler) { add(inv, filler, -1); w.setAt(q, filler); filled++; }
  }
  let outOf = 0;
  for (const b of blueprint(site, dir)) {
    if (!SOFT.test(w.blockAt(b))) continue;
    const id = materialFor(inv, b.material);
    if (!id) { outOf++; continue; }
    add(inv, id, -1); w.setAt(b, id);
  }
  return { outOf, cleared, filled };
}

// ---------- runs ----------
const rng = makeRng(20260928);
const byKind = {};
for (let i = 0; i < N; i++) {
  const kind = ['plains', 'forest', 'dense', 'jungle'][i % 4];
  const w = makeWorld(kind, rng);
  // What it tends to carry when the house comes up: cobblestone left from tools and the furnace,
  // a few logs and planks.
  const inv = {};
  add(inv, 'cobblestone', Math.floor(rng() * 20));
  add(inv, 'oak_log', Math.floor(rng() * 5));
  add(inv, 'oak_planks', Math.floor(rng() * 6));
  const secondsLeft = rng() < 0.25 ? 120 + rng() * 120 : Infinity; // some afternoons are short
  const f = { x: 0, z: 0 };
  const site = findSite(w, f, inv, secondsLeft);
  const o = (byKind[kind] ??= { n: 0, sites: 0, dist: 0, clearS: 0, logsCut: 0, leaves: 0, trips: 0, hiccup: 0, extraTrip: 0, short: 0, fittingsShort: 0, lateStart: 0 });
  o.n++;
  if (!site) { if (VERBOSE) console.log(`${kind} #${i}: no site`); continue; }
  o.sites++; o.dist += Math.hypot(site.x, site.z); o.clearS += site.work.seconds;
  if (site.work.seconds + BUILD_S > secondsLeft) o.lateStart++;
  // planHouse: the count with fittings, one trip for it.
  const need = houseNeeds(w, site, site.dir, inv, { fittings: true });
  if (need.stone || need.planks) { fetch(inv, need); o.trips++; }
  // buildHouse: "everything in hand before the first block goes down".
  const again = houseNeeds(w, site, site.dir, inv);
  if (again.stone || again.planks) { fetch(inv, again); o.trips++; }
  let r = build(w, site, site.dir, inv);
  o.logsCut += r.cleared.logs; o.leaves += r.cleared.leaves;
  if (r.outOf) {
    // "Ran out of blocks for the house": count again; if the logs cut while clearing cover it, the
    // next round planks them and finishes (a hiccup); else another trip first.
    o.short += r.outOf;
    const n2 = houseNeeds(w, site, site.dir, inv);
    if (n2.stone || n2.planks) { o.extraTrip++; fetch(inv, n2); } else o.hiccup++;
    r = build(w, site, site.dir, inv);
    if (r.outOf) console.log(`${kind} #${i}: still ${r.outOf} short after the second round`);
  }
  // The fittings (door, bed, table, chest) from what wood is left.
  const wood = count(inv, isPlanks) + count(inv, isLog) * 4;
  if (wood < fittingsPlanks({})) o.fittingsShort++;
  if (VERBOSE) console.log(`${kind} #${i}: site ${site.x},${site.z} ${site.dir}, ${site.work.seconds.toFixed(0)} s to clear (${r.cleared.logs} logs), short ${r.outOf}, wood left ${wood}`);
}
console.log(`${N} houses (${FIXCOUNT ? 'natural blocks in a wall\'s place counted as missing' : 'the old count'}):`);
console.log(`  ${'land'.padEnd(8)} site  walk  clear   logs cut  trips  ran out mid-build (blocks)   then: carried on / another trip   fittings short  couldn't finish by dusk`);
for (const [k, o] of Object.entries(byKind)) {
  const s = o.sites || 1;
  console.log(`  ${k.padEnd(8)} ${String(o.sites).padStart(3)}/${o.n}  ${(o.dist / s).toFixed(1).padStart(4)}  ${(o.clearS / s).toFixed(0).padStart(4)} s  ${(o.logsCut / s).toFixed(1).padStart(7)}  ${((o.trips) / s).toFixed(2).padStart(5)}  ${String(o.hiccup + o.extraTrip).padStart(8)} (${o.short})${' '.repeat(12)}${String(o.hiccup).padStart(3)} / ${o.extraTrip}${' '.repeat(22)}${o.fittingsShort}${' '.repeat(15)}${o.lateStart}`);
}
