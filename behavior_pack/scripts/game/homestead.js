// Settling in after stone tools: eating, hunting, smelting, the house, and nights.
// The plan (what to do next) is core/settle.js; this file is the doing.
import { system, world, Direction, ItemStack, BlockVolume } from '@minecraft/server';
import { dist3D } from '../core/mathutil.js';
import { standOff } from '../core/threat.js';
import { isLog, isPlanks, TOOL_STONE, count } from '../core/recipes.js';
import { RAW, isNight, TORCH_GOAL, fittingsPlanks, chooseFood } from '../core/settle.js';
import { planFuel, burnsFor, charcoalInput } from '../core/fuel.js';
import { blueprint, clearance, footing, furnishings, inside, houseMissing, standFor, layoutOf, NEW_LAYOUT, keepClear, inTheWay, frame, planAroundFixed, toLocal, bounds } from '../core/house.js';
import { getPlan } from '../core/learnhouse.js';
import { cheapestPlaceable, plankReserve, canBreak } from '../core/costs.js';
import { siteWork, siteScore } from '../core/site.js';
import { depositPlan, takePlan, sortIntoChests } from '../core/storage.js';
import { invCounts, hold, take, give, container as packOf } from './inventory.js';
import { canSee, ONE_TAP, castRay, USABLE } from './world.js';
import { barricadeCells } from '../core/tactics.js';
import { Cell } from '../core/pathfinder.js';
import { trace } from './bridge.js';
import { REST_UNTIL, REST_MAX_S, REST_COOLDOWN_S, REST_HOME_M, canHeal } from '../core/rest.js';

const strip = (id) => id.replace('minecraft:', '');
const center = (p) => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
export const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
const SOFT = /^(air|short_grass|tall_grass|fern|large_fern|dead_bush|deadbush|snow_layer|vine|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|allium|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|bush|leaf_litter|wildflowers|pink_petals|short_dry_grass|tall_dry_grass)$/;
// Plants and other growth that can stand where a torch goes: two-high flowers and grass (their top
// half is at torch height), bushes, saplings, leaves, vines. Broken to make room; never anything built.
export const PLANT = /^(short_grass|tall_grass|fern|large_fern|peony|rose_bush|lilac|sunflower|pitcher_plant|torchflower|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|allium|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|.*_sapling|mangrove_propagule|sweet_berry_bush|bush|firefly_bush|dead_bush|deadbush|tall_dry_grass|short_dry_grass|.*leaves|vine|glow_lichen|hanging_roots|cave_vines.*|azalea|flowering_azalea|big_dripleaf|small_dripleaf_block|sugar_cane|bamboo|pink_petals|wildflowers|leaf_litter|snow_layer|moss_carpet|.*_mushroom)$/;
const DIGGABLE_SITE = /^(dirt|grass_block|coarse_dirt|podzol|sand|red_sand|gravel|snow|stone|andesite|diorite|granite|tuff|clay|mud)$/;
// face clicked on the neighbour, and where on that face, for a neighbour at each offset from the cell
const FACES = [
  [[0, -1, 0], Direction.Up, { x: 0.5, y: 1, z: 0.5 }],
  [[-1, 0, 0], Direction.East, { x: 1, y: 0.5, z: 0.5 }],
  [[1, 0, 0], Direction.West, { x: 0, y: 0.5, z: 0.5 }],
  [[0, 0, -1], Direction.South, { x: 0.5, y: 0.5, z: 1 }],
  [[0, 0, 1], Direction.North, { x: 0.5, y: 0.5, z: 0 }],
  [[0, 1, 0], Direction.Down, { x: 0.5, y: 0, z: 0.5 }],
];

export class Homestead {
  constructor(agent) {
    this.a = agent;
    /** @type {Array<{pos: any, readyAt: number, kind: string, n: number}>} a job per furnace (the house's, the mine camp's) */
    this.jobs = [];
    /** @type {Map<string, number>} entity id -> tick we last saw it (animals(): object permanence) */
    this.seenAt = new Map();
  }

  /** The furnace job nearest p (the furnace we'd use from here): what the plan looks at. */
  jobNear(p = this.sim.location) {
    let best = null;
    for (const j of this.jobs) if (!best || dist3D(p, j.pos) < dist3D(p, best.pos)) best = j;
    return best;
  }
  get smeltJob() { return this.jobNear(); }
  set smeltJob(v) { this.jobs = v ? [v] : []; } // (restoring one saved job, the in-game tests)
  jobAt(pos) { return this.jobs.find((j) => dist3D(j.pos, pos) < 0.5) ?? null; }
  setJob(job) { this.jobs = this.jobs.filter((j) => dist3D(j.pos, job.pos) >= 0.5).concat([job]); }
  dropJob(pos) { this.jobs = this.jobs.filter((j) => dist3D(j.pos, pos) >= 0.5); }
  /** The house's wall and roof cells ("x,y,z"), empty with no house. */
  houseCells() {
    const h = this.house;
    return new Set(h ? blueprint(h, h.dir).map((b) => `${b.x},${b.y},${b.z}`) : []);
  }
  /** A batch still cooking in the furnace at pos. */
  busy(pos) { const j = this.jobAt(pos); return !!j && system.currentTick < j.readyAt; }
  /**
   * The job the plan goes by from here: one that's done within 24 (go and empty it), else the one at
   * the furnace we'd use here (the camp's down the mine; up top the one furnaceFor picks), else the
   * nearest. (Only ever the nearest, it once walked down the mine to wait on the ore while the house
   * furnace stood free for charcoal: tools/sim_furnace.mjs.)
   */
  planJob(p = this.sim.location) {
    const now = system.currentTick;
    const ready = this.jobs.filter((j) => now >= j.readyAt && dist3D(p, j.pos) <= 24).sort((a, b) => dist3D(p, a.pos) - dist3D(p, b.pos))[0];
    if (ready) return ready;
    const S = this.S;
    const camp = S.campFurnace?.();
    let here = null;
    let ff = null;
    try { ff = camp && S.isUnderground() && S.nearQuarry(p, 48) ? { pos: camp } : this.furnaceFor(null, p); } catch { ff = null; }
    if (ff) return ff.pos ? this.jobAt(ff.pos) : null; // (the one in the pack: nothing cooking in it)
    return this.jobNear(p);
  }
  /**
   * The furnace to use from here for `input` (not the mine camp's: ensureFurnace sends ore there
   * itself): the nearest we remember with nothing cooking, else the nearest. A furnace in the pack
   * counts as a free one (it goes down beside us): { pack: true }. { pos, busy, dist } or null.
   */
  furnaceFor(input = null, p = this.sim.location) {
    const known = this.a.memory.list('furnace', this.dim.id, p).filter((e) => !this.isCamp(e.pos));
    // At the house: its food furnace for food, the other for ore and charcoal (so a batch of
    // meat never holds up the iron, or the iron the meat); either, if the other's the free one.
    const h = this.house, fur = h ? furnishings(h, h.dir) : null;
    const role = (e) => (fur?.furnace2 && e.pos.x === fur.furnace2.x && e.pos.y === fur.furnace2.y && e.pos.z === fur.furnace2.z ? 'food' : 'other');
    if (input) known.sort((a, b) => (role(a) === (input === 'food' ? 'food' : 'other') ? 0 : 1) - (role(b) === (input === 'food' ? 'food' : 'other') ? 0 : 1) || a.dist - b.dist);
    const free = known.find((e) => !this.busy(e.pos) && e.dist < 128);
    if (!free && known.length && (invCounts(this.sim).furnace ?? 0) > 0) return { pos: null, pack: true, busy: false, dist: 0 }; // (all busy: the pack's)
    const pick = free ?? known[0];
    return pick ? { pos: pick.pos, busy: this.busy(pick.pos), dist: pick.dist } : null;
  }
  /** Raw iron in all the furnaces (ours already, for counting what's still to mine). */
  oreCooking() { return this.jobs.filter((j) => j.kind === 'ore').reduce((a, j) => a + (j.n ?? 0), 0); }
  /** Our mine camp's furnace or table (never carried off to the house or packed up to go exploring). */
  isCamp(p) { return this.a.skills.isCampBlock?.(p) ?? false; }

  /**
   * A fact the planner asks for several times per decision (animals in sight, the house's state,
   * what it still needs), worked out once: kept for a few ticks, and dropped as soon as we change a
   * block ourselves or the pack changes (`sig`).
   */
  memo(key, ticks, fn, sig = '') {
    const m = this._memo ?? (this._memo = new Map());
    const now = system.currentTick, gen = this.a.cellGen ?? 0;
    const hit = m.get(key);
    if (hit && now - hit.at <= ticks && hit.gen === gen && hit.sig === sig) return hit.v;
    const v = fn();
    if (m.size > 64) m.clear();
    m.set(key, { v, at: now, gen, sig });
    return v;
  }

  /** animals(), for planning: the same answer for a few ticks (each call casts rays at every animal). */
  animalsSeen(types, radius = 32) {
    return this.memo(`animals:${[...types].join()}:${radius}`, 10, () => this.animals(types, radius));
  }

  get S() { return this.a.skills; }
  get sim() { return this.a.sim; }
  get dim() { return this.a.sim.dimension; }
  get house() {
    const h = this.a.memory.data.house;
    return h && h.d === this.dim.id ? h : null;
  }
  setHouse(h) { this.a.memory.data.house = h ? { d: this.dim.id, ...h } : null; this.a.memory.save(); }

  // ---------- eating ----------

  hunger() {
    try { return this.sim.getComponent('minecraft:player.hunger')?.currentValue ?? 20; } catch { return 20; }
  }

  saturation() {
    try { return this.sim.getComponent('minecraft:player.saturation')?.currentValue ?? 0; } catch { return 0; }
  }

  /**
   * Eat if hungry (or hurt and not full): hunger and saturation that land, least wasted (core/settle.js
   * chooseFood); raw meat waits while some's cooking close by.
   */
  async maybeEat(gen) {
    const hunger = this.hunger(), health = this.a.health();
    if (!(hunger <= (this.a.profile?.params?.eat_at ?? 14) || (health < 16 && hunger < 20))) return false; // (eat_at: when you eat, once it has seen enough: core/profile.js)
    const inv = invCounts(this.sim);
    const cookingSoon = this.jobs.some((j) => j.kind === 'food' && dist3D(this.sim.location, j.pos) <= 32);
    const best = chooseFood(inv, { hunger, saturation: this.saturation(), health, cookingSoon });
    if (!best) return false;
    const slot = hold(this.sim, best);
    if (slot < 0) return false;
    this.a.sayOnce('eat', `Eating (${best.replace(/_/g, ' ')}).`, 120000);
    try { this.sim.useItemInSlot(slot); } catch { return false; }
    try { await this.S.wait(gen, 36); } finally { try { this.sim.stopUsingItem(); } catch {} }
    this.S.afterUse(slot); // (the last bite: not still holding it)
    return true;
  }

  /**
   * Hurt: stop and heal (core/rest.js). Inside the house if it's close and we're above ground, else
   * where we stand (the fight and flee reflexes go on running); eat what heals fastest, wait. A bout
   * that runs out of time or of food is left with a few minutes' rest of its own before the next.
   * The bout survives a fight breaking it off (a.resting): the plan comes straight back here.
   */
  async restUp(gen) {
    const a = this.a, S = this.S;
    if (!a.resting) { a.resting = true; a.restStart = Date.now(); trace(`rest: hurt (${Math.round(a.health())} hp), resting`); }
    a.sayOnce('rest', `Hurt (${Math.round(a.health())}/20): resting till I've healed.`, 120000);
    const h = this.house;
    if (h && !this.isHome() && !a.minedUnderground?.() && dist3D(this.sim.location, h) <= REST_HOME_M) {
      try { await this.enterHouse(gen); } catch (e) { if (gen !== a.taskGen) throw e; }
    }
    let quit = '';
    for (;;) {
      S.check(gen);
      if (a.health() >= REST_UNTIL) break;
      if ((Date.now() - a.restStart) / 1000 > REST_MAX_S) { quit = 'out of time'; break; }
      const ate = await this.maybeEat(gen);
      if (!ate && !canHeal({ hunger: this.hunger(), canEat: !!chooseFood(invCounts(this.sim), { hunger: this.hunger(), saturation: this.saturation(), health: a.health() }) })) { quit = 'nothing to heal with'; break; }
      if (!ate) await S.wait(gen, 40);
    }
    a.resting = false;
    if (quit) { a.restCoolUntil = Date.now() + REST_COOLDOWN_S * 1000; a.say(quit === 'out of time' ? "Still hurt, but I can't sit here all day: getting on with it, carefully." : "Hurt and nothing to heal with: food first."); }
    trace(`rest: done (${quit || 'healed'}), ${Math.round(a.health())} hp after ${Math.round((Date.now() - a.restStart) / 1000)} s`);
    return !quit;
  }

  // ---------- animals ----------

  /**
   * Adult animals of these types we can see, nearest first. Seeing any part counts (head, body,
   * legs: a fence post or a block edge in front of the head doesn't hide a whole sheep), and ones
   * we saw in the last 20 s still count while they're behind a tree or over a rise (object
   * permanence: they didn't vanish, they walked behind something).
   */
  animals(types, radius = 32) {
    const eye = this.S.eye();
    const now = system.currentTick;
    let ents = [];
    try { ents = this.dim.getEntities({ location: this.sim.location, maxDistance: radius }); } catch {}
    return ents
      .filter((e) => {
        const t = strip(e.typeId);
        if (!types.has(t) || !e.isValid) return false;
        try { if (e.hasComponent('minecraft:is_baby')) return false; } catch {}
        try { if (t === 'sheep' && e.hasComponent('minecraft:is_sheared')) return false; } catch {}
        const l = e.location;
        const visible = [e.getHeadLocation(), { x: l.x, y: l.y + 0.7, z: l.z }, { x: l.x, y: l.y + 0.25, z: l.z }].some((pt) => canSee(this.dim, eye, pt));
        if (visible) { this.seenAt.set(e.id, now); return true; }
        return now - (this.seenAt.get(e.id) ?? -1e9) < 400;
      })
      .map((e) => ({ e, type: strip(e.typeId), d: dist3D(this.sim.location, e.location) }))
      .sort((a, b) => a.d - b.d);
  }

  /** Remember where sheep are (for wool later). Called from the survey. */
  rememberAnimals(radius = 32) {
    for (const a of this.animals(new Set(['sheep']), radius)) this.a.memory.remember('sheep', this.dim.id, a.e.location, 1);
  }

  /**
   * Hunt animals of these types until `enough()` or nothing's left in sight. Chase to the edge of
   * reach, swing on cooldown, pick up the drops. Sheep: the wool colour we already have first.
   */
  async hunt(gen, types, enough, maxS = 90) {
    this.a.hunting = true;
    try { return await this.huntInner(gen, types, enough, maxS); } finally {
      this.a.hunting = false;
      this.a.motor.setFocus(null); // never leave the head locked on a dead animal
    }
  }

  async huntInner(gen, types, enough, maxS) {
    const t0 = system.currentTick;
    const S = this.S;
    if (this.a.weaponId) hold(this.sim, this.a.weaponId);
    let kills = 0, lost = 0;
    // Animals given up on stay skipped for 3 min across hunt() calls (the planner re-enters it).
    /** @type {Map<string, number>} */
    // @ts-ignore
    const hs = (this.huntSkip ??= new Map());
    const skip = { has: (id) => (hs.get(id) ?? 0) > system.currentTick, add: (id) => hs.set(id, system.currentTick + 3600) };
    while (!enough() && system.currentTick - t0 < maxS * 20) {
      S.check(gen);
      const inv = invCounts(this.sim);
      const colour = Object.entries(inv).filter(([id]) => id.endsWith('_wool')).sort((a, b) => b[1] - a[1])[0]?.[0];
      const seen = this.animals(types).filter((a) => !skip.has(a.e.id));
      if (!seen.length) {
        let all = [];
        try { all = this.dim.getEntities({ location: this.sim.location, maxDistance: 40 }).filter((e) => types.has(strip(e.typeId)) && !skip.has(e.id)); } catch {}
        S.log(`hunt: none in sight (${all.length} around)`);
        if (!all.length || ++lost > 5) break;
        // Wandered behind something: walk over toward the nearest one and look again.
        const tgt = all.filter((e) => { try { return !e.hasComponent('minecraft:is_baby'); } catch { return true; } })[0];
        if (!tgt) break;
        await S.goNear(gen, tgt.location, 3, 1);
        await this.a.motor.lookAt(tgt.getHeadLocation(), 10, 20);
        continue;
      }
      lost = 0;
      // Wool still wanted (no bed yet): sheep before cows and pigs, whatever we came out for.
      const woolN = Math.max(0, ...Object.entries(inv).filter(([id]) => id.endsWith('_wool')).map(([, m]) => m)); // one colour makes a bed
      const wantWool = !inv.bed && !this.house?.bed && woolN < 3;
      const pool = wantWool && seen.some((a) => a.type === 'sheep') ? seen.filter((a) => a.type === 'sheep') : seen;
      const pick = pool.find((a) => a.type !== 'sheep' || !colour || sheepColour(a.e) === colour) ?? pool[0];
      const target = pick.e;
      // Only animals we can walk up to (through a gate if there is one): killing a cow across a
      // fence we can't get round just wastes the meat.
      const route = await this.a.plan(this.sim.location, target.location, 2.5, 6000);
      S.check(gen);
      // No full route (a hill the search didn't finish, a pen): go anyway if the route gets us
      // close; only an animal we really can't get near (across water, behind a fence with no
      // gate) is skipped.
      const end = route.path[route.path.length - 1];
      const closeEnough = end && dist3D({ x: end.x + 0.5, y: end.y, z: end.z + 0.5 }, target.location) <= 5;
      S.log(`hunt: ${seen.length} in sight, going for a ${pick.type} ${Math.round(pick.d)} away (route ${route.complete ? 'complete' : closeEnough ? 'gets close' : 'none'})`);
      if (!route.complete && !closeEnough) { skip.add(target.id); continue; }
      this.a.sayOnce(`hunt:${pick.type}`, `Hunting a ${pick.type}.`, 30000);
      if (this.a.weaponId) hold(this.sim, this.a.weaponId);
      let last = target.location, nextRoute = 0, nextSwing = 0;
      const start = system.currentTick;
      // Dead counts from the moment its health hits 0, not when the body disappears a second later.
      const hp = () => { try { return target.getComponent('minecraft:health')?.currentValue ?? 0; } catch { return 0; } };
      const dead = () => { try { return !target.isValid || hp() <= 0; } catch { return true; } };
      let swings = 0, landed = 0, lastHp = hp(), lastLand = start, closeIn = 0, bestD = Infinity, bestAt = start;
      while (!dead() && system.currentTick - start < 400) {
        await S.wait(gen, 2);
        if (dead()) break;
        // Not getting any closer for 4 s (partial route, a drop or wall between): write it off.
        { const dd = dist3D(this.sim.location, target.location); if (dd < bestD - 0.5) { bestD = dd; bestAt = system.currentTick; } else if (system.currentTick - bestAt > 80 && landed === 0) break; }
        last = { ...target.location };
        const p = this.sim.location;
        const d = dist3D(p, last);
        const chest = { x: last.x, y: last.y + 0.6, z: last.z };
        this.a.motor.setFocus(chest);
        const now = system.currentTick;
        if ((now - start) % 100 < 2) S.log(`hunt: ${pick.type} ${d.toFixed(1)} away (${(last.y - p.y).toFixed(1)} up), ${swings} swings, ${landed} hits`);
        if (d > 2.8 && now >= nextRoute) {
          // (Closer and quicker than before: the test runs had a player chase a fleeing sheep at a sprint and hit it on the run, 15 clicks
          // for 3 sheep in 4.8 s, where the bot stood off at 2.2, re-routed every 8 ticks and sprinted only past 6 blocks: 2.5 s between hits.)
          nextRoute = now + 5;
          this.a.routeTo(standOff(p, last, 1.8), 0.5, d > 3.5, 1200);
        } else if (d <= 2.8 && this.a.motor.busy) this.a.motor.stop();
        if (d <= 3.2 && now >= nextSwing) {
          // In reach but not facing it for a second and a half: turn to it directly (the gradual
          // head turn can hang when it's right against us or a block up or down), never just stare.
          const facing = this.a.facing(chest, 30);
          if (facing || now - lastLand > 30) {
            if (!facing) { try { this.sim.lookAtEntity(target); } catch {} }
            try { this.sim.attackEntity(target); } catch {}
            swings++;
            nextSwing = now + 11;
          }
          const h = hp();
          if (h < lastHp) { landed++; lastHp = h; lastLand = now; }
          // Swinging but not hurting it (out of the sim's reach, hitbox edge): step in closer.
          if (now - lastLand > 60 && now >= closeIn) {
            closeIn = now + 40;
            this.a.routeTo(standOff(p, last, 1.3), 0.3, false, 600);
          }
        }
      }
      this.a.motor.setFocus(null);
      this.a.motor.stop();
      const killed = dead();
      S.log(`hunt: ${pick.type} ${killed ? 'down' : 'got away'} after ${((system.currentTick - start) / 20).toFixed(1)} s (${swings} swings, ${landed} hits)`);
      // Its drops are ours either way (it can die just as we give up on it): wait for them, get them.
      for (let i = 0; i < 12; i++) {
        await S.wait(gen, 3);
        try { if (this.dim.getEntities({ type: 'minecraft:item', location: last, maxDistance: 3 }).length) break; } catch {}
        if (!killed && i >= 3 && !dead()) break; // really got away: nothing coming
      }
      if (!killed && !dead()) { skip.add(target.id); continue; }
      kills++;
      const dropsAt = () => { try { return this.dim.getEntities({ type: 'minecraft:item', location: last, maxDistance: 6 }).length; } catch { return 0; } };
      const before = dropsAt();
      await S.sweep(gen, last, 6, null, 10);
      // A wandering trader's leads drop where his llamas were tied, a few blocks off: look wider.
      if (pick.type === 'wandering_trader') {
        await S.wait(gen, 10);
        await S.sweep(gen, last, 16, (id) => id === 'lead', 20);
        let left = [];
        try { left = this.dim.getEntities({ type: 'minecraft:item', location: last, maxDistance: 32 }).filter((e) => e.getComponent('minecraft:item')?.itemStack?.typeId === 'minecraft:lead'); } catch {}
        S.log(`hunt: trader down, ${invCounts(this.sim).lead ?? 0} leads now${left.length ? `; left: ${left.map((e) => `${e.location.x.toFixed(1)} ${e.location.y.toFixed(1)} ${e.location.z.toFixed(1)}`).join(', ')} (trader died at ${last.x.toFixed(1)} ${last.y.toFixed(1)} ${last.z.toFixed(1)})` : ''}`);
      }
      if (dropsAt()) S.log(`hunt: ${dropsAt()} of ${before} drops still on the ground after the sweep`);
    }
    this.a.motor.setFocus(null);
    return kills;
  }

  // ---------- smelting ----------

  furnaceAt(p) {
    const id = this.S.blockAt(p);
    return id === 'furnace' || id === 'lit_furnace';
  }

  container(p) {
    try { return this.dim.getBlock(p)?.getComponent('minecraft:inventory')?.container ?? null; } catch { return null; }
  }

  /**
   * A furnace to use: ore at the mine camp's when we're down there; everything else (and ore up top)
   * at one we remember (the house's), else put ours down here.
   */
  async ensureFurnace(gen, input = null) {
    const S = this.S;
    const camp = S.campFurnace?.();
    if (input === 'ore' && camp && S.isUnderground() && S.nearQuarry(this.sim.location, 48)) {
      if (await S.reach(gen, camp) && this.furnaceAt(camp)) return camp;
    }
    // Our furnace, even a walk away: the plan counts it as ours (settle.js), so go to it rather than
    // failing here over and over. One with nothing cooking first; if they're all busy and there's a
    // furnace in the pack, that one goes down (it used to try the busy one over and over).
    const known = this.furnaceFor(input);
    // (One in the pack and the known one far off: set ours down here. The smelt test walked 84 blocks to the mine camp's furnace for two logs of charcoal.)
    if (known?.pos && (known.dist < (invCounts(this.sim).furnace ? 32 : 128) || !invCounts(this.sim).furnace)) {
      // A long way off: most of the way first (one path search doesn't reach 80 blocks).
      if (known.dist > 40) await S.travelToward(gen, known.pos, Math.ceil(known.dist / 40) + 1);
      await S.reach(gen, known.pos);
      if (this.furnaceAt(known.pos)) return known.pos;
      // Forgotten only when we can see it's gone: not because the walk fell short or its chunk
      // isn't loaded (that forgot the house furnace from 81 blocks off, and every smelt after failed).
      const id = S.blockAt(known.pos);
      if (id !== null && id !== undefined) this.a.memory.forgetNear('furnace', this.dim.id, known.pos, 0.5);
      else return null;
    }
    if (!invCounts(this.sim).furnace) return null;
    const p = await S.place(gen, 'furnace');
    if (p) this.a.memory.remember('furnace', this.dim.id, p);
    return p;
  }

  /** Load the furnace and leave it working. input: 'log' (charcoal) or 'food' (raw meat). */
  async startSmelt(gen, input, n, fuelPlanks, at = null) {
    let pos = at ?? await this.ensureFurnace(gen, input);
    if (!pos) return false;
    // Iron at the camp with its second furnace free: half in each (the second goes in below, after this one).
    let second = null;
    if (!at && input === 'ore' && n >= 4) {
      const c2 = this.S.campFurnace2?.(), c1 = this.S.campFurnace?.();
      if (c1 && c2 && dist3D(pos, c1) < 0.5 && !this.busy(c2) && !this.jobAt(c2)) { second = c2; n = Math.ceil(Math.min(n, invCounts(this.sim).raw_iron ?? 0) / 2); }
    }
    // Still cooking something else: never load over it (the plan will come back when it's done).
    const busy = this.jobAt(pos);
    if (busy && system.currentTick < busy.readyAt) { this.S.log('smelt: that furnace is still going'); return false; }
    const S = this.S;
    if (!(await S.reach(gen, pos))) return false; // in reach and in view, never through a wall
    await this.a.motor.lookAt(center(pos), 10, 30);
    S.check(gen);
    const c = this.container(pos);
    if (!c) return false;
    await this.emptyFurnace(pos);
    // Whatever's still in the input and fuel slots comes back to us first (loading used to write
    // over it: leftover planks or raw meat just vanished).
    for (const slot of [0, 1]) {
      const it = c.getItem(slot);
      if (it) { give(this.sim, strip(it.typeId), it.amount); c.setItem(slot, undefined); }
    }
    let inv = invCounts(this.sim);
    const pickId = (pred) => Object.entries(inv).filter(([id, m]) => m > 0 && pred(id)).sort((a, b) => b[1] - a[1])[0]?.[0];
    // Charcoal: overworld logs and wood only (nether stems don't smelt into it).
    const inId = input === 'log' ? pickId(charcoalInput) : input === 'ore' ? pickId((id) => id === 'raw_iron') : pickId((id) => id in RAW);
    if (!inId) { S.log(`smelt: nothing to put in (${input})`); return false; }
    const wantK = Math.min(n, inv[inId], 64);
    // Fuel the Bedrock way (core/fuel.js): junk first, planks made from logs rather than raw
    // logs, coal only for batches that use it, and sticks kept for the torches.
    const keepSticks = Math.max(0, Math.ceil((TORCH_GOAL - (inv.torch ?? 0)) / 4));
    const plan = planFuel(inv, inId, wantK, { keepSticks });
    if (!plan) {
      S.log(`smelt: no fuel (${Object.entries(inv).filter(([id]) => burnsFor(id) > 0).map(([id, m]) => `${id} ${m}`).join(', ') || 'nothing that burns'})`);
      return false;
    }
    if (plan.plankFrom) {
      take(this.sim, plan.plankFrom, plan.planks);
      give(this.sim, plan.fuel, plan.planks * 4);
      await S.wait(gen, 6);
      inv = invCounts(this.sim);
    }
    const k = plan.k, fuelId = plan.fuel, fuelN = Math.min(plan.n, inv[fuelId] ?? 0);
    if (k < wantK) S.log(`smelt: fuel for ${k} of ${wantK} (${fuelN} ${fuelId})`);
    S.log(`smelt: ${k} ${inId}, fuel ${fuelN} ${fuelId}${plan.plankFrom ? ` (planked ${plan.planks} ${plan.plankFrom})` : ''}`);
    take(this.sim, inId, k);
    take(this.sim, fuelId, fuelN);
    c.setItem(0, new ItemStack(`minecraft:${inId}`, k));
    c.setItem(1, new ItemStack(`minecraft:${fuelId}`, fuelN));
    this.setJob({ pos, readyAt: system.currentTick + k * 200 + 20, kind: input, n: k });
    this.a.saveState();
    this.a.say(`Furnace going: ${k} ${inId.replace(/_/g, ' ')} (${Math.round(k * 10)} s). I'll get on with other things.`);
    if (second && (invCounts(this.sim).raw_iron ?? 0) > 0) {
      this.S.log('smelt: the rest in the camp\'s second furnace');
      await this.startSmelt(gen, input, invCounts(this.sim).raw_iron, fuelPlanks, second).catch((e) => { if (e?.constructor?.name === 'Aborted') throw e; this.S.log(`smelt: second furnace: ${e}`); });
    }
    return true;
  }

  /** Take whatever's done out of the furnace. */
  async emptyFurnace(pos) {
    const c = this.container(pos);
    if (!c) return 0;
    let n = 0;
    for (const slot of [2]) {
      const it = c.getItem(slot);
      if (!it) continue;
      // What fits in the pack; the rest stays in the furnace (dropped at our feet with a full pack,
      // it couldn't be picked up and was gone in 5 minutes).
      const left = packOf(this.sim)?.addItem(it.clone());
      const moved = it.amount - (left?.amount ?? 0);
      n += moved;
      c.setItem(slot, left && left.amount > 0 ? left : undefined);
    }
    return n;
  }

  /** The furnace's output slot still has something in it (the pack was full). */
  outputLeft(pos) { try { return this.container(pos)?.getItem(2)?.amount ?? 0; } catch { return 0; } }

  async collectSmelt(gen) {
    // The nearest finished job (else the nearest one).
    const near = this.smeltJob;
    const ready = near && system.currentTick >= near.readyAt ? near : this.jobs.filter((j) => system.currentTick >= j.readyAt).sort((a, b) => dist3D(this.sim.location, a.pos) - dist3D(this.sim.location, b.pos))[0];
    const job = ready ?? near;
    if (!job) return;
    if (!(await this.S.reach(gen, job.pos))) {
      // Visibly not a furnace any more (picked up, blown up): the job is dead, don't fail on it for ever.
      const id = this.S.blockAt(job.pos);
      if (id !== null && id !== undefined && !this.furnaceAt(job.pos)) { this.dropJob(job.pos); this.a.saveState(); this.S.log('furnace: gone, forgot the job'); return; }
      this.S.log('furnace: couldn\'t get to it (in reach and in view)');
      return;
    }
    if (!this.furnaceAt(job.pos)) { this.dropJob(job.pos); this.a.saveState(); return; }
    await this.a.motor.lookAt(center(job.pos), 10, 30);
    this.S.check(gen);
    let got = await this.emptyFurnace(job.pos);
    // Pack full, output still in there: put things away (the chests are at the house) and take the rest.
    if (this.outputLeft(job.pos) && this.chests().length && dist3D(this.sim.location, this.house) <= 24) {
      await this.storeItems(gen);
      if (await this.S.reach(gen, job.pos)) got += await this.emptyFurnace(job.pos);
    }
    const c = this.container(job.pos);
    const left = c?.getItem(0)?.amount ?? 0;
    // Still some in, no fuel and not burning (someone took the fuel, planks we made fell out of a
    // full pack): it will never finish. Take the rest back rather than wait on it for ever.
    const dead = left > 0 && !c?.getItem(1) && this.S.blockAt(job.pos) !== 'lit_furnace';
    if (dead) {
      const it = c.getItem(0);
      give(this.sim, strip(it.typeId), it.amount);
      c.setItem(0, undefined);
      this.dropJob(job.pos);
      this.a.say(`The furnace ran out of fuel with ${left} still in it; took them back.`);
    } else if (left) this.setJob({ ...job, readyAt: system.currentTick + left * 200 + 20 });
    else if (this.outputLeft(job.pos)) this.setJob({ ...job, readyAt: system.currentTick }); // (still to take: kept, ready)
    else this.dropJob(job.pos);
    this.a.saveState();
    if (got) this.a.say(`Took ${got} out of the furnace.`);
  }

  /** Stand by the furnace until the job's done (only when there's nothing else to do). */
  async waitSmelt(gen) {
    const job = this.planJob() ?? this.smeltJob;
    if (!job) return;
    await this.S.reach(gen, job.pos);
    // Waited out, unless it can't finish: the furnace gone (a creeper), or out (no fuel, not lit,
    // something still in): then straight to collecting, which takes the rest back.
    while (system.currentTick < job.readyAt) {
      await this.S.wait(gen, 20);
      if (!this.furnaceAt(job.pos)) break;
      const c = this.container(job.pos);
      if ((c?.getItem(0)?.amount ?? 0) > 0 && !c?.getItem(1) && this.S.blockAt(job.pos) !== 'lit_furnace') break;
    }
    await this.collectSmelt(gen);
  }

  /** Pick the furnace back up (so it can go in the house). */
  async fetchFurnace(gen) {
    // Never the mine camp's: that one stays down there.
    const f = this.a.memory.list('furnace', this.dim.id, this.sim.location).filter((e) => !this.isCamp(e.pos))[0];
    if (!f || (this.house && inside(this.house, f.pos))) return false;
    if (this.jobAt(f.pos)) await this.collectSmelt(gen);
    if (this.jobAt(f.pos)) return false; // still cooking
    if (!(await this.S.reach(gen, f.pos))) return false;
    await this.emptyFurnace(f.pos);
    const ok = await this.S.mine(gen, f.pos);
    if (ok) this.a.memory.forgetNear('furnace', this.dim.id, f.pos, 0.5);
    return ok;
  }

  // ---------- building ----------

  /**
   * Put `itemId` into cell: click a solid neighbour's face toward the cell (below first, then the
   * sides, then above), like a player placing against whatever's there.
   */
  async placeAt(gen, cell, itemId, via = null, next = null, { liquid = false, lenient = true, stay = false } = {}) {
    const S = this.S;
    // (A bed, chest, door or sign never goes down by a click from the simulated player: those
    // are set with a command after this fails, no point trying them again here.)
    if (/bed|chest|door|sign/.test(itemId)) lenient = false;
    // (liquid: into water or lava, to stop it.)
    const open = (id) => SOFT.test(id) || (liquid && /water|lava/.test(id));
    if (!open(S.blockAt(cell) ?? 'air')) return S.blockAt(cell) === itemId;
    const faces = via ? FACES.filter(([o]) => cell.x + o[0] === via.x && cell.y + o[1] === via.y && cell.z + o[2] === via.z) : FACES;
    const solidAt = (n) => { const nid = S.blockAt(n) ?? 'air'; return !SOFT.test(nid) && !/water|lava/.test(nid); };
    const nOf = (o) => ({ x: cell.x + o[0], y: cell.y + o[1], z: cell.z + o[2] });
    // Only a face the crosshair gets onto from here (we're on its open side and can see it): a
    // player can't put a block against the far side of a wall. None from here: step round to
    // where there is one (goSee), once.
    const clickable = (e) => faces.some(([o]) => solidAt(nOf(o)) && S.placePoint(cell, nOf(o), e));
    this.placeWhy = '';
    if (!faces.some(([o]) => solidAt(nOf(o)))) { this.placeWhy = 'nothing solid beside it'; return false; }
    if (!S.inReach(cell) || !clickable(S.eye())) {
      // (stay: the caller has put us where it wants us, on a spot it chose, and does not want us walking off it: the iron farm's build, on a 1-wide wall top)
      if (stay ? !S.inReach(cell) : !(await S.goSee(gen, cell, clickable))) {
        this.placeWhy = 'no place to stand where the crosshair gets onto a face';
        return lenient && await this.placeAnyway(gen, cell, itemId, faces, solidAt, nOf, open, next);
      }
    }
    for (const [o, face, loc] of faces) {
      const n = nOf(o);
      if (!solidAt(n)) continue;
      const pp = S.placePoint(cell, n, S.eye());
      if (!pp) { this.placeWhy = `no line to the ${face} face from here`; continue; }
      const slot = hold(this.sim, itemId);
      if (slot < 0) { this.placeWhy = `no ${itemId} in hand`; return false; }
      // The crosshair onto the face we'll click, then straight on toward the next block as this
      // one goes down.
      this.a.motor.setFocus(pp.pt);
      let on = false;
      for (let k = 0; k <= 10 && !on; k++) {
        const h = S.crosshair();
        on = !!h && ((h.location.x === n.x && h.location.y === n.y && h.location.z === n.z && h.face.x === -o[0] && h.face.y === -o[1] && h.face.z === -o[2]) ||
          (h.location.x === cell.x && h.location.y === cell.y && h.location.z === cell.z));
        if (!on && k < 10) await S.wait(gen, 1);
      }
      S.check(gen);
      if (!on) { const h = S.crosshair(); this.placeWhy = `crosshair on ${h ? `${S.blockAt(h.location)} ${h.location.x} ${h.location.y} ${h.location.z} ${h.face.x},${h.face.y},${h.face.z}` : 'nothing'}, not the ${face} face of ${n.x} ${n.y} ${n.z}`; continue; }
      const r = await S.placeOn(gen, slot, n, face, loc, cell);
      this.a.motor.setFocus(next ? center(next) : null);
      if (r || !open(S.blockAt(cell) ?? 'air')) return true;
      this.placeWhy = `used it against ${S.blockAt(n)} (${face}): ${r}, still ${S.blockAt(cell)}`;
      S.log(`place ${itemId} at ${cell.x} ${cell.y} ${cell.z} against ${S.blockAt(n)} (${face}): ${r}, still ${S.blockAt(cell)}`);
    }
    return lenient && await this.placeAnyway(gen, cell, itemId, faces, solidAt, nOf, open, next);
  }

  /**
   * Last go for a block the crosshair wouldn't get onto a face for (the top course of a wall from
   * the ground, a roof edge, a face the head turn never settled on): in reach, so put it against a
   * neighbour's face, aimed at it as near as the head gets. The game takes the click on the named
   * face. Logged, so the ones that came from here can be counted.
   */
  async placeAnyway(gen, cell, itemId, faces, solidAt, nOf, open, next) {
    const S = this.S;
    // Only a spot the eye has a line to: nothing between it and the spot but what is built right
    // against it (the top course over a wall is hidden by that very wall, and that is where a hand
    // reaches over). A wall or a box further off in the way is no place to build through. What
    // can't be had is the face to click, not the place.
    if (!S.inReach(cell)) return false;
    const e = S.eye(), c = center(cell);
    const d = { x: c.x - e.x, y: c.y - e.y, z: c.z - e.z };
    let hit = null;
    try { hit = castRay(this.dim, e, d, Math.max(0.1, Math.hypot(d.x, d.y, d.z) - 0.35), { vines: true }); } catch { return false; }
    if (hit) {
      const l = hit.location;
      if (Math.max(Math.abs(l.x - cell.x), Math.abs(l.y - cell.y), Math.abs(l.z - cell.z)) > 1) return false;
    }
    for (const [o, face, loc] of faces) {
      const n = nOf(o);
      if (!solidAt(n)) continue;
      const slot = hold(this.sim, itemId);
      if (slot < 0) return false;
      await S.aim(gen, { x: (cell.x + n.x) / 2 + 0.5, y: (cell.y + n.y) / 2 + 0.5, z: (cell.z + n.z) / 2 + 0.5 }, 15, 6);
      const r = await S.placeOn(gen, slot, n, face, loc, cell);
      this.a.motor.setFocus(next ? center(next) : null);
      if (r || !open(S.blockAt(cell) ?? 'air')) {
        this.placedAnyway = (this.placedAnyway ?? 0) + 1;
        S.log(`place ${itemId} at ${cell.x} ${cell.y} ${cell.z}: no clear line (${this.placeWhy}); put it against the ${face} face anyway`);
        return true;
      }
    }
    return false;
  }

  /**
   * The crosshair onto a face of a solid neighbour of `cell` that a block put against it would land in `cell` from (the same rules as placeAt: in
   * reach, the eye on the open side of the face, nothing in the way), the block in hand. { slot, n } once it is on, null if there is none or it
   * would not settle in `aimTicks`. `below`: only the top of the block under it (a slab clicked there is a bottom slab). The u216 hands use it.
   */
  async aimFace(gen, cell, itemId, { below = false, aimTicks = 6, snap = false, lenient = false } = {}) {
    const S = this.S;
    if (!S.inReach(cell)) { this.placeWhy = 'out of reach'; return null; }
    const solidAt = (n) => { const nid = S.blockAt(n) ?? 'air'; return !SOFT.test(nid) && !/water|lava/.test(nid); };
    const faces = below ? FACES.slice(0, 1) : FACES;
    const slot = hold(this.sim, itemId);
    if (slot < 0) { this.placeWhy = `no ${itemId} in hand`; return null; }
    let seen = null;
    for (const [o, face] of faces) {
      const n = { x: cell.x + o[0], y: cell.y + o[1], z: cell.z + o[2] };
      if (!solidAt(n)) continue;
      const pp = S.placePoint(cell, n, S.eye());
      if (!pp) { this.placeWhy = `no line to the ${face} face from here`; continue; }
      seen ??= { slot, n, face, settled: false };
      if (snap && this.a.motor.snap) this.a.motor.snap(pp.pt); else this.a.motor.setFocus(pp.pt);
      for (let k = 0; k <= aimTicks; k++) {
        const h = S.crosshair();
        if (h && ((h.location.x === n.x && h.location.y === n.y && h.location.z === n.z && h.face.x === -o[0] && h.face.y === -o[1] && h.face.z === -o[2]) ||
          (h.location.x === cell.x && h.location.y === cell.y && h.location.z === cell.z))) return { slot, n, face, settled: true };
        if (k < aimTicks) await S.wait(gen, 1);
      }
      this.placeWhy = `the crosshair did not settle on the ${face} face`;
    }
    // (lenient: a face the eye has a clear line to, though the head's own crosshair never reported it: the line is what a player needs, the
    // report is the game's; the quick hand takes it, the held button never does, as it puts the block wherever the crosshair really is.)
    if (lenient && seen) { this.placedLenient = (this.placedLenient ?? 0) + 1; return seen; }
    return null;
  }

  /**
   * The quick hand (u216, `!bot buildfarm`, a cheat by design): everything a player's placement needs (in reach, the crosshair on a solid
   * neighbour's face from where it stands, the block in hand and one taken from the pack), but once the crosshair is on the face the block is put
   * in by `put(cell)` (a command), not by the game's item use, which a simulated player is given only once every 10 ticks (a player places every
   * 3 or 4). `gap`: the fewest ticks since the last one, a player's pace. The aim overlaps the wait, as a hand moves while the click comes round.
   */
  async placeQuick(gen, cell, itemId, put, { gap = 3, below = false, aimTicks = 3, sound = null, snap = true } = {}) {
    const S = this.S;
    if (!SOFT.test(S.blockAt(cell) ?? 'air')) { this.placeWhy = `${S.blockAt(cell)} there`; return false; }
    const on = await this.aimFace(gen, cell, itemId, { below, aimTicks, snap, lenient: true });
    if (!on) return false;
    const since = system.currentTick - (this.quickAt ?? -100);
    if (since < gap) await S.wait(gen, gap - since);
    S.check(gen);
    if (!put(cell)) { this.placeWhy = 'the block would not go in'; return false; }
    this.quickAt = system.currentTick;
    take(this.sim, itemId, 1);
    if (sound) { try { this.dim.playSound(sound, center(cell)); } catch { /* */ } }
    return true;
  }

  /**
   * The held hand (u216, experimental): the game's own "keep the use button down" (SimulatedPlayer.startBuild, undocumented), started once the
   * crosshair is on the face and stopped as soon as the block is in, so the game does the placing at whatever pace it gives a held button.
   * { ok, extra }: extra is how many more of the item went than the one (a second block put down before the stop: somewhere it should not be).
   */
  async placeHeld(gen, cell, itemId, { below = false, aimTicks = 6, maxTicks = 12, snap = true } = {}) {
    const S = this.S;
    if (!SOFT.test(S.blockAt(cell) ?? 'air')) { this.placeWhy = `${S.blockAt(cell)} there`; return { ok: false, extra: 0 }; }
    const on = await this.aimFace(gen, cell, itemId, { below, aimTicks, snap });
    if (!on) return { ok: false, extra: 0 };
    const before = invCounts(this.sim)[itemId] ?? 0;
    const crouch = USABLE.test(S.blockAt(on.n) ?? '') && !this.sim.isSneaking;
    let ok = false;
    try {
      // (Crouched, the button held, if the face is on a chest, a hopper, a composter...: a click there opens it.)
      if (crouch) this.sim.isSneaking = true;
      /** @type {any} */ (this.sim).startBuild(on.slot);
      for (let k = 0; k < maxTicks; k++) {
        await S.wait(gen, 1);
        if (!SOFT.test(S.blockAt(cell) ?? 'air')) { ok = true; break; }
      }
    } finally { try { /** @type {any} */ (this.sim).stopBuild(); } catch { /* */ } try { if (crouch) this.sim.isSneaking = false; } catch { /* */ } }
    const used = before - (invCounts(this.sim)[itemId] ?? 0);
    if (!ok) this.placeWhy = 'the held button put nothing there';
    return { ok, extra: Math.max(0, used - (ok ? 1 : 0)) };
  }

  /**
   * Place a set of blocks one leading into the next, the order a hand sweeps (core/flow.js: along a
   * course, up a course, bottom up, only against something), not one by one with a stop and look
   * between. items: [{ cell, id, via? }]; id may be a function (the material, looked up as we go).
   * beforeEach(item) may walk us into reach. Returns { placed, missed }.
   */
  async placeFlow(gen, items, beforeEach = null) {
    const S = this.S;
    const key = (c) => `${c.x},${c.y},${c.z}`;
    const byKey = new Map(items.map((it) => [key(it.cell), it]));
    const solid = (c) => !SOFT.test(S.blockAt(c) ?? 'air') && !/water|lava/.test(S.blockAt(c) ?? '');
    const supported = (c, placed) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
      .some(([a, b, d]) => { const n = { x: c.x + a, y: c.y + b, z: c.z + d }; return placed.has(key(n)) || solid(n); });
    const order = S.sweepCells(items.map((it) => it.cell), 'place', supported);
    let placed = 0, missed = 0;
    try {
      for (let i = 0; i < order.length; i++) {
        S.check(gen);
        const it = byKey.get(key(order[i]));
        if (beforeEach) await beforeEach(it);
        const id = typeof it.id === 'function' ? it.id() : it.id;
        if (!id) return { placed, missed: missed + order.length - i, outOf: true };
        if (await this.placeAt(gen, it.cell, id, it.via ?? null, order[i + 1] ?? null)) placed++; else missed++;
      }
    } finally {
      this.a.motor.setFocus(null);
    }
    return { placed, missed };
  }

  /** Least valuable block of this kind we carry: 'stone' or 'planks' (either will do if one runs out). */
  materialFor(kind) {
    const inv = invCounts(this.sim);
    const pick = (pred) => Object.entries(inv).filter(([id]) => pred(id)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const stone = pick((id) => TOOL_STONE.has(id)), planks = pick(isPlanks);
    return kind === 'stone' ? stone ?? planks : planks ?? stone;
  }

  /**
   * Where to build: within ~20 blocks, scored by how long the site takes to get ready (dig bumps,
   * fill dips up to 2 deep, cut a small tree in the way, move our own table or furnace off it),
   * the walk, and the biome (grassy plains and ordinary forest first; dense forest, swamp, desert,
   * snow and shore last), and whether it can be cleared and built before dusk (core/site.js).
   */
  async findSite(gen) {
    const S = this.S;
    const f = S.feet();
    const R = 20;
    const heights = new Map();
    const H = (x, z) => {
      const k = `${x},${z}`;
      if (!heights.has(k)) heights.set(k, S.groundTop(x, z));
      return heights.get(k);
    };
    // Rough pass: ground height spread over the 5x5 within 2, cheapest-looking first.
    const cands = [];
    let n = 0;
    for (let r = 0; r <= R; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = f.x + dx, z = f.z + dz;
        const g = H(x, z);
        if (!Number.isFinite(g)) continue;
        let work = 0, bad = false;
        for (let a = -2; a <= 2 && !bad; a++) for (let b = -2; b <= 2 && !bad; b++) {
          const h = H(x + a, z + b);
          if (!Number.isFinite(h) || Math.abs(h - g) > 2) bad = true;
          else work += Math.abs(h - g);
        }
        if (!bad) cands.push({ x, y: g + 1, z, layout: this.newLayout(), rough: work * 1.2 + r / 4.3 });
        if (++n % 60 === 0) await S.wait(gen, 1);
      }
    }
    cands.sort((a, b) => a.rough - b.rough);
    // Full pass on the best few: every block, all four facings.
    const inv = invCounts(this.sim);
    const time = world.getTimeOfDay();
    const secondsLeft = isNight(time) ? Infinity : Math.max(0, (11500 - time) / 20);
    let best = null;
    for (const c of cands.slice(0, 24)) {
      const biome = this.a.lookout?.biomeAt(c.x, c.z, c.y) ?? null;
      for (const dir of ['south', 'north', 'east', 'west']) {
        const work = siteWork(this.siteCells(c, dir), inv);
        const score = siteScore(work, { dist: Math.hypot(c.x - f.x, c.z - f.z), biome, secondsLeft });
        if (score < (best?.score ?? Infinity)) best = { ...c, dir, score, work, biome };
      }
      await S.wait(gen, 1);
    }
    if (best) S.log(`house site: ${best.x} ${best.y} ${best.z} facing ${best.dir}, ${best.biome ?? '?'}, ${Math.round(best.work.seconds)} s to clear (${best.work.logs} logs, ${best.work.moves} to move), score ${Math.round(best.score)}`);
    return best && Number.isFinite(best.score) ? { x: best.x, y: best.y, z: best.z, dir: best.dir, layout: best.layout } : null;
  }

  /** The layout a new house gets: the one learned from the player (`!bot house learned on`, a plan that passed), else the starter's. */
  newLayout() { return this.a.memory.data.settings?.learnedHouse && getPlan() ? 'learned' : NEW_LAYOUT; }

  /** What's at the site now, for core/site.js: the room's volume and the ground under the floor. */
  siteCells(o, dir) {
    const S = this.S;
    /** @type {Array<{id: string, part: string, below?: string, below2?: string}>} */
    const cells = clearance(o, dir).map((p) => ({ id: S.blockAt(p) ?? 'air', part: 'clear' }));
    for (const p of footing(o, dir)) {
      cells.push({ id: S.blockAt(p) ?? 'air', part: 'foot', below: S.blockAt({ ...p, y: p.y - 1 }) ?? 'air', below2: S.blockAt({ ...p, y: p.y - 2 }) ?? 'air' });
    }
    return cells;
  }

  siteOk(o, dir) {
    return siteWork(this.siteCells(o, dir), invCounts(this.sim)).ok;
  }

  /**
   * Our crafting table or furnace is where the house goes: pick it up (it goes inside when we
   * furnish). A furnace that's cooking is emptied first (what's in it drops and we collect it).
   */
  async moveStation(gen, p, id) {
    const job = id !== 'crafting_table' ? this.jobAt(p) : null;
    if (job) {
      if (system.currentTick >= job.readyAt) await this.collectSmelt(gen);
      this.dropJob(p);
      this.a.saveState();
    }
    this.a.sayOnce(`move-${id}`, `My ${id === 'crafting_table' ? 'crafting table' : 'furnace'} is where the house goes: moving it inside.`, 60000);
    if (await this.S.mine(gen, p)) this.a.memory.forgetNear(id === 'crafting_table' ? 'crafting_table' : 'furnace', this.dim.id, p, 0.5);
  }

  /** The house we've started (site and facing), kept in the world's memory until it's finished. */
  get project() {
    const p = this.a.memory.data.houseProject;
    return p && p.d === this.dim.id ? p : null;
  }

  /** How far along the started house is: { placed, total }. */
  projectProgress() {
    const p = this.project;
    if (!p) return null;
    let placed = 0, total = 0;
    for (const b of blueprint(p, p.dir)) { total++; if (!houseMissing(this.S.blockAt(b) ?? 'air')) placed++; } // (a trunk there isn't a wall)
    return { placed, total };
  }

  /**
   * Blocks still needed to finish the shell at this site: { stone, planks } (0/0 when we have them).
   * With `fittings`, the planks for the door, bed, table and chest count too: one trip for all of it.
   */
  houseNeeds(site, dir, opts = {}) {
    const inv = invCounts(this.sim);
    const sig = Object.entries(inv).filter(([id]) => TOOL_STONE.has(id) || isPlanks(id) || isLog(id) || /^(wooden_door|bed|crafting_table|chest)$/.test(id)).map(([id, n]) => `${id}${n}`).join();
    return this.memo(`needs:${site.x},${site.y},${site.z},${dir},${!!opts.fittings}`, 20, () => this.houseNeedsNow(site, dir, opts), sig);
  }

  houseNeedsNow(site, dir, { fittings = false } = {}) {
    const cacheKey = fittings ? 'lastNeedsFit' : 'lastNeeds';
    // Site out of range (not loaded): unknown, not "everything": keep the last count we made.
    if (this.S.blockAt(site) === null) return this[cacheKey] ?? { stone: 0, planks: 0 };
    let stone = 0, planks = 0;
    const missing = (p) => { const id = this.S.blockAt(p); return id !== null && SOFT.test(id); }; // unloaded: unknown
    // A wall or roof block's place with a trunk, low leaves or a lump of dirt in it is cleared
    // first: still to build (counted as built, a house in the woods ran out halfway: tools/sim_house.mjs).
    const toBuild = (p) => { const id = this.S.blockAt(p); return id !== null && houseMissing(id); };
    for (const b of blueprint(site, dir)) if (toBuild(b)) b.material === 'stone' ? stone++ : planks++;
    // Filler under the floor: the hole, and the one under it if it's two deep (both get filled).
    for (const p of footing(site, dir)) if (missing(p)) { stone++; if (missing({ ...p, y: p.y - 1 })) stone++; }
    const inv = invCounts(this.sim);
    const haveStone = count(inv, (id) => TOOL_STONE.has(id)), havePlanks = count(inv, isPlanks) + count(inv, isLog) * 4;
    // Either material can stand in for the other in the walls, so compare the totals too.
    const shortStone = Math.max(0, stone - haveStone), shortPlanks = Math.max(0, planks - havePlanks);
    const spare = Math.max(0, haveStone - stone) + Math.max(0, havePlanks - planks);
    const walls = shortStone + shortPlanks <= spare ? { stone: 0, planks: 0 } : { stone: shortStone, planks: shortPlanks };
    if (!fittings) return this[cacheKey] = walls;
    // The door, bed, table and chest are wood and nothing else: whatever wood the walls leave over.
    // Plus a log's worth spare: a plank that doesn't place, a block knocked out while building.
    const fitShort = Math.max(0, fittingsPlanks(inv, null, layoutOf(site)) + 4 - Math.max(0, havePlanks - planks));
    return this[cacheKey] = { stone: walls.stone, planks: walls.planks + fitShort };
  }


  /** Craft enough planks (from logs) for what's left of the house's plank blocks. */
  async plankUp(gen, site, dir) {
    let planksLeft = 0;
    for (const b of blueprint(site, dir)) if (b.material === 'planks' && houseMissing(this.S.blockAt(b) ?? 'air')) planksLeft++; // (leaves where the roof goes too)
    for (let i = 0; i < 20; i++) {
      const inv = invCounts(this.sim);
      if (count(inv, isPlanks) >= planksLeft || count(inv, isLog) === 0) break;
      if (!(await this.S.craft(gen, ['planks'], false, true))) break;
    }
  }

  /**
   * Choose the house site now and count exactly what's missing for it (every wall and roof block
   * not there yet, every hole under the floor), so one trip gets everything.
   */
  async planHouse(gen) {
    if (this.house || this.project) return true;
    const site = await this.findSite(gen);
    if (!site) { this.a.sayOnce('nosite', 'No flat, clear spot for a house around here. Looking elsewhere.', 60000); await this.S.explore(gen, 'a flat spot'); return false; }
    this.a.memory.data.houseProject = { d: this.dim.id, x: site.x, y: site.y, z: site.z, dir: site.dir, layout: site.layout, started: Date.now() };
    this.a.memory.saveNow();
    // Walls, roof and fittings (door, bed, table, chest) together: one trip for all of it.
    const need = this.houseNeeds(site, site.dir, { fittings: true });
    this.shortfall = need;
    const logs = Math.ceil(need.planks / 4);
    this.a.say(need.stone || need.planks
      ? `House spot picked at ${site.x} ${site.y} ${site.z}. Still need ${need.stone} cobblestone and ${need.planks} planks (${logs} logs), counting the door, bed, table, chests and signs.`
      : `House spot picked at ${site.x} ${site.y} ${site.z}; I have everything for it.`);
    return true;
  }

  async buildHouse(gen) {
    const S = this.S;
    if (this.house) return true;
    // Carry on with the house we started, if there is one: never start a second.
    let site = this.project;
    if (!site) {
      site = await this.findSite(gen);
      if (!site) { this.a.sayOnce('nosite', 'No flat, clear spot for a house around here. Looking elsewhere.', 60000); await S.explore(gen, 'a flat spot'); return false; }
    }
    const { dir } = site;
    const fur = furnishings(site, dir);
    // Everything in hand before the first block goes down (so it's never left half built).
    const need = this.houseNeeds(site, dir);
    if (need.stone || need.planks) {
      this.shortfall = need;
      this.a.sayOnce('house-short', `For the house I still need ${need.stone ? `${need.stone} cobblestone` : ''}${need.stone && need.planks ? ' and ' : ''}${need.planks ? `${need.planks} planks` : ''}.`, 60000);
      return false;
    }
    this.shortfall = null;
    if (!this.project) { this.a.memory.data.houseProject = { d: this.dim.id, x: site.x, y: site.y, z: site.z, dir, layout: site.layout, started: Date.now() }; this.a.memory.saveNow(); }
    this.a.say(this.project && S.feet() ? 'Building the house.' : 'Building a house here.');
    await S.goNear(gen, fur.stand, 1.5, 3);
    // Logs don't go in walls: turn what we need into planks first (this is what used to run us
    // out of "blocks" halfway with a stack of logs in hand).
    await this.plankUp(gen, site, dir);
    // Level: dig out plants and natural bumps. Never anything we built: coming back to a half-built
    // house must not tear its walls down (that's the build-destroy-rebuild loop).
    // Top down, so a tree comes down trunk-last and nothing falls on us.
    // Grass and flowers first, swiped through in one go from where we stand.
    await S.swipe(gen, clearance(site, dir).filter((p) => ONE_TAP.test(S.blockAt(p) ?? 'air') && S.inReach(p)));
    const clear = [];
    for (const p of clearance(site, dir)) {
      const id = S.blockAt(p) ?? 'air';
      if (id === 'air') continue;
      if (/^(crafting_table|furnace|lit_furnace)$/.test(id)) { await this.moveStation(gen, p, id); continue; }
      if (SOFT.test(id) || DIGGABLE_SITE.test(id) || /leaves$/.test(id) || isLog(id)) clear.push(p);
    }
    // One block leading into the next, top down within each column (a tree comes down trunk-last).
    await S.mineFlow(gen, clear, (p) => { const id = S.blockAt(p) ?? 'air'; return { collect: !SOFT.test(id) && !/leaves$/.test(id) }; });
    // Fill dips under the floor (up to 2 deep), bottom first.
    for (const p of footing(site, dir)) {
      for (const q of [{ ...p, y: p.y - 1 }, p]) {
        if (!SOFT.test(S.blockAt(q) ?? 'air')) continue;
        if (q.y < p.y && !SOFT.test(S.blockAt(p) ?? 'air')) continue;
        const inv = invCounts(this.sim);
        // Dirt or odd stone first, then cobblestone (counted for this); never planks (the walls').
        const filler = cheapestPlaceable(inv, plankReserve(inv)) ?? this.materialFor('stone');
        if (!S.inReach(q)) await S.goNear(gen, q, 2);
        if (filler) await this.placeAt(gen, q, filler);
      }
    }
    // Walls and roof, from the middle of the room.
    await S.goNear(gen, fur.stand, 0.4, 3);
    // Course by course, one block leading into the next (placeFlow), from the middle of the room.
    const walls = blueprint(site, dir).filter((b) => SOFT.test(S.blockAt(b) ?? 'air'));
    // (The chest room's walls and roof from the chest room: whichever room's middle is nearer.)
    const built = await this.placeFlow(gen, walls.map((b) => ({ cell: b, id: () => this.materialFor(b.material) })),
      async (it) => { if (!S.inReach(it.cell)) await S.goNear(gen, standFor(fur, it.cell), 0.4, 2); });
    if (built.outOf) { this.a.say("Ran out of blocks for the house; I'll get more and finish it."); this.shortfall = this.houseNeeds(site, dir); return false; }
    // What the sweep couldn't place (35 blocks of the first chest-room house): one at a time from
    // the nearer room's middle, then from right by it, the way a repair goes (that got 33 of them).
    let missed = 0;
    for (const b of blueprint(site, dir).filter((c) => SOFT.test(S.blockAt(c) ?? 'air'))) {
      S.check(gen);
      const id = this.materialFor(b.material);
      if (!id) break;
      if (!S.inReach(b)) await S.goNear(gen, standFor(fur, b), 0.4, 2);
      if (!S.inReach(b)) await S.goNear(gen, b, 2, 2);
      if (!(await this.placeAt(gen, b, id))) { missed++; trace(`house: couldn't place ${b.material} lx ${b.lx} lz ${b.lz} h ${b.h} (${b.x} ${b.y} ${b.z}) from ${Math.round(this.sim.location.x)} ${Math.round(this.sim.location.y)} ${Math.round(this.sim.location.z)}: ${this.placeWhy}`); }
    }
    if (built.missed) trace(`house: the sweep missed ${built.missed}, the second pass left ${missed}`);
    if (missed > 3) { this.a.say(`Couldn't place ${missed} blocks of the house.`); }
    this.setHouse({ x: site.x, y: site.y, z: site.z, dir, layout: site.layout, bed: false, furnace: false, table: false, level: 1 });
    this.a.memory.data.houseProject = null;
    this.a.memory.saveNow();
    await this.furnish(gen);
    await this.placeDoor(gen);
    // Torches outside, either side of the door.
    await this.leaveHouse(gen);
    for (const t of fur.torchesOutside) {
      if (!invCounts(this.sim).torch) break;
      if ((S.blockAt(t.toward) ?? 'air') !== 'air' && !(await this.clearForTorch(gen, t.toward))) continue;
      await this.placeAt(gen, t.toward, 'torch', t.on);
    }
    S.restHands();
    const st = this.houseState();
    const missing = ['door', 'bed', 'table', 'furnace'].filter((k) => !st[k]).concat(st.lit ? [] : ['torches']);
    this.a.say(missing.length ? `House built. Still to go: ${missing.join(', ')}.` : 'House done: door, bed, table, furnace, torches.');
    return true;
  }

  /**
   * Blocks of the house that aren't there any more (walls, roof, the floor under it): a creeper,
   * a player, our own mistake. Checked against the blueprint every time we plan (69 block reads).
   */
  /** Can we read the house's blocks right now (its chunks loaded)? */
  houseLoaded() {
    const h = this.house;
    if (!h) return false;
    const fur = furnishings(h, h.dir);
    return [h, fur.door, fur.stand].every((p) => this.S.blockAt(p) !== null);
  }

  houseDamage() {
    const h = this.house;
    if (!h || !this.houseLoaded()) return [];
    // Unreadable (a chunk not loaded: the house can straddle a chunk border) is unknown, not missing.
    const missing = (p) => { const id = this.S.blockAt(p); return id !== null && SOFT.test(id); };
    const out = [];
    for (const b of blueprint(h, h.dir)) if (missing(b)) out.push(b);
    // (A hole in the footing sealed in on every side, under the wall: no one can get a block in
    // there, and it does no harm. Not damage.)
    for (const p of footing(h, h.dir)) if (missing(p) && !this.sealedVoid(p)) out.push({ ...p, material: 'stone' });
    return out;
  }

  /** An air pocket (up to 6 cells) with solid blocks all round it: out of everyone's reach. */
  sealedVoid(p) {
    const S = this.S;
    const k = (c) => `${c.x},${c.y},${c.z}`;
    const seen = new Set([k(p)]), q = [p];
    for (let i = 0; i < q.length; i++) {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = { x: q[i].x + dx, y: q[i].y + dy, z: q[i].z + dz };
        if (seen.has(k(n))) continue;
        const id = S.blockAt(n);
        if (id === null || !SOFT.test(id)) continue;
        seen.add(k(n)); q.push(n);
        if (q.length > 6) return false;
      }
    }
    return true;
  }

  /**
   * Put back whatever's missing from the house, from the blueprint, with the same materials
   * (either one stands in for the other if we're short of one). Exact shortfall first, like the
   * build: nothing gets torn out of the house itself to patch it.
   */
  async repairHouse(gen) {
    const h = this.house;
    if (!h) return false;
    const S = this.S;
    const holes = this.houseDamage();
    if (!holes.length) return true;
    const need = this.houseNeeds(h, h.dir);
    if (need.stone || need.planks) { this.shortfall = need; return false; }
    this.shortfall = null;
    await this.sweepAroundHouse(gen); // a blast: what it threw out of a chest or a furnace
    this.a.sayOnce('repair', `${holes.length} block${holes.length > 1 ? 's' : ''} of my house ${holes.length > 1 ? 'are' : 'is'} missing: patching ${holes.length > 1 ? 'them' : 'it'} up.`, 60000);
    await this.plankUp(gen, h, h.dir);
    const fur = furnishings(h, h.dir);
    let fixed = 0;
    // Floor and walls bottom-up, roof last, working from inside the room where we can reach.
    for (const b of holes.sort((a, c) => a.y - c.y)) {
      S.check(gen);
      if (!SOFT.test(S.blockAt(b) ?? 'air')) continue;
      const id = this.materialFor(b.material);
      if (!id) break;
      if (!S.inReach(b)) await S.goNear(gen, standFor(fur, b), 0.6, 2);
      if (!S.inReach(b)) await S.goNear(gen, b, 2, 2);
      if (await this.placeAt(gen, b, id)) fixed++;
      else trace(`house repair: couldn't place ${b.material} (${b.x} ${b.y} ${b.z}) from ${Math.round(this.sim.location.x)} ${Math.round(this.sim.location.y)} ${Math.round(this.sim.location.z)}`);
    }
    S.restHands();
    const left = this.houseDamage().length;
    this.a.say(left ? `Patched ${fixed} blocks of the house; ${left} I couldn't reach yet.` : `House repaired (${fixed} block${fixed === 1 ? '' : 's'}).`);
    return left === 0;
  }

  // ---------- keeping the house usable ----------

  /**
   * Our own house's blocks, never broken to get somewhere (skills.actionOpts): the walls and roof,
   * the ground it stands on, and our furniture where it belongs.
   */
  isHouseBlock(p) {
    const h = this.house;
    if (!h) return false;
    const k = `${h.x},${h.y},${h.z},${h.dir},${layoutOf(h)},${getPlan()?.at ?? 0},${h.doorLx ?? 0},${h.doorwayLx ?? 0},${JSON.stringify(h.moved ?? {})}`;
    if (this._houseCells?.k !== k) {
      // The walls and roof, and the ground under the house and its doorstep (the floor).
      const walls = new Set([...blueprint(h, h.dir), ...footing(h, h.dir)].map((b) => `${b.x},${b.y},${b.z}`));
      const fittings = new Map(keepClear(h, h.dir).filter((c) => c.want).map((c) => [`${c.x},${c.y},${c.z}`, c]));
      this._houseCells = { k, walls, fittings };
    }
    const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
    if (this._houseCells.walls.has(key)) return true;
    const c = this._houseCells.fittings.get(key);
    return !!c && !inTheWay(c, this.S.blockAt(c) ?? 'air') && !SOFT.test(this.S.blockAt(c) ?? 'air');
  }

  /**
   * Whatever's in the way in the house: in the rooms, the doorways, on the doorstep, or where one of
   * our things goes (a player's blocks, sand or gravel that fell in, rubble, water). [{x,y,z,id}]
   */
  houseObstructions() {
    const h = this.house;
    if (!h || !this.houseLoaded()) return [];
    const out = [];
    for (const c of keepClear(h, h.dir)) {
      const id = this.S.blockAt(c);
      if (id === null) continue; // unreadable: unknown, not in the way
      if (inTheWay(c, id)) out.push({ ...c, id });
    }
    return out;
  }

  /**
   * Get rid of everything in the way in the house, whatever it is and whoever put it there: dug out
   * (and picked up), water and lava blocked off and dug out. Nearest first, so it works its way in
   * from wherever it is (through the doorway, or through the junk if that's what fills it).
   */
  async clearHouse(gen) {
    const h = this.house;
    if (!h) return false;
    const S = this.S;
    let blocks = this.houseObstructions();
    if (!blocks.length) return true;
    this.a.sayOnce('clear-house', `${blocks.length} block${blocks.length > 1 ? 's are' : ' is'} in the way in my house: clearing ${blocks.length > 1 ? 'them' : 'it'} out.`, 60000);
    trace(`house: in the way: ${blocks.slice(0, 12).map((b) => `${b.id}@${b.x},${b.y},${b.z}${b.want ? `(${b.want} spot)` : ''}`).join(' ')}${blocks.length > 12 ? ' ...' : ''}`);
    // What we can't break at all (obsidian without a diamond pickaxe, bedrock): never swung at. The
    // house is made to work round it instead (core/house.js planAroundFixed): the door moved along
    // the wall, a thing moved to another spot in the room, or it's left where it is.
    const fixed = blocks.filter((b) => !/water|lava/.test(b.id) && !canBreak(b.id, invCounts(this.sim)));
    if (fixed.length) {
      const was = { d: h.doorLx ?? 0, dw: h.doorwayLx ?? 0, moved: JSON.stringify(h.moved ?? {}) };
      Object.assign(h, planAroundFixed(h, h.dir, fixed));
      this.a.memory.saveNow();
      this._houseCells = null;
      const what = [...new Set(fixed.map((b) => b.id.replace(/_/g, ' ')))].join(', ');
      const moves = [];
      if ((h.doorLx ?? 0) !== was.d) moves.push('moving the door along the wall');
      if ((h.doorwayLx ?? 0) !== was.dw) moves.push('moving the chest room\'s doorway');
      if (JSON.stringify(h.moved ?? {}) !== was.moved) moves.push('putting my things somewhere else in the room');
      this.a.say(`There's ${what} in my house I can't break${moves.length ? `: ${moves.join(', ')}` : ': leaving it, it\'s not in the way'}.`);
      trace(`house: can't break ${fixed.map((b) => `${b.id}@${b.x},${b.y},${b.z}`).join(' ')}: door ${h.doorLx ?? 0}, doorway ${h.doorwayLx ?? 0}, moved ${JSON.stringify(h.moved ?? {})}`);
      blocks = this.houseObstructions();
    }
    let cleared = 0;
    const failed = new Set();
    for (let n = 0; n < 200 && blocks.length; n++) {
      S.check(gen);
      const f = this.sim.location;
      // Nearest first; the higher of two at the same spot first (sand and gravel fall into the gap).
      const todo = blocks.filter((b) => !failed.has(`${b.x},${b.y},${b.z}`))
        .sort((a, b) => Math.hypot(a.x + 0.5 - f.x, a.z + 0.5 - f.z) - Math.hypot(b.x + 0.5 - f.x, b.z + 0.5 - f.z) || b.y - a.y);
      if (!todo.length) break;
      const b = todo[0];
      const id = S.blockAt(b) ?? 'air';
      let ok = false;
      if (/water|lava/.test(id)) ok = await this.plugAndClear(gen, b);
      else ok = await S.mine(gen, b, { collect: true });
      if (ok) cleared++;
      else { failed.add(`${b.x},${b.y},${b.z}`); trace(`house: couldn't clear ${id} at ${b.x} ${b.y} ${b.z} from ${Math.round(f.x)} ${Math.round(f.y)} ${Math.round(f.z)}`); }
      blocks = this.houseObstructions();
    }
    S.restHands();
    await this.sweepAroundHouse(gen);
    const left = this.houseObstructions().length;
    if (cleared || left) this.a.say(left ? `Cleared ${cleared} block${cleared === 1 ? '' : 's'} out of my house; ${left} still in the way.` : `Cleared the house out (${cleared} block${cleared === 1 ? '' : 's'}).`);
    return left === 0;
  }

  /** Water or lava where it's in the way: a block into it (that stops it), then dig the block out. */
  async plugAndClear(gen, c) {
    const S = this.S;
    const inv = invCounts(this.sim);
    const block = cheapestPlaceable(inv, plankReserve(inv));
    if (!block) return false;
    if (!S.inReach(c)) await S.goNear(gen, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, 3, 2);
    if (!(await this.placeAt(gen, c, block, null, null, { liquid: true }))) return false;
    return S.mine(gen, c, { collect: true });
  }

  /** Items lying round the house (a chest or furnace blown up, the junk we dug out): pick them up. */
  async sweepAroundHouse(gen) {
    const h = this.house;
    if (!h) return;
    const mid = { x: h.x + 0.5, y: h.y + 0.5, z: h.z + 0.5 };
    let n = 0;
    try { n = this.dim.getEntities({ type: 'minecraft:item', location: mid, maxDistance: 12 }).length; } catch {}
    if (n) await this.S.sweep(gen, mid, 12, null, 20);
  }

  /** Fire on or round the house (its planks burn and it spreads): the fire blocks, nearest the house first. */
  houseFires() {
    const h = this.house;
    if (!h || !this.houseLoaded()) return [];
    const at = frame(h, h.dir), bd = bounds(h), back = bd.lz0;
    // One engine query for the box (it's asked every couple of seconds near the house: ~550 block
    // reads each time otherwise), block by block where that isn't available.
    const a = at(bd.lx0 - 1, back - 1, -1), b = at(bd.lx1 + 1, bd.lz1 + 2, bd.h1 + 2);
    try {
      const vol = new BlockVolume({ x: Math.min(a.x, b.x), y: a.y, z: Math.min(a.z, b.z) }, { x: Math.max(a.x, b.x), y: b.y, z: Math.max(a.z, b.z) });
      const hits = this.dim.getBlocks(vol, { includeTypes: ['minecraft:fire', 'minecraft:soul_fire'] }, true);
      return [...hits.getBlockLocationIterator()].map((p) => ({ x: p.x, y: p.y, z: p.z }));
    } catch {}
    const out = [];
    for (let lx = bd.lx0 - 1; lx <= bd.lx1 + 1; lx++) for (let lz = back - 1; lz <= bd.lz1 + 2; lz++) for (let dy = -1; dy <= bd.h1 + 2; dy++) {
      const p = at(lx, lz, dy);
      if (/^(fire|soul_fire)$/.test(this.S.blockAt(p) ?? '')) out.push(p);
    }
    return out;
  }

  /**
   * The house is on fire: punch every flame out (a hit puts fire out, as a player does), nearest
   * first, till none's left; the burnt blocks get patched by the repair after.
   */
  async fightFire(gen) {
    const S = this.S;
    let fires = this.houseFires();
    if (!fires.length) return true;
    this.a.say(`My house is on fire (${fires.length} flame${fires.length > 1 ? 's' : ''}): putting it out.`);
    let out = 0, rounds = 0;
    const t0 = system.currentTick;
    const skip = new Set(); // (ones we couldn't get at: the rest first, and not again)
    this.fireSecondGo = false;
    const k = (p) => `${p.x},${p.y},${p.z}`;
    while (rounds++ < 60 && system.currentTick - t0 < 20 * 90) {
      S.check(gen);
      fires = this.houseFires().filter((p) => !skip.has(k(p)));
      // (The others out, one more go at those we couldn't get at: we're somewhere else now.)
      if (!fires.length && skip.size && !this.fireSecondGo) { this.fireSecondGo = true; skip.clear(); continue; }
      if (!fires.length) break;
      const f = this.sim.location;
      fires.sort((a, b) => dist3D(f, center(a)) - dist3D(f, center(b)));
      const c = fires[0];
      // Where the crosshair gets onto the flame: round the wall to it, and for one on the roof, up
      // a pillar beside the house (you can't see the top of a roof from the ground).
      const sees = (e) => !!S.targetPoint(c, e).pt;
      if (!(S.inReach(c) && sees(S.eye()))) {
        if (S.builtUp?.length) await S.takeDownBuilt(gen); // (down off the last pillar first)
        await S.goSee(gen, c, sees, 4000, { build: true });
      }
      if (await this.punchOut(gen, c)) out++;
      else skip.add(k(c));
    }
    await S.takeDownBuilt?.(gen);
    fires = this.houseFires();
    this.a.say(fires.length ? `Put out ${out}; ${fires.length} still burning I can't get to.` : `Fire's out (${out} flame${out === 1 ? '' : 's'}).`);
    return !fires.length;
  }

  /** One punch at a fire block (it goes out; the block it's on is untouched). */
  async punchOut(gen, c) {
    const S = this.S;
    if (!/fire/.test(S.blockAt(c) ?? '')) return true;
    if (!S.inReach(c)) return false;
    hold(this.sim, null); // a fist: no tool wear for a flame
    // (Crosshair on the flame itself, as a player's must be: not through a wall.)
    if (!(await S.aimOn(gen, c, null, 8))) return false;
    try { this.sim.breakBlock(c); } catch {}
    await S.wait(gen, 2);
    try { this.sim.stopBreakingBlock(); } catch {}
    // (The break ray can miss a flame: put it out the way the punch would have.)
    if (/fire/.test(S.blockAt(c) ?? '')) { try { this.dim.runCommand(`setblock ${c.x} ${c.y} ${c.z} air`); } catch {} }
    this.a.cellChanged?.();
    return !/fire/.test(S.blockAt(c) ?? '');
  }

  /**
   * Before a block goes in from the item with a command (door, bed, chest: the simulated player
   * can't place those itself): where a player could put it, clicking the top of the block under
   * it from where they stand (step round to see it if need be), crosshair on it. False if not.
   */
  async seeToPlace(gen, cell) {
    const S = this.S;
    const below = { x: cell.x, y: cell.y - 1, z: cell.z };
    const ok = (e) => !!S.placePoint(cell, below, e);
    if (!(S.inReach(cell) && ok(S.eye())) && !(await S.goSee(gen, cell, ok))) { S.log(`can't get at ${cell.x} ${cell.y} ${cell.z} to put it there`); return false; }
    const pp = S.placePoint(cell, below, S.eye());
    if (!pp) return false;
    this.a.motor.setFocus(pp.pt);
    for (let k = 0; k < 10; k++) {
      const hh = S.crosshair();
      if (hh && ((hh.location.x === below.x && hh.location.y === below.y && hh.location.z === below.z && hh.face.y === 1) || (hh.location.x === cell.x && hh.location.y === cell.y && hh.location.z === cell.z))) break;
      await S.wait(gen, 1);
    }
    return true;
  }

  /** Put the door in from the item (the simulated player can't place doors itself). */
  async placeDoor(gen) {
    const h = this.house;
    if (!h || !invCounts(this.sim).wooden_door) return false;
    const fur = furnishings(h, h.dir);
    if (/door/.test(this.S.blockAt(fur.door) ?? '')) return true;
    // (setblock replaces whatever's there: something in the doorway is cleared out first, clear_house.)
    if (!SOFT.test(this.S.blockAt(fur.door) ?? 'air') || !SOFT.test(this.S.blockAt({ ...fur.door, y: fur.door.y + 1 }) ?? 'air')) return false;
    if (!(await this.seeToPlace(gen, fur.door))) return false;
    take(this.sim, 'wooden_door', 1);
    // Hinged so it swings out of the way: the door's facing is across the way we walk through it.
    const across = h.dir === 'north' || h.dir === 'south' ? 'east' : 'south';
    try { this.dim.runCommand(`setblock ${fur.door.x} ${fur.door.y} ${fur.door.z} wooden_door ["minecraft:cardinal_direction"="${across}"]`); } catch {
      try { this.dim.runCommand(`setblock ${fur.door.x} ${fur.door.y} ${fur.door.z} wooden_door`); } catch {}
    }
    this.a.cellChanged?.();
    const ok = /door/.test(this.S.blockAt(fur.door) ?? '');
    if (!ok) give(this.sim, 'wooden_door', 1);
    return ok;
  }

  /** What the house really has, read from the blocks (not from flags that can go stale). */
  houseState() {
    return this.memo('houseState', 20, () => this.houseStateNow());
  }

  houseStateNow() {
    const h = this.house;
    if (!h) return null;
    // Out of range (chunks not loaded): every block reads as nothing. Keep what we last saw
    // rather than "discover" a missing door, bed and 47 missing walls from 90 blocks away.
    if (!this.houseLoaded()) return this.lastHouseState ?? { layout: layoutOf(h), damage: 0, blocked: 0, fire: 0, door: true, bed: !!h.bed, bedMisplaced: false, table: !!h.table, furnace: !!h.furnace, chest: !!h.chest, signs: true, lit: true, litOutside: true };
    const fur = furnishings(h, h.dir), at = (p) => this.S.blockAt(p) ?? '';
    const none = new Set(fur.noRoom ?? []); // (no room for it anywhere: done without)
    const acc = new Set((h.accepted ?? []).map((c) => c.join(',')));
    const accepted = (p) => acc.has(toLocal(h, h.dir, p).join(','));
    const chestsPlaced = fur.chests.filter((c) => /chest/.test(at(c))).length;
    const signsPlaced = fur.signs.filter((sg) => /sign/.test(at(sg.cell))).length;
    return this.lastHouseState = {
      layout: fur.layout,
      chestsPlaced, signsPlaced,
      // The chest room's four chests, each with its sign (a cabin: the one by the door).
      signs: signsPlaced === fur.signs.length || this.S.constructor.itemExists?.('oak_sign') === false, // (no signs in this game: done without)
      damage: this.houseDamage().length,
      blocked: this.houseObstructions().length, // in the way in the rooms, doorways, doorstep
      fire: this.houseFires().length,
      door: /door/.test(at(fur.door)),
      // Both halves, in the planned cells: half a bed, or one across the wall line, isn't a bed.
      bed: (h.moved?.bedNone ?? false) || (/bed/.test(at(fur.bed.foot)) && /bed/.test(at(fur.bed.head))),
      bedMisplaced: !(/bed/.test(at(fur.bed.foot)) && /bed/.test(at(fur.bed.head))) && this.bedBlocks().length > 0,
      table: none.has('table') || at(fur.table) === 'crafting_table',
      furnace: none.has('furnace') || /furnace/.test(at(fur.furnace)),
      // The food furnace (chest-room houses): false while it's still to go in.
      furnace2: fur.furnace2 ? /furnace/.test(at(fur.furnace2)) : null,
      chest: fur.layout === 'chests' ? chestsPlaced === fur.chests.length : /chest/.test(at(fur.chests[0])),
      lit: (accepted(fur.torchInside.toward) || /torch/.test(at(fur.torchInside.toward))) && (!fur.torchChests || accepted(fur.torchChests.toward) || /torch/.test(at(fur.torchChests.toward))),
      litOutside: fur.torchesOutside.every((t) => accepted(t.toward) || /torch/.test(at(t.toward))),
    };
  }

  /** Bed pieces in and around the house's bed corner (to spot one set in the wrong place). */
  bedBlocks() {
    const h = this.house;
    if (!h) return [];
    const fur = furnishings(h, h.dir), out = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const c = { x: fur.bed.foot.x + dx, y: fur.bed.foot.y, z: fur.bed.foot.z + dz };
      if (/bed/.test(this.S.blockAt(c) ?? '')) out.push(c);
    }
    return out;
  }

  /** Put the bed, table, furnace and inside torch in (whatever's missing and we have). */
  async furnish(gen) {
    const h = this.house;
    if (!h) return;
    const S = this.S;
    const fur = furnishings(h, h.dir);
    // What's really there (a flag says "table" after a player took it, or it was blown up, or its
    // spot moved: it waited on a table that wasn't there, for ever).
    const st0 = this.houseLoaded() ? this.houseStateNow() : null;
    if (st0) { h.table = !!st0.table; h.furnace = !!st0.furnace; h.bed = !!st0.bed; }
    await this.sweepAroundHouse(gen); // a chest or furnace that went (a blast, a fire): its things
    if (!inside(h, this.sim.location)) await this.enterHouse(gen);
    let inv = invCounts(this.sim);
    if (!h.table && !inv.crafting_table && (count(inv, isPlanks) >= 4 || count(inv, isLog) >= 1)) await S.craft(gen, ['crafting_table'], false);
    if (!h.table && invCounts(this.sim).crafting_table) {
      await S.goNear(gen, standFor(fur, fur.table), 0.4, 2);
      if (await this.placeAt(gen, fur.table, 'crafting_table')) { h.table = true; this.a.memory.rememberTable(this.dim.id, fur.table); }
    }
    if (!h.furnace && !invCounts(this.sim).furnace) await this.fetchFurnace(gen).catch(() => false);
    if (!h.furnace && invCounts(this.sim).furnace) {
      await S.goNear(gen, standFor(fur, fur.furnace), 0.4, 2);
      if (await this.placeAt(gen, fur.furnace, 'furnace')) { h.furnace = true; this.a.memory.remember('furnace', this.dim.id, fur.furnace); }
    }
    // The food furnace, once the first's in (the second furnace in the pack: straight in its corner).
    if (fur.furnace2 && h.furnace && invCounts(this.sim).furnace && !/furnace/.test(S.blockAt(fur.furnace2) ?? '')) {
      await S.goNear(gen, standFor(fur, fur.furnace2), 0.4, 2);
      if (await this.placeAt(gen, fur.furnace2, 'furnace')) this.a.memory.remember('furnace', this.dim.id, fur.furnace2);
    }
    // A bed set in the wrong place (half a bed, or one poking into the wall): pick it up and redo it.
    const fb = /bed/.test(S.blockAt(fur.bed.foot) ?? ''), hb = /bed/.test(S.blockAt(fur.bed.head) ?? '');
    if (!(fb && hb) && this.bedBlocks().length) {
      S.log(`bed: set wrong (foot ${S.blockAt(fur.bed.foot)}, head ${S.blockAt(fur.bed.head)}), picking it up`);
      await S.goNear(gen, fur.bed.standAt, 0.4, 2);
      for (const c of this.bedBlocks()) if (/bed/.test(S.blockAt(c) ?? '')) await S.mine(gen, c).catch(() => false);
      await S.sweep(gen, this.sim.location, 5).catch(() => {});
      if (this.bedBlocks().length) for (const c of this.bedBlocks()) { try { this.dim.runCommand(`setblock ${c.x} ${c.y} ${c.z} air`); } catch {} }
      if (!invCounts(this.sim).bed) give(this.sim, 'bed', 1);
      h.bed = false;
    } else if (fb && hb) h.bed = true;
    inv = invCounts(this.sim);
    if (!h.bed && inv.bed) {
      await S.goNear(gen, fur.bed.standAt, 0.4, 2);
      await this.a.motor.lookAt(center(fur.bed.foot), 5, 20);
      const isBedAt = (c) => /bed/.test(S.blockAt(c) ?? '');
      const rightPlace = () => isBedAt(fur.bed.foot) && isBedAt(fur.bed.head);
      if (await this.placeAt(gen, fur.bed.foot, 'bed')) {
        // A clicked bed's head goes the way we face: it can end up across the wall line (a hole
        // in the house, a wall block over it, maybe "obstructed"). Only both planned cells count.
        if (rightPlace()) h.bed = true;
        else {
          S.log(`bed: landed wrong (foot ${S.blockAt(fur.bed.foot)}, head ${S.blockAt(fur.bed.head)}): picking it up`);
          for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
            const c = { x: fur.bed.foot.x + dx, y: fur.bed.foot.y, z: fur.bed.foot.z + dz };
            if (isBedAt(c)) await S.mine(gen, c).catch(() => false);
          }
          await S.sweep(gen, this.sim.location, 5).catch(() => {});
          if (!invCounts(this.sim).bed) give(this.sim, 'bed', 1); // it broke without dropping
        }
      }
      if (!h.bed && SOFT.test(S.blockAt(fur.bed.foot) ?? 'air') && SOFT.test(S.blockAt(fur.bed.head) ?? 'air') && invCounts(this.sim).bed && (await this.seeToPlace(gen, fur.bed.foot))) {
        // The simulated player's bed placement is unreliable in tight rooms: set it from the item instead.
        // Bedrock's setblock makes the given cell the HEAD and puts the foot one block behind it
        // (tested: direction 0 = head to the south). Setting it at the foot cell put the foot in
        // the back wall, knocking a hole in it: so set the head cell, facing the front.
        take(this.sim, 'bed', 1);
        // (head toward the front in the starter's rooms; a learned house's bed may lie any way: head minus foot says which)
        const hv = { x: Math.sign(fur.bed.head.x - fur.bed.foot.x), z: Math.sign(fur.bed.head.z - fur.bed.foot.z) };
        const direction = hv.z > 0 ? 0 : hv.x < 0 ? 1 : hv.z < 0 ? 2 : 3;
        const clearBeds = () => {
          for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
            const c = { x: fur.bed.head.x + dx, y: fur.bed.head.y, z: fur.bed.head.z + dz };
            if (isBedAt(c)) { try { this.dim.runCommand(`setblock ${c.x} ${c.y} ${c.z} air`); } catch {} }
          }
        };
        try { this.dim.runCommand(`setblock ${fur.bed.head.x} ${fur.bed.head.y} ${fur.bed.head.z} bed ["direction"=${direction},"head_piece_bit"=true]`); } catch (e) { S.log(`bed setblock: ${e}`); }
        this.a.cellChanged?.();
        h.bed = rightPlace();
        S.log(`bed: ${h.bed ? 'in' : 'setblock put it in the wrong place'} (foot ${S.blockAt(fur.bed.foot)}, head ${S.blockAt(fur.bed.head)})`);
        if (!h.bed) { clearBeds(); give(this.sim, 'bed', 1); }
      }
      S.restHands(); // the bed's gone from the inventory: don't keep showing it in hand
    }
    if (!/door/.test(S.blockAt(fur.door) ?? '')) await this.placeDoor(gen);
    if (fur.layout === 'chests') await this.furnishChestRoom(gen, h, fur);
    else if (!/chest/.test(S.blockAt(fur.chests[0]) ?? '') && invCounts(this.sim).chest) {
      // The chest, in the front corner by the door.
      await S.goNear(gen, fur.stand, 0.4, 2);
      if (await this.placeAt(gen, fur.chests[0], 'chest') || (await this.setChest(gen, fur.chests[0], h))) { h.chest = true; this.a.say('Put a chest in the house.'); }
    }
    if (invCounts(this.sim).torch && S.blockAt(fur.torchInside.toward) === 'air') {
      await S.goNear(gen, fur.stand, 0.4, 2);
      await this.placeAt(gen, fur.torchInside.toward, 'torch', fur.torchInside.on);
    }
    this.setHouse(h);
  }

  /**
   * The chest room: a chest in each corner (made here if there's wood for them), a sign over each
   * saying what goes in it (core/house.js CHEST_KINDS; core/storage.js sorts by the same kinds), a
   * torch on the back wall. Whatever's missing and can be done with what we have.
   */
  async furnishChestRoom(gen, h, fur) {
    const S = this.S;
    const missing = fur.chests.filter((c) => !/chest/.test(S.blockAt(c) ?? ''));
    const woodFor = (n) => count(invCounts(this.sim), isPlanks) + count(invCounts(this.sim), isLog) * 4 >= n;
    // Chests: 8 planks each (the crafting table's in the front room, in reach of the doorway).
    for (let i = (invCounts(this.sim).chest ?? 0); i < missing.length && woodFor(8); i++) {
      await S.goNear(gen, fur.stand, 0.4, 2);
      if (!(await S.craft(gen, ['chest'], true, true))) break;
    }
    if (missing.length && invCounts(this.sim).chest) await S.goNear(gen, fur.chestStand, 0.4, 2);
    let put = 0;
    for (const c of missing) {
      if (!invCounts(this.sim).chest) break;
      if (await this.placeAt(gen, c, 'chest') || (await this.setChest(gen, c, h))) put++;
    }
    if (put) this.a.say(`Put ${put} chest${put > 1 ? 's' : ''} in the chest room.`);
    h.chest = fur.chests.every((c) => /chest/.test(S.blockAt(c) ?? ''));
    // Signs over the chests, on the side walls: what goes in each.
    const unsigned = fur.signs.filter((sg) => /chest/.test(S.blockAt({ ...sg.cell, y: sg.cell.y - 1 }) ?? '') && !/sign/.test(S.blockAt(sg.cell) ?? ''));
    const signId = () => Object.keys(invCounts(this.sim)).find((id) => /_sign$/.test(id));
    if (unsigned.length && !signId() && woodFor(7)) { // (craft skips it in a game without oak signs)
      await S.goNear(gen, fur.stand, 0.4, 2);
      for (let n = 0; n < Math.ceil(unsigned.length / 3); n++) if (!(await S.craft(gen, ['oak_sign'], true, true))) break;
    }
    let labelled = 0;
    for (const sg of fur.signs) {
      if (/sign/.test(S.blockAt(sg.cell) ?? '')) { if (this.labelSign(sg)) labelled++; continue; }
      if (!/chest/.test(S.blockAt({ ...sg.cell, y: sg.cell.y - 1 }) ?? '')) continue;
      const id = signId();
      if (!id) break;
      await S.goNear(gen, fur.chestStand, 0.4, 2);
      if (!(await this.placeAt(gen, sg.cell, id, sg.on)) || !/sign/.test(S.blockAt(sg.cell) ?? '')) this.setSign(sg, h);
      if (this.labelSign(sg)) labelled++;
    }
    if (labelled && labelled === fur.signs.length) this.a.sayOnce('signs', 'Labelled the chests: stone and ores, wood and plants, food and farm, mob drops and the rest.', 600000);
    // Light in the chest room.
    const t = fur.torchChests;
    if (t && invCounts(this.sim).torch && (S.blockAt(t.toward) ?? 'air') === 'air') {
      await S.goNear(gen, fur.chestStand, 0.4, 2);
      await this.placeAt(gen, t.toward, 'torch', t.on);
    }
  }

  /** Write a chest's label on its sign (and wax it, so a stray click doesn't open it for editing). */
  labelSign(sg) {
    try {
      const sign = this.dim.getBlock(sg.cell)?.getComponent('minecraft:sign');
      if (!sign) return false;
      if (sign.getText?.() !== sg.text) sign.setText(sg.text);
      try { sign.setWaxed?.(true); } catch {}
      return true;
    } catch (e) { this.S.log(`sign at ${sg.cell.x} ${sg.cell.y} ${sg.cell.z}: ${e}`); return false; }
  }

  /** The simulated player's sign didn't take: set a wall sign from the item, facing into the room. */
  setSign(sg, h) {
    const id = Object.keys(invCounts(this.sim)).find((i) => /_sign$/.test(i));
    if (!id || !SOFT.test(this.S.blockAt(sg.cell) ?? 'air')) return false;
    // It faces away from the wall it hangs on (Bedrock facing_direction: 2 north, 3 south, 4 west, 5 east).
    const dx = sg.cell.x - sg.on.x, dz = sg.cell.z - sg.on.z;
    const facing = dz < 0 ? 2 : dz > 0 ? 3 : dx < 0 ? 4 : 5;
    take(this.sim, id, 1);
    try { this.dim.runCommand(`setblock ${sg.cell.x} ${sg.cell.y} ${sg.cell.z} wall_sign ["facing_direction"=${facing}]`); } catch {}
    this.a.cellChanged?.();
    const ok = /sign/.test(this.S.blockAt(sg.cell) ?? '');
    if (!ok) give(this.sim, id, 1);
    void h;
    return ok;
  }

  /**
   * Make room for a torch in `cell`: a plant in it (the top half of a peony or tall grass, a bush,
   * leaves hanging down) is broken first. Anything else there (a block someone built) is left.
   */
  async clearForTorch(gen, cell) {
    const id = this.S.blockAt(cell) ?? 'air';
    if (id === 'air') return true;
    if (!PLANT.test(id)) return false;
    this.S.log(`torch spot ${cell.x} ${cell.y} ${cell.z}: ${id} in the way, breaking it`);
    await this.S.mine(gen, cell, { collect: !/leaves|grass|fern|vine|lichen|roots|snow_layer|litter|petals|wildflowers/.test(id) });
    // The break ray can miss a thin plant: knock it out the way a punch would, with its drop.
    if (this.S.blockAt(cell) === id && this.S.inReach(cell)) { try { this.dim.runCommand(`setblock ${cell.x} ${cell.y} ${cell.z} air destroy`); } catch {} }
    await this.S.wait(gen, 2);
    return (this.S.blockAt(cell) ?? 'air') === 'air' || SOFT.test(this.S.blockAt(cell) ?? 'air');
  }

  /** The torches either side of the door, placed from the doorstep (never from inside). */
  async lightOutside(gen) {
    const h = this.house;
    if (!h) return false;
    const S = this.S, fur = furnishings(h, h.dir);
    const todo = fur.torchesOutside.filter((t) => !/torch/.test(S.blockAt(t.toward) ?? ''));
    if (!todo.length) return true;
    if (this.isHome()) await this.leaveHouse(gen);
    await S.goNear(gen, fur.doorstep, 0.6, 3);
    let ok = 0;
    for (const t of todo) {
      if (!invCounts(this.sim).torch) break;
      // A peony, a rose bush, tall grass or a bush by the door: its top half is right where the
      // torch goes. Break it (plants only, never anything built) and put the torch up.
      if ((S.blockAt(t.toward) ?? 'air') !== 'air' && !(await this.clearForTorch(gen, t.toward))) { S.log(`outside torch: ${t.toward.x} ${t.toward.y} ${t.toward.z} is ${S.blockAt(t.toward)}`); continue; }
      if (!S.usable(t.on)) await S.goNear(gen, t.toward, 1.5, 2);
      if (await this.placeAt(gen, t.toward, 'torch', t.on)) ok++;
      else S.log(`outside torch failed: ${S.whyNotUsable(t.on)}`);
    }
    S.restHands();
    if (ok) this.a.say(`Put up ${ok} torch${ok > 1 ? 'es' : ''} by the door.`);
    return ok === todo.length;
  }

  // ---------- the chest ----------

  /** The house's chests that are there (placed), in order. */
  chests() {
    const h = this.house;
    if (!h) return [];
    return furnishings(h, h.dir).chests.filter((p) => /chest/.test(this.S.blockAt(p) ?? ''));
  }

  /** What's in the chests, from the blocks when they're loaded (else what we saw last time). */
  chestContents() {
    const out = {};
    let read = false;
    for (const p of this.chests()) {
      const c = this.container(p);
      if (!c) continue;
      read = true;
      for (let i = 0; i < c.size; i++) {
        const it = c.getItem(i);
        if (it) out[strip(it.typeId)] = (out[strip(it.typeId)] ?? 0) + it.amount;
      }
    }
    if (read) { this.a.memory.data.chestInv = out; this.a.memory.save(); }
    return read ? out : this.a.memory.data.chestInv ?? {};
  }

  /**
   * The simulated player's placement didn't take (a tight corner, like the bed): set the chest from
   * the item instead, facing into the room.
   */
  async setChest(gen, cell, h) {
    if (!invCounts(this.sim).chest || !SOFT.test(this.S.blockAt(cell) ?? 'air')) return false;
    if (!(await this.seeToPlace(gen, cell))) return false;
    take(this.sim, 'chest', 1);
    const back = { north: 'south', south: 'north', east: 'west', west: 'east' }[h.dir]; // away from the door: into the room
    try { this.dim.runCommand(`setblock ${cell.x} ${cell.y} ${cell.z} chest ["minecraft:cardinal_direction"="${back}"]`); } catch {
      try { this.dim.runCommand(`setblock ${cell.x} ${cell.y} ${cell.z} chest`); } catch {}
    }
    this.a.cellChanged?.();
    const ok = /chest/.test(this.S.blockAt(cell) ?? '');
    if (!ok) give(this.sim, 'chest', 1);
    this.S.log(`chest: ${ok ? 'set' : "couldn't set"} at ${cell.x} ${cell.y} ${cell.z}`);
    return ok;
  }

  /** Free pack slots right now. */
  freeSlots() {
    try { return packOf(this.sim)?.emptySlotsCount ?? 36; } catch { return 36; }
  }

  /**
   * Put away what we don't need to carry (core/storage.js): in the chest by the door, then the
   * second one against the back wall (made and placed when the first is full). Whole stacks are
   * moved as they are; part stacks are split.
   */
  async storeItems(gen) {
    const h = this.house;
    if (!h) return false;
    const S = this.S;
    const fur = furnishings(h, h.dir);
    let plan = depositPlan(invCounts(this.sim));
    if (!Object.keys(plan).length) {
      // A full pack of things it keeps (tools, food, the working stock): nothing to put away. Noted,
      // so the plan doesn't send it back every round (store comes before the farm and the iron).
      this.a.memory.data.nothingToStoreAt = Date.now();
      this.a.memory.save();
      return true;
    }
    if (!this.isHome()) await this.enterHouse(gen);
    await S.goNear(gen, fur.chestStand, 0.4, 2);
    let stored = 0;
    // The chest room: each thing in the chest its sign says (core/storage.js), then anything that
    // didn't fit in whichever has room. A cabin: the chest by the door, then the second.
    const rounds = fur.layout === 'chests'
      ? [...sortIntoChests(plan, fur.chestKinds ?? fur.signs.map((sg) => sg.kind)).map((want, ci) => ({ ci, want })), ...fur.chests.map((_, ci) => ({ ci, want: null }))]
      : fur.chests.map((_, ci) => ({ ci, want: null }));
    for (const { ci, want: only } of rounds) {
      if (!Object.keys(plan).length) break;
      if (only && !Object.keys(only).length) continue;
      const pos = fur.chests[ci];
      if (!/chest/.test(S.blockAt(pos) ?? '')) {
        if (fur.layout === 'chests') continue; // (furnish puts them in)
        // The first chest's full: a second one (8 planks) against the back wall.
        if (ci === 0) break;
        if (!invCounts(this.sim).chest && !(await S.craft(gen, ['chest'], true, true))) break;
        if (!(await this.placeAt(gen, pos, 'chest')) && !(await this.setChest(gen, pos, h))) break;
        this.a.say('First chest is full: put a second one in.');
      }
      if (!(await S.reach(gen, pos))) continue;
      await this.a.motor.lookAt(center(pos), 8, 30); // opening it
      S.check(gen);
      const chest = this.container(pos), pack = packOf(this.sim);
      if (!chest || !pack) continue;
      for (let i = 0; i < pack.size; i++) {
        const it = pack.getItem(i);
        if (!it) continue;
        const id = strip(it.typeId);
        const want = Math.min(plan[id] ?? 0, only ? only[id] ?? 0 : Infinity);
        if (want <= 0) continue;
        let moved;
        if (want >= it.amount) {
          const left = pack.transferItem(i, chest); // the whole stack, as it is
          moved = it.amount - (left?.amount ?? 0);
        } else {
          const left = chest.addItem(new ItemStack(it.typeId, want));
          moved = want - (left?.amount ?? 0);
          if (moved > 0) take(this.sim, id, moved);
        }
        stored += moved;
        plan[id] -= moved;
        if (plan[id] <= 0) delete plan[id];
        if (only) { only[id] -= moved; if (only[id] <= 0) delete only[id]; }
      }
      await S.wait(gen, 6);
    }
    this.chestContents();
    S.restHands();
    const left = Object.values(plan).reduce((a, n) => a + n, 0);
    // Both chests full: don't come back to try again for a while (the plan would ask every round).
    this.a.memory.data.chestFullAt = left ? Date.now() : 0;
    this.a.memory.save();
    const where = fur.layout === 'chests' ? 'the chest room' : 'the chest';
    this.a.say(stored ? `Put ${stored} things away in ${where}${left ? ` (${left} didn't fit)` : ''}.` : `${fur.layout === 'chests' ? 'The chests are' : 'The chest is'} full.`);
    return stored > 0;
  }

  /**
   * Take back from the chest what a job needs: want = [[predicate(id), count], ...]. Returns how
   * many items we took. Only worth it when we're near the house (the caller checks).
   */
  async takeFromChest(gen, want) {
    const S = this.S;
    const plan = takePlan(this.chestContents(), want);
    if (!Object.keys(plan).length) return 0;
    if (!this.isHome()) await this.enterHouse(gen);
    let took = 0;
    for (const pos of this.chests()) {
      if (!Object.keys(plan).length) break;
      if (!(await S.reach(gen, pos))) continue;
      await this.a.motor.lookAt(center(pos), 8, 30);
      S.check(gen);
      const chest = this.container(pos);
      if (!chest) continue;
      for (let i = 0; i < chest.size; i++) {
        const it = chest.getItem(i);
        if (!it) continue;
        const id = strip(it.typeId);
        const k = Math.min(plan[id] ?? 0, it.amount);
        if (k <= 0) continue;
        if (k === it.amount) chest.setItem(i, undefined);
        else { it.amount -= k; chest.setItem(i, it); }
        give(this.sim, id, k);
        took += k;
        plan[id] -= k;
        if (plan[id] <= 0) delete plan[id];
      }
    }
    this.chestContents();
    if (took) this.a.say(`Took ${took} out of the chest.`);
    return took;
  }

  // ---------- doors, home, nights ----------

  doorPos() { return this.house ? furnishings(this.house, this.house.dir).door : null; }

  doorOpen() {
    const d = this.doorPos();
    try { return !!this.dim.getBlock(d)?.permutation.getState('open_bit'); } catch { return false; }
  }

  async setDoor(gen, open) {
    const d = this.doorPos();
    if (!d || (this.S.blockAt(d) ?? '').indexOf('door') < 0 || this.doorOpen() === open) return;
    await this.a.motor.lookAt(center(d), 8, 20);
    this.S.check(gen);
    let r; try { r = this.sim.interactWithBlock(d, Direction.Up); } catch (e) { r = `${e}`; }
    await this.S.wait(gen, 4);
    this.S.log(`door ${open ? 'open' : 'shut'}: interact ${r}, now ${this.doorOpen() ? 'open' : 'shut'}`);
  }

  isHome() { return !!this.house && inside(this.house, this.sim.location); }

  async enterHouse(gen) {
    const h = this.house;
    const fur = furnishings(h, h.dir);
    if (!this.isHome()) {
      if (!(await this.S.goNear(gen, fur.doorstep, 0.8, 3))) return false;
      await this.setDoor(gen, true);
      await this.a.motor.followPath([{ ...center(fur.doorstep), y: fur.doorstep.y }, { ...center(fur.door), y: fur.door.y }, { ...center(fur.stand), y: fur.stand.y }]);
      this.S.check(gen);
    }
    await this.setDoor(gen, false);
    return this.isHome();
  }

  async leaveHouse(gen) {
    if (!this.isHome()) return true;
    const h = this.house;
    const fur = furnishings(h, h.dir);
    await this.S.goNear(gen, fur.stand, 0.6, 2);
    await this.setDoor(gen, true);
    const r = await this.a.motor.followPath([{ ...center(fur.stand), y: fur.stand.y }, { ...center(fur.door), y: fur.door.y }, { ...center(fur.doorstep), y: fur.doorstep.y }]);
    this.S.check(gen);
    this.S.log(`leaving house: door ${this.doorOpen() ? 'open' : 'shut'}, walk ${r.status}, at ${this.S.feet().x} ${this.S.feet().z} (doorstep ${fur.doorstep.x} ${fur.doorstep.z})`);
    await this.setDoor(gen, false);
    return !this.isHome();
  }

  /** Go home for the night, shut the door, sleep if there's a bed, come out in the morning. */
  async nightAtHome(gen) {
    const h = this.house;
    const sleep = this.a.bedsOn?.() !== false; // (beds off: sit the night out inside, awake)
    this.a.sayOnce('gohome', 'Getting dark, heading home.', 300000);
    if (!(await this.enterHouse(gen))) {
      // Can't get in: whatever's in the way (a player's blocks in the doorway or the room, rubble)
      // comes out, and in we go. Still shut out after that: dig in here rather than stand outside.
      if (this.houseObstructions().length) await this.clearHouse(gen);
      if (!(await this.enterHouse(gen))) {
        this.homeFails = (this.homeFails ?? 0) + 1;
        trace(`night: can't get into the house (${this.homeFails})`);
        if (this.homeFails < 2) return false;
        this.homeFails = 0;
        this.a.say("Can't get into my house: digging in here for the night.");
        await this.shelter(gen);
        return true;
      }
    }
    this.homeFails = 0;
    const fur = furnishings(h, h.dir);
    // Wool for a bed and no bed yet: made here, at the house's table, and put in before sleeping.
    const wool = Math.max(0, ...Object.entries(invCounts(this.sim)).filter(([id]) => id.endsWith('_wool')).map(([, n]) => n));
    if (sleep && !h.bed && !invCounts(this.sim).bed && wool >= 3) await this.S.craft(gen, ['bed'], true);
    if (sleep && !h.bed && invCounts(this.sim).bed) await this.furnish(gen);
    // Home for the night anyway: put away what we don't need to carry before bed.
    if (this.chests().length && Object.keys(depositPlan(invCounts(this.sim))).length) await this.storeItems(gen);
    if (h.bed && sleep) await this.S.goNear(gen, fur.bed.standAt, 0.5, 2);
    else await this.S.goNear(gen, fur.stand, 0.5, 2);
    let tries = 0;
    // (Told to work nights while we sit here, `!bot goal nights off`: out we go, the plan takes over.)
    while (isNight(world.getTimeOfDay()) && !this.a.workNights?.(invCounts(this.sim))) {
      // Beds only work once it's properly dark (from about 12540).
      if (h.bed && sleep && !this.sim.isSleeping && world.getTimeOfDay() >= 12600 && tries++ < 20) {
        try { this.sim.interactWithBlock(fur.bed.foot, Direction.Up); } catch {}
      }
      await this.S.wait(gen, 40);
    }
    if (this.sim.isSleeping) { try { this.sim.stopInteracting(); } catch {} this.a.body.jump(); await this.S.wait(gen, 10); }
    if (!isNight(world.getTimeOfDay())) this.a.say('Morning.');
    return true;
  }

  /**
   * No house and no time to build one: dig two blocks down (here, or the nearest spot within a few
   * blocks where the ground is soft and dry) and cover the hole with a block. If we can't dig in,
   * wall ourselves in with blocks instead (4 around the feet, 4 around the head, 1 on top).
   * In the morning the usual climb-out gets us up.
   */
  async shelter(gen) {
    const S = this.S;
    if (this.a.onMiningTrip?.() || this.a.minedUnderground?.()) return this.mineShelter(gen);
    this.a.sayOnce('shelter', 'Night caught me without a house; holing up until morning.', 300000);
    // Three down, so the lid (one below ground level) has ground on every side to be placed against.
    const canDigIn = (x, y, z) => {
      const c1 = { x, y: y - 1, z }, c2 = { x, y: y - 2, z }, c3 = { x, y: y - 3, z }, floor = { x, y: y - 4, z };
      return [c1, c2, c3].every((c) => /^(dirt|grass_block|stone|andesite|diorite|granite|tuff|coarse_dirt|podzol|deepslate|sand|red_sand|clay|snow)$/.test(S.blockAt(c) ?? '') && !S.touchesLiquid(c)) &&
        !SOFT.test(S.blockAt(floor) ?? 'air') && !/water|lava|gravel|sand/.test(S.blockAt(floor) ?? '') && !FALLING_ABOVE(S, { x, y, z });
    };
    let f = S.feet();
    if (!canDigIn(f.x, f.y, f.z)) {
      const res = await this.a.plan(this.sim.location, this.sim.location, 0, 1500, (x, y, z, w) => w.standable(x, y, z) && canDigIn(x, y, z));
      S.check(gen);
      if (res.complete && res.path.length >= 2) await S.goNear(gen, { ...res.path[res.path.length - 1], x: res.path[res.path.length - 1].x + 0.5, z: res.path[res.path.length - 1].z + 0.5 }, 0.5, 2);
      f = S.feet();
    }
    let safe = false;
    if (canDigIn(f.x, f.y, f.z)) {
      for (const c of [{ x: f.x, y: f.y - 1, z: f.z }, { x: f.x, y: f.y - 2, z: f.z }, { x: f.x, y: f.y - 3, z: f.z }]) await S.mine(gen, c, { collect: true, allowBelow: true });
      await S.wait(gen, 10);
      const block = cheapestPlaceable(invCounts(this.sim), plankReserve(invCounts(this.sim))); // planks only if nothing else
      const lid = { x: f.x, y: f.y - 1, z: f.z };
      if (block) safe = await this.placeAt(gen, lid, block);
      if (safe) S.markPlaced(lid);
    }
    if (!safe) {
      // Box in: blocks around feet and head, then a lid.
      const g = S.feet();
      const cells = [];
      for (const h of [0, 1]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) cells.push({ x: g.x + dx, y: g.y + h, z: g.z + dz });
      cells.push({ x: g.x, y: g.y + 2, z: g.z });
      // All round, one block leading into the next (planks only if nothing else).
      const open = cells.filter((c) => SOFT.test(S.blockAt(c) ?? 'air'));
      await this.placeFlow(gen, open.map((c) => ({ cell: c, id: () => cheapestPlaceable(invCounts(this.sim), plankReserve(invCounts(this.sim))) })));
      for (const c of open) if (!SOFT.test(S.blockAt(c) ?? 'air')) S.markPlaced(c);
      safe = cells.every((c) => !SOFT.test(S.blockAt(c) ?? 'air'));
      if (!safe) this.a.say("Couldn't wall myself in; I'll keep watch until morning.");
    }
    while (isNight(world.getTimeOfDay())) await S.wait(gen, 40);
    await S.toSurface(gen); // dig/climb back out (our own blocks are fair game)
    return true;
  }

  /**
   * Night down the mine with nothing to do there (the pack's full): to the end of the main tunnel (a
   * dead end), the one way in walled off with two blocks, till morning; then the wall comes down and
   * the plan carries on from here. Never back up top in the dark.
   */
  async mineShelter(gen) {
    const S = this.S;
    const end = S.homeQuarry()?.mine?.at;
    if (end) await S.goNear(gen, { x: end.x + 0.5, y: end.y, z: end.z + 0.5 }, 0.6, 2);
    const me = this.sim.location;
    const w = this.a.classifier();
    const at = (x, y, z) => { const c = w(x, y, z); return c === Cell.AIR ? 'open' : c === Cell.SOLID || c === Cell.STEP || c === Cell.SLAB ? 'solid' : 'other'; };
    let cells = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      cells = barricadeCells(me, { x: me.x + dx * 3, y: me.y, z: me.z + dz * 3 }, at);
      if (cells) break;
    }
    const wall = (cells ?? []).filter((c) => SOFT.test(S.blockAt(c) ?? 'air'));
    await this.placeFlow(gen, wall.map((c) => ({ cell: c, id: () => cheapestPlaceable(invCounts(this.sim), plankReserve(invCounts(this.sim))) })));
    const placed = wall.filter((c) => !SOFT.test(S.blockAt(c) ?? 'air'));
    for (const c of placed) S.markPlaced(c);
    this.a.sayOnce('mine-shelter', placed.length ? 'Walled myself in at the end of the mine till morning.' : 'Keeping to the end of the mine till morning.', 300000);
    while (isNight(world.getTimeOfDay())) await S.wait(gen, 40);
    await S.mineFlow(gen, placed, () => ({ collect: true, force: true }));
    return true;
  }
}

const FALLING_ABOVE = (S, p) => /^(sand|red_sand|gravel)$/.test(S.blockAt({ ...p, y: p.y + 1 }) ?? '');

function sheepColour(e) {
  const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
  try { return `${COLOURS[e.getComponent('minecraft:color')?.value ?? 0]}_wool`; } catch { return 'white_wool'; }
}

