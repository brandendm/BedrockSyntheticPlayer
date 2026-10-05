// One agent = one SimulatedPlayer + motor + task state.
// Everything time-critical (movement, survival reflexes) runs locally every few ticks for free;
// the brain is only consulted on events (commands, stuck, task done, combat reports).
import { passRates, avgRates } from '../core/testrun.js';
import { system, world, EntityComponentTypes, Direction, EquipmentSlot, ItemStack } from '@minecraft/server';
import { MotorController, EYE_HEIGHT } from '../core/motor.js';
import { Calibration } from './calibrate.js';
import { searchJob, smoothPath, findPath, Cell, DEFAULT_COSTS } from '../core/pathfinder.js';
import { dist3D, makeRng } from '../core/mathutil.js';
import { decide, fleePoint, weaponDamage, MOBS, REACH_HIT, STOP_AT, BOW_MIN, crowdOf } from '../core/threat.js';
import { fleeJabOrder, avoidCreepers, towerWorth, TOWER_H, fightMove, creeperFight, creeperMove, Stalemate, pickRefuge, bestWeapon, barricadeCells, SPEAR_DAMAGE, weaponReach, pickCreeperSwing, creeperWeapon, isSpear, awayPath, knockbackRoom, blockOffCells, guardCell, fleeJab, killSlotCells, killSlotWorth, pinchWallCells, alcoveCells, dodgeArrow, CREEPER_LIGHT, CREEPER_CALM, creeperPlan, awayPathFrom } from '../core/tactics.js';
import { nextStep, STONE_TARGETS, TOOL_STONE, count, isLog, isPlanks } from '../core/recipes.js';
import { settleStep, foodCount, FOOD_GOAL, isNight, chooseFood } from '../core/settle.js';
import { shouldRest, canHeal, REST_BELOW, REST_MAX_S } from '../core/rest.js';
import { goalChain } from '../core/goals.js';
import { advanceStep, orderedAdvance, advanceProgress, ironHave, IRON_GOAL } from '../core/advance.js';
import { Farm } from './farm.js';
import { Flight } from './flight.js';
import { PathLog } from './pathlog.js';
import { invDiff } from '../core/flight.js';
import { Demo } from './demo.js';
import { adopt as adoptProfile, DEFAULTS as PROFILE_DEFAULTS } from '../core/profile.js';
import { chooseStep, needs as goalNeeds, stepKey } from '../core/focus.js';
import { inside as houseInside } from '../core/house.js';
import { mlgNow, ticksToLand } from '../core/fall.js';
import { GOALS, goalsOf, goalKey, orderOf, parseOrder } from '../core/toggles.js';
import { biomeName } from '../core/biomes.js';
import { chainStep, chainItem, chainOutline, held } from '../core/chain.js';
import { Horses } from './horse.js';
import { LeadTow } from './leadtow.js';
import { Boating } from './boating.js';
import { waterReflex, airFloor, ownsWater } from '../core/water.js';
import { TowLearn } from './towlearn.js';
import { Portals } from './portal.js';
import { FULL_SLOTS } from '../core/storage.js';
import { itemValue, armorUpgrades, armorTotal } from '../core/wants.js';
import { lootPlan, lootWorth, backoffMs, LOOT_WINDOW_MS } from '../core/loot.js';
import { Homestead, FOOD_ANIMALS } from './homestead.js';
import { Villages } from './villages.js';
import { Lookout } from './lookout.js';
import { Skills, Aborted, markVisited } from './skills.js';
import { shootAt } from './aim.js';
import { invCounts, hold, container, usesLeft, kitOf, emptyHanded, restoreKit } from './inventory.js';
import { WorldMemory } from './memory.js';
import { SimBodyAdapter } from './body.js';
import { makeClassifier, canSee, isWatery, OPENABLE } from './world.js';
import { sendEvent, trace, fetchProfile, fetchSettings, tracePosition } from './bridge.js';
import { parseLocal } from './localCommands.js';
import { CONFIG } from '../config.js';
import { locate } from './locate.js';
import { isWorkPickaxe } from '../core/costs.js';

/** Steps done down the mine (the camp's furnace and table too): night doesn't send us home from them. */
const MINE_STEPS = new Set(['get_iron', 'get_stone', 'smelt', 'collect_smelt', 'craft', 'equip']);
// Steps done inside the house (at its table, furnaces and chests): fine after dark, before bed.
const INDOOR_STEPS = new Set(['craft', 'furnish', 'store', 'smelt', 'collect_smelt', 'equip']);
// Steps that are the bot's home and its things: a way there walled off by anything breakable (a
// player's build, a chest, junk) gets broken through rather than given up on.
const ESSENTIAL_STEPS = new Set(['go_home', 'clear_house', 'fight_fire', 'repair_house', 'furnish', 'store', 'smelt', 'collect_smelt', 'wait_smelt', 'goto_table', 'light_outside', 'shelter']);
const SURVIVE_EVERY = 4;          // ticks between threat checks (0.2 s reaction time)
const BAD_BESIDE = /lava|magma|fire|cactus|campfire|powder_snow/; // beside where we take a creeper blast on the shield (game/agent.js crowdSafe)
const ENDERMAN_SCAN_EVERY = 20;
const CALM_TICKS_TO_RESUME = 40;  // threats gone this long -> resume the interrupted task
const ATTACKER_MEMORY_TICKS = 200;
const ESCORT_MEMORY_TICKS = 400; // a mob that hit the player we follow, or that they hit: ours to fight for 20 s

/** A sword worth hunting with: stone or better (a wooden one or a fist wastes the time). */
const SWORD_OK = /\b(stone|iron|diamond|netherite)_sword\b/;
const key3 = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

const STEP_WORDS = {
  gather_logs: 'getting wood', get_stone: 'getting cobblestone', place_table: 'placing a crafting table', goto_table: 'walking to the crafting table',
  hunt: 'hunting', smelt: 'the furnace job', collect_smelt: 'collecting from the furnace', wait_smelt: 'waiting on the furnace',
  plan_house: 'picking a spot for the house', build_house: 'building the house', repair_house: 'repairing the house', furnish: 'moving things into the house', light_outside: 'putting torches up by the door',
  check_water: 'looking for water to farm by', make_farm: 'making a wheat farm', tend_farm: 'harvesting and replanting wheat', get_iron: 'mining for iron', equip: 'putting on armor',
  store: 'putting things away in the chest',
  rest: 'hurt: resting till I\'ve healed', go_home: 'night: going home to sleep', shelter: 'night: holed up until morning', clear_house: 'clearing what\'s in the way in the house', fight_fire: 'putting out a fire at the house', done: 'all goals done', blocked: 'stuck on a recipe',
};

export class Agent {
  constructor(sim) {
    this.sim = sim;
    this.rng = makeRng();
    this.body = new SimBodyAdapter(sim);
    this.motor = new MotorController(this.body, {}, this.rng);
    this.pathLog = new PathLog(); // (every search and every walk, numbers: game/pathlog.js)
    { // each walk the motor is given, and how it ended
      const fp = this.motor.followPath.bind(this.motor);
      this.motor.followPath = (wps, opts) => {
        const t0 = system.currentTick, from = this.sim.location;
        const p = fp(wps, opts);
        try { p.then((result) => { try { this.pathLog.walk({ wps, result, ticks: system.currentTick - t0, from, end: this.sim.location }); } catch { /* */ } }); } catch { /* */ }
        return p;
      };
    }
    this.task = null;        // {kind, ...} - what the agent is doing right now
    this.taskGen = 0;        // bumps on every new task so stale async loops exit
    this.followTick = 0;

    // survival state
    this.mode = 'none';      // none | fight | flee
    this.suspended = null;   // task interrupted by a fight/flight, resumed when calm
    /** @type {{x: number, z: number, at: number} | null} where the last long walk was heading (a flight leans toward it) */
    this.travelGoal = null;
    this.calmSince = 0;
    this.attackers = new Map(); // entity id -> tick it last hurt us
    this.escort = new Map(); // following a player: entity id -> tick it hit them or they hit it
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
    this.villages = new Villages(this);
    this.horses = new Horses(this);
    this.tow = new LeadTow(this);
    this.boating = new Boating(this);
    this.towlearn = new TowLearn(this);
    this.portal = new Portals(this);
    /** @type {Set<string>} Far places already looked at for a village (game/villages.js scout). */
    this.villageScouted = new Set();
    tracePosition(() => this.sim.location); // (villages seen from afar: game/villages.js)
    system.runTimeout(() => { this.restoreSettings().catch(() => {}); }, 30);
    system.runTimeout(() => { try { this.restoreKit(); } catch (e) { this.kitChecked = true; console.warn(`[agent] kit: ${e}`); } try { this.restoreState(); } catch {} }, 40);
    this.badCells = new Map();   // "x,y,z" -> until (ms): cells we got stuck walking into
    this.deferred = new Map();   // stepKey -> {until (ms), step}: ladder steps that kept failing, set aside (core/focus.js)
    this.autoOpportunity = null; // the kind of side job we're on (sheep, food, log, stone), if any
    this.bonusUntil = 0;         // tick: taking extra for later jobs until then (checkStillNeeded waits)
    this.stuckOnce = new Map();  // first time we got stuck at a cell
    this.lastSeen = new Map();   // mob id -> tick we last saw it
    this.reachCache = new Map(); // mob id -> { ok, t, pending }: can it walk to us?
    this.stale = new Stalemate(120); // a fight going nowhere (the skeleton up at the quarry's mouth)
    this.giveUp = new Map();     // mob id -> tick until which we count it as out of reach
    this.creeperSt = new Map();  // creeper id -> { phase, since, retreat }: the hit-and-back-off dance
    this.roomCache = new Map();  // creeper id -> { ok, t, pending }: room to back off from it?
    this.shield = false;         // a shield in the off hand
    this.resting = false;        // a bout of resting to heal is under way (core/rest.js, homestead.restUp)
    this.restStart = 0;
    this.restCoolUntil = 0;
    this.blocking = false;       // crouched behind it right now
    this.pickingUp = false;      // the job is out collecting dropped things (no restarting it for more)
    this.lootTriggerAt = -1e9;   // last time a valuable drop nearby restarted the job
    /** @type {Map<string, number>} restarts each dropped item has caused */
    this.lootTries = new Map();
    /** @type {Array<any>} older death spots still to visit (died again on the way back) */
    this.deathQueue = [];
    this.testHold = false;       // a calibration test is driving: no fighting or running of our own
    this.swell = new Map();      // creeper id -> { still, t, since }: is it standing still, swelling?
    this.miningTrip = false;     // down the mine for iron since the plan last had us elsewhere
    this.fleeJabSt = new Map();  // mob id -> distance history, to tell who is catching up while we run
    this.jabbing = false;        // turned to jab something catching up
    this.fleeThreats = null;     // what we are running from
    this.dodgeUntil = 0;         // stepping out of an arrow's way until this tick
    this.breaking = false;       // a block breaking under the hand (the step profile)
    this.planning = 0;           // path searches running
    this.prof = null;            // the step profile being counted
    this.fallFrom = null;        // the highest our feet got since we left the ground
    /** @type {{x:number,y:number,z:number}|null} */
    this.fallLast = null;        // where we were last tick (a jump further than a fall: respawned, teleported)
    this.mlg = null;             // water we put down to break a fall: { t, cell, d, done }
    this.slot = null;            // a kill slot we put up: { cells, slot, stand, dir, block }
    this.threatsNow = [];        // the last survive() pass's threats
    /** @type {any} */
    this.perf = null;            // tick timings (notePerf)
    this.hunting = false;        // homestead.hunt is steering the head
    this.trail = [];             // recent positions, newest last: {x, y, z, under}
    this.demo = new Demo(this); // (watching the player play, only when switched on: !bot learn on)
    this.profile = { params: { ...PROFILE_DEFAULTS }, notes: [], at: 0 }; // (what it has learned from them: core/profile.js)
    this.flight = new Flight(this); // (what it was doing, dumped when something goes wrong: game/flight.js)
    this.calibration = new Calibration(this); // (the head height at once, the rest from the auto loop)
    const follow = this.motor.followPath.bind(this.motor);
    this.motor.followPath = async (wps, opts) => {
      const r = await follow(wps, opts);
      if (r.status === 'stuck') this.noteStuck(r, wps);
      return r;
    };
    this.autoEnabled = true;
    this.autoDone = false;
    this.nextAutoTry = 0;
    this.arenaHook = null;       // a test arena is running (game/arena.js): its rules for deaths, kit and who to fight
    this.kitHeld = false;        // the iron farm build (game/farmbuild.js) has its own things in the pack: do not save them as ours
    this.knownSurfaceStone = null;
    this.waterIdle = 0;
    this.ownWaterSince = null; this.ownWaterSaid = false; // (core/water.js: when a job of its own first got wet)
  }

  get dim() {
    return this.sim.dimension;
  }

  /** Is the bot's running commentary said in the game's chat? (`!bot chat on|off`; off by default: it's all on the dashboard either way.) */
  chatOn() { return this.memory.data.settings?.chat ?? CONFIG.chat ?? false; }
  setSetting(key, on) { this.memory.data.settings = { ...(this.memory.data.settings ?? {}), [key]: !!on }; this.memory.save(); this.keepSetting(key, on); }

  /** Kept on this computer by the brain (brain/settings.json), so the next world starts with the same goals on and off. */
  keepSetting(key, on) { sendEvent({ type: 'setting', key, on: !!on }).catch(() => {}); }

  /**
   * At spawn: the settings the brain kept from before (goal toggles, chat) go back on, over a new world's defaults.
   * Whatever's switched after that is the live choice (and kept in turn).
   */
  async restoreSettings(tries = 0) {
    const kept = await fetchSettings();
    if (kept === null) { if (tries < 6) system.runTimeout(() => { this.restoreSettings(tries + 1).catch(() => {}); }, 200); return 0; } // (the brain isn't up yet: try again in 10 s)
    if (!Object.keys(kept).length) {
      // Nothing kept yet: what this world has is kept, so the next one starts the same.
      for (const [k, v] of Object.entries(this.memory.data.settings ?? {})) this.keepSetting(k, !!v);
      return 0;
    }
    this.memory.data.settings = { ...(this.memory.data.settings ?? {}), ...kept };
    this.memory.save();
    this.autoDone = false; this.nextAutoTry = 0;
    const off = Object.entries(kept).filter(([, v]) => !v).map(([k]) => k);
    trace(`settings: restored from the brain: ${Object.entries(kept).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(' ')}`);
    this.sayOnce('settings-restored', `Your saved settings are back${off.length ? ` (off: ${off.join(', ')})` : ''}.`, 600000);
    return Object.keys(kept).length;
  }

  /** Say something: always to the log and the dashboard; in the game's chat only if chat is on (or `force`: the answer to something you asked). */
  say(text, force = false) {
    console.warn(`[agent] <${this.sim.name}> ${text}`);
    this.flight?.note('say', text);
    sendEvent({ type: 'log', text, state: this.snapshot() }).catch(() => {}); // brain/logs/events.jsonl, the dashboard
    if (!force && !this.chatOn()) return;
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
    this.deathCount = (this.deathCount ?? 0) + 1;
    // In a test arena: the arena decides (back to the start with the kit); no loot run, no kit forgotten.
    if (this.arenaHook) {
      this.fallFrom = null; this.mlg = null;
      this.arenaHook.onDeath?.();
      this.newTask(null); this.suspended = null; this.endCombat();
      this.emit('died');
      return;
    }
    try { this.flight.dump(`died (mode ${this.mode}, step ${this.autoStep ?? '-'})`); } catch { /* a report never stops the respawn */ }
    // Everything we carried is on the ground here for 5 minutes: go back for it after respawning.
    const p = this.body.getPos();
    // What was on us (the pack as last saved): gear is worth going back for through the night.
    let worth = 0;
    try { const k = this.memory.data.kit; worth = lootWorth([...(k?.slots ?? []).map(([, d]) => d.id), ...Object.values(k?.worn ?? {}).map((d) => d.id)]); } catch {}
    // Died again on the way back (with nothing on us): the first pile is still lying there, keep it.
    const old = this.deathSpot;
    if (old && Date.now() - old.at < LOOT_WINDOW_MS) (this.deathQueue ??= []).push(old);
    this.deathSpot = { x: p.x, y: p.y, z: p.z, d: this.dim.id, at: Date.now(), worth };
    this.memory.data.kit = null; // it's all on the ground now (and gone back for): nothing to put back
    this.fallFrom = null; this.mlg = null; // (no fall carried over to the respawn)
    this.saveState();
    this.newTask(null);
    this.suspended = null;
    this.endCombat();
    this.emit('died');
  }

  /**
   * Following a player, something else got hurt: a mob that hit them, or one they hit, is marked
   * (for ESCORT_MEMORY_TICKS) as one we fight too (escortMobs). Called from main.js on entityHurt.
   */
  onEscortHurt(victim, attacker) {
    if (this.task?.kind !== 'follow' || !victim || !attacker) return;
    const name = String(this.task.player).toLowerCase();
    const isPlayer = (e) => e.typeId === 'minecraft:player' && String(e.name).toLowerCase() === name;
    const t = system.currentTick;
    if (isPlayer(victim) && attacker.id !== this.sim.id) this.escort.set(attacker.id, t);
    else if (isPlayer(attacker) && victim.typeId !== 'minecraft:player') this.escort.set(victim.id, t);
  }

  /**
   * Following a player: only what's fighting us or them, what they're fighting, and a creeper
   * getting close to either of us (6). The rest is left alone, however hostile: the player's
   * choice whether to take it on, and chasing after it loses them.
   */
  escortMobs(mobs, t) {
    const p = this.findPlayer(this.task.player);
    const pl = p?.location;
    const marks = this.escort;
    for (const [id, at] of marks) if (t - at > ESCORT_MEMORY_TICKS) marks.delete(id);
    // (One of theirs counts as after us: an enderman they hit is a fight, not a neutral bystander.)
    return mobs.filter((m) => m.attackedMe || marks.has(m.id) ||
      (m.type === 'creeper' && (m.dist <= 6 || m.lit || (pl && dist3D(pl, m.pos) <= 6))))
      .map((m) => (marks.has(m.id) ? { ...m, targetingMe: true } : m));
  }

  /**
   * On fire (a ghast's fireball, a burning mob, lava's edge): the u200 run stood in the fire it was set alight by and lost 4 of its last hearts to
   * it without once moving. Water within a dozen blocks puts it out (stepped into); else away from the fire blocks, fast, and out of the grass that
   * is burning. Returns true while that is what it is doing.
   */
  burnTick(t) {
    let ticks = 0;
    try { ticks = this.sim.getComponent('minecraft:onfire')?.onFireTicksRemaining ?? 0; } catch { /* not burning */ }
    if (ticks <= 0 && !(this.burnUntil > t)) { if (this.task?.kind === 'burn') { this.newTask(null); this.motor.stop(); } return false; }
    if (this.task?.kind === 'burn' || (this.burnRunAt ?? 0) > t - 30) return this.task?.kind === 'burn';
    if (ticks <= 0) return false;
    this.burnRunAt = t;
    if (!['fight', 'flee', 'swim_out', 'burn'].includes(this.task?.kind)) this.suspended = this.task ?? this.suspended;
    const gen = this.newTask({ kind: 'burn' });
    this.motor.stop();
    this.say('On fire: putting it out.');
    trace(`burning (${ticks} ticks): looking for water or getting clear of the fire; was ${this.suspended?.kind ?? '-'} / ${this.autoStep ?? '-'}`);
    (async () => {
      const S = this.skills;
      const here = this.sim.location;
      const water = (await S.scan((id) => id === 'water', { radius: 12, below: 4, above: 3, limit: 4 }).catch(() => []))
        .filter((b) => /air/.test(S.blockAt({ x: b.x, y: b.y + 1, z: b.z }) ?? 'air')).sort((p, q) => dist3D(here, p) - dist3D(here, q))[0];
      if (water) { await S.goNear(gen, { x: water.x + 0.5, y: water.y, z: water.z + 0.5 }, 0.6, 2).catch(() => false); S.check(gen); await S.wait(gen, 20); return; }
      // No water near: away from the fire, 8 blocks on the side with none, sprinting.
      const fires = (await S.scan((id) => /^fire$|^soul_fire$|lava/.test(id), { radius: 7, below: 3, above: 3, limit: 12 }).catch(() => []));
      let dx = 0, dz = 0;
      for (const f of fires) { dx += here.x - f.x; dz += here.z - f.z; }
      const len = Math.hypot(dx, dz) || 1;
      const to = fires.length ? { x: here.x + (dx / len) * 8, y: here.y, z: here.z + (dz / len) * 8 } : { x: here.x + 6, y: here.y, z: here.z };
      const top = S.groundTop(Math.floor(to.x), Math.floor(to.z));
      await S.goNear(gen, { x: to.x, y: Number.isFinite(top) ? top + 1 : to.y, z: to.z }, 2, 1).catch(() => false);
      S.check(gen);
      await S.wait(gen, 40);
    })().catch(() => {}).finally(() => { if (gen === this.taskGen) { this.newTask(null); this.motor.stop(); this.calmSince = system.currentTick; } });
    return true;
  }

  /** Called from main.js on entityHurt where we're the victim. */
  onHurt(attacker, cause = '', amount = 0) {
    if (attacker && attacker.id !== this.sim.id) this.attackers.set(attacker.id, system.currentTick);
    // For the combat log (brain/logs/trace.jsonl): what hit us, how hard, from how far.
    let who = '', d = '';
    try { who = attacker ? attacker.typeId.replace('minecraft:', '') : ''; d = attacker ? dist3D(this.body.getPos(), attacker.location).toFixed(2) : ''; } catch {}
    if (/fire|lava|burn/i.test(String(cause))) this.burnUntil = system.currentTick + 60;
    this.flight.note('hurt', `${cause}${who ? ` by ${who}` : ''} ${Number(amount).toFixed(1)}${d ? ` at ${d}` : ''}, hp ${this.health()}, mode ${this.mode}`);
    trace(`hurt: ${cause}${who ? ` by ${who}` : ''} ${Number(amount).toFixed(1)}${d ? ` at ${d}` : ''}, hp ${this.health()}, mode ${this.mode}, blocking ${this.blocking}`);
  }

  // ---------- main loop ----------

  tick() {
    if (!this.sim.isValid) return;
    const t = system.currentTick;
    this.flight.tick(t);
    this.pathLog.flush(t);
    this.demo.tick(t);
    if (t % 6000 === 100) this.refreshProfile();
    if (t % SURVIVE_EVERY === 0) this.survive(t);
    if (t % ENDERMAN_SCAN_EVERY === 0) this.watchEndermen();
    if (t % 40 === 0) this.equipBestWeapon();
    if (t % 200 === 150 && this.kitChecked) this.saveKit(); // (not before the saved one's been put back)
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
    this.fleeJabTick(t);
    this.dodgeTick(t);
    this.fallTick(t);
    this.profileTick();
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
    if (t % 200 === 100 && this.mode === 'none' && !this.task && !this.checkingTrap && !this.arenaHook && !this.sim.isInWater) this.checkIdleTrapped(); // (not in water: a pool or a tank is not a hole to climb out of)
    if (t % 40 === 20 && this.mode === 'none') this.checkStillNeeded();
    // Dusk: drop whatever daytime job is running so the plan can send us home.
    if (t % 100 === 50) {
      const night = isNight(world.getTimeOfDay());
      const mining = MINE_STEPS.has(this.autoStep) && (this.minedUnderground() || this.onMiningTrip());
      if (night && !this.wasNight) trace(`dusk: step ${this.autoStep}, in the mine ${mining} (underground ${this.minedUnderground()}, trip ${this.onMiningTrip()})`);
      if (night && !this.wasNight && this.task?.kind === 'auto' && !['go_home', 'shelter', 'build_house'].includes(this.autoStep) && !this.workNights(invCounts(this.sim))) this.startAuto();
      this.wasNight = night;
    }
    // Something well worth having dropped near us (armor, a better sword: a player's gift, a mob's
    // drop): drop the job and get it (the auto loop picks things up first). Armor in the pack
    // that beats what's worn goes on.
    // (Not while the job is already out picking things up, and not more than once in ten seconds: a
    // restart every two seconds meant it never got there, and each one used up a try at getting our
    // own gear back. The same item that's had three restarts is left to the ordinary pickup.)
    if (t % 5 === 2 && this.towlearn.on) { try { this.towlearn.sample(t); } catch { /* watching never breaks the tick */ } }
    if (t % 4 === 1) { try { this.skills.heldSweep(); } catch { /* a stale hand is cosmetic */ } }
    if (t % 40 === 10 && this.mode === 'none' && this.autoEnabled && (this.task?.kind === 'auto' || !this.task) && !this.pickingUp &&
        t - (this.lootTriggerAt ?? -1e9) >= 200 && !(this.deathSpot && Date.now() - this.deathSpot.at < LOOT_WINDOW_MS)) {
      const tries = (this.lootTries ??= new Map());
      if (tries.size > 200) tries.clear();
      const want = this.wantedItemsNear(16, 8).filter((w) => (tries.get(w.e.id) ?? 0) < 3);
      if (want.length) {
        for (const w of want) tries.set(w.e.id, (tries.get(w.e.id) ?? 0) + 1);
        this.lootTriggerAt = t;
        trace('something worth having dropped nearby: going for it');
        this.autoDone = false;
        this.startAuto();
      }
    }
    if (t % 100 === 60 && this.mode === 'none') { try { if (armorUpgrades(invCounts(this.sim), this.worn()).length) this.equipArmor(); } catch {} }
    // Fire at the house: drop whatever's running; the plan puts the fire first. (Not again while a
    // fire we couldn't reach is set aside.)
    if (t % 40 === 30 && this.mode === 'none' && this.autoEnabled && this.homestead.house && this.autoStep !== 'fight_fire' &&
        (this.task?.kind === 'auto' || !this.task) && dist3D(this.sim.location, this.homestead.house) <= 64 &&
        ![...this.deferred.values()].some((d) => d.step === 'fight_fire' && d.until > Date.now()) && this.homestead.houseFires().length) {
      trace(`fire at the house: dropping ${this.autoStep}`);
      this.autoDone = false;
      this.startAuto();
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
    if (c && (c.pending || t - c.t < (c.ok ? 40 : 120))) return c.ok; // (one that can't reach us stays that way a while: 25 partial searches in one run)
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
    const jobs = this.homestead?.jobs ?? [];
    this.memory.data.state = {
      step: this.autoStep ?? null,
      deathSpot: this.deathSpot ?? null,
      deathQueue: this.deathQueue ?? [],
      jobs: jobs.map((job) => ({ ...job, readyInMs: Math.max(0, (job.readyAt - system.currentTick) * 50) })),
      at: Date.now(),
    };
    this.memory.save();
  }

  /**
   * Its pack and what it wears, kept in the world (every 10 s): a simulated player leaves with the
   * world and comes back empty-handed, so a server restart or a rejoin used to cost it everything.
   */
  saveKit() {
    if (this.arenaHook || this.kitHeld) return; // (the arena's kit is not ours, nor is the iron farm build's (game/farmbuild.js): what we owned was saved before it began)
    try { this.memory.data.kit = { ...kitOf(this.sim), at: Date.now() }; this.memory.save(); } catch (e) { console.warn(`[agent] save kit: ${e}`); }
  }

  /** Back on with it, if this is a fresh spawn (nothing on us: never doubled up). */
  restoreKit() {
    this.kitChecked = true;
    const kit = this.memory.data.kit;
    if (!kit || (!kit.slots?.length && !Object.keys(kit.worn ?? {}).length)) return;
    if (!emptyHanded(this.sim)) return;
    const n = restoreKit(this.sim, kit);
    if (n) { this.say(`Got my things back (${n} stacks).`); this.equipBestWeapon(); }
  }

  restoreState() {
    const st = this.memory.data.state;
    if (!st) return;
    if (st.deathSpot && Date.now() - st.deathSpot.at < LOOT_WINDOW_MS) this.deathSpot = st.deathSpot;
    this.deathQueue = (st.deathQueue ?? []).filter((d) => Date.now() - d.at < LOOT_WINDOW_MS);
    // Every furnace's job (older saves kept just the one, as `smelt`).
    const saved = st.jobs ?? (st.smelt ? [st.smelt] : []);
    if (saved.length && this.homestead) {
      this.homestead.jobs = saved.map(({ readyInMs, ...job }) => ({ ...job, readyAt: system.currentTick + Math.ceil((readyInMs ?? 0) / 50) }));
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
    try { open = this.classifier()(x, y, z) === Cell.AIR; } catch {}
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
      if (this.task || gen !== this.taskGen || this.sim.isInWater) return;
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

  /**
   * Sleeping at night, and so a bed and sheep hunted for it (`!bot beds on|off`, kept in the world;
   * CONFIG.beds is the default). Off: the night is sat out at home, awake.
   */
  bedsOn() { return this.memory.data.settings?.beds ?? CONFIG.beds ?? true; }
  setBeds(on) { this.setGoal('beds', on); }
  /** The goals switched on and off (core/toggles.js), from the world's settings. */
  toggles() { return goalsOf({ ...(this.memory.data.settings ?? {}), beds: this.bedsOn() }); }
  /** Task chains asked for (core/chain.js): [{ item, n }], first is being worked on. Kept in the world. */
  chainQueue() { return this.memory.data.chain ?? []; }
  popChain() { this.memory.data.chain = this.chainQueue().slice(1); this.memory.save(); this.deferred.clear(); }
  addChain(item, n) {
    this.memory.data.chain = [...this.chainQueue(), { item, n }];
    this.memory.save();
    this.autoEnabled = true; this.autoDone = false; this.nextAutoTry = 0;
  }
  clearChain() { this.memory.data.chain = []; this.memory.save(); }

  /**
   * A give-up with its reasons: what was tried, the numbers that decided it, and (map: true) the place as ASCII.
   * One note, so the log says why and not just that.
   */
  whyNot(tag, facts = {}, map = false) {
    let m = '';
    if (map) { try { m = `\n${this.flight.mapText()}`; } catch { /* no map */ } }
    trace(`give-up ${tag}: ${JSON.stringify(facts)}${m}`);
  }

  /** Why the plan has nothing to do: the switches that are off, what's held back and until when, what's queued. */
  idleReasons() {
    const out = [];
    const off = Object.entries(this.toggles()).filter(([, on]) => on === false).map(([k]) => k);
    if (off.length) out.push(`switched off: ${off.join(', ')}`);
    const hold = (until, what) => { const left = Math.round(((until ?? 0) - Date.now()) / 1000); if (left > 0) out.push(`${what} held back ${left} s more`); };
    hold(this.villageHoldUntil, 'the village hunt');
    hold(this.bedDeferredUntil, 'the bed/sheep search');
    for (const [k, d] of this.deferred) { const left = Math.round((d.until - Date.now()) / 1000); if (left > 0) out.push(`${d.step} (${k}) set aside ${left} s more`); }
    const q = this.chainQueue();
    if (q.length) out.push(`chain queued: ${q.map((g) => `${g.n} ${g.item}`).join(', ')}`);
    if (this.keepRiding) out.push('riding (!bot dismount to get off)');
    if (!this.homestead.house) out.push('no house');
    return out.length ? out.join('; ') : 'every goal is done';
  }

  /** @type {{ tick: number, from: string, to: string, where: string } | null} */
  lastTaskSwap = null;

  /** The order of the movable goals after moving in (core/toggles.js): `!bot order farm iron village`. */
  setOrder(text) {
    const order = parseOrder(text);
    this.memory.data.settings = { ...(this.memory.data.settings ?? {}), order };
    this.memory.save();
    this.autoDone = false; this.nextAutoTry = 0;
    return order;
  }
  setGoal(key, on) {
    this.memory.data.settings = { ...(this.memory.data.settings ?? {}), [key]: !!on };
    this.memory.save();
    this.keepSetting(key, on);
    this.autoDone = false; this.nextAutoTry = 0; // (re-plan now)
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
      // A ghast shoots from 30 and more blocks: seen out to 48 (the scan is 16, and one was fired at from 14-21 blocks and never noticed).
      if (radius < 48) { const ids = new Set(ents.map((e) => e.id)); for (const g of this.dim.getEntities({ location: pos, maxDistance: 48, type: 'minecraft:ghast' })) if (!ids.has(g.id)) ents.push(g); }
      // (In a test arena, what it names as the fight: an iron golem isn't a 'monster'.)
      for (const ty of this.arenaHook?.mobTypes ?? []) {
        for (const e of this.dim.getEntities({ location: pos, maxDistance: radius, type: `minecraft:${ty}` })) if (!ents.some((x) => x.id === e.id)) ents.push(e);
      }
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
        targetingMe, attackedMe, recent: false, dy: e.location.y - pos.y, canReach: true, inWater: !!e.isInWater, hp: undefined, lit: false, baby: false,
      });
      const m = out[out.length - 1];
      try { m.hp = e.getComponent('minecraft:health')?.currentValue; } catch {}
      try { m.baby = !!e.getComponent('minecraft:is_baby'); } catch {} // a baby zombie fits through a kill slot
      if (type === 'creeper') m.lit = this.hissing(e);
      m.canReach = this.canReachMe(e, pos, t);
      // A fight that went nowhere: it counts as out of reach for a minute, so we get on with things
      // (or into cover from it) instead of staring at it.
      if ((this.giveUp.get(e.id) ?? 0) > t) m.canReach = false;
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
    if (this.task?.kind === 'auto') return;
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

  /**
   * Track our best weapon (sword, axe or spear: most damage a hit, one about to break last); it's
   * only put in hand when a fight starts (tools stay in hand for work). And whether there's a shield
   * in the off hand.
   */
  equipBestWeapon() {
    try {
      const items = [];
      const c = container(this.sim);
      for (let i = 0; c && i < c.size; i++) {
        const it = c.getItem(i);
        if (!it) continue;
        const id = it.typeId.replace('minecraft:', '');
        if (!(id in SPEAR_DAMAGE) && weaponDamage(id) <= 1) continue;
        let uses = Infinity;
        try { const d = it.getComponent('minecraft:durability'); if (d) uses = d.maxDurability - d.damage; } catch {}
        items.push({ id, uses });
      }
      const best = bestWeapon(items);
      this.damage = best ? SPEAR_DAMAGE[best] ?? weaponDamage(best) : 1;
      this.weaponId = best;
      // Against creepers a spear as well (it reaches 4: outside their fuse range).
      const spear = creeperWeapon(items, null);
      this.spearId = spear && isSpear(spear) ? spear : null;
    } catch (e) {
      console.warn(`[agent] equip: ${e}`);
    }
    this.shield = this.worn().includes('shield');
    this.armor = armorTotal(this.worn()); // (confidence: health through armor, core/threat.js)
  }

  /**
   * Is this creeper swelling (fuse lit)? Scripts can't read the fuse (is_ignited is "on fire", not
   * this: counting on it, the bot never saw one hiss). What a player sees: a creeper stops walking
   * while it swells. So close (3.5), and its walk stopped (under 0.02 a tick, two readings running),
   * and it stays "lit" for the 1.5 s fuse or till we're past 6. Tracked per creeper.
   */
  hissing(e) {
    try {
      const t = system.currentTick;
      const v = e.getVelocity(), sp = Math.hypot(v.x, v.z);
      const d = dist3D(this.body.getPos(), e.location);
      const s = this.swell.get(e.id) ?? { still: 0, t: -1, since: null };
      if (s.t !== t) { s.t = t; s.still = sp < 0.02 && d <= 3.5 ? s.still + 1 : 0; }
      if (s.still >= 2 && s.since === null) s.since = t;
      if (s.since !== null && (d > CREEPER_CALM || t - s.since > 40)) s.since = null;
      this.swell.set(e.id, s);
      if (this.swell.size > 32) for (const [id, v2] of this.swell) if (t - v2.t > 200) this.swell.delete(id);
      return s.since !== null;
    } catch { return false; }
  }

  /** Shield up (crouch) or down. */
  setBlocking(on) {
    if (on === this.blocking) return;
    this.blocking = on;
    try { this.sim.isSneaking = on; } catch {}
  }

  survive(t) {
    if (this.testHold) return; // a calibration test is driving
    for (const [id, at] of this.attackers) if (t - at > ATTACKER_MEMORY_TICKS) this.attackers.delete(id);
    if (this.lastSeen.size > 200) for (const [id, at] of this.lastSeen) if (t - at > 200) this.lastSeen.delete(id);
    // In the boat with the player we follow: nothing to do but sit (they're steering). Anything
    // else has us out of it first.
    if (this.boatUnder(this.sim)) {
      if (this.task?.kind === 'follow') { if (this.mode !== 'none') this.endCombat(); return; }
      if (!this.boating?.crossing) this.leaveBoat(); // (our own crossing: staying in it)
    }
    if (this.burnTick(t)) return;
    const seen = this.scanMobs(this.mode === 'none' ? 16 : 24);
    const mobs = this.task?.kind === 'follow' ? this.escortMobs(seen, t) : seen;
    const inWater = this.sim.isInWater;
    if (!this.armor || t - (this.armorAt ?? -1e9) >= 100) { this.armor = armorTotal(this.worn()); this.armorAt = t; } // (worn out, taken off)
    const d = decide({ health: this.health(), damage: this.damage, isNight: this.isNight(), prevMode: this.mode, mobs, inWater, shield: this.shield, slot: this.slotHolds(), witches: this.toggles().witches, armor: this.armor?.points ?? 0, toughness: this.armor?.toughness ?? 0, bow: (() => { const iv = invCounts(this.sim); return !!iv.bow && (iv.arrow ?? 0) >= 3; })() });
    this.threatsNow = d.threats;
    // Cornered with nowhere better to run: fight the nearest thing that can be fought.
    // (Or squeezed and the creeper walled off behind us, out of sight and not hissing: the rest.)
    const pw = this.pinchWall;
    const behindWall = !!pw && t - pw.t < 1200 && pw.cells.every((c) => this.skills.blockAt(c) === pw.block) &&
      !d.threats.some((m) => m.type === 'creeper' && m.dist <= 8 && (m.lit || m.visible));
    if (d.mode === 'flee' && ((this.corneredUntil ?? 0) > t || (behindWall && d.reason === 'creeper')) && d.reason !== 'cover') {
      const fightable = (m) => !MOBS[m.type].never && m.type !== 'creeper' && m.dist <= 8 && (m.visible || m.attackedMe);
      const target = d.threats.find((m) => m.attackedMe && fightable(m)) ?? d.threats.find(fightable);
      if (target) { d.mode = 'fight'; d.target = target.id; d.reason = 'cornered'; }
      else { d.mode = 'none'; d.reason = 'cornered, nothing close enough to fight: carry on'; }
    }

    // A test arena can name the fight (a golem duel: it is why we are here): take that one on, whatever the race says.
    const arenaFight = this.arenaHook?.fightId?.();
    if (arenaFight) {
      const tgt = mobs.find((m) => m.id === arenaFight);
      if (tgt && !(d.mode === 'fight' && d.target === arenaFight)) {
        d.mode = 'fight'; d.target = arenaFight; d.reason = 'arena: this is the fight';
        if (!d.threats.some((m) => m.id === arenaFight)) { d.threats = [tgt, ...d.threats]; this.threatsNow = d.threats; }
      }
    }

    // Several creepers at once and nothing else about (core/tactics.js creeperPlan): on the shield as they come, or out of the blast of
    // a hissing one, not the run-and-shoot dance (u204: 31.9 s against the owner's 7.3). Takes the place of fighting or fleeing.
    const crowd = this.creeperCrowd(d, t);
    if (crowd) { d.mode = 'flee'; d.reason = `creepers: ${crowd.act}`; d.crowd = crowd; }

    // In bed: nobody swings a sword lying down (the game let the bot hit things from its bed). A mob
    // that's got to us (hit us, or right by the bed; a creeper close) gets us up first, and the fight
    // starts once we're on our feet; anything further off is the walls' business.
    if (this.sim.isSleeping && d.mode !== 'none') {
      const close = d.threats.some((m) => m.attackedMe || m.dist <= 2.5 || (m.type === 'creeper' && m.dist <= 5));
      if (close) this.getOutOfBed();
      d.mode = 'none';
      d.reason = close ? 'getting out of bed first' : 'in bed: the walls keep it out';
    }

    // Up our pillar (towerUp) with only zombies and their kind about: fight from the top, never down
    // and away. Anything that shoots, climbs or blows up in range: off it, the usual way.
    if (this.towered && this.towerHolds()) {
      if (d.threats.some((m) => m.dist <= 24 && (MOBS[m.type]?.kind !== 'melee' || /spider/.test(m.type)))) this.towered = null;
      else {
        const tgt = d.threats.filter((m) => MOBS[m.type]?.kind === 'melee' && m.dist <= 12).sort((a, b) => a.dist - b.dist)[0];
        if (tgt) { d.mode = 'fight'; d.target = tgt.id; d.reason = 'from the top of the pillar'; }
      }
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
    // (Never a creeper close by: it doesn't hit us before it goes off. Never anything that has hit
    // us, from any distance: it was ignoring an archer shooting from 6-9 blocks while health stayed
    // over 10, standing there for the arrows. Nor an archer that's after us and in sight.)
    if (d.mode !== 'none' && (this.ignoreThreatsUntil ?? 0) > t && this.health() >= 10 &&
        !d.threats.some((m) => m.attackedMe || (m.type === 'creeper' && m.dist <= 8) || (MOBS[m.type]?.kind === 'ranged' && m.targetingMe && m.visible))) {
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
          if (d.mode === 'fight' && this.weaponId) { hold(this.sim, this.weaponId); this.heldWeapon = this.weaponId; }
          if (t - this.lastShout > 200) {
            this.lastShout = t;
            const nm = String(d.threats[0].type).replace(/_/g, ' '), an = `${/^[aeiou]/.test(nm) ? 'an' : 'a'} ${nm}`;
            this.say(d.mode === 'fight' ? `Fighting ${an}.` : `Running from ${an}.`);
          }
        } else {
          this.newTask({ kind: d.mode });
          if (d.mode === 'fight' && this.weaponId) { hold(this.sim, this.weaponId); this.heldWeapon = this.weaponId; } // turned round from running
        }
        this.emit('combat', { mode: d.mode, reason: d.reason, threats: d.threats.map((m) => ({ type: m.type, dist: +m.dist.toFixed(1) })) });
        if (d.mode === 'flee') trace(`flee: ${d.reason}; from ${d.threats.slice(0, 3).map((m) => `${m.type} ${m.dist.toFixed(0)}`).join(', ')}; hp ${this.health()}; was doing ${this.suspended?.kind ?? this.task?.kind ?? '-'} / ${this.autoStep ?? '-'}${this.travelGoal && system.currentTick - this.travelGoal.at < 900 ? `, heading ${Math.round(this.travelGoal.x)} ${Math.round(this.travelGoal.z)}` : ''}`);
      }
      this.mode = d.mode;
      this.nextRoute = 0;
    }

    if (d.mode !== 'none' && this.body.headUnderwater() && this.body.airRatio() < airFloor(this.task?.kind, !!this.arenaHook?.swims, !!this.boating?.crossing)) {
      this.checkWater(t, inWater); // air first, fight later
    } else if (d.mode === 'fight') {
      this.calmSince = t;
      this.fight(mobs.find((m) => m.id === d.target), t);
    } else if (d.mode === 'flee') {
      this.calmSince = t;
      this.flee(d.threats, t, d.crowd);
    } else if (this.task?.kind === 'fight' || this.task?.kind === 'flee') {
      this.endCombat();
    } else if (this.blocking) {
      this.setBlocking(false); // never left crouching once it's calm
    } else if (this.checkWater(t, inWater)) {
      // swimming to shore
    } else if (this.suspended && !this.task && t - this.calmSince > CALM_TICKS_TO_RESUME) {
      const s = this.suspended;
      this.suspended = null;
      this.resume(s);
    }
  }

  /**
   * A search that keeps walking and never finds anything (no sheep on an island, in a desert): the
   * explore code only gives up on goes that get nowhere at all. After 6 legs with no sheep, the bed
   * waits 15 minutes and the rest of the list goes on.
   */
  noteSearch(want, found) {
    if (want !== 'sheep') return;
    // Found some: the wait's over (it kept the plan off them, and it walked away to look again).
    if (found) { this.sheepLegs = 0; this.sheepGiveUps = 0; this.bedDeferredUntil = 0; return; }
    this.sheepLegs = (this.sheepLegs ?? 0) + 1;
    if (this.sheepLegs < (this.sheepGiveUps ? 3 : 6)) return; // (a shorter look each time after the first)
    // Each time it comes up empty, a longer wait before the next look (15 min, 30, then an hour):
    // a world with none near shouldn't cost a quarter of every hour in searching.
    this.sheepLegs = 0;
    this.sheepGiveUps = (this.sheepGiveUps ?? 0) + 1;
    const wait = Math.min(60, 15 * 2 ** (this.sheepGiveUps - 1));
    this.bedDeferredUntil = Math.max(this.bedDeferredUntil ?? 0, Date.now() + wait * 60000);
    this.say(`No sheep anywhere I've looked: the bed can wait, getting on with the rest. I'll look again in ${wait} minutes.`);
  }

  /** Up out of bed (a mob's got to us). */
  getOutOfBed() {
    trace('out of bed: a mob close');
    try { this.sim.stopInteracting(); } catch {}
    try { this.body.jump(); } catch {}
  }

  endCombat() {
    // Whatever we killed dropped something: pick it up before getting back to work.
    if (this.fightTarget && !this.fightTarget.isValid && this.fightLast) this.lootAt = { ...this.fightLast, at: Date.now() };
    this.fightTarget = null;
    this.motor.setFocus(null);
    this.setBlocking(false);
    this.creeperSt.clear();
    this.stale.reset();
    this.heldWeapon = null; this.swingCheck = null; this.jabbing = false; this.fleeThreats = null;
    if (this.task?.kind === 'fight' || this.task?.kind === 'flee') {
      this.newTask(null);
      this.motor.stop();
    }
    this.mode = 'none';
  }

  /**
   * In water with nowhere to go (knocked in, fell in, path ended in it): swim to the nearest dry
   * land. Paths that deliberately cross water keep the motor busy, so they aren't interrupted; nor are the jobs that
   * work in water by themselves with raw moves (a test, a tow, an arena, our own boat crossing: core/water.js).
   */
  checkWater(t, inWater) {
    const kind = this.task?.kind;
    const st = {
      task: kind, crossing: !!this.boating?.crossing, inBoat: !!this.boatUnder?.(this.sim), inWater, headUnder: false, air: 1,
      swims: !!this.arenaHook?.swims, // (an arena job under water: the routine comes up for air itself; this is the last resort)
      motorBusy: !!this.motor.busy, onGround: false, idle: this.waterIdle, step: SURVIVE_EVERY,
    };
    if (!st.inBoat) { st.headUnder = this.body.headUnderwater(); st.air = this.body.airRatio(); st.onGround = this.body.isOnGround(); }
    // (core/water.js: a bot in a boat is left alone; one doing a test, a tow, an arena or its own boat crossing is in water on purpose and
    // is left to its routine until it is really short of air. The u204 leadboat run was taken from by this at 0.6 s in the tow course's pond.)
    const r = waterReflex(st);
    this.waterIdle = r.idle;
    if (inWater && !st.inBoat && ownsWater(kind, st.crossing)) {
      this.ownWaterSince ??= t;
      if (!this.ownWaterSaid && t - this.ownWaterSince >= 40) {
        this.ownWaterSaid = true;
        const p = this.body.getPos();
        trace(`water: ${st.crossing ? 'boat crossing' : kind} has been in water ${Math.round((t - this.ownWaterSince) / 20)} s at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)} (air ${Math.round(st.air * 100)}%, motor ${st.motorBusy ? 'busy' : 'free'}): left to its own routine`);
      }
    } else { this.ownWaterSince = null; this.ownWaterSaid = false; }
    if (r.act === 'air') {
      if (!['fight', 'flee'].includes(kind)) this.suspended = this.task ?? this.suspended;
      const gen = this.newTask({ kind: 'swim_out' });
      this.motor.stop();
      this.calmSince = t;
      if (CONFIG.debug) console.warn(`[agent] air ${Math.round(this.body.airRatio() * 100)}%: swimming for air`);
      if (ownsWater(kind, st.crossing)) trace(`water: ${kind} had ${Math.round(st.air * 100)}% air: swimming for air`);
      this.swimToAir(gen).then(() => { if (gen === this.taskGen) { this.newTask(null); this.calmSince = system.currentTick; } })
        .catch((e) => console.error(`[agent] swim for air: ${e}`));
      return true;
    }
    if (r.act !== 'shore') return !st.inBoat && kind === 'swim_out';
    // Remember where we got wet so exploring stops heading this way.
    const p = this.body.getPos();
    this.wetSpots = [...(this.wetSpots ?? []).slice(-4), { x: p.x, z: p.z, t }];
    this.skills.exploreAngle = undefined;
    this.suspended = this.task ?? this.suspended;
    const gen = this.newTask({ kind: 'swim_out' });
    this.calmSince = t;
    this.swimOut(gen).catch((e) => console.error(`[agent] swim out: ${e}`));
    return true;
  }

  async swimOut(gen) {
    const res = await new Promise((resolve) => {
      const classify = this.classifier();
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
      await this.motor.followPath(smoothPath(this.classifier(), res.path), { urgent: true });
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

  /** One leg of the village hunt (what the plan's seek_village step does): visit a known village, else search toward the seed's nearest village biome in rings. */
  async seekVillage(gen) {
    const S = this.skills;
    // Go to a village we know of, else toward the nearest biome villages generate in (the
    // world seed's biome search), eyes open: the lookout recognises one from afar (game/villages.js).
    const V = this.villages;
    // (Any village known, not only one within 220 blocks: the u197 run scouted one 432 away, did not count it as worth going to, and walked the long way
    // round through ring after ring of searching for five minutes.)
    const vil = V.pick('bed', 900) ?? V.pick('food', 900);
    if (vil) {
      const r = await V.visit(gen, vil, 'bed');
      this.say(`Village: ${r}.`, true);
      if (/raiders/.test(r)) this.villageHoldUntil = Date.now() + 600000;
      return;
    }
    // The game's own answer first (the brain types /locate into the server's console: exact, a village's real place), the in-game seed search if not.
    let b = null;
    { const here = this.sim.location, lc = await locate('structure', 'village', here); S.check(gen);
      if (lc) b = { pos: { x: lc.x, y: 64, z: lc.z }, id: 'village', dist: Math.hypot(lc.x - here.x, lc.z - here.z) }; }
    if (!b) b = this.lookout?.seedSearch('village');
    if (!b) { this.villageHoldUntil = Date.now() + 900000; this.whyNot('village hunt', { why: 'the seed search found no village biome within reach', hold: '15 min' }); return; }
    // Boxed into a pit or ravine floor: out of it first (that isn't a failed leg).
    if (await S.needsEscape(gen)) { await S.toSurface(gen); return; }
    // The biome is only where to look. Reaching it with no village in sight, search round it in widening rings (6 points
    // 48 out, then 6 at 96, ...) rather than wander off and come back (that paced 57,-67 <-> 11,-73 for a minute), with the
    // whole loaded area swept for village blocks and villagers as it goes (game/villages.js sweep).
    const base = this.villageBase;
    if (!base || Math.hypot(base.x - b.pos.x, base.z - b.pos.z) > 64) { this.villageBase = { x: b.pos.x, y: b.pos.y, z: b.pos.z }; this.villageRing = 0; }
    const ring = this.villageRing ?? 0;
    const R = 48 * (1 + Math.floor(ring / 6)), ang = (ring % 6) * Math.PI / 3 + (Math.floor(ring / 6) % 2 ? Math.PI / 6 : 0);
    const tgt = ring === 0 ? { x: b.pos.x, y: b.pos.y, z: b.pos.z } : { x: this.villageBase.x + Math.cos(ang) * R, y: b.pos.y, z: this.villageBase.z + Math.sin(ang) * R };
    // From where we are: look at this point and the next three on the ring (a loaded circle at each, in turn) before walking to any.
    const ringAt = (k) => { const Rk = 48 * (1 + Math.floor(k / 6)), ak = (k % 6) * Math.PI / 3 + (Math.floor(k / 6) % 2 ? Math.PI / 6 : 0); return k === 0 ? { x: b.pos.x, z: b.pos.z } : { x: this.villageBase.x + Math.cos(ak) * Rk, z: this.villageBase.z + Math.sin(ak) * Rk }; };
    const scouted = this.villageScouted;
    // (The game's own answer is the place itself: only the one point is looked at, not rings of far scouting areas that would not load for 12 s each.)
    for (let k = ring; k < ring + (b.id === 'village' ? 1 : 4) && k < 18; k++) {
      const pt = ringAt(k), key = `${Math.round(pt.x / 40)},${Math.round(pt.z / 40)}`;
      if (scouted.has(key)) continue;
      scouted.add(key);
      if (scouted.size > 200) scouted.clear();
      const sc = await V.scout(gen, pt.x, pt.z);
      if (!sc.loaded) { trace(`village scout at ${Math.round(pt.x)} ${Math.round(pt.z)}: ${sc.why}`); break; }
      if (sc.found) { this.sayOnce('village-scouted', 'There\'s a village over there: going to it.', 60000); this.villageRing = 0; this.villageStuck = 0; break; }
    }
    if (V.nearestKnown()) return; // a village is known now: the next pass visits it
    this.sayOnce('village-hunt', ring === 0 ? `Looking for a village: heading for the ${biomeName(b.id)} about ${Math.round(b.dist)} blocks away.` : `No village yet: searching round the ${biomeName(b.id)} (ring ${ring}).`, 120000);
    await S.packUp(gen);
    const from = { ...this.sim.location };
    S.spotted = null; S.spotWant = 'village';
    try { await S.travelToward(gen, tgt, 6); } finally { S.spotWant = null; }
    const left = Math.hypot(this.sim.location.x - tgt.x, this.sim.location.z - tgt.z);
    const found = S.spotted ?? V.sweep(true);
    S.spotted = null;
    if (found) { this.villageRing = 0; this.villageStuck = 0; this.villageMisses = 0; this.sayOnce('village-seen', `I can see a village about ${Math.round(Math.hypot(found.x - this.sim.location.x, found.z - this.sim.location.z))} blocks away.`, 60000); return; }
    this.villageMisses = (this.villageMisses ?? 0) + 1;
    const gained = Math.hypot(from.x - tgt.x, from.z - tgt.z) - left;
    if (left < 24) { this.villageRing = ring + 1; this.villageStuck = 0; } // (got there, none in sight: the next point on the ring)
    else if (gained < 8) { this.villageStuck = (this.villageStuck ?? 0) + 1; await S.wait(gen, 100); } else this.villageStuck = 0;
    if (this.villageStuck > 0 && this.villageStuck < 3) await S.explore(gen, 'a village', null); // (the way there ended in a dead end: fresh ground by the usual search)
    if (this.villageStuck >= 3 || (this.villageRing ?? 0) >= 18) {
      this.whyNot('village hunt', { stuckLegs: this.villageStuck, ring: this.villageRing, legs: this.villageMisses, lastGain: Math.round(gained), target: b.id, distance: Math.round(b.dist), pos: [Math.round(this.sim.location.x), Math.round(this.sim.location.y), Math.round(this.sim.location.z)], hold: '30 min' }, true);
      this.villageMisses = 0; this.villageStuck = 0; this.villageRing = 0; this.villageHoldUntil = Date.now() + 1800000;
    }
    return;
  }

  async runAuto(gen) {
    const S = this.skills, H = this.homestead;
    let last = '', repeats = 0, same = 0, lastSig = '';
    try {
      if (this.knownSurfaceStone === null && !S.isUnderground()) { // stone seen in a cave says nothing about the surface
        this.knownSurfaceStone = (await S.scan((id) => STONE_TARGETS.has(id), { radius: 24, below: 4, above: 8, limit: 1 })).length > 0;
        if (CONFIG.debug) console.warn(`[agent] surface stone in sight: ${this.knownSurfaceStone}`);
      }
      for (;;) {
        S.check(gen);
        S.essential = true; // (our things, before they despawn)
        await this.recoverDrops(gen);
        S.essential = false;
        await this.pickUpLoose(gen);
        await this.calibration.step(gen); // (once: what the game's numbers are, game/calibrate.js)
        await this.takeDownWalls(gen);
        await this.skills.cleanupScaffold(gen); // pillars left standing when something took us away
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
        // Hurt enough to stop working first (core/rest.js): a mine at night on 2 hp was how it died.
        const step = this.restNeeded(inv) ? { step: 'rest' } : this.hurtNoFood(inv) ?? this.planStep(inv, tableDist, tableDy);
        this.whyLog(step, inv, { tableDist, tableDy, tableNear: near ? Math.round(dist3D(this.sim.location, near)) : null, tableKnown: known ? Math.round(known.dist) : null });
        // A mining trip lasts till the plan has us doing something that isn't done down the mine.
        if (step.step === 'get_iron') this.miningTrip = true;
        else if (!MINE_STEPS.has(step.step) && step.step !== 'shelter' && step.step !== 'rest') this.miningTrip = false;
        const key = step.step + (step.items ? step.items.join() : '') + (step.count ?? '') + (step.what ?? '') + (step.why ?? '');
        // A repeat is the same step with nothing to show for the last one (the pack unchanged): the
        // same craft three times running that worked each time (bread, a loaf per 3 wheat; spare
        // pickaxes) is progress, and was being set aside for 3 minutes. The same step 8 times over
        // is set aside whatever it picked up on the way.
        const sig = JSON.stringify(inv);
        same = key === last ? same + 1 : 0;
        repeats = key === last && sig === lastSig ? repeats + 1 : 0;
        last = key;
        lastSig = sig;
        // Going round in circles: two or three steps taking turns (get stone, craft, get stone, craft:
        // each one "succeeds" and sets up the other), which the same-step counts above never see.
        // Five turns of the same step in the last 4 minutes among at most 3 different ones, with
        // nothing crafted or built between: the most repeated one that isn't a stint goes aside.
        {
          const nowT = system.currentTick;
          const hist = (this.autoHist ??= []);
          hist.push({ key, step: step.step, t: nowT, sk: stepKey(step) });
          while (hist.length && nowT - hist[0].t > 4800) hist.shift();
          const counts = new Map();
          for (const h of hist) counts.set(h.key, (counts.get(h.key) ?? 0) + 1);
          // (Only the fetching steps: crafting and furnishing take many turns one after another, and that's progress.)
          const fetching = ['get_stone', 'gather_logs', 'hunt', 'goto_table', 'place_table'];
          const top = [...counts].filter(([k]) => fetching.includes(hist.find((h) => h.key === k).step)).sort((a, b) => b[1] - a[1])[0];
          if (top && top[1] >= 5 && counts.size <= 3) {
            const h = hist.find((q) => q.key === top[0]);
            const cyc = [...counts.keys()].join(' <-> ');
            this.deferred.set(h.sk, { until: Date.now() + 180000, step: h.step });
            trace(`auto: going round in circles (${cyc}): setting ${h.step} aside for 3 min`);
            this.sayOnce(`circles:${h.step}`, `I keep going back and forth on ${h.step.replace(/_/g, ' ')}: setting it aside for a bit.`, 120000);
            this.flight.dump(`going round in circles: ${cyc}`);
            this.autoHist = [];
            last = ''; repeats = 0; same = 0;
            continue;
          }
        }
        // The same craft again and again with what it makes already in the pack (a real run made 8 furnaces and 6
        // crafting tables in a minute: whatever kept asking, the pack already had them): set it aside, say what the plan saw.
        if (step.step === 'craft' && Array.isArray(step.items)) {
          const invNow = invCounts(this.sim);
          // (A pile of four or more: three stone pickaxes before an iron trip is the plan's own stock, and setting that aside left the
          // bot idling three minutes, 09:42 in a real run. Eight furnaces was the loop.)
          const have = step.items.every((it) => (invNow[it] ?? 0) >= 4);
          const crafts = (this.autoHist ?? []).filter((h) => h.key === key && system.currentTick - h.t < 1800).length;
          if (have && crafts >= 4) {
            this.deferred.set(stepKey(step), { until: Date.now() + 180000, step: 'craft' });
            trace(`auto: craft loop: ${step.items.join(', ')} crafted ${crafts} times in 90 s and already in the pack (${step.items.map((it) => `${it} ${invNow[it]}`).join(', ')}); setting craft aside for 3 min. facts: ${JSON.stringify({ house: !!H.house, furnaceKnown: this.memory.list('furnace', this.dim.id, this.sim.location).length, campFurnace: !!S.campFurnace() })}`);
            this.flight.dump(`craft loop: ${step.items.join(', ')}`);
            this.autoHist = []; last = ''; repeats = 0; same = 0;
            continue;
          }
        }
        // The same step straight back after failing in no time (a placement that didn't take, a
        // craft with no table): give it a moment instead of burning through the retries in a second.
        if (repeats > 0 && system.currentTick - (this.lastStepAt ?? 0) < 20) await S.wait(gen, 40);
        this.lastStepAt = system.currentTick;
        trace(`auto: ${key}${step.opportunity ? ` (side job: ${step.opportunity})` : ''}${step.setAside ? ` (set aside: ${step.setAside})` : ''}`);
        if (CONFIG.debug) console.warn(`[agent] auto: ${key}`);
        if (this.autoStep !== step.step) { this.autoStep = step.step; this.saveState(); }
        this.profileStep(step.step);
        this.autoOpportunity = step.opportunity ?? null;
        this.autoLabel = this.labelFor(step);
        if (step.opportunity) this.sayOpportunity(step);
        // Out of the house for daytime work; out of any hole before anything but digging.
        // (Using what's in the house: the furnace, the table, putting things in. Walking out first and
        // back in for those was the in-and-out loop.)
        const inHouseJob = ['smelt', 'collect_smelt', 'furnish', 'store'].includes(step.step) || (['craft', 'goto_table'].includes(step.step) && H.house?.table);
        if (!['go_home', 'build_house', 'repair_house', 'clear_house', 'fight_fire', 'shelter', 'wait_smelt', 'rest'].includes(step.step) && !inHouseJob && H.isHome()) await H.leaveHouse(gen);
        // Jobs that can't be done without getting there: a way blocked by anything breakable gets
        // broken through (skills.actionOpts).
        S.essential = ESSENTIAL_STEPS.has(step.step);
        // (Mining is meant to be underground: iron trips and stone don't climb out between stints.)
        // Down our own mine, the camp's jobs (smelting, crafting a spare, putting on armor) happen
        // right there: climbing out first sent it to the surface to do them.
        const campJob = ['smelt', 'collect_smelt', 'wait_smelt', 'craft', 'goto_table', 'equip'].includes(step.step) && !!S.campFurnace() && this.minedUnderground();
        // Crafting at a table that's right here (in reach and in view): do it where we stand, then climb out.
        // Climbing out first and walking back down to the table (it was set down in the hole) for each
        // try was a loop: craft, escape, goto_table, craft, escape... for 2.5 minutes.
        const craftHere = step.step === 'craft' && step.needsTable !== false && tableDist === 0;
        // A table made or set down in the mine (the nearest one's 150 blocks up): done where we are. Climbing out first for it
        // (the planner picked "new table" because the walk was far) took the bot to the surface and its old table every time:
        // two 2.5-minute round trips in one real run, for a stone pickaxe.
        // (And walking to a table that's down here with us: "walk 2s < new table 6s" for a table 10 blocks off in the mine climbed 78 blocks to the surface first, then crafted at the stairs' top table: a real run, 12:50.)
        const tableNearby = step.step === 'goto_table' && this.skills.isUnderground() && Number.isFinite(tableDist) && tableDist <= 30 && Math.abs(tableDy) <= 5;
        const tableHere = tableNearby || this.skills.isUnderground() && (step.step === 'place_table' || (step.step === 'craft' && step.items?.[0] === 'crafting_table'));
        if (!['get_stone', 'get_iron', 'shelter', 'go_home'].includes(step.step) && !campJob && !craftHere && !tableHere && (await S.needsEscape(gen))) {
          last = ''; // getting out first isn't the step failing: don't count it toward giving up on it
          await S.toSurface(gen);
          continue;
        }
        // Steps that run in stints (iron mining is time-boxed and repeats on purpose) or handle their
        // own failure (the farm) never get set aside: exploring doesn't help them.
        if ((repeats >= 3 || same >= 8) && !['go_home', 'shelter', 'rest', 'wait_smelt', 'explore', 'seek_village', 'horse', 'riding', 'dismount', 'get_iron', 'make_farm', 'tend_farm', 'check_water', 'equip'].includes(step.step)) {
          // It keeps failing: set it aside for a few minutes and do the cheapest other thing on the
          // list (core/focus.js); it only goes exploring when nothing else is doable.
          if (step.step === 'hunt' && step.what === 'sheep') this.bedDeferredUntil = Date.now() + 300000;
          this.deferred.set(stepKey(step), { until: Date.now() + 180000, step: step.step });
          this.whyNot('step set aside', { step: stepKey(step), repeats, same, why: 'it kept failing' }, true);
          if (CONFIG.debug) console.warn(`[agent] setting aside ${stepKey(step)} for 3 min`);
          repeats = 0; same = 0;
          last = '';
          continue;
        }
        switch (step.step) {
          case 'explore': {
            // Look where what the set-aside step needs is likely to be (biome-aware). Never for
            // stone: that's a quarry or a staircase down (core/focus.js).
            const what = { log: 'trees', sheep: 'sheep', food: 'animals' }[step.want] ?? 'supplies';
            // Given up looking for it (explore got nowhere, core/explore.js): not again for now. For
            // sheep that's the bed waiting; anything else, a pause rather than the same spin.
            if (S.gaveUpLooking(step.want ?? what)) {
              if (step.want === 'sheep') this.bedDeferredUntil = Math.max(this.bedDeferredUntil ?? 0, Date.now() + 600000);
              else await S.wait(gen, 200);
              break;
            }
            const from = { ...this.sim.location };
            await S.explore(gen, what, step.want ?? null);
            if (step.want === 'sheep') this.noteSearch('sheep', H.animals(new Set(['sheep'])).length > 0);
            // Somewhere new: steps that failed because of the spot (no room for the furnace or the
            // table, no table in view) get another go here instead of waiting out their 3 minutes.
            // Only if we really moved, and never jobs tied to the house (its furnace is where it
            // was: clearing those made smelt -> explore -> smelt loop every 30 s).
            const moved = Math.hypot(this.sim.location.x - from.x, this.sim.location.z - from.z);
            const atHouse = new Set(H.house ? ['smelt', 'furnish'] : []);
            if (moved >= 24) for (const [k, d] of this.deferred) if (['smelt', 'place_table', 'craft', 'plan_house', 'build_house', 'furnish'].includes(d.step) && !atHouse.has(d.step)) this.deferred.delete(k);
            break;
          }
          case 'seek_village': await this.seekVillage(gen); break;
          case 'horse': {
            const Hs = this.horses;
            const h = Hs.mounted() ?? Hs.find(64);
            if (!h) { await S.wait(gen, 40); break; }
            if (step.do === 'tame') {
              this.sayOnce('horse-tame', 'Taming the horse: getting on until it lets me.', 60000);
              const r = await Hs.tame(gen, h);
              this.say(r.ok ? `The horse is tame (${r.tries} tries, ${r.how}).` : `Couldn't tame the horse: ${r.how}.`, true);
              if (!r.ok) this.popChain();
            } else if (step.do === 'saddle') {
              const ok = await Hs.saddle(gen, h);
              this.say(ok ? 'Saddled the horse.' : "The saddle won't go on.", true);
              if (!ok) this.popChain();
            } else {
              const ok = await Hs.getOn(gen, h);
              this.say(ok ? 'On the horse. `!bot dismount` to get off.' : "Couldn't get on the horse.", true);
              if (ok) this.keepRiding = true; else this.popChain();
            }
            break;
          }
          case 'dismount': await this.horses.getOff(gen); break;
          case 'riding': await S.wait(gen, 60); break;
          case 'gather_logs': {
            // Logs we put away in the chest come first, if we're near the house anyway.
            if (await this.fromChest(gen, isLog, step.count - count(inv, isLog))) break;
            // Everything the goals still need in one trip, not just this step's share: the rest of
            // the list (tools, fittings, sticks) is counted too, so we don't walk back for two logs.
            const later = Math.max(0, this.focusFacts(inv).need.logs - Math.max(0, step.count - count(inv, isLog)));
            const firm = Math.min(12, later);
            // At least a few in hand each trip: three trips for one log each in 45 s (the log of a real run)
            // cost more than the extra swings. Planks and sticks come out of them.
            // (Before any stone pickaxe, eight: the table, the wooden pickaxe and the five stone tools are ~6 logs of planks and sticks, and
            // a run that fetched 4 went back for 4 more 40 blocks away.)
            const early = !Object.keys(inv).some((id) => /^(stone|iron|diamond|netherite)_pickaxe$/.test(id));
            const target = Math.max(step.count + (step.opportunity ? 0 : firm), step.opportunity ? 0 : count(inv, isLog) + (early ? 8 : 4));
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
            { const after = invCounts(this.sim); trace(`craft: ${step.items.join(', ')} -> pack now ${step.items.map((it) => `${it} ${after[it] ?? 0}`).join(', ')}; tables known ${this.memory.list('crafting_table', this.dim.id, this.sim.location).map((t) => `${Math.round(t.dist)}`).join(',') || 'none'}`); }
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
            // (The first stone of the run, no stone pickaxe yet: the furnace's 8 and the spare pickaxes' 9 come in the same dig, not two more climbs up the stairs.)
            const firstStone = !step.why && !Object.keys(inv).some((id) => /^(stone|iron|diamond|netherite)_pickaxe$/.test(id));
            await S.getStone(gen, step.need, Math.min(32, Math.max(firstStone ? 17 : 0, this.focusFacts(inv).need.stone - step.need)));
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
          case 'smelt': {
            // A big batch of ore with a second furnace free (the house's two): half in each, done in
            // half the time (the last batch of the iron is the wait the gear's made after).
            const split = step.input === 'ore' && step.n >= 8 && H.furnaceFor('food')?.pos && !H.furnaceFor('food').busy && H.furnaceFor('ore')?.pos && key3(H.furnaceFor('food').pos) !== key3(H.furnaceFor('ore').pos);
            if (!(await H.startSmelt(gen, step.input, split ? Math.ceil(step.n / 2) : step.n, step.fuelPlanks))) { await S.wait(gen, 40); break; }
            const other = split ? H.furnaceFor('ore') : null;
            if (other?.pos && !other.busy && S.rawIron() > 0) await H.startSmelt(gen, 'ore', S.rawIron(), 0);
            break;
          }
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
            // Wood for the trip first, up here: iron gear needs sticks, a spare pickaxe, torches, and each climb out of the
            // mine for one log was ~90 s (three of them in one real run). About ten logs' worth in the pack before going down (a run still climbed out at 12:09 for more, 2.5 min a trip).
            try {
              const inv0 = invCounts(this.sim), woodHave = count(inv0, isLog) + Math.floor(count(inv0, isPlanks) / 4) + Math.floor((inv0.stick ?? 0) / 8);
              const tree = this.memory.list('log', this.dim.id, this.sim.location)[0];
              if (!S.isUnderground() && woodHave < 10 && tree && tree.dist <= 48 && step.why !== 'bucket') {
                this.sayOnce('wood-first', `Getting wood before I go down: ${10 - woodHave} logs for sticks, spares and a camp table, so I don't have to climb out for them.`, 300000);
                trace(`get_iron: only ${woodHave} logs' worth in the pack, fetching ${10 - woodHave} before going down (tree ${Math.round(tree.dist)} away)`);
                this.stockTarget = { step: 'gather_logs', n: count(inv0, isLog) + 10 - woodHave };
                try { await S.gatherLogs(gen, count(inv0, isLog) + 10 - woodHave, 0); } finally { this.stockTarget = null; }
              }
            } catch (e) { if (gen !== this.taskGen) throw e; trace(`get_iron: wood first failed: ${e}`); }
            if (!(await S.getIron(gen, step.need))) await S.wait(gen, 20);
            break;
          case 'equip': this.equipArmor(); break;
          case 'fill_bucket': {
            // Water for the bucket (it breaks falls); none about: leave it 10 minutes.
            if (!(await this.farm.fetchWater(gen))) { this.memory.data.bucketFailAt = Date.now(); this.memory.save(); }
            else this.say('Filled my water bucket (in case of a long fall).');
            break;
          }
          case 'wait_smelt': await H.waitSmelt(gen); break;
          case 'build_house': await H.buildHouse(gen); break;
          case 'repair_house': await H.repairHouse(gen); break;
          case 'clear_house': await H.clearHouse(gen); break;
          case 'fight_fire': await H.fightFire(gen); break;
          case 'plan_house': await H.planHouse(gen); break;
          case 'furnish': await H.furnish(gen); break;
          case 'store': await H.storeItems(gen); break;
          case 'go_home': await H.nightAtHome(gen); break;
          case 'shelter': await H.shelter(gen); break;
          case 'rest': await H.restUp(gen); break;
          case 'blocked':
            this.sayOnce(`blocked:${step.missing}`, `I can't make a ${step.missing.replace(/_/g, ' ')} with what I have.`, 300000);
            await S.explore(gen, 'supplies');
            break;
          case 'done':
            if ((await S.needsEscape(gen)) && !(await S.toSurface(gen))) { await S.wait(gen, 200); break; } // try again shortly
            if (!this.idleNoted || Date.now() - this.idleNoted > 60000) { this.idleNoted = Date.now(); trace(`idle: nothing to do: ${this.idleReasons()}`); }
            this.sayOnce('all-done', H.house ? 'Every goal done: I\'ll keep the place up (farm, chest, repairs, nights at home) and stand by.' : 'Got stone tools. Standing by for the next goal.', 3600000);
            // Not finished for good: nights, the farm, repairs, a full pack still need seeing to.
            // Idle for half a minute (free for orders and a look around), then plan again.
            this.newTask(null);
            this.nextAutoTry = system.currentTick + 600;
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
   * Died recently: go back for our things before they despawn (5 minutes). The whole 5 minutes:
   * a leg that gets nowhere, or a visit where it lies out of reach, is a failed try (core/loot.js
   * has the rule and the back-off; other jobs carry on between tries), but a fight, a swim or a
   * restart of the job on the way is not: the spot is kept until we've actually been there and
   * swept it, or the items have despawned.
   */
  async recoverDrops(gen) {
    // (A round per try: after a failed one it waits by the pile and goes again, right here rather
    // than back to the day's jobs, which would wander off and not be back for minutes.)
    for (let round = 0; round < 80; round++) {
      const d = this.deathSpot;
      if (!d || d.d !== this.dim.id) return;
      const S = this.skills;
      const now = Date.now();
      const dist = dist3D(this.sim.location, d);
      const plan = lootPlan(d, { now, dist, night: isNight(world.getTimeOfDay()), health: this.health() });
      if (plan.do === 'expired' || plan.do === 'giveup') {
        trace(`loot: ${plan.do}${plan.why ? ` (${plan.why})` : ''} after ${((now - d.at) / 1000).toFixed(0)} s, ${d.fails ?? 0} failed legs, ${d.stuck ?? 0} visits it couldn't pick up`);
        if (d.worth > 0) this.say(plan.do === 'expired' ? "Couldn't get back to my things in time; they'll have despawned." : "Couldn't get to my things: there's no way to where they are.");
        this.nextDeathSpot();
        continue; // (an older pile, if there is one)
      }
      if (plan.do === 'wait' && plan.why === 'backing off') { await S.wait(gen, Math.ceil(Math.max(0, d.retryAt - now) / 50) + 2); continue; }
      if (plan.do !== 'go') return;
      this.pickingUp = true;
      try {
        this.sayOnce('recover', (d.legs ?? 0) > 0 ? `Back to getting my things, ${Math.round(dist)} blocks away.` : `Going back for my things, ${Math.round(dist)} blocks away.`, 20000);
        let reached = dist3D(this.sim.location, d) <= 4;
        let failed = false;
        for (let leg = 0; leg < 6 && !reached; leg++) {
          const before = dist3D(this.sim.location, d);
          const ok = await S.goNear(gen, d, 3, 2);
          d.legs = (d.legs ?? 0) + 1;
          const after = dist3D(this.sim.location, d);
          reached = after <= 4;
          if (!ok && after > before - 2) {
            // Things far below and no walking way down from here (a path search from the surface runs out of nodes
            // long before 97 blocks of rock): go down our own shaft first and search from its bottom, once per trip.
            // (They were 97 blocks down in a cave off the mine; it gave up after 236 s without trying the stairs.)
            const q = S.homeQuarry(), b = q ? S.shaftBottom(q) : null;
            if (b && !d.viaShaft && d.y < this.sim.location.y - 12 && Math.hypot(b.x - d.x, b.z - d.z) < 120 && Math.abs(b.y - d.y) < 60) {
              d.viaShaft = true;
              trace(`loot: no walking way down; via the quarry's bottom at ${b.x} ${b.y} ${b.z}`);
              if (await S.toShaftBottom(gen)) { leg = -1; continue; }
            }
            failed = true; break;
          } // no headway on a leg that ran to its end
        }
        if (failed) {
          d.fails = (d.fails ?? 0) + 1;
          d.retryAt = Date.now() + backoffMs(d.fails);
          trace(`loot: no way to it from ${Math.round(dist3D(this.sim.location, d))} away (failed leg ${d.fails}), trying again in ${backoffMs(d.fails) / 1000} s`);
          this.saveState();
          await S.wait(gen, Math.ceil(backoffMs(d.fails) / 50)); // (by the pile: a way in may open)
          continue;
        }
        if (dist3D(this.sim.location, d) > 12) { this.saveState(); continue; } // (a long way: another leg)
        d.fails = 0;
        // Here: everything lying around the spot. Ones written off a moment ago (the first sweep
        // couldn't get one, a door has opened since) are tried again.
        const near = () => { try { return this.dim.getEntities({ type: 'minecraft:item', location: d, maxDistance: 9 }); } catch { return []; } };
        for (const e of near()) { try { S.unreachableItems.delete(e.id); } catch {} }
        await S.sweep(gen, d, 8, null, 25);
        const left = near().length;
        trace(`loot: at the spot, ${left} stack(s) left after the sweep (visit ${(d.stuck ?? 0) + 1})`);
        if (!left) {
          this.say('Got my things back.');
          this.equipBestWeapon(); this.equipArmor();
          this.nextDeathSpot();
          continue;
        }
        d.stuck = (d.stuck ?? 0) + 1;
        d.retryAt = Date.now() + backoffMs(d.stuck);
        this.sayOnce('loot-left', `Got some of my things back; ${left} stack${left > 1 ? 's' : ''} I couldn't reach yet.`, 30000);
        this.saveState();
        await S.wait(gen, Math.ceil(backoffMs(d.stuck) / 50));
      } finally {
        this.pickingUp = false;
      }
    }
  }

  /** This death spot's done (all picked up, expired or given up on): on to an older one, if any. */
  nextDeathSpot() {
    this.deathSpot = null;
    while (this.deathQueue?.length) {
      const n = this.deathQueue.shift();
      if (Date.now() - n.at < LOOT_WINDOW_MS) { this.deathSpot = n; break; }
    }
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
      toggles: this.toggles(),
      advance: H.house ? { ...advanceProgress({ inv: invCounts(this.sim), worn: this.worn() }), waterKnown: this.memory.data.waterNearHouse != null && (this.memory.data.waterNearHouse || advanceProgress({ inv: invCounts(this.sim), worn: this.worn() }).bucket) } : null,
    });
  }

  /** Everything the dashboard shows (brain/dashboard.html), sent to the brain once a second. */
  /**
   * Why the plan chose this step: the step as the planner built it and the facts it was looking at (the table, the
   * furnaces, the house, what's set aside, the pack's working stock, health, time). Its own log (the dashboard's Planner
   * log, brain/logs/why.jsonl), not the decisions list: one line per choice, for questions like "why did it craft a
   * furnace with one in the pack".
   */
  whyLog(step, inv, extra = {}) {
    try {
      const keep = ['crafting_table', 'furnace', 'cobblestone', 'coal', 'charcoal', 'raw_iron', 'iron_ingot', 'stick', 'torch', 'bucket', 'water_bucket', 'bed', 'shield', 'oak_planks', 'oak_log'];
      const pack = Object.fromEntries(keep.filter((k) => inv[k]).map((k) => [k, inv[k]]));
      const tools = Object.keys(inv).filter((k) => /_(pickaxe|sword|axe|shovel|spear)$/.test(k)).map((k) => `${k}${inv[k] > 1 ? ` x${inv[k]}` : ''}`);
      const woodish = count(inv, isLog) + Math.floor(count(inv, isPlanks) / 4);
      const H = this.homestead, here = this.sim.location;
      const furn = this.memory.list('furnace', this.dim.id, here).map((f) => ({ d: Math.round(f.dist), camp: !!H.isCamp?.(f.pos) }));
      const rec = {
        type: 'why', tick: system.currentTick, build: CONFIG.build,
        pos: [Math.round(here.x * 10) / 10, Math.round(here.y * 10) / 10, Math.round(here.z * 10) / 10],
        step: JSON.stringify(step).slice(0, 400), key: stepKey(step),
        facts: {
          ...extra, wood: woodish, pack, tools, furnaces: furn, house: !!H.house, project: !!H.project,
          deferred: [...this.deferred.values()].filter((d) => d.until > Date.now()).map((d) => d.step),
          toggles: this.toggles(), hp: Math.round(this.health()), food: Math.round(H.hunger()), time: world.getTimeOfDay(),
          under: this.minedUnderground?.() ?? null, trip: !!this.miningTrip, last: this.autoStep ?? null,
        },
      };
      sendEvent(rec).catch(() => {});
    } catch { /* a log never stops the plan */ }
  }

  /** How long each agent tick takes (ms) and how fast the server is turning over, for the diagnostics. */
  notePerf(ms) {
    const P = this.perf ??= { n: 0, sum: 0, max: 0, slow: 0, win: [], startedAt: Date.now(), tick0: system.currentTick, lastTickAt: Date.now(), lastTick: system.currentTick, tps: 20 };
    P.n++; P.sum += ms; P.max = Math.max(P.max, ms); if (ms > 25) P.slow++;
    P.win.push(ms); if (P.win.length > 200) P.win.shift();
    const now = Date.now();
    if (now - P.lastTickAt >= 5000) { P.tps = Math.round(((system.currentTick - P.lastTick) / ((now - P.lastTickAt) / 1000)) * 10) / 10; P.lastTickAt = now; P.lastTick = system.currentTick; }
  }

  /**
   * Everything that helps when something's gone wrong and isn't in the plain status: the exact state of
   * the body, what it wears, the light, the motor, the plan's bookkeeping, the memory's size, how
   * slow the server is, what's around. Each part on its own, so one failing leaves the rest.
   */
  diag() {
    const out = {};
    const part = (k, fn) => { try { out[k] = fn(); } catch (e) { out[k] = `unavailable: ${e}`; } };
    const r1 = (v) => Math.round(v * 100) / 100;
    part('build', () => CONFIG.build);
    part('game', () => { const si = system.serverSystemInfo; return si ? { memoryTier: si.memoryTier } : null; });
    part('body', () => {
      const l = this.sim.location, rot = this.sim.getRotation(), v = this.sim.getVelocity();
      return { x: r1(l.x), y: r1(l.y), z: r1(l.z), yaw: r1(rot.y), pitch: r1(rot.x), vel: [r1(v.x), r1(v.y), r1(v.z)], onGround: this.sim.isOnGround, inWater: this.sim.isInWater, sneaking: this.sim.isSneaking, sprinting: this.sim.isSprinting, sleeping: this.sim.isSleeping, gamemode: String(this.sim.getGameMode?.() ?? '') };
    });
    part('light', () => { const b = this.dim.getBlock(this.skills.feet()); return { block: b?.getLightLevel(), sky: b?.getSkyLightLevel(), standingOn: this.skills.blockAt({ ...this.skills.feet(), y: this.skills.feet().y - 1 }) }; });
    part('worn', () => ({ ...Object.fromEntries(Object.entries(this.worn() ?? {}).map(([k, v]) => [k, v && typeof v === 'object' ? (v.id ?? v.typeId ?? String(v)) : v])), armor: this.armor ?? null, shield: !!this.shield }));
    part('motor', () => ({ busy: !!this.motor.busy, intent: this.motor.intent?.kind ?? null, focus: !!this.motor.focus, mode: this.mode, task: this.task?.kind ?? 'idle', breaking: !!this.breaking, hunting: !!this.hunting, resting: !!this.resting, testHold: !!this.testHold }));
    part('plan', () => ({ step: this.autoStep ?? null, label: this.autoLabel ?? null, enabled: this.autoEnabled, done: this.autoDone, opportunity: this.autoOpportunity ?? null, miningTrip: !!this.onMiningTrip?.(), deferred: [...this.deferred.entries()].filter(([, d]) => d.until > Date.now()).map(([k, d]) => `${k} (${Math.round((d.until - Date.now()) / 1000)}s)`), bedDeferredS: Math.max(0, Math.round(((this.bedDeferredUntil ?? 0) - Date.now()) / 1000)), stock: this.stockTarget ?? null }));
    part('threats', () => (this.threatsNow ?? []).slice(0, 10).map((m) => ({ type: m.type, d: r1(m.dist ?? 0), hp: m.hp ?? null, targetingMe: !!m.targetingMe })));
    part('players', () => world.getPlayers().filter((p) => p.id !== this.sim.id).map((p) => { const l = p.location; return { name: p.name, d: r1(Math.hypot(l.x - this.sim.location.x, l.z - this.sim.location.z)), at: [Math.round(l.x), Math.round(l.y), Math.round(l.z)] }; }));
    part('house', () => { const h = this.homestead.house; return h ? { at: [h.x, h.y, h.z], dir: h.dir, layout: h.layout, state: this.homestead.houseState?.() ?? null } : null; });
    part('quarry', () => { const q = this.memory.data.quarry; return q ? { steps: q.steps?.length, top: q.steps?.[0], bottom: q.steps?.[q.steps.length - 1], fails: q.fails ?? 0, started: q.started } : null; });
    part('farm', () => this.memory.data.farm ? { ...this.memory.data.farm } : null);
    part('smelting', () => this.homestead.jobs?.map((j) => ({ kind: j.kind, pos: j.pos, readyIn: Math.round((j.readyAt - system.currentTick) / 20) })) ?? null);
    part('memory', () => { const raw = JSON.stringify(this.memory.data); return { bytes: raw.length, limit: 32767, byCategory: this.memory.summary(), villages: (this.memory.data.villages ?? []).length, saplings: (this.memory.data.saplings ?? []).length, chunksMapped: this.lookout?.map?.size ?? 0, settings: this.memory.data.settings ?? {} }; });
    part('settings', () => ({ chat: this.chatOn(), beds: this.bedsOn(), useProfile: CONFIG.useProfile !== false, learnedHouse: !!this.memory.data.settings?.learnedHouse, profile: this.profile?.params ? { ...this.profile.params } : null }));
    part('perf', () => { const P = this.perf; if (!P) return null; const w = P.win.slice().sort((a, b) => a - b); return { tps: P.tps, agentTickMsAvg: r1(P.sum / Math.max(1, P.n)), agentTickMsP95: w.length ? r1(w[Math.floor(w.length * 0.95)]) : null, agentTickMsMax: r1(P.max), slowTicks: P.slow, ticksRun: P.n, runningS: Math.round((Date.now() - P.startedAt) / 1000) }; });
    part('pathfinding', () => this.pathLog.summary());
    part('counters', () => ({ deaths: this.deathCount ?? 0, flightReports: this.flight?.dumps ?? 0, tick: system.currentTick, day: Math.floor(world.getDay?.() ?? 0), timeOfDay: world.getTimeOfDay() }));
    part('brain', () => ({ url: CONFIG.brainUrl }));
    return out;
  }

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
      tests: /** @type {any} */ (this).testProgress ?? null,
      testOmit: this.memory.data.testOmit ?? [],
      testRates: { ...passRates(this.memory.data.testRuns, this.memory.data.testOmit ?? []), avg: avgRates(this.memory.data.testStats, this.memory.data.testOmit ?? []) },
      testStats: this.memory.data.testStats ?? {},
      pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, dim: this.dim.id.replace('minecraft:', ''),
      health: Math.round(this.health()), hunger: Math.round(hunger), air: Math.round(air * 100),
      inWater: (() => { try { return !!this.sim.isInWater; } catch { return false; } })(),
      underwater: (() => { try { return this.body.headUnderwater(); } catch { return false; } })(),
      mode: this.mode, task: this.task?.kind ?? 'idle', step: this.task?.kind === 'auto' ? this.autoStep ?? null : null,
      auto: this.autoEnabled, autoDone: this.autoDone, underground,
      ravine: (() => { try { const r = this.skills.rimClimb(); return !underground && r >= 4 ? r : 0; } catch { return 0; } })(),
      time, night: isNight(time), day: Math.floor(world.getDay?.() ?? 0),
      held, inventory: inv, where: this.whereList().slice(0, 12),
      house: this.homestead.house ? { ...this.homestead.house } : null,
      project: this.homestead.project ? { ...this.homestead.project, ...this.homestead.projectProgress(), needs: this.homestead.shortfall ?? null } : null,
      smelting: this.homestead.smeltJob ? { secondsLeft: Math.max(0, Math.round((this.homestead.smeltJob.readyAt - system.currentTick) / 20)) } : null,
      players: world.getPlayers().filter((pl) => pl.id !== this.sim.id).map((pl) => pl.name),
      goals: this.goals(),
      toggles: GOALS.map((g) => ({ ...g, on: this.toggles()[g.key] })),
      order: orderOf(this.memory.data.settings),
      biome: (() => { try { return this.lookout.hereName(); } catch { return null; } })(),
      opportunity: this.task?.kind === 'auto' ? this.autoOpportunity : null,
      stepLabel: this.task?.kind === 'auto' ? this.autoLabel ?? null : null,
      setAside: [...this.deferred.values()].filter((d) => d.until > Date.now()).map((d) => d.step),
      flight: (() => { try { return this.flight.summary(); } catch { return null; } })(),
      deaths: this.deathCount ?? 0,
      learn: { recording: this.demo.on ? this.demo.name : null, status: this.demo.status(), params: this.profile.params, notes: this.profile.notes, using: CONFIG.useProfile !== false },
      villages: (() => { try { return this.villages.status(); } catch { return []; } })(),
      chat: this.chatOn(),
      diag: (() => { try { return this.diag(); } catch { return null; } })(),
      build: CONFIG.build,
    };
  }

  /**
   * Drops from a fight we just won, and anything else lying within a few blocks that we can walk
   * to: picked up between jobs so nothing gets left behind.
   */
  async pickUpLoose(gen) {
    this.pickingUp = true;
    try { await this.pickUpLooseInner(gen); } finally { this.pickingUp = false; }
  }

  async pickUpLooseInner(gen) {
    const S = this.skills;
    if (this.lootAt) {
      const l = this.lootAt;
      this.lootAt = null;
      if (Date.now() - l.at < 60000 && dist3D(this.sim.location, l) < 24) await S.sweep(gen, l, 6, null, 10);
    }
    let n = 0;
    try { n = this.dim.getEntities({ type: 'minecraft:item', location: this.sim.location, maxDistance: 8 }).length; } catch {}
    if (n) await S.sweep(gen, this.sim.location, 8, null, 8);
    // Further off, what's worth the walk (core/wants.js itemValue: armor or a weapon better than
    // ours, iron, coal when short, wool for the bed...): not a bone or a flower.
    if (this.wantedItemsNear(20).length) {
      const ctx = this.wantsCtx();
      await S.sweep(gen, this.sim.location, 20, (id) => itemValue(id, ctx) >= 3, 20);
    }
    this.equipArmor(); // (anything better we just picked up goes straight on)
    // Ore we want showing close by (coal on a hillside, iron in a cave mouth): a few steps, a few
    // swings, while we're here (core/wants.js blockValue; never copper and the like).
    if (!isNight(world.getTimeOfDay()) && Object.keys(invCounts(this.sim)).some((id) => /_pickaxe$/.test(id))) await S.oreInView(gen, 6, { maxWalk: 8, limit: 2 });
  }

  /** What core/wants.js values things against: what we have and wear, what the goals still need. */
  wantsCtx() {
    const inv = invCounts(this.sim);
    let needs = {};
    try { needs = this.focusFacts(inv).need; } catch {}
    return { inv, worn: this.worn(), needs };
  }

  /** Items on the ground within r worth going for ([{ e, value }], best first), skipping ones we couldn't reach. */
  wantedItemsNear(r, min = 3) {
    const out = [];
    let items = [];
    try { items = this.dim.getEntities({ type: 'minecraft:item', location: this.sim.location, maxDistance: r }); } catch {}
    if (!items.length) return out; // (the usual case: no working out what we need, it looks at animals)
    const ctx = this.wantsCtx();
    try {
      for (const e of items) {
        if ((this.skills.unreachableItems.get(e.id) ?? 0) > system.currentTick) continue;
        const id = e.getComponent('minecraft:item')?.itemStack?.typeId ?? '';
        const v = itemValue(id, ctx);
        if (v >= min) out.push({ e, value: v });
      }
    } catch {}
    return out.sort((a, b) => b.value - a.value);
  }

  /** The next step of the goal ladder, from what we have right now (inventory is the truth). */
  planStep(inv, tableDist, tableDy, { opportunities = true, dayTime = false } = {}) {
    // Sleeping switched off (!bot beds off, the goal toggle) and able to look after itself (a sword,
    // half health or more): nights are for working like days. It was still going home or digging in
    // at dusk and standing about till morning. (Unarmed or hurt, it still takes cover.)
    if (!dayTime && this.workNights(inv)) dayTime = true;
    const night = !dayTime && isNight(world.getTimeOfDay());
    // Riding (commanded, or a chain's goal): the plan waits till we're told to get off; riding when nothing asked for it: get off.
    {
      const riding = !!this.horses.mounted();
      const wantsRide = this.keepRiding || this.chainQueue()[0]?.item === 'riding_horse';
      if (riding && wantsRide && !this.chainQueue()[0]) return { step: 'riding' };
      if (riding && !wantsRide) return { step: 'dismount' };
    }
    if (!night) {
      for (let guard = 0; guard < 4; guard++) {
        const g = this.chainQueue()[0];
        if (!g) break;
        const f = { ...this.advanceFacts(inv, tableDist), tableDist, horse: this.horses.state(), furnaceKnown: this.memory.list('furnace', this.dim.id, this.sim.location).length > 0 || !!this.homestead.house?.furnace };
        const cs = chainStep(g.item, g.n, f);
        if (!cs) { this.say(g.item.endsWith('horse') ? `Chain done: ${g.item.replace(/_/g, ' ')}.` : `Chain done: ${held(inv, g.item)} ${g.item.replace(/_/g, ' ')}.`, true); if (g.item === 'riding_horse') this.keepRiding = true; this.popChain(); continue; }
        if (cs.step === 'blocked') { this.say(`Can't get ${g.item.replace(/_/g, ' ')} yet: no way to get ${cs.missing}. Dropping that one.`, true); this.popChain(); continue; }
        this.autoOpportunity = null;
        return { ...cs, chain: g.item };
      }
    }
    /** @type {any} */
    let step = nextStep({ inv, tableDist, tableDy, exposedStoneKnown: this.knownSurfaceStone, spears: Skills.itemExists('stone_spear') });
    if (step.step === 'done') step = settleStep({ ...this.settleFacts(inv, tableDist), ...(dayTime ? { time: 6000 } : {}) });
    // Moved in: a farm, iron, iron gear (core/advance.js).
    if (step.step === 'done' && this.homestead.house) step = orderedAdvance(this.advanceFacts(inv, tableDist), orderOf(this.memory.data.settings));
    // The house goal switched off (!bot goal house off): no home to farm by, but iron is still a goal.
    // Without this it said "all goals done" and stood about with iron and the farm still switched on.
    else if (step.step === 'done' && !this.homestead.house && this.toggles().house === false) {
      const f = this.advanceFacts(inv, tableDist);
      step = orderedAdvance({ ...f, goals: { ...f.goals, farm: false } }, orderOf(this.memory.data.settings));
    }
    // Nothing else left and still no bed (the sheep search put off, noteSearch): look now rather than
    // stand about till the wait's over.
    if (step.step === 'done' && this.homestead.house && this.toggles().beds !== false && !this.homestead.houseState()?.bed && !inv.bed &&
        SWORD_OK.test(Object.keys(inv).join(' '))) {
      const wool = Math.max(0, ...Object.entries(inv).filter(([id]) => id.endsWith('_wool')).map(([, n]) => n));
      const sheep = this.homestead.animalsSeen(new Set(['sheep'])).length > 0 || this.memory.list('sheep', this.dim.id, this.sim.location).some((m) => m.dist < 96);
      step = wool >= 3 ? step : sheep ? { step: 'hunt', what: 'sheep', need: 3 - wool } : { step: 'explore', want: 'sheep' };
    }
    // A wandering trader in sight and no lead yet: his two leads (for walking animals and
    // villagers home, into boats) drop when he's gone. Any time of day but night, from the start.
    if (!night && !inv.lead && !['go_home', 'shelter', 'repair_house', 'clear_house', 'fight_fire'].includes(step.step)) {
      const t = this.homestead.animalsSeen(new Set(['wandering_trader']), 32)[0];
      if (t) return { step: 'hunt', what: 'trader', near: Math.round(t.d) };
    }
    else if (night) {
      // Night before we're set up: home if we have one, otherwise dig in unless we're armed and healthy.
      const armed = Object.keys(inv).some((id) => /_sword$/.test(id)) && this.health() >= 12;
      if (this.homestead.house) {
        // In the house already: what's done indoors comes first (the table, the furnaces and the
        // chests are all here: crafting, furnishing, putting things away, loading a furnace), then
        // bed. It was going to bed with all that left for the morning's daylight.
        const H = this.homestead;
        if (H.isHome()) {
          const day = this.planStep(inv, tableDist, tableDy, { opportunities: false, dayTime: true });
          const fine = INDOOR_STEPS.has(day.step) && !(day.step === 'craft' && day.needsTable && !(tableDist <= 12)) &&
            !(['smelt', 'collect_smelt'].includes(day.step) && !H.house.furnace);
          if (fine) { trace(`night, at home: ${day.step} first`); return day; }
        }
        step = { step: 'go_home' };
      } else if (!armed) step = { step: 'shelter' };
    }
    // The ladder's step against everything else still needed that's cheap right now.
    if (opportunities && !night) step = chooseStep(step, this.focusFacts(inv));
    return step;
  }

  /**
   * Hurt (under REST_BELOW) and health can't come back: the food bar is under 18 and there's nothing in
   * the pack to eat, so resting gets nowhere (restNeeded says no) and the bot used to carry on mining at
   * 6 hp for 7 minutes, to a skeleton and a fall. Meat first, whatever the hunting switch says: animals
   * in sight are hunted, otherwise it looks for some. Null when that doesn't apply.
   */
  hurtNoFood(inv) {
    const H = this.homestead, health = this.health();
    if (health >= REST_BELOW || this.resting) return null;
    const hunger = H.hunger();
    if (canHeal({ hunger, canEat: !!chooseFood(inv, { hunger, saturation: H.saturation(), health }) })) return null;
    if (!Object.keys(inv).some((id) => /_sword$/.test(id))) return null;
    if (H.animalsSeen(FOOD_ANIMALS, 40).length > 0) return { step: 'hunt', what: 'food' };
    return { step: 'explore', want: 'food' };
  }

  /** Hurt enough to stop and heal before any more work (core/rest.js)? */
  restNeeded(inv) {
    const H = this.homestead;
    const hunger = H.hunger(), health = this.health();
    if (this.resting && Date.now() - this.restStart > (REST_MAX_S + 30) * 1000) this.resting = false; // (a bout an order cut off, long ago)
    if (health >= 14 && !this.resting) return false; // (the usual case: no food sums)
    const canEat = !!chooseFood(inv, { hunger, saturation: H.saturation(), health });
    return shouldRest({ health, hunger, canEat, resting: !!this.resting, coolingDown: Date.now() < (this.restCoolUntil ?? 0) });
  }

  /**
   * Fit to be out in the dark, and told to be (sleeping off, or `!bot goal nights off`: not going
   * home at dusk): work through the night like a day. Unarmed or hurt it still takes cover.
   */
  workNights(inv) {
    const tg = this.toggles();
    // (Switched off on purpose: no shelter either, armed or not, hurt or not: hurt is the rest step's job. A run on 4 hp walled itself in at the end of the mine till morning.)
    if (tg.nights === false || tg.beds === false) return true;
    return this.bedsOn() === false && SWORD_OK.test(Object.keys(inv).join(' ')) && this.health() >= 10;
  }

  /**
   * On a mining trip: iron mining started down our mine and nothing's brought us back up since. A
   * moment's position (half way up the quarry steps under open sky, a pick-up walk) isn't the test:
   * a trip is a trip until the plan takes us home in daylight.
   */
  onMiningTrip() {
    if (!this.miningTrip) return false;
    try { return this.skills.nearQuarry(this.sim.location, 96) && Object.keys(invCounts(this.sim)).some((id) => /_pickaxe$/.test(id)); } catch { return false; }
  }

  /** Underground in our quarry or its mine (not just any cave), with a pickaxe to keep going. */
  minedUnderground() {
    try {
      const S = this.skills;
      // In the mine: under cover near our quarry (its shaft, the tunnel's end), or deep anyway (a long
      // branch can run well past 48 blocks from the shaft).
      const p = this.sim.location;
      return Object.keys(invCounts(this.sim)).some((id) => /_pickaxe$/.test(id)) && S.isUnderground() && (S.nearQuarry(p, 64) || p.y < 40);
    } catch { return false; }
  }

  /** What core/focus.js weighs: what the goals still need and how far the nearest of each is. */
  focusFacts(inv) {
    const H = this.homestead, pos = this.sim.location, dimId = this.dim.id;
    const now = Date.now();
    for (const [k, d] of this.deferred) if (d.until <= now) this.deferred.delete(k);
    const mem = (cat) => this.memory.list(cat, dimId, pos)[0]?.dist ?? null;
    const sheep = H.animalsSeen(new Set(['sheep']), 24)[0]?.d ?? mem('sheep');
    const food = H.animalsSeen(FOOD_ANIMALS, 16)[0]?.d ?? null;
    const house = H.house;
    const facts = {
      inv,
      haveFurnace: (inv.furnace ?? 0) > 0 || !!house?.furnace || this.memory.list('furnace', dimId, pos).length > 0,
      house: house ? H.houseState() : null,
      project: !!H.project,
      shortfall: H.project ? H.houseNeeds(H.project, H.project.dir) : null,
      worn: this.worn(),
      beds: this.bedsOn(),
      goals: this.toggles(),
    };
    return {
      inv,
      goals: this.toggles(),
      need: goalNeeds(facts),
      seen: { sheep, food, log: mem('log'), stone: mem('stone') },
      deferred: this.deferred,
      bedDeferred: (this.bedDeferredUntil ?? 0) > now,
      canMineStone: Object.keys(inv).some((id) => /_pickaxe$/.test(id)),
      early: !Object.keys(inv).some((id) => /^(stone|iron|diamond|netherite)_pickaxe$/.test(id)),
      canHunt: SWORD_OK.test(Object.keys(inv).join(' ')) && this.toggles().hunting !== false, // (hunting switched off: not exploring for animals either)
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
      case 'horse': return { tame: 'taming the horse', saddle: 'saddling the horse', mount: 'getting on the horse' }[step.do] ?? 'with the horse';
      case 'riding': return 'riding my horse (!bot dismount to get off)';
      case 'dismount': return 'getting off the horse';
      case 'seek_village': return step.known ? 'heading for the village I saw' : 'looking for a village';
      case 'explore': return `looking further out for ${{ log: 'trees', sheep: 'sheep', food: 'animals' }[step.want] ?? 'supplies'}${aside}`;
      case 'gather_logs': return `getting wood: ${step.count} logs${step.wanted && step.wanted[0] !== 'later' ? ` for ${step.wanted.join(', ').replace(/_/g, ' ')}` : ''}${side}${aside}`;
      case 'get_stone': return `getting ${step.need} cobblestone${step.why && step.why !== 'later' ? ` for the ${step.why}` : ''}${side}${aside}`;
      case 'hunt': return `${step.what === 'sheep' ? 'getting wool from sheep' : step.what === 'trader' ? 'taking the wandering trader\'s leads' : 'hunting for food'}${side}${aside}`;
      case 'get_iron': return `mining for iron (${step.need} more${step.why === 'bucket' ? ', for a bucket' : ''})`;
      case 'fill_bucket': return 'filling the water bucket (for long falls)';
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
    // (The step's cleared so this doesn't fire again every 2 s while the new loop is still in its preamble: each restart cancelled
    // the last, and a 14:06 run sat frozen 5 min at "got what I needed" without ever planning.)
    this.autoStep = null;
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

  /**
   * Put on the best armor we carry, any material (a player's gift, a zombie's drop, our own iron):
   * each piece that beats what's worn in its slot goes on, the old one back in the pack (core/wants.js
   * armorUpgrades). And a shield in the off hand if there's none there.
   */
  equipArmor() {
    const eq = this.sim.getComponent('minecraft:equippable');
    const c = container(this.sim);
    if (!eq || !c) return 0;
    const SLOT = { helmet: EquipmentSlot.Head, chestplate: EquipmentSlot.Chest, leggings: EquipmentSlot.Legs, boots: EquipmentSlot.Feet };
    let n = 0;
    const put = (id, slot) => {
      for (let i = 0; i < c.size; i++) {
        const it = c.getItem(i);
        if (!it || it.typeId.replace('minecraft:', '') !== id) continue;
        try {
          const old = eq.getEquipment(slot);
          eq.setEquipment(slot, it.clone());
          c.setItem(i, old ?? undefined); // (the old piece where the new one was)
          n++;
        } catch (e) { trace(`equip ${id}: ${e}`); }
        return;
      }
    };
    for (const u of armorUpgrades(invCounts(this.sim), this.worn())) put(u.id, SLOT[u.slot]);
    let shielded = false;
    try { if (invCounts(this.sim).shield && !eq.getEquipment(EquipmentSlot.Offhand)) { put('shield', EquipmentSlot.Offhand); shielded = true; } } catch {}
    if (shielded) system.runTimeout(() => this.refreshShield(), 10); // (a script's equipment change may not be drawn by the clients)
    this.armor = armorTotal(this.worn());
    if (n) this.say(`Put on ${n} piece${n > 1 ? 's' : ''} of gear (armor ${this.armor.points}).`);
    return n;
  }

  /**
   * What it has learned from watching the player (brain/learn.py): the numbers it takes up, within
   * limits (core/profile.js), every 5 minutes. `!bot profile off` goes back to the defaults.
   */
  async refreshProfile(force = false) {
    const raw = CONFIG.useProfile === false ? null : await fetchProfile();
    const got = adoptProfile(raw);
    const changed = JSON.stringify(got.params) !== JSON.stringify(this.profile.params);
    this.profile = { ...got, at: system.currentTick, raw };
    Skills.IRON_Y = got.params.iron_y;
    if (changed || force) {
      trace(`profile: ${got.notes.length ? got.notes.join('; ') : 'defaults'}`);
      if (got.notes.length) this.sayOnce('profile', `Learned from watching you: ${got.notes.join('; ')}.`, 600000);
    }
    return got;
  }

  /**
   * The shield is in the off hand (it blocks, you hear it) but players saw none: setting equipment from
   * a script on a simulated player doesn't always send the change to the clients. The game's own
   * `replaceitem` does, so after equipping (and on `!bot reshield`): clear the slot, set it again,
   * then, if it's a fresh shield (no damage: nothing repaired for free), the command too.
   * What happened goes to the trace ("shield refresh: ...") so the next log says which step worked.
   */
  async refreshShield() {
    try {
      const eq = this.sim.getComponent('minecraft:equippable');
      const it = eq?.getEquipment(EquipmentSlot.Offhand);
      if (!it || !/shield$/.test(it.typeId)) { trace('shield refresh: no shield in the off hand'); return false; }
      let damage = 0;
      try { damage = it.getComponent('minecraft:durability')?.damage ?? 0; } catch {}
      const copy = it.clone();
      eq.setEquipment(EquipmentSlot.Offhand, undefined);
      await system.waitTicks(3);
      eq.setEquipment(EquipmentSlot.Offhand, copy);
      let cmd = 'skipped (damaged: not repaired for free)';
      if (damage === 0) {
        try { const r = this.dim.runCommand(`replaceitem entity @a[name="${this.sim.name}"] slot.weapon.offhand 0 shield`); cmd = `ran (${r.successCount} ok)`; } catch (e) { cmd = `failed: ${e}`; }
      }
      trace(`shield refresh: cleared and set again, replaceitem ${cmd}`);
      this.shield = this.worn().includes('shield');
      return true;
    } catch (e) { trace(`shield refresh: ${e}`); return false; }
  }

  /** What core/advance.js decides from. */
  advanceFacts(inv, tableDist) {
    const H = this.homestead;
    const job = H.planJob(); // (the one that matters from here, not just the nearest)
    const f = this.memory.list('furnace', this.dim.id, this.sim.location).filter((e) => !H.isCamp(e.pos))[0];
    const S = this.skills;
    return {
      inv, tableDist, worn: this.worn(),
      waterNearHouse: this.memory.data.waterNearHouse ?? null,
      farmBlocked: Date.now() - (this.memory.data.farmFailedAt ?? 0) < 600000,
      underground: (() => { try { return this.skills.isUnderground(); } catch { return false; } })(),
      farm: this.farm.state(),
      smelt: job ? { ready: system.currentTick >= job.readyAt, kind: job.kind, n: job.n ?? 0, dist: dist3D(this.sim.location, job.pos) } : null,
      furnaceDist: f ? f.dist : Infinity,
      pickUses: usesLeft(this.sim, (id) => /^(stone|iron|diamond|netherite)_pickaxe$/.test(id) && isWorkPickaxe(id)), // (the iron one is kept for ore)
      oreCooking: H.oreCooking(),
      canFillBucket: this.dim.id !== 'minecraft:nether' && Date.now() - (this.memory.data.bucketFailAt ?? 0) > 600000,
      goals: this.toggles(),
      armed: SWORD_OK.test(Object.keys(inv).join(' ')),
      health: this.health(),
      food: (() => { try { return this.sim.getComponent('minecraft:player.hunger')?.currentValue ?? 20; } catch { return 20; } })(),
      villageKnown: !!(this.villages.pick('bed', 900) ?? this.villages.pick('food', 900)),
      villageVisited: (this.memory.data.villages ?? []).some((v) => v.visited),
      villageReady: Date.now() >= (this.villageHoldUntil ?? 0),
      villageHunting: !!this.villageBase,
      // Down at the mine camp (a table and a furnace at the foot of the quarry): craft and smelt there.
      camp: (() => { try { return !!S.campFurnace() && S.isUnderground() && S.nearQuarry(this.sim.location, 48); } catch { return false; } })(),
    };
  }

  settleFacts(inv, tableDist) {
    const H = this.homestead, pos = this.sim.location, dimId = this.dim.id;
    const f = this.memory.list('furnace', dimId, pos).filter((e) => !H.isCamp(e.pos))[0]; // the house's, not the mine camp's
    const house = H.house;
    const sheepSeen = H.animalsSeen(new Set(['sheep'])).length > 0;
    const sheepKnown = this.memory.list('sheep', dimId, pos).some((m) => m.dist < 96);
    return {
      inv, tableDist, time: world.getTimeOfDay(),
      furnace: f ? { dist: f.dist, inHouse: !!house && houseInside(house, f.pos) } : null,
      smelt: (() => { const j = H.planJob(); return j ? { ready: system.currentTick >= j.readyAt, kind: j.kind, dist: dist3D(pos, j.pos) } : null; })(),
      house: house ? { dist: dist3D(pos, house), ...H.houseState() } : null,
      repairShort: house ? H.houseNeeds(house, house.dir) : null,
      sheep: sheepSeen || sheepKnown,
      animals: H.animalsSeen(FOOD_ANIMALS, 16).length,
      bedDeferred: (this.bedDeferredUntil ?? 0) > Date.now(),
      beds: this.bedsOn(),
      goals: this.toggles(),
      armed: SWORD_OK.test(Object.keys(inv).join(' ')),
      hungry: H.hunger() <= 10,
      farmRipe: (this.farm.state()?.ripe ?? 0) >= 3,
      project: !!H.project,
      shortfall: H.project ? H.houseNeeds(H.project, H.project.dir, { fittings: true }) : H.shortfall ?? null,
      packFull: H.freeSlots() <= FULL_SLOTS && Date.now() - (this.memory.data.nothingToStoreAt ?? 0) > 600000,
      chestFull: Date.now() - (this.memory.data.chestFullAt ?? 0) < 600000,
    };
  }

  resume(task) {
    if (!task) return;
    if (task.kind === 'arena') { this.arenaHook?.resume?.(); return; }
    if (task.kind === 'auto') { if (this.autoEnabled) this.startAuto(); return; }
    if (task.kind === 'surface' || task.kind === 'dig') { this.apply([{ type: task.kind }]); return; }
    if (task.kind === 'goto') this.startGoto(task.target, task.tolerance);
    else if (task.kind === 'follow') { this.newTask(task); this.followTick = 0; }
  }

  /**
   * One fight step (core/tactics.js decides; tools/sim_combat.mjs runs the same against simulated
   * mobs). Walk to the mob over the real terrain (a skeleton up at the quarry's mouth: back up the
   * steps to it, not at a point in the rock), swing when in reach, shield up between swings when
   * something's about to hit us, and write the fight off if it goes nowhere.
   */
  /**
   * Is the bow the right thing against this one, from here? With a bow and arrows in the pack: a creeper still 5 or more blocks off (it
   * never gets to hiss), a skeleton, witch or pillager beyond 6.5 (closing under its arrows costs more than the shot), anything we cannot
   * walk up to (in the air, across a gap), and, when hurt, a melee mob still 8 or more away. Needs a clear line.
   */
  bowWorthy(target, d) {
    const inv = invCounts(this.sim);
    if (!inv.bow || (inv.arrow ?? 0) < 3) return false;
    if (this.shooting || this.walling || this.jabbing || (this.nextBow ?? 0) > system.currentTick) return false;
    const type = target.type;
    let worth = false;
    if (type === 'creeper') worth = d >= 5 && d <= 22;
    else if (type === 'ghast') worth = d >= 8 && d <= 46;
    else if (['skeleton', 'stray', 'bogged', 'witch', 'pillager', 'blaze', 'phantom'].includes(type)) worth = d >= 6.5 && d <= 28;
    else if (target.canReach === false) worth = d >= 5 && d <= 28;
    else if (this.health() < 10 && MOBS[type]?.kind === 'melee' && d >= 8 && d <= 20) worth = true;
    if (!worth) return false;
    try { return canSee(this.dim, this.sim.getHeadLocation(), target.entity.getHeadLocation()); } catch { return false; }
  }

  /** One arrow at it (game/aim.js: aimed again through the whole draw, ahead of it, the drop allowed for). */
  async rangedShot(e) {
    this.shooting = true;
    try {
      this.setBlocking(false);
      await shootAt(this, e, { stop: () => !e.isValid || this.mode !== 'fight' });
    } catch { /* the target went, or we were stopped */ } finally {
      this.shooting = false;
      this.nextBow = system.currentTick + 6;
      this.heldWeapon = null;          // the sword back in hand by the usual rule
      try { if (this.weaponId) hold(this.sim, this.weaponId); } catch { /* */ }
    }
  }

  fight(target, t) {
    if (!target?.entity?.isValid) return;
    if (this.walling) return; // putting a wall up: the placing has the hands and the eyes
    if (this.shooting) return; // a shot is being drawn
    if (this.bowWorthy(target, dist3D(this.body.getPos(), target.pos))) { this.fightTarget = target.entity; this.rangedShot(target.entity); return; }
    const e = target.entity;
    this.fightTarget = e;
    this.fightLast = { x: e.location.x, y: e.location.y, z: e.location.z };
    const chest = { x: e.location.x, y: e.location.y + 1.0, z: e.location.z };
    this.motor.setFocus(chest);
    const me = this.body.getPos();
    const mob = target.pos;
    const d = dist3D(me, mob);
    let canSwing = t >= this.nextSwing;
    let mv, swingWith = this.weaponId, reach = REACH_HIT, minReach = 0, spearSwing = false, cooldown = 10;
    if (target.type === 'creeper') {
      const room = this.creeperRoom(target, me, t);
      if (!this.creeperSt.has(e.id)) this.creeperSt.set(e.id, {});
      const st = this.creeperSt.get(e.id);
      // Spear and sword both: the spear's jab from 4 when it's ready, the sword up close while it
      // recharges (switching is instant; the spear's cooldown is its own).
      const ws = [];
      if (this.spearReachOk === false && t >= (this.spearOffUntil ?? Infinity)) { this.spearReachOk = true; this.spearMisses = 0; }
      if (this.spearId && this.spearReachOk !== false) ws.push({ id: this.spearId, ...weaponReach(this.spearId), readyAt: Math.max(this.spearNext ?? 0, this.nextSwing) });
      ws.push({ id: this.weaponId, ...weaponReach(this.weaponId), readyAt: this.nextSwing });
      const w = pickCreeperSwing(ws, d, t);
      swingWith = w.id; reach = w.reach; minReach = w.minReach; canSwing = w.ready; spearSwing = isSpear(w.id); cooldown = w.cooldown;
      const lit = this.creeperLit(target, e, d, t);
      // A hit that won't send it anywhere: steps or rock right behind it (predicted), or it barely
      // moved the last time we hit it (measured 6 ticks on).
      if (st.hitAt !== undefined && t - st.hitAt >= 6 && st.kbMoved === undefined) st.kbMoved = d - st.hitD;
      const kbPoor = knockbackRoom(me, mob, this.cellAt()) < 1 || (st.kbMoved !== undefined && st.kbMoved < 0.6);
      const wallBlock = this.homestead.materialFor('stone');
      const canWall = !!wallBlock && (invCounts(this.sim)[wallBlock] ?? 0) >= 2;
      mv = creeperFight({ me, mob, t, st, shield: this.shield, canSwing, canRetreat: room !== false, lit, reach, minReach, canWall, kbPoor, walls: CONFIG.creeperWalls === true, company: (this.threatsNow ?? []).some((m) => m.id !== target.id && m.dist <= 16) });
      if (mv.wall) { this.wallOffCreeper(me, mob, wallBlock); return; }
      if (mv.guard) this.guardAgainstBlast(me, mob, wallBlock); // (and fight on)
      this.fightMove = 'creeper'; // its own spacing (creeperTick), not the melee stop
      // The combat log: every tick of a creeper fight, to calibrate tools/sim_combat.mjs against.
      let ign = '?'; // its walking speed: a swelling creeper stands still
      try { const v = e.getVelocity(); ign = Math.hypot(v.x, v.z).toFixed(3); } catch {}
      const f2 = (v) => v.toFixed(2);
      // (Every tick only with CONFIG.combatLog, for calibrating tools/sim_combat.mjs; else when the move changes, on a swing, and every 5 ticks: a creeper fight was 190 lines in 7 s and pushed everything else out of the buffer.)
      const act = `${mv.swing ? 'S' : ''}${mv.stop ? 'stop' : mv.away ? 'away' : mv.goal ? 'approach' : 'hold'}${mv.block ? 'b' : ''}`;
      const noisy = CONFIG.combatLog === true || mv.swing || act !== this.creeperLogAct || t - (this.creeperLogAt ?? -99) >= 5;
      this.creeperLogAct = act;
      if (noisy) { this.creeperLogAt = t;
      trace(`creeper ${e.id.slice(-4)} t${t} d${f2(d)} me${f2(me.x)},${f2(me.y)},${f2(me.z)} c${f2(mob.x)},${f2(mob.y)},${f2(mob.z)} v${ign} lit${lit ? 1 : 0} w=${swingWith ?? 'hand'}${canSwing ? '' : '(cd)'} r${reach} -> ${mv.swing ? 'SWING ' : ''}${mv.stop ? 'stop' : mv.away ? `away${f2(mv.away)}` : mv.goal ? 'approach' : 'hold'}${mv.block ? ' block' : ''} busy${this.motor.busy ? 1 : 0}`); }
    } else {
      if (this.heldWeapon && this.heldWeapon !== this.weaponId && this.weaponId) { hold(this.sim, this.weaponId); this.heldWeapon = this.weaponId; }
      // Tall melee mobs coming at a dead end: a kill slot across the way in, and fight from it.
      if (!this.slot && this.buildSlot(this.threatsNow, target)) return;
      // Up our pillar: stand still and hit what's at its foot (the eye's 4.6 up: a zombie right by the
      // pillar is in reach at ~3.4 feet to feet).
      if (this.towerHolds() && MOBS[target.type]?.kind === 'melee') reach = 3.7;
      mv = (this.towerHolds() && MOBS[target.type]?.kind === 'melee' ? { swing: canSwing, stop: true } : null) ?? this.slotMove(target, me, canSwing) ?? fightMove({ me, mob, melee: MOBS[target.type]?.kind === 'melee', t, shield: this.shield, canSwing, type: target.type });
      this.fightMove = mv.stop ? 'hold' : mv.goal && d > STOP_AT ? 'approach' : 'back';
      // The combat log for every other fight (twice a second): where it is, what we did, what was in
      // hand. The skeleton fights that went on for half a minute had nothing in the log to say why.
      if (t - (this.fightTraceAt ?? -1e9) >= 10) {
        this.fightTraceAt = t;
        let held = '?';
        try { held = this.sim.getComponent('minecraft:inventory')?.container?.getItem(this.sim.selectedSlotIndex)?.typeId?.replace('minecraft:', '') ?? 'hand'; } catch {}
        let vis = '?';
        try { vis = canSee(this.dim, this.sim.getHeadLocation(), chest) ? '1' : '0'; } catch {}
        trace(`fight ${target.type} ${e.id.slice(-4)} d${d.toFixed(1)} dy${(mob.y - me.y).toFixed(1)} hp${target.hp ?? '?'} me${this.health().toFixed(0)} held=${held} ${canSwing ? 'ready' : 'cd'} vis${vis} tgt${target.targetingMe ? 1 : 0} reach${target.canReach === false ? 0 : 1} -> ${mv.swing ? 'SWING ' : ''}${mv.stop ? 'stop' : mv.goal ? 'approach' : 'hold'}${mv.block ? ' block' : ''} shield${this.shield ? 1 : 0} busy${this.motor.busy ? 1 : 0}`);
      }
    }
    this.setBlocking(!!mv.block);
    // Stepping out of an arrow's way: the feet are the dodge's until it's done.
    if ((this.dodgeUntil ?? 0) > t) mv = { ...mv, stop: false, away: 0, goal: null };
    if (mv.stop) this.stopWalking();
    if (mv.away && (mv.now || !this.motor.busy)) {
      // Backing off a creeper: the nearest spot that far from it, found and walked on the spot (a
      // path planned in the background lands a few ticks late: a creeper doesn't wait).
      const path = awayPath(findPath, this.classifier(), me, mob, mv.away);
      if (path) { this.routeSeq = (this.routeSeq ?? 0) + 1; this.motor.followPath(smoothPath(this.classifier(), path), { seamless: true, urgent: mv.urgent, walk: mv.walk }); }
    } else if (mv.goal && (t >= this.nextRoute || !this.motor.busy || mv.now)) {
      this.nextRoute = t + 6;
      this.routeTo(mv.goal, mv.tolerance, mv.urgent, 1500, mv.walk);
    }
    // (Never through a block: a wall we just put up, the rock of a step.)
    let clearShot = true;
    try { clearShot = canSee(this.dim, this.sim.getHeadLocation(), chest); } catch {}
    // Swing wanted but no clear shot or not facing it (a creeper a level below, round a corner): turn to it, and if the way is blocked, go to it.
    // (It stood still "swinging" for 1.5 s at 3.8 blocks with the creeper two below, until it went off.)
    if (mv.swing && d <= reach && d >= minReach && canSwing && !(clearShot && this.facing(chest, 25))) {
      this.noSwing = (this.noSwing ?? 0) + 1;
      if (this.noSwing >= 3) this.motor.lookAt(chest, 6, 20).catch(() => {});
      if (!clearShot && this.noSwing >= 8 && t >= this.nextRoute) { this.nextRoute = t + 6; this.routeTo({ x: mob.x, y: mob.y, z: mob.z }, Math.max(1.5, reach - 1.4), false, 1500, true); }
    } else if (mv.swing) this.noSwing = 0;
    if (mv.swing && d <= reach && d >= minReach && canSwing && clearShot && this.facing(chest, 25)) {
      this.setBlocking(false);
      if (swingWith !== this.heldWeapon) { hold(this.sim, swingWith); this.heldWeapon = swingWith; }
      let hp0 = null;
      try { hp0 = e.getComponent('minecraft:health')?.currentValue ?? null; } catch {}
      try { this.sim.attackEntity(e); } catch {}
      // A creeper can be hurt again 10 ticks after a hit; a spear has its own, longer cooldown.
      this.nextSwing = t + (target.type === 'creeper' ? 10 : 10 + Math.floor(this.rng() * 4));
      if (spearSwing) this.spearNext = t + cooldown + 1;
      // (fresh: past the 10 ticks after a hit that land, when a creeper can't be hurt anyway)
      if (target.type === 'creeper' && hp0 !== null) this.swingCheck = { e, hp0, t, d, spear: spearSwing, fresh: t - (this.creeperHitAt ?? -1e9) >= 10 };
      if (target.type === 'creeper') { const st = this.creeperSt.get(e.id); if (st) { st.hitAt = t; st.hitD = d; st.kbMoved = undefined; } }
    }
    // Going nowhere (no hit landed, not a block closer for 6 s): give it up for a minute. It counts
    // as out of reach, so we either get on with things or, if it's shooting us, get out of its sight.
    let hpLost = 0;
    try { const h = e.getComponent('minecraft:health'); hpLost = h.effectiveMax - h.currentValue; } catch {}
    if (this.stale.update(e.id, t, d, hpLost)) {
      this.giveUp.set(e.id, t + 1200);
      this.stale.reset();
      if (this.giveUp.size > 32) for (const [id, until] of this.giveUp) if (until < t) this.giveUp.delete(id);
      if (CONFIG.debug) console.warn(`[agent] fight with ${target.type} going nowhere at ${d.toFixed(1)}: giving it up`);
      this.say(`Can't get at that ${target.type}. Leaving it.`);
    }
  }

  /**
   * Room to back off from a creeper (the hit-and-back-off dance needs a spot 4+ blocks further from
   * it than we are, on our side of it). Planned in the background, refreshed every second.
   * Returns true / false / undefined (not known yet).
   */
  creeperRoom(target, me, t) {
    const c = this.roomCache.get(target.id);
    if (c && (c.pending || t - c.t < 20)) return c.ok;
    const entry = { ok: c?.ok, t, pending: true };
    this.roomCache.set(target.id, entry);
    if (this.roomCache.size > 16) for (const [id, v] of this.roomCache) if (t - v.t > 400) this.roomCache.delete(id);
    const m = target.pos, need = Math.max(6.5, dist3D(me, m) + 4);
    const goalTest = (x, y, z, w) => w.standable(x, y, z) && Math.hypot(x + 0.5 - m.x, z + 0.5 - m.z) >= need
      // On our side of it: nearer us than it. ("2 nearer", as it was, can't be met by any spot at all
      // with the creeper 2 away: "no room" just when it mattered, and it stood there for the blast.)
      && Math.hypot(x + 0.5 - me.x, z + 0.5 - me.z) < Math.hypot(x + 0.5 - m.x, z + 0.5 - m.z);
    this.plan(me, me, 0, 400, goalTest).then((res) => { entry.ok = res.complete; entry.t = system.currentTick; entry.pending = false; })
      .catch(() => { entry.pending = false; });
    return entry.ok;
  }

  /**
   * Cornered in a 1-wide passage with the threat coming the one way in: two blocks across it (feet
   * and head height) keep zombies out, arrows off and most of a creeper's blast away. Cheapest
   * blocks we carry. Returns true if a wall is going up.
   */
  wallOff(threats) {
    if (this.walling) return true;
    const near = threats.filter((m) => m.dist <= 12).sort((a, b) => a.dist - b.dist)[0];
    if (!near) return false;
    const me = this.body.getPos();
    const w = this.classifier();
    const at = (x, y, z) => { const c = w(x, y, z); return c === Cell.AIR ? 'open' : c === Cell.SOLID || c === Cell.STEP || c === Cell.SLAB ? 'solid' : 'other'; };
    const cells = barricadeCells(me, near.pos, at);
    if (!cells) return false;
    const block = this.homestead.materialFor('stone');
    if (!block || (invCounts(this.sim)[block] ?? 0) < cells.length) return false;
    // Not on top of a mob standing in the gap.
    if (threats.some((m) => cells.some((c) => Math.floor(m.pos.x) === c.x && Math.floor(m.pos.z) === c.z && Math.abs(Math.floor(m.pos.y) - c.y) <= 1))) return false;
    this.walling = true;
    this.motor.stop();
    this.setBlocking(false);
    const gen = this.taskGen;
    (async () => {
      let n = 0;
      n = (await this.homestead.placeFlow(gen, cells.map((c) => ({ cell: c, id: block })))).placed;
      if (n) { this.say('Walled myself in.'); if (CONFIG.debug) console.warn(`[agent] walled off the way in (${n}/${cells.length} blocks)`); }
    })().catch(() => {}).finally(() => { this.walling = false; });
    return true;
  }

  /** Every tick while fighting: stop walking in the moment we're at striking distance. */
  fightSpacingTick() {
    const e = this.fightTarget;
    // A creeper fight runs every tick: between our reach and its fuse there's ~7 ticks of its walk.
    if (this.mode === 'fight' && this.fightMove === 'creeper' && e?.isValid) {
      const t = system.currentTick;
      // Did that swing land? If its health didn't drop, it missed (out of reach after all, or not
      // lined up): swing again at once rather than wait out a cooldown while it walks in. A spear that
      // keeps missing from past a sword's reach: stop counting on its reach.
      const sc = this.swingCheck;
      if (sc && t - sc.t >= 2) {
        this.swingCheck = null;
        let hp = sc.hp0;
        try { hp = sc.e.getComponent('minecraft:health')?.currentValue ?? hp; } catch {}
        trace(`creeper swing ${sc.spear ? 'spear' : 'sword'} at ${sc.d.toFixed(2)}: ${hp < sc.hp0 ? `hit ${sc.hp0}->${hp}` : 'MISSED'}`);
        if (hp >= sc.hp0) {
          this.nextSwing = t;
          // A miss that says something about the spear's reach: a clear swing, the creeper hurtable.
          // (Swings at one behind the wall we'd just put up counted, and put the spear away for good.)
          if (sc.spear) { this.spearNext = t; if (sc.d > REACH_HIT && sc.fresh) this.spearMisses = (this.spearMisses ?? 0) + 1; }
          if ((this.spearMisses ?? 0) >= 3 && this.spearReachOk !== false) {
            this.spearReachOk = false;
            this.spearOffUntil = t + 6000; // 5 minutes, then it gets another chance
            this.say("My spear isn't reaching the creepers from out there: sword only for a while.");
          }
        } else {
          this.creeperHitAt = sc.t;
          if (sc.spear && sc.d > REACH_HIT) this.spearMisses = 0;
        }
      }
      if (t % SURVIVE_EVERY !== 0) {
        const l = e.location;
        this.fight({ id: e.id, type: 'creeper', entity: e, pos: { x: l.x, y: l.y, z: l.z }, lit: this.hissing(e) }, t);
      }
      return;
    }
    if (this.mode !== 'fight' || this.fightMove !== 'approach' || !e?.isValid || !this.motor.busy) return;
    if (dist3D(this.body.getPos(), e.location) <= STOP_AT) { this.motor.stop(); this.fightMove = 'hold'; }
  }

  /**
   * Several creepers at once (core/tactics.js creeperPlan): the plan for this tick, or null (the old rules). Keeps the state of the
   * encounter: whether we are on it (a wider range, so it doesn't flip at the edge), the 'lead's used, and a way out when nobody is
   * coming (a creeper over a ravine, behind glass): 8 s with none getting nearer and the old rules have it for half a minute.
   */
  creeperCrowd(d, t) {
    let st = this.crowdSt;
    const done = (why) => {
      if (st?.active) trace(`crowd: over after ${((t - st.since) / 20).toFixed(1)} s (${why}); hp ${st.hp0} -> ${this.health()}, ${st.n} seen, ${st.acts.join('/')}`);
      this.crowdSt = st && t < (st.offUntil ?? 0) ? { ...st, active: false } : null;
      return null;
    };
    if (!d.threats.length || d.mode === 'none') return done('no threat');
    if (t < (st?.offUntil ?? 0) || this.walling || this.digging || this.towered || this.sim.isInWater || this.testHold) return done('held off');
    const { creepers, company } = crowdOf(d.threats);
    const me = this.body.getPos();
    const plan = creeperPlan({
      me, shield: this.shield, health: this.health(), company, active: !!st?.active, leads: st?.leads ?? 0,
      creepers: creepers.map((m) => ({ pos: m.pos, d: m.dist, lit: !!m.lit })),
      safe: this.crowdSafe(),
    });
    if (!plan) return done(company ? 'company' : 'plan over');
    if (!st?.active) {
      st = this.crowdSt = { ...(st ?? {}), active: true, since: t, hp0: this.health(), n: creepers.length, acts: [], leads: st?.leads ?? 0, best: plan.nearest, bestAt: t, lastAct: null };
      if (t - this.lastShout > 200) { this.lastShout = t; this.say(plan.act === 'receive' ? `${creepers.length} creepers: shield up, letting them come.` : `${creepers.length} creepers: getting clear of them.`); }
    }
    st.n = Math.max(st.n, creepers.length);
    if (st.lastAct !== plan.act) {
      st.lastAct = plan.act; st.acts.push(plan.act);
      if (plan.act === 'lead') st.leads++;
      trace(`crowd: ${plan.act} (${plan.why}); nearest ${plan.nearest.toFixed(1)}, hp ${this.health()}, ${creepers.filter((m) => m.lit).length} hissing, shield ${this.shield ? 1 : 0}`);
    }
    // Waiting on them: none any nearer for 8 s (they are not coming): the old rules for half a minute.
    if (plan.nearest < st.best - 0.5) { st.best = plan.nearest; st.bestAt = t; }
    if (plan.act === 'receive' && t - st.bestAt > 160) {
      st.offUntil = t + 600;
      trace(`crowd: none of ${creepers.length} any nearer than ${st.best.toFixed(1)} for 8 s: back to the old rules`);
      return done('nobody coming');
    }
    st.last = t;
    return plan;
  }

  /** A place to take a blast: no drop of more than 2 beside us, no lava or fire close (its knock could throw us into them). */
  crowdSafe() {
    try {
      if (this.skills.dropsAround().some((e) => e.drop > 2 || BAD_BESIDE.test(e.landing ?? ''))) return false;
      const f = this.skills.feet();
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [-1, 0]) if (BAD_BESIDE.test(this.skills.blockAt({ x: f.x + dx, y: f.y + dy, z: f.z + dz }) ?? 'air')) return false;
      return true;
    } catch { return true; }
  }

  /**
   * One step of the several-creepers plan. 'receive': stand where we are, shield up, facing the middle of them, nothing swung (the
   * running jabs off too: a swing lowers the shield). 'outrun' / 'lead': sprint to the nearest spot clear of them (core/tactics.js
   * awayPathFrom), over a running route (no long drops), never past a creeper's nose. Returns true if it took the step; false: the old rules
   * (no way out found).
   */
  crowdMove(cp, threats, t) {
    const me = this.body.getPos();
    if (cp.act === 'receive') {
      this.fleeThreats = null;
      this.setBlocking(true);
      if (this.motor.busy) this.stopWalking();
      this.motor.setFocus(cp.face);
      return true;
    }
    this.setBlocking(false);
    // Already on the way (the route is kept for a second; a new one when it ends or a creeper starts to hiss).
    const lit = threats.filter((m) => m.type === 'creeper' && m.lit).map((m) => m.id).sort().join();
    if (this.motor.busy && t - (this.crowdRunAt ?? -1e9) < 20 && lit === this.crowdRunLit) return true;
    const wrap = (c) => avoidCreepers(c, threats.filter((m) => m.type === 'creeper').map((m) => m.pos), 3.5, me);
    const path = awayPathFrom(findPath, wrap(this.classifier()), me, cp.from, 400, this.fleeCosts());
    if (!path) { trace(`crowd: ${cp.act}: no way clear of them found: the old rules`); return false; }
    this.crowdRunAt = t; this.crowdRunLit = lit;
    this.routeSeq = (this.routeSeq ?? 0) + 1;
    this.fleeThreats = threats; // (a jab at one catching up is still fine while running)
    if (!this.jabbing) this.motor.setFocus(null);
    this.motor.followPath(smoothPath(this.classifier(), path), { seamless: true, urgent: true, walk: false });
    trace(`crowd: ${cp.act}: sprinting ${path.length - 1} blocks to ${Math.floor(path[path.length - 1].x)} ${path[path.length - 1].y} ${Math.floor(path[path.length - 1].z)}`);
    return true;
  }

  /**
   * Run (core/tactics.js pickRefuge): to a spot we can actually walk to, far from the threats, on
   * our side of them, and out of a shooter's sight if one is hitting us. Nowhere better: wall off
   * the way in, or get into the dead end nearby; failing both, we're cornered: stand and fight.
   * A creeper about to go off next to us with a shield on: face it, shield up, rather than race it.
   */
  flee(threats, t, crowd = null) {
    this.fleeThreats = threats;
    const me = this.body.getPos();
    if (crowd && this.crowdMove(crowd, threats, t)) return;
    const creeper = threats.find((m) => m.type === 'creeper');
    if (creeper && creeperMove({ me, creeper: creeper.pos, shield: this.shield, lit: creeper.lit }) === 'block') {
      this.setBlocking(true);
      if (this.motor.busy) this.motor.stop();
      this.motor.setFocus({ x: creeper.pos.x, y: creeper.pos.y + 1, z: creeper.pos.z });
      return;
    }
    this.setBlocking(false);
    if (!this.jabbing) this.motor.setFocus(null); // (turned to jab something catching up: leave the head on it)
    if (this.walling || this.digging) return;
    if (this.pinch(threats, t)) return;
    // An iron golem: no race to run, a pillar it cannot reach (core/tactics.js towerWorth). First thing, not the last resort.
    if (!this.towered && threats.some((m) => m.type === 'iron_golem' && m.dist <= 12) && this.towerUp(threats)) return;
    if ((t < this.nextRoute && this.motor.busy) || this.findingRefuge) return;
    // On a height with a long drop beside us (a pillar, a tree, a cliff top) and hurt: running is how it fell to its death in two of the
    // reports (a knock, a leap, a ledge in the dark). Stand and fight from there instead (the same switch as when cornered).
    if (this.health() < 12 && this.skills.dropsAround().some((e) => e.drop > 3)) {
      this.corneredUntil = t + 80;
      trace('flee: on a height with a drop beside me and hurt: standing my ground instead of running');
      return;
    }
    this.nextRoute = t + 30;
    this.findingRefuge = true;
    const gen = this.taskGen;
    const f = { x: Math.floor(me.x), z: Math.floor(me.z) };
    const cands = [];
    const probe = (x, y, z, w) => {
      if (w.standable(x, y, z)) cands.push({ x: x + 0.5, y, z: z + 0.5, cost: Math.hypot(x - f.x, z - f.z) });
      return false;
    };
    // Never past a creeper's nose on the way (core/tactics.js avoidCreepers), and up a ledge with a
    // block if that's the way out (the step-ups: a trench, a terrace, rough ground).
    const wrap = (c) => avoidCreepers(c, threats.filter((m) => m.type === 'creeper').map((m) => m.pos), 3.5, me);
    // The refuge candidates from the last search, if we've barely moved: the search to its cap was
    // 7 ticks a time, 25 times in one run, all for the same ground.
    const rc = this.refugeCache;
    const reuse = rc && t - rc.t < 120 && Math.hypot(rc.x - me.x, rc.z - me.z) < 6 && Math.abs(rc.y - me.y) < 2;
    // (900 nodes, not 2500: the spots to run to are within a dozen blocks, and the search used to run its whole cap, 7 ticks, 20 times in a report, for the same ground.)
    (reuse ? Promise.resolve(cands.push(...rc.cands)) : this.plan(me, me, 0, 900, probe, { wrap, actions: this.fleeActions(), costs: this.fleeCosts() })).then(() => {
      if (!reuse) this.refugeCache = { t, x: me.x, y: me.y, z: me.z, cands: cands.slice() };
      this.findingRefuge = false;
      if (gen !== this.taskGen || this.mode !== 'flee') return;
      // Out of sight: the ray from the shooter's eye to our chest there.
      const sees = (p, m) => { try { return canSee(this.dim, m.head, { x: p.x, y: p.y + 1.2, z: p.z }); } catch { return true; } };
      const now = this.body.getPos();
      const prefer = this.travelGoal && system.currentTick - this.travelGoal.at < 900 ? this.travelGoal : null;
      const spot = pickRefuge(now, threats, cands, sees, 3, prefer);
      if (spot) { this.routeTo(spot, 1, true, 3000, false, wrap, true); return; }
      if (this.buildSlot(threats, threats.filter((m) => m.dist <= 12).sort((a, b) => a.dist - b.dist)[0])) return; // cornered by zombies: a kill slot, not a sealed wall
      if (this.wallOff(threats)) return;
      if (this.towerUp(threats)) return; // nowhere to run, no way in to block: up out of their reach
      const deeper = pickRefuge(now, threats, cands, sees, 0.5, prefer);
      if (deeper) { this.routeTo(deeper, 0.5, true, 1500, false, wrap, true); this.nextRoute = system.currentTick + 8; return; }
      this.corneredUntil = system.currentTick + 200; // 10 s: fight back
      if (CONFIG.debug && !(this.corneredSaid > system.currentTick - 200)) console.warn('[agent] cornered: nowhere better to run');
      this.corneredSaid = system.currentTick;
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
  async routeTo(goal, tolerance, urgent, maxNodes, walk = false, wrap = null, climb = false) {
    const gen = this.taskGen, seq = this.routeSeq ?? 0;
    const fleeing = this.mode === 'flee';
    const res = await this.plan(this.body.getPos(), goal, tolerance, maxNodes, null, { ...(wrap ? { wrap } : {}), ...(fleeing ? { costs: this.fleeCosts() } : {}) });
    if (gen !== this.taskGen || seq !== (this.routeSeq ?? 0)) return;
    // No walking way there but one with a block or two to step up on (out of a trench, up a
    // terrace): that, a block under our feet at each step up (skills.followActionPath).
    if (climb && !res.complete) {
      const a = await this.plan(this.body.getPos(), goal, tolerance, maxNodes, null, { wrap, actions: this.fleeActions(), weight: 2 });
      if (gen !== this.taskGen || seq !== (this.routeSeq ?? 0)) return;
      if (a.complete && a.path.some((p) => p.move?.type === 'pillar') && a.path.every((p) => !p.move || ['pillar', 'leap', 'stair', 'bucketDrop'].includes(p.move.type))) {
        trace(`running: up a ledge (${a.path.filter((p) => p.move?.type === 'pillar').length} block(s))`);
        this.walling = true; // (the placing has the hands; flee doesn't re-route meanwhile)
        this.stopWalking();
        this.skills.followActionPath(this.taskGen, a.path).catch(() => false).finally(() => { this.walling = false; });
        return;
      }
    }
    // Stopped (or sent elsewhere) while it planned: a path that lands after a stop walked us on
    // into the creeper we'd stopped short of.
    if (res.path.length < 2) return;
    this.motor.followPath(smoothPath(this.classifier(), res.path), { seamless: true, urgent, walk });
  }

  /**
   * Costs for a running route: drops of 2 (1 when hurt) at most, no bucket drops and no jumps over a deep gap: the walking search allows drops of 3
   * and sure leaps, which is right at a leisurely walk and not with a mob at our back and half the health.
   */
  fleeCosts() {
    return { ...this.moveCosts(), maxDrop: this.health() < 10 ? 1 : 2, bucketDrop: 0, riskyLeap: null };
  }

  /** Moves a running route may make: put a block down to step up a ledge (up to 4), never dig. */
  fleeActions() {
    return { ...this.skills.actionOpts({ force: false }), breakCost: () => Infinity, placeCost: 1.5, budget: Math.min(this.skills.blockCount(), 4) };
  }

  /**
   * Cornered by zombies (nothing that shoots, climbs or blows up), nowhere to run and no way in to
   * block: up a 3-high pillar where they can't reach, and hit them from the top (core/tactics.js
   * towerWorth). Returns true if we're going up.
   */
  towerUp(threats) {
    if (this.towered || this.walling || (this.noTowerUntil ?? 0) > system.currentTick) return false;
    const f = this.skills.feet();
    const headroom = [1, 2, 3, 4, 5].every((k) => /^air$|grass|flower/.test(this.skills.blockAt({ ...f, y: f.y + k }) ?? 'stone'));
    if (!towerWorth({ threats, health: this.health(), blocks: this.skills.blockCount(), headroom })) return false;
    this.walling = true;
    this.stopWalking();
    trace(`cornered by ${threats.length} ${threats[0]?.type}: up a pillar`);
    this.say('Cornered: up a pillar, out of their reach.');
    (async () => {
      let up = 0;
      // (Each step under whatever task is current: the switch from running to fighting mustn't stop it half built.)
      for (let k = 0; k < TOWER_H; k++) { if (await this.skills.stepUp(this.taskGen).catch(() => false)) up++; else break; }
      const g = this.skills.feet();
      if (up === TOWER_H) this.towered = { x: g.x, z: g.z, top: g.y };
      else this.noTowerUntil = system.currentTick + 200;
    })().finally(() => { this.walling = false; });
    return true;
  }

  /** On top of our pillar still (towerUp)? */
  towerHolds() {
    const tw = this.towered;
    if (!tw) return false;
    const f = this.skills.feet();
    if (f.x !== tw.x || f.z !== tw.z || f.y < tw.top) { this.towered = null; return false; }
    return true;
  }

  /**
   * Running, and a melee mob is catching up: turn and jab it (the spear from out of its reach, the
   * sword if it's right on us), then run on (core/tactics.js fleeJab). Every tick while fleeing.
   */
  fleeJabTick(t) {
    const stopJab = () => { if (this.jabbing) { this.jabbing = false; this.motor.setFocus(null); } };
    if (this.mode !== 'flee' || !this.fleeThreats?.length) { stopJab(); return; }
    const me = this.body.getPos();
    // A creeper coming up on us first (spear it back while there's the chance), then the nearest
    // melee mob (core/tactics.js fleeJabOrder): each asked in turn till one's worth a jab.
    const live = [];
    for (const m of this.fleeThreats) {
      if (!m.entity || (MOBS[m.type]?.kind !== 'melee' && m.type !== 'creeper')) continue;
      let l;
      try { if (!m.entity.isValid) continue; l = m.entity.location; } catch { continue; }
      live.push({ m, l, type: m.type, d: dist3D(me, l) });
    }
    let best = null, how = null;
    for (const o of fleeJabOrder(live)) {
      if (!this.fleeJabSt.has(o.m.id)) { if (this.fleeJabSt.size > 16) this.fleeJabSt.clear(); this.fleeJabSt.set(o.m.id, {}); }
      how = fleeJab({
        me, mob: o.l, t, st: this.fleeJabSt.get(o.m.id), melee: true, creeper: o.type === 'creeper',
        hasSpear: !!this.spearId && this.spearReachOk !== false,
        spearReady: t >= Math.max(this.spearNext ?? 0, this.nextSwing), swordReady: t >= this.nextSwing,
      });
      best = o;
      if (how) break;
    }
    if (!best || !how) { stopJab(); return; }
    const chest = { x: best.l.x, y: best.l.y + 1, z: best.l.z };
    this.motor.setFocus(chest);
    this.jabbing = true;
    if (!this.facing(chest, 30)) return; // turning to it
    const id = how === 'spear' ? this.spearId : this.weaponId;
    if (id && id !== this.heldWeapon) { hold(this.sim, id); this.heldWeapon = id; }
    try { this.sim.attackEntity(best.m.entity); } catch {}
    this.nextSwing = t + 10;
    if (how === 'spear') this.spearNext = t + weaponReach(id).cooldown + 1;
    trace(`running: jabbed the ${best.m.type} with the ${how} at ${best.d.toFixed(2)}`);
    stopJab(); // and on
  }

  /**
   * Squeezed in a passage (a tunnel, the quarry stairs): a creeper coming one way, the rest the other.
   * Running either way runs into one of them. Two blocks across the creeper's way (core/tactics.js
   * pinchWallCells), only if that really cuts it off (not round a tree or up the next step), then a
   * kill slot across the other way if they're zombies, and the fight's with them. No blocks: dig
   * them out of the passage's side (alcoveCells), which leaves a pocket out of its line to duck into
   * if there's still not enough. Once per squeeze. Returns true while it's doing any of that.
   */
  pinch(threats, t) {
    if (this.walling || this.digging) return true;
    if (this.pinchWall && t - this.pinchWall.t < 600) return false; // (once: it's gone round, or over)
    if (this.pinchDig && t - this.pinchDig.t > 600) this.pinchDig = null;
    const me = this.body.getPos();
    const cr = threats.filter((m) => m.type === 'creeper' && m.dist <= 8).sort((a, b) => a.dist - b.dist)[0];
    if (!cr) return false;
    const across = (m) => (m.pos.x - me.x) * (cr.pos.x - me.x) + (m.pos.z - me.z) * (cr.pos.z - me.z) < 0;
    const rest = threats.filter((m) => m.type !== 'creeper' && m.dist <= 12 && across(m)).sort((a, b) => a.dist - b.dist);
    if (!rest.length) return false;
    const at = this.cellAt();
    let cells = this.pinchDig?.wall ?? pinchWallCells(me, cr.pos, at);
    if (cells && !this.pinchDig) {
      if (t < (this.pinchNext ?? 0)) return false;
      this.pinchNext = t + 10;
      // Cut off with it there? (its path to us, the wall solid)
      const w = this.classifier();
      const shut = new Set(cells.map((c) => `${c.x},${c.y},${c.z}`));
      try { if (findPath((x, y, z) => (shut.has(`${x},${y},${z}`) ? Cell.SOLID : w(x, y, z)), cr.pos, me, { tolerance: 1, maxNodes: 400 }).complete) cells = null; } catch { cells = null; }
    }
    if (!cells) return false;
    if (threats.some((m) => cells.some((c) => Math.floor(m.pos.x) === c.x && Math.floor(m.pos.z) === c.z && Math.abs(Math.floor(m.pos.y) - c.y) <= 1))) return false;
    const block = this.homestead.materialFor('stone');
    const have = block ? invCounts(this.sim)[block] ?? 0 : 0;
    const gen = this.taskGen;
    if (block && have >= cells.length) {
      this.walling = true;
      this.setBlocking(false);
      this.stopWalking();
      trace(`squeezed: walling off the creeper's way (${cells.length} blocks, creeper ${cr.dist.toFixed(1)}, ${rest.length} ${rest[0].type} the other way)`);
      this.homestead.placeFlow(gen, cells.map((c) => ({ cell: c, id: block })))
        .then(() => {
          const up = cells.filter((c) => this.skills.blockAt(c) === block);
          for (const c of up) this.skills.markPlaced(c);
          if (up.length) {
            this.pinchWall = { cells: up, block, t: system.currentTick };
            this.creeperWalls = [...(this.creeperWalls ?? []), { cells: up, block }];
            this.say('Walled the creeper off: now the rest.');
          }
          trace(`squeezed: wall up (${up.length}/${cells.length})`);
        })
        .catch(() => {})
        .finally(() => {
          this.walling = false;
          // The rest have the only way in now: a kill slot across it, if they're zombies.
          if (this.pinchWall && gen === this.taskGen) this.buildSlot(rest, rest[0]);
        });
      return true;
    }
    // Short of blocks: dig them out of the side.
    if (!this.pinchDig) {
      const al = alcoveCells(me, cr.pos, at);
      if (!al) return false;
      this.pinchDig = { wall: cells, into: al.into, t, ducked: false };
      this.digging = true;
      this.setBlocking(false);
      this.stopWalking();
      trace(`squeezed, ${have} blocks: digging ${al.cells.length} out of the side for them`);
      this.skills.mineFlow(gen, al.cells, () => ({ collect: true })).catch(() => {}).finally(() => { this.digging = false; });
      return true;
    }
    // Dug and still short: into the pocket, out of its line.
    if (!this.pinchDig.ducked) {
      this.pinchDig.ducked = true;
      this.motor.followPath([{ ...me }, this.pinchDig.into], { walk: true });
      return true;
    }
    return false;
  }

  /**
   * Tall melee mobs only (grown zombies and the like), at a dead end with them coming the one way
   * in: a block at our feet in the next cell toward them (and over head height if the ceiling's
   * higher) leaves a 1-high gap at eye level. They can't get through it or reach us over it; we
   * hit them through it (core/tactics.js killSlotCells). Returns true if we're putting it up.
   */
  buildSlot(threats, near) {
    if (this.slot || this.walling || !near?.pos || !threats?.length) return false;
    const ks = killSlotWorth({ threats, health: this.health() }) && killSlotCells(this.body.getPos(), near.pos, this.cellAt());
    if (!ks) return false;
    const block = this.homestead.materialFor('stone');
    if (!block || (invCounts(this.sim)[block] ?? 0) < ks.cells.length) return false;
    if (threats.some((m) => ks.cells.some((c) => Math.floor(m.pos.x) === c.x && Math.floor(m.pos.z) === c.z && Math.abs(Math.floor(m.pos.y) - c.y) <= 1))) return false;
    this.walling = true;
    this.setBlocking(false);
    this.stopWalking();
    const gen = this.taskGen;
    const me = this.body.getPos();
    trace(`kill slot: ${ks.cells.length} block(s) across the way in, ${threats.length} ${near.type} coming, nearest ${near.dist.toFixed(1)}`);
    // Our box can't be in the cell the block goes in: back to the middle of ours first.
    const back = Math.hypot(me.x - ks.stand.x, me.z - ks.stand.z) > 0.25 ? this.motor.followPath([{ ...me }, ks.stand], { walk: true }) : Promise.resolve();
    back.then(() => this.homestead.placeFlow(gen, ks.cells.map((c) => ({ cell: c, id: block }))))
      .then(() => {
        const up = ks.cells.filter((c) => this.skills.blockAt(c) === block);
        for (const c of up) this.skills.markPlaced(c);
        if (up.some((c) => c.y === ks.stand.y)) {
          this.slot = { ...ks, block };
          // Down again once they're dead (it's across our own way out).
          this.creeperWalls = [...(this.creeperWalls ?? []), { cells: up, block }];
          this.say('Blocked the tunnel with a gap to hit them through.');
        }
        trace(`kill slot: up (${up.length}/${ks.cells.length})`);
      })
      .catch(() => {})
      .finally(() => { this.walling = false; });
    return true;
  }

  /** Behind our kill slot: its block still there, and we're in the cell behind it. */
  slotHolds() {
    const s = this.slot;
    if (!s) return false;
    if (this.skills.blockAt(s.cells[0]) !== s.block) { this.slot = null; return false; }
    const me = this.body.getPos();
    return Math.floor(me.x) === Math.floor(s.stand.x) && Math.floor(me.z) === Math.floor(s.stand.z) && Math.abs(me.y - s.stand.y) < 0.6;
  }

  /**
   * Fighting from the kill slot: a mob on the far side of it is hit through the gap from the back of
   * our cell (a step there if we've drifted), never walked at. Else null (fight as usual).
   */
  slotMove(target, me, canSwing) {
    const s = this.slot;
    if (!s || !this.slotHolds()) return null;
    const beyond = (target.pos.x - s.stand.x) * s.dir.x + (target.pos.z - s.stand.z) * s.dir.z > 1;
    if (!beyond) return null;
    const off = Math.hypot(me.x - s.stand.x, me.z - s.stand.z);
    if (off > 0.25 && !this.motor.busy) { this.routeSeq = (this.routeSeq ?? 0) + 1; this.motor.followPath([{ ...me }, s.stand], { walk: true }); }
    return { stop: off <= 0.25, swing: canSwing };
  }

  /**
   * An arrow coming at us (fighting or running): a step aside, facing where we were (core/tactics.js
   * dodgeArrow). A skeleton aims where we are when it looses; it doesn't lead. Not with the shield
   * up at it: that stops it anyway. Every tick.
   */
  dodgeTick(t) {
    if ((this.mode !== 'fight' && this.mode !== 'flee') || (this.dodgeUntil ?? 0) > t) return;
    // Arrows, and a witch's splash potions (they splash round where they land: a wider berth).
    let ents = [];
    try {
      for (const type of ['minecraft:arrow', 'minecraft:splash_potion', 'minecraft:lingering_potion']) ents = ents.concat(this.dim.getEntities({ type, location: this.sim.location, maxDistance: 24 }));
    } catch { return; }
    if (!ents.length) return;
    const arrows = [];
    for (const e of ents) {
      try {
        const v = e.getVelocity();
        if (Math.hypot(v.x, v.y, v.z) < (e.typeId === 'minecraft:arrow' ? 0.3 : 0.05)) continue; // stuck in something
        if (this.blocking && this.facing(e.location, 60)) continue;
        arrows.push({ id: e.id, pos: e.location, vel: v, grow: e.typeId === 'minecraft:arrow' ? 0.25 : 1.2 });
      } catch {}
    }
    if (!arrows.length) return;
    const dg = dodgeArrow({ me: this.body.getPos(), arrows, at: this.cellAt() });
    if (!dg) return;
    this.routeSeq = (this.routeSeq ?? 0) + 1;
    this.motor.strafe(dg.dir, Math.min(8, dg.eta + 2));
    this.dodgeUntil = t + dg.eta + 2;
    this.nextRoute = Math.max(this.nextRoute ?? 0, this.dodgeUntil);
    trace(`arrow in ${dg.eta} ticks: stepping aside`);
  }

  /**
   * A long fall: water down on the block we'll land on, from the water bucket, as soon as it's in
   * reach (core/fall.js; tools/sim_fall.mjs), then the water scooped back up once we're in it.
   * Never in the Nether: water boils away there. Every tick.
   */
  fallTick(t) {
    const sim = this.sim;
    let onGround = true, inWater = false, loc = null;
    try { onGround = sim.isOnGround; inWater = sim.isInWater; loc = sim.location; } catch { return; }
    // Dead, or just moved further than any fall could in a tick (respawned, teleported): no fall.
    // The height from before a death was kept, and the first step off a block after respawning
    // read as a long fall: the bucket went down for nothing.
    const jumped = this.fallLast && Math.hypot(loc.x - this.fallLast.x, loc.y - this.fallLast.y, loc.z - this.fallLast.z) > 8;
    this.fallLast = { x: loc.x, y: loc.y, z: loc.z };
    if (this.health() <= 0 || jumped) { this.fallFrom = null; if (this.mlg && !this.mlg.done) this.mlg.done = true; return; }
    if (this.mlg && !this.mlg.done && (inWater || onGround) && t - this.mlg.t >= 2) this.scoopFallWater(t);
    if (onGround || inWater || sim.isClimbing) { this.fallFrom = null; return; }
    this.fallFrom = Math.max(this.fallFrom ?? loc.y, loc.y);
    if ((this.mlg && !this.mlg.done && t - this.mlg.t < 40) || this.testHold) return;
    if (this.dim.id === 'minecraft:nether' || !invCounts(sim).water_bucket) return;
    let v;
    try { v = sim.getVelocity(); } catch { return; }
    if (v.y > -0.3) return; // not really falling yet (a hop, a step down)
    // Where we'll come down: straight below where the drift takes us by then.
    const below = (x, z) => {
      try { return this.dim.getBlockFromRay({ x, y: loc.y, z }, { x: 0, y: -1, z: 0 }, { includeLiquidBlocks: true, includePassableBlocks: false, maxDistance: 96 })?.block ?? null; } catch { return null; }
    };
    let b = below(loc.x, loc.z);
    if (!b) return;
    const n = ticksToLand(loc.y, v.y, b.location.y + 1);
    const b2 = below(loc.x + v.x * n, loc.z + v.z * n);
    if (b2) b = b2;
    const id = b.typeId.replace('minecraft:', '');
    if (/water|lava|slime|hay_block|cobweb|powder_snow/.test(id)) return; // water already (safe), lava (nothing helps), soft landings
    const groundY = b.location.y + 1;
    const m = mlgNow({ fallFrom: this.fallFrom, y: loc.y, vy: v.y, groundY, health: this.health() });
    if (!m.place) return;
    const slot = hold(sim, 'water_bucket');
    if (slot < 0) return;
    this.motor.setFocus({ x: b.location.x + 0.5, y: groundY, z: b.location.z + 0.5 });
    let ok = false;
    try { ok = !!sim.useItemInSlotOnBlock(slot, b.location, Direction.Up); } catch {}
    this.mlg = { t, cell: { x: b.location.x, y: groundY, z: b.location.z }, d: loc.y - groundY, done: false };
    this.cellChanged?.();
    trace(`falling ${(this.fallFrom - groundY).toFixed(1)} (${m.damage} damage): water down ${(loc.y - groundY).toFixed(1)} above the ground${ok ? '' : ' (the game said no)'}`);
  }

  /** Landed in the water we put down: scoop it back into the bucket (a few tries, then leave it). */
  scoopFallWater(t) {
    const m = this.mlg;
    const sim = this.sim;
    if (invCounts(sim).water_bucket || t - m.t > 60) { m.done = true; this.motor.setFocus(null); return; }
    if ((t - m.t) % 4 !== 2) return; // every few ticks, not every one
    const slot = hold(sim, 'bucket');
    if (slot < 0) { m.done = true; return; }
    this.motor.setFocus({ x: m.cell.x + 0.5, y: m.cell.y + 0.5, z: m.cell.z + 0.5 });
    try { sim.useItemInSlotOnBlock(slot, m.cell, Direction.Up); } catch {}
    if (!invCounts(sim).water_bucket) { try { sim.useItemInSlot(slot); } catch {} }
    if (invCounts(sim).water_bucket) {
      m.done = true;
      this.motor.setFocus(null);
      this.cellChanged?.();
      this.say('Broke that fall with the water bucket.');
    }
  }

  /**
   * Where a step's time goes, for finding what holds the bot up (trace.jsonl, "step profile"): each
   * tick counts as moving (the motor's walking), planning (a path search running), breaking, or
   * other (placing, crafting, waiting, deciding, and plain standing about), with the longest
   * stretch of "other" in a row and what the log said just before it.
   */
  profileStep(name) {
    const p = this.prof;
    if (p && p.step !== name) this.profileEnd();
    if (!this.prof) { let at = null, inv = {}; try { const l = this.sim.location; at = { x: l.x, y: l.y, z: l.z }; inv = invCounts(this.sim); } catch { /* */ } this.prof = { step: name, ticks: 0, moving: 0, planning: 0, breaking: 0, other: 0, run: 0, worst: 0, worstAfter: '', at, inv, path: 0, last: at }; }
  }

  profileTick() {
    const p = this.prof;
    if (!p || this.mode !== 'none') return;
    p.ticks++;
    if (p.ticks % 10 === 0 && p.last) { try { const l = this.sim.location; p.path += Math.hypot(l.x - p.last.x, l.y - p.last.y, l.z - p.last.z); p.last = { x: l.x, y: l.y, z: l.z }; } catch { /* */ } }
    const kind = this.motor.busy ? 'moving' : (this.planning ?? 0) > 0 ? 'planning' : this.breaking ? 'breaking' : 'other';
    p[kind]++;
    if (kind === 'other') { p.run++; if (p.run > p.worst) { p.worst = p.run; p.worstAfter = this.skills.lastLog ?? ''; } } else p.run = 0;
    if (p.ticks >= 6000) this.profileEnd(); // (a long step: report every 5 minutes)
  }

  profileEnd() {
    const p = this.prof;
    this.prof = null;
    if (!p) return;
    // Where it ended up and what the pack did over the step: a step that ran for a few seconds, went nowhere and
    // changed nothing is the one to look at (four goto_table of 2 s in a row, at one spot).
    let net = 0, diff = 'unchanged';
    try {
      const l = this.sim.location;
      if (p.at) net = Math.hypot(l.x - p.at.x, l.y - p.at.y, l.z - p.at.z);
      diff = invDiff(p.inv, invCounts(this.sim));
      if (diff === 'nothing') diff = 'unchanged';
    } catch { /* */ }
    const wentNowhere = p.ticks >= 20 && p.ticks < 100 && net < 1.5 && diff === 'unchanged';
    if (p.ticks < 100 && !wentNowhere) return;
    const pc = (n) => `${Math.round((100 * n) / p.ticks)}%`;
    trace(`step profile: ${p.step} ${(p.ticks / 20).toFixed(p.ticks < 100 ? 1 : 0)} s: moving ${pc(p.moving)}, planning ${pc(p.planning)}, breaking ${pc(p.breaking)}, other ${pc(p.other)}; longest still ${(p.worst / 20).toFixed(1)} s, after "${p.worstAfter}"; walked ${Math.round(p.path)} blocks, ${net.toFixed(1)} from where it started${wentNowhere ? ' (NO PROGRESS)' : ''}; pack ${diff.length > 160 ? `${diff.slice(0, 160)}...` : diff}`);
  }

  /** Blocks as tactics.js reads them: 'open' | 'solid' | 'other'. */
  cellAt() {
    const w = this.classifier();
    return (x, y, z) => { const c = w(x, y, z); return c === Cell.AIR ? 'open' : c === Cell.SOLID || c === Cell.STEP || c === Cell.SLAB ? 'solid' : 'other'; };
  }

  /**
   * Cornered with a creeper coming and a hit that won't move it (core/tactics.js): wall it off.
   * Blocks across its way in, at feet and head (and higher if it's coming down at us), the straight
   * line first, one leading into the next (placeFlow). No sight of us, no fuse; no way in.
   */
  wallOffCreeper(me, mob, block) {
    if (this.walling) return;
    const cells = blockOffCells(me, mob, this.cellAt());
    if (!cells.length) return;
    this.walling = true;
    this.setBlocking(false);
    this.stopWalking();
    const gen = this.taskGen;
    trace(`creeper: walling it off (${cells.length} blocks, knockback room ${knockbackRoom(me, mob, this.cellAt())}, d ${dist3D(me, mob).toFixed(2)})`);
    this.say("Can't knock that creeper back from here: walling it off.");
    this.homestead.placeFlow(gen, cells.map((c) => ({ cell: c, id: block })))
      .then((r) => {
        const up = cells.filter((c) => this.skills.blockAt(c) === block);
        for (const c of up) this.skills.markPlaced(c);
        // Down again once it's gone (a wall across the quarry stairs is in our own way too).
        this.creeperWalls = [...(this.creeperWalls ?? []), { cells: up, block }];
        trace(`creeper: wall up (${r.placed}/${cells.length})`);
      })
      .catch(() => {})
      .finally(() => { this.walling = false; });
  }

  /**
   * Cornered with a creeper a hit won't move (core/tactics.js creeperFight's guard): one block at our
   * feet toward it, placed in a moment, and the fight goes on over the top of it. If it does go off,
   * the block takes most of the blast. Down again with the walls once it's gone.
   */
  guardAgainstBlast(me, mob, block) {
    if (this.walling || !block) return;
    const c = guardCell(me, mob, this.cellAt());
    if (!c) return;
    this.walling = true;
    const gen = this.taskGen;
    trace(`creeper: a block against the blast at ${c.x} ${c.y} ${c.z}, d ${dist3D(me, mob).toFixed(2)}`);
    this.homestead.placeAt(gen, c, block)
      .then((ok) => {
        if (ok && this.skills.blockAt(c) === block) {
          this.skills.markPlaced(c);
          this.creeperWalls = [...(this.creeperWalls ?? []), { cells: [c], block }];
        }
      })
      .catch(() => {})
      .finally(() => { this.walling = false; });
  }

  /**
   * Walls we put up against a creeper, taken down once there's no creeper within 16 (our own
   * blocks only: anything else in those cells is left alone).
   */
  async takeDownWalls(gen) {
    if (!this.creeperWalls?.length) return;
    let near = [];
    try { near = this.dim.getEntities({ type: 'minecraft:creeper', location: this.sim.location, maxDistance: 16 }); } catch {}
    // A kill slot: not while a zombie is still out there.
    if (this.slot) try { near = near.concat(this.dim.getEntities({ families: ['monster'], location: this.sim.location, maxDistance: 16 }).filter((e) => e.typeId !== 'minecraft:creeper')); } catch {}
    if (near.length) return;
    const walls = this.creeperWalls;
    this.creeperWalls = [];
    this.slot = null;
    for (const w of walls) {
      // (Never one that went into a hole in the house: taking it down would reopen the hole.)
      const houseCells = this.homestead.houseCells();
      const ours = w.cells.filter((c) => this.skills.blockAt(c) === w.block && !houseCells.has(`${c.x},${c.y},${c.z}`));
      if (!ours.length || dist3D(this.sim.location, ours[0]) > 24) continue;
      trace(`creeper gone: taking the wall down (${ours.length} blocks)`);
      for (const c of ours) if (!this.skills.inReach(c)) { await this.skills.goNear(gen, c, 3, 2); break; }
      await this.skills.mineFlow(gen, ours.filter((c) => this.skills.inReach(c)), () => ({ collect: true }));
    }
  }

  /** Stand still, and drop any path still being planned. */
  stopWalking() {
    this.routeSeq = (this.routeSeq ?? 0) + 1;
    if (this.motor.busy) this.motor.stop();
  }

  /**
   * Is this creeper hissing? Seen standing still to swell (hissing()); failing that, what its
   * fuse does: it starts once we're inside 2.5 and in its sight, and runs 1.5 s unless we get past 6.
   */
  creeperLit(target, e, d, t) {
    if (target.lit ?? this.hissing(e)) return true;
    const st = this.creeperSt.get(e.id);
    if (!st) return false;
    if (d <= CREEPER_LIGHT + 0.1 && target.visible !== false) st.fuseFrom ??= t;
    if (d > CREEPER_CALM) st.fuseFrom = undefined;
    return st.fuseFrom !== undefined && t - st.fuseFrom < 32;
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

  /**
   * A Minecraft command the brain made from the player's words ("make it day": time set day). Checked
   * again here against the same allowlist as the brain's (no op, ban, whitelist, permission...), run as
   * the server in the bot's dimension, then the others if that failed. The result is told in chat.
   */
  runMinecraft(command) {
    const cmd = String(command ?? '').trim().replace(/^\//, '');
    const root = cmd.split(/\s+/)[0]?.toLowerCase();
    const ok = new Set(['time', 'weather', 'gamemode', 'give', 'tp', 'teleport', 'effect', 'difficulty', 'gamerule', 'kill', 'summon', 'setblock', 'fill', 'clear', 'enchant', 'xp', 'title', 'playsound', 'particle', 'spawnpoint', 'setworldspawn', 'execute', 'say', 'tellraw', 'tag', 'replaceitem', 'clone', 'fog', 'camerashake', 'music']);
    if (!cmd || cmd.length > 240 || cmd.includes('\n') || !ok.has(root) || (root === 'execute' && !ok.has((cmd.match(/\brun\s+(\S+)/)?.[1] ?? '').toLowerCase()))) {
      this.say(`Won't run that: ${cmd.slice(0, 60)}`, true);
      trace(`mc: refused ${cmd.slice(0, 120)}`);
      return;
    }
    let err = null, done = false;
    for (const d of [this.dim, ...['overworld', 'nether', 'the_end'].map((n) => world.getDimension(n)).filter((d) => d.id !== this.dim.id)]) {
      try {
        const r = d.runCommand(cmd);
        if (r.successCount > 0 || root === 'say') { done = true; break; }
      } catch (e) { err = err ?? e; }
    }
    trace(`mc: ${cmd} -> ${done ? 'ok' : `failed: ${err ?? 'nothing matched'}`}`);
    this.say(done ? `Done: ${cmd}` : `That didn't work (${cmd}): ${String(err ?? 'nothing matched').replace(/^.*?: /, '').slice(0, 80)}`, true);
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
        case 'mc': this.runMinecraft(a.command); break;
        case 'stop':
          this.newTask(null); this.suspended = null; this.motor.stop();
          if (/** @type {any} */ (this).testProgress?.running) { /** @type {any} */ (this).testAbort = true; /** @type {any} */ (this).testSkipped = true; }
          if (this.autoEnabled) { this.autoEnabled = false; this.say('Stopped. Say "!bot auto" to let me carry on by myself.'); }
          break;
        case 'auto':
          this.autoEnabled = a.on !== false;
          if (this.autoEnabled) { this.autoDone = false; this.nextAutoTry = 0; }
          else if (this.task?.kind === 'auto') { this.newTask(null); this.motor.stop(); }
          this.say(this.autoEnabled ? 'Carrying on by myself.' : 'Waiting for orders.');
          break;
        case 'goal': {
          const key = goalKey(a.goal);
          if (!key) { this.say(`Goals: ${GOALS.map((g) => g.key).join(', ')}. Say "goal farm off", say.`); break; }
          this.setGoal(key, a.on !== false);
          this.say(`${GOALS.find((g) => g.key === key).label}: ${a.on !== false ? 'on' : 'off'}.`);
          break;
        }
        case 'beds':
          this.setBeds(a.on !== false);
          this.say(a.on !== false ? 'Sleeping at night again (a bed, and sheep for one if I need it).' : "No sleeping: I'll sit the nights out at home, and won't hunt sheep for a bed.");
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
        case 'mount': this.startMount(); break;
        case 'dismount': this.startDismount(); break;
        case 'tow': this.startTow(Math.floor(a.x), Math.floor(a.z)); break;
        case 'chain': { const it = chainItem(a.item); if (it) { this.addChain(it, Math.max(1, Math.min(256, Math.floor(a.n ?? 1)))); this.say(`Chain: ${chainOutline(it).join(' > ')}.`); } else this.say(`I don't know how to get ${a.item} yet.`); break; }
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
    // Who replaced a running job, for a test that reports "interrupted" (it never said what by).
    if (this.task && this.task.kind !== 'auto') this.lastTaskSwap = { tick: system.currentTick, from: this.task.kind, to: task?.kind ?? 'none', where: String(new Error().stack ?? '').split('\n').slice(2, 5).map((l) => l.trim().replace(/^at /, '')).join(' < ') };
    this.task = task;
    if (this.skills) this.skills.essential = false; // (the auto loop sets it again for its own jobs)
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

  /** `!bot tow <x> <z>`: the nearest boat (within 16) on a lead, towed to there, on foot or on the horse we're on. */
  startTow(x, z) {
    const gen = this.newTask({ kind: 'tow' });
    (async () => {
      const boats = this.dim.getEntities({ type: 'minecraft:boat', location: this.sim.location, maxDistance: 16 })
        .sort((p, q) => Math.hypot(p.location.x - this.sim.location.x, p.location.z - this.sim.location.z) - Math.hypot(q.location.x - this.sim.location.x, q.location.z - this.sim.location.z));
      const boat = boats[0];
      if (!boat) return this.say('No boat within 16 blocks to tow.', true);
      if (!(await this.skills.goNear(gen, boat.location, 2.5, 3))) this.say("Couldn't get next to the boat.", true);
      const how = this.tow.attach(boat);
      if (!how) return this.say("Couldn't put a lead on the boat (do I have one?).", true);
      const top = this.skills.groundTop(Math.floor(x), Math.floor(z));
      const m = await this.tow.run(gen, boat, { x: x + 0.5, y: Number.isFinite(top) ? top + 1 : this.sim.location.y, z: z + 0.5 }, { mount: this.horses.mounted() });
      this.say(m.arrived ? `Towed the boat there in ${m.secs} s (${m.holds} holds, ${m.tugs} unsticks).` : `Stopped towing: ${m.why || 'out of time'}${m.snapped ? ' (the lead broke)' : ''}.`, true);
    })().catch((e) => { if (e?.constructor?.name !== 'Aborted') console.warn(`[agent] tow: ${e}`); }).finally(() => { if (gen === this.taskGen) this.newTask(null); });
  }

  /** `!bot mount`: get on its horse (taming and saddling it first if it needs that and can). */
  startMount() {
    const gen = this.newTask({ kind: 'mount' });
    (async () => {
      const Hs = this.horses;
      const h = Hs.mounted() ?? Hs.find(64);
      if (!h) return this.say('No horse within 64 blocks.', true);
      const st = Hs.state();
      if (!st.tamed) { const r = await Hs.tame(gen, h); if (!r.ok) return this.say(`Couldn't tame the horse: ${r.how}.`, true); }
      if (!st.saddled && st.saddleInPack) await Hs.saddle(gen, h);
      const ok = await Hs.getOn(gen, h);
      if (ok) this.keepRiding = true;
      this.say(ok ? 'On the horse. `!bot dismount` to get off.' : "Couldn't get on the horse.", true);
    })().catch((e) => { if (e?.constructor?.name !== 'Aborted') console.warn(`[agent] mount: ${e}`); }).finally(() => { if (gen === this.taskGen) this.newTask(null); });
  }

  /** `!bot dismount`: off the horse; the plan carries on. */
  startDismount() {
    this.keepRiding = false;
    if (this.chainQueue()[0]?.item === 'riding_horse') this.popChain();
    const gen = this.newTask({ kind: 'dismount' });
    this.horses.getOff(gen).then((ok) => this.say(ok ? 'Off the horse.' : "Couldn't get off.", true)).catch(() => {}).finally(() => { if (gen === this.taskGen) this.newTask(null); });
  }

  /** `!bot village visit`: go to the best known village now and use it (a bed, the chests' food and iron). */
  startVillage(v, want = 'bed') {
    const gen = this.newTask({ kind: 'village', target: v });
    this.villages.visit(gen, v, want).then((r) => { if (gen === this.taskGen) { this.say(`Village: ${r}.`, true); this.newTask(null); } }).catch((e) => { if (gen === this.taskGen) { this.newTask(null); } else return; console.warn(`[agent] village visit: ${e}`); });
  }

  async runGoto(gen, target, tolerance) {
    let replans = 0, climbed = false, built = false;
    for (let seg = 0; seg < CONFIG.maxSegments; seg++) {
      if (gen !== this.taskGen) return;
      const from = this.body.getPos();
      const res = await this.plan(from, target, tolerance);
      if (gen !== this.taskGen) return;
      if (CONFIG.debug) {
        const end = res.path[res.path.length - 1];
        console.warn(`[agent] plan seg ${seg}: from ${from.x.toFixed(1)} ${from.y.toFixed(1)} ${from.z.toFixed(1)} to ${target.x} ${target.y} ${target.z} -> ${res.complete ? 'complete' : 'partial'}, ${res.path.length} nodes, ${res.expanded} expanded, ends ${end.x} ${end.y} ${end.z}`);
      }
      // No walking way there (a player up a tower, on a ledge, across a ravine): build, dig or bridge
      // one (skills.goNear's actions: pillar up, cut steps, bridge), before walking as close as we can.
      const end = res.path[res.path.length - 1];
      if (!res.complete && end && dist3D(end, target) > tolerance + 2 && dist3D(from, target) <= 64 && !built) {
        built = true; // (once a trip)
        let ok = false;
        try { ok = await this.skills.goNear(gen, target, Math.max(tolerance, 1), 2, { actionRange: 64 }); } catch (e) { if (gen !== this.taskGen) return; }
        if (gen !== this.taskGen) return;
        if (ok) break;
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
      const wps = smoothPath(this.classifier(), res.path);
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

  /**
   * The block classifier every search and path smoothing uses, with what it read shared between
   * them for a second: a goNear and its "through or around" search, a hunt re-routing every few
   * ticks, a sweep planning to each item in turn all look at the same blocks. Reading a block is
   * the slow part of a search in game. Cleared at once whenever we change a block ourselves
   * (cellChanged), so a search right after mining or placing never sees the old block.
   */
  classifier() {
    const now = system.currentTick;
    if (!this.cells || this.cellsDim !== this.dim.id || now - this.cellsAt > 20) {
      this.cells = new Map();
      this.cellsAt = now;
      this.cellsDim = this.dim.id;
      this.cellsBase = makeClassifier(this.dim);
    }
    const m = this.cells, base = this.cellsBase;
    return (x, y, z) => {
      const k = `${x},${y},${z}`;
      let c = m.get(k);
      if (c === undefined) { c = base(x, y, z); m.set(k, c); }
      return c;
    };
  }

  /** Path costs for now: long drops allowed with a water bucket (core/pathfinder.js bucketDrop). */
  moveCosts() {
    /** @type {any} */
    let c = DEFAULT_COSTS;
    try {
      if (this.dim.id !== 'minecraft:nether' && invCounts(this.sim).water_bucket && this.health() >= 8 && !this.testHold) c = { ...c, bucketDrop: 40 };
      // Air to spare and not hurt: routes may go under water (the surface never more than 5 blocks
      // up, core/pathfinder.js submerged; checkWater brings us up at half air whatever the route).
      if (this.body.airRatio() >= 0.95 && this.health() >= 10 && !this.testHold) c = { ...c, dive: 1.5 };
      // Jumps over a deep drop (void, a ravine): the sure ones only, and not at all if switched off.
      if (CONFIG.riskyJumps === false) c = { ...c, riskyLeap: null };
    } catch {}
    return c;
  }

  /** We broke or placed a block (or poured water): forget what the searches read. */
  cellChanged() { this.cells = null; this.cellGen = (this.cellGen ?? 0) + 1; }

  plan(from, to, tolerance, maxNodes = CONFIG.maxPathNodes, goalTest = null, extra = {}) {
    this.planning = (this.planning ?? 0) + 1;
    return new Promise((resolve0) => {
      const resolve = (r) => { this.planning = Math.max(0, (this.planning ?? 1) - 1); resolve0(r); };
      const base = this.classifier();
      const now = Date.now(), bad = this.badCells;
      // Places we got physically stuck at recently count as walls, so we don't try them again.
      const classify0 = bad.size ? (x, y, z) => ((bad.get(`${x},${y},${z}`) ?? 0) > now ? Cell.DANGER : base(x, y, z)) : base;
      // (extra.wrap: a search's own view on top, e.g. cells by a creeper counted dangerous while running.)
      const classify = extra.wrap ? extra.wrap(classify0) : classify0;
      // (u219 live: standing on a bed (9/16 high) the feet's cell is the bed, which reads as solid: every route from there began inside a block and
      // the walk stuck. On top of a block lower than a full one (a bed, a chest, a composter's rim), the search starts from the cell above it.)
      {
        const fx = Math.floor(from.x), fy = Math.floor(from.y), fz = Math.floor(from.z);
        try { if (classify(fx, fy, fz) === Cell.SOLID && from.y - fy > 0.3 && classify(fx, fy + 1, fz) === Cell.AIR) from = { x: from.x, y: fy + 1, z: from.z }; } catch { /* */ }
      }
      const t0 = system.currentTick;
      // A water bucket on us (not in the Nether, not badly hurt): long drops are fine (the fall's
      // broken with the water, fallTick), so a route can go off a pillar or a cliff edge.
      const costs = extra.costs ?? this.moveCosts();
      const stack = new Error().stack;
      const log = this.pathLog;
      const job = function* () {
        const r = yield* searchJob(classify, from, to, { tolerance, maxNodes, goalTest, costs, ...extra });
        const ticks = system.currentTick - t0;
        try { log.plan({ from, to, tolerance, maxNodes, goalTest, actions: !!extra.actions, r, ticks, stack }); } catch { /* a log never stops a search */ }
        if (ticks > 40) trace(`slow plan: ${ticks} ticks, ${r.expanded} nodes, ${r.complete ? 'complete' : 'partial'}${goalTest ? ' (search)' : ''}${extra.actions ? ' (actions)' : ''}`);
        resolve(r);
      };
      system.runJob(job()); // spreads the search over ticks so the server never hitches
    });
  }

  /** The boat (a plain one, a raft, a chest boat) e is sitting in, or null. */
  boatUnder(e) {
    try {
      const v = e.getComponent('minecraft:riding')?.entityRidingOn;
      return v?.isValid && /^minecraft:(chest_)?boat$/.test(v.typeId) ? v : null;
    } catch { return null; }
  }

  /** Out of the boat we're in (the player got out, or we stopped following). */
  leaveBoat() {
    const b = this.boatUnder(this.sim);
    if (!b) return false;
    try { b.getComponent('minecraft:rideable')?.ejectRider(this.sim); } catch {}
    this.body.resetProbe?.();
    trace('boat: got out');
    return true;
  }

  /**
   * Following, and they're in a boat: into its other seat, and sit tight until they get out (then
   * out too, and on following on foot). A chest boat has one seat: follow along the shore instead.
   * Returns true while the boat's what we're doing.
   */
  async followBoat(p) {
    const theirs = this.boatUnder(p);
    const ours = this.boatUnder(this.sim);
    if (ours && (!theirs || ours.id !== theirs.id)) { this.leaveBoat(); if (!theirs) { this.say('Out of the boat.'); return false; } }
    if (!theirs) return false;
    if (ours?.id === theirs.id) { if (this.motor.busy) this.motor.stop(); return true; }
    let rideable = null;
    try { rideable = theirs.getComponent('minecraft:rideable'); } catch {}
    const seats = rideable?.seatCount ?? 0;
    let riders = [];
    try { riders = rideable?.getRiders() ?? []; } catch {}
    if (!rideable || riders.length >= seats) {
      if (!this.boatFullSaid) { this.say("No seat for me in that boat: I'll follow along."); this.boatFullSaid = true; }
      return false;
    }
    this.boatFullSaid = false;
    const d = dist3D(this.body.getPos(), theirs.location);
    if (d <= 3.5) {
      this.motor.stop();
      let ok = false;
      try { ok = rideable.addRider(this.sim); } catch (e) { trace(`boat: couldn't get in: ${e}`); }
      if (ok) { this.say(`In the boat with you, ${this.task.player}.`); trace('boat: in'); }
      return ok;
    }
    // Over to it first (it may be out on the water: swimming's fine).
    const gen = this.taskGen;
    const res = await this.plan(this.body.getPos(), theirs.location, 2.5);
    if (gen !== this.taskGen) return true;
    if (res.path.length >= 2) this.motor.followPath(smoothPath(this.classifier(), res.path), { seamless: true, urgent: true });
    return true;
  }

  async updateFollow() {
    if (this.followClimb) return; // building our way up to them: let it finish
    // On a horse it keeps further back (a horse is wide and does not stop on a dime); worked out each time, so getting off or dying puts it back.
    const fd = CONFIG.followDistance + (this.horses?.mounted?.() ? 3 : 0);
    const p = this.findPlayer(this.task.player);
    if (!p) { this.leaveBoat(); this.say(`Lost ${this.task.player}.`); this.newTask(null); return; }
    if (await this.followBoat(p)) return;
    const gen = this.taskGen;
    const d = dist3D(this.body.getPos(), p.location);
    if (d <= fd + 0.5) {
      if (this.motor.busy) this.motor.stop();
      this.motor.glanceAt(p.getHeadLocation(), CONFIG.followRepathTicks + 5);
      return;
    }
    const res = await this.plan(this.body.getPos(), p.location, fd);
    if (gen !== this.taskGen) return;
    // No walking way to them (up a tower, over a gap): pillar, dig or bridge one, like a player would.
    const end = res.path[res.path.length - 1];
    if (!res.complete && (!end || dist3D(end, p.location) > fd + 2) && d <= 64) {
      this.followClimb = true;
      this.say(`No way up to you on foot, ${this.task.player}: building one.`);
      this.skills.goNear(gen, p.location, fd, 2, { actionRange: 64 }).catch(() => {}).finally(() => { this.followClimb = false; });
      return;
    }
    if (res.path.length < 2) return;
    this.motor.followPath(smoothPath(this.classifier(), res.path), { seamless: true });
  }
}
