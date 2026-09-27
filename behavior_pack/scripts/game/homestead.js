// Settling in after stone tools: eating, hunting, smelting, the house, and nights.
// The plan (what to do next) is core/settle.js; this file is the doing.
import { system, world, Direction, ItemStack } from '@minecraft/server';
import { dist3D } from '../core/mathutil.js';
import { standOff } from '../core/threat.js';
import { isLog, isPlanks, TOOL_STONE, count } from '../core/recipes.js';
import { FOODS, RAW, isNight, TORCH_GOAL, fittingsPlanks } from '../core/settle.js';
import { planFuel, burnsFor, charcoalInput } from '../core/fuel.js';
import { blueprint, clearance, footing, furnishings, inside } from '../core/house.js';
import { cheapestPlaceable, plankReserve } from '../core/costs.js';
import { siteWork, siteScore } from '../core/site.js';
import { depositPlan, takePlan } from '../core/storage.js';
import { invCounts, hold, take, give, container as packOf } from './inventory.js';
import { canSee, ONE_TAP } from './world.js';
import { barricadeCells } from '../core/tactics.js';
import { Cell } from '../core/pathfinder.js';

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

  /** Eat if hungry (or hurt and not full): the food that wastes least, cooked before raw, never raw chicken unless starving. */
  async maybeEat(gen) {
    const hunger = this.hunger(), health = this.a.health();
    if (!(hunger <= 14 || (health < 16 && hunger < 20))) return false;
    const inv = invCounts(this.sim);
    const missing = 20 - hunger;
    let best = null, bestScore = -Infinity;
    for (const [id, v] of Object.entries(FOODS)) {
      if (!inv[id] || (id === 'chicken' && hunger > 6)) continue;
      const score = Math.min(v, missing) - 0.5 * Math.max(0, v - missing) + (id in RAW ? 0 : 1);
      if (score > bestScore) { bestScore = score; best = id; }
    }
    if (!best) return false;
    const slot = hold(this.sim, best);
    if (slot < 0) return false;
    this.a.sayOnce('eat', `Eating (${best.replace(/_/g, ' ')}).`, 120000);
    try { this.sim.useItemInSlot(slot); } catch { return false; }
    try { await this.S.wait(gen, 36); } finally { try { this.sim.stopUsingItem(); } catch {} }
    return true;
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
    const skip = new Set();
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
      let swings = 0, landed = 0, lastHp = hp(), lastLand = start, closeIn = 0;
      while (!dead() && system.currentTick - start < 400) {
        await S.wait(gen, 2);
        if (dead()) break;
        last = { ...target.location };
        const p = this.sim.location;
        const d = dist3D(p, last);
        const chest = { x: last.x, y: last.y + 0.6, z: last.z };
        this.a.motor.setFocus(chest);
        const now = system.currentTick;
        if ((now - start) % 100 < 2) S.log(`hunt: ${pick.type} ${d.toFixed(1)} away (${(last.y - p.y).toFixed(1)} up), ${swings} swings, ${landed} hits`);
        if (d > 2.8 && now >= nextRoute) {
          nextRoute = now + 8;
          this.a.routeTo(standOff(p, last, 2.2), 0.5, d > 6, 1200);
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
    const known = this.a.memory.list('furnace', this.dim.id, this.sim.location).filter((e) => !this.isCamp(e.pos))[0];
    // Our furnace, even a walk away: the plan counts it as ours (settle.js), so go to it rather than
    // failing here over and over. Only a furnace in the pack (none known nearby) gets put down.
    if (known && (known.dist < 128 || !invCounts(this.sim).furnace)) {
      await S.reach(gen, known.pos);
      if (this.furnaceAt(known.pos)) return known.pos;
      this.a.memory.forgetNear('furnace', this.dim.id, known.pos, 0.5);
    }
    if (!invCounts(this.sim).furnace) return null;
    const p = await S.place(gen, 'furnace');
    if (p) this.a.memory.remember('furnace', this.dim.id, p);
    return p;
  }

  /** Load the furnace and leave it working. input: 'log' (charcoal) or 'food' (raw meat). */
  async startSmelt(gen, input, n, fuelPlanks) {
    const pos = await this.ensureFurnace(gen, input);
    if (!pos) return false;
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
    return true;
  }

  /** Take whatever's done out of the furnace. */
  async emptyFurnace(pos) {
    const c = this.container(pos);
    if (!c) return 0;
    let n = 0;
    for (const slot of [2]) {
      const it = c.getItem(slot);
      if (it) { give(this.sim, strip(it.typeId), it.amount); n += it.amount; c.setItem(slot, undefined); }
    }
    return n;
  }

  async collectSmelt(gen) {
    // The nearest finished job (else the nearest one).
    const near = this.smeltJob;
    const ready = near && system.currentTick >= near.readyAt ? near : this.jobs.filter((j) => system.currentTick >= j.readyAt).sort((a, b) => dist3D(this.sim.location, a.pos) - dist3D(this.sim.location, b.pos))[0];
    const job = ready ?? near;
    if (!job) return;
    if (!(await this.S.reach(gen, job.pos))) { this.S.log('furnace: couldn\'t get to it (in reach and in view)'); return; }
    if (!this.furnaceAt(job.pos)) { this.dropJob(job.pos); this.a.saveState(); return; }
    await this.a.motor.lookAt(center(job.pos), 10, 30);
    this.S.check(gen);
    const got = await this.emptyFurnace(job.pos);
    const left = this.container(job.pos)?.getItem(0)?.amount ?? 0;
    if (left) this.setJob({ ...job, readyAt: system.currentTick + left * 200 + 20 });
    else this.dropJob(job.pos);
    this.a.saveState();
    if (got) this.a.say(`Took ${got} out of the furnace.`);
  }

  /** Stand by the furnace until the job's done (only when there's nothing else to do). */
  async waitSmelt(gen) {
    const job = this.smeltJob;
    if (!job) return;
    await this.S.reach(gen, job.pos);
    while (system.currentTick < job.readyAt) await this.S.wait(gen, 20);
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
  async placeAt(gen, cell, itemId, via = null, next = null) {
    const S = this.S;
    if (!SOFT.test(S.blockAt(cell) ?? 'air')) return S.blockAt(cell) === itemId;
    const faces = via ? FACES.filter(([o]) => cell.x + o[0] === via.x && cell.y + o[1] === via.y && cell.z + o[2] === via.z) : FACES;
    for (const [o, face, loc] of faces) {
      const n = { x: cell.x + o[0], y: cell.y + o[1], z: cell.z + o[2] };
      const nid = S.blockAt(n) ?? 'air';
      if (SOFT.test(nid) || /water|lava/.test(nid)) continue;
      if (!S.inReach(cell)) return false;
      const slot = hold(this.sim, itemId);
      if (slot < 0) return false;
      // The crosshair onto the face we'll click (near enough, as a player's hand gets there; no stop
      // and settle), then straight on toward the next block as this one goes down.
      const faceAt = { x: (cell.x + n.x) / 2 + 0.5, y: (cell.y + n.y) / 2 + 0.5, z: (cell.z + n.z) / 2 + 0.5 };
      await S.aim(gen, faceAt, 15, 6);
      S.check(gen);
      const r = await S.placeOn(gen, slot, n, face, loc, cell);
      this.a.motor.setFocus(next ? center(next) : null);
      if (r || !SOFT.test(S.blockAt(cell) ?? 'air')) return true;
      S.log(`place ${itemId} at ${cell.x} ${cell.y} ${cell.z} against ${nid} (${face}): ${r}, still ${S.blockAt(cell)}`);
    }
    return false;
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
        if (!bad) cands.push({ x, y: g + 1, z, rough: work * 1.2 + r / 4.3 });
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
    return best && Number.isFinite(best.score) ? { x: best.x, y: best.y, z: best.z, dir: best.dir } : null;
  }

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
    for (const b of blueprint(p, p.dir)) { total++; if (!SOFT.test(this.S.blockAt(b) ?? 'air')) placed++; }
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
    for (const b of blueprint(site, dir)) if (missing(b)) b.material === 'stone' ? stone++ : planks++;
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
    const fitShort = Math.max(0, fittingsPlanks(inv) + 4 - Math.max(0, havePlanks - planks));
    return this[cacheKey] = { stone: walls.stone, planks: walls.planks + fitShort };
  }


  /** Craft enough planks (from logs) for what's left of the house's plank blocks. */
  async plankUp(gen, site, dir) {
    let planksLeft = 0;
    for (const b of blueprint(site, dir)) if (b.material === 'planks' && SOFT.test(this.S.blockAt(b) ?? 'air')) planksLeft++;
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
    this.a.memory.data.houseProject = { d: this.dim.id, x: site.x, y: site.y, z: site.z, dir: site.dir, started: Date.now() };
    this.a.memory.saveNow();
    // Walls, roof and fittings (door, bed, table, chest) together: one trip for all of it.
    const need = this.houseNeeds(site, site.dir, { fittings: true });
    this.shortfall = need;
    const logs = Math.ceil(need.planks / 4);
    this.a.say(need.stone || need.planks
      ? `House spot picked at ${site.x} ${site.y} ${site.z}. Still need ${need.stone} cobblestone and ${need.planks} planks (${logs} logs), counting the door, bed, table and chest.`
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
    if (!this.project) { this.a.memory.data.houseProject = { d: this.dim.id, x: site.x, y: site.y, z: site.z, dir, started: Date.now() }; this.a.memory.saveNow(); }
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
    const built = await this.placeFlow(gen, walls.map((b) => ({ cell: b, id: () => this.materialFor(b.material) })),
      async (it) => { if (!S.inReach(it.cell)) await S.goNear(gen, fur.stand, 0.4, 2); });
    if (built.outOf) { this.a.say("Ran out of blocks for the house; I'll get more and finish it."); this.shortfall = this.houseNeeds(site, dir); return false; }
    const missed = built.missed;
    if (missed > 3) { this.a.say(`Couldn't place ${missed} blocks of the house.`); }
    this.setHouse({ x: site.x, y: site.y, z: site.z, dir, bed: false, furnace: false, table: false, level: 1 });
    this.a.memory.data.houseProject = null;
    this.a.memory.saveNow();
    await this.furnish(gen);
    this.placeDoor();
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
    for (const p of footing(h, h.dir)) if (missing(p)) out.push({ ...p, material: 'stone' });
    return out;
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
      if (!S.inReach(b)) await S.goNear(gen, fur.stand, 0.6, 2);
      if (!S.inReach(b)) await S.goNear(gen, b, 2, 2);
      if (await this.placeAt(gen, b, id)) fixed++;
    }
    S.restHands();
    const left = this.houseDamage().length;
    this.a.say(left ? `Patched ${fixed} blocks of the house; ${left} I couldn't reach yet.` : `House repaired (${fixed} block${fixed === 1 ? '' : 's'}).`);
    return left === 0;
  }

  /** Put the door in from the item (the simulated player can't place doors itself). */
  placeDoor() {
    const h = this.house;
    if (!h || !invCounts(this.sim).wooden_door) return false;
    const fur = furnishings(h, h.dir);
    if (/door/.test(this.S.blockAt(fur.door) ?? '')) return true;
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
    if (!this.houseLoaded()) return this.lastHouseState ?? { damage: 0, door: true, bed: !!h.bed, bedMisplaced: false, table: !!h.table, furnace: !!h.furnace, chest: !!h.chest, lit: true, litOutside: true };
    const fur = furnishings(h, h.dir), at = (p) => this.S.blockAt(p) ?? '';
    return this.lastHouseState = {
      damage: this.houseDamage().length,
      door: /door/.test(at(fur.door)),
      // Both halves, in the planned cells: half a bed, or one across the wall line, isn't a bed.
      bed: /bed/.test(at(fur.bed.foot)) && /bed/.test(at(fur.bed.head)),
      bedMisplaced: !(/bed/.test(at(fur.bed.foot)) && /bed/.test(at(fur.bed.head))) && this.bedBlocks().length > 0,
      table: at(fur.table) === 'crafting_table',
      furnace: /furnace/.test(at(fur.furnace)),
      chest: /chest/.test(at(fur.chests[0])),
      lit: /torch/.test(at(fur.torchInside.toward)),
      litOutside: fur.torchesOutside.every((t) => /torch/.test(at(t.toward))),
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
    if (!inside(h, this.sim.location)) await this.enterHouse(gen);
    let inv = invCounts(this.sim);
    if (!h.table && !inv.crafting_table && (count(inv, isPlanks) >= 4 || count(inv, isLog) >= 1)) await S.craft(gen, ['crafting_table'], false);
    if (!h.table && invCounts(this.sim).crafting_table) {
      await S.goNear(gen, fur.stand, 0.4, 2);
      if (await this.placeAt(gen, fur.table, 'crafting_table')) { h.table = true; this.a.memory.rememberTable(this.dim.id, fur.table); }
    }
    if (!h.furnace && !invCounts(this.sim).furnace) await this.fetchFurnace(gen).catch(() => false);
    if (!h.furnace && invCounts(this.sim).furnace) {
      await S.goNear(gen, fur.stand, 0.4, 2);
      if (await this.placeAt(gen, fur.furnace, 'furnace')) { h.furnace = true; this.a.memory.remember('furnace', this.dim.id, fur.furnace); }
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
      if (!h.bed && SOFT.test(S.blockAt(fur.bed.foot) ?? 'air') && SOFT.test(S.blockAt(fur.bed.head) ?? 'air') && invCounts(this.sim).bed) {
        // The simulated player's bed placement is unreliable in tight rooms: set it from the item instead.
        // Bedrock's setblock makes the given cell the HEAD and puts the foot one block behind it
        // (tested: direction 0 = head to the south). Setting it at the foot cell put the foot in
        // the back wall, knocking a hole in it: so set the head cell, facing the front.
        take(this.sim, 'bed', 1);
        const direction = { south: 0, west: 1, north: 2, east: 3 }[h.dir];
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
    if (!/door/.test(S.blockAt(fur.door) ?? '')) this.placeDoor();
    // The chest, in the front corner by the door.
    if (!/chest/.test(S.blockAt(fur.chests[0]) ?? '') && invCounts(this.sim).chest) {
      await S.goNear(gen, fur.stand, 0.4, 2);
      if (await this.placeAt(gen, fur.chests[0], 'chest') || this.setChest(fur.chests[0], h)) { h.chest = true; this.a.say('Put a chest in the house.'); }
    }
    if (invCounts(this.sim).torch && S.blockAt(fur.torchInside.toward) === 'air') {
      await S.goNear(gen, fur.stand, 0.4, 2);
      await this.placeAt(gen, fur.torchInside.toward, 'torch', fur.torchInside.on);
    }
    this.setHouse(h);
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
  setChest(cell, h) {
    if (!invCounts(this.sim).chest || !SOFT.test(this.S.blockAt(cell) ?? 'air')) return false;
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
    if (!Object.keys(plan).length) return true;
    if (!this.isHome()) await this.enterHouse(gen);
    await S.goNear(gen, fur.stand, 0.4, 2);
    let stored = 0;
    for (let ci = 0; ci < fur.chests.length && Object.keys(plan).length; ci++) {
      const pos = fur.chests[ci];
      if (!/chest/.test(S.blockAt(pos) ?? '')) {
        // The first chest's full: a second one (8 planks) against the back wall.
        if (ci === 0) break;
        if (!invCounts(this.sim).chest && !(await S.craft(gen, ['chest'], true, true))) break;
        if (!(await this.placeAt(gen, pos, 'chest')) && !this.setChest(pos, h)) break;
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
        const want = plan[id] ?? 0;
        if (want <= 0) continue;
        if (want >= it.amount) {
          const left = pack.transferItem(i, chest); // the whole stack, as it is
          const moved = it.amount - (left?.amount ?? 0);
          stored += moved;
          plan[id] = want - moved;
        } else {
          const left = chest.addItem(new ItemStack(it.typeId, want));
          const moved = want - (left?.amount ?? 0);
          if (moved > 0) { take(this.sim, id, moved); stored += moved; }
          plan[id] = want - moved;
        }
        if (plan[id] <= 0) delete plan[id];
      }
      await S.wait(gen, 6);
    }
    this.chestContents();
    S.restHands();
    const left = Object.values(plan).reduce((a, n) => a + n, 0);
    // Both chests full: don't come back to try again for a while (the plan would ask every round).
    this.a.memory.data.chestFullAt = left ? Date.now() : 0;
    this.a.memory.save();
    this.a.say(stored ? `Put ${stored} things away in the chest${left ? ` (${left} didn't fit)` : ''}.` : 'The chest is full.');
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
    this.a.sayOnce('gohome', 'Getting dark, heading home.', 300000);
    if (!(await this.enterHouse(gen))) return false;
    const fur = furnishings(h, h.dir);
    // Home for the night anyway: put away what we don't need to carry before bed.
    if (this.chests().length && Object.keys(depositPlan(invCounts(this.sim))).length) await this.storeItems(gen);
    if (h.bed) await this.S.goNear(gen, fur.bed.standAt, 0.5, 2);
    let tries = 0;
    while (isNight(world.getTimeOfDay())) {
      // Beds only work once it's properly dark (from about 12540).
      if (h.bed && !this.sim.isSleeping && world.getTimeOfDay() >= 12600 && tries++ < 20) {
        try { this.sim.interactWithBlock(fur.bed.foot, Direction.Up); } catch {}
      }
      await this.S.wait(gen, 40);
    }
    if (this.sim.isSleeping) { try { this.sim.stopInteracting(); } catch {} this.a.body.jump(); await this.S.wait(gen, 10); }
    this.a.say('Morning.');
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

