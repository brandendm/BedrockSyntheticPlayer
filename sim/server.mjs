// A stand-in for @minecraft/server (+ the GameTest SimulatedPlayer) that runs the bot's real game/ code in Node, on a virtual clock, against the physics in physics.js and the
// constants in params.js. tools/mock/server.mjs is the older, thinner one each sim_* tool builds its own world on; this one is meant to be the single engine (sim/README.md).
//
// What is real here: blocks (sim/world.js), the bodies' movement, a lead's pull, placing blocks, item use timing, the tick clock. What is not yet: mobs, fluids beyond a
// simple float, redstone, light, crafting. Anything the game code asks for that is not built answers undefined and is written to `engine.unimplemented`, so a run says
// exactly what the engine could not do (a gap in the simulator is a number in a report, never a silent wrong answer).
import { VoxelWorld } from './world.js';
import { loadParams } from './params.js';
import { move, fits } from './physics.js';

// ---------- the engine (one per process; reset() starts a fresh world) ----------
export const engine = {
  params: loadParams(), world: new VoxelWorld(), entities: [], players: [], unimplemented: new Map(), waiters: [], timeouts: [], intervals: [], nextId: 1,
  events: [], // [tick, kind, ...] anything a probe wants recorded
  reset({ params, floorY = 149 } = {}) {
    this.params = loadParams(params); this.world = new VoxelWorld({ floorY }); this.entities = []; this.players = []; this.waiters = []; this.timeouts = []; this.intervals = []; this.nextId = 1;
    this.unimplemented = new Map(); this.events = []; system.currentTick = 0; props.clear();
  },
  miss(what) { this.unimplemented.set(what, (this.unimplemented.get(what) ?? 0) + 1); },
  /** One tick: bodies move, then what was due runs. */
  step() {
    system.currentTick++;
    for (const e of this.entities) if (e.isValid && e.physics) { const p = [e.x, e.y, e.z]; e.physics(); e.dv = { x: e.x - p[0], y: e.y - p[1], z: e.z - p[2] }; }
    for (const t of [...this.intervals]) if (system.currentTick % t.every === 0) t.fn();
    for (let k = this.timeouts.length - 1; k >= 0; k--) if (this.timeouts[k].at <= system.currentTick) { const t = this.timeouts.splice(k, 1)[0]; try { t.fn(); } catch (e) { console.warn('[sim] timeout:', e); } }
    for (let k = this.waiters.length - 1; k >= 0; k--) if (this.waiters[k].at <= system.currentTick) { const w = this.waiters.splice(k, 1)[0]; w.resolve(); }
  },
  /** Run the world until `promise` settles (a flush of the microtasks between ticks, so awaiting code goes on). */
  async runUntil(promise, maxTicks = 20 * 600, flush = 6) {
    let done = false, val, err;
    promise.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; });
    const start = system.currentTick;
    while (!done && system.currentTick - start < maxTicks) {
      this.step();
      for (let i = 0; i < flush; i++) await new Promise((r) => setImmediate(r)); // let the awaiting code run on
    }
    if (!done) throw new Error(`the sim ran ${maxTicks} ticks without the task ending`);
    if (err) throw err;
    return val;
  },
};

const props = new Map();
const unimpl = (name, target) => new Proxy(target, {
  get(t, k, r) {
    if (k in t || typeof k === 'symbol' || k === 'then') return Reflect.get(t, k, r);
    engine.miss(`${name}.${String(k)}`);
    return () => undefined;
  },
});

// ---------- system / world ----------
export const system = {
  currentTick: 0,
  runTimeout(fn, ticks = 1) { const t = { at: system.currentTick + Math.max(1, ticks), fn }; engine.timeouts.push(t); return t; },
  run(fn) { return system.runTimeout(fn, 1); },
  runInterval(fn, every = 1) { const t = { every: Math.max(1, every), fn }; engine.intervals.push(t); return t; },
  clearRun(t) { engine.timeouts = engine.timeouts.filter((x) => x !== t); engine.intervals = engine.intervals.filter((x) => x !== t); },
  runJob(gen) { for (const _ of gen) { /* a tick each, in the game */ } return 0; },
  waitTicks(n = 1) { return new Promise((resolve) => engine.waiters.push({ at: system.currentTick + Math.max(1, Math.ceil(n)), resolve })); },
};
const eventsProxy = () => new Proxy({}, { get: () => ({ subscribe: (f) => f, unsubscribe() {} }) });
export const world = {
  getDynamicProperty: (k) => props.get(k), setDynamicProperty: (k, v) => props.set(k, v),
  getTimeOfDay: () => 6000, getAllPlayers: () => engine.players, getPlayers: () => engine.players, getDimension: () => dimension,
  afterEvents: eventsProxy(), beforeEvents: eventsProxy(), sendMessage() {}, getDay: () => 1,
};
export const Direction = { Up: 'Up', Down: 'Down', North: 'North', South: 'South', East: 'East', West: 'West' };
const NORMAL = { Up: [0, 1, 0], Down: [0, -1, 0], North: [0, 0, -1], South: [0, 0, 1], East: [1, 0, 0], West: [-1, 0, 0] };
export const EntityComponentTypes = { Inventory: 'minecraft:inventory', Equippable: 'minecraft:equippable', Health: 'minecraft:health', Leashable: 'minecraft:leashable', Rideable: 'minecraft:rideable', Riding: 'minecraft:riding' };
export const EquipmentSlot = { Head: 'Head', Chest: 'Chest', Legs: 'Legs', Feet: 'Feet', Offhand: 'Offhand', Mainhand: 'Mainhand' };
export const EnchantmentTypes = { get: () => undefined };
export const BlockPermutation = { resolve: (id) => ({ type: { id } }) };
export const BlockTypes = { get: (id) => ({ id }) };
export const ItemTypes = { get: (id) => ({ id }) };
export class BlockVolume { constructor(from, to) { this.from = from; this.to = to; } }
export class ItemStack {
  constructor(typeId, amount = 1) { this.typeId = typeId.startsWith('minecraft:') ? typeId : `minecraft:${typeId}`; this.amount = amount; this.maxAmount = /(sword|pickaxe|axe|shovel|hoe|spear|boat|bucket|bed)$/.test(typeId) ? 1 : 64; }
  getComponent() { return undefined; }
  clone() { return new ItemStack(this.typeId, this.amount); }
}
export class Container {
  constructor(size = 36) { this.size = size; this.slots = new Array(size).fill(undefined); }
  get emptySlotsCount() { return this.slots.filter((s) => !s).length; }
  getItem(i) { const it = this.slots[i]; return it ? it.clone() : undefined; }
  setItem(i, it) { this.slots[i] = it ? it.clone() : undefined; }
  addItem(it) {
    let left = it.amount;
    for (let i = 0; i < this.size && left > 0; i++) { const s = this.slots[i]; if (s && s.typeId === it.typeId && s.amount < s.maxAmount) { const k = Math.min(s.maxAmount - s.amount, left); s.amount += k; left -= k; } }
    for (let i = 0; i < this.size && left > 0; i++) if (!this.slots[i]) { const k = Math.min(it.maxAmount, left); this.slots[i] = new ItemStack(it.typeId, k); left -= k; }
    return left > 0 ? new ItemStack(it.typeId, left) : undefined;
  }
  swapItems(a, b, other) { const o = other ?? this; const t = this.slots[a]; this.slots[a] = o.slots[b]; o.slots[b] = t; }
}

// ---------- blocks ----------
class Block {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; this.dimension = dimension; }
  get location() { if (!this.isValid) throw new Error('Failed to get property location: the entity is not valid'); return { x: this.x, y: this.y, z: this.z }; }
  get typeId() { return `minecraft:${engine.world.id(this.x, this.y, this.z)}`; }
  get isValid() { return true; }
  get isWaterlogged() { return false; }
  get isAir() { return engine.world.id(this.x, this.y, this.z) === 'air'; }
  get isLiquid() { return engine.world.isLiquid(this.x, this.y, this.z); }
  get isSolid() { return engine.world.height(this.x, this.y, this.z) > 0; }
  get permutation() { return { type: { id: this.typeId }, matches: (id) => this.typeId === id || this.typeId === `minecraft:${id}`, getAllStates: () => ({}) }; }
  above(n = 1) { return new Block(this.x, this.y + n, this.z); } below(n = 1) { return new Block(this.x, this.y - n, this.z); }
  north(n = 1) { return new Block(this.x, this.y, this.z - n); } south(n = 1) { return new Block(this.x, this.y, this.z + n); }
  east(n = 1) { return new Block(this.x + n, this.y, this.z); } west(n = 1) { return new Block(this.x - n, this.y, this.z); }
  getComponent() { return undefined; } hasTag() { return false; } canBeWaterlogged() { return false; }
  setType(t) { engine.world.set(this.x, this.y, this.z, typeof t === 'string' ? t : t.id); }
  setPermutation(p) { engine.world.set(this.x, this.y, this.z, p.type.id); }
}
const blockAt = (p) => unimpl('Block', new Block(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));

// ---------- entities ----------
class Entity {
  constructor(typeId, loc) {
    this.id = `e${engine.nextId++}`; this.typeId = typeId; this.x = loc.x; this.y = loc.y; this.z = loc.z; this.vx = 0; this.vy = 0; this.vz = 0; this.isValid = true; this.dv = null;
    this.tags = new Set(); this.dimension = dimension; this.onGround = false; this.rot = { x: 0, y: 0 };
  }
  get location() { return { x: this.x, y: this.y, z: this.z }; }
  set location(l) { this.x = l.x; this.y = l.y; this.z = l.z; }
  get isInWater() { return engine.world.isWater(this.x, this.y + 0.2, this.z); }
  get isOnGround() { return this.onGround; }
  getVelocity() { if (!this.isValid) throw new Error('the entity is not valid'); return this.dv ? { ...this.dv } : { x: this.vx, y: this.vy, z: this.vz }; } // (what the game reports: the last tick's movement)
  addTag(t) { this.tags.add(t); return true; } hasTag(t) { return this.tags.has(t); } removeTag(t) { return this.tags.delete(t); } getTags() { return [...this.tags]; }
  teleport(l) { this.x = l.x; this.y = l.y; this.z = l.z; this.vx = this.vy = this.vz = 0; }
  remove() { this.isValid = false; engine.entities = engine.entities.filter((e) => e !== this); }
  kill() { this.remove(); }
  applyImpulse(i) { this.vx += i.x; this.vy += i.y; this.vz += i.z; }
  getRotation() { return { ...this.rot }; } setRotation(r) { this.rot = { ...r }; }
  getHeadLocation() { return { x: this.x, y: this.y + 1.52, z: this.z }; }
  getViewDirection() { const y = this.rot.y * Math.PI / 180; return { x: -Math.sin(y), y: 0, z: Math.cos(y) }; }
  hasComponent() { return false; } getComponent() { return undefined; }
  runCommand(c) { return dimension.runCommand(c); }
}

export class Boat extends Entity {
  constructor(loc) { super('minecraft:boat', { ...loc, x: loc.x + engine.params.boat.spawnDx, z: loc.z + engine.params.boat.spawnDz }); this.holder = null; this.riders = []; this.peak = 0; }
  physics() {
    const P = engine.params, B = P.boat, L = P.leash, w = engine.world;
    const wet = w.isWater(this.x, this.y + 0.1, this.z);
    // the lead: a spring from the boat toward its holder once it is longer than `rest` (measured on the real game: tests/ sim/probes), the part along y scaled by kVertical
    if (this.holder && this.holder.isValid) {
      const h = this.holder, dx = h.x - this.x, dy = (h.y + 0.9) - (this.y + 0.25), dz = h.z - this.z, len = Math.hypot(dx, dy, dz);
      if (len > L.snap && this.snapOk !== false) { this.holder = null; engine.events.push([system.currentTick, 'lead-snapped', len]); }
      else if (len > L.rest) {
        // (probesling, real game: a boat pulled in goes at a speed proportional to how far past `rest` the lead is, reaching it over a couple of ticks, and ends at rest; it does not overshoot)
        const t = Math.min(L.maxPull, L.k * Math.pow(len - L.rest, L.pow));
        this.vx += (dx / len * t - this.vx) * L.blend; this.vz += (dz / len * t - this.vz) * L.blend; this.vy += (dy / len * t * L.kVertical - this.vy) * L.blend;
      }
      // past `yankAt` the lead also yanks (the Java game's: 0.4 times the square of each axis's share of the distance, toward the holder): what a sling is made of
      if (len > L.yankAt) { const ux = dx / len, uy = dy / len, uz = dz / len; this.vx += Math.sign(ux) * ux * ux * L.yank; this.vz += Math.sign(uz) * uz * uz * L.yank; this.vy += Math.sign(uy) * uy * uy * L.yank * L.kVertical; }
    }
    if (wet) { this.vy += (B.waterBuoyancy - (this.y - Math.floor(this.y + 0.1))) * 0.1; this.vy *= 0.8; this.vx *= 0.9; this.vz *= 0.9; }
    else if (!this.onGround) this.vy = (this.vy - B.gravity) * 0.98;
    const r = move(w, this, this.vx, this.vy, this.vz, { hw: B.halfWidth, h: B.height, step: B.step });
    if (r.hitX) this.vx *= B.wallKeep; if (r.hitZ) this.vz *= B.wallKeep; if (r.hitY) this.vy = 0; // (probelift: pressed against a wall the boat keeps the speed the lead gives it, and shoots off when it clears the lip)
    this.onGround = r.onGround;
    const f = this.onGround ? B.landFriction : B.airFriction;
    this.vx *= f; this.vz *= f;
    this.peak = Math.max(this.peak, Math.hypot(this.vx, this.vy, this.vz) * 20);
  }
  applyImpulse(i) { const k = engine.params.boat.impulse; this.vx += i.x * k; this.vy += i.y * k; this.vz += i.z * k; } // (a pushed boat moves about a third as far as the number says: probeslide)
  getComponent(c) {
    const self = this;
    if (c === 'minecraft:leashable') return {
      get isLeashed() { return !!self.holder && self.holder.isValid; }, get leashHolder() { return self.holder ?? undefined; },
      leashTo(e) { self.holder = e; return true; }, unleash() { self.holder = null; },
      softDistance: engine.params.leash.soft, hardDistance: engine.params.leash.hard, maxDistance: engine.params.leash.max,
    };
    if (c === 'minecraft:rideable') return { seatCount: 2, getRiders: () => self.riders, addRider(e) { self.riders.push(e); return true; }, ejectRider(e) { self.riders = self.riders.filter((r) => r !== e); } };
    return undefined;
  }
  hasComponent(c) { return c === 'minecraft:leashable' || c === 'minecraft:rideable'; }
}

const BLOCK_ITEM = /^(dirt|cobblestone|stone|grass_block|sand|gravel|netherrack|obsidian|glass|andesite|diorite|granite|deepslate|cobbled_deepslate|.*_planks|.*_log|.*_wool|.*_stone|.*_bricks|.*_slab|.*_stairs)$/;

export class SimPlayer extends Entity {
  constructor(loc, name = 'Scout') {
    super('minecraft:player', loc);
    this.name = name; this.inv = new Container(36); this.selectedSlotIndex = 0; this.isSneaking = false; this.isSprinting = false;
    this.target = null; this.dir = null; this.speed = 1; this.lastUse = -100; this.hp = 20; this.jumpQueued = false;
    return unimpl('SimPlayer', this);
  }
  getComponent(c) {
    if (c === 'minecraft:inventory') return { container: this.inv };
    if (c === 'minecraft:health') return { currentValue: this.hp, effectiveMax: 20, defaultValue: 20 };
    if (c === 'minecraft:riding') return undefined;
    return undefined;
  }
  hasComponent(c) { return c === 'minecraft:inventory'; }
  moveToLocation(l, o = {}) { this.target = { x: l.x, z: l.z }; this.speed = o.speed ?? 1; }
  navigateToLocation(l, s = 1) { this.moveToLocation(l, { speed: s }); return { isFullPath: true }; }
  stopMoving() { this.target = null; this.dir = null; }
  /** sim.move(westEast, northSouth, speed): keeps walking that way (+x east, +z south) until stopMoving or the next order. */
  move(wx, nz, speed = 1) { this.target = null; const h = Math.hypot(wx, nz); this.dir = h > 1e-6 ? { x: wx / h, z: nz / h, speed: 1 /* (probemove, real game: the speed argument changes nothing, move() always walks at full speed) */ } : null; }
  get isSleeping() { return false; } get isClimbing() { return false; } get isFalling() { return !this.onGround && this.vy < 0; }
  jump() { if (this.onGround) this.jumpQueued = true; }
  lookAtLocation() {} lookAtBlock() {} lookAtEntity() {}
  teleport(l) { super.teleport(l); this.target = null; this.dir = null; }
  runCommand(c) { return dimension.runCommand(c); }
  get isInWater() { return super.isInWater; }
  interactWithEntity(e) {
    const held = this.inv.getItem(this.selectedSlotIndex);
    if (held?.typeId === 'minecraft:lead' && e.getComponent?.('minecraft:leashable') && !e.holder && Math.hypot(e.x - this.x, e.z - this.z) < 6) { e.holder = this; return true; }
    return false;
  }
  interactWithBlock() { return false; }
  useItemInSlot() { return false; }
  /** Put a block item against a face of a block (the game takes one use in `useGapTicks`: a faster one is refused). */
  useItemInSlotOnBlock(slot, blockLoc, face = 'Up') {
    if (system.currentTick - this.lastUse < engine.params.item.useGapTicks) return false;
    const it = this.inv.getItem(slot);
    if (!it) return false;
    const id = it.typeId.replace('minecraft:', '');
    if (!BLOCK_ITEM.test(id)) return false;
    const n = NORMAL[face] ?? NORMAL.Up;
    const tx = Math.floor(blockLoc.x) + n[0], ty = Math.floor(blockLoc.y) + n[1], tz = Math.floor(blockLoc.z) + n[2];
    if (engine.world.height(Math.floor(blockLoc.x), Math.floor(blockLoc.y), Math.floor(blockLoc.z)) === 0 && !engine.world.isLiquid(Math.floor(blockLoc.x), Math.floor(blockLoc.y), Math.floor(blockLoc.z))) return false; // nothing to place against
    const here = engine.world.id(tx, ty, tz);
    if (here !== 'air' && !engine.world.isLiquid(tx, ty, tz)) return false;
    if (!fits(engine.world, this.x, this.y, this.z, engine.params.player.halfWidth, engine.params.player.height) === false) { /* free */ }
    // a block may not go into the body that stands in it
    const hw = engine.params.player.halfWidth;
    if (this.x + hw > tx && this.x - hw < tx + 1 && this.z + hw > tz && this.z - hw < tz + 1 && this.y < ty + 1 && this.y + 1.8 > ty) return false;
    engine.world.set(tx, ty, tz, id);
    this.lastUse = system.currentTick;
    it.amount -= 1; this.inv.setItem(slot, it.amount > 0 ? it : undefined);
    return true;
  }
  attackEntity() { return false; }
  physics() {
    const P = engine.params.player, w = engine.world;
    const ground = this.onGround, wet = this.isInWater;
    const f = ground ? P.groundFriction : P.airFriction;
    if (this.target) {
      const dx = this.target.x - this.x, dz = this.target.z - this.z, d = Math.hypot(dx, dz);
      if (d < 0.15) this.target = null;
      else {
        const a = (ground ? P.groundAccel : wet ? P.waterAccel : P.airAccel) * Math.min(1, this.speed);
        // (do not overshoot: the last step is at most the distance left)
        this.vx += dx / d * a; this.vz += dz / d * a;
        this.rot.y = Math.atan2(-dx, dz) * 180 / Math.PI;
      }
    }
    if (this.dir) {
      const a = (ground ? P.groundAccel : wet ? P.waterAccel : P.airAccel) * this.dir.speed;
      this.vx += this.dir.x * a; this.vz += this.dir.z * a;
      this.rot.y = Math.atan2(-this.dir.x, this.dir.z) * 180 / Math.PI;
    }
    if (this.jumpQueued && ground) { this.vy = P.jump; this.jumpQueued = false; } else this.jumpQueued = false;
    if (wet) {
      // (u307, fitted to the real game's probewater trace: a body that is deep in water is pushed up until its feet are about buoyDepth under the surface, where it floats;
      // a fast fall in is braked hard. Without this the sim sank a still body at 2 b/s where the real one floats.)
      let vy = this.vy * P.waterDrag - P.waterGravity;
      let top = Math.floor(this.y);
      while (top < Math.floor(this.y) + 40 && w.isWater(Math.floor(this.x), top + 1, Math.floor(this.z))) top++;
      const depth = top + 1 - this.y;
      if (this.vy < -0.3 && depth > P.brakeDepth) vy *= P.entryBrake;
      if (w.isWater(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) && depth > P.buoyDepth) vy += P.buoy;
      this.vy = vy;
    }
    const r = move(w, this, this.vx, this.vy, this.vz, { hw: P.halfWidth, h: P.height, step: ground ? P.step : 0 });
    if (r.hitX) this.vx = 0; if (r.hitZ) this.vz = 0;
    if (r.hitY) this.vy = r.onGround ? 0 : this.vy > 0 ? 0 : this.vy;
    this.onGround = r.onGround;
    if (this.onGround) this.vy = 0; else if (!wet) this.vy = (this.vy - P.gravity) * P.drag;
    this.vx *= f; this.vz *= f;
  }
}

// ---------- the dimension ----------
export const dimension = {
  id: 'minecraft:overworld',
  getBlock: (p) => blockAt(p),
  getTopmostBlock: (p) => { for (let y = 320; y > -64; y--) if (engine.world.height(Math.floor(p.x), y, Math.floor(p.z)) > 0) return blockAt({ x: p.x, y, z: p.z }); return blockAt({ x: p.x, y: -64, z: p.z }); },
  getEntities: (q = {}) => engine.entities.filter((e) => e.isValid
    && (!q.type || e.typeId === q.type) && (!q.location || !q.maxDistance || Math.hypot(e.x - q.location.x, e.y - q.location.y, e.z - q.location.z) <= q.maxDistance)
    && (!q.tags || q.tags.every((t) => e.tags.has(t)))),
  getPlayers: () => engine.players,
  spawnEntity(type, loc) {
    const e = /boat/.test(type) ? new Boat(loc) : new Entity(type, loc);
    engine.entities.push(e); return e;
  },
  runCommand(c) { if (!engine.world.command(c)) engine.miss(`command:${String(c).split(/\s+/)[0]}`); return { successCount: 1 }; },
  spawnItem() { engine.miss('spawnItem'); },
  fillBlocks() { engine.miss('fillBlocks'); },
};

/** The bot's body: a SimulatedPlayer standing at `loc`, in the engine's player list. */
export function spawnBot(loc, name = 'Scout') {
  const p = new SimPlayer(loc, name);
  engine.entities.push(p); engine.players.push(p);
  return p;
}
export const GameMode = { survival: 'survival', creative: 'creative' };
export const TimeOfDay = {};
export const MolangVariableMap = class {};
export const Player = SimPlayer;
export const Entity_ = Entity;
export const DisplaySlotId = { Sidebar: 'Sidebar', List: 'List', BelowName: 'BelowName' };
export const ObjectiveSortOrder = { Ascending: 0, Descending: 1 };
