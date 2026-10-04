// A stand-in for @minecraft/server with a world that takes `fill` / `setblock` commands, for tools/sim_ironfarm.mjs (game/ironfarm.js runs in Node
// against it). The world's behaviour is set by `globalThis.__ifw.knobs`, so the sim can make the game awkward in the ways the builder
// has to cope with: signs that only hang the other way round, water that only spreads after a block update (or never), slabs under another name.
const G = (globalThis.__ifw ??= { grid: new Map(), log: [], tick: 0, knobs: {}, entities: [], players: [], intervals: [], awake: new Set() });
const key = (x, y, z) => `${x},${y},${z}`;
const SUPPORT = { 2: [0, 1], 3: [0, -1], 4: [1, 0], 5: [-1, 0] };
const KNOWN = new Set(['air', 'cobblestone', 'glass', 'composter', 'bed', 'hopper', 'chest', 'wall_sign', 'oak_wall_sign', 'spruce_wall_sign', 'torch', 'lava', 'water', 'flowing_water', 'cobblestone_slab', 'stone_block_slab', 'oak_slab', 'wooden_slab']);

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

const solidId = (id) => ['cobblestone', 'glass', 'composter', 'hopper', 'chest', 'bed'].includes(id) || id.endsWith('slab');
export const idAtCell = (x, y, z) => G.grid.get(key(x, y, z))?.id ?? 'air';

function neighbourChanged(x, y, z) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const nx = x + dx, ny = y + dy, nz = z + dz, c = G.grid.get(key(nx, ny, nz));
    if (!c) continue;
    if (c.id.endsWith('wall_sign')) {
      // A sign hangs on the block behind it; with nothing there it comes off at the next update. (knobs.invertSigns: the game names the side the other way round.)
      const f = G.knobs.invertSigns ? ({ 2: 3, 3: 2, 4: 5, 5: 4 })[c.states.facing_direction] : c.states.facing_direction;
      const off = SUPPORT[f];
      if (!off || !solidId(idAtCell(nx + off[0], ny, nz + off[1]))) { G.grid.delete(key(nx, ny, nz)); G.log.push(`sign popped off at ${nx},${ny},${nz}`); }
    }
    if (c.id === 'water' && (c.states?.liquid_depth ?? 0) === 0 && G.knobs.water === 'needsKick') G.awake.add(key(nx, ny, nz));
  }
}

function put(x, y, z, b) {
  if (b.id === 'air') G.grid.delete(key(x, y, z)); else G.grid.set(key(x, y, z), { id: b.id, states: b.states });
  if (b.id === 'bed' && b.states.head_piece_bit) G.grid.set(key(x, y, z - 1), { id: 'bed', states: { direction: 0, head_piece_bit: false } });
  if (b.id === 'water' && (b.states.liquid_depth ?? 0) === 0 && G.knobs.water !== 'never' && G.knobs.water !== 'needsKick') G.awake.add(key(x, y, z));
  neighbourChanged(x, y, z);
}

function acceptable(b) {
  if (!b || !KNOWN.has(b.id)) return false;
  if (G.knobs.noSlabName && G.knobs.noSlabName.includes(b.id)) return false;
  if (G.knobs.noSignName?.includes(b.id)) return false;
  return true;
}

class Dimension {
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
    throw new Error(`Syntax error: ${cmd}`);
  }
  getBlock(l) {
    const x = Math.floor(l.x), y = Math.floor(l.y), z = Math.floor(l.z);
    const c = G.grid.get(key(x, y, z));
    return {
      typeId: `minecraft:${c?.id ?? 'air'}`,
      permutation: { getState: (n) => c?.states?.[n] },
      getComponent: () => ({ container: { size: 27, getItem: () => undefined } }),
    };
  }
  getTopmostBlock({ x, z }) { const y = G.knobs.groundAt?.(x, z); return y === undefined ? undefined : { y }; }
  spawnEntity(type, loc) {
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
  getEntities({ type }) { return G.entities.filter((e) => e.isValid && (!type || e.typeId === type)); }
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
}

export const system = {
  get currentTick() { return G.tick; },
  runInterval(fn) { G.intervals.push(fn); return G.intervals.length; },
  clearRun() {},
  runTimeout() { return 0; },
  waitTicks(n) { for (let i = 0; i < n; i++) { G.tick++; if (G.tick % 4 === 0) spread(); } return Promise.resolve(); },
};
export const world = {
  sendMessage(m) { G.log.push(`CHAT ${String(m).replace(/§./g, '')}`); },
  getPlayers() { return G.players; },
  getAbsoluteTime: () => 0,
  getTimeOfDay: () => 6000,
};
export const dimension = new Dimension();
