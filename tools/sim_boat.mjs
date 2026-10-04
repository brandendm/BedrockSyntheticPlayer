// Crossing a lake by boat: game/boating.js's own cross() (put the boat on the water, get in, push it across, get out, take it back into the
// pack), run in Node against a stand-in for the game (tools/mock/server.mjs): a 40-wide lake, a boat that takes an impulse and slows (8% a
// tick) and stops at the bank, a bot that boards by interacting with it. What it checks is the sequence and the time, not the physics: the
// u204 boatcross run took 46 s and never got in a boat (the lake had a strip of grass round it, the search ended in the water short of the
// far shore, and the first crossing code looked for water with a function that is never true for a block's name).
//
//   node tools/sim_boat.mjs [-v]
import { register } from 'node:module';
register('./mock/hooks.mjs', import.meta.url);
const MC = await import('@minecraft/server');
const { Boating } = await import('../behavior_pack/scripts/game/boating.js');
const { system, ItemStack, Container } = MC;
const VERBOSE = process.argv.includes('-v');

let pass = 0, fail = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (ok) pass++; else fail++; };
const flat = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);

const GY = 150, LAKE = { x1: 4, x2: 43, z: 9 };
/** One run: options { weapon, refuseItemUse (the game takes no boat from the item), refuseInteract }. */
async function run(opts = {}) {
  const pack = new Container(36);
  pack.setItem(0, new ItemStack('oak_boat', 1));
  if (opts.weapon) pack.setItem(1, new ItemStack('stone_sword', 1));
  const boats = [], items = [];
  const block = (x, y, z) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    if (Y > GY) return { typeId: 'minecraft:air', isAir: true, isLiquid: false };
    if (X >= LAKE.x1 && X <= LAKE.x2 && Math.abs(Z) <= LAKE.z && Y >= GY - 3) return { typeId: 'minecraft:water', isAir: false, isLiquid: true };
    return { typeId: 'minecraft:grass_block', isAir: false, isLiquid: false };
  };
  const dim = {
    id: 'minecraft:overworld',
    getBlock: (p) => block(p.x, p.y, p.z),
    getTopmostBlock: (p) => { const b = block(p.x, GY, p.z); return { ...b, location: { x: p.x, y: GY, z: p.z } }; },
    getEntities: (q) => (q?.type === 'minecraft:item' ? items : boats).filter((e) => e.isValid && (!q?.location || Math.hypot(e.location.x - q.location.x, e.location.z - q.location.z) <= (q.maxDistance ?? 1e9))),
    spawnEntity: (type, loc) => spawnBoat(type, loc),
  };
  const bot = {
    id: 'bot', typeId: 'minecraft:player', isValid: true, dimension: dim, location: { x: 3.5, y: GY + 1, z: 0.5 }, riding: null, selectedSlotIndex: 0,
    getComponent: (t) => (t === 'minecraft:inventory' ? { container: pack } : t === 'minecraft:riding' ? (bot.riding ? { entityRidingOn: bot.riding } : undefined) : undefined),
    lookAtLocation() {}, lookAtEntity() {}, stopMoving() {}, runCommand() {},
    useItemInSlotOnBlock(slot, cell) {
      const it = pack.getItem(slot);
      if (!it || !/boat/.test(it.typeId) || opts.refuseItemUse) return false;
      if (block(cell.x, cell.y, cell.z).typeId !== 'minecraft:water') return false;
      pack.setItem(slot, undefined);
      spawnBoat('minecraft:boat', { x: cell.x + 0.5, y: cell.y + 0.9, z: cell.z + 0.5 });
      return true;
    },
    useItemInSlot() { return false; },
    interactWithEntity(e) { if (!opts.refuseInteract && flat(e.location, bot.location) < 3.5 && e.riders.length < 2) { e.riders.push(bot); bot.riding = e; } },
    attackEntity(e) {
      e.hits = (e.hits ?? 0) + (opts.weapon && pack.getItem(bot.selectedSlotIndex)?.typeId === 'minecraft:stone_sword' ? 5 : 1);
      if (e.hits >= 5) { e.isValid = false; items.push({ id: `item${items.length}`, typeId: 'minecraft:item', isValid: true, location: { ...e.location }, getComponent: () => ({ itemStack: new ItemStack('oak_boat', 1) }) }); }
    },
  };
  function spawnBoat(type, loc) {
    const b = {
      id: `boat${boats.length}`, typeId: type, isValid: true, location: { ...loc }, v: { x: 0, y: 0, z: 0 }, riders: [], rot: 0,
      getVelocity() { return { ...b.v }; },
      applyImpulse(i) { b.v.x += i.x; b.v.z += i.z; },
      setRotation() {},
      getComponent: (c) => (c === 'minecraft:rideable' ? {
        seatCount: 2, getRiders: () => b.riders,
        addRider: (e) => { if (b.riders.length >= 2) return false; b.riders.push(e); e.riding = b; return true; },
        ejectRider: (e) => { b.riders = b.riders.filter((r) => r !== e); e.riding = null; e.location = { x: b.location.x, y: GY + 0.9, z: b.location.z }; },
      } : undefined),
    };
    boats.push(b);
    return b;
  }
  // The world, a tick at a time: boats slide and slow, stop at the banks, carry their riders; the bot picks up what lies at its feet.
  system.waitTicks = async (n) => {
    for (let i = 0; i < n; i++) {
      for (const b of boats) {
        if (!b.isValid) continue;
        b.v.x *= 0.92; b.v.z *= 0.92;
        const nx = b.location.x + b.v.x, nz = b.location.z + b.v.z;
        const wet = (x, z) => block(x, GY, z).isLiquid;
        // (a boat is 1.4 wide: its edge must stay over water)
        if (wet(nx + Math.sign(b.v.x) * 0.7, b.location.z) && Math.abs(nz) < LAKE.z + 1) { b.location.x = nx; b.location.z = nz; } else { b.v.x = 0; b.v.z *= 0.5; }
        for (const r of b.riders) r.location = { x: b.location.x, y: b.location.y + 0.2, z: b.location.z };
      }
      system.advance(1);
    }
  };
  const t0 = system.currentTick;
  const S = {
    check() {}, wait: (g, n) => system.waitTicks(n), useGap: async () => {}, feet: () => ({ x: Math.floor(bot.location.x), y: Math.floor(bot.location.y), z: Math.floor(bot.location.z) }),
    blockAt: (p) => block(p.x, p.y, p.z).typeId.replace('minecraft:', ''),
    async goNear(g, pos) { const d = flat(bot.location, pos); await system.waitTicks(Math.ceil(d / 5 * 20) + 2); if (!bot.riding) bot.location = { x: pos.x, y: pos.y, z: pos.z }; return true; },
    async sweep(g, near, r, pred) { for (const it of items) if (it.isValid && flat(it.location, bot.location) < 8) { it.isValid = false; pack.addItem(new ItemStack('oak_boat', 1)); } return 1; },
  };
  const a = {
    skills: S, sim: bot, dim, weaponId: opts.weapon ? 'stone_sword' : null, restHands() {}, sayOnce() {},
    boatUnder: (e) => e.riding ?? null,
    leaveBoat() { const b = bot.riding; if (!b) return false; b.getComponent('minecraft:rideable').ejectRider(bot); return true; },
  };
  const B = new Boating(a);
  const res = await B.cross(1, { x: 3.5, y: GY + 1, z: 0.5 }, { x: 45.5, y: GY + 1, z: 0.5 });
  const arrivedS = B.arrivedAt != null ? (B.arrivedAt - t0) / 20 : null;
  if (VERBOSE) console.log(JSON.stringify({ res, arrivedS, bot: bot.location, pack: pack.slots.filter(Boolean).map((s) => s.typeId) }));
  return { res, arrivedS, bot, pack, boats };
}

{
  const r = await run({ weapon: true });
  check(r.res.ok, `crosses the 40 block lake (${r.res.why || 'ok'})`);
  check(r.res.how.placed === 'item on the water' && r.res.how.boarded === 'interacted with it', `puts the boat on with the item and boards by interacting (${r.res.how.placed}, ${r.res.how.boarded})`);
  check(r.arrivedS !== null && r.arrivedS < 8, `stands ashore in under 8 s (${r.arrivedS} s)`);
  check(r.bot.location.x > 43, `ashore at the far bank (x ${r.bot.location.x.toFixed(1)})`);
  check(r.res.how.top > 5.5 && r.res.how.top < 8, `fastest ${r.res.how.top} b/s`);
  check(r.res.how.picked === 'back in the pack' && r.pack.getItem(0)?.typeId === 'minecraft:oak_boat' || r.pack.slots.some((s) => s?.typeId === 'minecraft:oak_boat'), `the boat is back in the pack (${r.res.how.picked})`);
}
{
  const r = await run({ refuseItemUse: true });
  check(r.res.ok && r.res.how.placed === 'by command', `the game takes no boat from the item: put by command, said so (${r.res.how.placed})`);
  check(r.res.how.top > 5.5, 'and it still crosses');
}
{
  const r = await run({ refuseInteract: true });
  check(r.res.ok && r.res.how.boarded === 'by the game call', `interacting does not seat it: the game's own call does (${r.res.how.boarded})`);
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
