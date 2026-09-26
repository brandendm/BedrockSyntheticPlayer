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

const strip = (id) => id.replace('minecraft:', '');
const TILLABLE = /^(grass_block|dirt|coarse_dirt|dirt_with_roots)$/;
const GRASS = /^(short_grass|tall_grass|fern|large_fern)$/;
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
   * Make the farm. water 'near': around the water we found by the house. 'bucket': fill the bucket
   * wherever there's water, dig a hole in the middle of a flat 5x5 by the house, pour it in.
   */
  async make(gen, mode, tiles = 24) {
    const S = this.S;
    let w = mode === 'near' ? this.data.farmWater : null;
    if (mode === 'bucket') w = await this.bucketWater(gen);
    if (!w) { S.log('farm: no water to farm by'); return false; }
    await this.gatherSeeds(gen, Math.min(tiles, 12));
    const cells = this.landAround(w).slice(0, tiles);
    if (!cells.length) { S.log('farm: no tillable ground around the water'); return false; }
    this.data.farm = { water: w, tiles: cells.map(key), made: Date.now() };
    this.a.memory.save();
    this.a.say(`Starting a wheat farm: ${cells.length} tiles by the ${mode === 'near' ? 'water' : 'water I brought'}.`);
    await this.tend(gen);
    return true;
  }

  /** Fill the bucket at the nearest water, dig a hole by the house, pour it in. Returns the water cell. */
  async bucketWater(gen) {
    const S = this.S, h = this.a.homestead?.house;
    if (!h) return null;
    if (!invCounts(this.sim).water_bucket) {
      if (S.isUnderground()) await S.toSurface(gen);
      // One wide look around the house (the fast block query makes 80 blocks cheap, and it only
      // runs once per farm), nearest to the house first.
      let src = (await this.waterNear(h, 80, 16))[0]; // down to the sea or a lake below a hilltop house
      if (!src) {
        // Water we've seen further off (the lookout's chunk map): walk over and look there.
        const far = this.seenWater(h, 200);
        if (far) {
          S.log(`farm: no water within 80; heading for water seen ${Math.round(far.d)} away`);
          await S.travelToward(gen, far, Math.ceil(far.d / 40) + 2);
          S.check(gen);
          src = (await this.waterNear(this.sim.location, 32))[0];
        }
      }
      if (!src) { S.log('farm: no water within reach to fill the bucket'); this.a.sayOnce('farm-water', "I need water for a farm and there's none close: I'll keep an eye out.", 300000); return null; }
      if (!(await S.goNear(gen, { x: src.x + 0.5, y: src.y + 1, z: src.z + 0.5 }, 2.5, 3))) return null;
      const slot = hold(this.sim, 'bucket');
      if (slot < 0) return null;
      await this.a.motor.lookAt({ x: src.x + 0.5, y: src.y + 0.9, z: src.z + 0.5 }, 1, 8);
      try { this.sim.useItemInSlotOnBlock(slot, src, Direction.Up); } catch {}
      await S.wait(gen, 4);
      if (!invCounts(this.sim).water_bucket) { try { this.sim.useItemInSlot(slot); } catch {} await S.wait(gen, 4); }
      S.log(`farm: bucket ${invCounts(this.sim).water_bucket ? 'filled' : 'not filled'} at ${src.x} ${src.y} ${src.z}`);
      if (!invCounts(this.sim).water_bucket) return null;
    }
    // The best spots by the house (most tillable ground level with them), a few tries.
    const spots = this.flatSpots(h);
    if (!spots.length) { S.log('farm: no spot near the house with 12+ tillable tiles level with it'); return null; }
    for (const spot of spots.slice(0, 4)) {
      S.check(gen);
      if (!(await S.goNear(gen, { x: spot.x + 1.5, y: spot.y + 1, z: spot.z + 0.5 }, 1.5, 3)) && !S.inReach(spot)) { S.log(`farm: couldn't get to ${spot.x} ${spot.y} ${spot.z}`); continue; }
      if (!(await S.mine(gen, spot, { collect: false }))) { S.log(`farm: couldn't dig the water hole at ${spot.x} ${spot.y} ${spot.z} (${S.blockAt(spot)})`); continue; }
      const slot = hold(this.sim, 'water_bucket');
      const below = { x: spot.x, y: spot.y - 1, z: spot.z };
      await this.a.motor.lookAt({ x: spot.x + 0.5, y: spot.y + 0.1, z: spot.z + 0.5 }, 1, 8);
      try { this.sim.useItemInSlotOnBlock(slot, below, Direction.Up); } catch {}
      await S.wait(gen, 4);
      const ok = /water/.test(S.blockAt(spot) ?? '');
      S.log(`farm: water ${ok ? 'poured' : 'not poured'} at ${spot.x} ${spot.y} ${spot.z}`);
      S.restHands();
      if (ok) return spot;
    }
    return null;
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

  /** Break grass nearby for wheat seeds (1 in 8), until `want` seeds or ~60 s. */
  async gatherSeeds(gen, want) {
    const S = this.S;
    const t0 = system.currentTick;
    const seeds = () => invCounts(this.sim).wheat_seeds ?? 0;
    let broke = 0;
    while (seeds() < want && system.currentTick - t0 < 1800) {
      const grass = (await S.scan((id) => GRASS.test(id), { radius: 32, below: 4, above: 4, limit: 24 }))
        .filter((b) => !this.a.memory.isUnreachable(b));
      if (!grass.length) break;
      for (const g of grass.slice(0, 12)) {
        S.check(gen);
        if (!GRASS.test(S.blockAt(g) ?? '')) continue;
        if (!S.inReach(g) && !(await S.goNear(gen, g, 2.5, 1))) { this.a.memory.markUnreachable(g, 300000); continue; }
        if (await S.mine(gen, g, { collect: false })) broke++;
        if (broke % 6 === 0) await S.sweep(gen, this.sim.location, 6, (id) => id === 'wheat_seeds', 4);
        if (seeds() >= want) break;
      }
      await S.sweep(gen, this.sim.location, 8, (id) => id === 'wheat_seeds', 6);
    }
    S.log(`farm: broke ${broke} grass, have ${seeds()} seeds`);
    return seeds();
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
    return loaded ? { tiles: f.tiles.length, planted, ripe } : { tiles: f.tiles.length, planted: this.lastPlanted ?? 0, ripe: 0 };
  }

  /** Harvest ripe wheat, re-till trampled tiles, plant seeds on every empty tile. */
  async tend(gen) {
    const S = this.S, f = this.farm;
    if (!f) return;
    const tiles = f.tiles.map(unkey);
    let harvested = 0, tilled = 0, planted = 0;
    for (const t of tiles) {
      S.check(gen);
      const crop = { ...t, y: t.y + 1 };
      let b;
      try { b = this.dim.getBlock(crop); } catch { continue; }
      if (b && strip(b.typeId) === 'wheat') {
        let g = 0;
        try { g = b.permutation.getState('growth') ?? 0; } catch {}
        if (g < 7) continue;
        if (!S.inReach(crop)) await S.goNear(gen, crop, 2.5, 2);
        if (await S.mine(gen, crop, { collect: false })) harvested++;
      }
      const ground = S.blockAt(t) ?? '';
      if (TILLABLE.test(ground) && CLEAR.test(S.blockAt(crop) ?? 'stone')) {
        if (!S.inReach(t)) await S.goNear(gen, crop, 2.5, 2);
        // A hoe only tills with air on top: grass or a flower goes first (and may drop a seed).
        if ((S.blockAt(crop) ?? 'air') !== 'air') await S.mine(gen, crop, { collect: false });
        if (await this.useOn(gen, this.hoe(), t)) tilled++;
      }
      if (S.blockAt(t) === 'farmland' && (S.blockAt(crop) ?? '') === 'air' && invCounts(this.sim).wheat_seeds) {
        if (!S.inReach(t)) await S.goNear(gen, crop, 2.5, 2);
        if (await this.useOn(gen, 'wheat_seeds', t)) planted++;
      }
    }
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
  async useOn(gen, itemId, block) {
    if (!itemId) return false;
    const slot = hold(this.sim, itemId);
    if (slot < 0) return false;
    const before = this.S.blockAt(block), above = this.S.blockAt({ ...block, y: block.y + 1 });
    await this.a.motor.lookAt({ x: block.x + 0.5, y: block.y + 1, z: block.z + 0.5 }, 1, 8);
    this.S.check(gen);
    try { this.sim.useItemInSlotOnBlock(slot, block, Direction.Up, { x: 0.5, y: 1, z: 0.5 }); } catch {}
    await this.S.wait(gen, 3);
    return this.S.blockAt(block) !== before || this.S.blockAt({ ...block, y: block.y + 1 }) !== above;
  }
}

