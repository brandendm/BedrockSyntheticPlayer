// A stand-in for @minecraft/server with a world that takes `fill` / `setblock` commands, for tools/sim_ironfarm.mjs (game/ironfarm.js runs in Node
// against it). The world's behaviour is set by `globalThis.__ifw.knobs`, so the sim can make the game awkward in the ways the builder
// has to cope with: signs that only hang the other way round, water that only spreads after a block update (or never), slabs under another name,
// fence gates that refuse a state, read back shut or have no name at all.
const G = (globalThis.__ifw ??= { grid: new Map(), log: [], tick: 0, knobs: {}, entities: [], players: [], intervals: new Map(), nextInterval: 1, awake: new Set(), time: 0 });
const key = (x, y, z) => `${x},${y},${z}`;
const SUPPORT = { 2: [0, 1], 3: [0, -1], 4: [1, 0], 5: [-1, 0] };
const KNOWN = new Set(['air', 'cobblestone', 'dirt', 'stone', 'glass', 'composter', 'bed', 'hopper', 'chest', 'wall_sign', 'oak_wall_sign', 'spruce_wall_sign', 'torch', 'lava', 'water', 'flowing_water', 'cobblestone_slab', 'stone_block_slab', 'oak_slab', 'wooden_slab', 'campfire', 'wooden_door', 'oak_door', 'fence_gate', 'oak_fence_gate']);

function parseBlock(text) {
  const m = /^(?:minecraft:)?([a-z_]+)\s*(?:\[(.*)\])?$/.exec(text.trim());
  if (!m) return null;
  const states = {};
  if (m[2]) for (const part of m[2].split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    const name = k.replace(/"/g, '');
    states[name] = v.startsWith('"') ? v.replace(/"/g, '') : v === 'true' ? true : v === 'false' ? false : Number(v);
  }
  return { id: m[1], states };
}

/** A chest with another chest beside it facing the same way is half of a double chest (unless the game is made not to pair them). */
function pairedChest(x, y, z) {
  if (G.knobs.noPair) return false;
  const me = G.grid.get(key(x, y, z));
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const o = G.grid.get(key(x + dx, y, z + dz)); return o?.id === 'chest' && o.states?.['minecraft:cardinal_direction'] === me.states?.['minecraft:cardinal_direction']; });
}

const solidId = (id) => ['cobblestone', 'dirt', 'stone', 'glass', 'composter', 'hopper', 'chest', 'bed'].includes(id) || id.endsWith('slab');
export const idAtCell = (x, y, z) => G.grid.get(key(x, y, z))?.id ?? 'air';

function neighbourChanged(x, y, z, changed = '') {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const nx = x + dx, ny = y + dy, nz = z + dz, c = G.grid.get(key(nx, ny, nz));
    if (!c) continue;
    if (c.id.endsWith('wall_sign')) {
      // A sign hangs on the block behind it; with nothing there it comes off at the next update. (knobs.invertSigns: the game names the side the other way round.)
      const f = G.knobs.invertSigns ? ({ 2: 3, 3: 2, 4: 5, 5: 4 })[c.states.facing_direction] : c.states.facing_direction;
      const off = SUPPORT[f];
      if (!off || !solidId(idAtCell(nx + off[0], ny, nz + off[1]))) { G.grid.delete(key(nx, ny, nz)); G.log.push(`sign popped off at ${nx},${ny},${nz}`); }
    }
    // (a source made by a command wakes up only when something that is not water changes beside it)
    if (c.id === 'water' && (c.states?.liquid_depth ?? 0) === 0 && G.knobs.water === 'needsKick' && !changed.endsWith('water')) G.awake.add(key(nx, ny, nz));
  }
}

function put(x, y, z, b) {
  if (b.id.endsWith('fence_gate') && G.knobs.gateShut) b = { ...b, states: { ...b.states, open_bit: false } };       // (the game keeps it shut whatever it is told)
  if (b.id === 'water' && b.states?.liquid_depth === undefined) b = { ...b, states: { ...b.states, liquid_depth: 0 } };   // (the game's water source reads depth 0)
  if (b.id === 'air') G.grid.delete(key(x, y, z)); else G.grid.set(key(x, y, z), { id: b.id, states: b.states });
  if (b.id === 'bed' && b.states.head_piece_bit) G.grid.set(key(x, y, z - 1), { id: 'bed', states: { direction: 0, head_piece_bit: false } });
  if (b.id === 'water' && (b.states.liquid_depth ?? 0) === 0 && G.knobs.water !== 'never' && G.knobs.water !== 'needsKick') G.awake.add(key(x, y, z));
  neighbourChanged(x, y, z, b.id);
}

function acceptable(b) {
  if (!b || !KNOWN.has(b.id)) return false;
  if (G.knobs.noSlabName && G.knobs.noSlabName.includes(b.id)) return false;
  if (G.knobs.noSignName?.includes(b.id)) return false;
  if (G.knobs.noDoorName?.includes(b.id)) return false;
  if (G.knobs.noGateName?.includes(b.id)) return false;
  if (b.id.endsWith('fence_gate') && G.knobs.gateNoDirection && b.states && 'direction' in b.states) return false;   // (a game that has no such state)
  return true;
}

class Dimension {
  id = 'minecraft:overworld';
  heightRange = { min: -64, max: 320 };
  runCommand(cmd) {
    G.log.push(cmd.length > 100 ? `${cmd.slice(0, 100)}...` : cmd);
    let m = /^setblock (-?\d+) (-?\d+) (-?\d+) (.+)$/.exec(cmd);
    if (m) {
      const b = parseBlock(m[4]);
      if (!acceptable(b)) throw new Error(`Unknown block ${m[4]}`);
      const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (G.grid.get(key(x, y, z))?.id === b.id && JSON.stringify(G.grid.get(key(x, y, z)).states ?? {}) === JSON.stringify(b.states)) return { successCount: 0 };
      put(x, y, z, b); return { successCount: 1 };
    }
    m = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (.+)$/.exec(cmd);
    if (m) {
      const b = parseBlock(m[7]);
      if (!acceptable(b)) throw new Error(`Unknown block ${m[7]}`);
      const [x1, y1, z1, x2, y2, z2] = m.slice(1, 7).map(Number);
      let n = 0;
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
        const c = G.grid.get(key(x, y, z));
        if ((c?.id ?? 'air') === b.id) continue;
        put(x, y, z, b); n++;
      }
      return { successCount: n };
    }
    if (/^tickingarea (add|remove) /.test(cmd)) return { successCount: 1 };
    m = /^time (set|add) (-?\d+)$/.exec(cmd);
    if (m) { G.time = m[1] === 'set' ? Number(m[2]) : G.time + Number(m[2]); return { successCount: 1 }; }
    m = /^gamerule randomtickspeed (\d+)$/.exec(cmd);
    if (m) { G.rts = Number(m[1]); return { successCount: 1 }; }
    m = /^tick rate (\d+)$/.exec(cmd);
    if (m && G.knobs.tickRate) { G.tickRate = Number(m[1]); return { successCount: 1 }; }
    throw new Error(`Unknown command or syntax error: ${cmd}`);
  }
  getBlock(l) {
    const x = Math.floor(l.x), y = Math.floor(l.y), z = Math.floor(l.z);
    const c = G.grid.get(key(x, y, z));
    return {
      typeId: `minecraft:${c?.id ?? 'air'}`,
      permutation: { getState: (n) => c?.states?.[n] },
      getComponent: (n) => (n === 'minecraft:inventory' && c?.id === 'chest' ? { container: { size: pairedChest(x, y, z) ? 54 : 27, getItem: () => undefined } } : undefined),
    };
  }
  getTopmostBlock({ x, z }) { const y = G.knobs.groundAt ? G.knobs.groundAt(x, z) : 69; return y === undefined ? undefined : { y, location: { x, y, z } }; }
  spawnEntity(type, loc) {
    if (type === 'minecraft:iron_golem') {
      const e = { typeId: type, id: String(G.entities.length + 1), location: { ...loc }, isValid: true, isInWater: false, kill() { this.isValid = false; }, remove() { this.isValid = false; } };
      G.entities.push(e);
      return e;
    }
    const baby = G.entities.length % 5 === 0;
    const e = {
      typeId: type, id: String(G.entities.length + 1), location: { ...loc }, isValid: true, isInWater: false, baby,
      mark: baby ? 1 : (G.entities.length % 7 === 3 ? 2 : 0),
      triggerEvent(ev) { if (ev === 'minecraft:ageable_grow_up') { if (!this.baby) throw new Error('adult'); this.baby = false; } },
      kill() { this.isValid = false; }, remove() { this.isValid = false; },
      hasComponent(c) { return c === 'minecraft:is_baby' && this.baby; },
      getComponent(c) { return c === 'minecraft:mark_variant' ? { value: this.mark } : undefined; },
    };
    G.entities.push(e);
    return e;
  }
  getEntities({ type, families }) {
    const MONSTER = /zombie|skeleton|creeper|spider|witch|enderman|phantom|drowned|husk|stray/;
    return G.entities.filter((e) => e.isValid && (!type || e.typeId === type) && (!families || (families.includes('monster') && MONSTER.test(e.typeId))));
  }
}

/** Spread the water one ring: a source (or a flowing cell) fills its free horizontal neighbours one level deeper, up to 7. */
function spread() {
  const fresh = [];
  for (const k of G.awake) {
    const c = G.grid.get(k);
    if (!c || (c.id !== 'water' && c.id !== 'flowing_water')) { G.awake.delete(k); continue; }
    const [x, y, z] = k.split(',').map(Number);
    const d = c.states?.liquid_depth ?? 0;
    if (d >= 7) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nk = key(x + dx, y, z + dz);
      if (idAtCell(x + dx, y, z + dz) === 'air') fresh.push([nk, d + 1]);
    }
  }
  for (const [nk, d] of fresh) { if (!G.grid.has(nk)) { G.grid.set(nk, { id: 'flowing_water', states: { liquid_depth: d } }); G.awake.add(nk); } }
  convert();
}

/**
 * The game's infinite-water rule: a flowing cell with a solid block (or a source) under it that touches two sources, side by side, becomes a source.
 * One round per call, as the game does one per update; a layout with a ring of sources goes on round after round until the platform is all source
 * (u209). `G.knobs.noConversion` turns it off (to show that the sim notices the pooling).
 */
function convert() {
  if (G.knobs.noConversion) return;
  const src = (x, y, z) => { const c = G.grid.get(key(x, y, z)); return !!c && (c.id === 'water' || c.id === 'flowing_water') && (c.states?.liquid_depth ?? 0) === 0; };
  const made = [];
  for (const [k, c] of G.grid) {
    if (c.id !== 'flowing_water' && c.id !== 'water') continue;
    if ((c.states?.liquid_depth ?? 0) === 0) continue;
    const [x, y, z] = k.split(',').map(Number);
    if (!solidId(idAtCell(x, y - 1, z)) && !src(x, y - 1, z)) continue;
    let n = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (src(x + dx, y, z + dz)) n++;
    if (n >= 2) made.push(k);
  }
  for (const k of made) { G.grid.set(k, { id: 'water', states: { liquid_depth: 0 } }); G.awake.add(k); }
}

export const system = {
  get currentTick() { return G.tick; },
  runInterval(fn, period = 1) { const id = G.nextInterval++; G.intervals.set(id, { fn, period }); return id; },
  clearRun(id) { G.intervals.delete(id); },
  runTimeout() { return 0; },
  waitTicks(n) {
    for (let i = 0; i < n; i++) {
      G.tick++;
      if (G.tick % 4 === 0) spread();
      for (const { fn, period } of [...G.intervals.values()]) if (G.tick % period === 0) fn();
    }
    return Promise.resolve();
  },
};
export const world = {
  sendMessage(m) { G.log.push(`CHAT ${String(m).replace(/§./g, '')}`); },
  getPlayers() { return G.players; },
  get gameRules() { return { randomTickSpeed: G.rts ?? 1 }; },
  getAbsoluteTime: () => G.time,
  setAbsoluteTime(t) { G.time = t; },
  getTimeOfDay: () => G.time % 24000,
};
export const dimension = new Dimension();

// ---- what game/inventory.js needs of the module (the bot's pack), for tools/sim_farmbuild.mjs ----
export class ItemStack {
  constructor(typeId, amount = 1) { this.typeId = typeId.startsWith('minecraft:') ? typeId : `minecraft:${typeId}`; this.amount = amount; this.maxAmount = this.typeId.endsWith('bucket') ? 1 : 64; }
  getComponent() { return undefined; }
  clone() { return new ItemStack(this.typeId, this.amount); }
}
export class Container {
  constructor(size) { this.size = size; this.slots = new Array(size).fill(undefined); }
  getItem(i) { const it = this.slots[i]; return it ? it.clone() : undefined; }
  setItem(i, it) { this.slots[i] = it ? it.clone() : undefined; }
  clearAll() { this.slots.fill(undefined); }
  swapItems(a, b) { const t = this.slots[a]; this.slots[a] = this.slots[b]; this.slots[b] = t; }
  addItem(it) {
    let left = it.amount;
    for (let i = 0; i < this.size && left > 0; i++) { const s = this.slots[i]; if (s && s.typeId === it.typeId && s.amount < s.maxAmount) { const k = Math.min(s.maxAmount - s.amount, left); s.amount += k; left -= k; } }
    for (let i = 0; i < this.size && left > 0; i++) if (!this.slots[i]) { const k = Math.min(it.maxAmount, left); this.slots[i] = new ItemStack(it.typeId, k); left -= k; }
    return left > 0 ? new ItemStack(it.typeId, left) : undefined;
  }
}
export const EntityComponentTypes = { Inventory: 'minecraft:inventory', Equippable: 'minecraft:equippable' };
export const EquipmentSlot = { Head: 'Head', Chest: 'Chest', Legs: 'Legs', Feet: 'Feet', Offhand: 'Offhand', Mainhand: 'Mainhand' };
export const EnchantmentTypes = { get: () => undefined };
