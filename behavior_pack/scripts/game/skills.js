// Things the agent knows how to do with its hands: find blocks, mine, pick up drops, place, craft,
// dig down to stone. Every skill is async, takes the task generation `gen`, and bails out as soon
// as the agent switches task (a fight, a command) so nothing keeps running in the background.
import { system, world, Direction, BlockTypes, BlockVolume, ItemTypes, ItemStack } from '@minecraft/server';
import { isNight } from '../core/settle.js';
import { wetCones, towardWet, ExploreStall } from '../core/explore.js';
import { tourStops, sweepOrder } from '../core/flow.js';
import { EYE_HEIGHT } from '../core/motor.js';
import { TUNING } from '../core/calibrate.js'; // (useGap: ticks between one item use and the next, the game refuses sooner)
import { smoothPath, Cell, isWalkMove, isGround, DEFAULT_COSTS } from '../core/pathfinder.js';
import { dist3D, viewVector } from '../core/mathutil.js';
import { toolFor, planCrafts, applyCraft, isLog, isPlanks, STONE_TARGETS, SHOVEL_BLOCKS, PICKAXE_BLOCKS, TOOL_STONE, count } from '../core/recipes.js';
import { canBreak, chooseTool, breakSeconds, cheapestPlaceable, spendableBlocks, blockSourceCost, itemValue, plankReserve } from '../core/costs.js';
import { invCounts, hold, take, give, container, findSlot } from './inventory.js';
import { chooseSource, chooseSourceSticky, sourceKey, trustFor, trunksOf, EXPLORE_S, DIG_DOWN_S } from '../core/sourcing.js';
import { THIN_COVER, castRay, canSee, ONE_TAP, isWatery } from './world.js';
import { CONFIG } from '../config.js';
import { wantScore, biomeName } from '../core/biomes.js';
import { trace } from './bridge.js';
import { inside as houseInside } from '../core/house.js';
import { saplingFor, needs2x2, plantProblem } from '../core/saplings.js';
import { blockValue } from '../core/wants.js';
import { depositPlan, FULL_SLOTS } from '../core/storage.js';

export class Aborted extends Error {}

const strip = (id) => id.replace('minecraft:', '');
const center = (p) => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
const REACH = 4.5;
const FOOD_SET = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);
// Blocks that only form at the real surface (dirt and moss also show up in caves; sand is judged by terrain).
const TOPSOIL = /^(grass_block|podzol|mycelium|snow|snow_layer|farmland|grass_path|dirt_path)$/;
const STONEISH = /^(stone|deepslate|cobblestone|cobbled_deepslate|tuff|andesite|diorite|granite)$/; // solid rock to tunnel through (stone and deepslate drop cobblestone)
const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|concrete_powder|.*_concrete_powder)$/;
// Terrain the world generates. Only this counts as "ground over our head": a glass sky roof,
// a house, a tree or our own cobblestone pillar never makes a spot "underground".
const NATURAL_IDS = [
  'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'dripstone_block', 'smooth_basalt', 'bedrock',
  'dirt', 'coarse_dirt', 'dirt_with_roots', 'grass_block', 'podzol', 'mycelium', 'mud', 'clay', 'moss_block',
  'sand', 'red_sand', 'sandstone', 'red_sandstone', 'gravel',
  'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lit_redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore',
  'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore', 'deepslate_redstone_ore',
  'lit_deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore', 'raw_iron_block', 'raw_copper_block',
  'hardened_clay', 'terracotta', 'white_terracotta', 'orange_terracotta', 'yellow_terracotta', 'brown_terracotta', 'red_terracotta', 'light_gray_terracotta',
  'snow', 'powder_snow', 'ice', 'packed_ice', 'blue_ice', 'obsidian',
  'netherrack', 'basalt', 'blackstone', 'soul_sand', 'soul_soil', 'magma', 'crimson_nylium', 'warped_nylium', 'end_stone',
];
const NATURAL = new Set(NATURAL_IDS);
// Our tunnels' floors (Skills.tunnels): a world property of their own.
const TUNNELS_KEY = 'agent:tunnels';
// Never broken, however much it's in the way.
const UNBREAKABLE = /^(bedrock|barrier|command_block|chain_command_block|repeating_command_block|structure_block|jigsaw|end_portal_frame|end_portal|portal|end_gateway|obsidian|crying_obsidian|reinforced_deepslate|respawn_anchor|light_block.*|allow|deny|border_block)$/;
// Nothing to stand on or bump into (air and plants you walk through).
const OPEN = /^(air|short_grass|tall_grass|fern|large_fern|dead_bush|deadbush|snow_layer|vine|sweet_berry_bush|tall_dry_grass|short_dry_grass|bush|firefly_bush|leaf_litter|wildflowers|pink_petals|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|allium|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|light_block.*|structure_void)$/;
const TORCH = /^(wall_|soul_|redstone_|underwater_)?torch$/;
// Never land on these.
const BAD_LANDING = /lava|magma|fire|cactus|campfire|sweet_berry|powder_snow|pointed_dripstone|wither_rose/;
// Raycast filter: only ids this game version knows (an unknown id would make every raycast throw).
let naturalTypes = null;
const naturalTypeIds = () => (naturalTypes ??= NATURAL_IDS.map((id) => `minecraft:${id}`).filter((id) => { try { return !!BlockTypes.get(id); } catch { return false; } }));

/** How far from the house its quarry may be (blocks). */
const QUARRY_R = 32;

/** Blocks a torch can stand on (any full solid block of the kind we dig through). */
const SOLID_FLOOR = /^(stone|deepslate|cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff|dirt|coarse_dirt|grass_block|gravel|sandstone|red_sandstone|calcite|mud|clay|podzol|rooted_dirt|packed_mud|.*_planks|.*_ore|polished_.*|smooth_stone|terracotta|.*_terracotta)$/;

/** @type {WeakMap<Function, string[]>} block ids per scan predicate */
const TYPE_CACHE = new WeakMap();

export class Skills {
  /** Set if the native block query ever fails: fall back to the walk for the rest of the session. */
  static noFastScan = false;

  constructor(agent) {
    this.a = agent;
    this.placed = new Set(); // blocks we put down ourselves (pillars): fair game to dig out again
    /** @type {Array<{x: number, y: number, z: number}>} blocks goSee put down to see from (a pillar by a roof fire): taken down after */
    this.builtUp = [];
    // Running a job that can't be done without getting somewhere (home, the furnace, the chest): a
    // way there that's blocked by anything breakable gets broken through (actionOpts).
    this.essential = false;
    this.ourDrops = new Map(); // item entities our breaks made, watched by id until picked up (invalid)
    /** @type {{x:number,y:number,z:number,at:number}[]} */
    this.dropSpots = []; // recent breaks, rescanned for drops that spawn a tick late
    this.getDownStats = { hops: 0, digs: 0 };
    /** @type {Map<string, number>} item entity id -> tick it's written off until (couldn't get to it) */
    this.unreachableItems = new Map();
    /** @type {Record<string, {n: number, at: number, since?: number}>} explore trips per want that found nothing */
    this.exploreMiss = {};
    this.exploreGaveUp = {};      // want -> until when (ms) we've stopped looking for it (explore got nowhere)
    this.exploreStall = null;
    this.memVisits = new Map();       // remembered spot -> { at, n }: trips there that came to nothing
    // Chunks we've walked through (exploring prefers new ones), kept in the world's memory.
    this.visited = new Set(agent.memory?.data.visited ?? []);
  }

  markPlaced(p) {
    if (this.placed.size > 4000) this.placed.clear();
    this.placed.add(`${p.x},${p.y},${p.z}`);
  }

  placedByMe(p) {
    return this.placed.has(`${p.x},${p.y},${p.z}`);
  }

  /**
   * A block we stood on to get somewhere up top (a pillar up a tree, a step onto a ledge): kept in
   * the world's memory until it's taken down again. Getting distracted on the way down (a fight,
   * the night coming) used to leave dirt pillars standing about. (Not down a mine: a pillar out of
   * a pit is the way back.)
   */
  markScaffold(p) {
    let under = false;
    try { under = this.isUnderground(); } catch {}
    if (under) return;
    const list = (this.a.memory.data.scaffold ??= []);
    const id = this.blockAt(p);
    if (!id || id === 'air') return;
    list.push({ d: this.dim.id, x: p.x, y: p.y, z: p.z, id, t: Date.now(), tries: 0 });
    if (list.length > 200) list.splice(0, list.length - 200);
    this.a.memory.save();
  }

  unmarkScaffold(p) {
    const list = this.a.memory.data.scaffold;
    if (!list?.length) return;
    const n = list.length;
    this.a.memory.data.scaffold = list.filter((e) => !(e.x === p.x && e.y === p.y && e.z === p.z));
    if (this.a.memory.data.scaffold.length !== n) this.a.memory.save();
  }

  /**
   * Take down what's left of our pillars within 24 blocks: from the ground beside each one, top
   * down (the order a player's reach allows). A block that's since become something else is
   * forgotten; one out of reach from the ground gets three tries, then it's left.
   * Returns how many came down.
   */
  async cleanupScaffold(gen) {
    const all = this.a.memory.data.scaffold ?? [];
    if (!all.length) return 0;
    const here = this.sim.location;
    const near = all.filter((e) => e.d === this.dim.id && Math.hypot(e.x + 0.5 - here.x, e.z + 0.5 - here.z) <= 24 && Math.abs(e.y - here.y) <= 12);
    if (!near.length) return 0;
    const gone = near.filter((e) => { const id = this.blockAt(e); return id !== null && id !== e.id; });
    for (const e of gone) this.unmarkScaffold(e);
    const cols = new Map();
    for (const e of near) if (this.blockAt(e) === e.id) { const k = `${e.x},${e.z}`; (cols.get(k) ?? cols.set(k, []).get(k)).push(e); }
    let down = 0;
    for (const col of cols.values()) {
      this.check(gen);
      col.sort((a, b) => b.y - a.y);
      const base = col[col.length - 1];
      // A pillar standing in a pit (the way back out of a shelter or a hole we dug) is left as it is: going down to
      // its foot to take it apart put us back in the pit, hemmed in, and the escape built it up again (a real run did that
      // six times in two minutes). Only ones we can reach from about our own level.
      if (this.sim.location.y - base.y > 1.6) { for (const b of col) this.unmarkScaffold(b); continue; }
      // Beside it, on the ground (never on it).
      if (!col.some((b) => this.inReach(b))) await this.goNear(gen, { x: base.x + 0.5, y: base.y, z: base.z + 0.5 }, 2.2, 2);
      for (const b of col) {
        const f = this.feet();
        if (f.x === b.x && f.z === b.z) break; // standing on it: leave it for another time
        if (!this.inReach(b)) { b.tries = (b.tries ?? 0) + 1; if (b.tries >= 3) this.unmarkScaffold(b); continue; }
        if (await this.mine(gen, b, { collect: true })) { this.unmarkScaffold(b); down++; }
      }
    }
    if (down) {
      this.log(`scaffold: took down ${down} block${down > 1 ? 's' : ''} of an old pillar`);
      this.a.sayOnce('scaffold', 'Taking down a pillar I left standing.', 300000);
    }
    this.a.memory.save();
    return down;
  }

  get sim() { return this.a.sim; }
  get dim() { return this.a.sim.dimension; }

  check(gen) {
    if (gen !== this.a.taskGen || !this.sim.isValid) throw new Aborted();
  }

  async wait(gen, ticks) {
    await system.waitTicks(ticks);
    this.check(gen);
  }

  log(msg) {
    this.lastLog = String(msg).slice(0, 120); // (the step profile says what came just before a long stand)
    trace(msg);
    if (CONFIG.debug) console.warn(`[agent] ${msg}`);
  }

  feet() {
    const p = this.sim.location;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  }

  eye() {
    const p = this.sim.location;
    return { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
  }

  // ---------- perception ----------

  /**
   * Blocks matching `pred(id)` near us, nearest first. Only blocks with an open face count
   * (something a player could actually see), and the scan is spread over ticks.
   */
  scan(pred, { radius = 24, below = 6, above = 12, limit = 32, background = false } = {}) {
    const dim = this.dim;
    const f = this.feet();
    const t0 = system.currentTick;
    // Fast path: one native query for just the matching block types, nearest first. The
    // block-by-block walk below took up to 2-3 s in a sparse wood (63k reads for radius 32), and
    // the bot stood there "thinking" before every tree.
    // Background jobs (the 30 s survey) take the tick-spread walk instead: one native query over
    // a volume full of stone blocks the whole server for ~0.2 s, a visible stutter every 30 s.
    const fast = background ? null : this.fastScan(pred, f, radius, below, above, limit);
    if (fast) return Promise.resolve(fast);
    return new Promise((resolve) => {
      const found = [];
      const job = function* () {
        for (let r = 0; r <= radius; r++) {             // expanding rings: nearest first, early exit
          for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              for (let dy = -below; dy <= above; dy++) {
                const p = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
                let b;
                try { b = dim.getBlock(p); } catch { continue; }
                if (!b || b.isAir || !pred(strip(b.typeId))) continue;
                if (!exposed(dim, p)) continue;
                found.push({ ...p, id: strip(b.typeId) });
              }
            }
            yield;
          }
          if (found.length >= limit) break;
        }
        found.sort((a, b) => dist3D(f, a) - dist3D(f, b));
        if (!background && system.currentTick - t0 > 40) trace(`slow scan: ${system.currentTick - t0} ticks, radius ${radius}, ${found.length} found`);
        resolve(found);
      };
      system.runJob(job());
    });
  }

  /** Block ids matching pred (full ids), from the engine's registry; cached per predicate. */
  typesFor(pred) {
    let t = TYPE_CACHE.get(pred);
    if (!t) {
      t = BlockTypes.getAll().map((b) => b.id).filter((id) => { try { return pred(strip(id)); } catch { return false; } });
      TYPE_CACHE.set(pred, t);
    }
    return t;
  }

  /** scan() with dimension.getBlocks: null if the engine call isn't available or fails. */
  fastScan(pred, f, radius, below, above, limit) {
    if (Skills.noFastScan) return null;
    const dim = this.dim;
    const ms0 = Date.now();
    try {
      const types = this.typesFor(pred);
      if (!types.length) return [];
      // Close in first: common blocks (stone) fill a big volume and the query's cost grows with
      // the matches, so only widen when the near search didn't find enough.
      let found = [];
      for (const r of radius > 8 ? [8, radius] : [radius]) {
        const vol = new BlockVolume({ x: f.x - r, y: f.y - below, z: f.z - r }, { x: f.x + r, y: f.y + above, z: f.z + r });
        const hits = dim.getBlocks(vol, { includeTypes: types, location: f, closest: Math.max(limit * 4, 32) }, true);
        found = [];
        for (const p of hits.getBlockLocationIterator()) {
          if (!exposed(dim, p)) continue;
          let id;
          try { id = strip(dim.getBlock(p)?.typeId ?? ''); } catch { continue; }
          if (!id || !pred(id)) continue;
          found.push({ x: p.x, y: p.y, z: p.z, id });
        }
        if (found.length >= limit) break;
      }
      found.sort((a, b) => dist3D(f, a) - dist3D(f, b));
      const ms = Date.now() - ms0;
      if (ms > 50) trace(`scan (fast): ${ms} ms, radius ${radius}, ${found.length} found`);
      return found;
    } catch (e) {
      Skills.noFastScan = true;
      trace(`fast scan unavailable, using the slow one: ${e}`);
      return null;
    }
  }

  blockAt(p) {
    try {
      const b = this.dim.getBlock(p);
      return b ? strip(b.typeId) : null;
    } catch {
      return null;
    }
  }

  /** The first solid block on the line from our eye to the target block's centre. */
  firstHit(p) {
    const e = this.eye();
    const c = center(p);
    const d = { x: c.x - e.x, y: c.y - e.y, z: c.z - e.z };
    const len = Math.hypot(d.x, d.y, d.z);
    try {
      const hit = castRay(this.dim, e, d, len + 0.5, { vines: true }); // (a vine on the block is in the way: break it first)
      return hit?.block.location;
    } catch {
      return undefined;
    }
  }

  inReach(p) {
    return dist3D(this.eye(), center(p)) <= REACH;
  }

  // ---------- the crosshair: what a player can actually click ----------
  // A player breaks or clicks what the crosshair is on, and it stops on anything with an outline
  // (a vine over a log, grass in front of a flower, the leaf before the trunk). The game's
  // breakBlock and useItemOnBlock take any block in reach, seen or not: every break and place goes
  // through these first, so the bot only does what a player could from where it stands.

  /** The block under the crosshair now, within reach: { location, face (outward normal), faceLocation } or null. */
  crosshair() {
    try {
      const e = this.sim.getHeadLocation(), r = this.sim.getRotation();
      const v = viewVector(r.y, r.x);
      const h = castRay(this.dim, e, v, REACH + 0.5, { crosshair: true });
      return h ? { location: h.location, face: h.face, faceLocation: h.faceLocation } : null;
    } catch { return null; }
  }

  /**
   * A point on block p the crosshair can be put on from eye e (nothing with an outline in front of
   * it): { pt } or, failing that, { blocker } (the first thing in the way of the most direct one).
   * Tries the middle and, on each face turned toward e, the face's middle and four points round it.
   */
  targetPoint(p, e = this.eye()) {
    const same = (a) => a && a.x === p.x && a.y === p.y && a.z === p.z;
    const pts = [center(p)];
    for (const [nx, ny, nz] of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const fc = { x: p.x + 0.5 + nx * 0.49, y: p.y + 0.5 + ny * 0.49, z: p.z + 0.5 + nz * 0.49 };
      if ((e.x - fc.x) * nx + (e.y - fc.y) * ny + (e.z - fc.z) * nz <= 0) continue; // (faces turned away)
      pts.push(fc);
      // (the two axes across the face)
      const ax = nx ? [[0, 1, 0], [0, 0, 1]] : ny ? [[1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0]];
      for (const [s1, s2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        pts.push({ x: fc.x + (ax[0][0] * s1 + ax[1][0] * s2) * 0.3, y: fc.y + (ax[0][1] * s1 + ax[1][1] * s2) * 0.3, z: fc.z + (ax[0][2] * s1 + ax[1][2] * s2) * 0.3 });
      }
    }
    let blocker = null;
    const first = pts.slice(1).sort((a, b) => dist3D(e, a) - dist3D(e, b))[0];
    for (const c of [pts[0], ...pts.slice(1).sort((a, b) => dist3D(e, a) - dist3D(e, b))]) {
      const d = { x: c.x - e.x, y: c.y - e.y, z: c.z - e.z };
      const len = Math.hypot(d.x, d.y, d.z);
      if (len > REACH + 0.6) continue;
      let h;
      try { h = castRay(this.dim, e, d, len + 0.3, { crosshair: true }); } catch { h = null; }
      if (same(h?.location)) return { pt: c };
      if (h && !blocker && (c === first || c === pts[0])) blocker = h.location;
    }
    return { pt: null, blocker };
  }

  /**
   * Placing into `cell` against neighbour n's face: a point on that face the crosshair gets onto
   * from eye e (we're on the open side of it and nothing's in the way; grass in the cell itself is
   * fine: a click on it puts the block there). null if there's none.
   */
  placePoint(cell, n, e = this.eye()) {
    const nx = cell.x - n.x, ny = cell.y - n.y, nz = cell.z - n.z; // (the face's outward normal)
    const fc = { x: n.x + 0.5 + nx * 0.5, y: n.y + 0.5 + ny * 0.5, z: n.z + 0.5 + nz * 0.5 };
    if ((e.x - fc.x) * nx + (e.y - fc.y) * ny + (e.z - fc.z) * nz <= 0.05) return null; // behind the face
    const ax = nx ? [[0, 1, 0], [0, 0, 1]] : ny ? [[1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0]];
    const pts = [fc];
    for (const [s1, s2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) pts.push({ x: fc.x + (ax[0][0] * s1 + ax[1][0] * s2) * 0.3, y: fc.y + (ax[0][1] * s1 + ax[1][1] * s2) * 0.3, z: fc.z + (ax[0][2] * s1 + ax[1][2] * s2) * 0.3 });
    for (const c of pts) {
      const q = { x: c.x - nx * 0.01, y: c.y - ny * 0.01, z: c.z - nz * 0.01 }; // (just inside n)
      const d = { x: q.x - e.x, y: q.y - e.y, z: q.z - e.z };
      const len = Math.hypot(d.x, d.y, d.z);
      if (len > REACH + 0.5) continue;
      let h;
      try { h = castRay(this.dim, e, d, len + 0.2, { crosshair: true }); } catch { h = null; }
      if (!h) continue;
      const L = h.location;
      const onN = L.x === n.x && L.y === n.y && L.z === n.z && h.face.x === nx && h.face.y === ny && h.face.z === nz;
      const inCell = L.x === cell.x && L.y === cell.y && L.z === cell.z;
      if (onN || inCell) return { pt: c, onN };
    }
    return null;
  }

  /**
   * Crosshair onto block p (at point pt, or wherever it can be): turns until it's really on it, the
   * way a player's hand does before the click. True once it is.
   */
  async aimOn(gen, p, pt = null, maxTicks = 14) {
    const at = pt ?? this.targetPoint(p).pt;
    if (!at) return false;
    this.a.motor.setFocus(at);
    for (let k = 0; k <= maxTicks; k++) {
      const h = this.crosshair();
      if (h && h.location.x === p.x && h.location.y === p.y && h.location.z === p.z) return true;
      if (k < maxTicks) await this.wait(gen, 1);
    }
    return false;
  }

  /**
   * Somewhere to stand, in reach of p, from where `ok(eye)` holds (the crosshair gets onto it):
   * walk there. The way a player steps round a wall to get at something behind it.
   */
  async goSee(gen, p, ok, maxNodes = 3000, { build = false } = {}) {
    const c = center(p);
    const goal = (x, y, z, w) => {
      if (!w.standable(x, y, z) && !(build && w.open(x, y, z) && w.open(x, y + 1, z))) return false;
      const e = { x: x + 0.5, y: y + EYE_HEIGHT, z: z + 0.5 };
      if (dist3D(e, c) > REACH - 0.3) return false;
      if (x === p.x && z === p.z && (y === p.y || y + 1 === p.y)) return false; // (not standing in it)
      return ok(e);
    };
    const res = await this.a.plan(this.sim.location, p, 0, maxNodes, goal);
    this.check(gen);
    if (res.complete) {
      if (res.path.length >= 2) await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
      this.check(gen);
      if (ok(this.eye())) return true;
    }
    if (!build) return false;
    // Nowhere on the ground to see it from (the top of a roof): up a few blocks to where we can,
    // the way a player does. The blocks are the caller's to take down again (this.builtUp).
    const ar = await this.a.plan(this.sim.location, p, 0, maxNodes, goal, { actions: { ...this.actionOpts(), bridge: false }, weight: 1.5 });
    this.check(gen);
    if (!ar.complete) return false;
    for (const q of ar.path) if (q.move?.place) (this.builtUp ??= []).push({ x: q.x, y: q.y - 1, z: q.z });
    if (!(await this.followActionPath(gen, ar.path, { sweep: false }))) return false;
    return ok(this.eye());
  }

  /** Take down what goSee built to see from (a pillar): top first, standing on it. */
  async takeDownBuilt(gen) {
    const cells = (this.builtUp ?? []).splice(0).sort((a, b) => b.y - a.y);
    for (const c of cells) {
      if (OPEN.test(this.blockAt(c) ?? 'air')) continue;
      await this.mine(gen, c, { collect: true, allowBelow: true }).catch(() => false);
      await this.wait(gen, 6); // (down onto the next)
    }
  }

  // ---------- placing ----------

  /**
   * Place the item in `slot` against `neighbor`'s face so it lands in `cell`. The game only accepts
   * a placement the player is looking at, so finish the (already smooth) turn with an exact aim.
   */
  async placeOn(gen, slot, neighbor, face, faceLoc, cell) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // First go: from where the crosshair already is (the aim before this got it near), no snap.
      // Didn't take: look straight at the face and try once more, the plain way.
      if (attempt) { try { this.sim.lookAtBlock(neighbor); } catch {} await this.wait(gen, 1); }
      await this.useGap(gen);
      let ok = false;
      try { ok = attempt === 1 ? this.sim.useItemInSlotOnBlock(slot, neighbor, face) : this.sim.useItemInSlotOnBlock(slot, neighbor, face, faceLoc); } catch {}
      this.lastUseTick = system.currentTick;
      for (let k = 0; k < 2; k++) {
        await this.wait(gen, 1);
        if (!OPEN.test(this.blockAt(cell) ?? 'air')) { this.a.cellChanged?.(); this.afterUse(slot); return true; }
      }
      if (ok) { this.a.cellChanged?.(); this.afterUse(slot); return !OPEN.test(this.blockAt(cell) ?? 'air'); }
    }
    return false;
  }

  /**
   * The game takes one item use every 10 ticks (measured on BDS 1.26.51: 9 is refused, 10 taken;
   * game/calibrate.js measures it again at spawn) and refuses one sooner: it comes back `false`
   * and does nothing. Blocks laid one after another, or a seed right after a hoe, went nowhere
   * for that. So leave the gap since the last use.
   */
  async useGap(gen) {
    const gap = TUNING.useGap - (system.currentTick - (this.lastUseTick ?? -100));
    if (gap > 0) await this.wait(gen, gap);
    this.check(gen);
  }

  /**
   * Just used up the last of what was in `slot` (the last block placed, the last seed, the last
   * bite): show something else in hand, the weapon, else a nudge off the slot and back, so the
   * hand doesn't keep showing the item that's gone.
   */
  afterUse(slot) {
    try {
      const c = container(this.sim);
      if (!c || slot < 0 || c.getItem(slot)) return;
      if (this.a.weaponId && findSlot(this.sim, this.a.weaponId) >= 0) { hold(this.sim, this.a.weaponId); return; }
      this.sim.selectedSlotIndex = (slot + 1) % 9;
      this.sim.selectedSlotIndex = slot;
    } catch {}
  }

  /** Put the weapon back in hand (or an empty hand) after building or crafting. */
  restHands() {
    hold(this.sim, this.a.weaponId && findSlot(this.sim, this.a.weaponId) >= 0 ? this.a.weaponId : null);
  }

  /** How far (degrees) our view is off point c: the larger of the yaw and pitch errors. */
  aimError(c) {
    try {
      const e = this.sim.getHeadLocation(), r = this.sim.getRotation();
      const dx = c.x - e.x, dy = c.y - e.y, dz = c.z - e.z;
      const yaw = Math.atan2(-dx, dz) * 180 / Math.PI, pitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
      return Math.max(Math.abs(((yaw - r.y + 540) % 360) - 180), Math.abs(pitch - r.x));
    } catch { return 0; }
  }

  /**
   * Put the crosshair on c, the way a player does before a swing: near enough is enough (the head
   * keeps settling onto it while we break). No stop and no hold: the old look (settle to 2.5 deg,
   * hold 3 ticks, and it stopped the walk) cost 6-12 ticks a block. Leaves the focus on c.
   */
  async aim(gen, c, tol = 12, maxTicks = 10) {
    this.a.motor.setFocus(c);
    for (let k = 0; k < maxTicks && this.aimError(c) > tol; k++) await this.wait(gen, 1);
  }

  // ---------- movement ----------

  /** Walk until our feet are within `tolerance` of pos. Replans on stuck. */
  // (actionRange: how far off digging and building a way there is tried: 24; a player up a tower, 64.)
  async goNear(gen, pos, tolerance = 3, tries = 3, { actionRange = 24 } = {}) {
    let climbs = 0;
    for (let i = 0; i < tries + climbs; i++) {
      this.check(gen);
      const res = await this.a.plan(this.sim.location, pos, tolerance, i === 0 ? 8000 : 4000);
      this.check(gen);
      // Around, or through? A walking route that winds far past the straight line (a mangrove
      // swamp, a hedge of leaves, a wall of dirt) gets priced against one that breaks its way
      // through (break time with our best tool, in the same units as walking), cheapest wins.
      if (res.complete && res.path.length >= 2 && i === 0 && (await this.throughIfCheaper(gen, pos, tolerance, res))) return true;
      // The only way there runs through a current (3+ blocks of flowing water: a flooded crater, a
      // stream down a slope): stop it at its source and plan again, once, rather than fight it.
      if (i === 0 && res.path.length >= 2 && this.blockCount() >= 2) {
        const cls = this.a.classifier();
        const flow = res.path.filter((p) => cls(p.x, p.y, p.z) === Cell.FLOW || cls(p.x, p.y + 1, p.z) === Cell.FLOW);
        if (flow.length >= 3 && (await this.stopFlow(gen, flow.slice(0, 16))) > 0) { climbs++; continue; }
      }
      if (res.path.length >= 2) {
        const r = await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
        this.check(gen);
        if (this.spotted) return false; // saw what we were exploring for on the way: stop here
        if (r.status === 'arrived' && res.complete) return true;
      } else if (res.complete) return true;
      // Can't walk there: plan again allowing digging through and building up, and do that.
      if (!res.complete && climbs === 0 && dist3D(this.sim.location, pos) <= actionRange) {
        climbs++;
        // (Weighted toward the goal: a climb up a 40-high tower found in ~400 nodes, not 60,000.)
        const ar = await this.a.plan(this.sim.location, pos, tolerance, actionRange > 24 ? 20000 : 6000, null, { actions: this.actionOpts(), weight: 2 });
        this.check(gen);
        if (ar.complete && ar.path.some((p) => !isWalkMove(p))) {
          this.log(`digging/building my way there (${ar.path.filter((p) => !isWalkMove(p)).length} actions)`);
          if (await this.followActionPath(gen, ar.path)) return true;
        }
        continue;
      }
      // Up a ledge we can't walk onto, and close: put a block down and hop up (or cut a step).
      if (!res.complete && climbs < 4 && (await this.climbToward(gen, pos))) climbs++;
      else if (res.path.length < 2) break;
    }
    return dist3D(this.sim.location, pos) <= tolerance + 0.5;
  }

  /**
   * The walking route res winds a long way round: plan again allowing digging through (and
   * building up), and take that instead if it's clearly quicker (15% margin: breaking has risks
   * walking doesn't, like opening a cave or a water pocket). Returns true if it got there that way.
   */
  async throughIfCheaper(gen, pos, tolerance, res) {
    const here = this.sim.location;
    const straight = Math.hypot(pos.x - here.x, pos.z - here.z) + Math.abs(pos.y - here.y);
    if (straight > 32 || res.cost <= straight * 1.4 + 6) return false;
    const ar = await this.a.plan(here, pos, tolerance, 5000, null, { actions: this.actionOpts({ force: false }) });
    this.check(gen);
    const breaks = ar.path.filter((p) => !isWalkMove(p));
    if (!ar.complete || !breaks.length || ar.cost >= res.cost * 0.85) return false;
    this.log(`around: ${res.cost.toFixed(0)}, through: ${ar.cost.toFixed(0)} (${breaks.length} actions): going through`);
    this.a.sayOnce('through', `Quicker to cut through than walk round (${Math.round(ar.cost / 4.3)} s vs ${Math.round(res.cost / 4.3)} s).`, 60000);
    return this.followActionPath(gen, ar.path);
  }

  /**
   * Target up a wall within a few blocks: go up one level the cheapest way. Stand on a cheap
   * block (dirt costs nothing) if we carry one, otherwise cut a step into soft ground.
   */
  async climbToward(gen, pos) {
    const f = this.feet();
    const up = pos.y - f.y, flat = Math.hypot(pos.x - (f.x + 0.5), pos.z - (f.z + 0.5));
    if (up < 1.5 || flat > 8) return false;
    this.log(`climbing toward ${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)} (${up.toFixed(1)} up)`);
    // Walk up to the foot of the wall on the way to it.
    const ax = pos.x - (f.x + 0.5), az = pos.z - (f.z + 0.5);
    const d = Math.abs(ax) >= Math.abs(az) ? [Math.sign(ax), 0] : [0, Math.sign(az)];
    let k = 1;
    while (k <= 8 && OPEN.test(this.blockAt({ x: f.x + d[0] * k, y: f.y, z: f.z + d[1] * k }) ?? 'air') &&
      !OPEN.test(this.blockAt({ x: f.x + d[0] * k, y: f.y - 1, z: f.z + d[1] * k }) ?? 'air')) k++;
    if (k > 1 && k <= 8) {
      await this.a.motor.followPath([{ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }, { x: f.x + d[0] * (k - 1) + 0.5, y: f.y, z: f.z + d[1] * (k - 1) + 0.5 }]);
      this.check(gen);
    }
    if (this.placeableSlot() >= 0 && OPEN.test(this.blockAt({ ...this.feet(), y: this.feet().y + 2 }) ?? 'air')) {
      if (await this.stepUp(gen)) return true;
    }
    return this.stairStep(gen, false, [d]);
  }

  /**
   * Bridge one block: put a block against the side of the one we stand on (from), so `to` has a
   * floor, then step onto it. Works over a gap or over water.
   */
  async bridgeTo(gen, from, to) {
    const slot = this.placeableSlot();
    if (slot < 0) return false;
    const dx = to.x - from.x, dz = to.z - from.z;
    const floor = { x: from.x, y: from.y - 1, z: from.z };
    const cell = { x: to.x, y: to.y - 1, z: to.z };
    if (OPEN.test(this.blockAt(cell) ?? 'air') || /water/.test(this.blockAt(cell) ?? '')) {
      // Stand square on our block, near its front edge, looking down at where the new one goes.
      await this.a.motor.followPath([{ x: from.x + 0.5, y: from.y, z: from.z + 0.5 }]);
      this.check(gen);
      const face = dx > 0 ? Direction.East : dx < 0 ? Direction.West : dz > 0 ? Direction.South : Direction.North;
      const faceLoc = { x: dx > 0 ? 1 : dx < 0 ? 0 : 0.5, y: 0.5, z: dz > 0 ? 1 : dz < 0 ? 0 : 0.5 };
      if (!(await this.placeOn(gen, slot, floor, face, faceLoc, cell))) {
        // No side face to build against (it's the start of a bridge off a slab, say): try from below.
        const under = { x: cell.x, y: cell.y - 1, z: cell.z };
        if (OPEN.test(this.blockAt(under) ?? 'air') || !(await this.placeOn(gen, slot, under, Direction.Up, { x: 0.5, y: 1, z: 0.5 }, cell))) {
          this.restHands();
          return false;
        }
      }
      this.markPlaced(cell);
      this.restHands();
    }
    const r = await this.a.motor.followPath([{ x: from.x + 0.5, y: from.y, z: from.z + 0.5 }, { x: to.x + 0.5, y: to.y, z: to.z + 0.5 }]);
    this.check(gen);
    return r.status === 'arrived';
  }

  /** Jump and put a block under our feet: one level up, right here. */
  async stepUp(gen) {
    const f = this.feet();
    const slot = this.placeableSlot();
    if (slot < 0) return false;
    this.a.motor.lookAt({ x: f.x + 0.5, y: f.y - 1, z: f.z + 0.5 }, 1, 10);
    this.a.body.jump();
    let placed = false;
    for (let t = 0; t < 12 && !placed; t++) {
      await this.wait(gen, 1);
      if (this.sim.location.y >= f.y + 1.05) {
        try { this.sim.lookAtBlock({ x: f.x, y: f.y - 1, z: f.z }); } catch {}
        try { this.sim.useItemInSlotOnBlock(slot, { x: f.x, y: f.y - 1, z: f.z }, Direction.Up); } catch {}
        placed = !OPEN.test(this.blockAt(f) ?? 'air');
      }
    }
    this.afterUse(slot);
    await this.wait(gen, 6);
    this.a.cellChanged?.();
    if (placed) { this.markPlaced(f); this.markScaffold(f); }
    this.restHands();
    return placed && this.feet().y > f.y;
  }

  // ---------- paths that dig and build (Baritone-style) ----------

  /** What digging and pillaring cost right now, for the pathfinder's action moves. */
  actionOpts({ force = this.essential } = {}) {
    const inv = invCounts(this.sim);
    const cheapest = cheapestPlaceable(inv, this.blockReserve(inv));
    return {
      breakCost: (x, y, z) => {
        const p = { x, y, z };
        const id = this.blockAt(p) ?? 'air';
        if (OPEN.test(id)) return 0;
        if (/water|lava/.test(id) || this.isProtected(p)) return Infinity;
        // Never our own house: its walls, roof and furniture, or the ground it stands on. Blocks we
        // put down ourselves count as diggable, and the house is ours: one route in with the door
        // shut and a wall down went under the floor and up through it.
        if (this.a.homestead?.isHouseBlock?.(p)) return Infinity;
        // Something essential (home, the furnace, the chest, our things) walled off by anything at
        // all (a player's build, a chest, glass, wool): through it. Never our own house, or what
        // can't be broken.
        if (!this.isDiggable([p], { byHand: true }) && !(force && !UNBREAKABLE.test(id) && !this.a.homestead?.isHouseBlock?.(p))) return Infinity;
        if (this.touchesLiquid(p) || FALLING.test(this.blockAt({ x, y: y + 1, z }) ?? '')) return Infinity;
        const t = chooseTool(id, inv, { needDrop: false });
        return t ? t.seconds + 0.25 : Infinity; // + the time to aim and swing
      },
      placeCost: 0.8 + (cheapest ? itemValue(cheapest) * 0.3 : 0),
      budget: this.blockCount(),
      unitsPerSecond: 4.3,
    };
  }

  /** Follow a path from an actions search: walk the plain parts, dig and pillar where it says. */
  async followActionPath(gen, path, { sweep = true } = {}) {
    const cls = this.a.classifier();
    let i = 1;
    while (i < path.length) {
      this.check(gen);
      const n = path[i];
      if (isWalkMove(n)) {
        let j = i;
        while (j < path.length && isWalkMove(path[j])) j++;
        const r = await this.a.motor.followPath(smoothPath(cls, path.slice(i - 1, j)));
        this.check(gen);
        if (r.status !== 'arrived') return false;
        i = j;
        continue;
      }
      const m = n.move;
      for (const [x, y, z] of m.breaks) {
        const c = { x, y, z };
        for (let k = 0; k < 6 && !OPEN.test(this.blockAt(c) ?? 'air'); k++) { // sand/gravel can keep dropping in
          if (!(await this.mine(gen, c, { collect: false, allowBelow: m.type === 'digDown' }))) return false;
          if (FALLING.test(this.blockAt({ x, y: y + 1, z }) ?? '')) await this.wait(gen, 10);
        }
      }
      if (m.type === 'pillar') {
        if (!(await this.stepUp(gen))) return false;
      } else if (m.type === 'bridge') {
        if (!(await this.bridgeTo(gen, path[i - 1], n))) return false;
      } else if (m.type === 'digDown') {
        for (let t = 0; t < 20 && this.feet().y > n.y; t++) await this.wait(gen, 1);
      } else {
        const prev = path[i - 1];
        await this.a.motor.followPath([{ x: prev.x + 0.5, y: prev.y, z: prev.z + 0.5 }, { x: n.x + 0.5, y: n.y, z: n.z + 0.5 }]);
        this.check(gen);
      }
      const f = this.feet();
      if (Math.abs(f.x - n.x) > 1 || Math.abs(f.z - n.z) > 1 || Math.abs(f.y - n.y) > 1) return false; // knocked off course: replan
      i++;
    }
    if (sweep) await this.sweep(gen, this.sim.location, 4, null, 3); // what we dug up on the way
    return true;
  }

  /**
   * Out to the surface with one plan: walking, digging through, cutting steps and pillaring all
   * priced together (break times with our tools, the blocks we carry), cheapest route wins.
   */
  async actionEscape(gen) {
    const cache = new Map();
    const f0 = this.feet();
    // Somewhere out in the open and away from here (not just "the spot we're stuck on": on top of a
    // pillar in a tree, that spot passes every other test).
    const goal = (x, y, z, w) => Math.hypot(x - f0.x, z - f0.z) >= 3 && w.standable(x, y, z) &&
      !this.isUndergroundCached(x, y, z, cache) && this.rimClimb({ x, y, z }) <= 0;
    const heuristicFn = (x, y, z) => {
      const top = this.groundTop(x, z, cache);
      return Number.isFinite(top) ? Math.max(0, top + 1 - y) * 3 : 0;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.a.plan(this.sim.location, this.sim.location, 0, 15000, goal, { actions: this.actionOpts({ force: false }), heuristicFn });
      this.check(gen);
      if (!res.complete) { this.log(`escape plan: none (${res.expanded} searched)`); return false; }
      const kinds = {};
      for (const p of res.path) if (p.move) kinds[p.move.type] = (kinds[p.move.type] ?? 0) + 1;
      this.log(`escape plan: ${res.path.length} steps, ${JSON.stringify(kinds)}`);
      if (await this.followActionPath(gen, res.path)) return !(await this.needsEscape(gen));
      if (!(await this.needsEscape(gen))) return true;
    }
    return false;
  }

  /**
   * A spot we can use a block from (within reach, clear line of sight): a crafting table on a
   * ledge is used from below, not walked onto.
   */
  async reach(gen, p, tries = 3) {
    if (this.usable(p)) return true;
    const c = center(p);
    // Far off (our furnace back at the house, say): walk most of the way first. The in-reach
    // search below is short-range and just fails from 100+ blocks out.
    const far = dist3D(this.sim.location, c);
    if (far > 24) await this.travelToward(gen, c, Math.ceil(far / 40) + 2);
    // In reach AND in view: never use a table or furnace through a wall.
    const goal = (x, y, z, w) => w.standable(x, y, z) && Math.hypot(x + 0.5 - c.x, y + EYE_HEIGHT - c.y, z + 0.5 - c.z) <= REACH - 0.4 &&
      this.seesFrom({ x: x + 0.5, y: y + EYE_HEIGHT, z: z + 0.5 }, p);
    // Only a spot in reach (the view may be blocked by leaves, cleared below).
    const near = (x, y, z, w) => w.standable(x, y, z) && Math.hypot(x + 0.5 - c.x, y + EYE_HEIGHT - c.y, z + 0.5 - c.z) <= REACH - 0.4;
    for (let i = 0; i < tries; i++) {
      let res = await this.a.plan(this.sim.location, p, 0, 8000, goal);
      this.check(gen);
      // No spot with a clear view (leaves all round it): any spot in reach, then clear the view.
      if (!res.complete) { res = await this.a.plan(this.sim.location, p, 0, 8000, near); this.check(gen); }
      if (res.path.length >= 2) await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
      this.check(gen);
      if (this.usable(p) || (res.complete && this.inReach(p))) break;
      if (!res.complete && !(await this.climbToward(gen, c))) break;
    }
    if (this.usable(p)) return true;
    // In reach but a leaf, vine or tuft of grass in the way: swipe it aside, like a player would
    // (a furnace behind one leaf block was "unusable", so the job kept failing).
    for (let k = 0; k < 3 && this.inReach(p) && !this.usable(p); k++) {
      const hit = this.firstHit(p);
      const hid = hit ? this.blockAt(hit) ?? '' : '';
      if (!hit || !/leaves$|vine|grass|fern|flower|bush|snow_layer|azalea|propagule|moss_carpet/.test(hid)) break;
      if (!(await this.mine(gen, hit, { collect: false }))) break;
    }
    if (this.usable(p)) return true;
    this.log(`reach ${this.blockAt(p)} at ${p.x} ${p.y} ${p.z} failed: ${this.whyNotUsable(p)}`);
    return false;
  }

  /** For the trace: why a block isn't usable from here (distance, and what each sight line hits). */
  whyNotUsable(p) {
    const e = this.eye();
    const d = dist3D(e, center(p)).toFixed(2);
    const hits = [center(p), { x: p.x + 0.5, y: p.y + 0.9, z: p.z + 0.5 }].map((c) => {
      const dx = c.x - e.x, dy = c.y - e.y, dz = c.z - e.z, len = Math.hypot(dx, dy, dz);
      try {
        const h = castRay(this.dim, e, { x: dx, y: dy, z: dz }, len + 0.5);
        return h ? `${strip(h.block.typeId)}@${h.block.location.x},${h.block.location.y},${h.block.location.z}` : 'nothing';
      } catch (err) { return `err ${err}`; }
    });
    return `eye ${e.x.toFixed(1)} ${e.y.toFixed(1)} ${e.z.toFixed(1)}, dist ${d}, sight: ${hits.join(' / ')}`;
  }

  /** Close enough to use this block and nothing in the way (a player can't open a furnace through a wall). */
  usable(p) {
    return this.inReach(p) && this.sees(p);
  }


  // ---------- mining ----------

  /**
   * Break one block and pick up what drops. Gets in reach first, clears leaves in the way,
   * picks the right tool (never a pickaxe on dirt), looks at the block before swinging.
   */
  async mine(gen, p, { collect = true, depth = 0, allowBelow = false, force = false, next = null } = {}) {
    let id = this.blockAt(p);
    if (!id || id === 'air') return true;
    if (this.isProtected(p) && !force) return false; // a step of our own staircase or tunnel floor (force: ore in it, filled back in after)
    if (/water|lava/.test(id)) return false;
    if (!canBreak(id, invCounts(this.sim))) return false; // (obsidian without a diamond pickaxe, bedrock: never started on)
    if (this.touchesLava(p)) return false; // opening it would let lava in

    if (!this.inReach(p) && !(await this.goNear(gen, p, 3))) return false;
    if (!this.inReach(p) && !(await this.goNear(gen, p, 1.5))) return false;
    // The crosshair has to get onto it, as a player's does: what's in front (a vine over the log,
    // the leaves before the trunk, grass before the flower, the next block) comes out first, or we
    // step round to where we can get at it. No more breaking things through other things.
    let tp = this.targetPoint(p);
    // (A few rounds: what's in front, then a vine on the line to the block, then what that uncovers.)
    for (let round = 0; round < 3; round++) {
      for (let k = 0; !tp.pt && k < 3; k++) {
        const hit = tp.blocker;
        if (hit) {
          const hid = this.blockAt(hit) ?? '';
          const f0 = this.feet();
          const ownFloor = hit.x === f0.x && hit.z === f0.z && hit.y < f0.y;
          // (Ore we're after, seen through a cave's wall: the stone in front of it is dug, as a miner does.)
        const soft = ONE_TAP.test(hid) || /leaves|vine|grass|fern|flower|bush|snow_layer|lichen|roots|web|fire|litter|petals/.test(hid) || SHOVEL_BLOCKS.has(hid) ||
          (Skills.isOre(id) && STONEISH.test(hid) && !this.touchesLiquid(hit));
          // On an essential job, whatever's in front of it goes too (not our house, not liquid).
          const clearIt = !ownFloor && depth < 3 && !this.isProtected(hit) && (soft || (this.essential && !UNBREAKABLE.test(hid) && !/water|lava/.test(hid) && !this.a.homestead?.isHouseBlock?.(hit)));
          if (clearIt) {
            if (!(await this.mine(gen, hit, { collect: !soft, depth: depth + 1 }))) break;
            tp = this.targetPoint(p);
            continue;
          }
        }
        if (!(await this.goSee(gen, p, (e) => !!this.targetPoint(p, e).pt))) break;
        tp = this.targetPoint(p);
      }
      if (!tp.pt) break;
      // A vine is a thin sheet on the face of the block behind it. The crosshair can slip past its edge,
      // or take the block by its bare underside, but the vine is still hanging there: a player would look
      // at it and take it off first. Any vine on the line to the block's middle goes before the block does.
      const vh = depth < 3 ? this.firstHit(p) : null;
      if (!vh || (vh.x === p.x && vh.y === p.y && vh.z === p.z)) break;
      if (!THIN_COVER.test(this.blockAt(vh) ?? '') || this.isProtected(vh)) break;
      const f1 = this.feet();
      this.log(`vine over ${id} at ${p.x} ${p.y} ${p.z}: ${this.blockAt(vh)} at ${vh.x} ${vh.y} ${vh.z} first (from ${f1.x} ${f1.y} ${f1.z}), taking it off`);
      // (A vine can drop off by itself as the block it hung on goes: then there's nothing to take off.)
      if (!(await this.mine(gen, vh, { collect: false, depth: depth + 1 })) && THIN_COVER.test(this.blockAt(vh) ?? '')) { this.log(`couldn't take the ${this.blockAt(vh)} at ${vh.x} ${vh.y} ${vh.z} off ${id} at ${p.x} ${p.y} ${p.z}`); return false; }
      tp = this.targetPoint(p);
    }
    if (!tp.pt) { this.log(`can't get the crosshair on ${id} at ${p.x} ${p.y} ${p.z} (${tp.blocker ? `${this.blockAt(tp.blocker)} in the way` : 'out of sight'})`); return false; }

    // Grass, a flower, litter: one tap, no tool, no settling.
    if (ONE_TAP.test(id) && !(p.x === this.feet().x && p.z === this.feet().z && p.y < this.feet().y)) {
      const ok = await this.tap(gen, p, 25, next, tp.pt);
      if (ok && collect) await this.collect(gen, p, 4, 3, false);
      return ok;
    }

    id = this.blockAt(p);
    if (!id || id === 'air') return true;
    // Never dig out the floor we're standing on (or anything straight below us).
    const f = this.feet();
    if (!allowBelow && p.x === f.x && p.z === f.z && p.y < f.y) return false;
    // Cheapest way to break it that still gives us the block (break time plus tool wear): fists on
    // dirt and leaves, never a pickaxe on dirt, the lowest pickaxe that can harvest an ore.
    const inv = invCounts(this.sim);
    const tool = (chooseTool(id, inv, { needDrop: true }) ?? chooseTool(id, inv, { needDrop: false }))?.tool ?? null;
    hold(this.sim, tool);
    // Crosshair on it before the swing (the view could have moved while the tool came out).
    if (!(await this.aimOn(gen, p, tp.pt)) && !(await this.aimOn(gen, p))) { this.log(`crosshair wouldn't settle on ${id} at ${p.x} ${p.y} ${p.z}`); return false; }
    const expect = breakTicks(id, tool);
    // Last look before the swing: the view, or we, may have shifted since the check above. A vine
    // that's first on the line now comes off first, and then the crosshair goes back on the block.
    for (let round = 0; round < 3 && depth < 3; round++) {
      const late = this.firstHit(p);
      if (!late || (late.x === p.x && late.y === p.y && late.z === p.z)) break;
      if (!THIN_COVER.test(this.blockAt(late) ?? '') || this.isProtected(late)) break;
      const fl = this.feet(), e = this.eye();
      this.log(`vine still first at the swing: ${this.blockAt(late)} at ${late.x} ${late.y} ${late.z} over ${id} at ${p.x} ${p.y} ${p.z}, feet ${fl.x} ${fl.y} ${fl.z} eye ${e.x.toFixed(2)} ${e.y.toFixed(2)} ${e.z.toFixed(2)}, pt ${JSON.stringify(tp.pt)}`);
      if (!(await this.mine(gen, late, { collect: false, depth: depth + 1 })) && THIN_COVER.test(this.blockAt(late) ?? '')) return false;
      if (this.blockAt(p) !== id) return this.blockAt(p) === 'air' || !this.blockAt(p);
      tp = this.targetPoint(p);
      if (!tp.pt || !(await this.aimOn(gen, p, tp.pt))) return false;
    }
    {
      const late = this.firstHit(p);
      if (late && !(late.x === p.x && late.y === p.y && late.z === p.z) && THIN_COVER.test(this.blockAt(late) ?? '')) { this.log(`won't break ${id} at ${p.x} ${p.y} ${p.z} through the ${this.blockAt(late)} at ${late.x} ${late.y} ${late.z}`); return false; }
    }
    this.a.breaking = true; // (the step profile: breaking, not thinking)
    try {
      this.sim.breakBlock(p);
      const limit = expect * 2 + 40;
      for (let t = 0; t < limit; t++) {
        // The last moments of the break: the crosshair's already moving on to the next block (the
        // break carries on; a player's hand leads into the next swing, it doesn't stop dead).
        if (next && t >= expect - 2) this.a.motor.setFocus(center(next));
        await this.wait(gen, 1);
        if (this.blockAt(p) !== id) break;
      }
    } finally {
      this.a.breaking = false;
      try { this.sim.stopBreakingBlock(); } catch {}
      this.a.motor.setFocus(next ? center(next) : null);
    }
    // Snow layers and plants: if the swing didn't take (the break ray can miss thin blocks),
    // knock it out the way a punch would, with its normal drop.
    if (this.blockAt(p) === id && OPEN.test(id)) {
      try { this.dim.runCommand(`setblock ${p.x} ${p.y} ${p.z} air destroy`); } catch {}
    }
    this.a.cellChanged?.();
    if (this.blockAt(p) === id) return false;
    // A quick one: what landed within a couple of blocks we pick up by standing here; what bounced
    // further we walk over. (It used to settle 8 ticks and wait out every drop at our feet.)
    // (With a next block to go on to, we're staying put and what fell comes in on its own; with none, the job's over and
    // may walk straight off: wait the fresh drop out and pick it up, or it lies there. A packed-up table and furnace did.)
    if (collect) await this.collect(gen, p, 5, 4, !next);
    return true;
  }

  /**
   * Walk over dropped items near a spot so they get picked up. waitNear: also stand and wait out
   * a fresh drop right at our feet (can't be picked up for a moment); off between blocks of a job
   * (we're staying put, it comes in anyway), on for the last sweep.
   */
  async collect(gen, near, radius = 5, settleTicks = 8, waitNear = true) {
    await this.wait(gen, settleTicks); // let drops land
    await this.sweep(gen, near, radius, null, 6, waitNear);
  }

  /**
   * Pick up every item around `near` we can walk to (optionally only ones matching `pred`),
   * nearest first, for up to maxS seconds. Items we can't reach (on leaves, up a cliff) are
   * remembered for later rather than chased forever.
   */
  async sweep(gen, near, radius = 6, pred = null, maxS = 10, waitNear = true) {
    // Items we couldn't get to: written off for 2 minutes (they may be reachable from elsewhere),
    // plus ones skipped just for this sweep.
    const t0 = system.currentTick, writtenOff = this.unreachableItems, local = new Set(), tours = new Map();
    if (writtenOff.size > 500) writtenOff.clear();
    const skip = { has: (id) => local.has(id) || (writtenOff.get(id) ?? 0) > system.currentTick, add: (id) => writtenOff.set(id, system.currentTick + 2400) };
    for (let i = 0; i < 12 && system.currentTick - t0 < maxS * 20; i++) {
      this.check(gen);
      let items = [];
      try {
        items = this.dim.getEntities({ type: 'minecraft:item', location: near, maxDistance: radius })
          .filter((e) => !skip.has(e.id) && (!pred || pred(strip(e.getComponent('minecraft:item')?.itemStack?.typeId ?? ''))));
      } catch {}
      if (!items.length) break;
      const here = this.sim.location;
      // Positions now: an item can be picked up (or merge, or despawn) while we plan, and reading
      // a removed entity throws (that crash restarted the whole job every half minute).
      const withPos = items.map((e) => { try { return { e, id: e.id, loc: { ...e.location } }; } catch { return null; } }).filter(Boolean);
      if (!withPos.length) break;
      withPos.sort((a, b) => dist3D(here, a.loc) - dist3D(here, b.loc));
      // Several out of reach: one route through them (the next nearest from each), walked without
      // stopping, picked up as we pass: a player runs over a tree's drops or a patch of litter, he
      // doesn't walk to one, stand, plan and walk to the next. A plan that fails ends the route there;
      // the one-at-a-time way below (breaking through to it, writing it off) takes what's left.
      const far = withPos.filter((w) => dist3D(here, w.loc) >= (waitNear ? 1.2 : 1.8));
      if (far.length >= 2) {
        const chain = [];
        let at = here, left = far.slice();
        while (left.length && chain.length < 10) {
          left.sort((a, b) => dist3D(at, a.loc) - dist3D(at, b.loc));
          const w = left.shift();
          chain.push(w);
          at = w.loc;
        }
        let path = [], from = here;
        for (const w of chain) {
          const res = await this.a.plan(from, w.loc, 0.9, 1500);
          this.check(gen);
          if (!res.complete || !res.path.length) break;
          // (Each leg smoothed on its own: smoothing the whole route would cut straight past the items.)
          const leg = smoothPath(this.a.classifier(), res.path);
          path = path.length ? path.concat(leg.slice(1)) : leg;
          const end = res.path[res.path.length - 1];
          from = { x: end.x + 0.5, y: end.y, z: end.z + 0.5 };
        }
        if (path.length >= 2) {
          await this.a.motor.followPath(path);
          this.check(gen);
          // Any still lying there after the pass: a second pass at most, then written off for now.
          for (const w of chain) { try { if (w.e.isValid && dist3D(this.sim.location, w.e.location) > 1.5) { const n = (tours.get(w.id) ?? 0) + 1; tours.set(w.id, n); if (n >= 2) skip.add(w.id); } } catch { /* gone */ } }
          continue;
        }
      }
      const { e: it, id: itId, loc } = withPos[0];
      const gone = () => { try { return !it.isValid; } catch { return true; } };
      const stillFar = () => { try { return it.isValid && dist3D(this.sim.location, it.location) > 1.5; } catch { return false; } };
      if (dist3D(here, loc) < (waitNear ? 1.2 : 1.8)) {
        // Right at our feet: a fresh drop can't be picked up for a moment. Wait it out (or, mid-job,
        // leave it: we're staying here and it comes in on its own).
        if (!waitNear) { local.add(itId); continue; }
        for (let w = 0; w < 30 && !gone(); w += 3) await this.wait(gen, 3);
        if (!gone()) local.add(itId); // still here: something odd about it, move on for now
        continue;
      }
      const res = await this.a.plan(here, loc, 0.9, 1200); // (an item up out of reach ran the whole cap, then the breaking-through plan did the work)
      this.check(gen);
      if (gone()) continue;
      if (!res.complete) {
        // Wedged between leaves and dirt, up a step: break the way to it (leaves and dirt are
        // near-free by hand) rather than leave logs behind after chopping a tree.
        if (dist3D(here, loc) <= 16) {
          const ar = await this.a.plan(here, loc, 0.9, 4000, null, { actions: { ...this.actionOpts({ force: false }), budget: Math.min(3, this.blockCount()) } });
          this.check(gen);
          if (gone()) continue;
          if (ar.complete) {
            this.log(`item: breaking through to it (${ar.path.filter((p) => !isWalkMove(p)).length} actions)`);
            await this.followActionPath(gen, ar.path, { sweep: false });
            this.check(gen);
            await this.wait(gen, 4);
            if (stillFar()) skip.add(itId);
            continue;
          }
        }
        skip.add(itId);
        continue;
      }
      if (res.path.length >= 2) await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
      this.check(gen);
      await this.wait(gen, 2);
      if (stillFar()) skip.add(itId);
    }
    this.rememberItems(radius + 2); // anything left behind: remember it
  }

  /**
   * Plant a sapling of the tree's kind where its trunk stood (core/saplings.js has the rules):
   * dirt-type ground, room to grow, light, well clear of the house, our table and furnace and the
   * quarry stairs, not crowding another sapling. Dark oak and pale oak need four, in a 2x2.
   */
  async replant(gen, stump, logId) {
    const sap = saplingFor(logId);
    if (!sap) return false;
    const have = invCounts(this.sim)[sap] ?? 0;
    const two = needs2x2(sap);
    if (have < (two ? 4 : 1)) return false;
    const mem = this.a.memory;
    const planted = mem.data.saplings ?? (mem.data.saplings = []);
    const home = this.a.homestead?.house ?? this.a.homestead?.project;
    const avoid = [];
    if (home) avoid.push({ x: home.x, z: home.z, r: 8, why: 'too close to the house' });
    const farmW = mem.data.farm?.water;
    if (farmW) avoid.push({ x: farmW.x, z: farmW.z, r: 10, why: 'would shade the farm' });
    for (const cat of ['crafting_table', 'furnace']) for (const e of mem.list(cat, this.dim.id, stump).filter((e) => e.dist < 12 && (this.blockAt(e.pos) ?? cat).includes(cat))) avoid.push({ x: e.pos.x, z: e.pos.z, r: 3, why: `next to our ${cat.replace('_', ' ')}` });
    for (const k of [...(mem.data.stairs ?? []), ...(mem.data.quarry?.steps ?? [])]) {
      const [x, , z] = k.split(',').map(Number);
      if (Math.abs(x - stump.x) < 6 && Math.abs(z - stump.z) < 6) avoid.push({ x, z, r: 2.5, why: 'on the quarry stairs' });
    }
    const others = planted.map((k) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; }).filter((o) => Math.abs(o.y - stump.y) < 4);
    const light = (p) => { try { const b = this.dim.getBlock(p); return b ? Math.max(b.getLightLevel(), b.getSkyLightLevel()) : null; } catch { return null; } };
    const at = (p) => this.blockAt(p);
    const cells = two
      ? [[0, 0], [-1, 0], [0, -1], [-1, -1]].map(([ox, oz]) => [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => ({ x: stump.x + ox + a, y: stump.y, z: stump.z + oz + b })))
        .find((sq) => sq.every((c) => !plantProblem(c, sap, { at, light, avoid, others })))
      : [stump];
    const why = !cells ? 'no clear 2x2 of dirt here' : two ? null : plantProblem(stump, sap, { at, light, avoid, others });
    if (!cells || why) { this.log(`replant ${sap} at ${stump.x} ${stump.y} ${stump.z}: ${why}`); return false; }
    let ok = 0;
    for (const c of cells) {
      if (!this.inReach(c)) await this.goNear(gen, c, 2.5, 2);
      if (await this.a.homestead.placeAt(gen, c, sap, { x: c.x, y: c.y - 1, z: c.z })) {
        ok++;
        planted.push(`${c.x},${c.y},${c.z}`);
      }
    }
    if (planted.length > 100) planted.splice(0, planted.length - 100);
    mem.save();
    this.restHands();
    this.log(`replanted ${ok} ${sap} at ${stump.x} ${stump.y} ${stump.z}`);
    if (ok) this.a.sayOnce('replant', `Planted ${two ? 'four saplings' : 'a sapling'} where that tree was.`, 120000);
    return ok > 0;
  }

  /**
   * Keep the quarry lit (Bedrock: hostile mobs spawn at block light 0 under cover; a torch gives
   * 14, one less per block walked). Measured, not guessed: when the light where we stand in a
   * covered spot drops to 5 or less, put a torch on the floor of the step behind us. That keeps
   * every spot of a 1-wide staircase or tunnel, and the side pockets we mine, well above 0.
   * Makes torches from charcoal or coal on the spot if we're out (no table needed).
   */
  async lightQuarry(gen, back) {
    let b;
    try { b = this.dim.getBlock(this.feet()); } catch { return; }
    if (!b) return;
    let light, sky;
    try { light = b.getLightLevel(); sky = b.getSkyLightLevel(); } catch { return; }
    if (sky > 7 || light > 3) return;
    if (!invCounts(this.sim).torch) {
      const inv = invCounts(this.sim);
      if ((inv.charcoal ?? 0) + (inv.coal ?? 0) > 0) await this.craft(gen, ['torch'], false, true);
      if (!invCounts(this.sim).torch) { this.a.sayOnce('no-torch', 'Out of torches: the quarry will stay dark here.', 300000); return; }
    }
    const f = this.feet();
    const spots = [];
    if (back) spots.push(back);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) spots.push({ x: f.x + dx, y: f.y, z: f.z + dz }, { x: f.x + dx, y: f.y + 1, z: f.z + dz });
    for (const c of spots) {
      if ((this.blockAt(c) ?? '') !== 'air') continue;
      const below = { x: c.x, y: c.y - 1, z: c.z };
      if (!SOLID_FLOOR.test(this.blockAt(below) ?? 'air')) continue;
      if (await this.a.homestead.placeAt(gen, c, 'torch', below)) {
        this.log(`quarry: torch at ${c.x} ${c.y} ${c.z} (light here was ${light})`);
        this.restHands();
        return;
      }
    }
    this.log(`quarry: dark here (light ${light}) but no spot for a torch`);
  }

  /**
   * Punch held down and swept across one-tap blocks, like a player running a hand through grass:
   * each breaks the tick the crosshair is on it and we're straight on to the next, in order of
   * bearing so the head sweeps round instead of jumping back and forth. ~2 ticks a block (mine(),
   * with its checks and pick-up, was 10+). Only ones in reach. Returns how many broke.
   */
  async swipe(gen, cells, maxTicks = 200) {
    const t0 = system.currentTick;
    const order = this.sweepCells(cells, 'break');
    hold(this.sim, null); // a bare hand: no tool wear on grass
    let broke = 0;
    try {
      for (let i = 0; i < order.length; i++) {
        if (system.currentTick - t0 > maxTicks) break;
        if (await this.tap(gen, order[i], 25, order[i + 1] ?? null)) broke++;
      }
    } finally {
      this.a.motor.setFocus(null);
    }
    return broke;
  }

  /** Where we're looking, as flow.js wants it: { yaw, pitch } in radians (yaw along +x toward +z). */
  lookDir() {
    try { const v = this.sim.getViewDirection(); return { yaw: Math.atan2(v.z, v.x), pitch: Math.atan2(v.y, Math.hypot(v.x, v.z)) }; } catch { return { yaw: 0, pitch: 0 }; }
  }

  /**
   * Blocks in the order a hand sweeps across them (core/flow.js): each next one the least turn of
   * the head from the last, edges first, top down (breaking) or bottom up with something to place
   * against (placing). Placing: ones with nothing to go against yet come last, in their own order.
   */
  sweepCells(cells, mode = 'break', supported = null) {
    const order = sweepOrder(this.eye(), this.lookDir(), cells, { mode, supported });
    if (mode === 'place' && order.length < cells.length) {
      const got = new Set(order.map((c) => `${c.x},${c.y},${c.z}`));
      for (const c of cells) if (!got.has(`${c.x},${c.y},${c.z}`)) order.push(c);
    }
    return order;
  }

  /**
   * Break a set of blocks one leading into the next (the crosshair moves on as each goes), not one
   * by one with a stop and a fresh look between. optsFor(cell): mine()'s options for that block.
   * stop(cell) -> true: stop before it. Returns how many broke.
   */
  async mineFlow(gen, cells, optsFor = null, stop = null) {
    const order = this.sweepCells(cells, 'break');
    let n = 0;
    const spots = [];
    try {
      for (let i = 0; i < order.length; i++) {
        this.check(gen);
        if (stop?.(order[i])) break;
        if ((this.blockAt(order[i]) ?? 'air') === 'air') continue; // (already gone: snow, vines and grass still get cut)
        const o = optsFor ? optsFor(order[i]) : {};
        // Not a stop to pick up after each block (4 ticks standing, then a walk to what fell): on to
        // the next as it goes, and the drops are picked up in one pass at the end, over the route.
        const later = o.collect !== false && i < order.length - 1;
        if (await this.mine(gen, order[i], { ...o, collect: later ? false : o.collect, next: order[i + 1] ?? null })) { n++; if (later) spots.push(order[i]); }
      }
    } finally {
      this.a.motor.setFocus(null);
    }
    if (spots.length) {
      const mid = { x: spots.reduce((a, c) => a + c.x, 0) / spots.length, y: spots.reduce((a, c) => a + c.y, 0) / spots.length, z: spots.reduce((a, c) => a + c.z, 0) / spots.length };
      const r = Math.min(9, 4 + Math.max(...spots.map((c) => Math.hypot(c.x - mid.x, c.z - mid.z))));
      await this.collect(gen, mid, r, 3, true);
    }
    return n;
  }

  /** One swipe at a one-tap block: crosshair near it, hit, gone next tick. */
  async tap(gen, c, tol = 25, next = null, pt = null) {
    const id = this.blockAt(c) ?? 'air';
    if (!ONE_TAP.test(id) || !this.inReach(c) || this.isProtected(c)) return false;
    // (Only what the crosshair gets onto.) Grass among grass: it lands on a neighbour of the same
    // kind, whose top is as good as any. That one's coming out anyway; punch it and look again, the
    // way a player works through a patch, until the one wanted is in the clear.
    let aimed = await this.aimOn(gen, c, pt, 6);
    for (let k = 0; !aimed && k < 4; k++) {
      const ch = this.crosshair();
      const cid = ch ? this.blockAt(ch.location) ?? '' : '';
      if (!ch || !ONE_TAP.test(cid) || this.isProtected(ch.location)) break;
      if (ch.location.x === c.x && ch.location.y === c.y && ch.location.z === c.z) break;
      try { this.sim.breakBlock(ch.location); } catch {}
      await this.wait(gen, 1);
      try { this.sim.stopBreakingBlock(); } catch {}
      if (this.blockAt(ch.location) === cid) { try { this.dim.runCommand(`setblock ${ch.location.x} ${ch.location.y} ${ch.location.z} air destroy`); } catch {} }
      this.a.cellChanged?.();
      aimed = await this.aimOn(gen, c, this.targetPoint(c).pt ?? pt, 6);
    }
    if (!aimed) return false;
    try { this.sim.breakBlock(c); } catch {}
    // On to the next one as it goes (the hand sweeps through; it doesn't stop on each).
    if (next) this.a.motor.setFocus({ x: next.x + 0.5, y: next.y + 0.25, z: next.z + 0.5 });
    await this.wait(gen, 1);
    try { this.sim.stopBreakingBlock(); } catch {}
    // The break ray can miss something this thin: knock it out the way the punch would have.
    if (this.blockAt(c) === id) { try { this.dim.runCommand(`setblock ${c.x} ${c.y} ${c.z} air destroy`); } catch {} }
    this.a.cellChanged?.();
    return this.blockAt(c) !== id;
  }

  /**
   * Swipe through a patch of one-tap blocks (pred: grass for seeds, leaf litter), the way a player
   * runs through it with the punch held: everything in reach in one sweep, then on into the rest of
   * the patch, punching what comes into reach as we walk; again from there. Stops when enough() says
   * so, or the patch runs out (fewer than minRest left further off), or after maxTicks.
   * Returns { broke, spots: [cells broken] } (spots: where drops will be).
   * @param {any} gen
   * @param {(id: string) => boolean} pred
   * @param {{ radius?: number, rounds?: number, maxTicks?: number, minRest?: number, enough?: () => boolean }} [opts]
   */
  async swipePatch(gen, pred, { radius = 6, rounds = 6, maxTicks = 600, minRest = 3, enough = () => false } = {}) {
    const t0 = system.currentTick, spots = [];
    const isIt = (b) => pred(this.blockAt(b) ?? '');
    let broke = 0;
    for (let round = 0; round < rounds && system.currentTick - t0 < maxTicks && !enough(); round++) {
      // See-through (a sight line passes grass and litter rather than hitting them): what counts is
      // nothing solid in the way.
      const patch = (await this.scan(pred, { radius, below: 2, above: 2, limit: 48 }))
        .filter((b) => !this.a.memory.isUnreachable(b) && canSee(this.dim, this.eye(), { x: b.x + 0.5, y: b.y + 0.1, z: b.z + 0.5 }));
      this.check(gen);
      if (!patch.length) break;
      // A route through the patch, walked without stopping (core/flow.js tourStops): everything
      // comes into reach on the way and gets swiped on the move, the way a player runs through the
      // grass with the button held. (It used to stand and clear what was in reach, stop, plan the
      // next bit, walk, stop again.) What's all in reach already: swiped from here, in hand order.
      const far = patch.filter((b) => !this.inReach(b));
      const stops = far.length >= minRest || (round === 0 && far.length) ? tourStops(this.sim.location, far, 2.5, 8) : [];
      let path = [];
      let from = this.sim.location;
      for (const st of stops) {
        const res = await this.a.plan(from, { x: st.x + 0.5, y: st.y, z: st.z + 0.5 }, 1.5, 800);
        this.check(gen);
        if (!res.complete || res.path.length < 2) { this.a.memory.markUnreachable(st, 120000); continue; }
        path = path.length ? path.concat(res.path.slice(1)) : res.path;
        const end = res.path[res.path.length - 1];
        from = { x: end.x + 0.5, y: end.y, z: end.z + 0.5 };
      }
      let walking = path.length >= 2;
      if (walking) this.a.motor.followPath(smoothPath(this.a.classifier(), path), { walk: true }).finally(() => { walking = false; });
      hold(this.sim, null);
      try {
        // On the move: the nearest one in reach ahead of us, swiped as we pass; nothing in reach
        // yet, a tick of walking. Then whatever's still in reach where we end up.
        const bad = new Set(); // ones the crosshair wouldn't settle on: once is enough (a 64 s freeze went round the same block, 400 goes)
        for (let k = 0; k < 400 && !enough(); k++) {
          const here = this.sim.location;
          const c = patch.filter((b) => isIt(b) && this.inReach(b) && !bad.has(`${b.x},${b.y},${b.z}`)).sort((a, b) => Math.hypot(a.x + 0.5 - here.x, a.z + 0.5 - here.z) - Math.hypot(b.x + 0.5 - here.x, b.z + 0.5 - here.z))[0];
          if (c) { if (await this.tap(gen, c, walking ? 35 : 25)) { broke++; spots.push(c); } else { bad.add(`${c.x},${c.y},${c.z}`); this.log(`swipe: crosshair wouldn't settle on ${this.blockAt(c)} at ${c.x} ${c.y} ${c.z}, leaving it`); } continue; }
          if (!walking) break;
          this.a.motor.setFocus(null);
          await this.wait(gen, 1);
        }
      } finally { this.a.motor.setFocus(null); }
      if (enough()) break;
      const rest = patch.filter((b) => isIt(b) && !this.inReach(b));
      if (rest.length < minRest) break; // the odd block further off isn't worth the walk
    }
    this.restHands();
    return { broke, spots };
  }

  /**
   * Leaf litter: fuel for next to nothing. One layer burns 0.5 items, a block holds 1-4 layers and
   * breaks at a touch. Swiped through the whole patch (swipePatch), up to 64 layers (32 items of
   * cooking), ~15 s at most.
   */
  async grabLitter(gen) {
    const have = () => invCounts(this.sim).leaf_litter ?? 0;
    if (have() >= 64) return 0;
    const t0 = system.currentTick;
    let n = 0;
    const r = await this.swipePatch(gen, (id) => id === 'leaf_litter', { radius: 6, rounds: 4, maxTicks: 300, enough: () => have() + n * 2 >= 64 });
    n = r.broke;
    if (n) this.log(`leaf litter: swiped ${n} blocks for fuel in ${((system.currentTick - t0) / 20).toFixed(1)} s (had ${have()})`);
    return n;
  }

  /**
   * The item entities a break of ours just made (the drop spawns as the block goes): their ids, so
   * we know exactly which items on the ground are ours and whether they've come in (an item picked
   * up is gone). Nothing is waited on.
   */
  noteDrops(p) {
    if (this.ourDrops.size > 200) this.ourDrops.clear();
    // The drop can land a tick after the break, so the last few spots are looked at again later.
    if (p) this.dropSpots = [...(this.dropSpots ?? []).slice(-5), { x: p.x, y: p.y, z: p.z, at: system.currentTick }];
    const now = system.currentTick;
    this.dropSpots = (this.dropSpots ?? []).filter((s) => now - s.at <= 40);
    for (const s of this.dropSpots) {
      try {
        for (const e of this.dim.getEntities({ type: 'minecraft:item', location: { x: s.x + 0.5, y: s.y + 0.5, z: s.z + 0.5 }, maxDistance: 2.5 })) {
          if (!this.ourDrops.has(e.id)) this.ourDrops.set(e.id, { e, at: now });
        }
      } catch {}
    }
  }

  /**
   * Our drops lying out of pickup range: landed (not still falling or bouncing), further than
   * ~1.4 from us, within maxD. Gone ones (picked up, merged, despawned) are forgotten.
   */
  strayDrops(maxD = 4) {
    const out = [];
    this.noteDrops(null); // catch late spawns from the last breaks
    if (!this.ourDrops.size) return out;
    const here = this.sim.location;
    for (const [id, d] of this.ourDrops) {
      let loc, v;
      try { if (!d.e.isValid) { this.ourDrops.delete(id); continue; } loc = d.e.location; v = d.e.getVelocity(); } catch { this.ourDrops.delete(id); continue; }
      if (Math.hypot(v.x, v.y, v.z) > 0.05) continue; // still coming down
      const dist = Math.hypot(loc.x - here.x, loc.z - here.z);
      if (dist > 1.4 && dist <= maxD && Math.abs(loc.y - here.y) <= 1.5) out.push({ id, loc, dist });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /**
   * Chopping, between logs: a drop of ours lying off to the side gets picked up by stepping onto it,
   * but only when the next log (`next`) is still in reach from there, so the chopping carries straight
   * on (a player walking by would have them otherwise). Further ones wait for the tree's last sweep,
   * unless a player's close.
   */
  async grabStrayOnTheWay(gen, next) {
    let playerNear = false;
    try { playerNear = this.dim.getPlayers({ location: this.sim.location, maxDistance: 12 }).some((pl) => pl.id !== this.sim.id); } catch {}
    const stray = this.strayDrops(playerNear ? 6 : 3.5);
    for (const s of stray) {
      const spot = { x: s.loc.x, y: Math.floor(s.loc.y + 0.1), z: s.loc.z };
      const eye = { x: spot.x, y: spot.y + EYE_HEIGHT, z: spot.z };
      const reachNext = Math.hypot(next.x + 0.5 - eye.x, next.y + 0.5 - eye.y, next.z + 0.5 - eye.z) <= 4.5;
      if (!reachNext && !playerNear) continue;
      const res = await this.a.plan(this.sim.location, spot, 0.8, 200);
      this.check(gen);
      if (!res.complete) continue;
      if (res.path.length >= 2) await this.a.motor.followPath(res.path.map((c) => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 })), { walk: true });
      this.check(gen);
      return true; // one at a time, then back to the chopping
    }
    return false;
  }

  /** Log item stacks on the ground near p (valid entities only). */
  logItemsNear(p, r) {
    try {
      return this.dim.getEntities({ type: 'minecraft:item', location: p, maxDistance: r })
        .filter((e) => { try { return e.isValid && isLog(strip(e.getComponent('minecraft:item')?.itemStack?.typeId ?? '')); } catch { return false; } });
    } catch { return []; }
  }

  /**
   * Logs that landed on leaves (chopping the top of a trunk drops them into the canopy): break the
   * leaves under them so they fall to where we can walk. Leaves go in a moment by hand.
   */
  async dropStranded(gen, trunk) {
    for (let pass = 0; pass < 4; pass++) {
      let knocked = 0;
      for (const e of this.logItemsNear(trunk, 10)) {
        let l;
        try { l = { ...e.location }; } catch { continue; }
        const under = { x: Math.floor(l.x), y: Math.floor(l.y - 0.1), z: Math.floor(l.z) };
        if (!/leaves/.test(this.blockAt(under) ?? '')) continue;
        if (l.y - this.feet().y < 1.5) continue; // down at our level: the sweep walks to it
        this.log(`logs: one's up on the leaves at ${under.x} ${under.y} ${under.z}: knocking it down`);
        if (await this.mine(gen, under, { collect: false })) knocked++;
      }
      if (!knocked) break;
      await this.wait(gen, 10); // let them fall
    }
  }

  // ---------- memory: sources, survey, verification ----------

  /** Memory category for a block id, or null if it's not something worth remembering. */
  static categoryOf(id) {
    if (isLog(id)) return 'log';
    if (STONE_TARGETS.has(id)) return 'stone';
    const ore = id.match(/^(?:deepslate_)?(coal|iron|copper|gold|diamond|redstone|lapis|emerald)_ore$/);
    if (ore) return `${ore[1]}_ore`;
    if (id === 'crafting_table') return 'crafting_table';
    if (id === 'furnace' || id === 'lit_furnace') return 'furnace';
    return null;
  }

  /**
   * Look around and remember what's here: resource blocks with an open face, crafting tables,
   * and item stacks on the ground. Runs as a background job every ~30 s while idle-ish.
   */
  async survey() {
    const mem = this.a.memory, dimId = this.dim.id;
    // Only what's actually in view: stone or ore behind the ground (a cave under us) isn't known.
    const all = await this.scan((id) => Skills.categoryOf(id) !== null, { radius: 16, below: 8, above: 10, limit: 200, background: true });
    // Sight checks a few rays each: 20 blocks a tick, so a big survey never stalls the server.
    const found = [];
    for (let i = 0; i < all.length; i++) {
      if (i && i % 20 === 0) await system.waitTicks(1);
      try { if (this.sim.isValid && this.sees(all[i], Skills.categoryOf(all[i].id) === 'log')) found.push(all[i]); } catch {}
    }
    const clusters = new Map();
    for (const b of found) {
      const cat = Skills.categoryOf(b.id);
      if (cat === 'crafting_table' || cat === 'furnace') { mem.remember(cat, dimId, b); continue; }
      const k = `${cat}:${Math.floor(b.x / 8)},${Math.floor(b.y / 8)},${Math.floor(b.z / 8)}`;
      const c = clusters.get(k) ?? { cat, pos: b, n: 0 };
      c.n++;
      clusters.set(k, c);
    }
    for (const c of clusters.values()) mem.remember(c.cat, dimId, c.pos, c.n);
    this.rememberItems(24);
    try { this.a.homestead?.rememberAnimals(); } catch {}
    return found.length;
  }

  rememberItems(radius) {
    let items = [];
    try { items = this.dim.getEntities({ type: 'minecraft:item', location: this.sim.location, maxDistance: radius }); } catch {}
    for (const e of items) {
      try {
        const st = e.getComponent('minecraft:item')?.itemStack;
        if (st) this.a.memory.remember(`item:${strip(st.typeId)}`, this.dim.id, e.location, st.amount);
      } catch {}
    }
  }

  /** Is anything matching this memory category still near p? Items: a stack of that id. */
  stillThere(cat, p, r = 6) {
    if (cat.startsWith('item:')) {
      const id = `minecraft:${cat.slice(5)}`;
      try {
        return this.dim.getEntities({ type: 'minecraft:item', location: p, maxDistance: r })
          .some((e) => e.getComponent('minecraft:item')?.itemStack?.typeId === id);
      } catch { return false; }
    }
    // A block only counts if we could actually go for it: in view (logs through leaves), not
    // marked unreachable, not up out of reach. "There's a log somewhere in this cube" (inside a
    // wall, up a tree we can't climb) is how we ended up standing here forever.
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
      const id = this.blockAt(q);
      if (!id || Skills.categoryOf(id) !== cat) continue;
      if (this.a.memory.isUnreachable(q) || q.y - this.feet().y > 8) continue;
      if (this.inReach(q) || this.sees(q, cat === 'log')) return true;
    }
    return false;
  }

  /**
   * Go to a remembered source and check it. If it's gone, forget it (so it's never counted on
   * again) and say so. Returns true if it's there and we're next to it.
   */
  async visitMemory(gen, entry) {
    const label = entry.cat.replace(/^item:/, '').replace(/_/g, ' ');
    // Items: stand on them. Stone: go right down to it (a quarry is at the bottom of its stairs).
    const tol = entry.cat.startsWith('item:') ? 1 : entry.cat === 'stone' ? 2 : 5;
    // Only set off if there's a complete walking route. Following half a route toward something
    // behind a wall is how you end up rubbing against cave walls.
    // (A budget that grows with the distance: 25,000 nodes to a log 35 blocks off, across water, was a 3 s freeze for the same answer: no.)
    const cap = Math.max(6000, Math.min(15000, Math.round(dist3D(this.sim.location, entry.pos) * 300)));
    const res = await this.a.plan(this.sim.location, entry.pos, tol, cap);
    this.check(gen);
    if (!res.complete) {
      this.log(`no route to remembered ${label} at ${entry.pos.x} ${entry.pos.y} ${entry.pos.z}; skipping it for now`);
      this.a.memory.markUnreachable(entry.pos, 600000);
      // Its neighbours (the rest of that grove) have the same answer: don't spend a 20 s plan on each.
      try {
        for (const m of this.a.memory.list(entry.cat, this.dim.id, this.sim.location)) {
          if (dist3D(m.pos, entry.pos) <= 20) this.a.memory.markUnreachable(m.pos, 600000);
        }
      } catch {}
      return false;
    }
    // Came here recently and it came to nothing: this memory is wrong, drop it.
    const key = `${entry.cat}:${entry.pos.x},${entry.pos.y},${entry.pos.z}`;
    const visits = this.memVisits;
    const prev = visits.get(key);
    if (prev && Date.now() - prev.at < 180000 && prev.n >= 2) {
      this.a.memory.forgetNear(entry.cat, this.dim.id, entry.pos, 3);
      this.a.memory.markUnreachable(entry.pos, 600000); // and don't let the lookout put it straight back
      this.log(`remembered ${label} at ${entry.pos.x} ${entry.pos.y} ${entry.pos.z} came to nothing twice: forgotten`);
      visits.delete(key);
      return false;
    }
    visits.set(key, { at: Date.now(), n: (prev && Date.now() - prev.at < 180000 ? prev.n : 0) + 1 });
    this.a.sayOnce(`visit:${entry.pos.x},${entry.pos.z}`, `Going for ${label} I remember, ${Math.round(entry.dist)} blocks away.`);
    const ok = await this.goNear(gen, entry.pos, tol, 2);
    if (!ok && dist3D(this.sim.location, entry.pos) > 12) {
      this.a.memory.markUnreachable(entry.pos, 600000);
      return false;
    }
    if (this.stillThere(entry.cat, entry.pos, 5)) return true;
    this.a.memory.forgetNear(entry.cat, this.dim.id, entry.pos);
    this.a.say(`The ${label} I remembered here is gone.`);
    return false;
  }

  /** Pick up item stacks of these ids near a spot (used after visiting a remembered stash). */
  async pickUp(gen, pred, near, radius = 6) {
    for (let pass = 0; pass < 4; pass++) {
      let items = [];
      try {
        items = this.dim.getEntities({ type: 'minecraft:item', location: near, maxDistance: radius })
          .filter((e) => pred(strip(e.getComponent('minecraft:item')?.itemStack?.typeId ?? '')));
      } catch {}
      if (!items.length) break;
      let loc;
      try { loc = { ...items[0].location }; } catch { continue; } // picked up or gone already
      if (!(await this.goNear(gen, loc, 0.6, 1))) {
        await this.sweep(gen, loc, 1.5, pred, 6); // walking failed: break through to it
      }
      await this.wait(gen, 8);
    }
  }

  /** Candidates for `need` units of something, priced by core/sourcing.js. */
  sourceCandidates({ cat, itemPred, visible, perUnitS, extra = [] }) {
    const from = this.sim.location, mem = this.a.memory, dimId = this.dim.id;
    // With a house (or one under way), don't send us off to things far from it.
    const home = this.a.homestead?.house ?? this.a.homestead?.project;
    const nearHome = (m) => !home || Math.hypot(m.pos.x - home.x, m.pos.z - home.z) <= 96;
    const out = [...extra];
    if (visible) out.push({ kind: 'visible', dist: dist3D(from, visible), units: visible.units ?? 4, perUnitS, target: visible });
    for (const m of mem.list(cat, dimId, from).filter(nearHome).slice(0, 4)) {
      if (visible && dist3D(m.pos, visible) < 10) continue; // same place we can already see
      out.push({ kind: 'memory', dist: m.dist, units: m.n, perUnitS, trust: trustFor('block', m.ageMs), entry: m });
    }
    for (const m of mem.list((c) => c.startsWith('item:') && itemPred(c.slice(5)), dimId, from).slice(0, 4)) {
      out.push({ kind: 'item', dist: m.dist, units: m.n, trust: trustFor('item', m.ageMs), entry: m });
    }
    return out;
  }

  // ---------- trees ----------

  /** Get `target` logs: chop what's in sight, pick up dropped logs, or go back to remembered trees. */
  async gatherLogs(gen, target, extra = 0) {
    let fails = 0;
    const have = () => count(invCounts(this.sim), isLog);
    while (have() < target) {
      this.check(gen);
      if ((await this.needsEscape(gen)) && !(await this.toSurface(gen))) {
        await this.wait(gen, 100); // stuck below for now; toSurface already said why
        continue;
      }
      const f = this.feet();
      const raw = await this.scan(isLog, { radius: 32, below: 4, above: 10, limit: 12 });
      const low = raw.filter((b) => b.y - f.y <= 8 && !this.a.memory.isUnreachable(b));
      const logs = low.filter((b) => this.sees(b, true));
      if (raw.length !== logs.length) this.log(`logs scan: ${raw.length} found, ${low.length} low enough and not written off, ${logs.length} in sight${!logs.length && low[0] ? `; nearest ${low[0].id} at ${low[0].x} ${low[0].y} ${low[0].z}: ${this.whyNotUsable(low[0])}` : ''}`);
      this.check(gen);
      for (const l of logs) this.a.memory.remember('log', this.dim.id, l, 4);
      const need = target - have();
      // Trees, not log blocks: the nearest trunk by the walk to its foot (a climb up to it costs
      // extra), not the nearest log block in a straight line (a branch overhead, a log up in the
      // canopy of a tree further off). Stick with the tree we were on only while it's about as
      // close as the nearest one.
      const trees = trunksOf(logs, f);
      const committedTree = this.logCommit?.startsWith('visible:') ? trees.find((t) => `visible:${t.x},${t.z}` === this.logCommit) : null;
      const vis = committedTree && committedTree.cost <= trees[0].cost + 4 ? committedTree : trees[0];
      if (vis && trees.length > 1) this.log(`logs: nearest tree ${vis.cost.toFixed(1)} away (${vis.x} ${vis.y} ${vis.z}), next ${trees[1].cost.toFixed(1)}`);
      const best = chooseSourceSticky(this.sourceCandidates({
        cat: 'log', itemPred: isLog, perUnitS: 3.5,
        visible: vis ? { ...vis, units: vis.n } : null,
        extra: [{ kind: 'explore', dist: 0, units: Infinity, perUnitS: 3.5, fixedS: EXPLORE_S }],
      }), need, this.logCommit);
      this.logCommit = sourceKey(best);
      this.log(`logs: need ${need}, ${logs.length} in sight, best ${best.kind} (${best.cost.toFixed(0)} s)`);

      if (best.kind === 'explore') { await this.explore(gen, 'trees'); continue; }
      if (best.kind === 'memory' || best.kind === 'item') {
        if (await this.visitMemory(gen, best.entry) && best.kind === 'item') await this.pickUp(gen, isLog, best.entry.pos);
        continue;
      }
      // Chop the nearest trunk bottom-up while it lasts.
      const r = await this.chopTree(gen, best.target, { stop: () => have() >= target + extra, bonus: () => have() >= target });
      if (r.unreachable) { fails++; continue; }
      const chopped = r.chopped;
      if (!chopped && ++fails >= 3) { await this.explore(gen, 'reachable trees'); fails = 0; }
    }
  }

  /**
   * Chop one tree: its trunk column bottom-up (building up beside it for the top logs), then pick
   * up every log that fell, and put a sapling back on the stump (unless `replant` is off).
   * stop(): enough logs, leave the rest standing; bonus(): the job's share is in (taking extra).
   * Returns { chopped, unreachable }.
   * @param {any} gen
   * @param {{x: number, y: number, z: number}} trunk
   * @param {{stop?: () => boolean, bonus?: () => boolean, replant?: boolean}} [opts]
   */
  async chopTree(gen, trunk, { stop = () => false, bonus = () => false, replant = true } = {}) {
    const have = () => count(invCounts(this.sim), isLog);
    const column = [];
    for (let y = trunk.y - 3; y <= trunk.y + 10; y++) if (isLog(this.blockAt({ x: trunk.x, y, z: trunk.z }) ?? '')) column.push({ x: trunk.x, y, z: trunk.z });
    // A tree up on a ledge: get up to its base first (walking, or digging and building up).
    if (column[0] && column[0].y - this.feet().y > 2) {
      await this.goNear(gen, { x: column[0].x + 0.5, y: column[0].y, z: column[0].z + 0.5 }, 2.5, 2);
      if (column[0].y - this.feet().y > 4) {
        for (const c of column) this.a.memory.markUnreachable(c, 300000); // can't get to it: other trees first
        return { chopped: 0, unreachable: true };
      }
    }
    let chopped = 0;
    const before = have();
    const logId = column[0] ? this.blockAt(column[0]) : null;
    for (const b of column) {
      if (stop()) break; // the job's logs, plus the rest of this tree for later jobs
      if (bonus()) this.a.bonusUntil = system.currentTick + 100;
      if (!isLog(this.blockAt(b) ?? '')) continue;
      // The rest of the trunk is out of reach: build up beside it (a cheap block under us, leaves
      // above cut away) instead of leaving the top of the tree and walking off to another one.
      if (b.y - this.feet().y > 4 && !(await this.climbForLog(gen, b))) break;
      // The first log and we can't get to it: written off for 5 minutes, on to another tree. (It
      // stayed the nearest, so the next pass picked it again: three rounds of failed searches,
      // two walks and a dig-and-build each, before it gave up: tools/sim_think.mjs.)
      if (!chopped && !this.inReach(b) && !(await this.goNear(gen, b, 3, 2)) && !this.inReach(b)) {
        // (the whole trunk: each log of it was picked as a "tree" in turn, ~15 s of failed searches apiece, in a real run)
        for (const c of column) this.a.memory.markUnreachable(c, 300000);
        return { chopped: 0, unreachable: true };
      }
      // A log of ours that landed out of pickup range: stepped onto on the way to this one, if this
      // one's still in reach from there (no stop, no search, no waiting on drops that aren't there).
      await this.grabStrayOnTheWay(gen, b);
      if (await this.mine(gen, b, { collect: false })) {
        chopped++;
        this.noteDrops(b); // (which items this break made: watched until they're in the pack)
      }
    }
    if (chopped) this.memVisits.clear(); // trips paid off: nothing to hold against those memories
    await this.descendPillar(gen); // built up to reach the top logs: come back down the same way
    { const f = invCounts(this.sim); if ((f.coal ?? 0) + (f.charcoal ?? 0) < 8) await this.grabLitter(gen); } // free fuel within reach (only while short of it): the sweep below picks it up with the logs
    await this.sweep(gen, trunk, 7, null, 8); // every log that fell, and saplings/apples while we're here
    // Every log we broke should be in the inventory now. Missing some: they're on the ground
    // (or up in the leaves): look harder before moving on to another tree.
    const got = have() - before;
    if (got < chopped) {
      this.log(`logs: broke ${chopped}, have ${got} more: looking for the rest`);
      // The first sweep may have written them off (up on the leaves, out of the path search's
      // reach): these are ours, try again, and knock down any sitting on leaves first.
      for (const e of this.logItemsNear(trunk, 10)) this.unreachableItems.delete(e.id);
      await this.dropStranded(gen, trunk);
      await this.sweep(gen, trunk, 10, isLog, 15);
      const left = this.logItemsNear(trunk, 12);
      if (left.length) this.log(`logs: ${left.length} still on the ground: ${left.map((e) => { const l = e.location; return `${l.x.toFixed(1)} ${l.y.toFixed(1)} ${l.z.toFixed(1)} on ${this.blockAt({ x: Math.floor(l.x), y: Math.floor(l.y - 0.1), z: Math.floor(l.z) })}`; }).join('; ')}`);
    }
    if (!column.some((b) => isLog(this.blockAt(b) ?? ''))) {
      this.a.memory.forgetNear('log', this.dim.id, trunk, 3);
      // The whole trunk's down: put a sapling back on the stump, like a good forester.
      if (replant && chopped && logId && column[0]) await this.replant(gen, column[0], logId).catch((e) => this.log(`replant: ${e}`));
    }
    return { chopped, unreachable: false };
  }

  // ---------- crafting ----------

  async findTable(radius = 5) {
    const t = await this.scan((id) => id === 'crafting_table', { radius, below: 3, above: 3, limit: 4 });
    return t.find((b) => this.usable(b)) ?? t[0] ?? null; // one we can use right here first
  }

  /**
   * Craft each item in `items` (planks and sticks made along the way). The Script API has no
   * crafting call, so this does exactly what the crafting grid does to the inventory: remove the
   * recipe's inputs, add its output, one step at a time, standing at the table.
   */
  async craft(gen, items, needsTable, quiet = false) {
    let table = null;
    if (needsTable) {
      table = await this.findTable(5);
      if (!table) { this.log('craft: no crafting table within 5'); return false; }
      let usable = await this.reach(gen, table);
      // The mine camp's table, seen from the tunnel through rock (3 blocks off, no line): the camp's standing spot is where it's used from.
      const camp = this.homeQuarry()?.camp;
      if (!usable && camp && camp.table.x === table.x && camp.table.y === table.y && camp.table.z === table.z) {
        await this.goNear(gen, { x: camp.stand.x + 0.5, y: camp.stand.y, z: camp.stand.z + 0.5 }, 0.6, 2);
        usable = await this.reach(gen, table);
      }
      if (!usable) {
        // It's right here but we can't get a clear view of it (set down in a corner, behind a
        // block): pick it up and put it down somewhere sensible, instead of failing over and over.
        this.log(`craft: can't use the table at ${table.x} ${table.y} ${table.z} (reach and view): moving it`);
        if (!(await this.mine(gen, table))) return false;
        this.a.memory.forgetTable(this.dim.id, table);
        table = await this.place(gen, 'crafting_table');
        if (!table || !(await this.reach(gen, table))) return false;
      }
      await this.a.motor.lookAt(center(table), 10, 40); // opening the table
      this.check(gen);
    }
    for (const item of items) {
      // An item this game version doesn't have (spears are new): say so, never spend the inputs on it.
      if (!Skills.itemExists(item)) {
        this.a.sayOnce(`no-item-${item}`, `This game doesn't have ${item.replace(/_/g, ' ')}s: skipping it.`, 3600000);
        this.log(`craft: ${item} isn't an item in this version`);
        continue;
      }
      const plan = planCrafts(invCounts(this.sim), [item]);
      if (plan.logsShort || plan.missing) return false;
      // A full pack: the crafted item lands on the floor and the pack still reads 0 of it, so it was
      // crafted again (three iron shovels in one real run, 372 cobblestone in the pack). Room first.
      const cont = container(this.sim);
      let crowded = false;
      if (cont && cont.emptySlotsCount < 3) {
        crowded = true;
        await this.dumpJunk(gen, true, 3);
        if (cont.emptySlotsCount < 2) { this.log(`craft: pack full (${cont.emptySlotsCount} free), not crafting ${item}`); return false; }
      }
      for (const step of plan.steps) {
        const r = applyCraft(invCounts(this.sim), step);
        for (const [id, n] of Object.entries(r.used)) take(this.sim, id, n);
        for (const [id, n] of Object.entries(r.made)) give(this.sim, id, n);
        await this.wait(gen, 6); // a click or two per step
      }
      if (crowded) await this.collect(gen, this.sim.location, 4, 2, false); // (whatever still landed on the floor)
      if (!quiet) this.a.say(`Crafted ${item.replace(/_/g, ' ')}.`);
    }
    this.restHands();
    return true;
  }

  /** Put a block item down next to us, on the ground. */
  async place(gen, itemId, retry = true) {
    const f = this.feet();
    const cls = this.a.classifier();
    // Any open cell with solid ground under it within a couple of blocks: same level first,
    // then on top of a neighbouring block or down a step (placing in a dug-out hole needs these).
    const spots = [];
    const why = { floor: 0, taken: 0, far: 0 };
    for (const dy of [0, 1, -1]) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (Math.abs(dx) <= 0 && Math.abs(dz) <= 0) continue; // not where we stand
          const p = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
          // Air or something you place straight over (grass, flowers, snow layer), solid under,
          // and in plain view: a table set down behind a block is one we then can't use.
          const under = isGround(cls(p.x, p.y - 1, p.z)) || /leaves$/.test(this.blockAt({ x: p.x, y: p.y - 1, z: p.z }) ?? ''); // leaves hold a block fine
          const open = OPEN.test(this.blockAt(p) ?? '?'), reach = this.inReach(p);
          if (!under) why.floor++; else if (!open) why.taken++; else if (!reach) why.far++;
          if (under && open && reach) spots.push({ ...p, seen: this.sees({ x: p.x, y: p.y - 1, z: p.z }, true) });
        }
      }
    }
    spots.sort((a, b) => (b.seen ? 1 : 0) - (a.seen ? 1 : 0) || Math.abs(a.y - f.y) - Math.abs(b.y - f.y) || dist3D(f, a) - dist3D(f, b));
    if (!spots.length) this.log(`place ${itemId}: no open spot around ${f.x} ${f.y} ${f.z} (no ground ${why.floor}, taken ${why.taken}, out of reach ${why.far})`);
    for (const p of spots.slice(0, 6)) {
      const ground = { x: p.x, y: p.y - 1, z: p.z };
      const slot = hold(this.sim, itemId);
      if (slot < 0) return null;
      await this.a.motor.lookAt({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, 1, 20);
      this.check(gen);
      await this.placeOn(gen, slot, ground, Direction.Up, { x: 0.5, y: 1, z: 0.5 }, p);
      if (this.blockAt(p) === itemId) {
        if (itemId === 'crafting_table') { this.a.memory.rememberTable(this.dim.id, p); this.tablePlaced = { ...p, tick: system.currentTick }; }
        this.restHands();
        return p;
      }
    }
    this.restHands();
    // Cramped here (a hole, leaves, a slope): step out to open ground a few blocks off and try once more.
    if (retry) {
      const res = await this.a.plan(this.sim.location, this.sim.location, 0, 1500, (x, y, z, w) =>
        Math.hypot(x - f.x, z - f.z) >= 2 && w.standable(x, y, z) &&
        [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => w.standable(x + dx, y, z + dz)).length >= 3);
      this.check(gen);
      if (res.complete && res.path.length >= 2) {
        this.log(`place ${itemId}: no luck here, trying a few blocks over`);
        await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
        this.check(gen);
        return this.place(gen, itemId, false);
      }
    }
    return null;
  }

  // ---------- stone ----------

  /**
   * Get `need` cobblestone from whichever is cheapest: stone we can actually see, stone remembered,
   * cobblestone lying around, or a staircase down from here. Stone is mined nearest-first from
   * where we stand (the next block is picked after each one, not from a list made earlier), and
   * every drop is picked up before moving on.
   */
  /**
   * Get `need` cobblestone for the job at hand, plus up to `extra` more for later jobs while it's
   * cheap: only from the stone we're already mining (the tunnel, the face in front of us), for at
   * most 45 s after the job's share is in. Never a separate trip for the extra: later jobs can
   * fetch their own once the job at hand is done.
   */
  async getStone(gen, need, extra = 0) {
    const have = () => count(invCounts(this.sim), (id) => TOOL_STONE.has(id));
    const goal = have() + need, stretch = goal + Math.max(0, extra);
    let bonusUntil = null;
    const more = () => {
      const h = have();
      if (h < goal) return true;
      if (h >= stretch) return false;
      if (bonusUntil === null) {
        bonusUntil = system.currentTick + 900;
        this.a.bonusUntil = bonusUntil; // don't let "got what I needed" cut the extra short
        this.a.sayOnce('stone-extra', `Got the ${need} I needed; taking up to ${stretch - h} more for later while I'm here.`, 120000);
      }
      return system.currentTick < bonusUntil;
    };
    for (let round = 0; round < 8 && have() < goal; round++) {
      this.check(gen);
      const seen = await this.visibleStone(24);
      this.check(gen);
      if (seen[0]) this.a.memory.remember('stone', this.dim.id, seen[0], seen.length);
      const best = chooseSource(this.sourceCandidates({
        cat: 'stone', itemPred: (id) => TOOL_STONE.has(id), perUnitS: 1.1,
        visible: seen[0] ? { ...seen[0], units: seen.length } : null,
        extra: [{ kind: 'dig', dist: 0, units: Infinity, perUnitS: 1.1, fixedS: DIG_DOWN_S }],
      }), goal - have());
      this.log(`stone: need ${goal - have()}, ${seen.length} in sight, best ${best.kind} (${best.cost.toFixed(0)} s)`);

      if (best.kind === 'dig') {
        // One quarry, by the house: back down its shaft whenever we need stone, never a new hole
        // while it's still usable (core of the "new quarry every trip" problem).
        if (this.homeQuarry()) {
          await this.workQuarry(gen, more);
          if (have() >= goal) return true;
          continue;
        }
        await this.toQuarrySite(gen);
        this.a.sayOnce('stone-dig', 'No stone in sight, digging down to it.', 60000);
        await this.digStairs(gen, more);
        if (have() >= goal) return true;
        // A fresh start that got nowhere (water, a drop right at the top): try a few blocks over.
        // A quarry that's under way is carried on from its bottom next round instead.
        if ((this.quarry?.steps.length ?? 0) < 3) { this.abandonQuarry('a bad spot to start'); await this.relocate(gen); }
        continue;
      }
      if (best.kind === 'item') {
        if (await this.visitMemory(gen, best.entry)) await this.pickUp(gen, (id) => TOOL_STONE.has(id), best.entry.pos);
        continue;
      }
      if (best.kind === 'memory') {
        // Stone we remember in our own quarry: go down its shaft and carry on from the bottom,
        // not from wherever the memory was made (that's how extra holes got started in it).
        if (this.homeQuarry() && this.nearQuarry(best.entry.pos, 24)) {
          await this.workQuarry(gen, more);
          if (have() >= goal) break;
          continue;
        }
        // Stone remembered in an old quarry (from before the house, far from it now): not worth
        // the walk; the home quarry (or a new one by the house) will do.
        if (this.a.homestead?.house && this.quarry && this.nearQuarry(best.entry.pos, 24) && !this.homeQuarry()) {
          this.a.memory.markUnreachable(best.entry.pos, 3600000);
          continue;
        }
        if (!(await this.visitMemory(gen, best.entry))) continue;
        if (this.inStone()) {
          await this.tunnel(gen, more, this.stoniestDir());
          if (have() >= goal) break;
        }
        // There, but only stone we can see and reach counts (not the far side of a cave wall).
        const here = await this.visibleStone(8);
        this.check(gen);
        if (here[0]) await this.mineStoneFrom(gen, here[0], more);
        else this.a.memory.markUnreachable(best.entry.pos, 600000);
        continue;
      }
      this.a.sayOnce('stone-seen', `Going for the stone I can see, ${Math.round(dist3D(this.sim.location, seen[0]))} blocks away.`, 60000);
      await this.mineStoneFrom(gen, seen[0], more);
    }
    return have() >= goal;
  }

  /** Stone blocks we can see from here (line of sight to the block), nearest first. */
  /** Stone next to a block we just mined (what it uncovered) that we can reach and see from here. */
  stoneBehind(b) {
    const f = this.feet(), out = [];
    for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const c = { x: b.x + ox, y: b.y + oy, z: b.z + oz };
      if (!STONE_TARGETS.has(this.blockAt(c) ?? '') || !this.inReach(c)) continue;
      if (c.x === f.x && c.z === f.z && c.y < f.y) continue; // our own floor
      if (this.isProtected(c) || this.nearHome(c) || this.touchesLava(c) || this.a.memory.isUnreachable(c) || !this.sees(c)) continue;
      out.push(c);
    }
    return out;
  }

  /** Part of the house's footprint (and just round it): never quarried for stone. */
  nearHome(b) {
    const home = this.a.homestead?.house ?? this.a.homestead?.project;
    return !!home && Math.abs(b.x - home.x) <= 4 && Math.abs(b.z - home.z) <= 4 && b.y >= home.y - 3 && b.y <= home.y + 4;
  }

  async visibleStone(radius) {
    const f = this.feet();
    const found = await this.scan((id) => STONE_TARGETS.has(id), { radius, below: 4, above: 6, limit: 24 });
    return found.filter((b) => !this.touchesLava(b) && !this.nearHome(b) && !this.isProtected(b) && !this.a.memory.isUnreachable(b) && !(b.x === f.x && b.z === f.z && b.y < f.y) && this.sees(b));
  }

  /**
   * Nothing solid between our eye and this block. With `throughLeaves`, leaves don't count as
   * solid (you can see a trunk through its own canopy, and you'd chop your way in).
   */
  sees(p, throughLeaves = false) {
    return this.seesFrom(this.eye(), p, throughLeaves);
  }

  /** sees(), from any eye position (e.g. where we'd stand: reach() picks a spot with a clear view). */
  /**
   * Any part of block p in view from e: its centre, or the middle of its top or any side face
   * (inset a little). One ray at the exact centre misses a lot: it clips the edge of the block
   * next to it, so a table set down in a corner, a furnace in the house or a trunk behind a stump
   * "couldn't be seen" (and got moved, walked in and out of, or passed over for a farther tree).
   */
  seesFrom(e, p, throughLeaves = false) {
    const pts = [
      center(p),
      { x: p.x + 0.5, y: p.y + 0.9, z: p.z + 0.5 },
      { x: p.x + 0.1, y: p.y + 0.5, z: p.z + 0.5 }, { x: p.x + 0.9, y: p.y + 0.5, z: p.z + 0.5 },
      { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.1 }, { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.9 },
    ];
    // Nearest faces first (the ones actually turned toward us).
    pts.sort((a, b) => dist3D(e, a) - dist3D(e, b));
    for (const c of pts.slice(0, 4)) if (this.rayTo(e, p, c, throughLeaves)) return true;
    return false;
  }

  /** One ray from e toward point c: does the first thing it hits turn out to be block p? */
  rayTo(e, p, c, throughLeaves) {
    let from = e;
    for (let k = 0; k < 10; k++) {
      const d = { x: c.x - from.x, y: c.y - from.y, z: c.z - from.z };
      const len = Math.hypot(d.x, d.y, d.z);
      if (len < 0.05) return true;
      let hit;
      try {
        hit = castRay(this.dim, from, d, len + 0.5, { vines: true });
      } catch { return false; }
      if (!hit) return false;
      const h = hit.block.location;
      if (h.x === p.x && h.y === p.y && h.z === p.z) return true;
      // (For a look, leaves and vines can be cut through in a moment: a trunk wrapped in vines is still in sight.)
      if (!throughLeaves || !(/leaves/.test(hit.block.typeId) || THIN_COVER.test(hit.block.typeId))) return false;
      // Carry on from just inside this leaf block (the walk skips the cell it starts in).
      const f = hit.faceLocation ?? { x: 0.5, y: 0.5, z: 0.5 };
      from = { x: h.x + f.x + (d.x / len) * 0.01, y: h.y + f.y + (d.y / len) * 0.01, z: h.z + f.z + (d.z / len) * 0.01 };
    }
    return false;
  }

  /**
   * Mine outward from `first`: after each block, take the cheapest stone within a few steps of
   * where we now stand (blocks at foot-to-head height first: their drops land where we can walk),
   * and pick up what dropped before moving on.
   */
  async mineStoneFrom(gen, first, goal) {
    const have = () => count(invCounts(this.sim), (id) => TOOL_STONE.has(id));
    const more = typeof goal === 'function' ? goal : () => count(invCounts(this.sim), (id) => TOOL_STONE.has(id)) < goal; // goal: a count, or "keep going?"
    let target = first, fails = 0;
    const cost = (f, b) => dist3D(f, b) + (b.y - f.y > 2 ? 3 : 0) + (b.y < f.y - 1 ? 2 : 0);
    for (let n = 0; target && more() && fails < 4 && n < 64; n++) {
      this.check(gen);
      const mined = target;
      // Drops are gathered every few blocks, not after each one (a player mines a face, then walks
      // over what fell).
      if (!(await this.mine(gen, target, { collect: false }))) { fails++; this.a.memory.markUnreachable(target, 120000); }
      // Ore the block uncovered (coal behind the stone we just took): the vein now, it's right here.
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const c = { x: mined.x + dx, y: mined.y + dy, z: mined.z + dz };
        if (this.wantsOre(this.blockAt(c) ?? '') && this.inReach(c)) await this.mineVein(gen, c);
      }
      if (n % 4 === 3) await this.sweep(gen, this.sim.location, 5, null, 4, false);
      // Coal or iron showing near the stone we're working: take it (torches, fuel, the iron gear).
      if (n % 4 === 0) await this.oreInView(gen, 8, { maxWalk: 12 });
      const f = this.feet();
      // The face that block uncovered, in reach from here: the next swing, no looking round (the
      // full scan and its sight checks, after every block, was the pause between swings).
      const next = this.stoneBehind(mined).sort((p, q) => cost(f, p) - cost(f, q))[0];
      if (next) { target = next; continue; }
      const near = await this.visibleStone(6);
      this.check(gen);
      target = near.sort((p, q) => cost(f, p) - cost(f, q))[0] ?? null;
    }
    await this.sweep(gen, this.sim.location, 6, null, 6);
    // Stone left here that we can see: remember the spot, next time we come straight back.
    const left = await this.visibleStone(8);
    if (left.length) this.a.memory.remember('stone', this.dim.id, left[0], left.length);
    return !more();
  }

  /**
   * The quarry's staircase, one wide, one step down per block. It's always the same shaft: if we
   * have a quarry, we carry on from the bottom of it in the direction it was going; if not, this
   * starts one here. Once two steps are in solid stone (and we're after stone, not a depth), it
   * tunnels along that level from the bottom, then comes back to the bottom and goes on down.
   * Ore showing in the walls on the way gets mined (then back onto the stairs). Never digs straight
   * down, never opens a block next to water or lava, never steps over a drop; blocked on every
   * side, it cuts a few blocks along the level (still part of the shaft) and carries on down.
   */
  async digStairs(gen, goal, { toY = null, maxSteps = 40 } = {}) {
    const more = typeof goal === 'function' ? goal : () => count(invCounts(this.sim), (id) => TOOL_STONE.has(id)) < goal; // goal: a count, or "keep going?"
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    // Carry on our quarry from its bottom; don't start a second hole beside it.
    if (this.homeQuarry() && !(await this.toShaftBottom(gen))) return false;
    let q = this.homeQuarry();
    if (!q) {
      // A new quarry starts where we stand: the ground under us is the top step (the way out).
      const f = this.feet();
      this.abandonQuarry('starting a new one by the house'); // an old one far from home, if any
      this.extendShaft({ x: f.x, y: f.y - 1, z: f.z }, this.stoniestDir());
      q = this.quarry;
      this.log(`quarry: new shaft at ${f.x} ${f.y} ${f.z}`);
    }
    let di = q.dir ?? Math.floor(Math.random() * 4);
    let turns = 0, stoneSteps = 0;
    for (let step = 0; step < maxSteps && more(); step++) {
      this.check(gen);
      // Going to a set depth (the iron layer): keep stepping down until we're there.
      if (toY != null && this.feet().y <= toY) return true;
      // After stone, not a depth: the shaft stops at the iron layer (it's the branch mine's level, and
      // deeper means lava and deepslate). There, the stone comes from tunnels off the bottom.
      if (toY == null && this.feet().y <= Skills.IRON_Y) {
        // As deep as the quarry goes: the stone comes from the branch mine off the bottom, carried
        // on from where it left off (not a new tunnel from the stairs each time).
        await this.branchMine(gen, more);
        return !more();
      }
      if (stoneSteps >= 2 && toY == null) {
        this.a.sayOnce('tunnel', 'Down in the stone now: tunnelling along for the rest of the cobblestone.', 120000);
        const t = await this.tunnel(gen, goal, (di + 1) % 4);
        if (!more()) return true;
        stoneSteps = 0; // that level's used up here: back to the stairs, one more step down, then tunnel again
        if (!(await this.toShaftBottom(gen))) return false;
        this.log(`quarry: tunnelled ${t.mined}, back at the bottom of the stairs`);
      }
      const f = this.feet();
      const [dx, dz] = dirs[di];
      const fx = f.x + dx, fz = f.z + dz;
      const cells = [{ x: fx, y: f.y + 1, z: fz }, { x: fx, y: f.y, z: fz }, { x: fx, y: f.y - 1, z: fz }];
      const floor = { x: fx, y: f.y - 2, z: fz };
      // Our own tunnel floors and stairs count as in the way too (a stone tunnel can spiral back
      // round in front of the stairs): mining them is refused, and trying the same step again and
      // again was the bot standing at the bottom of the quarry doing nothing.
      const unsafe = cells.some((c) => this.touchesLiquid(c) || this.isProtected(c)) || this.isLiquid(floor) ||
        !this.isDiggable(cells) || OPEN.test(this.blockAt(floor) ?? 'air') || this.isProtected(floor);
      if (unsafe) {
        if (++turns > 4) {
          // No safe step down from here (water, a cave, a drop all round): cut a few blocks along
          // this level and go on down from there. The cut is part of the shaft, so the next trip
          // walks the same way instead of starting a new hole.
          if (this.inStone() || this.isUnderground()) {
            let moved = 0;
            for (let k = 0; k < 4 && moved < 3; k++) {
              const d = (di + k) % 4;
              while (moved < 3 && (await this.tunnelStep(gen, dirs[d][0], dirs[d][1]))) {
                moved++;
                const g = this.feet();
                this.extendShaft({ x: g.x, y: g.y - 1, z: g.z }, d);
              }
            }
            if (moved) { this.log(`stairs: blocked below at Y ${f.y}, cut ${moved} along`); turns = 0; continue; }
          }
          this.a.sayOnce('dig-unsafe', "Can't dig down safely here.", 30000);
          this.log(`stairs: no safe step down at ${f.x} ${f.y} ${f.z} (water, lava, a drop or loose blocks on every side)`);
          return false;
        }
        di = (di + 1) % 4;
        continue;
      }
      // Sand and gravel keep falling into the gap from above: mine until the column stays clear
      // (a beach or a desert has several blocks of it over the stone).
      let blocked = false;
      for (const c of cells) {
        for (let k = 0; k < 10 && !OPEN.test(this.blockAt(c) ?? 'air'); k++) {
          if (!(await this.mine(gen, c, { collect: false }))) {
            if (FALLING.test(this.blockAt(c) ?? '')) { await this.wait(gen, 8); continue; } // still settling
            this.log(`stairs: couldn't mine ${this.blockAt(c)} at ${c.x} ${c.y} ${c.z}: another way`);
            blocked = true;
            break;
          }
          if (FALLING.test(this.blockAt({ x: c.x, y: c.y + 1, z: c.z }) ?? '')) await this.wait(gen, 12);
        }
        if (blocked) break;
      }
      // Couldn't clear it: try the next way round (same as a step that isn't safe), never give up
      // on the spot and come straight back to the same block.
      if (blocked) { turns++; di = (di + 1) % 4; continue; }
      turns = 0;
      const r = await this.a.motor.followPath([
        { x: f.x + 0.5, y: f.y, z: f.z + 0.5 },
        { x: fx + 0.5, y: f.y - 1, z: fz + 0.5 },
      ]);
      this.check(gen);
      await this.collect(gen, this.sim.location, 3, 2); // drops from this step land around us
      if (r.status !== 'arrived') {
        const g = this.feet();
        this.log(`stairs: step down from ${f.x} ${f.y} ${f.z} toward ${fx} ${f.y - 1} ${fz} didn't land (${r.status}); now at ${g.x} ${g.y} ${g.z}; cells ${cells.map((c) => this.blockAt(c)).join('/')}, floor ${this.blockAt(floor)}, above us ${this.blockAt({ x: f.x, y: f.y + 2, z: f.z })}`);
        return false;
      }
      this.extendShaft({ x: fx, y: f.y - 2, z: fz }, di); // the step we stand on: the way back up
      await this.lightQuarry(gen, { x: f.x, y: f.y, z: f.z }); // the step behind us
      // Ore in the walls we just opened (iron on the way down to the iron layer, coal for torches).
      await this.oreAround(gen, { x: fx, y: f.y - 1, z: fz });
      stoneSteps = cells.every((c) => STONEISH.test(this.blockAt({ ...c, x: c.x + dx, z: c.z + dz }) ?? '')) ? stoneSteps + 1 : 0;
      // Reached stone: remember it's here (the quarry), so stone memories point back to it.
      if (cells.some((c) => /^(stone|deepslate)$/.test(this.blockAt({ ...c, x: c.x + dx, z: c.z + dz }) ?? ''))) {
        this.a.memory.remember('stone', this.dim.id, this.feet(), 24);
      }
    }
    return !more();
  }

  // ---------- the quarry: one shaft down, near the house ----------

  /** Our quarry in this dimension: { d, steps: ['x,y,z' treads, top first], dir, fails, mine }. */
  get quarry() {
    const q = this.a.memory.data.quarry;
    return q && q.d === this.dim.id && q.steps?.length ? q : null;
  }

  /** Where we stand on tread i (one above the block). */
  shaftStand(q, i) {
    const [x, y, z] = q.steps[i].split(',').map(Number);
    return { x, y: y + 1, z };
  }

  shaftBottom(q = this.quarry) { return q ? this.shaftStand(q, q.steps.length - 1) : null; }
  shaftTop(q = this.quarry) { return q ? this.shaftStand(q, 0) : null; }

  /** The quarry to use: near the house if there is one, and not given up on. */
  homeQuarry() {
    const q = this.quarry;
    if (!q) return null;
    const house = this.a.homestead?.house;
    const top = this.shaftTop(q);
    if (house && Math.hypot(top.x - house.x, top.z - house.z) > QUARRY_R) return null;
    return q;
  }

  /** Is p in or around our quarry (its shaft or the mine off its bottom), within r? */
  nearQuarry(p, r = 24) {
    const q = this.quarry;
    if (!q) return false;
    const pts = [this.shaftTop(q), this.shaftBottom(q), ...(q.mine?.at ? [q.mine.at] : [])];
    return pts.some((s) => Math.hypot(s.x - p.x, s.z - p.z) <= r && Math.abs(s.y - p.y) <= r);
  }

  /** A new tread at the bottom of the shaft (starts the quarry if there isn't one). */
  extendShaft(tread, di) {
    const mem = this.a.memory;
    let q = this.quarry;
    if (!q) q = mem.data.quarry = { d: this.dim.id, steps: [], dir: di, fails: 0, started: Date.now() };
    const k = `${tread.x},${tread.y},${tread.z}`;
    if (q.steps[q.steps.length - 1] !== k) q.steps.push(k);
    if (q.steps.length > 240) q.steps.splice(1, q.steps.length - 240); // keep the top: it's the way in
    q.dir = di;
    this._protected = null;
    mem.save();
  }

  /** Give up on the quarry (we'll start another by the house next time we need one). */
  abandonQuarry(why) {
    if (!this.a.memory.data.quarry) return;
    this.log(`quarry: giving up on it (${why})`);
    // Its steps stay protected: never dig out the stairs of an old quarry either.
    for (const k of this.a.memory.data.quarry.steps ?? []) { const [x, y, z] = k.split(',').map(Number); this.protect({ x, y, z }); }
    this.a.memory.data.quarry = null;
    this._protected = null;
    this.a.memory.save();
  }

  /** Index of the shaft tread we're standing on (or next to), or -1. */
  shaftIndexHere(q = this.quarry) {
    if (!q) return -1;
    const p = this.sim.location;
    let best = -1, bd = 1.6;
    for (let i = 0; i < q.steps.length; i++) {
      const s = this.shaftStand(q, i);
      const d = Math.hypot(s.x + 0.5 - p.x, s.z + 0.5 - p.z) + Math.abs(s.y - Math.floor(p.y));
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /**
   * Walk the shaft's treads from where we are to tread `to` (down or up). The stairs are ours and
   * known, so no path search: straight down the steps we cut, the way a player walks their mine.
   */
  async walkShaft(gen, to) {
    const q = this.quarry;
    if (!q) return false;
    await this.mendHoleUnderUs(gen, q);
    let from = this.shaftIndexHere(q);
    // Thrown off them into a crater beside them: back onto the nearest step, and on from there.
    if (from < 0 && dist3D(this.sim.location, this.shaftStand(q, this.nearestStep(q))) <= 6) {
      if (await this.rebuildStairs(gen, q, to)) return true;
      from = this.shaftIndexHere(q);
    }
    if (from < 0) {
      // Not on the stairs: to the top (or the nearer end) first.
      const top = this.shaftTop(q), bottom = this.shaftBottom(q);
      const here = this.sim.location;
      const useBottom = to === q.steps.length - 1 && dist3D(here, bottom) < dist3D(here, top);
      const end = useBottom ? bottom : top;
      if (!(await this.goNear(gen, { x: end.x + 0.5, y: end.y, z: end.z + 0.5 }, 0.8, 3))) return false;
      from = useBottom ? q.steps.length - 1 : 0;
    }
    if (from === to) return true;
    const idx = [];
    for (let i = from; from < to ? i <= to : i >= to; i += from < to ? 1 : -1) idx.push(i);
    // Water on the steps (a creeper's crater let a pond in, rain filled a hole): stopped where it
    // comes in, and the steps cleared, before walking them. Wading down against a current, or
    // swimming a flooded stairwell, is slow and it pushes us off the steps.
    const wet = [];
    for (const i of idx) { const s = this.shaftStand(q, i); for (const dy of [0, 1]) if (this.waterDepth({ ...s, y: s.y + dy }) !== null) wet.push({ ...s, y: s.y + dy }); }
    if (wet.length) await this.stopFlow(gen, wet);
    for (let a = 0; a < idx.length; a += 40) {
      const chunk = idx.slice(Math.max(0, a - 1), a + 40);
      // A step that's gone (a blast took the tread, rock fell into the way): look before walking
      // and mend it as we come to it. Following the recorded steps into a 2-high gap was the bot
      // jumping at a wall, over and over, before it gave in and found a way round.
      const bad = chunk.findIndex((s, n) => n > 0 && !this.stepFine(q, chunk[n - 1], s));
      if (bad > 0) {
        this.log(`quarry: step ${chunk[bad]} is broken (${this.blockAt({ ...this.shaftStand(q, chunk[bad]), y: this.shaftStand(q, chunk[bad]).y - 1 }) ?? '?'} under it): mending before walking on`);
        return (await this.rebuildStairs(gen, q, to)) || this.pastDamage(gen, q, to);
      }
      const wps = chunk.map((i) => { const s = this.shaftStand(q, i); return { x: s.x + 0.5, y: s.y, z: s.z + 0.5 }; });
      const r = await this.a.motor.followPath(wps);
      this.check(gen);
      if (r.status !== 'arrived') {
        // Something's changed (a creeper blew a hole in the stairs, a block fell in, a mob): the
        // stairs put back as they were, step by step; failing that, past it a few steps at a time.
        return (await this.rebuildStairs(gen, q, to)) || this.pastDamage(gen, q, to);
      }
    }
    return true;
  }

  /** Water here: its liquid_depth (0 a source, 1-7 flowing, 8+ falling), or null (not water). */
  waterDepth(p) {
    try {
      const b = this.dim.getBlock(p);
      if (!b || !isWatery(b) || /lava/.test(b.typeId)) return null;
      if (!b.isLiquid) return 0; // (waterlogged: stays put like a source)
      return b.permutation.getState('liquid_depth') ?? 0;
    } catch { return null; }
  }

  /**
   * Water where it's in our way (`cells`: the steps of our stairs, a path): stopped at the source,
   * the way a player does, not waded or swum. Traced back up the current (lower liquid_depth, or
   * water from above) to the blocks feeding it, and those filled: a pond's edge is a few blocks.
   * Fed by many (a lake): the first flowing blocks next to them instead (a dam). Then the water
   * left on the cells themselves (a source that ended up there) is filled and dug back out.
   * Returns how many blocks went down.
   */
  async stopFlow(gen, cells, maxBlocks = 12) {
    const key = (p) => `${p.x},${p.y},${p.z}`;
    const t0 = system.currentTick;
    const block = () => cheapestPlaceable(invCounts(this.sim), this.blockReserve(invCounts(this.sim)));
    let placed = 0, traced = 0;
    // A round: trace back, fill what feeds it, let the current die back; again while the cells
    // are still wet (a wide crater has more than one way in: the next nearest takes over).
    for (let round = 0; round < 4 && cells.some((c) => (this.waterDepth(c) ?? 0) > 0); round++) {
      const seen = new Set(cells.map(key));
      const queue = cells.filter((c) => (this.waterDepth(c) ?? 0) > 0).map((c) => ({ ...c }));
      const sources = new Map(), dam = new Map();
      for (let n = 0; n < queue.length && n < 600; n++) {
        const c = queue[n], dc = this.waterDepth(c) ?? 0;
        // Falling water is fed from above; the top of a fall, from beside it (where the current
        // reached the edge). Never from a pool below it (the one at the bottom of the quarry).
        const wetAbove = this.waterDepth({ x: c.x, y: c.y + 1, z: c.z }) !== null;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
          const u = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
          if (seen.has(key(u))) continue;
          const du = this.waterDepth(u);
          if (du === null) continue;
          // Upstream: water above us, or level water nearer its source than we are.
          if (!(dy === 1 || (dc >= 8 ? !wetAbove : du < dc))) continue;
          seen.add(key(u));
          if (du === 0) { sources.set(key(u), u); dam.set(key(c), c); continue; }
          queue.push(u);
        }
      }
      traced += sources.size;
      let targets = [...sources.values()];
      if (targets.length > maxBlocks) targets = [...dam.values()];
      if (!targets.length || targets.length > maxBlocks * 2) {
        if (targets.length) this.log(`water: ${sources.size} sources feeding it, too many to stop`);
        break;
      }
      if (!block() && toolFor('stone', invCounts(this.sim))) await this.gatherBlocks(gen, Math.min(targets.length + 4, 16), false);
      if (!round) this.a.sayOnce('stop-water', `Water's running onto my way: stopping it where it comes in.`, 60000);
      const f0 = this.sim.location;
      let n = 0;
      for (const c of targets.sort((a, b) => dist3D(f0, a) - dist3D(f0, b))) {
        this.check(gen);
        if (this.waterDepth(c) === null) continue;
        const id = block();
        if (!id) break;
        if (!this.inReach(c)) await this.goNear(gen, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, 3.5, 2);
        if (await this.a.homestead.placeAt(gen, c, id, null, null, { liquid: true })) { placed++; n++; this.markPlaced(c); }
      }
      if (!n) break;
      await this.wait(gen, 40); // (a level of current dies back every 5 ticks)
    }
    // What's still standing on our cells (a source that ended up there): fill it, dig it back out.
    for (const c of cells) {
      if (this.waterDepth(c) === null) continue;
      const id = block();
      if (!id) break;
      if (!this.inReach(c)) await this.goNear(gen, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, 3, 2);
      if (await this.a.homestead.placeAt(gen, c, id, null, null, { liquid: true })) { placed++; await this.mine(gen, c, { collect: true, force: true }); }
    }
    this.a.cellChanged?.();
    if (placed) this.log(`water: ${placed} block(s) to stop it (${traced} source(s) traced) in ${((system.currentTick - t0) / 20).toFixed(1)} s`);
    return placed;
  }

  /**
   * The stairs are broken (a creeper's crater): on toward step `to` a few steps at a time (each hop
   * close enough for goNear to dig and build its way across: one search to the far end, 40 steps
   * off, couldn't, and it gave up; tools/sim_quarry.mjs: back up the stairs 25% of the time), and the
   * treads that are gone put back as we pass, so the next trip is a plain walk again.
   */
  async pastDamage(gen, q, to) {
    this.a.sayOnce('quarry-damage', "Something's blown a hole in my quarry stairs: getting past it and patching them.", 120000);
    for (let hop = 0; hop < 16; hop++) {
      this.check(gen);
      let i = this.shaftIndexHere(q);
      if (i === to) return true;
      if (i < 0) i = this.nearestStep(q); // down in the crater: the nearest step
      const dir = to > i ? 1 : -1;
      const j = dir > 0 ? Math.min(to, i + 6) : Math.max(to, i - 6);
      const t = this.shaftStand(q, j);
      // Short of blocks to build across the gap and put the treads back (the house's cobblestone is
      // held back): dig a few out of the quarry's wall first; it's stone. (tools/sim_quarry.mjs
      // --leave: up its own stairs 97% of the time without this, 100% with it, ~5 s more.)
      if (this.blockCount() < 8 && toolFor('stone', invCounts(this.sim))) await this.gatherBlocks(gen, 8, false);
      if (!(await this.goNear(gen, { x: t.x + 0.5, y: t.y, z: t.z + 0.5 }, 0.8, 2))) {
        this.log(`quarry: couldn't get past the damage from step ${i} to ${j}`);
        return false;
      }
      await this.repairShaft(gen, q, i, j);
      // The rest of the way on the stairs, if they're whole from here.
      const k = this.shaftIndexHere(q);
      if (k === to) return true;
      if (k >= 0) {
        const wps = [];
        for (let s2 = k; dir > 0 ? s2 <= to : s2 >= to; s2 += dir) { const st = this.shaftStand(q, s2); wps.push({ x: st.x + 0.5, y: st.y, z: st.z + 0.5 }); }
        const r = await this.a.motor.followPath(wps);
        this.check(gen);
        if (r.status === 'arrived') return true;
      }
    }
    return false;
  }

  /**
   * The stairs blown about (one crater or a string of them, the top included): put back as they
   * were, step by step along the recorded line, the way a player rebuilds theirs. No searching for
   * a way round (every hop a new hole, and next time another), no standing about: at each broken
   * step, what's fallen into the walkway is dug out, the tread is put back (on a block or two under
   * it when the crater took everything it could be placed against), and on up. The same stairs
   * after, so the next trip is a plain walk. Short of blocks: a few out of the wall. Lava, or
   * nothing to build with: false (pastDamage's searches after that).
   */
  async rebuildStairs(gen, q, to) {
    const t0 = system.currentTick;
    await this.mendHoleUnderUs(gen, q);
    let i = this.shaftIndexHere(q);
    if (i < 0) {
      // Thrown into the crater beside them: onto the nearest step we can stand on.
      i = this.nearestStep(q);
      const s = this.shaftStand(q, i);
      if (dist3D(this.sim.location, s) > 8) return false;
      if (!this.standableAt(s)) await this.putTread(gen, q, i);
      if (!(await this.goNear(gen, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 }, 0.8, 2))) return false;
      i = this.shaftIndexHere(q);
      if (i < 0) return false;
    }
    if (i === to) return true;
    this.a.sayOnce('quarry-damage', "Something's blown my quarry stairs apart: putting them back as they were.", 120000);
    const dir = to > i ? 1 : -1;
    let fixed = 0, dug = 0;
    while (i !== to) {
      this.check(gen);
      // Walk the whole stretch that's fine in one go; stop on the step before the first broken one.
      let k = i;
      while (k !== to && this.stepFine(q, k, k + dir)) k += dir;
      if (k !== i) {
        const wps = [];
        for (let s2 = i; s2 !== k + dir; s2 += dir) { const st = this.shaftStand(q, s2); wps.push({ x: st.x + 0.5, y: st.y, z: st.z + 0.5 }); }
        const r = await this.a.motor.followPath(wps);
        this.check(gen);
        const here = this.shaftIndexHere(q);
        if (r.status !== 'arrived' && here === i) return false;
        i = here < 0 ? i : here;
        continue;
      }
      // The next step's broken: fix it from here.
      const j = i + dir;
      const s = this.shaftStand(q, j);
      const walk = [0, 1, 2].map((h) => ({ x: s.x, y: s.y + h, z: s.z }));
      if (walk.some((c) => /lava/.test(this.blockAt(c) ?? '') || this.touchesLava(c))) { this.log(`quarry: lava at step ${j}, not rebuilding`); return false; }
      const wet = walk.filter((c) => this.isLiquid(c));
      if (wet.length) await this.stopFlow(gen, wet);
      for (const c of walk) {
        if (OPEN.test(this.blockAt(c) ?? 'air') || this.isLiquid(c)) continue;
        if (await this.mine(gen, c, { collect: true, force: true })) dug++;
      }
      if (!this.standableAt(s)) {
        if (this.blockCount() < 4 && toolFor('stone', invCounts(this.sim))) await this.gatherBlocks(gen, 8, false);
        if (!(await this.putTread(gen, q, j))) { this.log(`quarry: couldn't put step ${j} back`); return false; }
        fixed++;
      }
      const r = await this.a.motor.followPath([{ ...this.sim.location }, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 }]);
      this.check(gen);
      if (r.status !== 'arrived' && this.shaftIndexHere(q) !== j) {
        // (gravel still coming down, a mob in the way: once more, then the searches)
        if (!(await this.goNear(gen, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 }, 0.6, 1))) return false;
      }
      i = j;
    }
    this.log(`quarry: stairs rebuilt on the way (${fixed} tread${fixed === 1 ? '' : 's'} put back, ${dug} fallen block${dug === 1 ? '' : 's'} dug out) in ${((system.currentTick - t0) / 20).toFixed(0)} s`);
    return true;
  }

  /**
   * Down in the hole where a tread should be (the blast took it from under us, or we fell through):
   * put it back from inside, jumping up onto it. Walking "the stairs" from down here is a jump at
   * a wall of 2 blocks, over and over.
   */
  async mendHoleUnderUs(gen, q) {
    const f = this.feet();
    const i = q.steps.indexOf(`${f.x},${f.y},${f.z}`);
    if (i < 0 || !OPEN.test(this.blockAt(f) ?? 'air')) return false;
    this.log(`quarry: in the hole where step ${i} was: putting it back from inside`);
    return this.putTread(gen, q, i);
  }

  /** Feet and head free, and something solid to stand on. */
  standableAt(s) {
    const open = (c) => OPEN.test(this.blockAt(c) ?? 'air') || TORCH.test(this.blockAt(c) ?? ''); // (a torch on a step is walked through)
    return open(s) && open({ ...s, y: s.y + 1 }) && !open({ ...s, y: s.y - 1 }) && !this.isLiquid({ ...s, y: s.y - 1 });
  }

  /** A plain step from stair a to stair b: b standable, clear overhead, no water. */
  stepFine(q, a, b) {
    const s = this.shaftStand(q, b);
    const up = this.shaftStand(q, a);
    return this.standableAt(s) && !this.isLiquid(s) && !this.isLiquid({ ...s, y: s.y + 1 }) &&
      OPEN.test(this.blockAt({ ...s, y: s.y + 2 }) ?? 'air') && OPEN.test(this.blockAt({ ...up, y: up.y + 2 }) ?? 'air');
  }

  /**
   * Step i's tread back. Nothing beside it to place against (the crater took the rock under and
   * round it): the block or two under it first, out of the walkway, found by a short search from
   * the tread to anything solid.
   */
  async putTread(gen, q, i) {
    const s = this.shaftStand(q, i);
    // Standing in the hole where it should be (fallen through, or the blast took it from under us):
    // a block can't go into the cell we're in. Jump and put it down under our feet, the way a player
    // pillars up one: it's the tread, and we end up on it.
    const f = this.feet();
    if (f.x === s.x && f.z === s.z && f.y === s.y - 1 && (await this.stepUp(gen))) return true;
    const walkway = [];
    for (let k = Math.max(0, i - 2); k <= Math.min(q.steps.length - 1, i + 2); k++) { const w = this.shaftStand(q, k); for (const h of [0, 1, 2]) walkway.push({ ...w, y: w.y + h }); }
    return this.putTreadAt(gen, { x: s.x, y: s.y - 1, z: s.z }, walkway);
  }

  /** A tread at `tread`, on a block or two under it if need be (never in `walkway`'s cells). */
  async putTreadAt(gen, tread, walkwayCells) {
    const key = (c) => `${c.x},${c.y},${c.z}`;
    const walkway = new Set(walkwayCells.map(key));
    const open = (c) => { const id = this.blockAt(c) ?? 'air'; return OPEN.test(id) || /water/.test(id); };
    const N6 = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
    // Breadth first from the tread over open cells: the first with a solid face ends the chain.
    const prev = new Map([[key(tread), null]]);
    let q2 = [tread], end = null;
    for (let depth = 0; depth < 4 && !end && q2.length; depth++) {
      const nextQ = [];
      for (const c of q2) {
        if (N6.some(([dx, dy, dz]) => !open({ x: c.x + dx, y: c.y + dy, z: c.z + dz }))) { end = c; break; }
        for (const [dx, dy, dz] of N6) {
          const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
          if (prev.has(key(n)) || walkway.has(key(n)) || !this.inReach(n)) continue;
          prev.set(key(n), c);
          nextQ.push(n);
        }
      }
      q2 = nextQ;
    }
    if (!end) { this.log(`tread at ${tread.x} ${tread.y} ${tread.z}: nothing solid within 4 cells of it in reach to build from`); return false; }
    const chain = [];
    for (let c = end; c; c = prev.get(key(c))) chain.push(c);
    const block = () => cheapestPlaceable(invCounts(this.sim), this.blockReserve(invCounts(this.sim)));
    for (const c of chain) {
      this.check(gen);
      const id = block();
      if (!id) { this.log(`tread at ${tread.x} ${tread.y} ${tread.z}: no block to build with`); return false; }
      if (!(await this.a.homestead.placeAt(gen, c, id, null, null, { liquid: true }))) {
        this.log(`tread at ${tread.x} ${tread.y} ${tread.z}: couldn't place ${id} at ${c.x} ${c.y} ${c.z} (in reach ${this.inReach(c)}, from ${this.feet().x} ${this.feet().y} ${this.feet().z})`);
        return false;
      }
      this.markPlaced(c);
    }
    this.a.cellChanged?.();
    return !open(tread);
  }

  /**
   * Out of the top of the stairs and still in a hole (the crater took the ground round the
   * entrance): a way on up to the ground, cut and built like any stair (a step up at a time, or
   * across), and kept: it's added to the top of the stairs, so the next trip walks it. One way out,
   * not a new hole each time.
   */
  async rebuildEntrance(gen, q) {
    if (this.shaftIndexHere(q) !== 0 || !(await this.needsEscape(gen))) return true;
    // The stairs carried on up the way they came, a step at a time: across the crater at this
    // level on treads put down (a block under each if need be), up a step where the ground rises.
    if (q.steps.length >= 2 && (await this.extendStairsUp(gen, q))) return true;
    const f0 = this.feet();
    const cache = new Map();
    const out = (x, y, z, w) => w.standable(x, y, z) && Math.hypot(x - f0.x, z - f0.z) >= 4 && y >= f0.y && !this.isUndergroundCached(x, y, z, cache);
    const opts = this.actionOpts({ force: false });
    // (No pillars, no leaps over gaps: steps to walk every trip, the gaps bridged.)
    const costs = { ...(this.a.moveCosts?.() ?? DEFAULT_COSTS), leap: null };
    const res = await this.a.plan(this.sim.location, this.sim.location, 0, 6000, out, { actions: { ...opts, pillar: false }, costs });
    this.check(gen);
    if (!res.complete || res.path.length < 2) return false;
    // Only a stair-like way is kept (a step at most up or down between neighbours).
    const stairLike = res.path.every((p, n) => !n || (Math.abs(p.y - res.path[n - 1].y) <= 1 && Math.abs(Math.floor(p.x) - Math.floor(res.path[n - 1].x)) + Math.abs(Math.floor(p.z) - Math.floor(res.path[n - 1].z)) <= 1));
    if (!stairLike) this.log(`quarry: the way up out of the crater isn't a stair (${res.path.map((p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}${p.move ? `:${p.move.type}` : ''}`).join(' ')}): not kept`);
    if (!(await this.followActionPath(gen, res.path))) return false;
    if (stairLike) {
      const treads = res.path.slice(1).map((p) => `${Math.floor(p.x)},${Math.floor(p.y) - 1},${Math.floor(p.z)}`).reverse();
      q.steps.unshift(...treads.filter((k) => !q.steps.includes(k)));
      this._protected = null;
      this.a.memory.save();
      this.log(`quarry: a new way up out of the crater at the top, ${treads.length} step${treads.length === 1 ? '' : 's'}, kept as the stairs' top`);
      this.a.sayOnce('quarry-top', 'Rebuilt the way into my quarry.', 120000);
    }
    return !(await this.needsEscape(gen));
  }

  /**
   * From the top step, on in the stairs' own line (away from step 1) until we're out: up to 8 steps,
   * each put on the front of q.steps as it's made. Returns true once out.
   */
  async extendStairsUp(gen, q) {
    const [a, b] = [this.shaftStand(q, 0), this.shaftStand(q, 1)];
    const dx = Math.sign(a.x - b.x), dz = Math.sign(a.z - b.z);
    if (Math.abs(dx) + Math.abs(dz) !== 1) return false;
    let made = 0;
    for (let n = 0; n < 8; n++) {
      this.check(gen);
      const cur = this.shaftStand(q, 0);
      const c = { x: cur.x + dx, y: cur.y, z: cur.z + dz };
      // The ground rises ahead (feet cell solid): a step up, cut into it.
      const solidAt = (p) => !OPEN.test(this.blockAt(p) ?? 'air') && !this.isLiquid(p);
      const s = solidAt(c) ? { ...c, y: c.y + 1 } : c;
      const cells = [0, 1, 2].map((h) => ({ ...s, y: s.y + h }));
      if (s.y > cur.y) cells.push({ ...cur, y: cur.y + 2 }); // (headroom to step up)
      if (cells.some((p) => /lava/.test(this.blockAt(p) ?? '') || this.touchesLava(p))) break;
      for (const p of cells) if (solidAt(p)) await this.mine(gen, p, { collect: true, force: true });
      if (cells.some((p) => solidAt(p))) break;
      const tread = { x: s.x, y: s.y - 1, z: s.z };
      if (!solidAt(tread)) {
        if (this.blockCount() < 3 && toolFor('stone', invCounts(this.sim))) await this.gatherBlocks(gen, 8, false);
        if (!(await this.putTreadAt(gen, tread, [...cells, ...[0, 1, 2].map((h) => ({ ...cur, y: cur.y + h }))]))) break;
      }
      const r = await this.a.motor.followPath([{ ...this.sim.location }, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 }]);
      this.check(gen);
      if (r.status !== 'arrived') break;
      q.steps.unshift(`${tread.x},${tread.y},${tread.z}`);
      this._protected = null;
      made++;
      if (!(await this.needsEscape(gen))) break;
    }
    if (made) {
      this.a.memory.save();
      this.log(`quarry: the stairs carried on up out of the crater at the top, ${made} step${made === 1 ? '' : 's'}, kept`);
      this.a.sayOnce('quarry-top', 'Rebuilt the way into my quarry.', 120000);
    }
    return made > 0 && !(await this.needsEscape(gen));
  }

  /** The step of the quarry's stairs nearest us (in a crater beside them, say). */
  nearestStep(q) {
    const p = this.sim.location;
    let best = 0, bd = Infinity;
    for (let i = 0; i < q.steps.length; i++) {
      const s = this.shaftStand(q, i);
      const d = dist3D(p, { x: s.x + 0.5, y: s.y, z: s.z + 0.5 });
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Put back the treads between steps a and b that are gone (in reach from here): cheap blocks. */
  async repairShaft(gen, q, a, b) {
    let fixed = 0;
    for (let s2 = Math.min(a, b); s2 <= Math.max(a, b); s2++) {
      const [x, y, z] = q.steps[s2].split(',').map(Number);
      const tread = { x, y, z };
      if (!OPEN.test(this.blockAt(tread) ?? 'air') || !this.inReach(tread)) continue;
      const f = this.feet();
      if (tread.x === f.x && tread.z === f.z && tread.y < f.y) continue;
      if (await this.fillFloor(gen, tread)) { fixed++; this._protected = null; }
    }
    if (fixed) this.log(`quarry: put back ${fixed} tread${fixed > 1 ? 's' : ''} of the stairs`);
    return fixed;
  }

  /**
   * Down to the bottom of our quarry. A quarry we can't get down (three tries in a row) is given
   * up on; one bad trip isn't reason enough to dig a new one.
   */
  async toShaftBottom(gen) {
    const q = this.homeQuarry();
    if (!q) return false;
    const b = this.shaftBottom(q);
    if (Math.hypot(b.x + 0.5 - this.sim.location.x, b.z + 0.5 - this.sim.location.z) < 0.9 && Math.abs(b.y - this.feet().y) <= 1) return true;
    this.a.sayOnce('quarry-back', 'Back to my quarry: down to the bottom and carrying on from there.', 60000);
    const ok = (await this.walkShaft(gen, q.steps.length - 1)) || (await this.goNear(gen, { x: b.x + 0.5, y: b.y, z: b.z + 0.5 }, 0.8, 2));
    if (ok) { q.fails = 0; return true; }
    q.fails = (q.fails ?? 0) + 1;
    this.log(`quarry: couldn't get down to ${b.x} ${b.y} ${b.z} (${q.fails} time${q.fails > 1 ? 's' : ''})`);
    if (q.fails >= 3) this.abandonQuarry("can't get down it");
    this.a.memory.save();
    return false;
  }

  /** Up our shaft to the top, if we're in it or in the mine off its bottom. */
  async leaveQuarry(gen) {
    const q = this.quarry;
    if (!q || !this.nearQuarry(this.sim.location, 48)) return false;
    // Tried from about here a moment ago and there was no way to the stairs: don't search again
    // every round of the climb-out loop.
    const f = this.feet(), lf = this.leaveFail;
    if (lf && Date.now() - lf.at < 60000 && Math.abs(lf.x - f.x) + Math.abs(lf.y - f.y) + Math.abs(lf.z - f.z) < 4) return false;
    if (this.shaftIndexHere(q) < 0) {
      // In the mine off the bottom (or a tunnel): back to the foot of the stairs first.
      const b = this.shaftBottom(q);
      const res = await this.a.plan(this.sim.location, { x: b.x + 0.5, y: b.y, z: b.z + 0.5 }, 0.8, 12000);
      this.check(gen);
      if (!res.complete) { this.leaveFail = { ...f, at: Date.now() }; return false; }
      if (res.path.length >= 2) await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
      this.check(gen);
      if (this.shaftIndexHere(q) < 0) return false;
    }
    this.log('quarry: walking up the stairs');
    if (!(await this.walkShaft(gen, 0))) return false;
    // At the top and still in a hole (the entrance blown out): one way on up, kept as the stairs' top.
    await this.rebuildEntrance(gen, q);
    return true;
  }

  /** Where a new quarry goes: 14-24 blocks from the house (never under it), walking there first. */
  async toQuarrySite(gen) {
    const house = this.a.homestead?.house;
    const homeD = house ? Math.hypot(this.sim.location.x - house.x, this.sim.location.z - house.z) : 0;
    if (house && homeD > 24 && homeD < 200) {
      this.a.sayOnce('quarry-home', 'Heading back to dig my quarry near the house.', 120000);
      this.log(`quarry: ${Math.round(homeD)} from the house, going back to start one near it`);
      await this.travelToward(gen, { x: house.x, y: house.y, z: house.z }, Math.ceil(homeD / 40) + 2);
      this.check(gen);
    }
    // Never dig our staircase under the house (or the spot we're building it on).
    const home = house ?? this.a.homestead?.project;
    const hd = home ? Math.hypot(this.sim.location.x - home.x, this.sim.location.z - home.z) : Infinity;
    if (home && (hd < 12 || (house && hd > 24))) {
      const res = await this.a.plan(this.sim.location, this.sim.location, 0, 4000, (x, y, z, w) => { const d = Math.hypot(x - home.x, z - home.z); return w.standable(x, y, z) && d >= 14 && (!house || d <= 24); });
      this.check(gen);
      if (res.complete && res.path.length >= 2) await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
      this.check(gen);
    }
    // A house on a mountain: the shaft's every block of height above the iron layer is ~5 s of digging and a
    // 50 s climb each trip (a run dug 110 blocks down). Start from the lowest ground that's still within the
    // quarry's reach of the house (QUARRY_R), walking downhill a stretch at a time.
    {
      // (No house yet, as at the start of a run: from where we stand now.)
      const anchor = home ?? { x: this.feet().x, z: this.feet().z };
      const dMin = home ? 14 : 0;
      for (let k = 0; k < 4 && this.feet().y > Skills.IRON_Y + 20; k++) {
        const y0 = this.feet().y;
        const res = await this.a.plan(this.sim.location, this.sim.location, 0, 6000, (x, y, z, w) => { const d = Math.hypot(x - anchor.x, z - anchor.z); return w.standable(x, y, z) && d >= dMin && d <= QUARRY_R - 4 && y <= y0 - 6; });
        this.check(gen);
        if (!res.complete || res.path.length < 2) break;
        await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
        this.check(gen);
        if (this.feet().y > y0 - 3) break;
        this.log(`quarry: starting lower, from Y ${y0} down to ${this.feet().y} (${Math.round(Math.hypot(this.sim.location.x - anchor.x, this.sim.location.z - anchor.z))} from ${home ? 'the house' : 'where I started'})`);
      }
    }
  }

  // ---------- the mine camp: a table and a furnace at the foot of the stairs ----------

  /** The mine camp's furnace (if it's still there). */
  campFurnace() {
    const c = this.homeQuarry()?.camp;
    return c && /furnace/.test(this.blockAt(c.furnace) ?? 'furnace') ? c.furnace : null;
  }

  /** The camp's second furnace (iron cooks in both at once), if there is one still standing. */
  campFurnace2() {
    const c = this.homeQuarry()?.camp;
    return c?.furnace2 && /furnace/.test(this.blockAt(c.furnace2) ?? 'furnace') ? c.furnace2 : null;
  }

  /** Is p the camp's table or furnace (theirs to stay put)? */
  isCampBlock(p) {
    const c = this.quarry?.camp;
    if (!c) return false;
    const same = (a) => a && Math.floor(p.x) === a.x && Math.floor(p.y) === a.y && Math.floor(p.z) === a.z;
    return same(c.furnace) || same(c.table) || same(c.furnace2);
  }

  /**
   * At the foot of the quarry's stairs at the iron layer: a table and a furnace in a little alcove
   * to the side (never on the stairs or across the branch mine's way), so spare pickaxes, iron
   * tools and smelting all happen down here instead of a climb to the house and back. Built once,
   * kept with the quarry. Needs a log (or 4 planks) and 8 cobblestone, or the items themselves.
   */
  async ensureCamp(gen) {
    const q = this.homeQuarry();
    if (!q || q.camp) return !!q?.camp;
    const b = this.shaftBottom(q), f = this.feet();
    if (b.y > Skills.IRON_Y + 1 || f.x !== b.x || f.z !== b.z || Math.abs(f.y - b.y) > 1) return false;
    const inv = invCounts(this.sim);
    const cobble = count(inv, (id) => TOOL_STONE.has(id));
    const wood = inv.crafting_table || count(inv, isPlanks) >= 4 || count(inv, isLog) >= 1;
    if (!wood || !(inv.furnace || cobble >= 8)) return false;
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    // Not back up the stairs, not the way the branch mine runs (or its way back).
    const prev = q.steps.length > 1 ? this.shaftStand(q, q.steps.length - 2) : null;
    const back = prev ? dirs.findIndex(([dx, dz]) => dx === Math.sign(prev.x - b.x) && dz === Math.sign(prev.z - b.z)) : -1;
    const mineDi = q.mine?.di ?? this.a.memory.data.mineDir;
    const safe = (c) => this.isDiggable([c]) && !this.touchesLiquid(c) && !this.isProtected(c) && !FALLING.test(this.blockAt({ ...c, y: c.y + 1 }) ?? '');
    let pick = null;
    for (let d = 0; d < 4 && !pick; d++) {
      if ((q.campBad ?? []).includes(d) || d === back || d === mineDi || (mineDi != null && d === (mineDi + 2) % 4)) continue;
      const [dx, dz] = dirs[d];
      const stand = { x: b.x + dx, y: b.y, z: b.z + dz };
      const furnace = { x: stand.x + dx, y: b.y, z: stand.z + dz };
      const table = { x: stand.x - dz, y: b.y, z: stand.z + dx };
      const cells = [stand, { ...stand, y: b.y + 1 }, furnace, table];
      if (cells.every(safe) && !OPEN.test(this.blockAt({ ...stand, y: b.y - 1 }) ?? 'air')) pick = { stand, furnace, table, d };
    }
    if (!pick) { this.log('camp: no solid spot beside the foot of the stairs'); return false; }
    this.a.say('Setting up a little camp at the foot of the stairs: a crafting table and a furnace, so I can craft and smelt down here.');
    // Whatever's in the way of the alcove goes (essential: clears blockers too). A cell that still
    // won't come out is tried again from the stairs' foot, then knocked out outright: the camp
    // shouldn't fail over a block of dirt.
    const wasEssential = this.essential;
    this.essential = true;
    try {
      for (const c of [{ ...pick.stand, y: b.y + 1 }, pick.stand, pick.furnace, pick.table]) {
        if (OPEN.test(this.blockAt(c) ?? 'air')) continue;
        let done = false;
        for (let tries = 0; tries < 3 && !done; tries++) {
          if (tries) { this.log(`camp: ${this.blockAt(c)} at ${c.x} ${c.y} ${c.z} wouldn't come out, try ${tries + 1}`); await this.goNear(gen, { x: b.x + 0.5, y: b.y, z: b.z + 0.5 }, 0.5, 2); }
          done = await this.mine(gen, c, { force: true });
        }
        if (!done && !this.touchesLava(c) && !this.touchesLiquid(c) && !UNBREAKABLE.test(this.blockAt(c) ?? '')) {
          try { this.dim.runCommand(`setblock ${c.x} ${c.y} ${c.z} air destroy`); } catch {}
          this.a.cellChanged?.();
          done = OPEN.test(this.blockAt(c) ?? 'air');
        }
        if (!done) {
          this.log(`camp: couldn't dig ${c.x} ${c.y} ${c.z} (${this.blockAt(c)}${this.isProtected(c) ? ', protected' : ''}${this.touchesLava(c) ? ', lava beside' : ''}); trying another side next time`);
          (q.campBad ??= []).push(pick.d); // (not the same alcove again: the next try takes another side)
          return false;
        }
      }
    } finally { this.essential = wasEssential; }
    await this.goNear(gen, { x: b.x + 0.5, y: b.y, z: b.z + 0.5 }, 0.5, 2);
    const H = this.a.homestead;
    if (!invCounts(this.sim).crafting_table && !(await this.craft(gen, ['crafting_table'], false, true))) return false;
    if (!(await H.placeAt(gen, pick.table, 'crafting_table'))) { this.log('camp: the table didn\'t go down'); return false; }
    this.a.memory.rememberTable(this.dim.id, pick.table);
    if (!invCounts(this.sim).furnace && !(await this.craft(gen, ['furnace'], true, true))) return false;
    if (!(await H.placeAt(gen, pick.furnace, 'furnace'))) { this.log('camp: the furnace didn\'t go down'); return false; }
    this.a.memory.remember('furnace', this.dim.id, pick.furnace);
    q.camp = { stand: pick.stand, table: pick.table, furnace: pick.furnace };
    this.protect({ ...pick.stand, y: b.y - 1 }); // the alcove floor stays
    this.a.memory.save();
    this.restHands();
    await this.lightQuarry(gen, pick.stand);
    this.log(`camp: table ${pick.table.x} ${pick.table.y} ${pick.table.z}, furnace ${pick.furnace.x} ${pick.furnace.y} ${pick.furnace.z}`);
    return true;
  }


  /**
   * A second furnace at the camp, beside the first (in line with the table): a batch of iron is
   * split over both, so 18 iron is about 90 s of waiting, not 180. Needs 8 cobblestone (or a furnace
   * in the pack); tried again after 5 minutes if it can't be.
   */
  /** Dig a camp cell out, and when the view to it is blocked by the camp's own table/furnace/chest (so the crosshair never gets on it), knock it out with a command. */
  async clearCampCell(gen, cell) {
    // (Not an essential dig: that clears whatever blocks the view, and here that's the camp's own table, which it picked up: 15:17 run.)
    if (await this.mine(gen, cell, { force: true })) return true;
    if (this.touchesLava(cell) || this.touchesLiquid(cell) || UNBREAKABLE.test(this.blockAt(cell) ?? '')) return false;
    try { this.dim.runCommand(`setblock ${cell.x} ${cell.y} ${cell.z} air destroy`); } catch {}
    this.a.cellChanged?.();
    return OPEN.test(this.blockAt(cell) ?? 'air');
  }

  async ensureCampFurnace2(gen) {
    const q = this.homeQuarry(), c = q?.camp;
    if (!c || c.furnace2 || (c.furnace2Try && Date.now() - c.furnace2Try < 300000)) return false;
    const f = this.feet();
    if (Math.hypot(f.x - c.stand.x, f.z - c.stand.z) > 10 || Math.abs(f.y - c.stand.y) > 2) return false;
    const inv = invCounts(this.sim);
    if (!inv.furnace && count(inv, (id) => TOOL_STONE.has(id)) < 8) return false; // (no stone yet: not worth marking it tried)
    const dx = Math.sign(c.furnace.x - c.stand.x), dz = Math.sign(c.furnace.z - c.stand.z);
    const cell = { x: c.furnace.x - dz, y: c.furnace.y, z: c.furnace.z + dx };
    c.furnace2Try = Date.now();
    this.a.memory.save();
    const here = this.blockAt(cell) ?? 'air';
    const ok = OPEN.test(here) || (this.isDiggable([cell]) && !this.touchesLiquid(cell) && !this.isProtected(cell));
    if (!ok) { this.log(`camp furnace 2: ${cell.x} ${cell.y} ${cell.z} is ${here}, not diggable`); return false; }
    const H = this.a.homestead;
    await this.goNear(gen, { x: c.stand.x + 0.5, y: c.stand.y, z: c.stand.z + 0.5 }, 0.6, 2);
    if (!OPEN.test(here) && !(await this.clearCampCell(gen, cell))) { this.log(`camp furnace 2: couldn't clear ${cell.x} ${cell.y} ${cell.z}`); return false; }
    if (!invCounts(this.sim).furnace && !(await this.craft(gen, ['furnace'], true, true))) { this.log('camp furnace 2: not made'); return false; }
    if (!(await H.placeAt(gen, cell, 'furnace'))) { this.log('camp furnace 2: it didn\'t go down'); return false; }
    this.a.memory.remember('furnace', this.dim.id, cell);
    c.furnace2 = { x: cell.x, y: cell.y, z: cell.z };
    this.protect(cell);
    this.a.memory.save();
    this.restHands();
    this.log(`camp furnace 2: ${cell.x} ${cell.y} ${cell.z}`);
    this.a.say('A second furnace at the camp: iron cooks twice as fast.');
    return true;
  }

  /**
   * A chest at the mine camp, on the side of the stand opposite the table: what a player does, so a
   * full pack is a trip to the chest, not stone thrown away (and not a crafted tool dropped on the
   * floor). Made once there's wood for it (8 planks); tried again after 5 minutes if it can't be.
   */
  async ensureCampChest(gen) {
    const q = this.homeQuarry(), c = q?.camp;
    if (!c || (c.chest && c.chest2) || (c.chestTry && Date.now() - c.chestTry < 300000)) return false;
    const dx = Math.sign(c.furnace.x - c.stand.x), dz = Math.sign(c.furnace.z - c.stand.z);
    // Two chests side by side along (dz, -dx), both facing along the furnace's axis: a double chest.
    const cells = [1, 2].map((k) => ({ x: c.stand.x + dz * k, y: c.stand.y, z: c.stand.z - dx * k }));
    const faceName = (vx, vz) => (vx > 0 ? 'east' : vx < 0 ? 'west' : vz > 0 ? 'south' : 'north');
    const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' };
    const facing = faceName(-dx, -dz); // (setChest takes the door side and faces the other way)
    const f = this.feet();
    if (Math.hypot(f.x - c.stand.x, f.z - c.stand.z) > 10 || Math.abs(f.y - c.stand.y) > 2) return false;
    const inv = invCounts(this.sim);
    if (!inv.chest && count(inv, isPlanks) + 4 * count(inv, isLog) < 8) return false; // (no wood yet: not worth marking it tried)
    c.chestTry = Date.now();
    this.a.memory.save();
    const H = this.a.homestead;
    await this.goNear(gen, { x: c.stand.x + 0.5, y: c.stand.y, z: c.stand.z + 0.5 }, 0.6, 2);
    let made = 0;
    for (const [i, cell] of cells.entries()) {
      const key = i === 0 ? 'chest' : 'chest2';
      if (c[key]) continue;
      const have = invCounts(this.sim);
      if (!have.chest && count(have, isPlanks) + 4 * count(have, isLog) < 8) break; // (the second one when there's more wood)
      if (!have.chest && !(await this.craft(gen, ['chest'], true, true))) { this.log('camp chest: not made (wood or table)'); break; }
      const here = this.blockAt(cell) ?? 'air';
      if (!OPEN.test(here) && !/chest/.test(here) && !(await this.clearCampCell(gen, cell))) { this.log(`camp chest: couldn't clear ${cell.x} ${cell.y} ${cell.z}`); break; }
      if (!/chest/.test(this.blockAt(cell) ?? '') && !(await H.placeAt(gen, cell, 'chest')) && !(await H.setChest(gen, cell, { dir: opposite[facing] }))) { this.log('camp chest: the chest didn\'t go down'); break; }
      c[key] = { x: cell.x, y: cell.y, z: cell.z };
      this.protect(cell);
      made++;
      this.log(`camp chest: ${cell.x} ${cell.y} ${cell.z} facing ${facing}${i === 1 ? `, size ${this.a.homestead.container(cell)?.size ?? '?'} (54 = a double chest)` : ''}`);
    }
    this.a.memory.save();
    this.restHands();
    if (made) this.a.say(c.chest2 ? 'A double chest at the camp now: spare stone and drops go in it when my pack fills.' : 'Put a chest at the camp: spare stone and mob drops go in it when my pack fills.');
    return made > 0;
  }

  /** Pack nearly full: the camp chest if there is one in reach, otherwise junk stone thrown away. */
  async packRoom(gen) {
    let c = null;
    try { c = container(this.sim); } catch { /* no pack to look at */ }
    if (!c || c.emptySlotsCount > FULL_SLOTS) return 0;
    if (await this.stashAtCamp(gen).catch((e) => { if (e instanceof Aborted) throw e; this.log(`camp stash: ${e}`); return false; })) return 1;
    return this.dumpJunk(gen);
  }

  /**
   * Walk to the camp chest (within 40 blocks, on this level) and put away what the pack doesn't
   * need (core/storage.js depositPlan, but 128 cobblestone kept for building), then back to where we were.
   * Full or unreachable: said once, not tried again for 10 minutes.
   */
  async stashAtCamp(gen) {
    const q = this.homeQuarry(), c = q?.camp;
    const chests = [c?.chest, c?.chest2].filter(Boolean);
    if (!chests.length || (c.chestFullAt && Date.now() - c.chestFullAt < 600000) || this.a.toggles().storage === false) return false;
    for (const key of ['chest', 'chest2']) if (c[key] && !/chest/.test(this.blockAt(c[key]) ?? 'chest')) { c[key] = null; this.a.memory.save(); }
    const ch0 = c.chest ?? c.chest2;
    if (!ch0) return false;
    const f = this.feet();
    if (Math.hypot(f.x - ch0.x, f.z - ch0.z) > 40 || Math.abs(f.y - ch0.y) > 3) return false;
    const inv = invCounts(this.sim);
    const plan = depositPlan(inv);
    if (plan.cobblestone) { plan.cobblestone = Math.max(0, (inv.cobblestone ?? 0) - 128); if (!plan.cobblestone) delete plan.cobblestone; }
    if (!Object.keys(plan).length) return false;
    const back = { x: f.x + 0.5, y: f.y, z: f.z + 0.5 };
    const pack = container(this.sim);
    let stored = 0;
    for (const ch of [c.chest, c.chest2].filter(Boolean)) {
      if (!Object.keys(plan).some((id) => plan[id] > 0)) break;
      if (!(await this.reach(gen, ch))) { this.log(`camp stash: couldn't reach the chest at ${ch.x} ${ch.y} ${ch.z}`); continue; }
      await this.a.motor.lookAt(center(ch), 8, 30);
      this.check(gen);
      const chest = this.a.homestead.container(ch);
      if (!chest || !pack) continue;
      for (let i = 0; i < pack.size; i++) {
        const it = pack.getItem(i);
        if (!it) continue;
        const id = strip(it.typeId);
        const want = plan[id] ?? 0;
        if (want <= 0) continue;
        let moved;
        if (want >= it.amount) { const left = pack.transferItem(i, chest); moved = it.amount - (left?.amount ?? 0); }
        else { const left = chest.addItem(new ItemStack(it.typeId, want)); moved = want - (left?.amount ?? 0); if (moved > 0) take(this.sim, id, moved); }
        stored += moved;
        plan[id] -= moved;
      }
      await this.wait(gen, 6);
    }
    this.restHands();
    const left = Object.values(plan).reduce((a, n) => a + Math.max(0, n), 0);
    if (left) c.chestFullAt = Date.now(); // (what didn't fit is tossed as junk by the caller's next pass)
    this.a.memory.save();
    this.log(`camp stash: put ${stored} things in the camp chest${left ? ` (${left} didn't fit)` : ''}`);
    if (stored) this.a.sayOnce('camp-stash', 'Pack was filling up: put the spare stone and drops in the camp chest.', 120000);
    await this.goNear(gen, back, 0.8, 2);
    return stored > 0;
  }

  /**
   * Mine ore showing around us (in reach, in view), and coal or iron in view a few steps further
   * (torches, fuel, the iron gear), then step back to where we were standing.
   */
  async oreAround(gen, stand) {
    const n = (await this.mineExposedOre(gen)) + (await this.oreInView(gen, 8, { maxWalk: 12 }));
    if (!n) return 0;
    const p = this.sim.location;
    if (Math.hypot(stand.x + 0.5 - p.x, stand.z + 0.5 - p.z) > 0.6 || Math.floor(p.y) !== stand.y) {
      await this.goNear(gen, { x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, 0.5, 2);
    }
    return n;
  }


  // ---------- iron: down to the iron layer, branch mine, mine the veins ----------

  /** Is this an item in the running game (by id without the prefix)? */
  static itemExists(id) {
    try { return !!ItemTypes.get(`minecraft:${id}`); } catch { return true; }
  }

  /** Ore we mine when we come across it (with a pickaxe that gets a drop from it). */
  static isOre(id) { return /_ore$/.test(id) && !/^(nether_gold|quartz)/.test(id); }

  /** The iron band peaks here (minecraft.wiki: Y -24..56, most at 16). */
  static IRON_Y = 16;

  /** Raw iron (and unsmelted iron ore blocks) we carry. */
  rawIron() { const inv = invCounts(this.sim); return (inv.raw_iron ?? 0) + (inv.iron_ore ?? 0) + (inv.deepslate_iron_ore ?? 0); }

  /**
   * Get `need` more raw iron. Iron ore we can see first (a cave wall, a mountainside, the quarry
   * walls), else down the quarry by the house to Y 15-16 (the peak of the underground iron band,
   * minecraft.wiki: Y -24..56, peaking at 16) and branch mine there. Time-boxed (`maxS`), so
   * night, hunger and the furnace get a look in; the next call carries on from the mine's end.
   */
  async getIron(gen, need, maxS = 180) {
    const t0 = system.currentTick;
    const goal = this.rawIron() + need;
    const pick = () => Object.keys(invCounts(this.sim)).some((id) => /^(stone|iron|diamond|netherite)_pickaxe$/.test(id));
    // Out of pickaxes: stop (digging stone by hand is ten times slower); the ladder makes more.
    // Pack full of things worth keeping (junk stone is tossed as we go): home to the chest first,
    // rather than leave ore lying in the tunnel.
    const roomy = () => { const c = container(this.sim); return !c || c.emptySlotsCount > 1 || !this.a.homestead?.chests().length || Date.now() - (this.a.memory.data.chestFullAt ?? 0) < 600000; };
    const more = () => this.rawIron() < goal && system.currentTick - t0 < maxS * 20 && pick() && roomy();
    if (!pick()) { this.log('iron: no pickaxe'); return false; }
    // Night down the mine and the pack's full: make room here rather than go home to the chest.
    if (!roomy() && isNight(world.getTimeOfDay())) await this.dumpJunk(gen, true);
    // 1. Iron in sight.
    const seen = (await this.scan((id) => /iron_ore$/.test(id), { radius: 16, below: 6, above: 8, limit: 8 }))
      .filter((b) => !this.a.memory.isUnreachable(b) && this.sees(b));
    if (seen.length) {
      this.rememberOre(seen);
      this.log(`iron: ${seen.length} ore in sight, nearest ${Math.round(dist3D(this.sim.location, seen[0]))} away`);
      for (const b of seen) {
        if (!more()) break;
        if (!(await this.mineVein(gen, b))) this.a.memory.markUnreachable(b, 600000);
      }
      if (!more()) return this.rawIron() >= goal;
    }
    // 2. Down to the iron layer: our quarry's shaft (carried on down if it doesn't reach yet), or
    //    a new one near the house. Straight back to the branch mine if we've started one.
    const IRON_Y = Skills.IRON_Y;
    const going = () => system.currentTick - t0 < maxS * 20 && pick();
    if (this.feet().y > IRON_Y + 1) {
      if (this.homeQuarry()) this.a.sayOnce('iron-down', `Down the quarry to about Y ${IRON_Y} for iron.`, 120000);
      else await this.toQuarrySite(gen);
      this.check(gen);
      this.a.sayOnce('iron-stairs', `Digging down to Y ${IRON_Y}, where the iron is.`, 120000);
      for (let tries = 0; tries < 4 && this.feet().y > IRON_Y + 1 && going(); tries++) {
        // digStairs goes to the bottom of the quarry first and carries the same shaft on down.
        const y0 = this.feet().y, steps0 = this.quarry?.steps.length ?? 0;
        await this.digStairs(gen, going, { toY: IRON_Y, maxSteps: 120 });
        this.check(gen);
        if (this.feet().y <= IRON_Y + 1 || !going()) break;
        // Got nowhere at all (the bottom's boxed in: water, lava, our own tunnels all round): say so,
        // and after a few such trips start a new quarry rather than stand at the bottom of this one.
        const q = this.quarry;
        if (q && this.feet().y >= y0 && q.steps.length === steps0) {
          q.stuck = (q.stuck ?? 0) + 1;
          this.a.memory.save();
          this.log(`iron: the quarry's bottom is blocked (${q.stuck} time${q.stuck > 1 ? 's' : ''} in a row)`);
          if (q.stuck >= 3) {
            this.a.say("My quarry's blocked at the bottom every way I try: starting a new one.");
            this.abandonQuarry('blocked at the bottom');
            await this.toQuarrySite(gen);
            continue;
          }
          this.a.sayOnce('quarry-blocked', "The bottom of my quarry's blocked; trying again a different way.", 60000);
          break;
        } else if (q) q.stuck = 0;
        // Stopped near the top of a new shaft (water, sand): start it again a few blocks over.
        // A shaft that's under way is never abandoned for a new hole: it's carried on next trip.
        if ((this.quarry?.steps.length ?? 0) < 3) { this.abandonQuarry('a bad spot to start'); await this.relocate(gen); } else break;
      }
      if (this.feet().y > IRON_Y + 1) return false;
    }
    // Fell into a cave on the way (or walked down one after ore): the iron band peaks at Y 16,
    // and a branch mine far below it finds less and is harder to get out of. Back up first.
    if (this.feet().y < IRON_Y - 4 && !(await this.backToLevel(gen, IRON_Y))) return false;
    // 3. The camp at the foot of the stairs (once), then the branch mine.
    await this.ensureCamp(gen).catch((e) => { if (e instanceof Aborted) throw e; this.log(`camp: ${e}`); });
    await this.ensureCampFurnace2(gen).catch((e) => { if (e instanceof Aborted) throw e; this.log(`camp furnace 2: ${e}`); });
    await this.ensureCampChest(gen).catch((e) => { if (e instanceof Aborted) throw e; this.log(`camp chest: ${e}`); });
    // Iron seen on an earlier trip and not mined (night fell, a fight, a full pack): that first.
    if (await this.pendingIron(gen, more)) this.a.sayOnce('iron-pending', 'Back for the iron I saw last time.', 120000);
    if (!more()) return this.rawIron() >= goal;
    this.a.sayOnce('iron-branch', 'At the iron layer: branch mining.', 120000);
    await this.branchMine(gen, more);
    return this.rawIron() >= goal;
  }

  /**
   * Too deep (a fall into a cave, a vein followed down): back up to about level y. Our own shaft or
   * any walking route first; otherwise a staircase up, cut into the rock.
   */
  async backToLevel(gen, y) {
    const q = this.homeQuarry();
    this.log(`too deep: at Y ${this.feet().y}, getting back up to about Y ${y}`);
    this.a.sayOnce('too-deep', `I'm down at Y ${this.feet().y}, below the iron layer: climbing back up to it.`, 120000);
    if (q) {
      const b = this.shaftBottom(q);
      if (b.y >= y - 2 && (await this.goNear(gen, { x: b.x + 0.5, y: b.y, z: b.z + 0.5 }, 0.8, 2))) return true;
    }
    // Anywhere we can walk to at about that level.
    const res = await this.a.plan(this.sim.location, this.sim.location, 0, 6000, (x, yy, z, w) => w.standable(x, yy, z) && yy >= y - 2 && yy <= y + 2);
    this.check(gen);
    if (res.complete && res.path.length >= 2) {
      await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
      this.check(gen);
      if (this.feet().y >= y - 4) return true;
    }
    const byHand = !toolFor('stone', invCounts(this.sim));
    for (let i = 0; i < 40 && this.feet().y < y - 1; i++) {
      if (!(await this.stairStep(gen, byHand))) {
        if (!(await this.tunnelSideways(gen, byHand))) break;
      }
    }
    return this.feet().y >= y - 4;
  }

  /**
   * A branch mine off the bottom of the quarry: a 2-high main tunnel, and every 3rd block a branch
   * 8 long to each side (two solid blocks between branches, so every block in between shows a face
   * and none is dug twice). Ore on the walls gets mined as we pass, whole veins. Where the main
   * tunnel has got to, and which way it runs, is kept with the quarry: the next trip walks to the
   * end of it and carries on, instead of starting over from wherever it happens to be.
   */
  async branchMine(gen, more) {
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const q = this.homeQuarry();
    const mem = this.a.memory.data;
    let prev = q?.mine && Math.abs(q.mine.y - this.feet().y) <= 2 ? q.mine : null;
    if (prev) {
      const at = prev.at;
      if (!(await this.goNear(gen, { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, 0.8, 2))) { this.log(`mine: couldn't get back to the end of the main tunnel at ${at.x} ${at.y} ${at.z}; carrying on from here`); prev = null; }
    }
    let di = prev?.di ?? mem.mineDir ?? this.stoniestDir();
    let steps = prev?.n ?? 0, blocked = 0, since = 0, fresh_n = 0;
    let tried = new Set();
    // A branch left half dug last trip: finish it first.
    const half = q?.branch;
    if (half && Math.abs(half.at.y - this.feet().y) <= 2 && more()) {
      this.log(`mine: finishing the branch left at ${half.at.x} ${half.at.y} ${half.at.z} (${half.left} to go)`);
      if (await this.goNear(gen, { x: half.at.x + 0.5, y: half.at.y, z: half.at.z + 0.5 }, 0.8, 2)) {
        await this.branch(gen, half.dx, half.dz, half.left, more, half.start);
      } else { q.branch = null; this.a.memory.save(); }
      if (prev) await this.goNear(gen, { x: prev.at.x + 0.5, y: prev.at.y, z: prev.at.z + 0.5 }, 0.8, 2);
    }
    // Only ever saved on the mine's level: a spot down in a hole is never where the next trip starts.
    const record = () => {
      mem.mineDir = di;
      if (q) q.mine = { y: level, at: this.feet().y === level ? this.feet() : lastGood, di, n: steps };
      this.a.memory.save();
    };
    // The level the mine is dug at: every step of it, main tunnel and branches, stays on it.
    const level = prev?.y ?? this.feet().y;
    let lastGood = this.feet();
    while (more() && blocked < 4) {
      this.check(gen);
      await this.packRoom(gen);
      if (this.feet().y !== level && !(await this.backOntoLevel(gen, lastGood))) break;
      const [dx, dz] = dirs[di];
      const f0 = this.feet();
      const fresh = !this.isTunnelFloor({ x: f0.x + dx, y: f0.y - 1, z: f0.z + dz }); // (a step into a tunnel we already dug isn't progress)
      if (!(await this.tunnelStep(gen, dx, dz))) {
        if (blocked === 0) this.log(`mine: tunnel blocked going ${dx},${dz} at ${f0.x} ${f0.y} ${f0.z}: feet ${this.blockAt({ x: f0.x + dx, y: f0.y, z: f0.z + dz })}, head ${this.blockAt({ x: f0.x + dx, y: f0.y + 1, z: f0.z + dz })}, floor ${this.blockAt({ x: f0.x + dx, y: f0.y - 1, z: f0.z + dz })}`);
        // Something in the way (water, lava, a drop, the house): turn, the way with less of our
        // own tunnels in it (right on a tie), then the other way, then back.
        tried.add(di);
        // Branches a block or two back: turn there, so the new way runs down one of them. Turning
        // here would run it alongside one with a single block between (the same stone seen twice).
        const here = this.feet();
        const o = tried.size === 1 && !this.branchAt(here, dx, dz, 0) ? [-1, -2].find((v) => this.branchAt(here, dx, dz, v)) : undefined;
        if (o !== undefined) await this.goNear(gen, { x: here.x + dx * o + 0.5, y: here.y, z: here.z + dz * o + 0.5 }, 0.6, 2);
        di = this.turnFrom(di, tried);
        blocked++;
        continue;
      }
      // Only a new block dug resets the dead-end count: walking back and forth along old tunnel
      // between two dead ends looped forever (4 minutes of it in one real run).
      if (fresh) { tried = new Set(); blocked = 0; fresh_n++; }
      steps++;
      lastGood = this.feet();
      record();
      await this.oreAround(gen, lastGood);
      if (this.caveHere() && this.a.health() >= 12) await this.exploreCave(gen, lastGood, level, more); // (a cave is where the skeletons are: not when hurt)
      // Branches every 3rd block, spaced off the branches already dug (a trip that started again
      // somewhere else, a turn, a death): two solid blocks between any two, never one beside another.
      const o = this.branchNear(lastGood, dx, dz);
      let branchHere = false;
      if (o !== null) since = -o;
      else if (++since >= 3) { since = 0; branchHere = true; }
      if (branchHere) {
        for (const side of [1, -1]) {
          if (!more()) break;
          await this.branch(gen, side * -dz, side * dx, 8, more);
        }
      }
    }
    record();
    // Boxed in at the end of the mine, nothing new dug: after two such calls in a row the quarry's
    // abandoned and a new one started, rather than walking the same dead ends every trip.
    if (q) {
      if (blocked >= 4 && fresh_n === 0) {
        q.deadMine = (q.deadMine ?? 0) + 1;
        this.log(`mine: boxed in, nothing new dug (${q.deadMine} in a row)`);
        if (q.deadMine >= 2) this.abandonQuarry('the mine is boxed in');
        else { q.mine = null; q.branch = null; this.a.memory.data.mineDir = undefined; }
        this.a.memory.save();
      } else if (fresh_n) q.deadMine = 0;
    }
  }

  /**
   * A branch of ours off the main tunnel near `at` (running (dx, dz)): its offset along the tunnel
   * (0 here, negative behind, positive ahead, within 2), or null. Seen by its floor two blocks out
   * to either side.
   */
  branchNear(at, dx, dz) {
    for (const o of [0, -1, 1, -2, 2]) if (this.branchAt(at, dx, dz, o)) return o;
    return null;
  }

  /** A branch of ours off the main tunnel (running (dx, dz)) at offset o from `at`, either side? */
  branchAt(at, dx, dz, o) {
    return [1, -1].some((s) => this.isTunnelFloor({ x: at.x + dx * o - s * dz * 2, y: at.y - 1, z: at.z + dz * o + s * dx * 2 }));
  }

  /** Which way to turn the main tunnel from `di` (tried: ways that were blocked here). */
  turnFrom(di, tried) {
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const f = this.feet();
    const lane = (d) => { let n = 0; for (let k = 1; k <= 8; k++) for (const w of [-2, -1, 0, 1, 2]) if (this.isTunnelFloor({ x: f.x + dirs[d][0] * k - dirs[d][1] * w, y: f.y - 1, z: f.z + dirs[d][1] * k + dirs[d][0] * w })) n++; return n; };
    const right = (di + 1) % 4, left = (di + 3) % 4, back = (di + 2) % 4;
    const opts = [right, left].filter((d) => !tried.has(d)).sort((a, b) => lane(a) - lane(b));
    return opts[0] ?? back;
  }

  /**
   * Our tunnels' floors (the branch mine's main tunnel and branches, any tunnel dug a step at a
   * time): runs [x, y, z, dir, n] (dir 0..3 as east, south, west, north), kept in a world property
   * of their own so a big mine is never forgotten to make room (the staircase list is capped at 300,
   * and an old tunnel that dropped off it looked like a cave).
   */
  get tunnels() {
    if (!this._tunnels) {
      this._tunnels = [];
      try {
        const raw = world.getDynamicProperty(TUNNELS_KEY);
        if (typeof raw === 'string' && raw) this._tunnels = raw.split(';').map((s) => s.split(',').map(Number)).filter((r) => r.length === 5 && r.every(Number.isFinite));
      } catch {}
    }
    return this._tunnels;
  }

  saveTunnels() {
    if (this._tunnelsDirty) return;
    this._tunnelsDirty = true;
    system.runTimeout(() => {
      this._tunnelsDirty = false;
      try { world.setDynamicProperty(TUNNELS_KEY, this.tunnels.map((r) => r.join(',')).join(';')); } catch (e) { console.warn(`[agent] tunnels save: ${e}`); }
    }, 100);
  }

  /** A tunnel step dug: its floor (one below the feet), dug going (dx, dz). */
  noteTunnel(floor, dx, dz) {
    const d = [[1, 0], [0, 1], [-1, 0], [0, -1]].findIndex(([a, b]) => a === dx && b === dz);
    if (d < 0 || this.isTunnelFloor(floor)) return;
    const runs = this.tunnels;
    const k = `${floor.x},${floor.y},${floor.z}`;
    // The next block of a run that ends right behind it, dug the same way.
    const r = runs.slice(-12).find(([x, y, z, rd, n]) => rd === d && y === floor.y && x + dx * n === floor.x && z + dz * n === floor.z);
    if (r) r[4]++;
    else {
      runs.push([floor.x, floor.y, floor.z, d, 1]);
      if (runs.length > 1500) { runs.splice(0, runs.length - 1500); this._tunnelCells = null; }
    }
    this._tunnelCells?.add(k);
    this.saveTunnels();
  }

  isTunnelFloor(p) {
    if (!this._tunnelCells) {
      const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      this._tunnelCells = new Set();
      for (const [x, y, z, d, n] of this.tunnels) for (let i = 0; i < n; i++) this._tunnelCells.add(`${x + dirs[d][0] * i},${y},${z + dirs[d][1] * i}`);
    }
    return this._tunnelCells.has(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`);
  }

  /**
   * Back onto the mine's level at `at` (our last spot in the tunnel) if we've dropped into a hole
   * (walking over ore drops, a vein followed down). False if we can't get back there.
   */
  async backOntoLevel(gen, at) {
    const f = this.feet();
    if (f.y === at.y) return true;
    this.log(`mine: off the level (Y ${f.y}, the mine's at ${at.y}): back up to it`);
    await this.goNear(gen, { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, 0.6, 2);
    return this.feet().y === at.y;
  }

  /** Put a cheap block in the floor cell (dirt, cobblestone: never planks). */
  async fillFloor(gen, cell) {
    const inv = invCounts(this.sim);
    const block = cheapestPlaceable(inv, this.blockReserve(inv));
    if (!block || !this.inReach(cell)) return false;
    let ok = await this.a.homestead.placeAt(gen, cell, block);
    this.restHands();
    // (Only what the world shows counts: a fill "put against the West face anyway" that never took let the mine walk on into an 18-block drop, four deaths at one spot in a 15:03 run.)
    if (ok) { await this.wait(gen, 3); ok = !OPEN.test(this.blockAt(cell) ?? 'air') && !this.isLiquid(cell); }
    if (ok) { this.markPlaced(cell); this.log(`mine: filled a hole in the floor at ${cell.x} ${cell.y} ${cell.z}`); }
    else this.log(`mine: couldn't fill the hole in the floor at ${cell.x} ${cell.y} ${cell.z}; turning back`);
    return ok;
  }

  /** What's worth a detour underground: iron (the gear) and coal (torches, fuel). */
  static isWanted(id) { return /^(deepslate_)?(iron|coal)_ore$/.test(id); }

  /**
   * Ore worth mining when it turns up, from what we have now (core/wants.js blockValue): coal for
   * torches and the furnace, iron for the gear, diamonds with an iron pickaxe. Not copper, gold,
   * redstone or lapis: nothing to make with them yet.
   */
  wantsOre(id) {
    if (!Skills.isOre(id)) return false;
    const inv = invCounts(this.sim);
    return blockValue(id, { inv, worn: this.a.worn?.() ?? [] }) > 0 && !!chooseTool(id, inv, { needDrop: true });
  }

  /**
   * Iron and coal ore we can see within `radius` (not just in reach): walk over and mine the vein,
   * iron first then nearest, if the walk there is short. Returns how many veins we mined.
   */
  async oreInView(gen, radius, { maxWalk = 16, minY = -Infinity, limit = 6 } = {}) {
    const f = this.feet();
    const found = (await this.scan((id) => this.wantsOre(id), { radius, below: Math.min(radius, 8), above: Math.min(radius, 8), limit: 16 }))
      .filter((b) => b.y >= minY && !this.a.memory.isUnreachable(b) && this.sees(b) && chooseTool(b.id, invCounts(this.sim), { needDrop: true }));
    this.rememberOre(found.filter((b) => /iron_ore$/.test(b.id))); // till it's mined: a trip cut short comes back for it
    found.sort((a, b) => (/iron/.test(b.id) ? 1 : 0) - (/iron/.test(a.id) ? 1 : 0) || dist3D(f, a) - dist3D(f, b));
    let n = 0;
    for (const b of found.slice(0, limit)) {
      this.check(gen);
      if (!this.wantsOre(this.blockAt(b) ?? '')) continue; // part of a vein we've just mined
      if (!this.inReach(b)) {
        const res = await this.a.plan(this.sim.location, center(b), REACH - 0.7, 2500);
        this.check(gen);
        if (!res.complete || res.path.length > maxWalk) { this.a.memory.markUnreachable(b, 300000); continue; }
      }
      if (await this.mineVein(gen, b)) n++;
      else this.a.memory.markUnreachable(b, 300000);
    }
    return n;
  }

  /**
   * Did that tunnel step open into a cave? Open air round us that isn't our own tunnels or stairs
   * (their floors are protected): a handful of cells of it.
   */
  caveHere() {
    const f = this.feet();
    let n = 0;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      if (Math.abs(dx) + Math.abs(dz) < 2) continue;
      for (const dy of [0, 1, 2]) {
        const c = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
        if ((this.blockAt(c) ?? 'stone') !== 'air') continue;
        let ours = false;
        for (let k = 1; k <= 3 && !ours; k++) ours = this.isProtected({ x: c.x, y: c.y - k, z: c.z });
        if (!ours) n++;
      }
    }
    return n >= 6;
  }

  /**
   * Broke into a cave from the mine: have a look round it for iron (and coal) before carrying on
   * with the mine. Walks the cave floor near the mine's level, a leg at a time to parts not seen
   * yet, mining what it can see; lights it as it goes; then back to `back` in the mine. Each cave is
   * explored once (remembered in the world), and time-boxed.
   */
  async exploreCave(gen, back, level, more) {
    const mem = this.a.memory.data;
    const key = `${back.x >> 4},${back.y >> 4},${back.z >> 4}`;
    const done = mem.cavesDone ?? (mem.cavesDone = []);
    if (done.includes(key)) return 0;
    // A real cave, not just the hole a vein of ore left: floor to walk to 6+ blocks off that isn't ours.
    const f0 = this.feet();
    const probe = await this.a.plan(this.sim.location, this.sim.location, 0, 1500, (x, y, z, w) => w.standable(x, y, z) &&
      !this.isProtected({ x, y: y - 1, z }) && Math.hypot(x - f0.x, z - f0.z) >= 6 && y >= level - 6 && y <= level + 6);
    this.check(gen);
    if (!probe.complete) return 0;
    done.push(key);
    if (done.length > 60) done.shift();
    this.a.memory.save();
    this.a.say('Broke into a cave: having a look round it for iron before I carry on with the mine.');
    const t0 = system.currentTick, origin = this.feet(), seen = new Set();
    let ore = 0, legs = 0;
    const cell = (x, y, z) => `${x >> 2},${y >> 2},${z >> 2}`;
    // (Nothing in view after three legs and 40 s: not a cave with ore in it, on to the mine. Four of these in one run took ~1.5 min for no veins.)
    while (legs < 8 && system.currentTick - t0 < 90 * 20 && more() && !(ore === 0 && legs >= 3 && system.currentTick - t0 > 40 * 20)) {
      this.check(gen);
      ore += await this.oreInView(gen, 16, { maxWalk: 30, minY: level - 8 });
      await this.lightQuarry(gen, null);
      const f = this.feet();
      seen.add(cell(f.x, f.y, f.z));
      // The next part of the cave: floor we haven't stood near, within 24 of where we came in, not
      // far above or below the mine (no following it down to lava).
      const res = await this.a.plan(this.sim.location, this.sim.location, 0, 3000, (x, y, z, w) => w.standable(x, y, z) &&
        !this.isProtected({ x, y: y - 1, z }) && Math.hypot(x - f.x, z - f.z) >= 6 && Math.hypot(x - origin.x, z - origin.z) <= 24 &&
        y >= level - 6 && y <= level + 6 && !seen.has(cell(x, y, z)));
      this.check(gen);
      if (!res.complete || res.path.length < 2) break;
      for (const p of res.path) seen.add(cell(p.x, p.y, p.z));
      await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
      this.check(gen);
      legs++;
    }
    this.log(`cave: ${legs} legs, ${ore} veins; back to the mine at ${back.x} ${back.y} ${back.z}`);
    await this.goNear(gen, { x: back.x + 0.5, y: back.y, z: back.z + 0.5 }, 0.6, 3);
    if (ore) this.a.say(`Done with the cave (${ore} vein${ore > 1 ? 's' : ''} of ore); back to the branch mine.`);
    return ore;
  }

  /** One branch off the main tunnel, `len` long, then back to where it started. */
  async branch(gen, dx, dz, len, more, from = null) {
    const start = from ?? { ...this.feet() };
    // Kept in the world as we go: a trip cut short (night, a fight, a full pack) finishes this branch
    // next time rather than starting another past it.
    const q = this.homeQuarry();
    const save = (at, left) => { if (q) { q.branch = left > 0 ? { start, at, dx, dz, left } : null; this.a.memory.save(); } };
    let n = 0, at = this.feet();
    save(at, len);
    for (; n < len && more(); n++) {
      if (!(await this.backOntoLevel(gen, at))) break;
      if (!(await this.tunnelStep(gen, dx, dz))) { n = len; break; } // a dead end: the branch is done
      at = this.feet();
      save(at, len - n - 1);
      await this.oreAround(gen, at);
      if (this.caveHere() && this.a.health() >= 12) await this.exploreCave(gen, at, start.y, more);
    }
    if (n >= len) save(at, 0);
    if (n) await this.goNear(gen, { x: start.x + 0.5, y: start.y, z: start.z + 0.5 }, 0.6, 2);
    return n;
  }

  /**
   * One step of a 2-high tunnel: mine head and feet ahead (if solid and safe), step in, keep the
   * floor as the way back, light it. False if it isn't safe (liquid, a drop, loose blocks above,
   * under the house).
   */
  async tunnelStep(gen, dx, dz) {
    const f = this.feet();
    const feet = { x: f.x + dx, y: f.y, z: f.z + dz }, head = { ...feet, y: f.y + 1 };
    const floorId = this.blockAt({ ...feet, y: f.y - 1 }) ?? 'air';
    const home = this.a.homestead?.house;
    if (home && Math.hypot(feet.x - home.x, feet.z - home.z) < 8 && f.y > home.y - 12) return false;
    const safe = (c) => !this.touchesLiquid(c) && !this.isLiquid(c) && this.isDiggable([c]) && !FALLING.test(this.blockAt({ ...c, y: c.y + 1 }) ?? '');
    if (!safe(feet) || !safe(head) || /water|lava/.test(floorId)) return false;
    if (OPEN.test(floorId)) {
      // A hole in the floor ahead (ore we mined out of it, a small cave): fill it and keep the
      // tunnel level. Stepping down into it is how the mine crept below the iron layer.
      const floor = { ...feet, y: f.y - 1 };
      if (!(await this.fillFloor(gen, floor))) return false;
    }
    // Head then feet, one swing leading into the next.
    const cut = [head, feet].filter((c) => !OPEN.test(this.blockAt(c) ?? 'air'));
    const ores = new Set(cut.filter((c) => this.wantsOre(this.blockAt(c) ?? '')).map((c) => `${c.x},${c.y},${c.z}`));
    await this.mineFlow(gen, cut, (c) => ({ collect: ores.has(`${c.x},${c.y},${c.z}`) }));
    if (cut.some((c) => !OPEN.test(this.blockAt(c) ?? 'air'))) return false;
    const r = await this.a.motor.followPath([{ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }, { x: feet.x + 0.5, y: f.y, z: feet.z + 0.5 }]);
    this.check(gen);
    await this.collect(gen, this.sim.location, 3, 2, false);
    if (r.status !== 'arrived') return false;
    this.noteTunnel({ x: feet.x, y: f.y - 1, z: feet.z }, dx, dz);
    await this.lightQuarry(gen, { x: f.x, y: f.y, z: f.z });
    return true;
  }

  /** Ore showing on the walls around us (in reach and in view): mine it, whole veins. */
  async mineExposedOre(gen) {
    const ores = (await this.scan((id) => this.wantsOre(id), { radius: 4, below: 2, above: 3, limit: 12 }))
      .filter((b) => this.inReach(b) && this.sees(b) && chooseTool(b.id, invCounts(this.sim), { needDrop: true })); // (floor ore too: mineVein fills it back)
    this.rememberOre(ores.filter((b) => /iron_ore$/.test(b.id)));
    let n = 0;
    for (const b of ores) if (this.wantsOre(this.blockAt(b) ?? '') && (await this.mineVein(gen, b))) n++;
    return n;
  }

  /**
   * Mine an ore block and the rest of its vein (ore of the same kind touching it), up to 16 blocks.
   * Only what's safe to open (no liquid behind) and never our own stairs.
   */
  async mineVein(gen, start) {
    const kind = (this.blockAt(start) ?? '').replace(/^deepslate_/, '');
    if (!Skills.isOre(kind)) return false;
    const same = (id) => (id ?? '').replace(/^deepslate_/, '') === kind;
    const todo = [start], done = new Set(), refill = [];
    const stand = this.feet();
    let n = 0;
    // Coal past what's wanted isn't taken: a vein of 16 and another of 4 with 7 coal in the pack was 30 s of mining for 32 coal (iron
    // gear smelts on about 5). The vein's left; whatever's in the way of the next thing is still cut.
    const coalHave = kind === 'coal_ore' ? (invCounts(this.sim).coal ?? 0) + (invCounts(this.sim).charcoal ?? 0) : 0;
    while (todo.length && n < 16 && !(kind === 'coal_ore' && coalHave + n >= 24)) {
      this.check(gen);
      // Nearest first, from where we are: a vein mined in the order it was found had us walking
      // round it and back.
      const here = this.sim.location;
      todo.sort((a, b) => dist3D(here, center(a)) - dist3D(here, center(b)));
      const b = todo.shift();
      const k = `${b.x},${b.y},${b.z}`;
      if (done.has(k)) continue;
      done.add(k);
      if (!same(this.blockAt(b)) || this.touchesLava(b) || this.touchesLiquid(b)) continue;
      if (!chooseTool(this.blockAt(b), invCounts(this.sim), { needDrop: true })) break; // pickaxe too weak for it
      // Ore in our own floor (a tunnel's, a quarry step): mine it, then fill it back in, so the floor
      // stays level and the way back stays whole. (These were skipped as protected: iron under our
      // feet went unmined while the iron in the wall got taken.)
      const floor = this.isProtected(b);
      if (floor) {
        const f = this.feet();
        if (b.x === f.x && b.z === f.z && b.y < f.y && !(await this.stepOffFloor(gen, b))) continue;
      }
      // Drops are picked up once, at the end: a sweep after every block had us chasing each one
      // into the pocket we'd just dug.
      if (!(await this.mine(gen, b, { collect: false, force: floor }))) continue;
      n++;
      if (floor) refill.push(b);
      for (const [ox, oy, oz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const c = { x: b.x + ox, y: b.y + oy, z: b.z + oz };
        if (same(this.blockAt(c))) todo.push(c);
      }
    }
    if (n) {
      await this.collect(gen, this.sim.location, 5, 3);
      // Floor we took ore out of: back in with a cheap block (from where we stood, if we can).
      for (const c of refill) {
        if (!OPEN.test(this.blockAt(c) ?? 'air')) continue;
        if (!this.inReach(c)) await this.goNear(gen, { x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, 0.6, 1);
        const f = this.feet();
        if (c.x === f.x && c.z === f.z && c.y < f.y) continue; // standing in it: leave it
        await this.fillFloor(gen, c);
      }
      this.forgetOre(done);
      this.log(`ore: mined ${n} ${kind.replace(/_/g, ' ')}${refill.length ? ` (${refill.length} from the floor, filled back in)` : ''}`);
    }
    return n > 0;
  }

  /** Room to stand in cell c: open at feet and head, something solid (not liquid) under it. */
  standable(c) {
    const at = (y) => this.blockAt({ x: c.x, y, z: c.z }) ?? 'air';
    return OPEN.test(at(c.y)) && OPEN.test(at(c.y + 1)) && !OPEN.test(at(c.y - 1)) && !/water|lava/.test(at(c.y - 1));
  }

  /**
   * Iron we've seen in the mine but not mined yet, kept in the world: a trip cut short (night, a
   * fight, a full pack) comes back for it next time instead of starting a new branch past it.
   */
  rememberOre(blocks) {
    if (!blocks.length) return;
    const mem = this.a.memory.data;
    const list = mem.pendingOre ?? (mem.pendingOre = []);
    let added = 0;
    for (const b of blocks) { const k = `${b.x},${b.y},${b.z}`; if (!list.includes(k)) { list.push(k); added++; } }
    if (list.length > 48) list.splice(0, list.length - 48);
    if (added) this.a.memory.save();
  }

  /** Mined (or gone): off the list. */
  forgetOre(keys) {
    const list = this.a.memory.data.pendingOre;
    if (!list?.length) return;
    const drop = new Set(keys);
    const kept = list.filter((k) => !drop.has(k) && /iron_ore$/.test(this.blockAt((([x, y, z]) => ({ x, y, z }))(k.split(',').map(Number))) ?? 'iron_ore'));
    if (kept.length !== list.length) { this.a.memory.data.pendingOre = kept; this.a.memory.save(); }
  }

  /**
   * Back for iron seen on an earlier trip (pendingOre) within reach of the mine, nearest first.
   * Returns veins mined.
   */
  async pendingIron(gen, more) {
    const list = this.a.memory.data.pendingOre ?? [];
    if (!list.length) return 0;
    const f = this.feet();
    const cells = list.map((k) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; })
      .filter((b) => Math.abs(b.y - f.y) <= 12 && dist3D(f, b) <= 64 && !this.a.memory.isUnreachable(b))
      .sort((a, b) => dist3D(f, a) - dist3D(f, b));
    let n = 0;
    for (const b of cells) {
      if (!more()) break;
      this.check(gen);
      if (!/iron_ore$/.test(this.blockAt(b) ?? '')) { this.forgetOre([`${b.x},${b.y},${b.z}`]); continue; }
      this.log(`iron: back for the ore seen last trip at ${b.x} ${b.y} ${b.z}`);
      if (!this.inReach(b)) {
        const res = await this.a.plan(this.sim.location, center(b), REACH - 0.7, 6000);
        this.check(gen);
        if (!res.complete) { this.a.memory.markUnreachable(b, 600000); continue; }
        await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
        this.check(gen);
      }
      if (await this.mineVein(gen, b)) n++;
      else this.a.memory.markUnreachable(b, 600000);
    }
    return n;
  }

  /** Ore in the floor right under us: step onto the tunnel next to it first (never dig our own floor out from under us). */
  async stepOffFloor(gen, b) {
    const f = this.feet();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = { x: f.x + dx, y: f.y, z: f.z + dz };
      if (!this.standable(c)) continue;
      await this.goNear(gen, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, 0.4, 1);
      const g = this.feet();
      if (!(g.x === b.x && g.z === b.z)) return this.inReach(b);
    }
    return false;
  }

  /**
   * Keep room in the pack: toss the stone we'll never use when the pack's nearly full (a strip mine
   * turns up stacks of it). Keeps 2 stacks of cobblestone and 1 of deepslate cobble for building.
   */
  async dumpJunk(gen, hard = false, below = 4) {
    const c = container(this.sim);
    if (!c || c.emptySlotsCount >= below) return 0;
    // hard: night in the mine with a full pack. Keep a stack of cobblestone, toss the rest, rather
    // than walk home in the dark to the chest.
    const keep = hard ? { cobblestone: 64 } : { cobblestone: 128, cobbled_deepslate: 64 };
    const junk = /^(andesite|diorite|granite|tuff|gravel|dirt|cobbled_deepslate|cobblestone|calcite|flint)$/;
    const seen = {};
    let tossed = 0;
    for (let i = 0; i < c.size; i++) {
      const it = c.getItem(i);
      if (!it) continue;
      const id = strip(it.typeId);
      if (!junk.test(id)) continue;
      seen[id] = (seen[id] ?? 0) + it.amount;
      if (seen[id] > (keep[id] ?? 0)) { c.setItem(i, undefined); tossed += it.amount; }
    }
    if (tossed) this.log(`pack nearly full: tossed ${tossed} junk stone`);
    return tossed;
  }

  /** Which way from here has the most stone at feet and head height, a few blocks deep. */
  stoniestDir() {
    const f = this.feet();
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let best = 0, bestN = -1;
    dirs.forEach(([dx, dz], i) => {
      let n = 0;
      for (let k = 1; k <= 3; k++) for (const dy of [0, 1]) if (STONEISH.test(this.blockAt({ x: f.x + dx * k, y: f.y + dy, z: f.z + dz * k }) ?? '')) n++;
      if (n > bestN) { bestN = n; best = i; }
    });
    return best;
  }

  /**
   * Back to the quarry: down our own stairs to the bottom, tunnel on from there toward the most
   * stone, and if that level's used up, carry the same staircase on down from the bottom.
   */
  async workQuarry(gen, more) {
    if (!(await this.toShaftBottom(gen))) return false;
    const have = () => count(invCounts(this.sim), (id) => TOOL_STONE.has(id));
    const h0 = have();
    const b = this.feet();
    // At the iron layer the shaft stops and the branch mine (via digStairs) takes over.
    const t = b.y > Skills.IRON_Y ? await this.tunnel(gen, more, this.stoniestDir()) : { mined: 0 };
    this.log(`quarry: tunnelled ${t.mined} from the bottom at ${b.x} ${b.y} ${b.z}`);
    if (!more()) return true;
    await this.digStairs(gen, more); // this level's done here: back to the stairs and on down
    if (have() === h0) {
      const q = this.quarry;
      if (q) { q.dry = (q.dry ?? 0) + 1; this.a.memory.save(); }
      this.log(`quarry: nothing more from the bottom this time (${q?.dry ?? 0} in a row)`);
      if ((q?.dry ?? 0) >= 3) this.abandonQuarry('nothing more to be had from it');
    } else if (this.quarry) this.quarry.dry = 0;
    return !more();
  }

  /**
   * A level 1x2 tunnel through stone from where we stand, starting in direction `di`: mine the
   * two blocks ahead and the stone either side of our feet, step in, repeat. Turns right every
   * 10 blocks (keeps it compact, close to the stairs) or when the way ahead isn't solid stone
   * (a cave, gravel, water, lava, not under the house). Returns { di, mined }.
   */
  async tunnel(gen, goal, di) {
    const have = () => count(invCounts(this.sim), (id) => TOOL_STONE.has(id));
    const more = typeof goal === 'function' ? goal : () => count(invCounts(this.sim), (id) => TOOL_STONE.has(id)) < goal; // goal: a count, or "keep going?"
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const home = this.a.homestead?.house ?? this.a.homestead?.project;
    const safe = (c) => !this.touchesLiquid(c) && !this.isLiquid(c) && this.isDiggable([c]) && !FALLING.test(this.blockAt({ ...c, y: c.y + 1 }) ?? '');
    let mined = 0, run = 0, blocked = 0;
    for (let n = 0; n < 48 && more() && blocked < 4; n++) {
      this.check(gen);
      const f = this.feet();
      const [dx, dz] = dirs[di];
      const feet = { x: f.x + dx, y: f.y, z: f.z + dz }, head = { ...feet, y: f.y + 1 };
      const floorId = this.blockAt({ ...feet, y: f.y - 1 }) ?? 'air';
      const stoneAhead = [feet, head].filter((c) => STONEISH.test(this.blockAt(c) ?? '')).length;
      const nearHome = home && Math.hypot(feet.x - home.x, feet.z - home.z) < 8;
      if (run >= 10 || nearHome || stoneAhead === 0 || !safe(feet) || !safe(head) || OPEN.test(floorId) || /water|lava/.test(floorId)) {
        di = (di + 1) % 4;
        run = 0;
        blocked++;
        continue;
      }
      blocked = 0;
      for (const c of [head, feet]) {
        if (OPEN.test(this.blockAt(c) ?? 'air')) continue;
        if (!(await this.mine(gen, c, { collect: false }))) return { di, mined };
        mined++;
      }
      // The walls beside our feet: stone we can take without taking a step.
      for (const [sx, sz] of [[-dz, dx], [dz, -dx]]) {
        const side = { x: feet.x + sx, y: feet.y, z: feet.z + sz };
        if (/^(stone|deepslate)$/.test(this.blockAt(side) ?? '') && safe(side) && more() && await this.mine(gen, side, { collect: false })) mined++;
      }
      const r = await this.a.motor.followPath([{ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }, { x: feet.x + 0.5, y: f.y, z: feet.z + 0.5 }]);
      this.check(gen);
      await this.collect(gen, this.sim.location, 3, 2);
      if (r.status !== 'arrived') return { di, mined };
      this.protect({ x: feet.x, y: f.y - 1, z: feet.z }); // tunnel floor
      await this.lightQuarry(gen, { x: f.x, y: f.y, z: f.z });
      await this.oreAround(gen, feet); // coal and iron in the tunnel walls: worth the moment
      run++;
    }
    this.a.memory.remember('stone', this.dim.id, this.feet(), 24); // the tunnel: come back to it next time
    return { di, mined };
  }

  /**
   * Blocks we must not mine: the treads of our staircases and the floors of our tunnels (the way
   * back up, and the quarry we come back to). Saved with the world, most recent 300.
   */
  protect(p) {
    const mem = this.a.memory;
    const k = `${p.x},${p.y},${p.z}`;
    const list = mem.data.stairs ?? (mem.data.stairs = []);
    if (list.includes(k)) return;
    list.push(k);
    if (list.length > 300) list.splice(0, list.length - 300); // bounded: the whole memory is one world property
    this._protected = null;
    mem.save();
  }

  isProtected(p) {
    // The treads of our staircases and tunnel floors, and every step of the quarry's shaft.
    if (!this._protected) this._protected = new Set([...(this.a.memory.data.stairs ?? []), ...(this.a.memory.data.quarry?.steps ?? [])]);
    return this._protected.has(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || this.isTunnelFloor(p);
  }

  /** Standing among stone (a quarry, a tunnel, a cave wall): most of the sides at feet and head height. */
  inStone() {
    const f = this.feet();
    let n = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) if (STONEISH.test(this.blockAt({ x: f.x + dx, y: f.y + dy, z: f.z + dz }) ?? '')) n++;
    return n >= 4;
  }

  isLiquid(p) {
    const id = this.blockAt(p) ?? '';
    return /water|lava/.test(id);
  }

  touchesLava(p) {
    return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
      .some(([x, y, z]) => /lava/.test(this.blockAt({ x: p.x + x, y: p.y + y, z: p.z + z }) ?? ''));
  }

  /** Water here drains into a short swim to open air (not a flooded tunnel we'd drown in)? */
  waterWithAirAbove(p, maxDepth = 22) { // swims up ~3 blocks/s: 22 blocks is ~8 s, inside the 15 s of air
    for (let y = p.y; y <= p.y + maxDepth; y++) {
      const id = this.blockAt({ x: p.x, y, z: p.z }) ?? '';
      if (id === 'air') return true;
      if (!/water|seagrass|kelp/.test(id)) return false;
    }
    return false;
  }

  /** Opening p would let in lava, or water we couldn't swim up out of. */
  dangerousLiquidNear(p) {
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0, 0, 0]]) {
      const q = { x: p.x + x, y: p.y + y, z: p.z + z };
      const id = this.blockAt(q) ?? '';
      if (/lava/.test(id)) return true;
      if (/water/.test(id) && !this.waterWithAirAbove(q)) return true;
    }
    return false;
  }

  touchesLiquid(p) {
    return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
      .some(([x, y, z]) => this.isLiquid({ x: p.x + x, y: p.y + y, z: p.z + z }));
  }

  /**
   * Only dig through natural terrain (or blocks we placed ourselves) that we have the tool, or
   * fists, for. Never through someone's build: a cobblestone wall, a glass roof, a floor.
   */
  isDiggable(cells, { byHand = false } = {}) {
    const inv = invCounts(this.sim);
    return cells.every((c) => {
      const id = this.blockAt(c);
      if (!id || id === 'air') return true;
      if (/leaves|^short_grass$|^tall_grass$|fern|flower|bush|snow_layer|^(muddy_)?mangrove_roots$|moss_carpet|propagule/.test(id)) return true;
      if (/^(wall_|soul_|redstone_)?torch$/.test(id)) return true; // (our own lights in the way of a tunnel: break in a hit)
      if (!NATURAL.has(id) && !this.placedByMe(c)) return false;
      if (SHOVEL_BLOCKS.has(id) || id === 'snow') return true;
      // Escaping: stone can be punched through (slow, drops nothing) when there's no pickaxe.
      if (PICKAXE_BLOCKS.test(id)) return !!toolFor(id, inv) || byHand;
      return false; // bedrock, obsidian, chests, anything odd: go another way
    });
  }

  // ---------- getting out of caves ----------

  /**
   * y of the highest natural terrain block in this column. Trees, water, and anything built
   * (a glass sky roof, a house, a pillar) don't count: being under those isn't being underground.
   */
  groundTop(x, z, cache) {
    const k = `${x},${z}`;
    if (cache?.has(k)) return cache.get(k);
    let y = -Infinity;
    try {
      const top = this.dim.getTopmostBlock({ x, z });
      if (top) y = NATURAL.has(strip(top.typeId)) ? top.location.y : this.naturalBelow(x, top.location.y, z);
    } catch { y = -Infinity; } // unloaded: treat as open sky
    cache?.set(k, y);
    return y;
  }

  /** Highest natural block at or below y in this column (one native raycast, straight down). */
  naturalBelow(x, y, z) {
    const min = this.dim.heightRange.min;
    try {
      const hit = this.dim.getBlockFromRay({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }, { x: 0, y: -1, z: 0 }, {
        includeTypes: naturalTypeIds(), includeLiquidBlocks: false, includePassableBlocks: false, maxDistance: y - min + 1,
      });
      return hit ? hit.block.location.y : -Infinity;
    } catch {
      for (let yy = y; yy > Math.max(min, y - 96); yy--) { // raycast unavailable: step down
        const b = this.dim.getBlock({ x, y: yy, z });
        if (!b) return -Infinity;
        if (NATURAL.has(strip(b.typeId))) return yy;
      }
      return -Infinity;
    }
  }

  /**
   * Underground = rock or dirt over our head (cave, mine, our own staircase), the bottom of a
   * shaft/pit (three sides walled 2+ blocks up), or the floor of a ravine (ground 8+ blocks higher
   * on most sides).
   */
  isUnderground(p = this.feet()) {
    if (!this.isUndergroundCached(p.x, p.y, p.z, new Map())) return false;
    // Daylight on our head means open sky: a canyon floor or under a cliff's overhang, not a cave
    // (walking through badlands canyons read as "underground", so it kept climbing back out the
    // way it came). Hemmed in with no way out is still caught by isTrapped().
    try { if (this.dim.getSkyLightLevel({ x: p.x, y: p.y + 1, z: p.z }) >= 12) return false; } catch {}
    return true;
  }

  /**
   * Back up to open sky, cheapest way first:
   *   1. walk out (a cave mouth, our own staircase),
   *   2. pillar straight up: mine the block above, jump, place a block under us (1 block mined per
   *      level, and dirt/sand/cobble mined on the way refill the blocks),
   *   3. if sand or gravel hangs over us, drain it from the side first so it can't fall on us,
   *   4. otherwise a staircase (3 blocks per level, but needs no blocks: stone punched by hand drops nothing),
   *   5. and if every way up is blocked, tunnel sideways a few blocks and start again.
   */
  /**
   * Hemmed in with open sky: a hole or pit we can't jump out of (walls 2+ blocks). Checked by
   * trying to walk anywhere 8+ blocks away; the cheap underground test can't see a wide pit.
   */
  async isTrapped(gen) {
    const f = this.feet();
    // Asked before nearly every step: the same spot, nothing changed by us, a few seconds ago, is
    // the same answer (a 600-node search each time was most of the pause between steps).
    const k = `${f.x},${f.y},${f.z}`, c = this.trappedAt, gen0 = this.a.cellGen ?? 0;
    if (c && c.k === k && c.gen === gen0 && system.currentTick - c.at < 100) return c.v;
    const res = await this.a.plan(this.sim.location, this.sim.location, 0, 600,
      (x, y, z, w) => w.standable(x, y, z) && Math.hypot(x - f.x, z - f.z) >= 8);
    this.check(gen);
    const v = !res.complete && res.expanded < 600; // searched the whole enclosure, found no way out
    this.trappedAt = { k, gen: gen0, at: system.currentTick, v };
    return v;
  }

  async needsEscape(gen) {
    if (this.a.homestead?.isHome()) return false; // our own house: the door is the way out
    if (this.isUnderground()) { this.log(`escape: underground at ${this.feet().x} ${this.feet().y} ${this.feet().z}`); return true; }
    if (await this.isTrapped(gen)) { this.log(`escape: hemmed in at ${this.feet().x} ${this.feet().y} ${this.feet().z}`); return true; }
    return false;
  }

  async toSurface(gen) {
    if (!(await this.needsEscape(gen))) return true;
    // Standing on a tree's canopy (climbed up for the top logs, or walked onto it from a hill):
    // leaves aren't ground to the path search, so everything looks like a dead end. Punch down
    // through them (a fraction of a second each) and drop; a log under us gets chopped too.
    if (await this.offCanopy(gen)) { if (!(await this.needsEscape(gen))) return true; }
    // Hemmed in by height, not by rock: on top of a pillar, a tree, a spire. The way out is down.
    if (this.perched()) {
      if (await this.getDown(gen)) return true;
      if (!(await this.needsEscape(gen))) return true;
    }
    this.a.sayOnce('surface', 'Heading back up to the surface.', 20000);
    // Just arrived somewhere (spawned, teleported)? The chunks around may still be loading.
    for (let i = 0; i < 10 && this.blockAt({ ...this.feet(), x: this.feet().x + 16 }) === null; i++) await this.wait(gen, 20);
    const startY = this.feet().y;
    let lastY = startY, stalls = 0, handSaid = false, relocations = 0, looseTried = false, shaftMoves = 0, actionTries = 0;
    for (let round = 0; round < 250; round++) {
      this.check(gen);
      if (!(await this.needsEscape(gen))) break;
      if (await this.walkOut(gen)) break;
      if (this.perched() && (await this.getDown(gen))) break;
      if (actionTries++ < 3 && (await this.actionEscape(gen))) break;
      const byHand = !toolFor('stone', invCounts(this.sim));
      if (byHand && !handSaid && this.coverAbove() > 3) {
        handSaid = true;
        this.a.sayOnce('byhand', "No pickaxe, so I'm digging out by hand. Stone is slow to punch through; toss me a pickaxe and I'll be out much faster.", 120000);
      }
      // Like a player: first get as high as walking and jumping allow, then build or dig from there.
      if (await this.climbHighest(gen)) continue;
      const need = this.climbNeeded();
      const openAbove = this.coverAbove() === 0;
      // Then the cheaper way up from here, per level: a pillar (clear the block above, stand on a
      // block: nearly free with dirt on hand or in reach) or a staircase (three blocks to break,
      // which by hand in stone is 22 s a level).
      const cost = this.upCost(byHand);
      this.lastUpCost = `pillar ${cost.pillar.toFixed(1)}s/level vs stairs ${cost.stairs.toFixed(1)}s/level`;
      this.log(`way up: ${this.lastUpCost} (${need} to go)`);
      if (cost.stairs < cost.pillar) {
        if (openAbove && !this.nextToWall()) await this.walkToWall(gen);
        if (await this.stairStep(gen, byHand)) {
          const y = this.feet().y;
          if (y > lastY) { lastY = y; stalls = 0; }
          continue;
        }
      } else if (openAbove && !this.nextToWall()) {
        await this.walkToWall(gen); // a pillar in the open would strand us: lean on a wall
      }
      // Pick a column that's clean all the way up (no water or lava in or beside it, no loose
      // sand/gravel) before starting a shaft; a player eyes the ceiling the same way.
      if (!openAbove && !this.columnSafe(this.feet()) && shaftMoves++ < 3) {
        const spot = await this.findShaftSpot(gen);
        if (spot) { await this.goNear(gen, spot, 0.5, 2); continue; }
      }
      // Pillar: inside rock the shaft keeps walls around us, and the blocks we mine on the way up
      // refill us. In the open it only climbs while a wall is beside us.
      if (this.blockCount() < need && cost.pillar < Infinity) {
        if ((await this.gatherBlocks(gen, Math.min(64, need + 2), byHand)) < need && !looseTried) {
          looseTried = true;
          await this.gatherLoose(gen, Math.min(40, need + 2));
        }
      }
      const why = await this.pillarUp(gen, byHand);
      this.log(`pillar stopped: ${why}`);
      if (!(await this.needsEscape(gen))) break;
      if (why === 'falling' && (await this.drainSide(gen, byHand))) continue;
      // Out of blocks to stand on: grab some from the walls around us (quick with a pickaxe, or
      // dirt/sand by hand), then pillar again.
      if (why === 'noBlocks' && (await this.gatherBlocks(gen, Math.min(24, this.climbNeeded() + 2), byHand)) > 0) continue;
      // By hand, stone drops nothing and a staircase costs 3 punched blocks per level. Loose dirt or
      // gravel nearby comes out fast by hand and lets us pillar instead (1 punched block per level).
      if (why === 'noBlocks' && byHand && !looseTried) {
        looseTried = true;
        if ((await this.gatherLoose(gen, Math.min(40, this.climbNeeded() + 4))) >= 4) continue;
      }
      if ((why === 'open' || why === 'exposed') && (await this.walkToWall(gen))) continue;
      if (why !== 'climbed' && !(await this.stairStep(gen, byHand)) && !(await this.tunnelSideways(gen, byHand))) {
        // Nothing works from this spot (water, lava, sand everywhere): try again from somewhere else.
        if (relocations++ < 6 && (await this.relocate(gen))) { stalls = 0; continue; }
        this.a.sayOnce('cantdigup', "I can't find a safe way up from here.", 60000);
        return false;
      }
      const y = this.feet().y;
      if (y > lastY) { lastY = y; stalls = 0; } else if (++stalls > 8) return false;
      if (round % 10 === 9) this.a.sayOnce('digup-progress', `Still working my way up, about ${Math.max(1, this.coverAbove())} blocks to go.`, 60000);
    }
    if (await this.needsEscape(gen)) return false;
    await this.walkOut(gen); // step off the top of the pillar/stairs onto proper ground
    this.a.sayOnce('surfaced', 'Out on the surface.', 20000);
    return true;
  }

  /**
   * Walk to the highest spot we can reach without breaking or placing anything (a ledge, a slope,
   * the top of a rubble pile). Returns true if that took us up.
   */
  async climbHighest(gen) {
    const f = this.feet();
    /** @type {{x:number,y:number,z:number}|null} */
    let best = null;
    const probe = (x, y, z, w) => {
      if (y > (best ? best.y : f.y) && w.standable(x, y, z)) best = { x, y, z };
      return false;
    };
    await this.a.plan(this.sim.location, this.sim.location, 0, 3000, probe);
    this.check(gen);
    best = /** @type {{x:number,y:number,z:number}|null} */ (best);
    if (!best) return false;
    this.log(`highest point I can walk to: ${best.y - f.y} up at ${best.x} ${best.y} ${best.z}`);
    this.a.sayOnce('climbhigh', 'Getting up as high as I can first.', 60000);
    await this.goNear(gen, { x: best.x + 0.5, y: best.y, z: best.z + 0.5 }, 0.8, 2);
    return this.feet().y > f.y;
  }

  /** Seconds per level to go up from here by pillaring vs by a staircase. */
  upCost(byHand) {
    const f = this.feet();
    const inv = invCounts(this.sim);
    const brk = (p) => {
      const id = this.blockAt(p) ?? 'air';
      if (OPEN.test(id)) return 0;
      if (!this.isDiggable([p], { byHand: true })) return Infinity;
      return chooseTool(id, inv, { needDrop: false })?.seconds ?? Infinity;
    };
    // Pillar: the block above our head, the jump-and-place, and a block to stand on.
    let blockS = 0.2;
    if (this.blockCount() < this.climbNeeded()) {
      blockS = 15; // walk off and dig some dirt somewhere
      for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 4; dy++) for (let dz = -3; dz <= 3; dz++) {
        if (dx === 0 && dz === 0) continue;
        const p = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
        const id = this.blockAt(p) ?? 'air';
        if (id === 'air' || !NATURAL.has(id) || !this.inReach(p)) continue;
        blockS = Math.min(blockS, blockSourceCost(id, inv, dist3D(f, p)));
      }
    }
    const canPillar = this.nextToWall() || this.coverAbove() > 0;
    const pillar = canPillar ? brk({ x: f.x, y: f.y + 2, z: f.z }) + 0.6 + blockS : Infinity;
    // Stairs: our headroom plus two blocks in front, in the best direction.
    let stairs = Infinity;
    for (const [dx, dz] of this.upDirections()) {
      if (!this.blockAt({ x: f.x + dx, y: f.y, z: f.z + dz }) || OPEN.test(this.blockAt({ x: f.x + dx, y: f.y, z: f.z + dz }) ?? 'air')) continue; // no step to stand on
      const cells = [{ x: f.x, y: f.y + 2, z: f.z }, { x: f.x + dx, y: f.y + 1, z: f.z + dz }, { x: f.x + dx, y: f.y + 2, z: f.z + dz }];
      stairs = Math.min(stairs, cells.reduce((a, c) => a + brk(c), 0) + 0.5);
    }
    return { pillar, stairs };
  }

  /** Blocks of ground above our head (0 in the open). */
  coverAbove() {
    const f = this.feet();
    return Math.max(0, this.groundTop(f.x, f.z) - (f.y + 1));
  }

  /** How many levels we still have to climb: through the cover above, or up to a ravine's rim. */
  climbNeeded() {
    return Math.max(this.coverAbove() + 1, this.rimClimb(), 0);
  }

  /** Levels up to the rim of the pit or ravine we're in (the lowest of the five highest sides). */
  rimClimb(f = this.feet()) {
    const rim = [[6, 0], [-6, 0], [0, 6], [0, -6], [4, 4], [-4, 4], [4, -4], [-4, -4]]
      .map(([dx, dz]) => this.groundTop(f.x + dx, f.z + dz)).filter(Number.isFinite).sort((a, b) => b - a);
    return rim.length >= 5 ? rim[4] + 1 - f.y : 0;
  }

  /**
   * Blocks we mean to keep rather than stand on: the cobblestone still owed to the current goal
   * (stone pickaxe 3, stone sword 2, a furnace 8). Dirt and andesite are spent first anyway.
   */
  blockReserve(inv = invCounts(this.sim)) {
    const better = (kind) => ['stone', 'iron', 'diamond', 'netherite'].some((t) => (inv[`${t}_${kind}`] ?? 0) > 0);
    const furnace = (inv.furnace ?? 0) > 0 || !!this.a.homestead?.house?.furnace || this.a.memory.list('furnace', this.dim.id, this.sim.location).length > 0;
    // The house's cobblestone too, until it's built (walls, corners and filler under the floor).
    const H = this.a.homestead;
    const house = H?.house ? 0 : 27;
    return { ...plankReserve(inv), cobblestone: (better('pickaxe') ? 0 : 3) + (better('sword') ? 0 : 2) + (better('axe') ? 0 : 3) + (better('shovel') ? 0 : 1) + (furnace ? 0 : 8) + house };
  }

  /** Placeable blocks we can spend (all of them if `all`, else without touching the reserve). */
  blockCount({ all = false } = {}) {
    const inv = invCounts(this.sim);
    return spendableBlocks(inv, all ? {} : this.blockReserve(inv));
  }

  /** Walk to open sky if there's any route. Returns true if we got out. */
  async walkOut(gen) {
    // In our quarry: up our own stairs (known, no search, no new holes dug to get out).
    if (await this.leaveQuarry(gen)) {
      this.check(gen);
      if (!(await this.needsEscape(gen))) return true;
    }
    // The way we came in: the last place we stood on the surface, if we can walk back to it.
    const back = this.a.lastSurface?.();
    if (back && dist3D(this.sim.location, back) < 120) {
      const res = await this.a.plan(this.sim.location, back, 1.5, 12000);
      this.check(gen);
      if (res.complete && res.path.length >= 2) {
        this.log(`walking back out the way I came (${res.path.length} steps)`);
        await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path), { urgent: this.sim.isInWater });
        this.check(gen);
        if (!(await this.needsEscape(gen))) return true;
      }
    }
    const cache = new Map();
    const f = this.feet();
    const outside = (x, y, z, w) => (w.standable(x, y, z) || w.swimmable(x, y, z)) && !this.isUndergroundCached(x, y, z, cache) &&
      (Math.hypot(x - f.x, z - f.z) >= 6 || y >= f.y + 2); // not just the other side of the same pit
    const res = await this.a.plan(this.sim.location, this.sim.location, 0, 30000, outside);
    this.check(gen);
    this.log(`surface route: ${res.complete ? `${res.path.length} steps` : `none walkable (${res.expanded} cells searched)`}`);
    if (!res.complete) return false;
    if (res.path.length >= 2) await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path), { urgent: this.sim.isInWater });
    this.check(gen);
    return !(await this.needsEscape(gen));
  }

  isUndergroundCached(x, y, z, cache) {
    if (this.groundTop(x, z, cache) >= y + 1) return true;
    let walls = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.groundTop(x + dx, z + dz, cache) >= y + 1) walls++;
    if (walls >= 3) return true;
    // Open sky. Topsoil underfoot (grass, dirt, sand, snow) means real surface, even in a valley.
    if (this.topsoilNear(x, y, z)) return false;
    return this.inCanyon(x, y, z, cache);
  }

  topsoilNear(x, y, z) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (TOPSOIL.test(this.blockAt({ x: x + dx, y: y - 1, z: z + dz }) ?? '')) return true;
    }
    return false;
  }

  /**
   * Open sky but at the bottom of a ravine or sinkhole: the ground around us (16 blocks out, 8
   * directions) is mostly 12+ blocks higher, or the nearby walls (6 out) are 8+ higher.
   */
  inCanyon(x, y, z, cache) {
    let nearHigh = 0, farHigh = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
      if (this.groundTop(x + Math.round(dx * 6), z + Math.round(dz * 6), cache) >= y + 8) nearHigh++;
      if (this.groundTop(x + Math.round(dx * 16), z + Math.round(dz * 16), cache) >= y + 12) farHigh++;
    }
    return nearHigh >= 5 || farHigh >= 6;
  }

  /** Is the block above p sand/gravel (would fall into p once p is opened)? */
  fallingAbove(p) {
    return FALLING.test(this.blockAt({ x: p.x, y: p.y + 1, z: p.z }) ?? '');
  }

  /** Slot of the least valuable block to put down (dirt before andesite before cobblestone before planks). */
  placeableSlot() {
    const inv = invCounts(this.sim);
    const id = cheapestPlaceable(inv, this.blockReserve(inv));
    return id ? findSlot(this.sim, id) : -1;
  }

  /**
   * Pillar straight up in this column. Returns why it stopped:
   * 'climbed' (made progress, surface reached or ran out), 'noBlocks', 'falling', 'blocked', 'liquid'.
   */
  async pillarUp(gen, byHand) {
    let climbed = 0;
    for (let i = 0; i < 80 && (this.isUnderground() || this.rimClimb() > 0); i++) {
      this.check(gen);
      const f = this.feet();
      // Only climb with a wall beside us: in a shaft that's always so; in a big cavern or a ravine
      // a free-standing tower would leave us stranded in mid-air.
      if (!this.canPillarHere(byHand)) return climbed ? 'exposed' : (this.coverAbove() > 0 ? 'noBlocks' : 'open');
      const head = { x: f.x, y: f.y + 2, z: f.z };
      const id = this.blockAt(head) ?? 'air';
      // Water overhead that opens to air within a short swim (a lake, a flooded cave): swim up.
      if (/water/.test(id) || (/water/.test(this.blockAt({ x: f.x, y: f.y + 3, z: f.z }) ?? '') && id === 'air')) {
        const wet = /water/.test(id) ? head : { x: f.x, y: f.y + 3, z: f.z };
        if (!this.waterWithAirAbove(wet) || this.dangerousLiquidNear(head)) return climbed ? 'climbed' : 'liquid';
        this.a.sayOnce('swimup', 'Water above me, swimming up.', 30000);
        for (let t = 0; t < 200 && this.a.body.headUnderwater(); t++) { this.a.body.swimUp(); this.a.body.jump(); await this.wait(gen, 1); }
        for (let t = 0; t < 20; t++) { this.a.body.swimUp(); await this.wait(gen, 1); }
        return 'climbed';
      }
      if (id !== 'air' && !/^(short_grass|tall_grass|fern|large_fern|snow_layer|vine)$/.test(id)) {
        if (/lava/.test(id) || this.dangerousLiquidNear(head)) return climbed ? 'climbed' : 'liquid';
        if (FALLING.test(id) || this.fallingAbove(head)) return climbed ? 'climbed' : 'falling';
        if (!this.isDiggable([head], { byHand })) return climbed ? 'climbed' : 'blocked';
        // Punching stone by hand yields nothing to stand on; the staircase is cheaper then.
        if (byHand && PICKAXE_BLOCKS.test(id) && this.placeableSlot() < 0) return climbed ? 'climbed' : 'noBlocks';
        if (!(await this.mine(gen, head, { collect: false }))) return climbed ? 'climbed' : 'blocked';
        await this.wait(gen, 10); // the drop falls down the shaft onto us and is picked up
      }
      const slot = this.placeableSlot();
      if (slot < 0) return climbed ? 'climbed' : 'noBlocks';
      // Jump, and at the top of the jump place a block where our feet were.
      this.a.motor.lookAt({ x: f.x + 0.5, y: f.y - 1, z: f.z + 0.5 }, 1, 10); // glance down, like a player
      this.a.body.jump();
      let placed = false;
      for (let t = 0; t < 12 && !placed; t++) {
        await this.wait(gen, 1);
        if (this.sim.location.y >= f.y + 1.05) {
          try { this.sim.lookAtBlock({ x: f.x, y: f.y - 1, z: f.z }); } catch {}
          try { this.sim.useItemInSlotOnBlock(slot, { x: f.x, y: f.y - 1, z: f.z }, Direction.Up); } catch {}
          placed = (this.blockAt(f) ?? 'air') !== 'air';
        }
      }
      this.afterUse(slot);
      await this.wait(gen, 6);
      if (placed) this.markPlaced(f);
      if (!placed || this.feet().y <= f.y) return climbed ? 'climbed' : 'blocked';
      climbed++;
      if (!this.canPillarHere(byHand) && this.isUnderground()) return 'exposed';
    }
    return 'climbed';
  }

  /**
   * Sand or gravel over our head: open the column next to us from the side and keep mining what
   * falls into it until it stops, so the loose blocks come down there instead of on us. Then step
   * into that column (now open above) and pillar up it with the sand we collected.
   */
  async drainSide(gen, byHand) {
    for (const [dx, dz] of this.upDirections()) {
      const f = this.feet();
      const lo = { x: f.x + dx, y: f.y, z: f.z + dz }, hi = { x: f.x + dx, y: f.y + 1, z: f.z + dz };
      const floor = this.blockAt({ x: lo.x, y: f.y - 1, z: lo.z }) ?? 'air';
      if (floor === 'air' || /water|lava/.test(floor)) continue;
      if ([lo, hi].some((c) => this.dangerousLiquidNear(c)) || !this.isDiggable([lo, hi], { byHand })) continue;
      // Whatever sits on top of the loose column comes down too: never drain water in on us.
      let y = hi.y + 1;
      while (FALLING.test(this.blockAt({ x: hi.x, y, z: hi.z }) ?? '') && y < hi.y + 40) y++;
      if (/water|lava/.test(this.blockAt({ x: hi.x, y, z: hi.z }) ?? '')) continue;
      this.log(`draining loose blocks from the side ${dx},${dz}`);
      let quiet = 0;
      for (let k = 0; k < 40 && quiet < 2; k++) {
        const busy = [hi, lo].filter((c) => (this.blockAt(c) ?? 'air') !== 'air');
        if (!busy.length) { quiet++; await this.wait(gen, 12); continue; }
        quiet = 0;
        for (const c of busy) {
          if (!this.isDiggable([c], { byHand }) || this.dangerousLiquidNear(c)) return false;
          if (!(await this.mine(gen, c, { collect: false }))) return false;
        }
        await this.wait(gen, 12); // whatever was above falls in
      }
      const r = await this.a.motor.followPath([{ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }, { x: lo.x + 0.5, y: f.y, z: lo.z + 0.5 }]);
      this.check(gen);
      await this.collect(gen, this.sim.location, 3, 4);
      return r.status === 'arrived';
    }
    return false;
  }

  /**
   * Mine blocks within reach that drop something we can pillar with (never the floor under us,
   * nothing next to lava or deep water, nothing with sand or gravel above it). Returns how many
   * placeable blocks we now carry.
   */
  async gatherBlocks(gen, want, byHand) {
    const have = () => this.blockCount();
    for (let tries = 0; tries < want * 2 && have() < want; tries++) {
      this.check(gen);
      const f = this.feet();
      const inv = invCounts(this.sim);
      // Cheapest block to get, not the nearest: dirt by fist (fast, no wear, worthless to keep)
      // beats stone with the pickaxe, which beats nothing (stone punched by hand drops nothing).
      let target = null, best = Infinity;
      for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 4; dy++) for (let dz = -3; dz <= 3; dz++) {
        if (dx === 0 && dz === 0) continue; // never our own column (floor below, headroom above)
        if (dy === -1 && Math.abs(dx) + Math.abs(dz) === 1) continue; // nor the floor we'd step onto
        if (Math.abs(dx) + Math.abs(dz) === 1 && dy <= 1) continue; // nor the wall we're leaning on
        const p = { x: f.x + dx, y: f.y + dy, z: f.z + dz };
        const id = this.blockAt(p) ?? 'air';
        if (id === 'air' || !NATURAL.has(id)) continue; // never someone's build
        const cost = blockSourceCost(id, inv, dist3D(f, p));
        if (cost >= best || !this.inReach(p) || this.touchesLiquid(p) || this.fallingAbove(p)) continue;
        best = cost; target = p;
      }
      if (!target) break;
      if (tries === 0) this.a.sayOnce('gatherblocks', 'Collecting some blocks to build my way up.', 60000);
      await this.mine(gen, target, { collect: false }); // drops land next to us and get picked up
      if (tries % 6 === 5) await this.collect(gen, this.sim.location, 4, 2);
    }
    await this.collect(gen, this.sim.location, 4, 4);
    return have();
  }

  /** Walk to exposed dirt/gravel/sand within 16 blocks and dig it by hand, up to `want` blocks or ~90 s. */
  async gatherLoose(gen, want) {
    const t0 = Date.now();
    const loose = (id) => /^(dirt|coarse_dirt|gravel|sand|red_sand|rooted_dirt)$/.test(id);
    const f0 = this.feet(), inv = invCounts(this.sim);
    const spots = (await this.scan(loose, { radius: 16, below: 4, above: 6, limit: 48 }))
      .filter((b) => !this.touchesLiquid(b) && !this.fallingAbove(b))
      .map((b) => ({ b, cost: blockSourceCost(b.id, inv, dist3D(f0, b)) }))
      .sort((p, q) => p.cost - q.cost).map((e) => e.b);
    this.check(gen);
    if (!spots.length) return this.blockCount();
    this.a.sayOnce('gatherloose', 'Grabbing some dirt and gravel to climb out on.', 60000);
    for (const b of spots) {
      if (this.blockCount() >= want || Date.now() - t0 > 90000) break;
      const f = this.feet();
      if (b.x === f.x && b.z === f.z) continue;
      await this.mine(gen, b, { collect: true });
    }
    return this.blockCount();
  }

  /**
   * Directions to try. Under cover: thinnest cover first (surface lowest 10 blocks out).
   * In the open (ravine, pit): into the wall, tallest side first; that's where the rim is.
   */
  upDirections() {
    const f = this.feet();
    const open = this.coverAbove() === 0;
    const back = this.a.lastSurface?.(); // where we came in from: all else equal, head that way
    return [[1, 0], [0, 1], [-1, 0], [0, -1]]
      .map((d) => ({ d, top: this.groundTop(f.x + d[0] * (open ? 1 : 10), f.z + d[1] * (open ? 1 : 10)), wet: open ? 0 : this.wetAhead(f, d) }))
      .map((e) => ({ ...e, top: Number.isFinite(e.top) ? e.top : (open ? -999 : 999) }))
      .map((e) => ({ ...e, toward: back ? -(e.d[0] * (back.x - f.x) + e.d[1] * (back.z - f.z)) : 0 }))
      .sort((a, b) => a.wet - b.wet || (open ? b.top - a.top : a.top - b.top) || a.toward - b.toward) // away from flooded rock first
      .map((e) => e.d);
  }

  /** How many of the columns 2..10 blocks out in this direction have water somewhere above our level. */
  /** @param {{x:number,y:number,z:number}} f @param {number[]} d */
  wetAhead(f, d) {
    const [dx, dz] = d;
    let wet = 0;
    for (let i = 2; i <= 10; i += 2) {
      const x = f.x + dx * i, z = f.z + dz * i;
      const top = Math.min(this.groundTop(x, z), f.y + 24);
      for (let y = f.y + 2; y <= top; y++) if (/water|lava/.test(this.blockAt({ x, y, z }) ?? '')) { wet++; break; }
    }
    return wet;
  }

  /**
   * Safe to keep pillaring from here? Beside a wall, always (a shaft, or climbing a cliff face).
   * Free-standing under a cave ceiling, only if we carry enough blocks to reach the ceiling (and,
   * punching by hand, all the way up, since stone gives nothing back). Never free-standing in the open.
   */
  canPillarHere(byHand) {
    if (this.nextToWall()) return true;
    const f = this.feet();
    let ceiling = null;
    for (let y = f.y + 2; y <= f.y + 40; y++) {
      if (!/^air$|water|grass|fern/.test(this.blockAt({ x: f.x, y, z: f.z }) ?? 'air')) { ceiling = y; break; }
    }
    // A ceiling we can't dig through (glass, a build, bedrock) would leave us stuck on top of the pillar.
    if (ceiling === null || !this.isDiggable([{ x: f.x, y: ceiling, z: f.z }], { byHand })) return false;
    const need = byHand ? this.climbNeeded() : ceiling - f.y;
    return this.blockCount() >= need;
  }

  // ---------- getting down from somewhere high ----------

  /**
   * The open sides around p (nothing at feet or head height) and how far down the ground is on
   * each: { dx, dz, drop, landing } where landing is the block we'd land on.
   */
  dropsAround(p = this.feet()) {
    const out = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = p.x + dx, z = p.z + dz;
      if (!OPEN.test(this.blockAt({ x, y: p.y, z }) ?? 'air') || !OPEN.test(this.blockAt({ x, y: p.y + 1, z }) ?? 'air')) continue;
      let y = p.y - 1;
      while (y > p.y - 96 && OPEN.test(this.blockAt({ x, y, z }) ?? 'air')) y--;
      out.push({ dx, dz, drop: p.y - (y + 1), landing: this.blockAt({ x, y, z }) ?? 'air' });
    }
    return out;
  }

  /** Up on something with a long fall beside us, and not under rock (that's a cave, not a tower). */
  /** Break down through leaves (and logs) under us until we stand on real ground. */
  async offCanopy(gen) {
    let moved = false;
    for (let i = 0; i < 16; i++) {
      this.check(gen);
      const f = this.feet();
      const below = { x: f.x, y: f.y - 1, z: f.z };
      const id = this.blockAt(below) ?? 'air';
      if (!/leaves/.test(id) && !(moved && isLog(id))) break;
      if (i === 0) this.log(`escape: on a tree canopy at ${f.x} ${f.y} ${f.z}, breaking down through it`);
      if (!(await this.mine(gen, below, { collect: isLog(id), allowBelow: true }))) break;
      moved = true;
      for (let t = 0; t < 20 && this.feet().y >= f.y; t++) await this.wait(gen, 1); // fall
    }
    if (moved) await this.collect(gen, this.sim.location, 4, 2);
    return moved;
  }

  perched() {
    // Not a ledge partway up a ravine or cave wall (the land around is higher: the way out is up).
    return !this.isUnderground() && this.rimClimb() <= 1 && this.dropsAround().some((e) => e.drop > 3);
  }

  /**
   * Get down off a pillar or spire, weighing time against health like a player would: step off
   * where the fall is gentlest if it costs little health, otherwise dig out the block under us and
   * ride the pillar down a level at a time (fast with a pickaxe, slow by hand) until the fall is
   * harmless. Never lands on lava, magma or cactus; water breaks any fall.
   */
  async getDown(gen) {
    this.a.sayOnce('getdown', 'Stuck up here, climbing down.', 30000);
    const HP_S = 6;      // one half-heart of health is worth about 6 s (healing time, plus risk)
    const MAX_FALL = 6;  // never take more than 3 hearts from one fall, never drop below 5 hearts
    for (let i = 0; i < 128; i++) {
      this.check(gen);
      if (!(await this.isTrapped(gen))) {
        // Free to walk now; step off the stump of the pillar rather than stand on it.
        const f = this.feet();
        const step = this.dropsAround(f).filter((e) => e.drop >= 1 && e.drop <= 3 && !BAD_LANDING.test(e.landing)).sort((a, b) => b.drop - a.drop)[0];
        if (step) {
          await this.a.motor.followPath([{ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }, { x: f.x + step.dx + 0.5, y: f.y - step.drop, z: f.z + step.dz + 0.5 }]);
          this.check(gen);
        }
        return true;
      }
      const f = this.feet();
      // Only the long drops matter: short ones lead back into the same little area we're stuck in.
      const edges = this.dropsAround(f).filter((e) => e.drop > 3 && !BAD_LANDING.test(e.landing));
      if (!edges.length) {
        // Stuck on a small platform: walk to its edge first (a wide tower top, next to another pillar).
        if (!(await this.walkToEdge(gen))) return false;
        continue;
      }
      const dmg = (e) => (/water/.test(e.landing) ? 0 : Math.max(0, e.drop - 3));
      const best = edges.reduce((a, b) => (dmg(b) < dmg(a) || (dmg(b) === dmg(a) && b.drop < a.drop) ? b : a));
      const hopOk = dmg(best) <= Math.min(MAX_FALL, this.a.health() - 10);
      const below = { x: f.x, y: f.y - 1, z: f.z };
      const bid = this.blockAt(below) ?? 'air';
      const next = this.blockAt({ x: f.x, y: f.y - 2, z: f.z }) ?? 'air';
      const canDig = !OPEN.test(next) && !BAD_LANDING.test(next) && this.diggableBeneath(below, bid);
      const perLevel = canDig ? (chooseTool(bid, invCounts(this.sim), { needDrop: false })?.seconds ?? Infinity) + 0.5 : Infinity;
      const digCost = dmg(best) === 0 ? 0 : dmg(best) * perLevel;
      this.log(`getting down: drop ${best.drop} onto ${best.landing}, hop ${hopOk ? dmg(best) * HP_S : 'unsafe'}s vs dig ${digCost.toFixed(1)}s`);
      if (hopOk && dmg(best) * HP_S <= digCost) {
        this.getDownStats.hops++;
        const r = await this.a.motor.followPath([
          { x: f.x + 0.5, y: f.y, z: f.z + 0.5 },
          { x: f.x + best.dx + 0.5, y: f.y - best.drop, z: f.z + best.dz + 0.5 },
        ]);
        this.check(gen);
        await this.wait(gen, 10);
        if (r.status !== 'arrived' && this.feet().y === f.y) return false;
        continue;
      }
      if (!canDig) {
        this.a.sayOnce('toohigh', "I'm stuck up high and can't get down safely.", 60000);
        return false;
      }
      if (!(await this.mine(gen, below, { collect: true, allowBelow: true }))) return false;
      this.getDownStats.digs++;
      await this.wait(gen, 4);
    }
    return false;
  }

  /** Standing on blocks we stacked up ourselves: dig them out one by one back down to the ground. */
  /** Build up beside a trunk until `log` is in reach (up to 6 blocks up). */
  async climbForLog(gen, log) {
    for (let k = 0; k < 6 && log.y - this.feet().y > 3; k++) {
      this.check(gen);
      const f = this.feet();
      const over = { x: f.x, y: f.y + 2, z: f.z };
      const id = this.blockAt(over) ?? 'air';
      if (!OPEN.test(id)) {
        if (!/leaves$|vine/.test(id) || !(await this.mine(gen, over, { collect: false }))) return false; // solid overhead: give up
      }
      if (this.placeableSlot() < 0) { this.log('logs: nothing to build up with for the top of the tree'); return false; }
      if (!(await this.stepUp(gen))) return false;
    }
    return log.y - this.feet().y <= 4;
  }

  async descendPillar(gen) {
    for (let i = 0; i < 24; i++) {
      const f = this.feet();
      const below = { x: f.x, y: f.y - 1, z: f.z };
      if (!this.placedByMe(below)) return;
      const under = this.blockAt({ x: f.x, y: f.y - 2, z: f.z }) ?? 'air';
      if (OPEN.test(under) || BAD_LANDING.test(under) || /water|lava/.test(under)) return;
      if (!(await this.mine(gen, below, { collect: true, allowBelow: true }))) return;
      this.placed.delete(`${below.x},${below.y},${below.z}`);
      this.unmarkScaffold(below);
      for (let t = 0; t < 10 && this.feet().y >= f.y; t++) await this.wait(gen, 1);
    }
  }

  /** Walk to the nearest spot on this platform with a long drop beside it. */
  async walkToEdge(gen) {
    const f = this.feet();
    const goal = (x, y, z, w) => w.standable(x, y, z) && !(x === f.x && y === f.y && z === f.z) &&
      this.dropsAround({ x, y, z }).some((e) => e.drop > 3 && !BAD_LANDING.test(e.landing));
    const res = await this.a.plan(this.sim.location, this.sim.location, 0, 600, goal);
    this.check(gen);
    if (!res.complete || res.path.length < 2) return false;
    const r = await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
    this.check(gen);
    return r.status === 'arrived';
  }

  /** The block under us may be dug out: terrain, our own block, or the top of a one-wide pillar. */
  diggableBeneath(p, id) {
    if (OPEN.test(id) || /bedrock|barrier|obsidian|water|lava|chest|shulker|_door|bed$/.test(id)) return false;
    if (NATURAL.has(id) || this.placedByMe(p) || /leaves/.test(id)) return true;
    const pillar = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => OPEN.test(this.blockAt({ x: p.x + dx, y: p.y, z: p.z + dz }) ?? 'air'));
    return pillar && /^(dirt|cobblestone|cobbled_deepslate|stone|andesite|diorite|granite|tuff|sand|gravel|netherrack|.*_planks)$/.test(id);
  }

  /** A wall at least two blocks tall directly beside us (something to cut steps into). */
  nextToWall(p = this.feet()) {
    const solid = (q) => !/water|lava|^air$/.test(this.blockAt(q) ?? 'air');
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) =>
      solid({ x: p.x + dx, y: p.y, z: p.z + dz }) || solid({ x: p.x + dx, y: p.y + 1, z: p.z + dz }));
  }

  /** Can we dig/pillar straight up from p to the surface without meeting liquid or loose blocks? */
  columnSafe(p) {
    const top = Math.min(this.groundTop(p.x, p.z), p.y + 48);
    for (let y = p.y + 2; y <= top + 1; y++) {
      const q = { x: p.x, y, z: p.z };
      const id = this.blockAt(q) ?? 'air';
      if (/lava/.test(id) || FALLING.test(id)) return false;
      if (/water/.test(id)) return this.waterWithAirAbove(q); // a swim up at the end is fine
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = this.blockAt({ x: p.x + dx, y, z: p.z + dz }) ?? '';
        if (/lava/.test(n) || (/water/.test(n) && !this.waterWithAirAbove({ x: p.x + dx, y, z: p.z + dz }))) return false;
      }
    }
    return true;
  }

  /** Nearest reachable spot (within ~12 blocks of walking) whose column is safe to go straight up. */
  async findShaftSpot(gen) {
    const f = this.feet();
    const seen = new Set();
    const goal = (x, y, z, w) => {
      if (!w.standable(x, y, z) || (x === f.x && z === f.z)) return false;
      const k = `${x},${z}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return this.columnSafe({ x, y, z }) && this.nextToWall({ x, y, z });
    };
    const res = await this.a.plan(this.sim.location, this.sim.location, 0, 1500, goal);
    this.check(gen);
    const end = res.complete ? res.path[res.path.length - 1] : null;
    this.log(`shaft spot: ${end ? `${end.x} ${end.y} ${end.z}` : 'none nearby'}`);
    return end ? { x: end.x + 0.5, y: end.y, z: end.z + 0.5 } : null;
  }

  /** Walk to some other dry spot 8-20 blocks away (a fresh place to try digging up from). */
  async relocate(gen) {
    const f = this.feet();
    const goal = (x, y, z, w) => w.standable(x, y, z) && Math.hypot(x - f.x, z - f.z) >= 4 && Math.random() < 0.08;
    const res = await this.a.plan(this.sim.location, this.sim.location, 0, 6000, goal);
    this.check(gen);
    this.log(`relocate: ${res.complete ? `${res.path.length} steps` : 'nowhere to go'}`);
    if (!res.complete || res.path.length < 2) return false;
    const r = await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
    this.check(gen);
    return r.status === 'arrived';
  }

  /** Walk to the nearest spot beside a tall wall. */
  async walkToWall(gen) {
    const cache = new Map();
    const goal = (x, y, z, w) => w.standable(x, y, z) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) =>
      w.get(x + dx, y, z + dz) === Cell.SOLID && w.get(x + dx, y + 1, z + dz) === Cell.SOLID && this.groundTop(x + dx, z + dz, cache) >= y + 1);
    const res = await this.a.plan(this.sim.location, this.sim.location, 0, 8000, goal);
    this.check(gen);
    this.log(`wall: ${res.complete ? `${res.path.length} steps away` : 'none reachable'}`);
    if (!res.complete) return false;
    if (res.path.length >= 2) await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
    this.check(gen);
    return true;
  }

  /**
   * One staircase step up: clear the headroom above us plus two blocks in front, then jump up onto
   * the block in front. Breaking into water that's a short swim from air is allowed (we swim up).
   */
  async stairStep(gen, byHand, dirs = null) {
    for (const [dx, dz] of dirs ?? this.upDirections()) {
      this.check(gen);
      const f = this.feet();
      const fx = f.x + dx, fz = f.z + dz;
      const head = { x: f.x, y: f.y + 2, z: f.z };
      const front = [{ x: fx, y: f.y + 1, z: fz }, { x: fx, y: f.y + 2, z: fz }];
      const cells = [head, ...front];
      const floorId = this.blockAt({ x: fx, y: f.y, z: fz });
      if (cells.some((c) => /water/.test(this.blockAt(c) ?? '')) && cells.every((c) => !this.dangerousLiquidNear(c))) {
        for (const c of cells) if (!/water|air/.test(this.blockAt(c) ?? 'air') && !(await this.mine(gen, c, { collect: false }))) return false;
        this.a.say('Breaking into water above, swimming up.');
        for (let i = 0; i < 200 && this.isUnderground(); i++) { this.a.body.swimUp(); await this.wait(gen, 1); }
        return true;
      }
      const reason = !floorId || floorId === 'air' ? 'no floor ahead' : /water|lava/.test(floorId) ? 'liquid floor'
        : cells.some((c) => this.dangerousLiquidNear(c)) ? 'lava or deep water'
        : this.fallingAbove(head) || FALLING.test(this.blockAt(head) ?? '') ? 'loose blocks overhead'
        : !this.isDiggable(cells, { byHand }) ? 'undiggable block' : null;
      if (reason) { this.log(`stair ${dx},${dz} from ${f.x} ${f.y} ${f.z}: ${reason}`); continue; }
      for (const c of cells) {
        // Loose blocks can keep falling into the front column: mine until it stays clear.
        for (let k = 0; k < 10 && (this.blockAt(c) ?? 'air') !== 'air'; k++) {
          if (!this.isDiggable([c], { byHand }) || !(await this.mine(gen, c, { collect: false }))) return false;
          if (FALLING.test(this.blockAt({ x: c.x, y: c.y + 1, z: c.z }) ?? '')) await this.wait(gen, 12);
        }
      }
      const r = await this.a.motor.followPath([{ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }, { x: fx + 0.5, y: f.y + 1, z: fz + 0.5 }]);
      this.check(gen);
      await this.collect(gen, this.sim.location, 3, 2);
      if (r.status === 'arrived' || this.feet().y > f.y) return true;
    }
    return false;
  }

  /** Dig a 2-high tunnel 5 blocks in the first safe direction (a new column to go up from). */
  async tunnelSideways(gen, byHand) {
    for (const [dx, dz] of this.upDirections()) {
      const f = this.feet();
      const cells = [];
      let len = 0;
      for (let i = 1; i <= 5; i++) {
        const lo = { x: f.x + dx * i, y: f.y, z: f.z + dz * i }, hi = { ...lo, y: f.y + 1 };
        const floor = this.blockAt({ ...lo, y: f.y - 1 }) ?? 'air';
        const ok = floor !== 'air' && !/water|lava/.test(floor) && ![lo, hi].some((c) => this.dangerousLiquidNear(c)) &&
          this.isDiggable([lo, hi], { byHand }) && !this.fallingAbove(hi);
        if (!ok) break;
        cells.push(lo, hi);
        len = i;
      }
      if (len < 2) continue;
      this.log(`tunnelling sideways ${dx},${dz}`);
      for (const c of cells) if (!(await this.mine(gen, c, { collect: false }))) return false;
      const r = await this.a.motor.followPath([{ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }, { x: f.x + dx * len + 0.5, y: f.y, z: f.z + dz * len + 0.5 }]);
      this.check(gen);
      await this.collect(gen, this.sim.location, 4, 2);
      return r.status === 'arrived';
    }
    return false;
  }

  /** Only the walking part of toSurface (after swimming up, for example). */
  async toSurfaceWalkOnly(gen) {
    if (!this.isUnderground()) return true;
    return this.walkOut(gen);
  }

  // ---------- exploring ----------

  /**
   * Go looking for `what`. Watched for getting nowhere (core/explore.js): three goes that end where
   * they began and it treks 48 blocks a new way; six and it stops looking for that for 10 minutes
   * (exploreGaveUp), rather than stand in one spot saying it's looking further out, for ever.
   */
  async explore(gen, what, want = wantOf(what)) {
    const st = this.exploreStall ?? (this.exploreStall = new ExploreStall());
    st.start(this.sim.location, want ?? what);
    try {
      const v = st.verdict();
      if (v === 'giveup') {
        this.exploreGaveUp[want ?? what] = Date.now() + 600000;
        this.a.say(`I'm not getting anywhere looking for ${what}: leaving that for now.`);
        this.log(`explore: ${what}: six goes that got nowhere, giving up on it for 10 minutes`);
        st.n = 0;
        return;
      }
      if (v === 'trek') {
        // Up top first: a long leg from down the mine's stairs walked deeper into it.
        if (await this.needsEscape(gen)) { await this.toSurface(gen); return; }
        const p = this.sim.location;
        const ang = st.trekAngle(Math.random, wetCones(this.a.wetSpots, p, system.currentTick));
        this.log(`explore: ${what}: getting nowhere here, a long leg ${Math.round(ang * 180 / Math.PI)} deg`);
        this.a.sayOnce(`explore-trek:${what}`, `Nothing new round here: trying further off for ${what}.`, 60000);
        this.spotted = null;
        this.spotWant = want;
        try { await this.travelToward(gen, { x: p.x + Math.cos(ang) * 48, y: p.y, z: p.z + Math.sin(ang) * 48 }, 3); } finally { this.spotWant = null; }
        this.spotted = null;
        return;
      }
      await this.exploreOnce(gen, what, want);
    } finally {
      st.end(this.sim.location);
    }
  }

  /** Given up looking for this (explore got nowhere): until when, or 0. */
  gaveUpLooking(want) { return (this.exploreGaveUp[want] ?? 0) > Date.now(); }

  async exploreOnce(gen, what, want = wantOf(what)) {
    if (await this.needsEscape(gen)) { await this.toSurface(gen); return; }
    const label = this.a.task?.kind === 'auto' && this.a.autoLabel?.startsWith('looking') ? this.a.autoLabel : `looking for ${what}`;
    this.a.sayOnce(`explore:${what}`, `${label[0].toUpperCase()}${label.slice(1)}.`, 30000);
    const p = this.sim.location;
    const look = this.a.lookout;
    // Head for ground we haven't covered, somewhere we can actually walk to: search the walkable
    // area around us (never tunnelling) for the best spot 20+ blocks away, scored by how new the
    // ground is, how good its biome is for what we're after, keeping roughly the direction we were
    // going, and staying out of water.
    // Water we had to swim out of: close by and lately only (kept for ever, from anywhere, a few
    // swims ruled out every way and it stood still).
    const cones = wetCones(this.a.wetSpots, p, system.currentTick);
    const towardWater = (ang) => towardWet(ang, cones);
    // Explored for this twice lately and found nothing (open plains, no trees for miles): ask the
    // world seed where the nearest good biome is and head that way, instead of wandering.
    // A village we know of has beds (the wool's work done), farms and animals: it beats wandering
    // for sheep or food (and for iron when it has workstations: a blacksmith's chest).
    if (want === 'sheep' || want === 'food') {
      const vil = this.a.villages?.pick(want);
      if (vil && !this.a.villages.busy) {
        const res = await this.a.villages.visit(gen, vil, want);
        this.log(`explore: village visit for ${what}: ${res}`);
        if (res === 'looked round' || /took/.test(res)) { this.exploreMiss[want] = { n: 0, at: 0, since: 0 }; return; }
      }
    }
    const now = system.currentTick;
    const miss = this.exploreMiss[want ?? '-'] ?? { n: 0, at: 0, since: now };
    if (now - miss.at < 1800) miss.n++; else { miss.n = 1; miss.since = now; }
    miss.at = now;
    this.exploreMiss[want ?? '-'] = miss;
    let heading = null;
    // Not while we're already somewhere good for it (sheep in a forest are just spread out): look
    // around here a few more times first, rather than trek 200 blocks to the "best" biome.
    // Measured in time spent searching here (2.5 min), not explore calls, which can come fast.
    const hereGood = want && look ? wantScore(look.here() ?? '', want) >= 2 : false;
    if (hereGood && (want === 'sheep' || want === 'food')) { try { this.a.homestead?.rememberAnimals(64); } catch {} }
    const searchedHere = now - (miss.since ?? now) >= 3000 && miss.n >= 4;
    if (want && look && (hereGood ? searchedHere : miss.n >= 2)) {
      const b = look.seedSearch(want);
      if (b) {
        heading = Math.atan2(b.pos.z - p.z, b.pos.x - p.x);
        this.a.sayOnce(`explore-seed:${want}`, `Nothing around here; the nearest ${biomeName(b.id)} is about ${Math.round(b.dist)} blocks away, heading there.`, 120000);
        this.log(`explore: heading for ${b.id} at ${Math.round(b.pos.x)} ${Math.round(b.pos.z)} (${Math.round(b.dist)} away)`);
        // A long way: travel straight at it in long legs (partial paths, swimming allowed), eyes
        // open for what we want on the way, rather than 30-block hops that wander back and forth.
        if (b.dist > 40) {
          await this.packUp(gen);
          this.spotted = null;
          this.spotWant = want;
          const from0 = { ...this.sim.location };
          try { await this.travelToward(gen, { x: b.pos.x, y: b.pos.y, z: b.pos.z }, 4); } finally { this.spotWant = null; }
          if (this.spotted) { this.exploreMiss[want] = { n: 0, at: 0, since: 0 }; this.spotted = null; }
          // Got somewhere: done for this go. Didn't (no way that way): look round here instead.
          if (Math.hypot(this.sim.location.x - from0.x, this.sim.location.z - from0.z) >= 8) return;
          heading = null;
        }
      }
    }
    const cache = new Map();
    const biomeScore = new Map(); // chunk -> 0..1.5
    const ours = new Set();       // chunks our walkable land reaches
    let land = 0;
    /** @type {{x:number,y:number,z:number,ang:number}|null} */
    let best = null, bestWet = null;
    let bestScore = -Infinity, bestWetScore = -Infinity;
    const probe = (x, y, z, w) => {
      if (!w.standable(x, y, z)) return false;
      land++;
      const ck = chunkKey(x, z);
      ours.add(ck);
      const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
      if (d < 20) return false;
      if (this.isUndergroundCached(x, y, z, cache)) return false;
      const ang = Math.atan2(dz, dx);
      const wet = towardWater(ang);
      let bs = biomeScore.get(ck);
      if (bs === undefined) {
        const b = want && look ? look.biomeAt(x, z, y) : null;
        bs = b ? (wantScore(b, want) / 3) * 1.5 : 0;
        biomeScore.set(ck, bs);
      }
      const fresh = this.visited.has(ck) ? 0 : 2;
      const keepGoing = heading !== null ? 3 * Math.cos(ang - heading) : this.exploreAngle === undefined ? 0 : Math.cos(ang - this.exploreAngle);
      const home = this.a.homestead?.house ?? this.a.homestead?.project;
      const leash = home ? Math.max(0, Math.hypot(x - home.x, z - home.z) - 80) / 10 : 0; // stay within ~80 of home
      const sc = fresh + bs + keepGoing + Math.min(d, 40) / 40 + Math.random() * 0.3 - leash;
      // Toward water: only if there's nowhere else (never "nowhere to go" because of it).
      if (wet) { if (sc > bestWetScore) { bestWetScore = sc; bestWet = { x, y, z, ang }; } return false; }
      if (sc > bestScore) { bestScore = sc; best = { x, y, z, ang }; }
      return false;
    };
    await this.a.plan(this.sim.location, this.sim.location, 0, 6000, probe);
    this.check(gen);
    best = /** @type {{x:number,y:number,z:number,ang:number}|null} */ (best ?? bestWet);

    // A small island (little land, water all round): what we're after isn't here, so cross.
    // Trees: none seen on our patch and none remembered on it.
    if (look && look.island(land)) {
      const onOurs = (cat) => this.a.memory.list(cat, this.dim.id, p).some((m) => ours.has(chunkKey(m.pos.x, m.pos.z)));
      const cat = { log: 'log', sheep: 'sheep', stone: 'stone' }[want];
      if (!cat || !onOurs(cat)) {
        for (const k of ours) this.visited.add(k); // been all over it: don't come back to look again
        if (await this.leaveIsland(gen, ours, want)) return;
      }
    }

    let target = null;
    if (best) { this.exploreAngle = best.ang; target = { x: best.x + 0.5, y: best.y, z: best.z + 0.5 }; }
    if (!target) {
      // Nowhere new on foot. Hemmed in by water: swim for land.
      if (look && look.waterAround().frac >= 0.5 && (await this.leaveIsland(gen, ours, want))) return;
      this.exploreAngle = undefined;
      await this.wait(gen, 40);
      return;
    }
    await this.packUp(gen);
    const from = this.sim.location;
    // Eyes open on the way: stop the moment what we're after comes into view (agent tick calls
    // spotCheck), instead of walking the whole trip past trees and only looking at the end.
    this.spotted = null;
    this.spotWant = want;
    try { await this.goNear(gen, target, 3, 2); } finally { this.spotWant = null; }
    if (this.spotted) {
      this.exploreMiss[want ?? '-'] = { n: 0, at: 0 };
      this.log(`explore: spotted ${want} at ${this.spotted.x} ${this.spotted.y} ${this.spotted.z} on the way (${Math.round(dist3D(from, this.sim.location))} blocks in)`);
      // What was set aside because it kept failing (no trees near enough) is worth another go now that one's in sight:
      // left aside, a run spent its 3 minutes wandering past the logs it had just found.
      const asideFor = { log: 'gather_logs', sheep: 'hunt', food: 'hunt' }[want ?? ''];
      if (asideFor) for (const [k, d] of this.a.deferred) if (d.step === asideFor) this.a.deferred.delete(k);
      this.spotted = null;
      return;
    }
    if (dist3D(from, this.sim.location) < 4) {
      this.exploreAngle = undefined; // that way is blocked or not loaded yet: try another next time
      this.visited.add(chunkKey(target.x, target.z));
      await this.wait(gen, 40);
    }
  }

  /**
   * While exploring: glance ahead for what we're after. Logs: a fan of 18 rays across +-80 deg at
   * eye level and a little below, out to 24 blocks (trunks show at eye height under the canopy).
   * Animals: the ones in sight within 24. Cheap enough for twice a second. Returns a position.
   */
  spotCheck(want) {
    if (want === 'log') {
      const eye = this.eye();
      const yaw0 = this.a.motor.yaw;
      for (const pitch of [0, 10]) {
        for (let k = -4; k <= 4; k++) {
          const yaw = (yaw0 + k * 20) * Math.PI / 180, pr = pitch * Math.PI / 180;
          const dir = { x: -Math.sin(yaw) * Math.cos(pr), y: -Math.sin(pr), z: Math.cos(yaw) * Math.cos(pr) };
          let hit;
          try { hit = castRay(this.dim, eye, dir, 24); } catch { continue; }
          if (hit && isLog(strip(hit.block.typeId))) {
            const l = hit.block.location;
            if (!this.a.memory.isUnreachable(l)) return { x: l.x, y: l.y, z: l.z };
          }
        }
      }
      return null;
    }
    if (want === 'sheep' || want === 'food') {
      const H = this.a.homestead;
      const a = H?.animals(want === 'sheep' ? new Set(['sheep']) : FOOD_SET, 24)[0];
      return a ? a.e.location : null;
    }
    return null;
  }

  /**
   * Setting off to explore: take the crafting table and furnace we put down around here with us
   * (axe for the table, pickaxe for the furnace: by hand a furnace drops nothing), so we can set
   * up again wherever we end up. Never the ones in the house or at the house site, and never a
   * furnace that's still cooking.
   */
  async packUp(gen) {
    const H = this.a.homestead, mem = this.a.memory, dimId = this.dim.id, here = this.sim.location;
    const homes = [H?.house, H?.project].filter(Boolean);
    const atHome = (p) => homes.some((h) => houseInside(h, p) || Math.hypot(p.x - h.x, p.z - h.z) <= 6);
    const t = mem.nearestTable(dimId, here);
    // Not one we just put down (we're about to use it: that was the place, pack, place loop).
    const fresh = this.tablePlaced && this.tablePlaced.x === t?.pos.x && this.tablePlaced.y === t?.pos.y && this.tablePlaced.z === t?.pos.z && system.currentTick - this.tablePlaced.tick < 3600;
    if (t && t.dist <= 24 && !fresh && !atHome(t.pos) && !this.isCampBlock(t.pos) && this.blockAt(t.pos) === 'crafting_table') {
      this.a.sayOnce('pack-table', 'Taking my crafting table with me.', 60000);
      if (await this.mine(gen, t.pos)) mem.forgetTable(dimId, t.pos);
      this.check(gen);
    }
    const f = mem.list('furnace', dimId, here).filter((e) => !this.isCampBlock(e.pos))[0];
    const pickaxe = Object.keys(invCounts(this.sim)).some((id) => /_pickaxe$/.test(id));
    // Something cooking in it: nearly done, wait and take it with us; otherwise leave it cooking
    // and come back (never walk off and "collect" from across the map).
    const left = H?.smeltJob ? Math.max(0, (H.smeltJob.readyAt - system.currentTick) / 20) : 0;
    if (f && f.dist <= 24 && pickaxe && !atHome(f.pos) && H?.smeltJob && left <= 30) {
      this.a.sayOnce('pack-wait', `Waiting ${Math.ceil(left)} s for the furnace to finish before I take it.`, 60000);
      await H.waitSmelt(gen);
      this.check(gen);
    } else if (f && H?.smeltJob && left > 30) {
      this.a.sayOnce('pack-leave', `Leaving the furnace cooking (${Math.ceil(left)} s to go); I'll come back for it.`, 120000);
    }
    if (f && f.dist <= 24 && pickaxe && !atHome(f.pos) && (!H?.smeltJob || system.currentTick >= H.smeltJob.readyAt)) {
      this.a.sayOnce('pack-furnace', 'Taking my furnace with me.', 60000);
      await H.fetchFurnace(gen);
      this.check(gen);
    }
    this.restHands();
  }

  /** Long-distance travel: up to `legs` path segments toward a far target (partial paths ok). */
  async travelToward(gen, target, legs = 4) {
    for (let leg = 0; leg < legs; leg++) {
      this.check(gen);
      const from = this.sim.location;
      if (dist3D(from, target) < 12) return true;
      const res = await this.a.plan(from, target, 8, 8000, null, { wetPartial: true });
      this.check(gen);
      // A partial leg ends where the search got closest, which can be inside a cave: end it at the
      // last point out in the open instead (or we'd escape back out and walk straight in again).
      let path = res.path;
      if (!res.complete) {
        const cache = new Map();
        let last = 0;
        const open = (q) => {
          if (!this.isUndergroundCached(q.x, q.y, q.z, cache)) return true;
          try { return this.dim.getSkyLightLevel({ x: q.x, y: q.y + 1, z: q.z }) >= 12; } catch { return false; }
        };
        for (let i = 0; i < path.length; i++) if (open(path[i])) last = i;
        path = path.slice(0, last + 1);
      }
      if (path.length < 2) return false;
      await this.a.motor.followPath(smoothPath(this.a.classifier(), path));
      this.check(gen);
      if (this.spotted) return true;
      if (dist3D(from, this.sim.location) < 4) return false; // not getting anywhere this way
    }
    return true;
  }

  /**
   * Off an island (or a stretch of coast with nothing on it): pick land to swim to (land we can
   * see across the water, best for what we want; else the nearest good biome from the world
   * seed; else straight out the way we're facing) and swim there in legs.
   */
  async leaveIsland(gen, ours, want) {
    const look = this.a.lookout;
    const p = this.sim.location;
    let target = null, why = '';
    const seen = look.landAcross(ours, want);
    if (seen) { target = seen; why = 'land I can see'; }
    if (!target) {
      const s = look.seedSearch(want ?? 'land') ?? (want ? look.seedSearch('land') : null);
      if (s) { target = { x: s.pos.x, y: s.pos.y, z: s.pos.z }; why = `the nearest ${biomeName(s.id)}`; }
    }
    if (!target) {
      const ang = this.exploreAngle ?? Math.random() * Math.PI * 2;
      target = { x: p.x + Math.cos(ang) * 96, y: 63, z: p.z + Math.sin(ang) * 96 };
      why = 'open water, the way I was heading';
    }
    const dx = target.x - p.x, dz = target.z - p.z;
    const dir = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'][Math.round(((Math.atan2(dz, dx) / (Math.PI / 4)) + 8)) % 8];
    this.a.sayOnce('island', `I'm on a little island with nothing I need on it. Swimming for ${why}, ${Math.round(Math.hypot(dx, dz))} blocks ${dir}.`, 120000);
    this.exploreAngle = Math.atan2(dz, dx);
    await this.packUp(gen);
    return this.crossWater(gen, target, ours);
  }

  /** Swim (and walk) toward a far target in legs; done once we're ashore on other land. */
  async crossWater(gen, target, ours) {
    const start = this.sim.location;
    let stalls = 0;
    for (let leg = 0; leg < 16; leg++) {
      this.check(gen);
      const from = this.sim.location;
      const res = await this.a.plan(from, target, 4, 8000, null, { wetPartial: true });
      this.check(gen);
      if (res.path.length >= 2) await this.a.motor.followPath(smoothPath(this.a.classifier(), res.path));
      this.check(gen);
      const here = this.sim.location;
      const ashore = !this.sim.isInWater && !ours.has(chunkKey(here.x, here.z));
      if (ashore && dist3D(start, here) > 12) return true;
      if (res.complete && dist3D(here, target) < 6) return true;
      if (dist3D(from, here) < 3) { if (++stalls >= 2) break; } else stalls = 0;
    }
    return dist3D(start, this.sim.location) > 12;
  }
}

/** What an explore trip is for, from how it's described. */
function wantOf(what) {
  if (/tree|wood|log/.test(what)) return 'log';
  if (/sheep|wool/.test(what)) return 'sheep';
  if (/food|animal/.test(what)) return 'food';
  if (/stone/.test(what)) return 'stone';
  return null;
}

const chunkKey = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;

export function markVisited(skills, p) {
  const k = chunkKey(p.x, p.z);
  if (skills.visited.has(k)) return;
  skills.visited.add(k);
  const mem = skills.a.memory;
  mem.data.visited = [...(mem.data.visited ?? []), k].slice(-1500); // bounded: the whole memory is one world property
  mem.save();
}

/**
 * Has a face a player could see and get at: next to air or water, or to something you look
 * through and swipe away in a moment (vines, leaves, grass, flowers). A trunk wrapped in vines
 * is still a trunk.
 */
function exposed(dim, p) {
  for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    try {
      const b = dim.getBlock({ x: p.x + x, y: p.y + y, z: p.z + z });
      if (b && (b.isAir || b.isLiquid || SEE_THROUGH.test(b.typeId) || OPEN.test(strip(b.typeId)))) return true;
    } catch {}
  }
  return false;
}
const SEE_THROUGH = /leaves$|vine|glow_lichen|hanging_roots|cave_vines/;

/** Break time in ticks (see core/costs.js). */
export function breakTicks(id, tool) {
  return Math.ceil(breakSeconds(id, tool) * 20);
}
