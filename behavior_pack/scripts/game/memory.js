// Long-term memory of places and things, saved inside the world (a world dynamic property), so it
// survives restarts and travels with the world. Exact coordinates and distances live here, in code.
//
// Categories:
//   crafting_table           exact block positions
//   log, stone, <ore>        clusters: one entry per ~8-block area, with a rough count
//   item:<id>                stacks lying on the ground (they despawn after 5 minutes)
// Anything found missing on a visit is forgotten (forgetNear).
import { world, system } from '@minecraft/server';
import { dist3D } from '../core/mathutil.js';

const KEY = 'agent:memory';
const CLUSTER = 8;
const MAX_PER_CATEGORY = 24;

const exact = (cat) => cat === 'crafting_table' || cat === 'furnace';

export class WorldMemory {
  constructor() {
    this.data = { v: 3, res: [] };
    this.unreachable = new Map();
    this.dirty = false;
    try {
      const raw = world.getDynamicProperty(KEY);
      if (typeof raw === 'string') this.load(JSON.parse(raw));
    } catch (e) {
      console.warn(`[agent] memory load: ${e}`);
    }
  }

  load(d) {
    if (d.v === 3) { this.data = d; return; }
    if (d.v === 2) {
      // v2 surveys could "see" stone, ores and logs through the ground: drop those, keep the
      // places we built or used (tables, furnaces) and everything else about the world.
      this.data = { ...d, v: 3, res: d.res.filter((r) => r.c === 'crafting_table' || r.c === 'furnace') };
      this.save();
      return;
    }
    // v1: tables + trees lists
    for (const t of d.tables ?? []) this.data.res.push({ c: 'crafting_table', d: t.d, x: t.x, y: t.y, z: t.z, n: 1, t: Date.now() });
    for (const t of d.trees ?? []) this.data.res.push({ c: 'log', d: t.d, x: t.x, y: t.y, z: t.z, n: 4, t: Date.now() });
    this.save();
  }

  /** Coalesce writes: at most one save every 5 s. */
  save() {
    if (this.dirty) return;
    this.dirty = true;
    system.runTimeout(() => {
      this.dirty = false;
      try {
        world.setDynamicProperty(KEY, JSON.stringify(this.data));
      } catch (e) {
        console.warn(`[agent] memory save: ${e}`);
      }
    }, 100);
  }

  /** Write right away (for things we must not lose: a house we've started). */
  saveNow() {
    try { world.setDynamicProperty(KEY, JSON.stringify(this.data)); } catch (e) { console.warn(`[agent] memory save: ${e}`); }
  }

  remember(cat, dimId, p, n = 1) {
    const pos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const now = Date.now();
    const same = this.data.res.find((r) => r.c === cat && r.d === dimId && (exact(cat)
      ? r.x === pos.x && r.y === pos.y && r.z === pos.z
      : Math.abs(r.x - pos.x) < CLUSTER && Math.abs(r.z - pos.z) < CLUSTER && Math.abs(r.y - pos.y) < CLUSTER));
    if (same) {
      same.n = cat.startsWith('item:') ? n : Math.max(same.n, n);
      same.t = now;
    } else {
      this.data.res.push({ c: cat, d: dimId, ...pos, n, t: now });
      const mine = this.data.res.filter((r) => r.c === cat);
      if (mine.length > MAX_PER_CATEGORY) {
        const oldest = mine.reduce((a, b) => (a.t < b.t ? a : b));
        this.data.res.splice(this.data.res.indexOf(oldest), 1);
      }
    }
    this.save();
  }

  /** Forget entries of this category near p (it wasn't there when we checked). */
  forgetNear(cat, dimId, p, r = CLUSTER) {
    const before = this.data.res.length;
    this.data.res = this.data.res.filter((e) => !(e.c === cat && e.d === dimId && dist3D(e, p) <= r));
    if (this.data.res.length !== before) this.save();
    return before - this.data.res.length;
  }

  /** Entries of a category (or categories matching a predicate), nearest first, with distance and age. */
  list(catOrPred, dimId, from) {
    const match = typeof catOrPred === 'function' ? catOrPred : (c) => c === catOrPred;
    const now = Date.now();
    return this.data.res
      .filter((e) => match(e.c) && e.d === dimId && !this.isUnreachable(e))
      .map((e) => ({ cat: e.c, pos: { x: e.x, y: e.y, z: e.z }, n: e.n, ageMs: now - e.t, dist: dist3D(from, { x: e.x + 0.5, y: e.y, z: e.z + 0.5 }) }))
      .filter((e) => !(e.cat.startsWith('item:') && e.ageMs > 5 * 60_000)) // despawned by now
      .sort((a, b) => a.dist - b.dist);
  }

  /** Couldn't get there: ignore it for a few minutes (not saved; it may be fine later). */
  markUnreachable(p, ms = 180000) {
    this.unreachable.set(`${p.x},${p.y},${p.z}`, Date.now() + ms);
  }

  isUnreachable(p) {
    const until = this.unreachable.get(`${p.x},${p.y},${p.z}`);
    return until !== undefined && until > Date.now();
  }

  summary() {
    const out = {};
    for (const e of this.data.res) out[e.c] = (out[e.c] ?? 0) + 1;
    return out;
  }

  // ---- convenience wrappers used by the autonomy loop ----
  rememberTable(dimId, p) { this.remember('crafting_table', dimId, p); }
  forgetTable(dimId, p) { this.forgetNear('crafting_table', dimId, p, 0.5); }
  nearestTable(dimId, from) { return this.list('crafting_table', dimId, from)[0] ?? null; }
}
