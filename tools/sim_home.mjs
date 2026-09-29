// The house kept usable, for real: game/homestead.js's own code (houseObstructions, clearHouse,
// nightAtHome, fightFire, repairHouse, the door) against a little block world in Node
// (tools/mock/server.mjs). Walking is a teleport, but a walk is refused where a solid block stands
// in the way (feet or head), the way the motor would be stopped; breaking takes the block away;
// fire goes out when punched. Each case says what a player would expect and whether the bot did it.
//
//   node tools/sim_home.mjs [-v]
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Homestead } = await import('../behavior_pack/scripts/game/homestead.js');
const { Skills } = await import('../behavior_pack/scripts/game/skills.js');
const { castRay } = await import('../behavior_pack/scripts/game/world.js');
const { settleStep } = await import('../behavior_pack/scripts/core/settle.js');
const { blueprint, footing, furnishings, keepClear } = await import('../behavior_pack/scripts/core/house.js');
const { system, ItemStack, Container } = MC;
const VERBOSE = process.argv.includes('-v');

const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const SOLIDISH = (id) => !/^(air|fire|torch|wall_torch|.*_carpet|short_grass)$/.test(id) && !/door/.test(id);

function makeGame({ unbreakable = /^bedrock$/ } = {}) {
  const blocks = new Map();
  const items = []; // item entities on the ground
  const said = [], log = [];
  const pack = new Container(36);
  const house = { x: 0, y: 64, z: 0, dir: 'south', layout: 'chests', d: 'minecraft:overworld', bed: true, table: true, furnace: true, chest: true };
  const get = (p) => blocks.get(key(p)) ?? (Math.floor(p.y) < 64 ? 'stone' : 'air');
  const set = (p, id) => blocks.set(key(p), id);
  // The house as built: walls and roof, furniture, door, torches, the ground under it.
  for (const b of blueprint(house, house.dir)) set(b, b.material === 'stone' ? 'cobblestone' : 'oak_planks');
  const fur = furnishings(house, house.dir);
  set(fur.table, 'crafting_table'); set(fur.furnace, 'furnace'); set(fur.bed.foot, 'bed'); set(fur.bed.head, 'bed');
  for (const c of fur.chests) set(c, 'chest');
  set(fur.door, 'wooden_door'); set({ ...fur.door, y: fur.door.y + 1 }, 'wooden_door');
  for (const s of fur.signs) set(s.cell, 'oak_wall_sign');
  for (const t of [fur.torchInside, fur.torchChests, ...fur.torchesOutside]) set(t.toward, 'wall_torch');
  const dim = {
    id: 'minecraft:overworld',
    getBlock: (p) => { const id = get(p); return { typeId: `minecraft:${id}`, isAir: id === 'air', isLiquid: /water|lava/.test(id), location: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, permutation: { getState: () => false } }; },
    getEntities: ({ location, maxDistance }) => items.filter((e) => e.isValid && d3(e.location, location) <= maxDistance),
    runCommand: (cmd) => { const m = /^setblock (-?\d+) (-?\d+) (-?\d+) (\S+)/.exec(cmd); if (m) set({ x: +m[1], y: +m[2], z: +m[3] }, m[4].replace(/\[.*$/, '')); },
  };
  const bot = {
    id: 'bot', location: { x: fur.doorstep.x + 0.5, y: 64, z: fur.doorstep.z + 4.5 }, dimension: dim, selectedSlotIndex: 0, isSleeping: false,
    getComponent: (t) => (t === 'minecraft:inventory' ? { container: pack } : t === 'minecraft:player.hunger' ? { currentValue: 20 } : undefined),
    interactWithBlock: () => true, breakBlock: (p) => { if (/fire/.test(get(p))) set(p, 'air'); }, stopBreakingBlock() {}, stopInteracting() {},
  };
  const give = (id, n) => { const it = new ItemStack(id, n); pack.addItem(it); };
  const feet = () => ({ x: Math.floor(bot.location.x), y: Math.floor(bot.location.y), z: Math.floor(bot.location.z) });
  const eye = () => ({ x: bot.location.x, y: bot.location.y + 1.62, z: bot.location.z });
  const inReach = (p) => d3(eye(), { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }) <= 4.5;
  const standable = (p) => !SOLIDISH(get(p)) && !SOLIDISH(get({ ...p, y: p.y + 1 })) && get({ ...p, y: p.y - 1 }) !== 'air';
  // Is there a walk from a to b through open cells (feet and head), the house's door passable? (A
  // small flood fill: enough to tell "walled in" from "a way through".)
  const walk = (a, b) => {
    const start = { x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z) }, goal = key(b);
    const seen = new Set([key(start)]), q = [start];
    while (q.length) {
      const c = q.shift();
      if (key(c) === goal) return true;
      if (seen.size > 4000) break;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]]) {
        const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        if (seen.has(key(n)) || Math.abs(n.x) > 20 || Math.abs(n.z) > 20 || n.y < 60 || n.y > 70 || !standable(n)) continue;
        seen.add(key(n)); q.push(n);
      }
    }
    return false;
  };
  const S = {
    essential: true, // (the jobs these are part of are essential ones)
    log: (m) => log.push(`${system.currentTick}: ${m}`),
    check() {}, restHands() {},
    blockAt: (p) => get(p),
    feet, inReach, eye,
    async wait(gen, n) { system.advance(n); },
    async aim() {},
    async goNear(gen, p, tol = 3) {
      // Nearest standable cell within tol that we can walk to; failing that, with `essential`, dig
      // our way (anything breakable but the house's own blocks) like skills.actionOpts({ force }).
      const cand = [];
      for (let dx = -5; dx <= 5; dx++) for (let dy = -5; dy <= 2; dy++) for (let dz = -5; dz <= 5; dz++) {
        const c = { x: Math.floor(p.x) + dx, y: Math.floor(p.y) + dy, z: Math.floor(p.z) + dz };
        if (d3({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, p) <= Math.max(tol, 0.8) && standable(c)) cand.push(c);
      }
      cand.sort((a, b) => d3(a, p) - d3(b, p));
      for (const c of cand) if (walk(feet(), c)) { bot.location = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }; return true; }
      return false;
    },
    async mine(gen, p) {
      const id = get(p);
      if (id === 'air') return true;
      if (unbreakable.test(id) || /water|lava/.test(id)) return false;
      if (!inReach(p) && !(await S.goNear(gen, { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, 3))) {
        // Walled off: an essential job digs through what's between (here: whatever's nearest the goal).
        const way = keepClear(house, house.dir).filter((c) => SOLIDISH(get(c)) && !unbreakable.test(get(c)) && inReach(c)).sort((a, b) => d3(a, p) - d3(b, p))[0];
        if (!way) return false;
        set(way, 'air'); items.push({ id: `i${items.length}`, isValid: true, location: { x: way.x + 0.5, y: way.y, z: way.z + 0.5 }, what: get(way) });
        if (!inReach(p)) return S.mine(gen, p);
      }
      set(p, 'air');
      items.push({ id: `i${items.length}`, isValid: true, location: { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, what: id });
      return true;
    },
    async sweep(gen, near, radius) { for (const e of items) if (e.isValid && d3(e.location, near) <= radius) e.isValid = false; },
    async placeOn(gen, slot, n, face, loc, cell) {
      const it = pack.getItem(slot); if (!it) return false;
      set(cell, it.typeId.replace('minecraft:', '')); it.amount--; pack.setItem(slot, it.amount ? it : undefined); return true;
    },
    afterUse() {}, markPlaced() {},
    // The crosshair, for real: the game's rules (game/skills.js) on this world; it lands where the
    // motor was last told to look (the head's turn is instant here).
    dim,
    targetPoint: Skills.prototype.targetPoint, placePoint: Skills.prototype.placePoint, aimOn: Skills.prototype.aimOn,
    crosshair() {
      if (!focus) return null;
      const e = eye(), d = { x: focus.x - e.x, y: focus.y - e.y, z: focus.z - e.z };
      const h = castRay(dim, e, d, 5, { crosshair: true });
      return h ? { location: h.location, face: h.face } : null;
    },
    // Round to where it can be got at: the nearest cell we can walk to, in reach, where ok(eye).
    async goSee(gen, p, ok, maxNodes, { build = false } = {}) {
      const cand = [];
      for (let dx = -5; dx <= 5; dx++) for (let dy = -3; dy <= 2; dy++) for (let dz = -5; dz <= 5; dz++) {
        const c = { x: Math.floor(p.x) + dx, y: Math.floor(p.y) + dy, z: Math.floor(p.z) + dz };
        if (!standable(c)) continue;
        const e = { x: c.x + 0.5, y: c.y + 1.62, z: c.z + 0.5 };
        if (d3(e, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }) <= 4.2 && ok(e)) cand.push(c);
      }
      cand.sort((a, b) => d3(a, feet()) - d3(b, feet()));
      for (const c of cand) if (walk(feet(), c)) { bot.location = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }; seeMoves++; return true; }
      if (!build) return false;
      // Up a pillar from ground we can walk to (skills.goSee's build): the blocks go in builtUp.
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
        const g0 = { x: Math.floor(p.x) + dx, y: 64, z: Math.floor(p.z) + dz };
        if (!standable(g0) || !walk(feet(), g0)) continue;
        for (let up = 1; up <= 4; up++) {
          const top = { ...g0, y: 64 + up };
          if (SOLIDISH(get(top)) || SOLIDISH(get({ ...top, y: top.y + 1 }))) break;
          const e = { x: top.x + 0.5, y: top.y + 1.62, z: top.z + 0.5 };
          const pc = { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 };
          let at = d3(e, pc) <= 4.2 && ok(e) ? top : null;
          // (Or up the pillar and on across what it's up against: onto the roof.)
          if (!at) {
            for (let yy = 64; yy < top.y; yy++) set({ ...g0, y: yy }, 'cobblestone');
            for (let ax = -5; ax <= 5 && !at; ax++) for (let az = -5; az <= 5 && !at; az++) {
              const c = { x: Math.floor(p.x) + ax, y: top.y, z: Math.floor(p.z) + az };
              const ce = { x: c.x + 0.5, y: c.y + 1.62, z: c.z + 0.5 };
              if (standable(c) && d3(ce, pc) <= 4.2 && ok(ce) && walk(top, c)) at = c;
            }
            for (let yy = 64; yy < top.y; yy++) set({ ...g0, y: yy }, 'air');
          }
          if (at) {
            for (let yy = 64; yy < top.y; yy++) { set({ ...g0, y: yy }, 'cobblestone'); S.builtUp.push({ ...g0, y: yy }); }
            bot.location = { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }; seeMoves++;
            return true;
          }
        }
      }
      return false;
    },
    builtUp: [],
    async takeDownBuilt() { const cs = S.builtUp.splice(0).sort((a, b) => b.y - a.y); if (cs.length) bot.location = { x: cs[0].x + 0.5, y: cs[0].y + 1, z: cs[0].z + 0.5 }; for (const c of cs) { set(c, 'air'); bot.location = { ...bot.location, y: c.y }; } },
  };
  let focus = null, seeMoves = 0;
  const agent = {
    sim: bot, skills: S, say: (m) => said.push(m), sayOnce: (k, m) => said.push(m), cellChanged() {},
    memory: { data: { house }, save() {}, saveNow() {} }, health: () => 20, bedsOn: () => true,
    motor: {
      async lookAt() {}, setFocus(f) { focus = f; },
      async followPath(pts) {
        for (const p of pts.slice(1)) {
          const c = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
          if (!standable(c)) return { status: 'blocked' };
          bot.location = { x: c.x + 0.5, y: c.y, z: c.z + 0.5 };
        }
        return { status: 'arrived' };
      },
    },
  };
  S.a = agent;
  const H = new Homestead(agent);
  let sheltered = 0;
  H.shelter = async () => { sheltered++; };
  return { H, S, bot, blocks, items, said, log, house, fur, get, set, give, pack, sheltered: () => sheltered, standable };
}

const results = [];
function report(name, ok, detail, g) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  if (VERBOSE || !ok) { for (const m of g.said) console.log(`    says: ${m}`); for (const l of g.log.slice(-8)) console.log(`    log: ${l}`); }
}
const houseFacts = (H) => ({ tableDist: 0, furnace: null, smelt: null, sheep: false, animals: 0, bedDeferred: false, inv: {}, house: { dist: 5, ...H.houseStateNow() } });
const setNight = (on) => MC.world.getTimeOfDay = () => (on ? 14000 : 6000);
const inside = (g) => g.H.isHome();

// 1. A player filled the rooms: blocks of all sorts, in the rooms, on the furniture spots, in the doorway.
{
  const g = makeGame();
  const junk = ['cobblestone', 'glass', 'white_wool', 'oak_fence', 'dirt', 'sand', 'chest', 'bookshelf', 'oak_planks', 'stone_bricks'];
  const cells = keepClear(g.house, g.house.dir).filter((c) => !c.want || c.want === 'door');
  let n = 0;
  for (const [i, c] of cells.entries()) if (i % 2 === 0 || c.want === 'door') { g.set(c, junk[n++ % junk.length]); }
  const before = g.H.houseObstructions().length;
  const plan = settleStep(houseFacts(g.H)).step;
  setNight(false);
  await g.H.clearHouse(0);
  const after = g.H.houseObstructions().length;
  report('player filled the house', plan === 'clear_house' && before >= 20 && after === 0 && g.items.every((e) => !e.isValid),
    `plan ${plan}; ${before} blocks in the way, ${after} left; ${g.items.filter((e) => !e.isValid).length}/${g.items.length} picked up`, g);
}

// 2. Night, the doorway bricked up (door gone, two blocks in its place): clears it and gets in.
{
  const g = makeGame();
  g.set(g.fur.door, 'cobblestone'); g.set({ ...g.fur.door, y: g.fur.door.y + 1 }, 'cobblestone');
  g.set(g.fur.stand, 'dirt'); g.set({ ...g.fur.stand, y: g.fur.stand.y + 1 }, 'dirt');
  setNight(true);
  // Morning comes once it's in (or after a long wait outside).
  let got = false, waited = 0;
  g.S.wait = async (gen, n) => { system.advance(n); waited += n; if (inside(g)) { got = true; setNight(false); } else if (waited > 4000) setNight(false); };
  await g.H.nightAtHome(0);
  report('doorway bricked up at night', got && g.sheltered() === 0 && g.H.houseObstructions().filter((c) => c.want !== 'door').length === 0,
    `${got ? 'got in' : 'NOT in'}; sheltered elsewhere ${g.sheltered()}`, g);
}

// 3. Night, the doorway and doorstep filled with something it can't break (bedrock): the door moves
// along the front wall (the old doorway walled up round it) and in it goes; no digging in outside.
{
  const g = makeGame();
  g.set(g.fur.door, 'bedrock'); g.set({ ...g.fur.door, y: g.fur.door.y + 1 }, 'bedrock');
  g.set(g.fur.doorstep, 'bedrock'); g.set({ ...g.fur.doorstep, y: g.fur.doorstep.y + 1 }, 'bedrock');
  setNight(true);
  let got = false, waited = 0;
  g.S.wait = async (gen, n) => { system.advance(n); waited += n; if (inside(g)) { got = true; setNight(false); } else if (waited > 4000) setNight(false); };
  await g.H.nightAtHome(0);
  if (!got) await g.H.nightAtHome(0);
  setNight(false);
  report("doorway blocked by what can't be broken", got && (g.house.doorLx ?? 0) !== 0 && g.sheltered() === 0, `door moved to ${g.house.doorLx ?? 0} along the wall; ${got ? 'got in' : 'NOT in'}; dug in outside ${g.sheltered()} time(s)`, g);
}

// 4. The wrong thing in our furniture's spots (a player's furnace where the table goes, a block on the bed).
{
  const g = makeGame();
  g.set(g.fur.table, 'furnace'); g.set(g.fur.bed.head, 'cobblestone'); g.set(g.fur.chests[2], 'glass');
  const st = g.H.houseStateNow();
  await g.H.clearHouse(0);
  const left = g.H.houseObstructions();
  report('wrong things in the furniture spots', st.blocked === 3 && !left.length && g.get(g.fur.table) === 'air' && g.get(g.fur.chests[0]) === 'chest',
    `${st.blocked} found, ${left.length} left; our own chests untouched: ${g.get(g.fur.chests[0])}`, g);
}

// 5. Water poured into the room: blocked off and dug out.
{
  const g = makeGame();
  g.give('dirt', 16);
  g.set({ ...g.fur.stand, x: g.fur.stand.x + 1 }, 'water');
  await g.H.clearHouse(0);
  report('water in the room', g.H.houseObstructions().length === 0, `left ${g.H.houseObstructions().length}`, g);
}

// 6. A creeper blew out the front: walls, the doorstep's ground and a chest gone, its things on the ground.
{
  const g = makeGame();
  g.give('cobblestone', 40); g.give('oak_planks', 40);
  const front = blueprint(g.house, g.house.dir).filter((b) => Math.abs(b.x - g.fur.door.x) + Math.abs(b.z - g.fur.door.z) <= 2 && b.y <= 65);
  for (const b of front) g.set(b, 'air');
  for (const p of footing(g.house, g.house.dir).slice(-4)) g.set(p, 'air');
  g.set(g.fur.chests[3], 'air');
  for (let i = 0; i < 6; i++) g.items.push({ id: `spill${i}`, isValid: true, location: { x: g.house.x + i - 3, y: 64, z: g.house.z + 4 }, what: 'cobblestone' });
  const st = g.H.houseStateNow();
  const plan = settleStep({ ...houseFacts(g.H), inv: { cobblestone: 40, oak_planks: 40 } }).step;
  await g.H.repairHouse(0);
  const spilled = g.items.filter((e) => /^spill/.test(e.id));
  report('creeper blast at the front', plan === 'repair_house' && st.damage > 0 && spilled.every((e) => !e.isValid) && g.H.houseDamage().length === 0,
    `plan ${plan}; ${st.damage} holes, ${g.H.houseDamage().length} left; chest's things picked up ${spilled.filter((e) => !e.isValid).length}/${spilled.length}`, g);
}

// 7. The house on fire: flames on the roof and against the walls, day or night: all punched out.
{
  const g = makeGame();
  const bp = blueprint(g.house, g.house.dir);
  const roof = bp.filter((b) => b.h === 3);
  const fires = [...roof.slice(0, 5).map((b) => ({ ...b, y: b.y + 1 })), { x: g.house.x + 3, y: 64, z: g.house.z - 2 }, { x: g.house.x - 3, y: 65, z: g.house.z - 4 }];
  for (const f of fires) g.set(f, 'fire');
  const plan = settleStep({ ...houseFacts(g.H), time: 14000 }).step;
  await g.H.fightFire(0);
  const left = g.H.houseFires().length;
  report('house on fire', plan === 'fight_fire' && left === 0, `plan at night: ${plan}; ${fires.length} flames, ${left} left`, g);
}

// 8. A clean house: nothing to do.
{
  const g = makeGame();
  const st = g.H.houseStateNow();
  report('clean house', st.blocked === 0 && st.fire === 0 && st.damage === 0, `blocked ${st.blocked}, fire ${st.fire}, damage ${st.damage}`, g);
}

// 9. Obsidian where the crafting table goes (no diamond pickaxe): never swung at; the table's spot
// moves to a free one in the room, out of the way through.
{
  const g = makeGame();
  g.set(g.fur.table, 'obsidian');
  const before = g.H.houseStateNow().blocked;
  await g.H.clearHouse(0);
  const fur = furnishings(g.house, g.house.dir);
  const moved = key(fur.table) !== key(g.fur.table);
  const left = g.H.houseObstructions().filter((c) => c.want !== 'crafting_table');
  report('obsidian on the table\'s spot', before === 1 && moved && g.get(g.fur.table) === 'obsidian' && !left.length && g.standable(fur.stand), `table's spot ${moved ? `moved to ${key(fur.table)}` : 'NOT moved'}; obsidian ${g.get(g.fur.table)}; ${left.length} other things in the way; the stand still clear: ${g.standable(fur.stand)}`, g);
}

// 10. Obsidian somewhere harmless (over the furnace, head height by the wall): left be; the house
// no longer counts as blocked (it used to try, fail, and come back every 3 minutes).
{
  const g = makeGame();
  const spot = { ...g.fur.furnace, y: g.fur.furnace.y + 1 };
  g.set(spot, 'obsidian');
  await g.H.clearHouse(0);
  const st = g.H.houseStateNow();
  report('obsidian somewhere harmless', st.blocked === 0 && (g.house.doorLx ?? 0) === 0 && !Object.keys(g.house.moved ?? {}).length, `blocked ${st.blocked}; door ${g.house.doorLx ?? 0}; moved ${JSON.stringify(g.house.moved ?? {})}`, g);
}

// 11. Obsidian in the chest room's doorway: the doorway moves along the partition.
{
  const g = makeGame();
  const fur0 = furnishings(g.house, g.house.dir);
  g.set(fur0.doorway, 'obsidian');
  await g.H.clearHouse(0);
  const fur = furnishings(g.house, g.house.dir);
  report('obsidian in the chest room\'s doorway', (g.house.doorwayLx ?? 0) !== 0 && g.standable(fur.doorway) && g.H.houseObstructions().length === 0, `doorway moved to ${g.house.doorwayLx ?? 0}; the new one open: ${g.standable(fur.doorway)}; left in the way ${g.H.houseObstructions().length}`, g);
}

// 12. With a diamond pickaxe: the obsidian's mined (and kept), nothing moved.
{
  const g = makeGame();
  g.give('diamond_pickaxe', 1);
  g.set(g.fur.table, 'obsidian');
  await g.H.clearHouse(0);
  report('obsidian, with a diamond pickaxe', g.get(g.fur.table) === 'air' && !Object.keys(g.house.moved ?? {}).length, `table's spot now ${g.get(g.fur.table)}; moved ${JSON.stringify(g.house.moved ?? {})}`, g);
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} as a player would expect`);
process.exit(pass === results.length ? 0 : 1);
