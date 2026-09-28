// The branch mine across trips and deaths: game/skills.js's own branchMine/branch (where the main
// tunnel resumes, when a pair of branches is cut, which way it turns when blocked, the cave check)
// run in Node on a block grid, with the digging itself (tunnelStep) done by the grid: two blocks out,
// one step on, the floor noted as ours. Trips end part way (night, a full pack, a death); the next
// one either gets back to the end of the tunnel or can't (lava came in, the way's blocked) and
// starts from the foot of the shaft. Counted:
//   cramped   branches dug within 2 blocks of another one alongside it (no solid block between, or
//             one: the same stone seen twice, the digging wasted)
//   own caves times the bot took its own old tunnels for a cave it had broken into
//   ore faces how much stone the mine showed (new faces seen per block dug: the point of it)
//
//   node tools/sim_mine.mjs [-v]      OLD=1: the mine as it was (branches counted from the trip's
//                                     start, the tunnel floors kept in the 300-long list)
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Skills } = await import('../behavior_pack/scripts/game/skills.js');
const { makeRng } = await import('../behavior_pack/scripts/core/mathutil.js');
const { system } = MC;
const VERBOSE = process.argv.includes('-v');
const OLD = process.env.OLD === '1';
const LEVEL = 16;

async function run(seed, plan) {
  const rng = makeRng(seed);
  const open = new Set(); // dug cells
  const lava = new Set(); // cells that stop the tunnel
  const key = (x, y, z) => `${x},${y},${z}`;
  const blockAt = (p) => (lava.has(key(p.x, p.y, p.z)) ? 'lava' : open.has(key(p.x, p.y, p.z)) ? 'air' : 'deepslate');
  // The shaft's foot: a little room.
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (const y of [LEVEL, LEVEL + 1]) open.add(key(x, y, z));
  const camp = []; for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) camp.push(key(x, LEVEL - 1, z)); // (the shaft's foot: ours)
  // Some lava pockets out along the way (the tunnel turns at them).
  for (let i = 0; i < plan.lava; i++) { const x = 6 + Math.floor(rng() * 40), z = Math.floor(rng() * 21) - 10; lava.add(key(x, LEVEL, z)); lava.add(key(x, LEVEL + 1, z)); }
  const mem = { data: { quarry: { d: 'minecraft:overworld', steps: camp, dir: 0 }, stairs: [] }, save() {} };
  const bot = { location: { x: 0.5, y: LEVEL, z: 0.5 }, dimension: { id: 'minecraft:overworld', getBlock: (p) => ({ typeId: `minecraft:${blockAt(p)}` }) } };
  const agent = { sim: bot, memory: mem, say() {}, sayOnce() {}, homestead: { house: null }, motor: {}, cellChanged() {} };
  const S = Object.create(Skills.prototype);
  Object.assign(S, { a: agent, _tunnels: [], ourDrops: new Map(), dropSpots: [], essential: false, placed: new Set() });
  const noted = []; // every tunnel floor, in the order dug (OLD: only the last 300 are remembered)
  let digs = 0, faces = 0, ownCaves = 0, stepsLeft = 0, reachEnd = true;
  const seenFace = new Set();
  const look = (x, y, z) => { for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const k = key(x + a, y + b, z + c); if (!open.has(k) && !seenFace.has(k)) { seenFace.add(k); faces++; } } };
  S.check = () => {}; S.log = (m) => VERBOSE && console.log(`    ${m}`); S.wait = async () => {};
  S.homeQuarry = () => mem.data.quarry;
  S.stoniestDir = () => 0;
  S.dumpJunk = async () => {};
  S.oreAround = async () => 0;
  S.exploreCave = async () => {
    // There are no caves in this rock: a "cave" the bot would go and explore (exploreCave's own test:
    // floor to walk to 6+ blocks off that isn't ours) is its own old tunnels.
    const f = S.feet();
    const cave = [...open].some((k) => {
      const [x, y, z] = k.split(',').map(Number);
      const d = Math.hypot(x - f.x, z - f.z);
      return y === f.y && d >= 6 && d <= 24 && open.has(key(x, y + 1, z)) && !S.isProtected({ x, y: y - 1, z });
    });
    if (cave) ownCaves++;
    return 0;
  };
  S.goNear = async (gen, p) => {
    const t = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    if (!open.has(key(t.x, t.y, t.z))) return false;
    if (!reachEnd && mem.data.quarry.mine && t.x === mem.data.quarry.mine.at.x && t.z === mem.data.quarry.mine.at.z) return false;
    bot.location = { x: t.x + 0.5, y: t.y, z: t.z + 0.5 };
    return true;
  };
  S.tunnelStep = async (gen, dx, dz) => {
    if (stepsLeft-- <= 0) throw new Error('trip over');
    const f = S.feet();
    const feet = { x: f.x + dx, y: f.y, z: f.z + dz };
    if (lava.has(key(feet.x, feet.y, feet.z)) || lava.has(key(feet.x, feet.y + 1, feet.z))) return false;
    if (Math.abs(feet.x) > 60 || Math.abs(feet.z) > 60) return false;
    for (const y of [feet.y, feet.y + 1]) if (!open.has(key(feet.x, y, feet.z))) { open.add(key(feet.x, y, feet.z)); digs++; look(feet.x, y, feet.z); }
    bot.location = { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
    const floor = { x: feet.x, y: f.y - 1, z: feet.z };
    S.noteTunnel(floor, dx, dz);
    noted.push(key(floor.x, floor.y, floor.z));
    return true;
  };
  S.saveTunnels = () => {};
  if (OLD) {
    // Branches counted from where the trip started; the floors in a 300-long list.
    S.branchNear = () => null;
    S.branchAt = () => false;
    S.turnFrom = (di) => (di + 1) % 4;
    const isFloor = Skills.prototype.isTunnelFloor;
    S.isTunnelFloor = function (p) { return isFloor.call(this, p) && noted.slice(-300).includes(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))); };
  }
  for (const [i, trip] of plan.trips.entries()) {
    // Back down the shaft: at its foot, then (if it can) to the end of the tunnel.
    bot.location = { x: 0.5, y: LEVEL, z: 0.5 };
    reachEnd = trip.reachEnd !== false;
    stepsLeft = trip.steps;
    try { await S.branchMine(0, () => true); } catch (e) { if (!/trip over/.test(String(e))) throw e; }
  }
  // Cramped: two parallel tunnels (branches, or a branch beside the main tunnel) 1 or 2 blocks
  // apart side by side for 3+ blocks.
  const cells = [...open].map((k) => k.split(',').map(Number)).filter(([, y]) => y === LEVEL);
  const isOpen = (x, z) => open.has(key(x, LEVEL, z));
  let cramped = 0;
  for (const [x, , z] of cells) {
    // A cell of a tunnel running along x, with another running along x two over (one solid between).
    const alongX = isOpen(x - 1, z) && isOpen(x + 1, z) && !isOpen(x, z - 1) && !isOpen(x, z + 1);
    const alongZ = isOpen(x, z - 1) && isOpen(x, z + 1) && !isOpen(x - 1, z) && !isOpen(x + 1, z);
    // (Three over, two solid between, is the spacing meant: every block in between shows a face.)
    if (alongX && isOpen(x, z + 2) && isOpen(x - 1, z + 2) && isOpen(x + 1, z + 2)) cramped++;
    if (alongZ && isOpen(x + 2, z) && isOpen(x + 2, z - 1) && isOpen(x + 2, z + 1)) cramped++;
  }
  if (process.env.MAP && cramped) {
    const xs = cells.map((c) => c[0]), zs = cells.map((c) => c[2]);
    for (let z = Math.min(...zs) - 1; z <= Math.max(...zs) + 1; z++) {
      let row = '';
      for (let x = Math.min(...xs) - 1; x <= Math.max(...xs) + 1; x++) row += lava.has(key(x, LEVEL, z)) ? 'L' : isOpen(x, z) ? '.' : '#';
      console.log(row);
    }
    console.log(`seed ${seed}: ${cramped} cramped`);
  }
  return { digs, faces, ownCaves, cramped };
}

// The trips: a long first one, then comebacks of each kind.
const PLANS = [
  { name: 'death, back to the end', lava: 0, trips: [{ steps: 120 }, { steps: 120 }, { steps: 120 }] },
  { name: "death, can't get back to the end", lava: 0, trips: [{ steps: 120 }, { steps: 200, reachEnd: false }, { steps: 120, reachEnd: false }] },
  { name: 'lava in the way (turns), deaths', lava: 6, trips: [{ steps: 150 }, { steps: 150, reachEnd: false }, { steps: 150 }] },
  { name: 'a long mine, started again from the shaft', lava: 2, trips: [{ steps: 500 }, { steps: 400, reachEnd: false }] },
];
console.log(`${OLD ? 'OLD mine' : 'mine'}: plan                                       cramped  own caves  faces/dig`);
let bad = 0;
for (const p of PLANS) {
  const tot = { digs: 0, faces: 0, ownCaves: 0, cramped: 0 };
  for (let s = 1; s <= 20; s++) { const r = await run(s * 7919, p); for (const k of Object.keys(tot)) tot[k] += r[k]; }
  if (!OLD && (tot.ownCaves > 0 || tot.cramped > 0)) bad++;
  console.log(`  ${p.name.padEnd(48)} ${String(tot.cramped).padStart(6)}  ${String(tot.ownCaves).padStart(9)}  ${(tot.faces / Math.max(1, tot.digs)).toFixed(2).padStart(9)}`);
}
console.log(OLD ? '' : bad ? `\n${bad} plan(s) with cramped branches or own-caves` : '\nno cramped branches, never its own mine taken for a cave');
process.exit(!OLD && bad ? 1 : 0);
