// The simulated world's blocks: a sparse map over a flat stone floor, with the collision shape of each block id. Commands (fill, setblock) edit it.

const SOLID_H = { slab: 0.5, snow_layer: 0.125, carpet: 0.0625, trapdoor: 0.1875 };
const PASS = /^(air|cave_air|void_air|short_grass|tall_grass|fern|torch|redstone_torch|sign|wall_sign|standing_sign|vine|ladder|sapling|flower|poppy|dandelion|seagrass|kelp|fire|rail)/;
const LIQUID = /^(water|flowing_water|lava|flowing_lava)$/;

export class VoxelWorld {
  /** @param {{ floorY?: number }} o  every column is stone up to and including floorY, air above (until a command says otherwise) */
  constructor({ floorY = 149 } = {}) { this.floorY = floorY; this.cells = new Map(); this.version = 0; }
  key(x, y, z) { return `${x},${y},${z}`; }
  id(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    const v = this.cells.get(this.key(x, y, z));
    if (v !== undefined) return v;
    return y <= this.floorY ? 'stone' : 'air';
  }
  set(x, y, z, id) { id = String(id).replace(/^minecraft:/, ''); this.cells.set(this.key(Math.floor(x), Math.floor(y), Math.floor(z)), id); this.version++; }
  /** How tall the solid part of the cell is (0 = nothing to stand on or bump into, 1 = a full block). */
  height(x, y, z) {
    const id = this.id(x, y, z);
    if (id === 'air' || PASS.test(id) || LIQUID.test(id)) return 0;
    for (const [k, h] of Object.entries(SOLID_H)) if (id.includes(k)) return h;
    return 1;
  }
  isLiquid(x, y, z) { return LIQUID.test(this.id(x, y, z)); }
  isWater(x, y, z) { return /water/.test(this.id(x, y, z)); }
  isAir(x, y, z) { return this.id(x, y, z) === 'air'; }
  /** The highest top surface (a y, fractional for slabs) in column x,z at or below `from`, or -Infinity. */
  surface(x, z, from) {
    for (let y = Math.floor(from); y > from - 40; y--) { const h = this.height(x, y, z); if (h > 0) return y + h; }
    return -Infinity;
  }
  /** A game command: fill, setblock (others ignored, returned false). */
  command(text) {
    const t = text.trim().replace(/^\//, '').split(/\s+/);
    const num = (s, rel = 0) => Number(s);
    if (t[0] === 'fill' && t.length >= 8) {
      const [x1, y1, z1, x2, y2, z2] = t.slice(1, 7).map(Number); const id = t[7].replace(/^minecraft:/, '');
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) this.set(x, y, z, id);
      return true;
    }
    if (t[0] === 'setblock' && t.length >= 5) { this.set(num(t[1]), num(t[2]), num(t[3]), t[4]); return true; }
    return false;
  }
}
