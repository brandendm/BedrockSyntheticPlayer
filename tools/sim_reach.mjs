// Only what a player could: game/skills.js's own mine() and homestead.js's placeAt() in a little
// block world, with the crosshair for real (a ray from the eye to where the head's turned; it
// stops on anything with an outline: vines, grass, leaves). The game's breakBlock and
// useItemOnBlock would take any block in reach, seen or not; each case checks the bot doesn't.
//
//   node tools/sim_reach.mjs [-v]
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Skills } = await import('../behavior_pack/scripts/game/skills.js');
const { Homestead } = await import('../behavior_pack/scripts/game/homestead.js');
const { castRay } = await import('../behavior_pack/scripts/game/world.js');
const { system, ItemStack, Container } = MC;
const VERBOSE = process.argv.includes('-v');
const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const OPENISH = /^(air|short_grass|tall_grass|vine|poppy|dandelion)$/;

function game(setup) {
  const blocks = new Map();
  const get = (p) => blocks.get(key(p)) ?? (Math.floor(p.y) < 64 ? 'grass_block' : 'air');
  const set = (p, id) => blocks.set(key(p), id);
  const events = []; // what broke / went down, in order
  setup(set);
  const dim = {
    id: 'minecraft:overworld',
    getBlock: (p) => { const id = get(p); return { typeId: `minecraft:${id}`, isAir: id === 'air', isLiquid: /water|lava/.test(id), permutation: { getState: () => undefined } }; },
    runCommand: (cmd) => { const m = /^setblock (-?\d+) (-?\d+) (-?\d+) (\S+)/.exec(cmd); if (m) { set({ x: +m[1], y: +m[2], z: +m[3] }, m[4]); events.push(`cmd ${m[4]} ${m[1]},${m[2]},${m[3]}`); } },
    getEntities: () => [],
  };
  const pack = new Container(36);
  pack.addItem(new ItemStack('stone_axe', 1)); pack.addItem(new ItemStack('cobblestone', 16));
  let focus = null;
  const bot = {
    location: { x: 0.5, y: 64, z: 0.5 }, dimension: dim, selectedSlotIndex: 0,
    getComponent: (t) => (t === 'minecraft:inventory' ? { container: pack } : undefined),
    breakBlock: (p) => {
      // The game breaks whatever it's told: the test is whether that was under the crosshair.
      const ch = S.crosshair();
      const legit = ch && key(ch.location) === key(p);
      events.push(`break ${get(p)} ${key(p)}${legit ? '' : ' THROUGH SOMETHING'}`);
      if (!legit) cheats++;
      set(p, 'air');
    },
    stopBreakingBlock() {}, useItemInSlotOnBlock: (slot, n, face) => true,
    getHeadLocation: () => ({ x: bot.location.x, y: bot.location.y + 1.62, z: bot.location.z }),
  };
  let cheats = 0;
  const standable = (c) => OPENISH.test(get(c)) && OPENISH.test(get({ ...c, y: c.y + 1 })) && !OPENISH.test(get({ ...c, y: c.y - 1 }));
  const walk = (a, b) => { // flood fill over standable cells
    const s = { x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z) }, goal = key(b), seen = new Set([key(s)]), q = [s];
    while (q.length) { const c = q.shift(); if (key(c) === goal) return true; if (seen.size > 3000) break;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]]) {
        const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz }; if (seen.has(key(n)) || Math.abs(n.x) > 12 || Math.abs(n.z) > 12 || !standable(n)) continue; seen.add(key(n)); q.push(n); } }
    return false;
  };
  const a = {
    sim: bot, dim, memory: { data: {}, save() {} }, log() {}, say() {}, sayOnce() {}, cellChanged() {},
    motor: { setFocus: (f) => { focus = f; }, async followPath() { return { status: 'arrived' }; }, stop() {} },
    homestead: { isHouseBlock: () => false },
    worn: () => [],
  };
  const S = Object.assign(Object.create(Skills.prototype), { a, ourDrops: new Map(), dropSpots: [], placed: new Set(), essential: false, _tunnels: [], builtUp: [] });
  Object.defineProperty(S, 'sim', { get: () => bot });
  Object.defineProperty(S, 'dim', { get: () => dim });
  const log = [];
  S.check = () => {}; S.log = (m) => log.push(m);
  S.wait = async (gen, n) => { system.advance(n); };
  S.blockAt = (p) => get(p);
  S.collect = async () => {};
  S.isProtected = () => false;
  S.touchesLava = () => false;
  S.crosshair = () => {
    if (!focus) return null;
    const e = S.eye(), d = { x: focus.x - e.x, y: focus.y - e.y, z: focus.z - e.z };
    const h = castRay(dim, e, d, 5, { crosshair: true });
    return h ? { location: h.location, face: h.face } : null;
  };
  // Moving: to the nearest standable cell we can walk to (goNear), or where ok(eye) holds (goSee).
  const moveTo = (cands) => { cands.sort((x, y) => d3(x, S.feet()) - d3(y, S.feet())); for (const c of cands) if (walk(S.feet(), c)) { bot.location = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }; events.push(`walk ${key(c)}`); return true; } return false; };
  const around = (p, r, f) => { const out = []; for (let dx = -r; dx <= r; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -r; dz <= r; dz++) { const c = { x: Math.floor(p.x) + dx, y: Math.floor(p.y) + dy, z: Math.floor(p.z) + dz }; if (standable(c) && f(c)) out.push(c); } return out; };
  S.goNear = async (gen, p, tol = 3) => moveTo(around(p, 5, (c) => d3({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, p) <= Math.max(tol, 0.8)));
  S.goSee = async (gen, p, ok) => moveTo(around(p, 5, (c) => { const e = { x: c.x + 0.5, y: c.y + 1.62, z: c.z + 0.5 }; return d3(e, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }) <= 4.2 && !(c.x === p.x && c.z === p.z) && ok(e); }));
  const H = Object.create(Homestead.prototype);
  H.a = a; a.skills = S;
  a.homestead = H; H.isHouseBlock = () => false;
  S.placeOn = async (gen, slot, n, face, loc, cell) => {
    // The click: onto the face the crosshair's on (or the plant in the cell): legit, else a cheat.
    const ch = S.crosshair();
    const legit = ch && ((key(ch.location) === key(n)) || key(ch.location) === key(cell));
    events.push(`place ${key(cell)} against ${key(n)}${legit ? '' : ' THROUGH SOMETHING'}`);
    if (!legit) cheats++;
    set(cell, 'cobblestone');
    return true;
  };
  return { S, H, bot, get, set, events, log, cheats: () => cheats };
}

const results = [];
function report(name, ok, detail, g) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  if (VERBOSE || !ok) { for (const e of g.events) console.log(`    ${e}`); for (const l of g.log.slice(-6)) console.log(`    log: ${l}`); }
}

// 1. A log with vines hanging on the side facing us: the vine comes off first.
{
  const g = game((set) => { for (let y = 64; y < 69; y++) set({ x: 3, y, z: 0 }, 'oak_log'); set({ x: 2, y: 64, z: 0 }, 'vine'); set({ x: 2, y: 65, z: 0 }, 'vine'); });
  const ok = await g.S.mine(0, { x: 3, y: 64, z: 0 });
  const vineFirst = g.events.findIndex((e) => /break vine/.test(e)) < g.events.findIndex((e) => /break oak_log/.test(e));
  report('a log behind vines', ok && g.get({ x: 3, y: 64, z: 0 }) === 'air' && g.cheats() === 0 && (vineFirst || /walk/.test(g.events[0] ?? '')), `log broken ${ok}, through something ${g.cheats()} time(s), ${g.events.join('; ')}`, g);
}
// 2. A trunk inside its canopy: leaves between us and it.
{
  const g = game((set) => { for (let y = 64; y < 69; y++) set({ x: 3, y, z: 0 }, 'oak_log'); for (let dz = -1; dz <= 1; dz++) for (let y = 64; y <= 66; y++) set({ x: 2, y, z: dz }, 'oak_leaves'); });
  const ok = await g.S.mine(0, { x: 3, y: 65, z: 0 });
  report('a trunk behind leaves', ok && g.cheats() === 0 && g.events.some((e) => /break oak_leaves/.test(e)), `log broken ${ok}, through something ${g.cheats()} time(s), ${g.events.join('; ')}`, g);
}
// 3. A flower behind tall grass: the grass first.
{
  const g = game((set) => { set({ x: 3, y: 64, z: 0 }, 'poppy'); set({ x: 2, y: 64, z: 0 }, 'short_grass'); });
  g.bot.location = { x: 0.5, y: 64, z: 0.5 };
  await g.S.mine(0, { x: 3, y: 64, z: 0 });
  report('a flower behind grass', g.cheats() === 0 && g.get({ x: 3, y: 64, z: 0 }) === 'air', `through something ${g.cheats()}, ${g.events.join('; ')}`, g);
}
// 4. Stone behind a wall (not an essential job): not through the wall; round to where it shows.
{
  const g = game((set) => {
    for (let dz = -3; dz <= 3; dz++) for (let y = 64; y <= 66; y++) set({ x: 2, y, z: dz }, 'stone'); // a wall
    set({ x: 3, y: 64, z: 0 }, 'iron_ore');
  });
  const ok = await g.S.mine(0, { x: 3, y: 64, z: 0 });
  report('ore behind a wall', g.cheats() === 0 && (!ok || g.events.some((e) => /walk/.test(e))), `mined ${ok}, through something ${g.cheats()}, ${g.events.join('; ')}`, g);
}
// 5. A block to go in on the far side of a wall, the only face to put it against over there: from
// this side it can't be done; the bot goes round (the wall's end is open).
{
  const g = game((set) => {
    for (let dz = -2; dz <= 2; dz++) for (let y = 64; y <= 66; y++) set({ x: 2, y, z: dz }, 'stone');
    set({ x: 4, y: 64, z: 0 }, 'stone'); // what the new block goes against (a post over there)
  });
  const ok = await g.H.placeAt(0, { x: 4, y: 65, z: 0 }, 'cobblestone');
  report('building on the far side of a wall', g.cheats() === 0 && ok && g.events.some((e) => /walk/.test(e)), `placed ${ok}, through something ${g.cheats()}, ${g.events.join('; ')}`, g);
}
// 6. Same, walled in on every side: can't be done at all, and isn't.
{
  const g = game((set) => {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let y = 64; y <= 66; y++) if (Math.abs(dx) === 2 || Math.abs(dz) === 2) set({ x: dx, y, z: dz }, 'stone');
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) set({ x: dx, y: 67, z: dz }, 'stone');
    set({ x: 4, y: 64, z: 0 }, 'stone');
  });
  const ok = await g.H.placeAt(0, { x: 4, y: 65, z: 0 }, 'cobblestone');
  report('building through the walls of a box it is shut in', g.cheats() === 0 && !ok, `placed ${ok}, through something ${g.cheats()}`, g);
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} only what a player could do`);
process.exit(pass === results.length ? 0 : 1);
