// Horses: find one, tame it the way a player does (get on, get thrown, again, until it accepts), put a
// saddle on it, get on and off. The in-game tests (game/scenarios.js) and the task chain
// (core/chain.js, `!bot get horse`, `!bot mount`, `!bot dismount`) both use this.
import { system } from '@minecraft/server';
import { hold, invCounts } from './inventory.js';
import { trace } from './bridge.js';

const babyOf = (e) => { try { return e.hasComponent('minecraft:is_baby'); } catch { return false; } };
const tamed = (e) => { try { return e.hasComponent('minecraft:is_tamed'); } catch { return false; } };
export const ridersOf = (e) => { try { return e.getComponent('minecraft:rideable')?.getRiders() ?? []; } catch { return []; } };
export const saddledOf = (e) => { try { return /saddle/.test(e.getComponent('minecraft:inventory')?.container?.getItem(0)?.typeId ?? ''); } catch { return false; } };
export const isTamed = tamed;

export class Horses {
  constructor(agent) { this.a = agent; }

  /** The horse we last got on, or the nearest tamed/wild one within `r`. */
  find(r = 48) {
    const a = this.a;
    const id = a.memory.data.horseId;
    let found = null;
    try {
      const all = a.dim.getEntities({ type: 'minecraft:horse', location: a.sim.location, maxDistance: r });
      const grown = all.filter((e) => !babyOf(e)); // (a baby can't be ridden)
      found = grown.find((e) => e.id === id) ?? grown.sort((p, q) => dist(a.sim.location, p.location) - dist(a.sim.location, q.location))[0] ?? null;
    } catch { /* none loaded */ }
    return found;
  }

  /** The horse we're riding, if any. */
  mounted() {
    try {
      const r = this.a.sim.getComponent('minecraft:riding')?.entityRidingOn;
      return r && /horse/.test(r.typeId) ? r : null;
    } catch { return null; }
  }

  /** What chain planning needs to know: { found, dist, tamed, saddled, mounted, saddleInPack }. */
  state() {
    const m = this.mounted(), h = m ?? this.find(64);
    const inv = invCounts(this.a.sim);
    return h ? { found: true, dist: Math.round(dist(this.a.sim.location, h.location)), tamed: tamed(h), saddled: saddledOf(h), mounted: !!m, saddleInPack: (inv.saddle ?? 0) > 0 }
      : { found: false, tamed: false, saddled: false, mounted: false, saddleInPack: (inv.saddle ?? 0) > 0 };
  }

  /** Walk up to a horse. */
  async approach(gen, h) {
    const S = this.a.skills;
    if (dist(this.a.sim.location, h.location) <= 2.5) return true;
    await S.goNear(gen, h.location, 2, 3);
    S.check(gen);
    return dist(this.a.sim.location, h.location) <= 3.5;
  }

  /**
   * Tame it: get on, get thrown off (or climb off), again, until it accepts. After `patience` tries
   * with no luck the game's own taming is used (said so in the result), a wild one can take a long time.
   * Returns { ok, tries, how }.
   */
  async tame(gen, h, patience = 14) {
    const S = this.a.skills, sim = this.a.sim;
    if (babyOf(h)) return { ok: false, tries: 0, how: "it's a foal: a baby horse can't be ridden" };
    let tries = 0;
    for (; tries < 40 && !tamed(h); tries++) {
      if (!h.isValid) return { ok: false, tries, how: 'the horse is gone' };
      if (!(await this.approach(gen, h))) return { ok: false, tries, how: "couldn't get to the horse" };
      if (tries >= patience) {
        try { h.getComponent('minecraft:tamemount')?.setTamed(false); } catch { /* not there */ }
        await S.wait(gen, 4);
        if (tamed(h)) { this.a.memory.data.horseId = h.id; return { ok: true, tries, how: 'by the game (it kept throwing me)' }; }
      }
      try { hold(sim, null); sim.interactWithEntity(h); } catch (e) { return { ok: false, tries, how: `couldn't get on: ${e}` }; }
      await S.wait(gen, 40);
      if (ridersOf(h).some((r) => r.id === sim.id)) await this.getOff(gen);
      await S.wait(gen, 10);
    }
    if (tamed(h)) this.a.memory.data.horseId = h.id;
    return { ok: tamed(h), tries, how: 'by riding' };
  }

  /** Put the saddle on (a tame horse, a saddle in the pack). */
  async saddle(gen, h) {
    const S = this.a.skills, sim = this.a.sim;
    if (saddledOf(h)) return true;
    if (!invCounts(sim).saddle) return false;
    if (!(await this.approach(gen, h))) return false;
    for (let i = 0; i < 4 && !saddledOf(h); i++) {
      hold(sim, 'saddle');
      try { sim.interactWithEntity(h); } catch (e) { trace(`horse: saddle: ${e}`); return false; }
      await S.wait(gen, 10);
    }
    return saddledOf(h);
  }

  /** Get on (walk up to it first, again on each try: horses wander). */
  async getOn(gen, h) {
    const S = this.a.skills, sim = this.a.sim;
    if (ridersOf(h).some((r) => r.id === sim.id)) return true;
    const why = { tries: 0, near: false, tamed: tamed(h), saddled: saddledOf(h), threw: '', rider: ridersOf(h).length };
    for (let i = 0; i < 4; i++) {
      why.tries = i + 1;
      if (!h.isValid) { why.threw = 'the horse is gone'; break; }
      why.near = await this.approach(gen, h);
      if (!why.near) continue;
      try { hold(sim, null); sim.lookAtEntity?.(h); sim.interactWithEntity(h); } catch (e) { why.threw = `${e}`; break; }
      await S.wait(gen, 20);
      if (ridersOf(h).some((r) => r.id === sim.id)) { this.a.memory.data.horseId = h.id; return true; }
    }
    why.rider = ridersOf(h).length;
    this.a.whyNot('get on the horse', { ...why, dist: Math.round(dist(sim.location, h.location)) });
    return false;
  }

  /** Get off: sneak (what a player does), else the game's ride command. */
  async getOff(gen) {
    const sim = this.a.sim;
    const down = () => !this.mounted() && !sim.getComponent('minecraft:riding')?.entityRidingOn;
    if (down()) return true;
    try { sim.isSneaking = true; } catch { /* */ }
    for (let i = 0; i < 10 && !down(); i++) await (gen ? this.a.skills.wait(gen, 2) : system.waitTicks(2));
    try { sim.isSneaking = false; } catch { /* */ }
    if (!down()) { try { sim.runCommand('ride @s stop_riding'); } catch { /* */ } await system.waitTicks(4); }
    return down();
  }
}

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
