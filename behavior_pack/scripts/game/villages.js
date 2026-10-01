// Village sense (rules in core/village.js). The lookout's glances hand block ids in; every few
// seconds an entity query counts villagers and raiders out to 64 blocks. Confirmed villages are
// kept in the world memory (memory.data.villages), shown on the dashboard's trail map, and used by
// the plan: looking for sheep (a bed's wool) or food with a village known goes there first; once
// there it takes a bed (the wool's work done), the chests' iron and food, and goes on. A place raiders
// were seen at is left alone for ten minutes.
import { world } from '@minecraft/server';
import { Tracker, kindOfBlock, isVillager, isRaider, mergeKnown, pickVillage, lootWanted, takeableBed, offers } from '../core/village.js';
import { trace } from './bridge.js';
import { container as packOf, invCounts } from './inventory.js';

const strip = (id) => String(id ?? '').replace(/^minecraft:/, '');
const CROPS = /^(wheat|carrots|potatoes|beetroot|beetroots)$/;

export class Villages {
  constructor(agent) {
    this.a = agent;
    this.tracker = new Tracker();
    this.busy = false;
    this.told = new Set();
  }

  get known() { return this.a.memory.data.villages ?? []; }
  get dimId() { return this.a.dim.id; }

  /** A surface glance saw block `id` at (x, y, z). */
  seeBlock(id, x, y, z) {
    const b = strip(id);
    const kind = CROPS.test(b) ? 'farm' : kindOfBlock(b);
    return kind ? { kind, x, y, z } : null;
  }

  /** Evidence in: cluster it, and remember what's confirmed. */
  feed(items) {
    if (!items.length) return;
    const now = Date.now();
    this.tracker.add(items, now);
    this.confirm(now);
  }

  confirm(now = Date.now()) {
    const found = this.tracker.villages(now);
    if (!found.length) return;
    const before = this.known;
    const merged = mergeKnown(before, found, this.dimId, now);
    this.a.memory.data.villages = merged;
    this.a.memory.save();
    for (const v of found) {
      const k = `${Math.round(v.x / 48)},${Math.round(v.z / 48)}`;
      if (this.told.has(k)) continue;
      this.told.add(k);
      const p = this.a.sim.location;
      trace(`village: found one at ${v.x} ${v.y} ${v.z} (${Math.round(Math.hypot(v.x - p.x, v.z - p.z))} away), score ${v.score}: ${Object.entries(v.kinds).map(([k2, n]) => `${k2} ${n}`).join(', ')}`);
      this.a.sayOnce(`village:${k}`, `That looks like a village, about ${Math.round(Math.hypot(v.x - p.x, v.z - p.z))} blocks away.`, 600000);
    }
  }

  /** Villagers and raiders within 64 blocks (loaded chunks): evidence, and a warning. */
  scanEntities() {
    let ents = [];
    try { ents = this.a.dim.getEntities({ location: this.a.sim.location, maxDistance: 64 }); } catch { return; }
    const vil = [], raiders = [];
    for (const e of ents) {
      let t;
      try { t = strip(e.typeId); } catch { continue; }
      const l = e.location;
      if (isVillager(t)) vil.push({ kind: 'villager', x: Math.floor(l.x), y: Math.floor(l.y), z: Math.floor(l.z) });
      else if (isRaider(t)) raiders.push({ x: l.x, z: l.z });
    }
    if (vil.length) this.feed(vil);
    if (raiders.length) {
      const now = Date.now();
      this.tracker.raiders(raiders, now);
      for (const k of this.known) if (raiders.some((r) => Math.hypot(r.x - k.x, r.z - k.z) <= 64)) k.dangerAt = now;
      this.a.memory.save();
    }
    return { villagers: vil.length, raiders: raiders.length };
  }

  /** The village to go to for `want`, or null. */
  pick(want) {
    let night = false;
    try { const t = world.getTimeOfDay(); night = t >= 12542 && t <= 23460; } catch {}
    return pickVillage(this.known, this.a.sim.location, want, { dim: this.dimId, night });
  }

  /**
   * Go to a village and use it: a bed if we need one (`want` 'sheep': the bed's wool, done), the
   * chests' iron and food, a look round to learn more of what's there. Raiders in sight: not today.
   * Returns a one-line summary (or why not).
   */
  async visit(gen, v, want = 'sheep') {
    const S = this.a.skills;
    this.busy = true;
    try {
      trace(`village: going to ${v.x} ${v.y} ${v.z} (${v.dist ?? '?'} away) for ${want}`);
      this.a.sayOnce('village-go', 'Heading for the village I saw.', 60000);
      await S.packUp?.(gen);
      await S.travelToward(gen, { x: v.x, y: v.y, z: v.z }, 6);
      S.check(gen);
      const near = Math.hypot(this.a.sim.location.x - v.x, this.a.sim.location.z - v.z);
      const seen = this.scanEntities();
      if (seen?.raiders) { this.mark(v, { dangerAt: Date.now() }); trace(`village: ${seen.raiders} raider(s) in sight, leaving it alone`); this.a.say('Raiders at the village: staying away.'); return 'raiders'; }
      this.mark(v, { visited: Date.now() });
      if (near > 60) return `didn't get close (${Math.round(near)} away)`;
      // A look round: what's here (beds, chests, workstations) feeds back as evidence too.
      const blocks = await S.scan((id) => kindOfBlock(id) !== null, { radius: 28, below: 6, above: 8, limit: 300, background: true });
      this.feed(blocks.map((b) => ({ kind: kindOfBlock(b.id), x: b.x, y: b.y, z: b.z })));
      const out = [];
      const house = this.a.homestead?.house;
      const needBed = want === 'sheep' || want === 'bed';
      if (needBed && !invCounts(this.a.sim).bed && !house?.bed) {
        const beds = blocks.filter((b) => takeableBed(b.id, b, house)).sort((p, q) => Math.hypot(p.x - this.a.sim.location.x, p.z - this.a.sim.location.z) - Math.hypot(q.x - this.a.sim.location.x, q.z - this.a.sim.location.z));
        for (const bed of beds.slice(0, 3)) {
          if (!(await S.goNear(gen, bed, 3, 2))) continue;
          if (await S.mine(gen, bed, { collect: true })) { out.push('took a bed'); break; }
        }
      }
      const chests = blocks.filter((b) => strip(b.id) === 'chest' || strip(b.id) === 'barrel').slice(0, 6);
      let took = 0;
      for (const c of chests) {
        if (!(await S.reach(gen, c))) continue;
        await this.a.motor.lookAt({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 }, 8, 30);
        S.check(gen);
        took += this.loot(c);
        await S.wait(gen, 6);
      }
      if (took) out.push(`took ${took} item(s) from chests`);
      trace(`village: visit done: ${out.join(', ') || 'nothing to take'}; offers ${JSON.stringify(offers(this.find(v) ?? v))}`);
      return out.join(', ') || 'looked round';
    } finally { this.busy = false; }
  }

  /** The remembered village at v (the list is replaced as evidence comes in, so look it up each time). */
  find(v) { return this.known.find((k) => k.d === v.d && Math.hypot(k.x - v.x, k.z - v.z) < 8); }
  mark(v, patch) { const k = this.find(v); if (k) { Object.assign(k, patch); this.a.memory.save(); } }

  /** Move the wanted stacks out of the chest at c into the pack. Returns how many items. */
  loot(c) {
    let n = 0;
    try {
      const chest = this.a.dim.getBlock(c)?.getComponent('minecraft:inventory')?.container, pack = packOf(this.a.sim);
      if (!chest || !pack) return 0;
      for (let i = 0; i < chest.size; i++) {
        const it = chest.getItem(i);
        if (!it || !lootWanted(it.typeId)) continue;
        const amt = it.amount;
        const left = chest.transferItem(i, pack);
        n += amt - (left?.amount ?? 0);
      }
    } catch (e) { trace(`village: chest at ${c.x} ${c.y} ${c.z}: ${e}`); }
    return n;
  }

  /** For the dashboard: [{ x, z, score, kinds, danger, visited }]. */
  status() {
    const now = Date.now();
    return this.known.filter((v) => v.d === this.dimId).map((v) => ({ x: v.x, y: v.y, z: v.z, score: v.score, kinds: v.kinds, danger: !!(v.dangerAt && now - v.dangerAt < 600000), visited: !!v.visited }));
  }
}
