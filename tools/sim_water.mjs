// A creeper's crater lets water into the quarry stairs: game/skills.js's own stopFlow (trace the
// current back to what feeds it, fill that, clear the steps) against a block world where water
// behaves like Bedrock's, near enough: a source spreads 7 blocks over ground, pours down any drop
// and spreads again where it lands, and flowing water dies back once it's cut off. Cases: a pond
// beside the stairs, a lake (too many sources to fill: dammed instead), a stream from uphill.
//
//   node tools/sim_water.mjs [-v]
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Skills } = await import('../behavior_pack/scripts/game/skills.js');
const { system, ItemStack, Container } = MC;
const VERBOSE = process.argv.includes('-v');
const key = (x, y, z) => `${x},${y},${z}`;

function makeWorld({ pond }) {
  const solid = new Set();
  const sources = new Set();
  // Ground at y < 64 everywhere in -30..30; the stairs: a 1-wide cut down along +x from x=1
  // (feet at 64 - x) to x=10, 3 high.
  const inStairs = (x, y, z) => z === 0 && x >= 1 && x <= 12 && y >= 64 - Math.min(x, 10) && y < 64 - Math.min(x, 10) + 3;
  const ground = (x, y, z) => y < 64 && !inStairs(x, y, z);
  for (const [x, y, z] of pond.sources) sources.add(key(x, y, z));
  const holes = new Set(pond.holes.map(([x, y, z]) => key(x, y, z))); // the pond's bed and the crater: dug out of the ground
  const isSolid = (x, y, z) => solid.has(key(x, y, z)) || (ground(x, y, z) && !holes.has(key(x, y, z)) && !sources.has(key(x, y, z)));
  // Steady-state water from the sources (depth 0), flowing (1-7), falling (8).
  let water = new Map();
  const settle = () => {
    water = new Map();
    const q = [];
    for (const k of sources) { const [x, y, z] = k.split(',').map(Number); if (!solid.has(k)) { water.set(k, 0); q.push([x, y, z, 0]); } }
    for (let i = 0; i < q.length && i < 20000; i++) {
      const [x, y, z, d] = q[i];
      const below = [x, y - 1, z];
      if (y > 40 && !isSolid(...below) && !sources.has(key(...below))) {
        const kb = key(...below);
        const nd = 8;
        if (!water.has(kb)) { water.set(kb, nd); q.push([...below, nd]); }
        continue; // pours down, no spreading from here
      }
      const next = d >= 8 ? 1 : d + 1;
      if (next > 7) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = [x + dx, y, z + dz], kn = key(...n);
        if (isSolid(...n)) continue;
        const cur = water.get(kn);
        if (cur === undefined || (cur !== 0 && cur < 8 && cur > next)) { water.set(kn, next); q.push([...n, next]); }
      }
    }
  };
  settle();
  const blockAt = (p) => {
    const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    if (solid.has(k)) return 'cobblestone';
    if (isSolid(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) return 'stone';
    return water.has(k) ? 'water' : 'air';
  };
  const dim = {
    id: 'minecraft:overworld',
    getBlock: (p) => {
      const id = blockAt(p);
      const k = key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return { typeId: `minecraft:${id}`, isLiquid: id === 'water', isAir: id === 'air', isWaterlogged: false, isSolid: id !== 'water' && id !== 'air', permutation: { getState: (s) => (s === 'liquid_depth' ? water.get(k) ?? 0 : undefined) } };
    },
  };
  return { dim, blockAt, water, place: (p, id) => { const k = key(p.x, p.y, p.z); solid.add(k); sources.delete(k); settle(); return true; }, dig: (p) => { const k = key(p.x, p.y, p.z); solid.delete(k); holes.add(k); settle(); }, settle, inStairs, sources, get waterMap() { return water; } };
}

function run(name, pond) {
  const W = makeWorld({ pond });
  const pack = new Container(36);
  pack.addItem(new ItemStack('cobblestone', 32));
  const bot = { location: { x: 0.5, y: 64, z: 3.5 }, dimension: W.dim, getComponent: (t) => (t === 'minecraft:inventory' ? { container: pack } : undefined) };
  const log = [];
  const a = { sim: bot, memory: { data: {}, save() {} }, say: () => {}, sayOnce: (k, m) => log.push(m), cellChanged() {}, homestead: {} };
  const S = Object.assign(Object.create(Skills.prototype), { a, ourDrops: new Map(), dropSpots: [], placed: new Set(), essential: false, _tunnels: [] });
  S.check = () => {}; S.log = (m) => log.push(m);
  S.wait = async (gen, n) => { system.advance(n); W.settle(); };
  S.inReach = () => true;
  S.goNear = async () => true;
  S.blockReserve = () => ({});
  S.markPlaced = () => {};
  S.mine = async (gen, c) => { W.dig(c); return true; };
  let placedN = 0;
  a.homestead.placeAt = async (gen, c, id) => { if (!/water|air/.test(W.blockAt(c))) return false; placedN++; const s = pack.getItem(0); if (s) { s.amount--; pack.setItem(0, s.amount ? s : undefined); } return W.place(c, id); };
  // The stairs' cells (feet and head at each step).
  const cells = [];
  for (let x = 1; x <= 10; x++) for (const dy of [0, 1]) cells.push({ x, y: 64 - x + dy, z: 0 });
  const wetBefore = cells.filter((c) => W.blockAt(c) === 'water').length;
  return S.stopFlow(0, cells.filter((c) => W.blockAt(c) === 'water')).then((n) => {
    const wetAfter = cells.filter((c) => W.blockAt(c) === 'water').length;
    const ok = wetBefore > 0 && wetAfter === 0 && placedN <= 16;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: stairs wet in ${wetBefore} cells before, ${wetAfter} after; ${placedN} blocks placed (${W.sources.size} sources left in the pond/lake)`);
    if (VERBOSE || !ok) for (const l of log) console.log(`    ${l}`);
    return ok;
  });
}

const results = [];
// A pond 4x5 at the surface just west of the stairs' top, and the crater joining them.
const pondSrc = [], pondHoles = [];
for (let x = -6; x <= -3; x++) for (let z = -2; z <= 2; z++) { pondSrc.push([x, 63, z]); pondHoles.push([x, 63, z]); }
for (let x = -2; x <= 0; x++) pondHoles.push([x, 63, 0]); // the crater: a channel from the pond to the stairs' top
results.push(await run('pond let in by a crater at the top of the stairs', { sources: pondSrc, holes: pondHoles }));
// A lake 20x20: far too many sources to fill.
const lakeSrc = [], lakeHoles = [];
for (let x = -24; x <= -3; x++) for (let z = -10; z <= 10; z++) { lakeSrc.push([x, 63, z]); lakeHoles.push([x, 63, z]); }
for (let x = -2; x <= 0; x++) lakeHoles.push([x, 63, 0]);
results.push(await run('a lake let in (dammed, not filled)', { sources: lakeSrc, holes: lakeHoles }));
// A wide crater: three blocks across, joined to the pond along its whole edge.
const wideHoles = [...pondHoles];
for (let x = -2; x <= 0; x++) for (const z of [-1, 1]) wideHoles.push([x, 63, z]);
for (let x = 1; x <= 2; x++) for (const z of [-1, 1]) wideHoles.push([x, 63, z]);
results.push(await run('a crater 3 wide joined to the pond', { sources: pondSrc, holes: wideHoles }));
// A spring: one source uphill (a block up) running down a channel into the stairs.
results.push(await run('a stream from one source uphill', { sources: [[-5, 64, 0]], holes: [[-5, 64, 0], [-4, 63, 0], [-3, 63, 0], [-2, 63, 0], [-1, 63, 0], [0, 63, 0]] }));
const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} flooded stairs cleared`);
process.exit(pass === results.length ? 0 : 1);
