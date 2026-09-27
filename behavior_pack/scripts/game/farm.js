// A wheat farm by the house: find water (or bring a bucket of it), till, plant, harvest, replant.
//
// Bedrock rules this follows: farmland stays wet with water within 4 blocks sideways, level with
// it or one block above; a hoe turns grass or dirt with air above into farmland; wheat seeds come
// from breaking grass (1 in 8) and from harvesting wheat (1-4 each); wheat is ripe at growth 7.
// One water block in the middle of a 5x5 keeps all 24 tiles around it wet.
import { system, Direction } from '@minecraft/server';
import { invCounts, hold } from './inventory.js';
import { dist3D } from '../core/mathutil.js';
import { trace } from './bridge.js';
import { isLog } from '../core/recipes.js';
import { PLANT } from './homestead.js';

const strip = (id) => id.replace('minecraft:', '');
const TILLABLE = /^(grass_block|dirt|coarse_dirt|dirt_with_roots)$/;
const GRASS = /^(short_grass|tall_grass|fern|large_fern)$/;
const isSeed = (id) => id === 'wheat_seeds';
const CLEAR = /^(air|short_grass|tall_grass|fern|large_fern|leaf_litter|.*_flower|dandelion|poppy|snow_layer)$/;
const key = (p) => `${p.x},${p.y},${p.z}`;
const unkey = (k) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };

export class Farm {
  constructor(agent) {
    this.a = agent;
  }

  get S() { return this.a.skills; }
  get dim() { return this.a.dim; }
  get sim() { return this.a.sim; }
  get data() { return this.a.memory.data; }
  get farm() { return this.data.farm ?? null; }

  /** Water source blocks (still, not flowing) at the surface near p, nearest first. */
  async waterNear(p, radius, below = 5) {
    // Centred on p (the house, say), not on wherever we happen to be standing (down the mine).
    const c = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const found = this.S.fastScan((id) => id === 'water', c, radius, below, 3, 48) ?? await this.S.scan((id) => id === 'water', { radius, below, above: 3, limit: 48 });
    const why = {};
    const out = found.filter((b) => {
      try {
        const blk = this.dim.getBlock(b);
        if (!blk) { why.unloaded = (why.unloaded ?? 0) + 1; return false; }
        if ((blk.permutation.getState('liquid_depth') ?? 0) !== 0) { why.flowing = (why.flowing ?? 0) + 1; return false; } // a source, not a flow
        // Out in the open, not a cave pool: sky light in the block above it.
        const above = this.dim.getBlock({ x: b.x, y: b.y + 1, z: b.z });
        if ((above?.getSkyLightLevel() ?? 15) < 8) { why.dark = (why.dark ?? 0) + 1; return false; }
        return true;
      } catch (e) { why.err = `${e}`; return false; }
    }).sort((a, c) => dist3D(p, a) - dist3D(p, c));
    if (!out.length) trace(`farm: water scan found ${found.length}, kept 0 (${JSON.stringify(why)})`);
    return out;
  }

  /** Nearest water the lookout has seen (a chunk with water samples), within `max` of p. */
  seenWater(p, max) {
    const look = this.a.lookout;
    if (!look) return null;
    let best = null;
    for (const r of look.rings ?? []) {
      if (r.kind !== 'water') continue;
      const d = Math.hypot(r.x - p.x, r.z - p.z);
      if (d <= max && (!best || d < best.d)) best = { x: r.x, y: r.y + 1, z: r.z, d };
    }
    if (best) return best;
    for (const [k, c] of look.map ?? []) {
      if (!c.w) continue;
      const [cx, cz] = k.split(',').map(Number);
      const x = cx * 16 + 8, z = cz * 16 + 8, d = Math.hypot(x - p.x, z - p.z);
      if (d <= max && (!best || d < best.d)) best = { x, y: p.y, z, d };
    }
    return best;
  }

  /** Is there usable water within 24 blocks of the house? Remembered (it doesn't move). */
  async checkWater(gen) {
    const h = this.a.homestead?.house;
    if (!h) return null;
    if (dist3D(this.sim.location, h) > 40) await this.S.goNear(gen, h, 6, 2);
    const all = await this.waterNear(h, 24);
    const w = all.filter((b) => Math.abs(b.y - h.y) <= 4 && this.landAround(b).length >= 8);
    if (all.length && !w.length) trace(`farm: ${all.length} water near the house, none usable; nearest ${all[0].x} ${all[0].y} ${all[0].z} (house y ${h.y}, land around it ${this.landAround(all[0]).length})`);
    this.data.waterNearHouse = w.length > 0;
    this.data.farmWater = w[0] ? { x: w[0].x, y: w[0].y, z: w[0].z } : null;
    this.a.memory.save();
    trace(`farm: water near the house: ${w.length ? `yes, ${w[0].x} ${w[0].y} ${w[0].z}` : 'none within 24'}`);
    return this.data.waterNearHouse;
  }

  /** Tillable ground level with water block w, within 4 of it, air above, clear of our things. */
  landAround(w) {
    const S = this.S, out = [];
    const h = this.a.homestead?.house;
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      const c = { x: w.x + dx, y: w.y, z: w.z + dz };
      if (!TILLABLE.test(S.blockAt(c) ?? '')) continue;
      if (!CLEAR.test(S.blockAt({ ...c, y: c.y + 1 }) ?? 'stone')) continue;
      if (h && Math.abs(c.x - h.x) <= 3 && Math.abs(c.z - h.z) <= 4) continue; // the house and its doorstep
      if (S.isProtected(c)) continue;
      out.push(c);
    }
    return out.sort((a, b) => dist3D(a, w) - dist3D(b, w));
  }

  /**
   * Make the farm. water 'near': around the water we found by the house. 'bucket': a 2x2 pool of
   * water that never runs out beside a flat patch by the house, and the farm's water from it.
   * Either way: trees on or over it come down first (logs kept), and torches go round it.
   */
  async make(gen, mode, tiles = 24) {
    const S = this.S;
    let w = mode === 'near' ? this.data.farmWater : null;
    if (mode === 'bucket') w = await this.bucketWater(gen);
    if (!w) { S.log('farm: no water to farm by'); return false; }
    // Trees in the way: they block the harvest and the light. Down they come (the logs are ours).
    await this.clearTrees(gen, w);
    await this.gatherSeeds(gen, Math.min(tiles, 12));
    const cells = this.landAround(w).slice(0, tiles);
    if (!cells.length) { S.log('farm: no tillable ground around the water'); return false; }
    this.data.farm = { water: w, tiles: cells.map(key), made: Date.now(), mode, cleared: true, pool: this.data.farmPool ?? null };
    this.a.memory.save();
    this.a.say(`Starting a wheat farm: ${cells.length} tiles by the ${mode === 'near' ? 'water' : 'water I brought'}.`);
    await this.lightFarm(gen);
    await this.tend(gen);
    return true;
  }

  // ---------- water: fetching it, and a pool that never runs out ----------

  /** Fill the bucket at the nearest water (up to 80 blocks round the house, or water seen further). */
  async fetchWater(gen, avoid = []) {
    const S = this.S, h = this.a.homestead?.house;
    // Never the farm's own water (that's what keeps it wet), nor a pool we're still filling (moving
    // its one source from corner to corner gets nowhere).
    const skip = new Set([...avoid, ...(this.farm ? [this.farm.water] : [])].map(key));
    const ok = (b) => !skip.has(key(b));
    if (invCounts(this.sim).water_bucket) return true;
    if (!invCounts(this.sim).bucket) return false;
    if (S.isUnderground()) await S.toSurface(gen);
    // Our own pool first: that's what it's for.
    const pool = (this.farm?.pool ?? this.data.farmPool ?? []).map(unkey).find((c) => ok(c) && /water/.test(S.blockAt(c) ?? ''));
    // One wide look around the house (the fast block query makes 80 blocks cheap, and it only
    // runs once per farm), nearest to the house first.
    let src = pool ?? (await this.waterNear(h ?? this.sim.location, 80, 16)).filter(ok)[0]; // down to the sea or a lake below a hilltop house
    if (!src) {
      // Water we've seen further off (the lookout's chunk map): walk over and look there.
      const far = this.seenWater(h ?? this.sim.location, 200);
      if (far) {
        S.log(`farm: no water within 80; heading for water seen ${Math.round(far.d)} away`);
        await S.travelToward(gen, far, Math.ceil(far.d / 40) + 2);
        S.check(gen);
        src = (await this.waterNear(this.sim.location, 32)).filter(ok)[0];
      }
    }
    if (!src) { S.log('farm: no water within reach to fill the bucket'); this.a.sayOnce('farm-water', "I need water for a farm and there's none close: I'll keep an eye out.", 300000); return false; }
    if (!S.inReach(src) && !(await S.goNear(gen, { x: src.x + 0.5, y: src.y + 1, z: src.z + 0.5 }, 2.5, 3))) return false;
    const got = await this.scoop(gen, src);
    S.log(`farm: bucket ${got ? 'filled' : 'not filled'} at ${src.x} ${src.y} ${src.z}`);
    return got;
  }

  /** Scoop the water source at `src` into our bucket. */
  async scoop(gen, src) {
    const slot = hold(this.sim, 'bucket');
    if (slot < 0) return false;
    await this.a.motor.lookAt({ x: src.x + 0.5, y: src.y + 0.9, z: src.z + 0.5 }, 1, 8);
    try { this.sim.useItemInSlotOnBlock(slot, src, Direction.Up); } catch {}
    await this.S.wait(gen, 4);
    if (!invCounts(this.sim).water_bucket) { try { this.sim.useItemInSlot(slot); } catch {} await this.S.wait(gen, 4); }
    this.a.cellChanged?.();
    return !!invCounts(this.sim).water_bucket;
  }

  /** Pour our water bucket into the (empty, dug-out) cell. */
  async pour(gen, cell) {
    const S = this.S;
    if (!S.inReach(cell)) await S.goNear(gen, { x: cell.x + 0.5, y: cell.y + 1, z: cell.z + 0.5 }, 2.5, 2);
    const slot = hold(this.sim, 'water_bucket');
    if (slot < 0) return false;
    await this.a.motor.lookAt({ x: cell.x + 0.5, y: cell.y + 0.1, z: cell.z + 0.5 }, 1, 8);
    try { this.sim.useItemInSlotOnBlock(slot, { x: cell.x, y: cell.y - 1, z: cell.z }, Direction.Up); } catch {}
    await S.wait(gen, 4);
    S.restHands();
    this.a.cellChanged?.();
    return /water/.test(S.blockAt(cell) ?? '');
  }

  /**
   * Water by the house with one bucket: a 2x2 pool beside a flat patch (two buckets poured in
   * opposite corners fill all four for good: water you can always come back for, to widen the farm
   * or start another), then the farm's middle block dug out and filled from the pool.
   */
  async bucketWater(gen) {
    const S = this.S, h = this.a.homestead?.house;
    if (!h) return null;
    // The best spots by the house (most tillable ground level with them), a few tries.
    const spots = this.flatSpots(h);
    if (!spots.length) { S.log('farm: no spot near the house with 12+ tillable tiles level with it'); return null; }
    for (const spot of spots.slice(0, 4)) {
      S.check(gen);
      if (!(await S.goNear(gen, { x: spot.x + 1.5, y: spot.y + 1, z: spot.z + 0.5 }, 1.5, 3)) && !S.inReach(spot)) { S.log(`farm: couldn't get to ${spot.x} ${spot.y} ${spot.z}`); continue; }
      if (!(await S.mine(gen, spot, { collect: false }))) { S.log(`farm: couldn't dig the water hole at ${spot.x} ${spot.y} ${spot.z} (${S.blockAt(spot)})`); continue; }
      // The pool that never runs out, right beside it (two trips for water, once).
      const pool = await this.makePool(gen, spot);
      if (!invCounts(this.sim).water_bucket) {
        const src = pool?.find((c) => /water/.test(S.blockAt(c) ?? ''));
        if (src) { if (!S.inReach(src)) await S.goNear(gen, { x: src.x + 0.5, y: src.y + 1, z: src.z + 0.5 }, 2.5, 2); await this.scoop(gen, src); }
        if (!invCounts(this.sim).water_bucket && !(await this.fetchWater(gen))) return null;
      }
      const ok = await this.pour(gen, spot);
      S.log(`farm: water ${ok ? 'poured' : 'not poured'} at ${spot.x} ${spot.y} ${spot.z}`);
      if (ok) return spot;
    }
    return null;
  }

  /**
   * A 2x2 spot for the pool, 6-8 blocks from the farm's water (clear of its tiles): ground level
   * with it, solid under and all round (so the water stays in), nothing built.
   */
  poolSpot(w) {
    const S = this.S, h = this.a.homestead?.house;
    const solid = (c) => { const id = S.blockAt(c) ?? 'air'; return !CLEAR.test(id) && !/water|lava|leaves|log|farmland/.test(id); };
    let best = null;
    for (let dx = -8; dx <= 7; dx++) for (let dz = -8; dz <= 7; dz++) {
      const cells = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => ({ x: w.x + dx + a, y: w.y, z: w.z + dz + b }));
      if (cells.some((c) => Math.max(Math.abs(c.x - w.x), Math.abs(c.z - w.z)) < 6)) continue; // off the farm
      if (cells.some((c) => Math.max(Math.abs(c.x - w.x), Math.abs(c.z - w.z)) > 8)) continue;
      if (h && cells.some((c) => Math.abs(c.x - h.x) <= 4 && Math.abs(c.z - h.z) <= 4)) continue; // not by the walls
      if (!cells.every((c) => TILLABLE.test(S.blockAt(c) ?? '') && CLEAR.test(S.blockAt({ ...c, y: c.y + 1 }) ?? 'stone') && solid({ ...c, y: c.y - 1 }) && !S.isProtected(c))) continue;
      const ring = [];
      for (let a = -1; a <= 2; a++) for (let b = -1; b <= 2; b++) if (a < 0 || a > 1 || b < 0 || b > 1) ring.push({ x: w.x + dx + a, y: w.y, z: w.z + dz + b });
      if (!ring.every(solid)) continue;
      const d = Math.hypot(dx + 0.5, dz + 0.5) + (h ? Math.hypot(w.x + dx - h.x, w.z + dz - h.z) * 0.1 : 0);
      if (!best || d < best.d) best = { d, cells };
    }
    return best?.cells ?? null;
  }

  /** Dig the pool and fill it: a bucket in one corner, another in the opposite one. Returns its cells. */
  async makePool(gen, w) {
    const S = this.S;
    if (this.data.farmPool?.length) return this.data.farmPool.map(unkey);
    const cells = this.poolSpot(w);
    if (!cells) { S.log('farm: no spot for a pool next to the farm'); return null; }
    this.a.sayOnce('pool', 'Digging a little pool by the farm: water that never runs out.', 120000);
    for (const c of cells) {
      if (!S.inReach(c)) await S.goNear(gen, { x: c.x + 0.5, y: c.y + 1, z: c.z + 0.5 }, 2.5, 2);
      if (!(await S.mine(gen, c, { collect: true }))) { S.log(`farm: couldn't dig the pool at ${c.x} ${c.y} ${c.z}`); return null; }
    }
    for (const c of [cells[0], cells[3]]) {
      let source = false;
      try { source = /water/.test(S.blockAt(c) ?? '') && (this.dim.getBlock(c)?.permutation.getState('liquid_depth') ?? 1) === 0; } catch {}
      if (source) continue;
      if (!(await this.fetchWater(gen, [...cells, w]))) { S.log('farm: no water to fill the pool'); return null; }
      await S.goNear(gen, { x: c.x + 0.5, y: c.y + 1, z: c.z + 0.5 }, 2.5, 3);
      await this.pour(gen, c);
    }
    await S.wait(gen, 20);
    const full = cells.every((c) => /water/.test(S.blockAt(c) ?? ''));
    S.log(`farm: pool at ${cells[0].x} ${cells[0].y} ${cells[0].z} ${full ? 'full' : 'not full yet'}`);
    if (!full) return null;
    this.data.farmPool = cells.map(key);
    if (this.farm) this.farm.pool = this.data.farmPool;
    this.a.memory.save();
    this.a.say('Pool by the farm is full: water whenever I need it.');
    return cells;
  }

  /** Is the water we farm by already a pool or lake that refills (3+ sources close together)? */
  waterLasts(w) {
    let n = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      try {
        const b = this.dim.getBlock({ x: w.x + dx, y: w.y, z: w.z + dz });
        if (b && /water/.test(b.typeId) && (b.permutation.getState('liquid_depth') ?? 0) === 0) n++;
      } catch {}
    }
    return n >= 3;
  }

  // ---------- keeping the farm right: no trees over it, lit at night ----------

  /**
   * Trees standing on or right by the farm (trunks within 7 of its water, rooted near its level):
   * chopped down, logs kept, no sapling put back. Their leaves hanging low over the tiles go too;
   * the rest of the canopy decays by itself once the trunk's gone.
   */
  async clearTrees(gen, w) {
    const S = this.S;
    const cols = new Map();
    for (let dx = -7; dx <= 7; dx++) for (let dz = -7; dz <= 7; dz++) {
      for (let dy = -1; dy <= 3; dy++) {
        const p = { x: w.x + dx, y: w.y + dy, z: w.z + dz };
        if (!isLog(S.blockAt(p) ?? '')) continue;
        const k = `${p.x},${p.z}`;
        if (!cols.has(k)) cols.set(k, p);
        break; // the lowest log in this column is the trunk's foot
      }
    }
    // Only real trees (leaves round the top of the trunk): never a log wall someone built.
    const isTree = (p) => {
      let top = p.y;
      while (top < p.y + 30 && isLog(S.blockAt({ x: p.x, y: top + 1, z: p.z }) ?? '')) top++;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) {
        if (/leaves$/.test(S.blockAt({ x: p.x + dx, y: top + dy, z: p.z + dz }) ?? '')) return true;
      }
      return false;
    };
    const trunks = [...cols.values()].filter((p) => !S.isProtected(p) && isTree(p)).sort((a, b) => dist3D(a, this.sim.location) - dist3D(b, this.sim.location));
    if (!trunks.length) return 0;
    this.a.sayOnce('farm-trees', `${trunks.length > 1 ? `${trunks.length} trees are` : 'A tree is'} in the way of the farm (shade, and in the way at harvest): chopping ${trunks.length > 1 ? 'them' : 'it'} down.`, 120000);
    let n = 0;
    for (const t of trunks) {
      S.check(gen);
      if (!isLog(S.blockAt(t) ?? '')) continue;
      const r = await S.chopTree(gen, t, { replant: false });
      if (r.chopped) n++;
    }
    // Low leaves over the tiles (within 3 of the ground): in the way when harvesting.
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      for (let dy = 1; dy <= 3; dy++) {
        const p = { x: w.x + dx, y: w.y + dy, z: w.z + dz };
        if (!/leaves$/.test(S.blockAt(p) ?? '')) continue;
        if (!S.inReach(p)) await S.goNear(gen, { x: p.x + 0.5, y: w.y + 1, z: p.z + 0.5 }, 2.5, 1);
        if (S.inReach(p)) await S.mine(gen, p, { collect: false });
      }
    }
    S.log(`farm: chopped ${n} tree${n === 1 ? '' : 's'} by the farm`);
    return n;
  }

  /**
   * Torches round the farm, so the wheat grows at night too (crops need light 9+). One in the middle
   * of each side, a block beyond the last tile: light 14 falls off a level a block, so every tile of
   * the 9x9 is within 5 of one of them (9 or more).
   */
  torchSpots(w) {
    const S = this.S, out = [];
    for (const [ox, oz] of [[5, 0], [-5, 0], [0, 5], [0, -5]]) {
      // The spot itself, else one along the side: ground within a block of the farm's level,
      // room for the torch (a plant there is fine: it gets broken), not a tile, not water.
      const alts = ox ? [[ox, 0], [ox, 1], [ox, -1]] : [[0, oz], [1, oz], [-1, oz]];
      let spot = null;
      for (const [ax, az] of alts) {
        for (const dy of [0, 1, -1]) {
          const g = { x: w.x + ax, y: w.y + dy, z: w.z + az };
          const gid = S.blockAt(g) ?? 'air', cell = { ...g, y: g.y + 1 }, cid = S.blockAt(cell) ?? 'stone';
          if (CLEAR.test(gid) || /water|lava|farmland|leaves|glass|fence|wall|torch/.test(gid)) continue;
          if (cid !== 'air' && !PLANT.test(cid) && !/torch/.test(cid)) continue;
          spot = { cell, on: g };
          break;
        }
        if (spot) break;
      }
      if (spot) out.push(spot);
    }
    return out;
  }

  /** Put up the farm's torches (making some from coal or charcoal if we're out). True if all are up. */
  async lightFarm(gen) {
    const S = this.S, f = this.farm;
    if (!f) return false;
    const spots = this.torchSpots(f.water);
    const todo = spots.filter((s) => !/torch/.test(S.blockAt(s.cell) ?? ''));
    if (!todo.length) { f.lit = true; this.a.memory.save(); return true; }
    if ((invCounts(this.sim).torch ?? 0) < todo.length) {
      const inv = invCounts(this.sim);
      if ((inv.charcoal ?? 0) + (inv.coal ?? 0) > 0) await S.craft(gen, ['torch'], false, true);
    }
    let ok = 0;
    for (const s of todo) {
      if (!invCounts(this.sim).torch) break;
      if (!(await this.a.homestead.clearForTorch(gen, s.cell))) continue;
      if (!S.inReach(s.cell)) await S.goNear(gen, { x: s.cell.x + 0.5, y: s.cell.y, z: s.cell.z + 0.5 }, 2.5, 2);
      if (await this.a.homestead.placeAt(gen, s.cell, 'torch', s.on)) ok++;
    }
    S.restHands();
    f.lit = ok === todo.length && spots.length === 4;
    f.litTriedAt = Date.now();
    this.a.memory.save();
    if (ok) this.a.say(`Put ${ok} torch${ok > 1 ? 'es' : ''} round the farm, so the wheat grows at night too.`);
    else this.a.sayOnce('farm-dark', 'The farm needs torches and I have none: I\'ll light it when I have some.', 600000);
    return f.lit;
  }

  /** Anything the farm is missing: trees over it, torches round it, a pool by it (bucket farms). */
  needsUpkeep() {
    const f = this.farm;
    if (!f || Date.now() - (f.upkeepAt ?? 0) < 600000) return false; // at most every 10 minutes
    if (!f.cleared) return true;
    const torchesMissing = this.torchSpots(f.water).some((s) => !/torch/.test(this.S.blockAt(s.cell) ?? ''));
    const inv = invCounts(this.sim);
    if (torchesMissing && ((inv.torch ?? 0) > 0 || (inv.charcoal ?? 0) + (inv.coal ?? 0) > 0)) return true;
    if (!f.pool && (f.poolTries ?? 0) < 2 && !this.waterLasts(f.water) && (inv.bucket || inv.water_bucket)) return true;
    return false;
  }

  async upkeep(gen) {
    const f = this.farm;
    if (!f) return;
    f.upkeepAt = Date.now();
    this.a.memory.save();
    if (!f.cleared) { await this.clearTrees(gen, f.water); f.cleared = true; this.a.memory.save(); }
    await this.lightFarm(gen);
    if (!f.pool && (f.poolTries ?? 0) < 2 && !this.waterLasts(f.water) && (invCounts(this.sim).bucket || invCounts(this.sim).water_bucket)) {
      f.poolTries = (f.poolTries ?? 0) + 1;
      this.a.memory.save();
      await this.makePool(gen, f.water);
    }
  }

  /**
   * Where to pour the water: tillable ground 6-20 blocks from the house with the most tillable,
   * clear ground level with it within 4 (what one water block keeps wet). Needn't be flat all
   * round: 12 tiles is plenty to start, the rest can come later.
   */
  flatSpots(h) {
    const S = this.S;
    const out = [];
    for (let dx = -20; dx <= 20; dx += 2) for (let dz = -20; dz <= 20; dz += 2) {
      const d = Math.hypot(dx, dz);
      if (d < 6 || d > 20) continue;
      const cx = h.x + dx, cz = h.z + dz;
      let top;
      try { top = this.dim.getTopmostBlock({ x: cx, z: cz }); } catch { continue; }
      if (!top || !TILLABLE.test(strip(top.typeId))) continue;
      const c = { x: cx, y: top.location.y, z: cz };
      if (S.isProtected(c)) continue;
      const tiles = this.landAround(c).length - 1; // the middle becomes the water
      // Near the house's own level too: a spot up a hill or down a bank is a climb every harvest.
      const score = tiles - d * 0.3 - Math.abs(c.y - h.y) * 1.5;
      if (tiles >= 12) out.push({ ...c, score });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * Wheat seeds from grass (1 in 8 drops one), until `want` seeds or ~60 s. Swiped through the way a
   * player does it, punch held, running through the patch (skills.swipePatch): not tuft by tuft with
   * a stop and a wait for a seed after each. Walking through picks most seeds up on the way; one
   * pass over where the grass was gets the rest, and the swipe carries on from there if it's short.
   */
  async gatherSeeds(gen, want) {
    const S = this.S;
    const t0 = system.currentTick;
    const seeds = () => invCounts(this.sim).wheat_seeds ?? 0;
    // Seeds still on the ground (not picked up yet) count toward enough: they're about to be ours.
    let lying = 0;
    const enough = () => seeds() + lying >= want;
    let broke = 0;
    for (let pass = 0; pass < 6 && !enough() && system.currentTick - t0 < 1800; pass++) {
      // (Seeds lying about counted every half second, not every swipe: it's an entity query.)
      let countedAt = -1;
      const done = () => {
        if (system.currentTick - countedAt >= 10) { lying = this.seedsAround(10); countedAt = system.currentTick; }
        return enough();
      };
      const r = await S.swipePatch(gen, (id) => GRASS.test(id), { radius: 8, rounds: 4, maxTicks: 400, minRest: 2, enough: done });
      broke += r.broke;
      // What dropped: a moment for the last ones to land and become pick-up-able, then one sweep.
      if (r.broke) {
        await S.wait(gen, 8);
        const c = this.sim.location;
        await S.sweep(gen, { x: c.x, y: c.y, z: c.z }, 10, isSeed, 12);
      }
      lying = 0;
      if (!r.broke) break; // no grass left round here
    }
    S.log(`farm: swiped ${broke} grass, have ${seeds()} seeds`);
    return seeds();
  }

  /** Wheat seed items on the ground within r of us (dropped, not picked up yet). */
  seedsAround(r) {
    const c = this.sim.location;
    return this.seedItemsNear({ x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) }, r).reduce((n, e) => { try { return n + (e.getComponent('minecraft:item')?.itemStack?.amount ?? 1); } catch { return n; } }, 0);
  }

  /** Wheat seed item stacks on the ground within r of p. */
  seedItemsNear(p, r) {
    try {
      return this.dim.getEntities({ type: 'minecraft:item', location: { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 }, maxDistance: r })
        .filter((e) => { try { return isSeed(strip(e.getComponent('minecraft:item')?.itemStack?.typeId ?? '')); } catch { return false; } });
    } catch { return []; }
  }

  /** The farm's state: tiles, planted, ripe (from the blocks; zeros if it isn't loaded). */
  state() {
    const f = this.farm;
    if (!f) return null;
    let planted = 0, ripe = 0, loaded = true;
    for (const k of f.tiles) {
      const t = unkey(k);
      let b;
      try { b = this.dim.getBlock({ ...t, y: t.y + 1 }); } catch { loaded = false; break; }
      if (!b) { loaded = false; break; }
      if (strip(b.typeId) === 'wheat') {
        planted++;
        try { if ((b.permutation.getState('growth') ?? 0) >= 7) ripe++; } catch {}
      }
    }
    const upkeep = loaded && this.needsUpkeep();
    return loaded ? { tiles: f.tiles.length, planted, ripe, upkeep } : { tiles: f.tiles.length, planted: this.lastPlanted ?? 0, ripe: 0, upkeep: false };
  }

  /** Harvest ripe wheat, re-till trampled tiles, plant seeds on every empty tile. */
  async tend(gen) {
    const S = this.S, f = this.farm;
    if (!f) return;
    if (this.needsUpkeep()) await this.upkeep(gen);
    // Tile to tile, nearest next from where we are: in the order they were found (by distance from
    // the water) it zig-zagged across the field.
    const left = f.tiles.map(unkey), tiles = [];
    let at = S.feet();
    while (left.length) {
      let bi = 0;
      for (let i = 1; i < left.length; i++) if (Math.hypot(left[i].x - at.x, left[i].z - at.z) < Math.hypot(left[bi].x - at.x, left[bi].z - at.z)) bi = i;
      at = left.splice(bi, 1)[0];
      tiles.push(at);
    }
    let harvested = 0, tilled = 0, planted = 0;
    for (let ti = 0; ti < tiles.length; ti++) {
      const t = tiles[ti];
      S.check(gen);
      const crop = { ...t, y: t.y + 1 };
      // The next tile: where the crosshair heads as each action here goes through (one leading into
      // the next along the rows, the way a player runs down a field).
      const nextTile = tiles[ti + 1] ?? null;
      const nextTop = nextTile ? { ...nextTile, y: nextTile.y + 1 } : null;
      let b;
      try { b = this.dim.getBlock(crop); } catch { continue; }
      if (b && strip(b.typeId) === 'wheat') {
        let g = 0;
        try { g = b.permutation.getState('growth') ?? 0; } catch {}
        if (g < 7) continue;
        if (!S.inReach(crop)) await S.goNear(gen, crop, 2.5, 2);
        if (await S.mine(gen, crop, { collect: false, next: crop })) harvested++; // (replant right here next)
      }
      const ground = S.blockAt(t) ?? '';
      if (TILLABLE.test(ground) && CLEAR.test(S.blockAt(crop) ?? 'stone')) {
        if (!S.inReach(t)) await S.goNear(gen, crop, 2.5, 2);
        // A hoe only tills with air on top: grass or a flower goes first (and may drop a seed).
        if ((S.blockAt(crop) ?? 'air') !== 'air') await S.mine(gen, crop, { collect: false });
        if (await this.useOn(gen, this.hoe(), t, crop)) tilled++;
      }
      if (S.blockAt(t) === 'farmland' && (S.blockAt(crop) ?? '') === 'air' && invCounts(this.sim).wheat_seeds) {
        if (!S.inReach(t)) await S.goNear(gen, crop, 2.5, 2);
        if (await this.useOn(gen, 'wheat_seeds', t, nextTop)) planted++;
      }
    }
    this.a.motor.setFocus(null);
    await S.sweep(gen, { x: f.water.x, y: f.water.y + 1, z: f.water.z }, 7, null, 10);
    S.restHands();
    this.lastPlanted = this.state()?.planted ?? 0;
    S.log(`farm: harvested ${harvested}, tilled ${tilled}, planted ${planted}`);
    if (harvested) this.a.say(`Harvested ${harvested} wheat and replanted.`);
  }

  hoe() {
    const inv = invCounts(this.sim);
    return ['iron_hoe', 'stone_hoe', 'wooden_hoe'].find((id) => inv[id]) ?? null;
  }

  /** Use an item on the top of a block (hoe on dirt, seeds on farmland). */
  async useOn(gen, itemId, block, next = null) {
    if (!itemId) return false;
    const slot = hold(this.sim, itemId);
    if (slot < 0) return false;
    const before = this.S.blockAt(block), above = this.S.blockAt({ ...block, y: block.y + 1 });
    // Crosshair near the top of it (no stop and settle), use, and on toward the next as it takes.
    await this.S.aim(gen, { x: block.x + 0.5, y: block.y + 1, z: block.z + 0.5 }, 15, 6);
    this.S.check(gen);
    try { this.sim.useItemInSlotOnBlock(slot, block, Direction.Up, { x: 0.5, y: 1, z: 0.5 }); } catch {}
    if (next) this.a.motor.setFocus({ x: next.x + 0.5, y: next.y + 0.1, z: next.z + 0.5 });
    const changed = () => this.S.blockAt(block) !== before || this.S.blockAt({ ...block, y: block.y + 1 }) !== above;
    for (let k = 0; k < 3; k++) { await this.S.wait(gen, 1); if (changed()) return true; }
    return false;
  }
}

