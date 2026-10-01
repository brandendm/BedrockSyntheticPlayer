// Recognising a village from far off. Pure (unit-tested).
//
// A player looks at a skyline and knows "village": paths, hay bales, farmland, a bell, villagers
// wandering. None of it needs a picture: each is a block id or an entity, and a few of them close
// together are as good as a look. The lookout feeds this evidence in (block ids from its surface
// glances, villagers from an entity query, a close look at blocks when it's near); the Tracker
// clusters it and scores each cluster; a cluster that scores enough, on at least two kinds of
// evidence, is a village. Rules, no learning: it can be wrong the way a player is wrong about a
// farm someone built, never in a way that costs more than a walk.

/** kind -> { w: weight per piece of evidence, cap: how many pieces count }. */
export const KINDS = {
  bell:     { w: 8,   cap: 1 },
  villager: { w: 4,   cap: 3 },
  job:      { w: 3,   cap: 3 },  // a villager's workstation
  hay:      { w: 3,   cap: 2 },
  path:     { w: 2,   cap: 3 },
  bed:      { w: 1.5, cap: 4 },
  farm:     { w: 1,   cap: 3 },
  chest:    { w: 0.5, cap: 2 },
};

export const CONFIRM_SCORE = 9;
export const CLUSTER_R = 48;   // blocks: evidence this close to a cluster's middle belongs to it
export const DANGER_MS = 10 * 60_000; // how long a raider sighting keeps us away

const strip = (id) => String(id ?? '').replace(/^minecraft:/, '');

/** The evidence kind a block id is, or null. (Doors and cobblestone are everywhere: not evidence.) */
export function kindOfBlock(id) {
  const b = strip(id);
  if (b === 'bell') return 'bell';
  if (b === 'dirt_path' || b === 'grass_path') return 'path';
  if (b === 'hay_block') return 'hay';
  if (b === 'farmland') return 'farm';
  if (/^(composter|lectern|blast_furnace|smoker|loom|grindstone|stonecutter_block|stonecutter|fletching_table|cartography_table|smithing_table|brewing_stand)$/.test(b)) return 'job';
  if (/(^|_)bed$/.test(b)) return 'bed';
  if (b === 'chest' || b === 'barrel') return 'chest';
  return null;
}

const RAIDERS = /^(pillager|vindicator|evoker|ravager|vex|illusioner)$/;
/** Is this entity type a villager (not a zombie one)? */
export const isVillager = (type) => /^(villager|villager_v2)$/.test(strip(type));
export const isRaider = (type) => RAIDERS.test(strip(type));

/** Score a cluster's evidence: { score, kinds: { kind: count }, n }. */
export function scoreEvidence(items) {
  const kinds = {};
  for (const e of items) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  let score = 0;
  for (const [k, n] of Object.entries(kinds)) { const d = KINDS[k]; if (d) score += d.w * Math.min(n, d.cap); }
  return { score, kinds, n: items.length };
}

/** A village if it scores enough on at least two kinds (chests alone don't count as a kind). */
export const isVillage = (s) => s.score >= CONFIRM_SCORE && Object.keys(s.kinds).filter((k) => KINDS[k] && k !== 'chest').length >= 2;

/**
 * Clusters evidence into places. add(items, now) takes [{ kind, x, y, z }]; villages(now) lists the
 * confirmed ones: { x, y, z, score, kinds, danger (raiders seen lately), seen (ms) }.
 * Evidence is kept by block position, so seeing the same hay bale twice counts once; villagers
 * (who move) by a 4-block cell.
 */
export class Tracker {
  constructor() { this.clusters = []; }

  static key(e) { return e.kind === 'villager' ? `v${Math.floor(e.x / 4)},${Math.floor(e.z / 4)}` : `${e.kind}${Math.floor(e.x)},${Math.floor(e.y)},${Math.floor(e.z)}`; }

  centre(c) {
    const pts = [...c.ev.values()].filter((e) => e.kind !== 'chest');
    const use = pts.length ? pts : [...c.ev.values()];
    const n = use.length;
    const ys = use.map((e) => e.y).sort((a, b) => a - b);
    return { x: Math.round(use.reduce((s, e) => s + e.x, 0) / n), y: ys[Math.floor(n / 2)], z: Math.round(use.reduce((s, e) => s + e.z, 0) / n) };
  }

  add(items, now = Date.now()) {
    for (const e of items) {
      let best = null, bd = CLUSTER_R;
      for (const c of this.clusters) {
        const d = Math.hypot(e.x - c.mid.x, e.z - c.mid.z);
        if (d < bd) { bd = d; best = c; }
      }
      if (!best) { best = { ev: new Map(), mid: { x: e.x, y: e.y, z: e.z }, seen: now, dangerAt: 0 }; this.clusters.push(best); }
      best.ev.set(Tracker.key(e), { kind: e.kind, x: e.x, y: e.y, z: e.z });
      best.seen = now;
      best.mid = this.centre(best);
    }
    this.merge();
  }

  /** Raiders seen at (x, z): any cluster within 64 blocks is dangerous for a while. */
  raiders(items, now = Date.now()) {
    for (const r of items) for (const c of this.clusters) {
      if (Math.hypot(r.x - c.mid.x, r.z - c.mid.z) <= 64) c.dangerAt = now;
    }
  }

  /** Clusters whose middles drifted within the radius of each other are one place. */
  merge() {
    for (let i = 0; i < this.clusters.length; i++) for (let j = this.clusters.length - 1; j > i; j--) {
      const a = this.clusters[i], b = this.clusters[j];
      if (Math.hypot(a.mid.x - b.mid.x, a.mid.z - b.mid.z) < CLUSTER_R * 0.8) {
        for (const [k, v] of b.ev) a.ev.set(k, v);
        a.seen = Math.max(a.seen, b.seen); a.dangerAt = Math.max(a.dangerAt, b.dangerAt);
        a.mid = this.centre(a);
        this.clusters.splice(j, 1);
      }
    }
  }

  villages(now = Date.now()) {
    const out = [];
    for (const c of this.clusters) {
      const s = scoreEvidence([...c.ev.values()]);
      if (!isVillage(s)) continue;
      out.push({ ...c.mid, score: Math.round(s.score * 10) / 10, kinds: s.kinds, danger: now - c.dangerAt < DANGER_MS, seen: c.seen });
    }
    return out;
  }
}

/**
 * Fold freshly confirmed villages into the remembered list (saved in the world): the same place
 * (within CLUSTER_R) is updated, not added again; the best-scoring `max` are kept.
 * known: [{ d, x, y, z, score, kinds, seen, dangerAt, visited? }]
 */
export function mergeKnown(known, found, dim, now = Date.now(), max = 8) {
  const out = known.map((k) => ({ ...k }));
  for (const f of found) {
    const same = out.find((k) => k.d === dim && Math.hypot(k.x - f.x, k.z - f.z) < CLUSTER_R);
    if (same) {
      Object.assign(same, { x: f.x, y: f.y, z: f.z, score: Math.max(same.score, f.score), kinds: f.kinds, seen: now, dangerAt: f.danger ? now : same.dangerAt ?? 0 });
    } else out.push({ d: dim, x: f.x, y: f.y, z: f.z, score: f.score, kinds: f.kinds, seen: now, dangerAt: f.danger ? now : 0 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

/** What a village is good for: beds, food (farms, hay), chests, villagers (trade), workstations (a blacksmith's iron). */
export function offers(v) {
  const k = v.kinds ?? {};
  return { bed: k.bed ?? 0, food: (k.farm ?? 0) + 2 * (k.hay ?? 0), chest: k.chest ?? 0, villagers: k.villager ?? 0, smith: k.job ?? 0 };
}

/**
 * Which village to go to for `want` ('sheep'/'wool'/'bed', 'food', 'chest', 'iron'), from p, or null.
 * Skips: a place raiders were seen at lately, one visited in the last 15 minutes, one past `maxDist`,
 * and (at night, unless it's close) the walk through the dark. Nearer wins; what it offers pulls
 * a lot (12 blocks per piece, up to 4).
 */
export function pickVillage(known, p, want, { now = Date.now(), dim = undefined, maxDist = 220, night = false } = /** @type {{ now?: number, dim?: string, maxDist?: number, night?: boolean }} */ ({})) {
  const wantKey = { sheep: 'bed', wool: 'bed', bed: 'bed', food: 'food', chest: 'chest', iron: 'smith' }[want];
  if (!wantKey) return null;
  let best = null;
  for (const v of known) {
    if (v.d !== dim) continue;
    if (v.dangerAt && now - v.dangerAt < DANGER_MS) continue;
    if (v.visited && now - v.visited < 15 * 60_000) continue;
    const d = Math.hypot(v.x - p.x, v.z - p.z);
    if (d > maxDist || (night && d > 48)) continue;
    const have = offers(v)[wantKey] ?? 0;
    const cost = d - 12 * Math.min(have, 4) + (have ? 0 : 30); // (a village without what we want is still a place with animals about)
    if (!best || cost < best.cost) best = { ...v, dist: Math.round(d), cost };
  }
  return best;
}

/** Village chest contents worth taking (iron, food, a blacksmith's tools; not the junk). */
export const LOOT_WANTED = /^(iron_ingot|raw_iron|iron_ore|coal|charcoal|bread|baked_potato|cooked_[a-z_]+|apple|carrot|potato|beetroot|wheat|emerald|diamond|iron_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots)|saddle|obsidian|bucket|shield|lead)$/;
export const lootWanted = (id) => LOOT_WANTED.test(strip(id));

/** Is this a bed block the bot may take (a villager's, not one at our own house)? */
export function takeableBed(id, p, house) {
  if (!/(^|_)bed$/.test(strip(id))) return false;
  if (!house) return true;
  return Math.hypot(p.x - house.x, p.z - house.z) > 12;
}
