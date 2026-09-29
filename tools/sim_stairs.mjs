// The quarry stairs blown to pieces (several creeper blasts, the entrance at the top among them):
// does the bot get out quickly, the one way, and is that way still there next trip? Runs
// game/skills.js's own walkShaft / rebuildStairs / putTread / leaveQuarry / rebuildEntrance against
// a block world: a 1-wide staircase from the surface (feet at Y 64) 40 steps down, stone under dirt.
// Placing needs a solid face to place against, as in the game; moving is checked block by block
// (a step up or down at most, feet and head clear, something under us).
//
//   old  what the game did: stuck on the stairs, past the damage a few steps at a time with
//        dig-and-build searches (pastDamage); still stuck, a search for any way to the surface
//   new  the stairs put back as they were, step by step (rebuildStairs), a tread on a block or two
//        when the crater took what it goes against (putTread); out of the top into a crater: one
//        way on up, added to the stairs (rebuildEntrance)
//
// Counts: got out, searches run (each a dig-and-build path search: the "standing there thinking"),
// blocks dug off the stairs' line (new holes), and whether the next trip down and up is a plain walk.
//
//   node tools/sim_stairs.mjs [N] [-v]      OLD=1: the old way only
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Skills } = await import('../behavior_pack/scripts/game/skills.js');
const { findPath, Cell } = await import('../behavior_pack/scripts/core/pathfinder.js');
const { makeRng } = await import('../behavior_pack/scripts/core/mathutil.js');
const { system, ItemStack, Container } = MC;

const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 200);
const VERBOSE = process.argv.includes('-v');
const TOP = 64, STEPS = 40;
const key = (x, y, z) => `${x},${y},${z}`;
const stand = (i) => ({ x: i, y: TOP - i, z: 0 });

function makeWorld() {
  const over = new Map(); // "x,y,z" -> id
  for (let i = 0; i <= STEPS; i++) for (let h = 0; h < 3; h++) over.set(key(i, TOP - i + h, 0), 'air');
  for (let x = STEPS + 1; x <= STEPS + 10; x++) for (const y of [TOP - STEPS, TOP - STEPS + 1]) over.set(key(x, y, 0), 'air');
  const base = (x, y, z) => (y >= TOP ? 'air' : y >= TOP - 3 ? (y === TOP - 1 ? 'grass_block' : 'dirt') : 'stone');
  const id = (x, y, z) => over.get(key(x, y, z)) ?? base(x, y, z);
  const solid = (x, y, z) => id(x, y, z) !== 'air';
  const classify = (x, y, z) => (solid(x, y, z) ? Cell.SOLID : Cell.AIR);
  return { id, solid, classify, set: (x, y, z, v) => over.set(key(x, y, z), v) };
}

function blast(W, c, r, rng) {
  let n = 0;
  for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) {
    if (Math.hypot(dx, dy, dz) > r * (0.75 + rng() * 0.35)) continue;
    const x = Math.floor(c.x) + dx, y = Math.floor(c.y) + dy, z = Math.floor(c.z) + dz;
    if (W.solid(x, y, z)) { W.set(x, y, z, 'air'); n++; }
  }
  return n;
}

function setup(W, carry, OLD) {
  const pack = new Container(36);
  pack.addItem(new ItemStack('stone_pickaxe', 1));
  if (carry) pack.addItem(new ItemStack('cobblestone', carry));
  const bot = { location: { x: stand(STEPS).x + 0.5, y: stand(STEPS).y, z: 0.5 }, isInWater: false, dimension: null, getComponent: (t) => (t === 'minecraft:inventory' ? { container: pack } : undefined) };
  const steps = [];
  for (let i = 0; i <= STEPS; i++) steps.push(`${i},${TOP - i - 1},0`);
  const memory = { data: { quarry: { d: 'minecraft:overworld', steps, dir: 0, fails: 0 } }, save() {}, isUnreachable: () => false, list: () => [] };
  const log = [];
  const st = { searches: 0, nodes: 0, offLine: 0, placed: 0, ticks: 0 };
  const line = new Set();
  for (let i = 0; i <= STEPS; i++) for (let h = -1; h < 3; h++) line.add(key(i, TOP - i + h, 0));
  const cobble = () => { let n = 0; for (let i = 0; i < 36; i++) { const s = pack.getItem(i); if (s?.typeId === 'minecraft:cobblestone') n += s.amount; } return n; };
  const take = () => { for (let i = 0; i < 36; i++) { const s = pack.getItem(i); if (s?.typeId === 'minecraft:cobblestone') { s.amount--; pack.setItem(i, s.amount ? s : undefined); return true; } } return false; };
  const standable = (x, y, z) => !W.solid(x, y, z) && !W.solid(x, y + 1, z) && W.solid(x, y - 1, z);
  // Moving: waypoint by waypoint, a block's step at a time, else stopped where we got to.
  const moveTo = (p) => { bot.location = { x: Math.floor(p.x) + 0.5, y: Math.floor(p.y), z: Math.floor(p.z) + 0.5 }; };
  const followPath = async (wps) => {
    for (const w of wps.slice(1)) {
      const f = { x: Math.floor(bot.location.x), y: Math.floor(bot.location.y), z: Math.floor(bot.location.z) };
      const t = { x: Math.floor(w.x), y: Math.floor(w.y), z: Math.floor(w.z) };
      const man = Math.abs(t.x - f.x) + Math.abs(t.z - f.z);
      const ok = standable(t.x, t.y, t.z) && man <= 2 && t.y - f.y <= 1 && f.y - t.y <= 3 && !(t.y > f.y && W.solid(f.x, f.y + 2, f.z));
      if (!ok) return { status: 'stuck' };
      moveTo(t); st.ticks += 5;
    }
    return { status: 'arrived' };
  };
  const apply = (path) => {
    for (const p of path) {
      for (const [x, y, z] of p.move?.breaks ?? []) { if (W.solid(x, y, z)) { W.set(x, y, z, 'air'); if (!line.has(key(x, y, z))) st.offLine++; st.ticks += 14; pack.addItem(new ItemStack('cobblestone', 1)); } }
      if (p.move?.place) { W.set(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z), 'cobblestone'); take(); st.placed++; st.ticks += 16; }
      st.ticks += 5;
    }
    const e = path[path.length - 1];
    moveTo(e);
  };
  const search = (from, to, tol, maxNodes, goalTest, opts) => {
    st.searches++;
    const act = opts?.actions ? { breakCost: () => 0.85, placeCost: 0.8, budget: cobble(), unitsPerSecond: 4.3, ...(opts.actions.pillar === false ? { pillar: false } : {}) } : undefined;
    const r = findPath(W.classify, from, to, { tolerance: tol, maxNodes, goalTest, ...(act ? { actions: act } : {}), ...(opts?.costs ? { costs: opts.costs } : {}) });
    st.nodes += r.expanded ?? 0;
    st.ticks += Math.ceil((r.expanded ?? 0) / 500); // (a job: ~500 nodes a tick)
    return r;
  };
  const dim = {
    id: 'minecraft:overworld',
    getBlock: (p) => { const i = W.id(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return { typeId: `minecraft:${i}`, isLiquid: false, isAir: i === 'air', permutation: { getState: () => undefined } }; },
  };
  bot.dimension = dim;
  const a = {
    sim: bot, dim, memory, log: (m) => log.push(m), say: () => {}, sayOnce: (k, m) => log.push(`(says) ${m}`), cellChanged() {},
    motor: { followPath, setFocus() {}, stop() {} },
    classifier: () => W.classify,
    plan: async (from, to, tol, maxNodes, goalTest, opts) => search(from, to, tol, maxNodes, goalTest, opts),
    homestead: {
      house: { x: -20, y: 64, z: 0 },
      isHouseBlock: () => false,
      // As the game: needs a solid face beside it, in reach, a block in hand.
      placeAt: async (gen, c) => {
        if (W.solid(c.x, c.y, c.z)) return false;
        const face = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => W.solid(c.x + dx, c.y + dy, c.z + dz));
        if (!face || !S.inReach(c) || !take()) return false;
        W.set(c.x, c.y, c.z, 'cobblestone'); st.placed++; st.ticks += 6;
        return true;
      },
    },
  };
  const S = Object.assign(Object.create(Skills.prototype), { a, ourDrops: new Map(), dropSpots: [], placed: new Set(), essential: false, _tunnels: [] });
  Object.defineProperty(S, 'sim', { get: () => bot });
  Object.defineProperty(S, 'dim', { get: () => dim });
  Object.defineProperty(S, 'quarry', { get: () => memory.data.quarry });
  S.check = () => {}; S.log = (m) => log.push(m);
  S.wait = async (gen, n) => { st.ticks += n; system.advance(n); };
  S.blockAt = (p) => W.id(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  S.blockReserve = () => ({});
  S.markPlaced = () => {};
  S.stopFlow = async () => 0;
  S.isUndergroundCached = (x, y) => y < TOP;
  S.gatherBlocks = async (gen, n) => { const k = Math.max(0, n - cobble()); if (k) { pack.addItem(new ItemStack('cobblestone', k)); st.ticks += k * 14; } return cobble(); };
  S.mine = async (gen, c) => {
    if (!W.solid(c.x, c.y, c.z)) return true;
    if (!S.inReach(c)) return false;
    W.set(c.x, c.y, c.z, 'air'); if (!line.has(key(c.x, c.y, c.z))) st.offLine++;
    pack.addItem(new ItemStack('cobblestone', 1)); st.ticks += 14;
    return true;
  };
  // goNear: the game's walk search, then the dig-and-build one within 24.
  S.goNear = async (gen, p, tol) => {
    let r = search(bot.location, p, tol, 8000);
    if (!r.complete && Math.hypot(p.x - bot.location.x, p.y - bot.location.y, p.z - bot.location.z) <= 24) r = search(bot.location, p, tol, 6000, undefined, { actions: {} });
    if (!r.complete) return false;
    apply(r.path);
    return true;
  };
  S.followActionPath = async (gen, path) => { apply(path); return true; };
  // Out: standing at the surface level with a walk to open ground 6+ away.
  S.needsEscape = async () => {
    const f = { x: Math.floor(bot.location.x), y: Math.floor(bot.location.y), z: Math.floor(bot.location.z) };
    if (f.y < TOP) return true;
    const r = findPath(W.classify, bot.location, bot.location, { maxNodes: 800, goalTest: (x, y, z, w) => w.standable(x, y, z) && y >= TOP && Math.hypot(x - f.x, z - f.z) >= 6 });
    return !r.complete;
  };
  if (OLD) { S.rebuildStairs = async () => false; S.rebuildEntrance = async () => true; }
  // The game's climb out, as far as the quarry goes: its own stairs, else one escape search.
  const getOut = async () => {
    if (await S.leaveQuarry(0)) { if (!(await S.needsEscape())) return 'stairs'; }
    if (await S.actionEscape(0)) return 'escape';
    return 'stuck';
  };
  return { S, st, log, getOut, bot, memory };
}

function world(seed) {
  const r = makeRng(seed);
  const W = makeWorld();
  // Blown to pieces: the entrance, and 2-4 more down the stairs, big craters near the top (dirt).
  const at = [0, r.int(1, 4), ...Array.from({ length: 2 + r.int(0, 2) }, () => r.int(2, STEPS - 3))];
  for (const i of at) {
    const s = stand(i);
    blast(W, { x: s.x + r.range(-1, 1), y: s.y + r.range(0, 1.5), z: r.range(-1, 1) }, s.y >= TOP - 4 ? r.range(3.0, 4.2) : r.range(1.6, 3.0), r);
  }
  // PIT=1: a sheer-sided pit round the entrance too (4 deep, 3 across each way): no walking out of it.
  if (process.env.PIT === '1') for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = TOP - 4; y < TOP; y++) if (!(x >= 0 && z === 0 && y >= TOP - 1 - x)) W.set(x, y, z, 'air');
  return { W, carry: [0, 8, 20, 40][r.int(0, 3)], at };
}

const OLDONLY = process.env.OLD === '1';
const rng = makeRng(20260929);
const tot = { old: { out: 0, stairs: 0, searches: 0, offLine: 0, secs: 0, again: 0, againSearches: 0 }, new: { out: 0, stairs: 0, searches: 0, offLine: 0, secs: 0, again: 0, againSearches: 0 } };
for (let n = 0; n < N; n++) {
  const seed = rng.int(1, 1e9);
  for (const kind of OLDONLY ? ['old'] : ['old', 'new']) {
    const { W, carry, at } = world(seed);
    const { S, st, log, getOut, memory } = setup(W, carry, kind === 'old');
    let how;
    try { how = await getOut(); } catch (e) { how = `threw ${e.message}`; }
    const T = tot[kind];
    const out = how === 'stairs' || how === 'escape';
    if (out) T.out++;
    if (how === 'stairs') T.stairs++;
    T.searches += st.searches; T.offLine += st.offLine; T.secs += st.ticks / 20;
    // Next trip: down to the bottom and back up. A plain walk means no searches at all.
    if (out && memory.data.quarry) {
      const s0 = st.searches;
      let ok = false;
      try { ok = (await S.walkShaft(0, S.quarry.steps.length - 1)) && (await S.leaveQuarry(0)) && !(await S.needsEscape()); } catch {}
      if (ok) T.again++;
      T.againSearches += st.searches - s0;
      if (VERBOSE && st.searches > s0 && kind === 'new') { console.log(`#${n} new, next trip: ${st.searches - s0} searches`); for (const l of log.slice(-8)) console.log(`    ${l}`); }
    }
    if (VERBOSE && (!out || how !== 'stairs' || process.env.ALL)) {
      console.log(`#${n} ${kind}: ${how}, blasts at steps ${at.join(',')}, ${carry} cobble, ${st.searches} searches, ${st.offLine} dug off the line`);
      for (const l of log.slice(-12)) console.log(`    ${l}`);
    }
  }
}
for (const [k, T] of Object.entries(tot)) {
  if (OLDONLY && k === 'new') continue;
  console.log(`${k.padEnd(3)}: out ${T.out}/${N} (up its own stairs ${T.stairs}), ${(T.searches / N).toFixed(1)} searches, ${(T.offLine / N).toFixed(1)} blocks dug off the stairs' line, ~${(T.secs / N).toFixed(0)} s; next trip down and up: ${T.again}/${N} fine, ${(T.againSearches / N).toFixed(1)} searches`);
}
