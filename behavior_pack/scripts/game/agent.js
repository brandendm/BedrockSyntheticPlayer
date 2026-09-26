// One agent = one SimulatedPlayer + motor + task state.
// Everything time-critical (movement, survival reflexes) runs locally every few ticks for free;
// the brain is only consulted on events (commands, stuck, task done, combat reports).
import { system, world, EntityComponentTypes, Direction, EquipmentSlot, ItemStack } from '@minecraft/server';
import { MotorController, EYE_HEIGHT } from '../core/motor.js';
import { searchJob, smoothPath, Cell } from '../core/pathfinder.js';
import { dist3D, makeRng } from '../core/mathutil.js';
import { decide, fleePoint, refugeScore, weaponDamage, MOBS, spacing, standOff, REACH_HIT, STOP_AT, HOLD_AT } from '../core/threat.js';
import { nextStep, STONE_TARGETS, TOOL_STONE, count, isLog } from '../core/recipes.js';
import { settleStep, foodCount, FOOD_GOAL, isNight } from '../core/settle.js';
import { goalChain } from '../core/goals.js';
import { advanceStep, advanceProgress } from '../core/advance.js';
import { Farm } from './farm.js';
import { chooseStep, needs as goalNeeds, stepKey } from '../core/focus.js';
import { inside as houseInside } from '../core/house.js';
import { FULL_SLOTS } from '../core/storage.js';
import { Homestead, FOOD_ANIMALS } from './homestead.js';
import { Lookout } from './lookout.js';
import { Skills, Aborted, markVisited } from './skills.js';
import { invCounts, hold, container } from './inventory.js';
import { WorldMemory } from './memory.js';
import { SimBodyAdapter } from './body.js';
import { makeClassifier, canSee, isWatery, OPENABLE } from './world.js';
import { sendEvent, trace } from './bridge.js';
import { parseLocal } from './localCommands.js';
import { CONFIG } from '../config.js';

const SURVIVE_EVERY = 4;          // ticks between threat checks (0.2 s reaction time)
const ENDERMAN_SCAN_EVERY = 20;
const CALM_TICKS_TO_RESUME = 40;  // threats gone this long -> resume the interrupted task
const ATTACKER_MEMORY_TICKS = 200;

/** A sword worth hunting with: stone or better (a wooden one or a fist wastes the time). */
const SWORD_OK = /\b(stone|iron|diamond|netherite)_sword\b/;

const STEP_WORDS = {
  gather_logs: 'getting wood', get_stone: 'getting cobblestone', place_table: 'placing a crafting table', goto_table: 'walking to the crafting table',
  hunt: 'hunting', smelt: 'the furnace job', collect_smelt: 'collecting from the furnace', wait_smelt: 'waiting on the furnace',
  plan_house: 'picking a spot for the house', build_house: 'building the house', repair_house: 'repairing the house', furnish: 'moving things into the house', light_outside: 'putting torches up by the door',
  check_water: 'looking for water to farm by', make_farm: 'making a wheat farm', tend_farm: 'harvesting and replanting wheat', get_iron: 'mining for iron', equip: 'putting on armor',
  store: 'putting things away in the chest',
  go_home: 'night: going home to sleep', shelter: 'night: holed up until morning', done: 'all goals done', blocked: 'stuck on a recipe',
};

export class Agent {
  constructor(sim) {
    this.sim = sim;
    this.rng = makeRng();
    this.body = new SimBodyAdapter(sim);
    this.motor = new MotorController(this.body, {}, this.rng);
    this.task = null;        // {kind, ...} - what the agent is doing right now
    this.taskGen = 0;        // bumps on every new task so stale async loops exit
    this.followTick = 0;

    // survival state
    this.mode = 'none';      // none | fight | flee
    this.suspended = null;   // task interrupted by a fight/flight, resumed when calm
    this.calmSince = 0;
    this.attackers = new Map(); // entity id -> tick it last hurt us
    this.nextSwing = 0;
    this.nextRoute = 0;
    this.damage = 1;
    this.weaponId = null;
    this.lastShout = -Infinity;

    // default behaviour: work toward stone tools on its own
    this.memory = new WorldMemory();
    this.skills = new Skills(this);
    this.homestead = new Homestead(this);
    this.farm = new Farm(this);
    this.lookout = new Lookout(this);
    system.runTimeout(() => { try { this.restoreState(); } catch {} }, 40);
    this.badCells = new Map();   // "x,y,z" -> until (ms): cells we got stuck walking into
    this.deferred = new Map();   // stepKey -> {until (ms), step}: ladder steps that kept failing, set aside (core/focus.js)
    this.autoOpportunity = null; // the kind of side job we're on (sheep, food, log, stone), if any
    this.bonusUntil = 0;         // tick: taking extra for later jobs until then (checkStillNeeded waits)
    this.stuckOnce = new Map();  // first time we got stuck at a cell
    this.lastSeen = new Map();   // mob id -> tick we last saw it
    this.reachCache = new Map(); // mob id -> { ok, t, pending }: can it walk to us?
    this.hunting = false;        // homestead.hunt is steering the head
    this.trail = [];             // recent positions, newest last: {x, y, z, under}
    const follow = this.motor.followPath.bind(this.motor);
    this.motor.followPath = async (wps, opts) => {
      const r = await follow(wps, opts);
      if (r.status === 'stuck') this.noteStuck(r, wps);
      return r;
    };
    this.autoEnabled = true;
    this.autoDone = false;
    this.nextAutoTry = 0;
    this.knownSurfaceStone = null;
    this.waterIdle = 0;
  }

  get dim() {
    return this.sim.dimension;
  }

  say(text) {
    console.warn(`[agent] <${this.sim.name}> ${text}`);
    sendEvent({ type: 'log', text, state: this.snapshot() }).catch(() => {}); // brain/logs/events.jsonl
    try {
      this.sim.chat(text);
    } catch {
      world.sendMessage(`<${this.sim.name}> ${text}`);
    }
  }

  /** say(), but at most once per `ms` for the same key (no chat spam from retry loops). */
  sayOnce(key, text, ms = 15000) {
    const now = Date.now();
    if (!this.saidAt) this.saidAt = new Map();
    if (now - (this.saidAt.get(key) ?? 0) < ms) return;
    this.saidAt.set(key, now);
    this.say(text);
  }

  onDeath() {
    // Everything we carried is on the ground here for 5 minutes: go back for it after respawning.
    const p = this.body.getPos();
    this.deathSpot = { x: p.x, y: p.y, z: p.z, d: this.dim.id, at: Date.now() };
    this.saveState();
    this.newTask(null);
    this.suspended = null;
    this.endCombat();
    this.emit('died');
  }

  /** Called from main.js on entityHurt where we're the victim. */
  onHurt(attacker) {
    if (attacker && attacker.id !== this.sim.id) this.attackers.set(attacker.id, system.currentTick);
  }

  // ---------- main loop ----------

  tick() {
    if (!this.sim.isValid) return;
    const t = system.currentTick;
    if (t % SURVIVE_EVERY === 0) this.survive(t);
    if (t % ENDERMAN_SCAN_EVERY === 0) this.watchEndermen();
    if (t % 40 === 0) this.equipBestWeapon();
    if (t % 20 === 0) { this.keepChunksLoaded(); markVisited(this.skills, this.body.getPos()); }
    if (t % 40 === 10) this.dropCrumb();
    if (t % 10 === 5 && this.skills.spotWant && this.motor.busy && !this.skills.spotted) {
      try {
        const p = this.skills.spotCheck(this.skills.spotWant);
        if (p) { this.skills.spotted = p; if (this.skills.spotWant === 'log') this.memory.remember('log', this.dim.id, p, 4); this.motor.stop(); }
      } catch {}
    }
    if (t % 60 === 30) { try { this.lookout.glance(); } catch (e) { if (CONFIG.debug) console.warn(`[agent] glance: ${e}`); } }
    if (t % 600 === 300 && this.mode === 'none' && !this.surveying) {
      this.surveying = true; // look around and remember what's here (resources, tables, items)
      this.skills.survey().catch(() => {}).finally(() => { this.surveying = false; });
    }
    this.fightSpacingTick();
    // Head locked on something while just walking (a fight or a hunt that ended mid-step): let go,
    // so we look where we're going again.
    // Head locked on a target while walking a path, with no fight going on (or the "fight" is
    // over: target dead, gone or far away): let go, so we look where we walk.
    const ft = this.fightTarget;
    const staleFight = this.mode === 'fight' && (!ft?.isValid || dist3D(this.body.getPos(), ft.location) > 12);
    if (this.motor.focus && (this.mode !== 'fight' || staleFight) && !this.hunting && this.motor.intent?.kind === 'path') this.motor.setFocus(null);
    // Teleported (a jump of blocks in one tick): whatever we were walking, looking at or fighting
    // belongs to the old spot. Start clean: no head lock, fresh path, fresh motion checks.
    const here = this.body.getPos();
    if (this.lastTickPos && dist3D(here, this.lastTickPos) > 6) {
      trace(`teleported ${Math.round(dist3D(here, this.lastTickPos))} blocks: resetting motion`);
      this.body.resetProbe?.();
      this.endCombat(); // clears the target and the head lock; a fight/flee task ends, the job resumes
      this.motor.setFocus(null);
      this.motor.stop();
      if (this.task?.kind === 'auto') this.startAuto();
    }
    this.lastTickPos = here;
    this.doorTick();
    this.motor.tick();
    // Look around at people only when there's nothing to do (or while following): mid-job glances
    // were stealing the camera between steps.
    if (t % CONFIG.perceiveEveryTicks === 0 && this.mode === 'none' && (!this.task || this.task.kind === 'follow')) this.idleGlances();
    if (this.mode === 'none' && this.task?.kind === 'follow' && t - this.followTick >= CONFIG.followRepathTicks) {
      this.followTick = t;
      this.updateFollow();
    }
    if (t % 200 === 100 && this.mode === 'none' && !this.task && !this.checkingTrap) this.checkIdleTrapped();
    if (t % 40 === 20 && this.mode === 'none') this.checkStillNeeded();
    // Dusk: drop whatever daytime job is running so the plan can send us home.
    if (t % 100 === 50) {
      const night = isNight(world.getTimeOfDay());
      const mining = ['get_iron', 'get_stone'].includes(this.autoStep) && this.minedUnderground();
      if (night && !this.wasNight && this.task?.kind === 'auto' && !mining && !['go_home', 'shelter', 'build_house'].includes(this.autoStep)) this.startAuto();
      this.wasNight = night;
    }
    if (this.mode === 'none' && !this.task && !this.suspended && this.autoEnabled && !this.autoDone && t >= this.nextAutoTry) {
      this.startAuto();
    }
  }

  /**
   * Walking up to a closed door or fence gate: open it. Once we're through and a couple of blocks
   * past it, shut it again (animal pens stay shut, houses stay safe).
   */
  doorTick() {
    const p = this.body.getPos();
    if (this.motor.busy) {
      const d = this.body.lastDir;
      if (d && (d.x || d.z)) {
        const len = Math.hypot(d.x, d.z) || 1;
        for (const ahead of [0.8, 1.4]) {
          const c = { x: Math.floor(p.x + (d.x / len) * ahead), y: Math.floor(p.y), z: Math.floor(p.z + (d.z / len) * ahead) };
          let b;
          try { b = this.dim.getBlock(c); } catch { continue; }
          if (!b || !OPENABLE.test(b.typeId)) continue;
          let open = true;
          try { open = !!b.permutation.getState('open_bit'); } catch {}
          if (!open) {
            try { this.sim.interactWithBlock(c, Direction.Up); } catch {}
            (this.openedDoors ??= []).push({ ...c, at: system.currentTick });
          }
          break;
        }
      }
    }
    // Close what we opened once we're clear of it.
    if (this.openedDoors?.length) {
      this.openedDoors = this.openedDoors.filter((o) => {
        const dist = Math.hypot(p.x - (o.x + 0.5), p.z - (o.z + 0.5));
        if (dist < 2.2 && system.currentTick - o.at < 200) return true;
        try {
          const b = this.dim.getBlock(o);
          if (b && OPENABLE.test(b.typeId) && b.permutation.getState('open_bit') && dist < 5 && !(this.homestead.isHome() && /door/.test(b.typeId))) {
            this.sim.interactWithBlock(o, Direction.Up);
          }
        } catch {}
        return false;
      });
    }
  }

  /**
   * Can this mob walk to us? A short path search from it to us (the same moves we use), cached
   * for 2 s per mob. A zombie down in the cave below, or the far side of a ravine, can "target"
   * us all day without ever arriving: no reason to drop what we're doing.
   */
  canReachMe(e, pos, t) {
    const c = this.reachCache.get(e.id);
    if (c && (c.pending || t - c.t < 40)) return c.ok;
    const entry = { ok: c ? c.ok : dist3D(pos, e.location) <= 6, t, pending: true };
    this.reachCache.set(e.id, entry);
    if (this.reachCache.size > 64) for (const [id, v] of this.reachCache) if (t - v.t > 400) this.reachCache.delete(id);
    this.plan(e.location, pos, 2, 600).then((res) => { entry.ok = res.complete; entry.t = system.currentTick; entry.pending = false; })
      .catch(() => { entry.pending = false; });
    return entry.ok;
  }

  /**
   * What we were in the middle of, kept in the world's memory so a restart, a /reload or a death
   * picks up where it left off: the current step, where our things dropped, the furnace we loaded.
   */
  saveState() {
    const job = this.homestead?.smeltJob;
    this.memory.data.state = {
      step: this.autoStep ?? null,
      deathSpot: this.deathSpot ?? null,
      smelt: job ? { ...job, readyInMs: Math.max(0, (job.readyAt - system.currentTick) * 50) } : null,
      at: Date.now(),
    };
    this.memory.save();
  }

  restoreState() {
    const st = this.memory.data.state;
    if (!st) return;
    if (st.deathSpot && Date.now() - st.deathSpot.at < 280000) this.deathSpot = st.deathSpot;
    if (st.smelt && this.homestead) {
      const { readyInMs, ...job } = st.smelt;
      this.homestead.smeltJob = { ...job, readyAt: system.currentTick + Math.ceil((readyInMs ?? 0) / 50) };
    }
    const h0 = this.homestead?.project;
    if (h0 || (st.step && Date.now() - (st.at ?? 0) < 30 * 60000 && !['shelter', 'go_home', 'done'].includes(st.step))) {
      this.autoStep = st.step;
      const h = h0;
      this.say(h ? `Picking up where I left off: the house at ${h.x} ${h.y} ${h.z}.` : `Picking up where I left off (${String(st.step).replace(/_/g, ' ')}).`);
    }
  }

  /** Got stuck walking: remember the cell just ahead as blocked for a few minutes. */
  noteStuck(r, wps) {
    const at = r.at ?? this.body.getPos();
    const wp = wps[Math.min(r.waypointIndex ?? 0, wps.length - 1)];
    const d = Math.hypot(wp.x - at.x, wp.z - at.z);
    if (d < 0.3) return;
    const x = Math.floor(at.x + (wp.x - at.x) / d), z = Math.floor(at.z + (wp.z - at.z) / d), y = Math.floor(at.y);
    // Only a cell we should have been able to walk into (open at feet level), and only once it's
    // happened twice: one stuck can be a mob in the way; twice in the same spot is the terrain.
    let open = false;
    try { open = makeClassifier(this.dim)(x, y, z) === Cell.AIR; } catch {}
    if (!open) return;
    const k = `${x},${y},${z}`, now = Date.now();
    const seen = this.stuckOnce?.get(k);
    this.stuckOnce.set(k, now);
    if (!seen || now - seen > 60000) return;
    const until = now + 120000;
    this.badCells.set(k, until);
    if (this.badCells.size > 300) for (const [k, t] of this.badCells) if (t < Date.now()) this.badCells.delete(k);
    if (CONFIG.debug) console.warn(`[agent] stuck walking into ${x} ${y} ${z}; avoiding it for 2 min`);
  }

  /** Breadcrumbs: where we've been lately, and whether it was under ground. */
  dropCrumb() {
    const p = this.body.getPos();
    const last = this.trail[this.trail.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) < 3) return;
    const f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    let under = false; // under ground, or down in a pit or ravine: not somewhere to walk back to
    try { under = this.skills.isUnderground(f) || this.skills.rimClimb(f) > 0; } catch {}
    this.trail.push({ ...f, under });
    if (this.trail.length > 300) this.trail.shift();
  }

  /** The last place we stood on the surface, if we remember it. */
  lastSurface() {
    for (let i = this.trail.length - 1; i >= 0; i--) if (!this.trail[i].under) return this.trail[i];
    return null;
  }

  /** Standing idle at the bottom of a hole or pit it can't walk out of: climb out, whatever mode it's in. */
  checkIdleTrapped() {
    this.checkingTrap = true;
    const gen = this.taskGen, S = this.skills;
    (async () => {
      if (this.homestead.isHome() || S.coverAbove() > 0 || !(await S.isTrapped(gen))) return;
      if (this.task || gen !== this.taskGen) return;
      this.say("I'm stuck in a hole; climbing out.");
      this.apply([{ type: 'surface' }]);
    })().catch(() => {}).finally(() => { this.checkingTrap = false; });
  }

  /**
   * Simulated players don't load chunks the way real players do, so on its own the bot would be
   * stuck inside whatever area real players keep loaded. A ticking area that follows it (3 chunks
   * radius, moved when it's walked 24+ blocks) gives it its own loaded patch of world.
   */
  keepChunksLoaded() {
    const p = this.body.getPos();
    const c = this.areaCenter;
    if (c && Math.hypot(p.x - c.x, p.z - c.z) < 16) return;
    const x = Math.floor(p.x), z = Math.floor(p.z);
    try { this.dim.runCommand('tickingarea remove agent_bot'); } catch {}
    try {
      this.dim.runCommand(`tickingarea add circle ${x} 0 ${z} 3 agent_bot true`);
      this.areaCenter = { x, z };
    } catch (e) {
      console.warn(`[agent] ticking area: ${e}`);
    }
  }

  // ---------- perception ----------

  health() {
    try {
      return this.sim.getComponent(EntityComponentTypes.Health)?.currentValue ?? 20;
    } catch {
      return 20;
    }
  }

  isNight() {
    const t = world.getTimeOfDay();
    return t >= 12800 && t <= 23200;
  }

  /** Nearby mobs we know how to reason about, with what a player could actually know. */
  scanMobs(radius = 16) {
    const pos = this.body.getPos();
    const eye = { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z };
    const t = system.currentTick;
    let ents = [];
    try {
      ents = this.dim.getEntities({ location: pos, maxDistance: radius, families: ['monster'] });
    } catch { /* unloading */ }
    const out = [];
    for (const e of ents) {
      const type = e.typeId.replace('minecraft:', '');
      if (!MOBS[type] || !e.isValid) continue;
      let targetingMe = false;
      try { targetingMe = e.target?.id === this.sim.id; } catch {}
      const hitAt = this.attackers.get(e.id);
      const attackedMe = hitAt !== undefined && t - hitAt < ATTACKER_MEMORY_TICKS;
      const head = e.getHeadLocation();
      out.push({
        id: e.id, type, entity: e, head,
        pos: { x: e.location.x, y: e.location.y, z: e.location.z },
        dist: dist3D(pos, e.location),
        visible: canSee(this.dim, eye, head),
        targetingMe, attackedMe, recent: false, dy: e.location.y - pos.y, canReach: true, inWater: !!e.isInWater,
      });
      const m = out[out.length - 1];
      m.canReach = this.canReachMe(e, pos, t);
      if (m.visible) this.lastSeen.set(e.id, t);
      m.recent = m.visible || t - (this.lastSeen.get(e.id) ?? -Infinity) < 100; // seen in the last 5 s
    }
    return out;
  }

  watchEndermen() {
    let heads = [];
    try {
      heads = this.dim
        .getEntities({ location: this.body.getPos(), maxDistance: 64, type: 'minecraft:enderman' })
        .map((e) => e.getHeadLocation());
    } catch {}
    this.motor.setAvoid(heads);
  }

  idleGlances() {
    if (this.motor.busy || Math.random() > 0.15) return;
    // Working by itself and just between steps: eyes on the job, not on people.
    if (this.autoEnabled && !this.autoDone && this.task?.kind !== 'follow') return;
    const pos = this.body.getPos();
    const eye = { x: pos.x, y: pos.y + EYE_HEIGHT, z: pos.z };
    // Players first (a nod now and then, not a stare: once per 20 s at most), then passive mobs,
    // never endermen.
    const t = system.currentTick;
    let target = t - (this.lastPlayerGlance ?? -1e9) > 400 ? this.nearestPlayerHead(eye) : null;
    if (target) this.lastPlayerGlance = t;
    if (!target) {
      const m = this.scanMobs(12).find((x) => x.visible && x.type !== 'enderman');
      target = m?.head;
    }
    if (target) this.motor.glanceAt(target, 20 + Math.floor(Math.random() * 30));
  }

  nearestPlayerHead(eye) {
    let best = null, bd = 12;
    for (const p of world.getPlayers()) {
      if (p.id === this.sim.id || p.dimension.id !== this.dim.id) continue;
      const h = p.getHeadLocation();
      const d = dist3D(eye, h);
      if (d < bd && canSee(this.dim, eye, h)) { bd = d; best = h; }
    }
    return best;
  }

  // ---------- survival ----------

  /** Track our best weapon; it's only put in hand when a fight starts (tools stay in hand for work). */
  equipBestWeapon() {
    try {
      let best = null, bestDmg = 1;
      for (const id of Object.keys(invCounts(this.sim))) {
        const d = weaponDamage(id);
        if (d > bestDmg) { bestDmg = d; best = id; }
      }
      this.damage = bestDmg;
      this.weaponId = best;
    } catch (e) {
      console.warn(`[agent] equip: ${e}`);
    }
  }

  survive(t) {
    for (const [id, at] of this.attackers) if (t - at > ATTACKER_MEMORY_TICKS) this.attackers.delete(id);
    if (this.lastSeen.size > 200) for (const [id, at] of this.lastSeen) if (t - at > 200) this.lastSeen.delete(id);
    const mobs = this.scanMobs(this.mode === 'none' ? 16 : 24);
    const inWater = this.sim.isInWater;
    const d = decide({ health: this.health(), damage: this.damage, isNight: this.isNight(), prevMode: this.mode, mobs, inWater });
    // Cornered with nowhere better to run: fight the nearest thing that can be fought.
    if (d.mode === 'flee' && (this.corneredUntil ?? 0) > t && d.reason !== 'creeper') {
      const fightable = (m) => !MOBS[m.type].never && m.type !== 'creeper' && m.dist <= 8 && (m.visible || m.attackedMe);
      const target = d.threats.find((m) => m.attackedMe && fightable(m)) ?? d.threats.find(fightable);
      if (target) { d.mode = 'fight'; d.target = target.id; d.reason = 'cornered'; }
      else { d.mode = 'none'; d.reason = 'cornered, nothing close enough to fight: carry on'; }
    }

    // No fist fights with skeletons: bare-handed that's how we kept dying. Keep working and move on.
    if (d.mode === 'fight' && this.damage <= 1.5) {
      const tgt = mobs.find((m) => m.id === d.target);
      if (tgt && MOBS[tgt.type]?.kind === 'ranged' && !tgt.attackedMe) { d.mode = 'none'; d.reason = 'unarmed: not taking on a skeleton'; }
    }
    // Damping: flipping between calm and running over and over (a drowned in the lake, a mob at the
    // edge of range) gets nothing done. After 4 flips in a minute, stop reacting for 30 s unless
    // we're actually getting hurt.
    if (d.mode !== this.mode && (d.mode === 'none' || this.mode === 'none')) {
      this.flips = [...(this.flips ?? []).filter((x) => t - x < 1200), t];
      if (this.flips.length >= 8) { this.ignoreThreatsUntil = t + 600; this.flips = []; if (CONFIG.debug) console.warn('[agent] flip-flopping: ignoring threats for 30 s'); }
    }
    if (d.mode !== 'none' && (this.ignoreThreatsUntil ?? 0) > t && this.health() >= 10 && !d.threats.some((m) => m.attackedMe && m.dist <= 4)) {
      d.mode = 'none'; d.reason = 'ignoring (flip-flopping)';
    }
    if (d.mode !== this.mode) {
      if (CONFIG.debug) {
        const m = d.threats[0];
        console.warn(`[agent] survival: ${this.mode} -> ${d.mode} (${d.reason})${m ? ` nearest ${m.type} ${m.dist.toFixed(1)} targetingMe=${m.targetingMe} visible=${m.visible}` : ''}`);
      }
      if (d.mode !== 'none') {
        if (this.mode === 'none') {
          if (!['fight', 'flee', 'swim_out'].includes(this.task?.kind)) this.suspended = this.task ?? this.suspended;
          this.newTask({ kind: d.mode });
          if (d.mode === 'fight' && this.weaponId) hold(this.sim, this.weaponId);
          if (t - this.lastShout > 200) {
            this.lastShout = t;
            this.say(d.mode === 'fight' ? `Fighting a ${d.threats[0].type}.` : `Running from a ${d.threats[0].type}.`);
          }
        } else {
          this.newTask({ kind: d.mode });
        }
        this.emit('combat', { mode: d.mode, reason: d.reason, threats: d.threats.map((m) => ({ type: m.type, dist: +m.dist.toFixed(1) })) });
      }
      this.mode = d.mode;
      this.nextRoute = 0;
    }

    if (d.mode !== 'none' && this.body.headUnderwater() && this.body.airRatio() < 0.5) {
      this.checkWater(t, inWater); // air first, fight later
    } else if (d.mode === 'fight') {
      this.calmSince = t;
      this.fight(mobs.find((m) => m.id === d.target), t);
    } else if (d.mode === 'flee') {
      this.calmSince = t;
      this.flee(d.threats, t);
    } else if (this.task?.kind === 'fight' || this.task?.kind === 'flee') {
      this.endCombat();
    } else if (this.checkWater(t, inWater)) {
      // swimming to shore
    } else if (this.suspended && !this.task && t - this.calmSince > CALM_TICKS_TO_RESUME) {
      const s = this.suspended;
      this.suspended = null;
      this.resume(s);
    }
  }

  endCombat() {
    // Whatever we killed dropped something: pick it up before getting back to work.
    if (this.fightTarget && !this.fightTarget.isValid && this.fightLast) this.lootAt = { ...this.fightLast, at: Date.now() };
    this.fightTarget = null;
    this.motor.setFocus(null);
    if (this.task?.kind === 'fight' || this.task?.kind === 'flee') {
      this.newTask(null);
      this.motor.stop();
    }
    this.mode = 'none';
  }

  /**
   * In water with nowhere to go (knocked in, fell in, path ended in it): swim to the nearest dry
   * land. Paths that deliberately cross water keep the motor busy, so they aren't interrupted.
   */
  checkWater(t, inWater) {
    // Running out of air, whatever we're doing (climbing a flooded shaft, a path through water):
    // drop it and get our head into air now.
    if (this.task?.kind !== 'swim_out' && this.body.headUnderwater() && this.body.airRatio() < 0.5) {
      if (!['fight', 'flee'].includes(this.task?.kind)) this.suspended = this.task ?? this.suspended;
      const gen = this.newTask({ kind: 'swim_out' });
      this.motor.stop();
      this.calmSince = t;
      if (CONFIG.debug) console.warn(`[agent] air ${Math.round(this.body.airRatio() * 100)}%: swimming for air`);
      this.swimToAir(gen).then(() => { if (gen === this.taskGen) { this.newTask(null); this.calmSince = system.currentTick; } })
        .catch((e) => console.error(`[agent] swim for air: ${e}`));
      return true;
    }
    if (!inWater || this.motor.busy || this.task?.kind === 'swim_out') {
      this.waterIdle = 0;
      return this.task?.kind === 'swim_out';
    }
    if ((this.waterIdle += SURVIVE_EVERY) < 10) return false;
    this.waterIdle = 0;
    // Remember where we got wet so exploring stops heading this way.
    const p = this.body.getPos();
    this.wetSpots = [...(this.wetSpots ?? []).slice(-4), { x: p.x, z: p.z }];
    this.skills.exploreAngle = undefined;
    this.suspended = this.task ?? this.suspended;
    const gen = this.newTask({ kind: 'swim_out' });
    this.calmSince = t;
    this.swimOut(gen).catch((e) => console.error(`[agent] swim out: ${e}`));
    return true;
  }

  async swimOut(gen) {
    const res = await new Promise((resolve) => {
      const classify = makeClassifier(this.dim);
      // Search from the surface above us: a sunk body has no swim moves until it's floating.
      const p = this.body.getPos();
      const from = { x: p.x, y: Math.floor(p.y), z: p.z };
      for (let i = 0; i < 24; i++) {
        const b = this.dim.getBlock({ x: Math.floor(from.x), y: from.y + 1, z: Math.floor(from.z) });
        if (!isWatery(b)) break;
        from.y++;
      }
      const job = function* () {
        resolve(yield* searchJob(classify, from, from, { maxNodes: 4000, goalTest: (x, y, z, w) => w.standable(x, y, z) }));
      };
      system.runJob(job());
    });
    if (gen !== this.taskGen) return;
    if (CONFIG.debug) console.warn(`[agent] in water: swimming to land, ${res.complete ? res.path.length + ' steps' : 'no land found'}`);
    if (res.complete && res.path.length >= 2) {
      await this.motor.followPath(smoothPath(makeClassifier(this.dim), res.path), { urgent: true });
    } else if (this.body.headUnderwater()) {
      // Trapped under water (flooded cave, under an overhang): swim through the water to the
      // nearest pocket of air.
      await this.swimToAir(gen);
    } else {
      for (let i = 0; i < 20 && gen === this.taskGen; i++) { this.body.swimUp(); await system.waitTicks(1); }
    }
    if (gen === this.taskGen) { this.newTask(null); this.calmSince = system.currentTick; }
  }

  /** 3D search through water for the nearest air a head can go into, then push along the route. */
  async swimToAir(gen) {
    const h = this.sim.getHeadLocation();
    const start = { x: Math.floor(h.x), y: Math.floor(h.y), z: Math.floor(h.z) };
    const key = (p) => `${p.x},${p.y},${p.z}`;
    const prev = new Map([[key(start), null]]);
    let goal = null;
    const id = (p) => { try { return this.dim.getBlock(p); } catch { return undefined; } };
    // Search through the water for air, favouring up (a lake's surface is usually straight above).
    const buckets = [[{ p: start, c: 0 }]]; // costs are multiples of 0.5: bucket i holds cost i/2
    let bi = 0, left = 1;
    const push = (n) => { const i = Math.round(n.c * 2); (buckets[i] ??= []).push(n); left++; };
    for (let qi = 0; left > 0 && qi < 6000 && !goal; qi++) {
      while (!buckets[bi]?.length) bi++;
      const { p: c, c: cost } = buckets[bi].pop();
      left--;
      for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
        const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        if (prev.has(key(n))) continue;
        const b = id(n);
        if (!b) continue;
        if (b.isAir) { prev.set(key(n), c); goal = n; break; }
        if (!isWatery(b)) continue;
        prev.set(key(n), c);
        push({ p: n, c: cost + (dy > 0 ? 0.5 : dy < 0 ? 2 : 1) });
      }
    }
    if (!goal) {
      // Sealed in (a flooded pocket, water poured into our own shaft): dig for the air above, by
      // hand if need be; soft ground breaks in under a second.
      for (let dy = 1; dy <= 5 && !goal; dy++) {
        const c = { x: start.x, y: start.y + dy, z: start.z };
        const b = id(c);
        if (!b) break;
        if (b.isAir) { goal = c; break; }
        if (isWatery(b)) continue;
        if (!this.skills.isDiggable([c], { byHand: true })) break;
        if (CONFIG.debug) console.warn(`[agent] sealed under water: digging up through ${b.typeId}`);
        try { await this.skills.mine(gen, c, { collect: false }); } catch (e) { if (e instanceof Aborted) return; }
        for (let i = 0; i < 4; i++) { this.body.swimUp(); await system.waitTicks(1); }
      }
      if (goal) { for (let i = 0; i < 40 && gen === this.taskGen && this.body.headUnderwater(); i++) { this.body.swimUp(); await system.waitTicks(1); } return; }
    }
    if (CONFIG.debug) console.warn(`[agent] underwater: ${goal ? `air at ${goal.x} ${goal.y} ${goal.z}` : 'no air pocket found'}`);
    if (!goal) { for (let i = 0; i < 20 && gen === this.taskGen; i++) { this.body.swimUp(); await system.waitTicks(1); } return; }
    const route = [];
    for (let p = goal; p; p = prev.get(key(p))) route.push(p);
    route.reverse();
    // Follow the route with the head: aim two nodes ahead of the closest one, push every 2 ticks.
    let idx = 0;
    for (let t = 0; t < 300 && gen === this.taskGen; t++) {
      const hh = this.sim.getHeadLocation();
      if (!this.body.headUnderwater()) break;
      for (let j = idx; j < Math.min(route.length, idx + 6); j++) {
        const r = route[j];
        if (Math.hypot(r.x + 0.5 - hh.x, r.y + 0.5 - hh.y, r.z + 0.5 - hh.z) < 1.1) idx = j;
      }
      const w = route[Math.min(route.length - 1, idx + 2)];
      if (t % 2 === 0) {
        const dx = w.x + 0.5 - hh.x, dy = w.y + 0.5 - hh.y, dz = w.z + 0.5 - hh.z;
        const len = Math.hypot(dx, dz);
        const hx = len > 0.2 ? (dx / len) * 0.3 : 0, hz = len > 0.2 ? (dz / len) * 0.3 : 0;
        try { this.sim.applyKnockback({ x: hx, z: hz }, dy > 0.3 ? 0.16 : dy < -0.3 ? -0.04 : 0.07); } catch {}
      }
      await system.waitTicks(1);
    }
    for (let i = 0; i < 20 && gen === this.taskGen; i++) { this.body.swimUp(); await system.waitTicks(1); }
  }

  // ---------- autonomy (default behaviour) ----------

  startAuto() {
    const gen = this.newTask({ kind: 'auto' });
    this.runAuto(gen);
  }

  async runAuto(gen) {
    const S = this.skills, H = this.homestead;
    let last = '', repeats = 0;
    try {
      if (this.knownSurfaceStone === null && !S.isUnderground()) { // stone seen in a cave says nothing about the surface
        this.knownSurfaceStone = (await S.scan((id) => STONE_TARGETS.has(id), { radius: 24, below: 4, above: 8, limit: 1 })).length > 0;
        if (CONFIG.debug) console.warn(`[agent] surface stone in sight: ${this.knownSurfaceStone}`);
      }
      for (;;) {
        S.check(gen);
        await this.recoverDrops(gen);
        await this.pickUpLoose(gen);
        await H.maybeEat(gen);
        const inv = invCounts(this.sim);
        const near = await S.findTable(4);
        S.check(gen);
        if (near) this.memory.rememberTable(this.dim.id, near);
        const known = this.memory.nearestTable(this.dim.id, this.sim.location);
        // "At the table" means usable from here (in reach, in view): the same test crafting uses,
        // so the plan and the crafting never disagree (that was the walk-up, walk-away loop).
        const tableDist = near && S.usable(near) ? 0 : known && S.usable(known.pos) ? 0 : near ? dist3D(this.sim.location, near) : known ? known.dist : Infinity;
        const tableDy = near || !known ? 0 : known.pos.y - this.sim.location.y;
        const step = this.planStep(inv, tableDist, tableDy);
        const key = step.step + (step.items ? step.items.join() : '') + (step.count ?? '') + (step.what ?? '') + (step.why ?? '');
        repeats = key === last ? repeats + 1 : 0;
        last = key;
        // The same step straight back after failing in no time (a placement that didn't take, a
        // craft with no table): give it a moment instead of burning through the retries in a second.
        if (repeats > 0 && system.currentTick - (this.lastStepAt ?? 0) < 20) await S.wait(gen, 40);
        this.lastStepAt = system.currentTick;
        trace(`auto: ${key}${step.opportunity ? ` (side job: ${step.opportunity})` : ''}${step.setAside ? ` (set aside: ${step.setAside})` : ''}`);
        if (CONFIG.debug) console.warn(`[agent] auto: ${key}`);
        if (this.autoStep !== step.step) { this.autoStep = step.step; this.saveState(); }
        this.autoOpportunity = step.opportunity ?? null;
        this.autoLabel = this.labelFor(step);
        if (step.opportunity) this.sayOpportunity(step);
        // Out of the house for daytime work; out of any hole before anything but digging.
        // (Using what's in the house: the furnace, the table, putting things in. Walking out first and
        // back in for those was the in-and-out loop.)
        const inHouseJob = ['smelt', 'collect_smelt', 'furnish', 'store'].includes(step.step) || (['craft', 'goto_table'].includes(step.step) && H.house?.table);
        if (!['go_home', 'build_house', 'repair_house', 'shelter', 'wait_smelt'].includes(step.step) && !inHouseJob && H.isHome()) await H.leaveHouse(gen);
        // (Mining is meant to be underground: iron trips and stone don't climb out between stints.)
        if (!['get_stone', 'get_iron', 'shelter', 'go_home'].includes(step.step) && (await S.needsEscape(gen))) {
          last = ''; // getting out first isn't the step failing: don't count it toward giving up on it
          await S.toSurface(gen);
          continue;
        }
        // Steps that run in stints (iron mining is time-boxed and repeats on purpose) or handle their
        // own failure (the farm) never get set aside: exploring doesn't help them.
        if (repeats >= 3 && !['go_home', 'shelter', 'wait_smelt', 'explore', 'get_iron', 'make_farm', 'tend_farm', 'check_water', 'equip'].includes(step.step)) {
          // It keeps failing: set it aside for a few minutes and do the cheapest other thing on the
          // list (core/focus.js); it only goes exploring when nothing else is doable.
          if (step.step === 'hunt' && step.what === 'sheep') this.bedDeferredUntil = Date.now() + 300000;
          this.deferred.set(stepKey(step), { until: Date.now() + 180000, step: step.step });
          if (CONFIG.debug) console.warn(`[agent] setting aside ${stepKey(step)} for 3 min`);
          repeats = 0;
          last = '';
          continue;
        }
        switch (step.step) {
          case 'explore': {
            // Look where what the set-aside step needs is likely to be (biome-aware). Never for
            // stone: that's a quarry or a staircase down (core/focus.js).
            const what = { log: 'trees', sheep: 'sheep', food: 'animals' }[step.want] ?? 'supplies';
            const from = { ...this.sim.location };
            await S.explore(gen, what, step.want ?? null);
            // Somewhere new: steps that failed because of the spot (no room for the furnace or the
            // table, no table in view) get another go here instead of waiting out their 3 minutes.
            // Only if we really moved, and never jobs tied to the house (its furnace is where it
            // was: clearing those made smelt -> explore -> smelt loop every 30 s).
            const moved = Math.hypot(this.sim.location.x - from.x, this.sim.location.z - from.z);
            const atHouse = new Set(H.house ? ['smelt', 'furnish'] : []);
            if (moved >= 24) for (const [k, d] of this.deferred) if (['smelt', 'place_table', 'craft', 'plan_house', 'build_house', 'furnish'].includes(d.step) && !atHouse.has(d.step)) this.deferred.delete(k);
            break;
          }
          case 'gather_logs': {
            // Logs we put away in the chest come first, if we're near the house anyway.
            if (await this.fromChest(gen, isLog, step.count - count(inv, isLog))) break;
            // Everything the goals still need in one trip, not just this step's share: the rest of
            // the list (tools, fittings, sticks) is counted too, so we don't walk back for two logs.
            const later = Math.max(0, this.focusFacts(inv).need.logs - Math.max(0, step.count - count(inv, isLog)));
            const firm = Math.min(12, later);
            const target = step.count + (step.opportunity ? 0 : firm);
            if (!repeats && !step.opportunity) this.say(`Getting wood: ${target - count(inv, isLog)} logs for ${step.wanted.map((w) => w.replace(/_/g, ' ')).join(', ')}${firm && target > step.count ? ' and what comes after' : ''}.`);
            this.stockTarget = { step: 'gather_logs', n: target };
            try { await S.gatherLogs(gen, target, Math.min(8, Math.max(0, later - firm))); } finally { this.stockTarget = null; }
            break;
          }
          case 'craft':
            if (step.items[0] === 'crafting_table' && !repeats) {
              this.say(known ? `Making a new crafting table; mine is ${Math.round(known.dist)} blocks away.` : 'Making a crafting table.');
            }
            await S.craft(gen, step.items, step.needsTable);
            break;
          case 'place_table': await S.place(gen, 'crafting_table'); break;
          case 'goto_table': {
            if (!repeats) this.say(`Walking back to my crafting table, ${Math.round(step.dist)} blocks away.`);
            const ok = await S.reach(gen, known.pos);
            if (!ok && !S.inReach(known.pos)) {
              this.memory.markUnreachable(known.pos); // can't get there: next pass decides on a new one
              this.say("Can't get back to that table; I'll make another.");
            } else if (S.blockAt(known.pos) !== 'crafting_table') {
              this.memory.forgetTable(this.dim.id, known.pos); // broken or moved: stop counting on it
              this.say("My crafting table's gone.");
            }
            break;
          }
          case 'get_stone':
            if (await this.fromChest(gen, (id) => TOOL_STONE.has(id), step.need)) break;
            if (step.why && !repeats && !step.opportunity) this.say(`Getting ${step.need} more cobblestone for the ${step.why}.`);
            // The job's share first; then, while it's cheap (same tunnel), some for later jobs too.
            await S.getStone(gen, step.need, Math.min(32, Math.max(0, this.focusFacts(inv).need.stone - step.need)));
            break;
          case 'hunt':
            if (step.what === 'sheep') {
              if (!repeats && !step.opportunity) this.say(`Getting wool for a bed: ${step.need} more.`);
              const wool = () => Math.max(0, ...Object.entries(invCounts(this.sim)).filter(([id]) => id.endsWith('_wool')).map(([, n]) => n));
              if (!H.animals(new Set(['sheep'])).length) {
                const m = this.memory.list('sheep', this.dim.id, this.sim.location)[0];
                if (m && m.dist < 96) { await S.goNear(gen, m.pos, 4, 2); if (!H.animals(new Set(['sheep'])).length) this.memory.forgetNear('sheep', this.dim.id, m.pos, 16); }
                else await S.explore(gen, 'sheep', 'sheep'); // none known: toward grassland (plains, meadows)
              }
              await H.hunt(gen, new Set(['sheep']), () => wool() >= 3);
            } else if (step.what === 'trader') {
              this.sayOnce('trader', 'A wandering trader: taking his leads (for walking animals home, and into boats).', 120000);
              await H.hunt(gen, new Set(['wandering_trader']), () => (invCounts(this.sim).lead ?? 0) >= 1, 60);
            } else {
              await H.hunt(gen, FOOD_ANIMALS, () => foodCount(invCounts(this.sim)) >= FOOD_GOAL, 45);
            }
            break;
          case 'smelt':
            if (!(await H.startSmelt(gen, step.input, step.n, step.fuelPlanks))) await S.wait(gen, 40);
            break;
          case 'collect_smelt': await H.collectSmelt(gen); break;
          case 'light_outside': await H.lightOutside(gen); break;
          case 'check_water': await this.farm.checkWater(gen); break;
          case 'make_farm':
            if (!(await this.farm.make(gen, step.water, step.tiles))) {
              this.memory.data.farmFailedAt = Date.now(); // iron first, try the farm again in a while
              this.say("Couldn't make the farm here yet; getting iron first, I'll try again later.");
            }
            break;
          case 'tend_farm': await this.farm.tend(gen); break;
          case 'get_iron':
            if (!repeats) this.say(step.why === 'bucket' ? `Getting ${step.need} iron for a bucket, for the farm's water.` : `Mining for iron: ${step.need} more for the iron gear.`);
            if (!(await S.getIron(gen, step.need))) await S.wait(gen, 20);
            break;
          case 'equip': this.equipArmor(); break;
          case 'wait_smelt': await H.waitSmelt(gen); break;
          case 'build_house': await H.buildHouse(gen); break;
          case 'repair_house': await H.repairHouse(gen); break;
          case 'plan_house': await H.planHouse(gen); break;
          case 'furnish': await H.furnish(gen); break;
          case 'store': await H.storeItems(gen); break;
          case 'go_home': await H.nightAtHome(gen); break;
          case 'shelter': await H.shelter(gen); break;
          case 'blocked':
            this.sayOnce(`blocked:${step.missing}`, `I can't make a ${step.missing.replace(/_/g, ' ')} with what I have.`, 300000);
            await S.explore(gen, 'supplies');
            break;
          case 'done':
            if ((await S.needsEscape(gen)) && !(await S.toSurface(gen))) { await S.wait(gen, 200); break; } // try again shortly
            this.say(H.house ? 'Settled in: house with a door, bed, table, furnace and torches. Standing by for the next goal.' : 'Got stone tools. Standing by for the next goal.');
            this.autoDone = true;
            this.newTask(null);
            return;
        }
      }
    } catch (e) {
      if (e instanceof Aborted) return;
      console.error(`[agent] auto: ${e}\n${e.stack}`);
      trace(`auto error: ${e} | ${String(e?.stack ?? '').split('\n').slice(0, 3).join(' | ')}`);
      if (gen === this.taskGen) this.newTask(null);
      this.nextAutoTry = system.currentTick + 200;
    }
  }

  /**
   * Things a job needs that we put away in the house chest: take them out instead of fetching
   * more, when we're within a short walk of the house (not from the bottom of the mine).
   */
  async fromChest(gen, pred, n) {
    const H = this.homestead, h = H.house;
    if (n <= 0 || !h || !h.chest || dist3D(this.sim.location, h) > 48 || this.skills.isUnderground()) return false;
    const inChest = Object.entries(H.chestContents()).filter(([id]) => pred(id)).reduce((a, [, k]) => a + k, 0);
    if (!inChest) return false;
    return (await H.takeFromChest(gen, [[pred, n]])) > 0;
  }

  /**
   * Died recently: go back for our things before they despawn (5 minutes). Skipped at night when
   * it's far (walking back through the dark is how we died), and given up after one try.
   */
  async recoverDrops(gen) {
    const d = this.deathSpot;
    if (!d || d.d !== this.dim.id) return;
    const age = Date.now() - d.at, dist = dist3D(this.sim.location, d);
    if (age < 3000 || this.health() <= 0) return; // not respawned yet
    if (age > 280000) { this.deathSpot = null; this.saveState(); return; }
    if (dist < 4 && age < 10000) return; // still standing where we died (respawn pending)
    if (isNight(world.getTimeOfDay()) && dist > 40) return;
    // The spot is kept until we've actually been there and swept it: a fight, a swim or nightfall
    // on the way (anything that restarts the job) comes back here next, instead of forgetting it.
    d.tries = (d.tries ?? 0) + 1;
    if (d.tries > 4) { this.say("Couldn't get back to my things; they're gone."); this.deathSpot = null; this.saveState(); return; }
    this.saveState();
    this.sayOnce('recover', d.tries > 1 ? `Back to getting my things, ${Math.round(dist)} blocks away.` : `Going back for my things, ${Math.round(dist)} blocks away.`, 20000);
    const S = this.skills;
    for (let leg = 0; leg < 6 && dist3D(this.sim.location, d) > 4; leg++) {
      if (!(await S.goNear(gen, d, 3, 2)) && dist3D(this.sim.location, d) > 40) break;
    }
    if (dist3D(this.sim.location, d) <= 12) {
      await S.sweep(gen, d, 8, null, 25);
      let left = 0;
      try { left = this.dim.getEntities({ type: 'minecraft:item', location: d, maxDistance: 8 }).length; } catch {}
      if (left) this.say(`Got most of my things back; ${left} stack${left > 1 ? 's' : ''} I couldn't reach.`);
      else this.say('Got my things back.');
    }
    this.deathSpot = null;
    this.saveState();
  }

  /** Where things are from here: [{ label, dist, dir, dy }], home first. */
  whereList() {
    const pos = this.sim.location, dimId = this.dim.id;
    const names = ['south', 'south-west', 'west', 'north-west', 'north', 'north-east', 'east', 'south-east'];
    const at = (label, p) => {
      const dx = p.x - pos.x, dz = p.z - pos.z, d = Math.hypot(dx, dz);
      const a = Math.round(((Math.atan2(-dx, dz) * 180 / Math.PI + 360) % 360) / 45) % 8;
      return { label, dist: Math.round(d), dir: d < 3 ? 'here' : names[a], dy: Math.round(p.y - pos.y), x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    };
    const out = [];
    const h = this.homestead.house;
    if (h) out.push(at('home', h));
    else if (this.homestead.project) out.push(at('house (unfinished)', this.homestead.project));
    const cats = new Map();
    for (const e of this.memory.list(() => true, dimId, pos)) if (!cats.has(e.cat)) cats.set(e.cat, e);
    for (const [cat, e] of cats) out.push(at(cat.replace(/^item:/, 'dropped ').replace(/_/g, ' '), e.pos));
    if (this.deathSpot) out.push(at('my dropped gear', this.deathSpot));
    return out;
  }

  sayWhere() {
    const list = this.whereList();
    const txt = (w) => `${w.label} ${w.dir === 'here' ? 'right here' : `${w.dist} ${w.dir}`}${Math.abs(w.dy) >= 4 ? (w.dy > 0 ? `, ${w.dy} up` : `, ${-w.dy} down`) : ''}`;
    const under = this.skills.isUnderground();
    this.say(list.length ? `${under ? "I'm underground. " : ''}${list.slice(0, 10).map(txt).join('; ')}.` : "I don't know this area yet.");
  }

  /** The goal chain with progress, for the dashboard (core/goals.js). */
  goals() {
    const H = this.homestead, pos = this.sim.location, dimId = this.dim.id;
    const table = this.memory.nearestTable(dimId, pos);
    const furnace = this.memory.list('furnace', dimId, pos)[0];
    const p = H.project;
    return goalChain({
      inv: invCounts(this.sim),
      tableKnown: !!table && table.dist < 48,
      furnaceKnown: !!furnace,
      house: H.house ? H.houseState() : null,
      project: p ? { ...H.projectProgress(), needs: H.houseNeeds(p, p.dir, { fittings: true }) } : H.house ? { placed: 69, total: 69 } : null,
      // A side job doesn't move the dashboard's goal (it's for later): the ladder's goal stays current.
      step: this.task?.kind === 'auto' && !this.autoOpportunity ? this.autoStep : null,
      advance: H.house ? { ...advanceProgress({ inv: invCounts(this.sim), worn: this.worn() }), waterKnown: this.memory.data.waterNearHouse != null && (this.memory.data.waterNearHouse || advanceProgress({ inv: invCounts(this.sim), worn: this.worn() }).bucket) } : null,
    });
  }

  /** Everything the dashboard shows (brain/dashboard.html), sent to the brain once a second. */
  status() {
    const p = this.sim.location;
    let hunger = 20, air = 1;
    try { hunger = this.homestead.hunger(); } catch {}
    try { air = this.body.airRatio(); } catch {}
    const inv = Object.entries(invCounts(this.sim)).map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n);
    let held = null;
    try { held = container(this.sim)?.getItem(this.sim.selectedSlotIndex)?.typeId.replace('minecraft:', '') ?? null; } catch {}
    let underground = false;
    try { underground = this.skills.isUnderground(); } catch {}
    const time = world.getTimeOfDay();
    return {
      name: this.sim.name, online: this.sim.isValid,
      pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, dim: this.dim.id.replace('minecraft:', ''),
      health: Math.round(this.health()), hunger: Math.round(hunger), air: Math.round(air * 100),
      mode: this.mode, task: this.task?.kind ?? 'idle', step: this.task?.kind === 'auto' ? this.autoStep ?? null : null,
      auto: this.autoEnabled, autoDone: this.autoDone, underground,
      time, night: isNight(time), day: Math.floor(world.getDay?.() ?? 0),
      held, inventory: inv, where: this.whereList().slice(0, 12),
      house: this.homestead.house ? { ...this.homestead.house } : null,
      project: this.homestead.project ? { ...this.homestead.project, ...this.homestead.projectProgress(), needs: this.homestead.shortfall ?? null } : null,
      smelting: this.homestead.smeltJob ? { secondsLeft: Math.max(0, Math.round((this.homestead.smeltJob.readyAt - system.currentTick) / 20)) } : null,
      players: world.getPlayers().filter((pl) => pl.id !== this.sim.id).map((pl) => pl.name),
      goals: this.goals(),
      biome: (() => { try { return this.lookout.hereName(); } catch { return null; } })(),
      opportunity: this.task?.kind === 'auto' ? this.autoOpportunity : null,
      stepLabel: this.task?.kind === 'auto' ? this.autoLabel ?? null : null,
      setAside: [...this.deferred.values()].filter((d) => d.until > Date.now()).map((d) => d.step),
    };
  }

  /**
   * Drops from a fight we just won, and anything else lying within a few blocks that we can walk
   * to: picked up between jobs so nothing gets left behind.
   */
  async pickUpLoose(gen) {
    const S = this.skills;
    if (this.lootAt) {
      const l = this.lootAt;
      this.lootAt = null;
      if (Date.now() - l.at < 60000 && dist3D(this.sim.location, l) < 24) await S.sweep(gen, l, 6, null, 10);
    }
    let n = 0;
    try { n = this.dim.getEntities({ type: 'minecraft:item', location: this.sim.location, maxDistance: 8 }).length; } catch {}
    if (n) await S.sweep(gen, this.sim.location, 8, null, 8);
  }

  /** The next step of the goal ladder, from what we have right now (inventory is the truth). */
  planStep(inv, tableDist, tableDy, { opportunities = true, dayTime = false } = {}) {
    // Down the mine when night falls: a lit tunnel is as safe as the house, and climbing out to walk
    // home in the dark (then all the way back down in the morning) wastes the night. Keep mining if
    // that's what the day's plan says to do; anything else (home, the farm, the furnace) waits for the
    // usual night plan.
    if (!dayTime && isNight(world.getTimeOfDay()) && this.minedUnderground()) {
      const day = this.planStep(inv, tableDist, tableDy, { opportunities: false, dayTime: true });
      if (['get_iron', 'get_stone'].includes(day.step)) {
        this.sayOnce('mine-night', "It's night, but I'm down the mine: carrying on here.", 600000);
        return day;
      }
    }
    const night = !dayTime && isNight(world.getTimeOfDay());
    /** @type {any} */
    let step = nextStep({ inv, tableDist, tableDy, exposedStoneKnown: this.knownSurfaceStone });
    if (step.step === 'done') step = settleStep({ ...this.settleFacts(inv, tableDist), ...(dayTime ? { time: 6000 } : {}) });
    // Moved in: a farm, iron, iron gear (core/advance.js).
    if (step.step === 'done' && this.homestead.house) step = advanceStep(this.advanceFacts(inv, tableDist));
    // A wandering trader in sight and no lead yet: his two leads (for walking animals and
    // villagers home, into boats) drop when he's gone. Any time of day but night, from the start.
    if (!night && !inv.lead && !['go_home', 'shelter', 'repair_house'].includes(step.step)) {
      const t = this.homestead.animals(new Set(['wandering_trader']), 32)[0];
      if (t) return { step: 'hunt', what: 'trader', near: Math.round(t.d) };
    }
    else if (night) {
      // Night before we're set up: home if we have one, otherwise dig in unless we're armed and healthy.
      const armed = Object.keys(inv).some((id) => /_sword$/.test(id)) && this.health() >= 12;
      if (this.homestead.house) step = { step: 'go_home' };
      else if (!armed) step = { step: 'shelter' };
    }
    // The ladder's step against everything else still needed that's cheap right now.
    if (opportunities && !night) step = chooseStep(step, this.focusFacts(inv));
    return step;
  }

  /** Underground in our quarry or its mine (not just any cave), with a pickaxe to keep going. */
  minedUnderground() {
    try {
      const S = this.skills;
      return Object.keys(invCounts(this.sim)).some((id) => /_pickaxe$/.test(id)) && S.isUnderground() && S.nearQuarry(this.sim.location, 48);
    } catch { return false; }
  }

  /** What core/focus.js weighs: what the goals still need and how far the nearest of each is. */
  focusFacts(inv) {
    const H = this.homestead, pos = this.sim.location, dimId = this.dim.id;
    const now = Date.now();
    for (const [k, d] of this.deferred) if (d.until <= now) this.deferred.delete(k);
    const mem = (cat) => this.memory.list(cat, dimId, pos)[0]?.dist ?? null;
    const sheep = H.animals(new Set(['sheep']), 24)[0]?.d ?? mem('sheep');
    const food = H.animals(FOOD_ANIMALS, 16)[0]?.d ?? null;
    const house = H.house;
    const facts = {
      inv,
      haveFurnace: (inv.furnace ?? 0) > 0 || !!house?.furnace || this.memory.list('furnace', dimId, pos).length > 0,
      house: house ? H.houseState() : null,
      project: !!H.project,
      shortfall: H.project ? H.houseNeeds(H.project, H.project.dir) : null,
      worn: this.worn(),
    };
    return {
      inv,
      need: goalNeeds(facts),
      seen: { sheep, food, log: mem('log'), stone: mem('stone') },
      deferred: this.deferred,
      bedDeferred: (this.bedDeferredUntil ?? 0) > now,
      canMineStone: Object.keys(inv).some((id) => /_pickaxe$/.test(id)),
      early: !Object.keys(inv).some((id) => /^(stone|iron|diamond|netherite)_pickaxe$/.test(id)),
      canHunt: SWORD_OK.test(Object.keys(inv).join(' ')),
    };
  }

  /**
   * One plain description of the step we're on, used for chat and the dashboard alike, so they
   * never disagree ("working on charcoal" in one place, "looking for stone" in another).
   */
  labelFor(step) {
    const aside = step.setAside ? ` (set "${(STEP_WORDS[step.setAside] ?? step.setAside).replace(/_/g, ' ')}" aside for now: it kept failing)` : '';
    const side = step.opportunity && !step.setAside ? ' (right here, so doing it now)' : '';
    switch (step.step) {
      case 'explore': return `looking further out for ${{ log: 'trees', sheep: 'sheep', food: 'animals' }[step.want] ?? 'supplies'}${aside}`;
      case 'gather_logs': return `getting wood: ${step.count} logs${step.wanted && step.wanted[0] !== 'later' ? ` for ${step.wanted.join(', ').replace(/_/g, ' ')}` : ''}${side}${aside}`;
      case 'get_stone': return `getting ${step.need} cobblestone${step.why && step.why !== 'later' ? ` for the ${step.why}` : ''}${side}${aside}`;
      case 'hunt': return `${step.what === 'sheep' ? 'getting wool from sheep' : step.what === 'trader' ? 'taking the wandering trader\'s leads' : 'hunting for food'}${side}${aside}`;
      case 'get_iron': return `mining for iron (${step.need} more${step.why === 'bucket' ? ', for a bucket' : ''})`;
      case 'smelt': return step.input === 'log' ? 'loading the furnace: logs into charcoal' : step.input === 'ore' ? 'loading the furnace: smelting iron' : 'loading the furnace: cooking food';
      case 'craft': return `crafting ${step.items.join(', ').replace(/_/g, ' ')}`;
      default: return (STEP_WORDS[step.step] ?? step.step).replace(/_/g, ' ');
    }
  }

  /** Say (once in a while) why we're doing this now instead of the next thing on the list. */
  sayOpportunity(step) {
    const d = step.near != null ? ` (${step.near} blocks)` : '';
    const text = {
      sheep: `Sheep right here${d}: getting wool for the bed while I'm at it.`,
      food: `Animals right here${d}: getting some food while I'm at it.`,
      log: `A tree right here${d}: getting logs now for later.`,
      stone: `Stone right here${d}: grabbing ${step.need} cobblestone now for later.`,
    }[step.opportunity];
    if (step.setAside) this.sayOnce(`aside:${step.setAside}`, `That isn't working out for now; ${this.labelFor({ ...step, setAside: null, opportunity: null })} meanwhile.`, 60000);
    else if (text) this.sayOnce(`opp:${step.opportunity}`, text, 60000);
  }

  /**
   * Every 2 s while gathering: recount the inventory against the plan. If we already have what
   * we're out getting (picked up, given by a player, crafted), drop it and move on, instead of
   * finishing the search out of habit.
   */
  checkStillNeeded() {
    if (this.task?.kind !== 'auto' || !['gather_logs', 'get_stone', 'hunt'].includes(this.autoStep)) return;
    if (system.currentTick < (this.bonusUntil ?? 0)) return; // taking a few extra for later jobs: let it finish
    // Getting wood for the whole list in one go: not done until that's in, whatever the ladder's step says.
    if (this.stockTarget?.step === this.autoStep && count(invCounts(this.sim), isLog) < this.stockTarget.n) return;
    let step;
    try {
      const inv = invCounts(this.sim);
      if (this.autoOpportunity) {
        // A side job: done when that need's covered (not when the ladder's next step changes).
        const key = { sheep: 'wool', food: 'food', log: 'logs', stone: 'stone' }[this.autoOpportunity];
        if (this.focusFacts(inv).need[key] > 0) return;
        step = { step: 'next' };
      } else {
        const known = this.memory.nearestTable(this.dim.id, this.sim.location);
        step = this.planStep(inv, known ? known.dist : Infinity, known ? known.pos.y - this.sim.location.y : 0, { opportunities: false });
      }
    } catch { return; }
    if (step.step === this.autoStep) return;
    if (CONFIG.debug) console.warn(`[agent] have enough for ${this.autoStep} now; next: ${step.step}`);
    this.sayOnce(`enough:${this.autoStep}`, 'Got what I needed; moving on.', 30000);
    this.startAuto();
  }

  /** What the settle-in plan (core/settle.js) needs to know. */
  /** Armor and shield we have on. */
  worn() {
    const out = [];
    try {
      const eq = this.sim.getComponent('minecraft:equippable');
      for (const slot of [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand]) {
        const it = eq?.getEquipment(slot);
        if (it) out.push(it.typeId.replace('minecraft:', ''));
      }
    } catch {}
    return out;
  }

  /** Put on the armor (and the shield in the off hand) we carry. */
  equipArmor() {
    const eq = this.sim.getComponent('minecraft:equippable');
    const c = container(this.sim);
    if (!eq || !c) return 0;
    const slotFor = { iron_helmet: EquipmentSlot.Head, iron_chestplate: EquipmentSlot.Chest, iron_leggings: EquipmentSlot.Legs, iron_boots: EquipmentSlot.Feet, shield: EquipmentSlot.Offhand };
    let n = 0;
    for (let i = 0; i < c.size; i++) {
      const it = c.getItem(i);
      const id = it?.typeId.replace('minecraft:', '');
      if (!id || !(id in slotFor)) continue;
      try {
        if (eq.getEquipment(slotFor[id])) continue;
        eq.setEquipment(slotFor[id], it.clone());
        c.setItem(i, undefined);
        n++;
      } catch (e) { trace(`equip ${id}: ${e}`); }
    }
    if (n) this.say(`Put on ${n} piece${n > 1 ? 's' : ''} of gear.`);
    return n;
  }

  /** What core/advance.js decides from. */
  advanceFacts(inv, tableDist) {
    const H = this.homestead;
    const job = H.smeltJob;
    const f = this.memory.list('furnace', this.dim.id, this.sim.location)[0];
    return {
      inv, tableDist, worn: this.worn(),
      waterNearHouse: this.memory.data.waterNearHouse ?? null,
      farmBlocked: Date.now() - (this.memory.data.farmFailedAt ?? 0) < 600000,
      underground: (() => { try { return this.skills.isUnderground(); } catch { return false; } })(),
      farm: this.farm.state(),
      smelt: job ? { ready: system.currentTick >= job.readyAt, kind: job.kind, n: job.n ?? 0, dist: dist3D(this.sim.location, job.pos) } : null,
      furnaceDist: f ? f.dist : Infinity,
    };
  }

  settleFacts(inv, tableDist) {
    const H = this.homestead, pos = this.sim.location, dimId = this.dim.id;
    const f = this.memory.list('furnace', dimId, pos)[0];
    const house = H.house;
    const sheepSeen = H.animals(new Set(['sheep'])).length > 0;
    const sheepKnown = this.memory.list('sheep', dimId, pos).some((m) => m.dist < 96);
    return {
      inv, tableDist, time: world.getTimeOfDay(),
      furnace: f ? { dist: f.dist, inHouse: !!house && houseInside(house, f.pos) } : null,
      smelt: H.smeltJob ? { ready: system.currentTick >= H.smeltJob.readyAt, kind: H.smeltJob.kind, dist: dist3D(pos, H.smeltJob.pos) } : null,
      house: house ? { dist: dist3D(pos, house), ...H.houseState() } : null,
      repairShort: house ? H.houseNeeds(house, house.dir) : null,
      sheep: sheepSeen || sheepKnown,
      animals: H.animals(FOOD_ANIMALS, 16).length,
      bedDeferred: (this.bedDeferredUntil ?? 0) > Date.now(),
      armed: SWORD_OK.test(Object.keys(inv).join(' ')),
      project: !!H.project,
      shortfall: H.project ? H.houseNeeds(H.project, H.project.dir, { fittings: true }) : H.shortfall ?? null,
      packFull: H.freeSlots() <= FULL_SLOTS,
      chestFull: Date.now() - (this.memory.data.chestFullAt ?? 0) < 600000,
    };
  }

  resume(task) {
    if (!task) return;
    if (task.kind === 'auto') { if (this.autoEnabled) this.startAuto(); return; }
    if (task.kind === 'surface' || task.kind === 'dig') { this.apply([{ type: task.kind }]); return; }
    if (task.kind === 'goto') this.startGoto(task.target, task.tolerance);
    else if (task.kind === 'follow') { this.newTask(task); this.followTick = 0; }
  }

  fight(target, t) {
    if (!target?.entity?.isValid) return;
    const e = target.entity;
    this.fightTarget = e;
    this.fightLast = { x: e.location.x, y: e.location.y, z: e.location.z };
    const chest = { x: e.location.x, y: e.location.y + 1.0, z: e.location.z };
    this.motor.setFocus(chest);
    const p = this.body.getPos();
    const d = dist3D(p, e.location);
    const melee = MOBS[target.type]?.kind === 'melee';
    const move = spacing(d, melee);
    this.fightMove = move;

    if (move === 'approach' && t >= this.nextRoute) {
      this.nextRoute = t + 6;
      // Walk to the edge of our reach, not onto the mob. Sprint only while it's far.
      let goal = d > HOLD_AT + 0.5 ? standOff(p, target.pos) : target.pos;
      // Skeletons: don't run straight down the arrow line; weave a little.
      if (!melee && d > 6) {
        const side = Math.sin(t / 10) * 2.5;
        const nx = -(goal.z - p.z) / d, nz = (goal.x - p.x) / d;
        goal = { x: goal.x + nx * side, y: goal.y, z: goal.z + nz * side };
      }
      this.routeTo(goal, 0.5, d > 7, 1500);
    } else if (move === 'back' && t >= this.nextRoute) {
      this.nextRoute = t + 8; // head stays on the mob (focus): this is a backpedal, not a turn
      this.routeTo(standOff(p, target.pos, HOLD_AT + 0.3), 0.4, false, 600);
    } else if (move === 'hold' && this.motor.busy) {
      this.motor.stop();
    }

    if (d <= REACH_HIT && t >= this.nextSwing && this.facing(chest, 25)) {
      try { this.sim.attackEntity(e); } catch {}
      this.nextSwing = t + 10 + Math.floor(this.rng() * 4);
    }
  }

  /** Every tick while fighting: stop walking in the moment we're at striking distance. */
  fightSpacingTick() {
    const e = this.fightTarget;
    if (this.mode !== 'fight' || this.fightMove !== 'approach' || !e?.isValid || !this.motor.busy) return;
    if (dist3D(this.body.getPos(), e.location) <= STOP_AT) { this.motor.stop(); this.fightMove = 'hold'; }
  }

  /**
   * Run to the reachable spot farthest from the threats (searched over where we can actually walk,
   * not a point on a map that might be through a cave wall). If nowhere is much safer than here,
   * we're cornered: stand and fight instead of freezing in a dead end.
   */
  flee(threats, t) {
    this.motor.setFocus(null);
    if ((t < this.nextRoute && this.motor.busy) || this.findingRefuge) return;
    this.nextRoute = t + 20;
    this.findingRefuge = true;
    const gen = this.taskGen;
    const me = this.body.getPos();
    const here = refugeScore(me, threats, 0);
    let best = null, bestScore = here;
    const probe = (x, y, z, w) => {
      if (!w.standable(x, y, z)) return false;
      const sc = refugeScore({ x: x + 0.5, y, z: z + 0.5 }, threats, Math.hypot(x - me.x, z - me.z));
      if (sc > bestScore) { bestScore = sc; best = { x, y, z }; }
      return false;
    };
    this.plan(me, me, 0, 2500, probe).then((res) => {
      this.findingRefuge = false;
      if (gen !== this.taskGen || this.mode !== 'flee') return;
      if (!best || bestScore < here + 3) {
        this.corneredUntil = system.currentTick + 200; // 10 s: fight back
        if (CONFIG.debug && !(this.corneredSaid > system.currentTick - 200)) console.warn(`[agent] cornered (safest reachable spot ${(bestScore - here).toFixed(1)} better than here)`);
        this.corneredSaid = system.currentTick;
        return;
      }
      this.routeTo({ x: best.x + 0.5, y: best.y, z: best.z + 0.5 }, 1, true, 3000);
      void res;
    }).catch(() => { this.findingRefuge = false; });
  }

  facing(point, tolDeg) {
    const r = this.sim.getRotation();
    const eye = this.sim.getHeadLocation();
    const yaw = Math.atan2(-(point.x - eye.x), point.z - eye.z) * 180 / Math.PI;
    const dy = Math.abs(((yaw - r.y + 540) % 360) - 180);
    return dy < tolDeg;
  }

  /** Plan and start walking, replacing any current path without a stop. */
  async routeTo(goal, tolerance, urgent, maxNodes) {
    const gen = this.taskGen;
    const res = await this.plan(this.body.getPos(), goal, tolerance, maxNodes);
    if (gen !== this.taskGen || res.path.length < 2) return;
    this.motor.followPath(smoothPath(makeClassifier(this.dim), res.path), { seamless: true, urgent });
  }

  // ---------- brain link ----------

  snapshot() {
    const p = this.body.getPos();
    return {
      bot: this.sim.name,
      pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      dimension: this.dim.id.replace('minecraft:', ''),
      health: this.health(),
      time: world.getTimeOfDay(),
      task: this.task ? this.task.kind : 'idle',
      weapon_damage: this.damage,
    };
  }

  async emit(type, data = {}) {
    const res = await sendEvent({ type, state: this.snapshot(), ...data });
    if (res?.actions) this.apply(res.actions);
    return res;
  }

  async chat(text, senderName) {
    await this.emit('chat', { text, sender: senderName, bot: this.sim.name });
  }

  async command(text, senderName) {
    const res = await this.emit('command', { text, sender: senderName });
    if (!res) this.apply(parseLocal(text, senderName)); // brain offline
  }

  apply(actions) {
    for (const a of actions) {
      // While fighting or fleeing, new orders wait until it's safe.
      if (this.mode !== 'none' && ['goto', 'come', 'follow'].includes(a.type)) {
        this.suspended = this.orderToTask(a) ?? this.suspended;
        this.say("Busy staying alive, I'll do that next.");
        continue;
      }
      switch (a.type) {
        case 'say': this.say(a.text); break;
        case 'stop':
          this.newTask(null); this.suspended = null; this.motor.stop();
          if (this.autoEnabled) { this.autoEnabled = false; this.say('Stopped. Say "!bot auto" to let me carry on by myself.'); }
          break;
        case 'auto':
          this.autoEnabled = a.on !== false;
          if (this.autoEnabled) { this.autoDone = false; this.nextAutoTry = 0; }
          else if (this.task?.kind === 'auto') { this.newTask(null); this.motor.stop(); }
          this.say(this.autoEnabled ? 'Carrying on by myself.' : 'Waiting for orders.');
          break;
        case 'goto': this.startGoto(this.resolveY(a), a.tolerance ?? 0); break;
        case 'come': {
          const p = this.findPlayer(a.player);
          if (!p) { this.say(`I can't find ${a.player}.`); break; }
          this.startGoto(p.location, 2);
          break;
        }
        case 'follow': {
          if (!this.findPlayer(a.player)) { this.say(`I can't find ${a.player}.`); break; }
          this.newTask({ kind: 'follow', player: a.player });
          this.followTick = 0;
          break;
        }
        case 'look_at': this.motor.lookAt({ x: a.x, y: a.y, z: a.z }); break;
        case 'surface': {
          const gen = this.newTask({ kind: 'surface' });
          this.skills.toSurface(gen)
            .then((ok) => { if (gen === this.taskGen) { if (!ok) this.say("Couldn't get up from here."); this.newTask(null); } })
            .catch((e) => { if (!(e instanceof Aborted)) console.error(`[agent] surface: ${e}`); });
          break;
        }
        case 'memory': this.sayWhere(); break;
        case 'dig': {
          const gen = this.newTask({ kind: 'dig' });
          const have = () => Object.entries(invCounts(this.sim)).filter(([id]) => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(id)).reduce((n, [, c]) => n + c, 0);
          this.skills.digStairs(gen, have() + (a.count ?? 8))
            .then((ok) => { if (gen === this.taskGen) { this.say(ok ? 'Got the stone.' : "Couldn't dig down here."); this.newTask(null); } })
            .catch((e) => { if (!(e instanceof Aborted)) console.error(`[agent] dig: ${e}`); });
          break;
        }
        case 'flee': break; // survival reflexes are handled in-game now
        default: console.warn(`[agent] unknown action ${JSON.stringify(a)}`);
      }
    }
  }

  orderToTask(a) {
    if (a.type === 'goto') return { kind: 'goto', target: this.resolveY(a), tolerance: a.tolerance ?? 0 };
    if (a.type === 'follow') return { kind: 'follow', player: a.player };
    if (a.type === 'come') {
      const p = this.findPlayer(a.player);
      return p ? { kind: 'goto', target: { ...p.location }, tolerance: 2 } : null;
    }
    return null;
  }

  // ---------- tasks ----------

  newTask(task) {
    // Trace who ends or replaces the auto job (an unexplained stop showed up as "idle" gaps).
    if (this.task?.kind === 'auto' && task?.kind !== 'auto') {
      const where = String(new Error().stack ?? '').split('\n').slice(2, 4).map((l) => l.trim().replace(/^at /, '')).join(' < ');
      trace(`task: auto -> ${task?.kind ?? 'none'} (${where})`);
    }
    this.task = task;
    return ++this.taskGen;
  }

  findPlayer(name) {
    return world.getPlayers().find((p) => p.name.toLowerCase() === String(name).toLowerCase());
  }

  resolveY(a) {
    if (Number.isFinite(a.y)) return { x: a.x, y: a.y, z: a.z };
    try {
      const top = this.dim.getTopmostBlock({ x: a.x, z: a.z });
      if (top) {
        // The ground, not the top of a tree, a roof or a glass sky cover. Water: swim at the surface.
        const g = top.isLiquid ? -Infinity : this.skills.groundTop(Math.floor(a.x), Math.floor(a.z));
        return { x: a.x, y: (Number.isFinite(g) ? g : top.location.y) + 1, z: a.z };
      }
    } catch {}
    return { x: a.x, y: this.body.getPos().y, z: a.z };
  }

  startGoto(target, tolerance) {
    const gen = this.newTask({ kind: 'goto', target, tolerance });
    this.runGoto(gen, target, tolerance).catch((e) => console.error(`[agent] goto failed: ${e}\n${e.stack}`));
  }

  async runGoto(gen, target, tolerance) {
    let replans = 0, climbed = false;
    for (let seg = 0; seg < CONFIG.maxSegments; seg++) {
      if (gen !== this.taskGen) return;
      const from = this.body.getPos();
      const res = await this.plan(from, target, tolerance);
      if (gen !== this.taskGen) return;
      if (CONFIG.debug) {
        const end = res.path[res.path.length - 1];
        console.warn(`[agent] plan seg ${seg}: from ${from.x.toFixed(1)} ${from.y.toFixed(1)} ${from.z.toFixed(1)} to ${target.x} ${target.y} ${target.z} -> ${res.complete ? 'complete' : 'partial'}, ${res.path.length} nodes, ${res.expanded} expanded, ends ${end.x} ${end.y} ${end.z}`);
      }
      if (res.path.length < 2 || (!res.complete && seg === 0 && res.path.length < 4)) {
        if (res.complete) break; // already there
        // Can't get anywhere from here: probably in a hole or a cave. Climb out, then try again.
        if (!climbed && (await this.skills.needsEscape(gen).catch(() => false))) {
          climbed = true;
          if (await this.skills.toSurface(gen).catch(() => false)) { seg--; continue; }
        }
        if (gen !== this.taskGen) return;
        this.newTask(null);
        const p = this.body.getPos();
        this.say(seg === 0
          ? "I can't find a way there."
          : `Got as close as I can (${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}); no walkable route further yet.`);
        this.emit('goto_failed', { target, at: p });
        return;
      }
      const wps = smoothPath(makeClassifier(this.dim), res.path);
      const r = await this.motor.followPath(wps);
      if (gen !== this.taskGen || r.status === 'cancelled') return;
      if (r.status === 'stuck') {
        if (++replans > CONFIG.maxReplans) {
          this.newTask(null);
          this.emit('stuck', { target, at: r.at });
          return;
        }
        continue; // replan from where we are
      }
      replans = 0;
      if (res.complete) break; // otherwise it was a partial segment: plan the next one
    }
    if (gen !== this.taskGen) return;
    this.newTask(null);
    this.emit('task_done', { task: 'goto', target });
  }

  plan(from, to, tolerance, maxNodes = CONFIG.maxPathNodes, goalTest = null, extra = {}) {
    return new Promise((resolve) => {
      const base = makeClassifier(this.dim);
      const now = Date.now(), bad = this.badCells;
      // Places we got physically stuck at recently count as walls, so we don't try them again.
      const classify = bad.size ? (x, y, z) => ((bad.get(`${x},${y},${z}`) ?? 0) > now ? Cell.DANGER : base(x, y, z)) : base;
      const t0 = system.currentTick;
      const job = function* () {
        const r = yield* searchJob(classify, from, to, { tolerance, maxNodes, goalTest, ...extra });
        const ticks = system.currentTick - t0;
        if (ticks > 40) trace(`slow plan: ${ticks} ticks, ${r.expanded} nodes, ${r.complete ? 'complete' : 'partial'}${goalTest ? ' (search)' : ''}${extra.actions ? ' (actions)' : ''}`);
        resolve(r);
      };
      system.runJob(job()); // spreads the search over ticks so the server never hitches
    });
  }

  async updateFollow() {
    const p = this.findPlayer(this.task.player);
    if (!p) { this.say(`Lost ${this.task.player}.`); this.newTask(null); return; }
    const gen = this.taskGen;
    const d = dist3D(this.body.getPos(), p.location);
    if (d <= CONFIG.followDistance + 0.5) {
      if (this.motor.busy) this.motor.stop();
      this.motor.glanceAt(p.getHeadLocation(), CONFIG.followRepathTicks + 5);
      return;
    }
    const res = await this.plan(this.body.getPos(), p.location, CONFIG.followDistance);
    if (gen !== this.taskGen || res.path.length < 2) return;
    this.motor.followPath(smoothPath(makeClassifier(this.dim), res.path), { seamless: true });
  }
}
