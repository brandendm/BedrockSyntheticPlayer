// Cheap long-range vision and a sense of place (biomes, land and water around us).
//
// Every 3 s it glances at ~10 surface columns around the bot, out to 64 blocks (one
// getTopmostBlock and one ray each, so ~30 block reads a second). What it can actually see (line of sight to
// the top block) gets recorded per chunk: water, land, trees, bare stone, and the chunk's
// biome. Trees it sees far off are traced down to the trunk and remembered as logs; bare stone as
// stone, sheep and food animals out to 48 blocks. That's the "look around" a player does
// without walking over: where the forest is, which way the sea is, whether we're on an island.
//
// The chunk map is saved in its own world property (bounded to the most recent 600 chunks) so it
// never crowds out the main memory.
import { world, system } from '@minecraft/server';
import { classifyTop, traitsOf, biomeName, searchFor, onIsland } from '../core/biomes.js';
import { STONE_TARGETS, isLog } from '../core/recipes.js';
import { trace } from './bridge.js';
import { castRay } from './world.js';

const KEY = 'agent:map';
const MAX_CHUNKS = 600;
const RADII = [16, 24, 32, 44, 56, 64];
const PER_GLANCE = 10;
const strip = (id) => id.replace('minecraft:', '');
export const chunkKey = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;

export class Lookout {
  /** Set if a seed search ever ran long: never risk stalling the server with one again. */
  static seedSearchOff = false;

  constructor(agent) {
    this.a = agent;
    this.turn = 0;
    /** recent samples: [{ kind, x, y, z, dist, at }] (last ~2 min) */
    this.rings = [];
    /** chunkKey -> { b: biome id (short), w, l, t, s } */
    this.map = new Map();
    this.dirty = false;
    this.seedCache = new Map(); // want -> { pos, id, at } | { none: true, at }
    try {
      const raw = world.getDynamicProperty(KEY);
      if (typeof raw === 'string') for (const [k, v] of Object.entries(JSON.parse(raw))) this.map.set(k, v);
    } catch {}
  }

  get dim() { return this.a.dim; }

  /** Biome at a spot (cached per chunk; only works in loaded chunks). Short id, e.g. "plains". */
  biomeAt(x, z, y = 64) {
    const k = chunkKey(x, z);
    const c = this.map.get(k);
    if (c?.b) return c.b;
    let id = null;
    try { id = strip(this.dim.getBiome({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }).id); } catch { return null; }
    this.chunk(k).b = id;
    this.markDirty();
    return id;
  }

  here() {
    const p = this.a.sim.location;
    return this.biomeAt(p.x, p.z, p.y);
  }

  hereName() {
    const b = this.here();
    return b ? biomeName(b) : null;
  }

  chunk(k) {
    let c = this.map.get(k);
    if (!c) {
      c = { b: null, w: 0, l: 0, t: 0, s: 0 };
      this.map.set(k, c);
      if (this.map.size > MAX_CHUNKS) this.map.delete(this.map.keys().next().value);
    }
    return c;
  }

  markDirty() {
    if (this.dirty) return;
    this.dirty = true;
    system.runTimeout(() => {
      this.dirty = false;
      try { world.setDynamicProperty(KEY, JSON.stringify(Object.fromEntries(this.map))); } catch (e) { console.warn(`[agent] map save: ${e}`); }
    }, 200);
  }

  /** One glance: a handful of columns around us. Called every ~3 s from the agent's tick. */
  glance() {
    const sim = this.a.sim;
    let eye;
    try { eye = sim.getHeadLocation(); } catch { return; }
    const dim = this.dim, dimId = dim.id, now = Date.now();
    const mem = this.a.memory;
    this.turn++;
    const spin = (this.turn * 0.618) % 1; // golden-ratio rotation: covers every direction over time
    for (let i = 0; i < PER_GLANCE; i++) {
      const ang = ((i + spin) / PER_GLANCE) * Math.PI * 2;
      const r = RADII[(this.turn + i) % RADII.length];
      const x = Math.floor(eye.x + Math.cos(ang) * r), z = Math.floor(eye.z + Math.sin(ang) * r);
      let top;
      try { top = dim.getTopmostBlock({ x, z }); } catch { continue; } // not loaded
      if (!top) continue;
      const tl = top.location, id = strip(top.typeId);
      // Can we see it? Aim at the top face; anything in the way closer than it means no.
      const to = { x: tl.x + 0.5, y: tl.y + 1.02, z: tl.z + 0.5 };
      const d = { x: to.x - eye.x, y: to.y - eye.y, z: to.z - eye.z };
      const len = Math.hypot(d.x, d.y, d.z);
      let visible = true;
      try {
        const hit = castRay(dim, eye, d, len - 1.2);
        if (hit) visible = false;
      } catch {}
      if (!visible) continue;
      const kind = classifyTop(id);
      this.rings.push({ kind, x: tl.x, y: tl.y, z: tl.z, dist: Math.hypot(tl.x - eye.x, tl.z - eye.z), at: now });
      const c = this.chunk(chunkKey(x, z));
      if (kind === 'water') c.w = Math.min(99, c.w + 1);
      else if (kind === 'trees') c.t = Math.min(99, c.t + 1);
      else if (kind === 'stone') c.s = Math.min(99, c.s + 1);
      else c.l = Math.min(99, c.l + 1);
      if (!c.b) { try { c.b = strip(dim.getBiome(tl).id); } catch {} }
      if (kind === 'trees') {
        // Follow the canopy down to a trunk (a few block reads) and remember it as a tree.
        for (let y = tl.y; y > tl.y - 12; y--) {
          let b;
          try { b = dim.getBlock({ x: tl.x, y, z: tl.z }); } catch { break; }
          if (!b) break;
          const bid = strip(b.typeId);
          if (isLog(bid)) { if (!mem.isUnreachable({ x: tl.x, y, z: tl.z })) mem.remember('log', dimId, { x: tl.x, y, z: tl.z }, 4); break; }
          if (!/leaves|air|vine/.test(bid)) break;
        }
      } else if (STONE_TARGETS.has(id)) {
        mem.remember('stone', dimId, tl, 4);
      }
      this.markDirty();
    }
    this.rings = this.rings.filter((s) => now - s.at < 120000).slice(-120);
    // Animals further out than the survey looks (entity queries are cheap).
    if (this.turn % 2 === 0) { try { this.a.homestead?.rememberAnimals(48); } catch {} }
  }

  /** Water fraction of what we've seen around us recently (0..1), and how many samples. */
  waterAround() {
    const far = this.rings.filter((r) => r.dist >= 16);
    return { frac: far.length ? far.filter((r) => r.kind === 'water').length / far.length : 0, n: far.length };
  }

  /** On a small island? landCells from a walking flood fill (capped). */
  island(landCells) {
    return onIsland(landCells, this.rings);
  }

  /**
   * Land we've seen that isn't the patch we're standing on (`ours`: chunk keys the walking search
   * reached), best first for what we want: trees seen, a good biome, not too far.
   */
  landAcross(ours, want) {
    const p = this.a.sim.location;
    const best = new Map();
    for (const r of this.rings) {
      if (r.kind === 'water') continue;
      const k = chunkKey(r.x, r.z);
      if (ours.has(k)) continue;
      const c = this.map.get(k);
      const t = traitsOf(c?.b ?? '');
      if (!t.land) continue;
      const trait = { log: 'trees', trees: 'trees', sheep: 'sheep', food: 'food', stone: 'stone' }[want];
      let score = 2 + (trait ? t[trait] : 0) + (r.kind === 'trees' && trait === 'trees' ? 3 : 0) - Math.hypot(r.x - p.x, r.z - p.z) / 32;
      if (!best.has(k) || best.get(k).score < score) best.set(k, { score, x: r.x, y: r.y + 1, z: r.z });
    }
    return [...best.values()].sort((a, b) => b.score - a.score)[0] ?? null;
  }

  /**
   * The nearest biome good for `want`, from the world seed (works past what's loaded). A heavy
   * call: cached for 5 minutes per want, bounded to 384x384 blocks, and switched off for the
   * session if one ever takes over 1.5 s.
   */
  seedSearch(want) {
    const now = Date.now();
    if (Lookout.seedSearchOff) return null;
    const p = this.a.sim.location;
    // Cached per want and per rough area (256 blocks): "nothing near" stops being true once we move on.
    const key = `${want}:${Math.floor(p.x / 256)},${Math.floor(p.z / 256)}`;
    const hit = this.seedCache.get(key);
    if (hit && now - hit.at < 300000) return hit.none ? null : hit;
    let best = null;
    const t0 = Date.now();
    // Two biomes at most, in a 384x384 area: this is one blocking engine call each, and a long
    // one stalls the whole server (the script watchdog shuts BDS down past 10 s).
    // Near first (384 across), then wider (768) if nothing's that close: badlands and deserts go
    // on for a long way. A slow search switches the whole thing off for the session.
    for (const size of [384, 768]) {
      for (const id of searchFor(want).slice(0, 2)) {
        if (Lookout.seedSearchOff) break;
        let pos;
        const t1 = Date.now();
        try { pos = this.dim.calculateClosestBiomeFromSeed(p, id, { boundingSize: { x: size, y: 128, z: size } }); } catch (e) { console.warn(`[agent] biome search ${id}: ${e}`); continue; }
        if (Date.now() - t1 > 1500) { Lookout.seedSearchOff = true; console.warn(`[agent] biome search took ${Date.now() - t1} ms: turned off for this session`); }
        if (!pos) continue;
        const d = Math.hypot(pos.x - p.x, pos.z - p.z);
        if (d < 12) continue; // we're in it already
        if (!best || d < best.dist) best = { pos, id: strip(id), dist: d, at: now };
      }
      if (best) break;
    }
    const ms = Date.now() - t0;
    trace(`biome search for ${want}: ${best ? `${best.id} ${Math.round(best.dist)} away` : 'none found'} (${ms} ms)`);
    this.seedCache.set(key, best ?? { none: true, at: now });
    return best;
  }
}
