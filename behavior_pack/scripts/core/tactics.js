// Fighting and running, move by move. Pure (unit-tested, and run against simulated mobs by
// tools/sim_combat.mjs), so what's tested is what the game does.
//
//   fightMove   where to go and whether to swing or raise the shield, against one target
//   Stalemate   notices a fight that's going nowhere (a skeleton at the top of the quarry we can't
//               get a path to, an arrow line that never reaches us): give it up, don't stare at it
//   pickRefuge  where to run: far from the threats, and out of a shooter's sight if one's hitting us
//   bestWeapon  what to hold: most damage per hit (Bedrock has no attack cooldown), worn-out last
import { HOLD_AT, REACH_HIT, BACK_OFF, STOP_AT, standOff, MOBS, weaponDamage, SLOT_SAFE } from './threat.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * One step of a fight. me/mob: {x, y, z} feet; t: ticks; melee: the mob fights up close.
 * shield: we have one on; canSwing: our swing is ready.
 * Returns {
 *   goal: {x,y,z} | null, tolerance, urgent   walk toward goal (plan a path to within tolerance)
 *   stop: bool                               stand still (in range)
 *   swing: bool                              hit it now (in reach)
 *   block: bool                              shield up (crouch) this tick
 * }
 * Approach: plan to the mob itself, to within striking distance, over the real terrain. (The old
 * way aimed at a point on the straight line to it, which, with the mob up at the mouth of the
 * quarry, was inside the rock: no path, no move, a staring contest.)
 */
export function fightMove({ me, mob, melee, t, shield = false, canSwing = true, kind = melee ? 'melee' : 'ranged', type = null }) {
  const d = dist(me, mob);
  const out = { goal: null, tolerance: 0, urgent: false, now: false, stop: false, swing: false, block: false };
  const inReach = d <= REACH_HIT;
  out.swing = inReach && canSwing;
  if (d > STOP_AT) {
    out.goal = { x: mob.x, y: mob.y, z: mob.z };
    out.tolerance = HOLD_AT - 0.2;
    out.urgent = d > 7;
    // A skeleton: don't run straight down the arrow line; weave a little while it's far off.
    if (kind === 'ranged' && d > 6) {
      const side = Math.sin(t / 10) * 2.5, nx = -(mob.z - me.z) / d, nz = (mob.x - me.x) / d;
      out.goal = { x: mob.x + nx * side, y: mob.y, z: mob.z + nz * side };
      out.tolerance = HOLD_AT + 0.5;
    }
  } else if (melee && d < BACK_OFF) {
    out.goal = standOff(me, mob, HOLD_AT + 0.3);
    out.tolerance = 0.6;
  } else out.stop = true;
  // Shield up between our own swings when something's about to hit us: a melee mob closing in, or
  // an archer at range while we can't hit back (arrows come in a line: facing it stops them). Down
  // for the swing itself (a raised shield in Bedrock lowers when you attack).
  if (shield && !out.swing) {
    if (melee && d < REACH_HIT + 0.5) out.block = true;
    // Walking in on an archer behind the shield: slow (a crouch), but its arrows stop at the shield
    // instead of costing half our hearts on the way.
    if (kind === 'ranged' && d > REACH_HIT) { out.block = true; out.urgent = false; }
  }
  void type;
  return out;
}

// Bedrock's creeper: the fuse starts once we're inside ~2.9 blocks (measured in the game: it stops to
// swell at 2.88) and in its sight, and stops again beyond 6 or when it loses sight of us. A sword
// reaches ~3.2 (feet to feet): a window of a third of a block. A spear reaches 4.
export const CREEPER_LIGHT = 2.9; // measured (`!bot test creeper`): it stops to swell at 2.88
export const CREEPER_CALM = 6;
export const CREEPER_HOLD = 3.1; // where to stand with a sword: just outside its fuse range, inside our reach

/**
 * Killing a creeper without it ever going off: keep it at arm's length. Stand just outside its fuse
 * range and hit it as it walks into our reach, before it's inside 2.9; the knockback sends it back
 * and it has to walk in again. It never lights. No running room needed (a dead-end tunnel is fine:
 * it comes at us one way), any weapon (the knockback does it; the damage only ends it sooner).
 *  - It's coming at us: wait for it, facing it. Walking in on a creeper that's walking in on us
 *    (down the quarry steps) closed the gap twice as fast, and the stop carried us inside its fuse range.
 *  - Not coming (stuck, wandering): walk up to it, stopping well short (momentum).
 *  - Swing not ready and it's close (knockback up a step is weak: it's back in a few ticks): back
 *    off, to keep it outside its fuse range until the swing is ready.
 *  - Hissing anyway: knock it back and get beyond 6 (the fuse stops), or with nowhere to go, shield up.
 * Backing off is `away`: the distance from the creeper to get to; the caller finds the nearest spot
 * it can stand on that far away (a point on the straight line back is inside the rock on stairs).
 * st keeps state between calls; lit: it's hissing (seen standing still to swell, game/agent.js hissing()). Call it every tick.
 */
export function creeperFight({ me, mob, t, st, shield = false, canSwing = true, canRetreat = true, lit = false, reach = REACH_HIT, minReach = 0, canWall = false, kbPoor = false }) {
  const d = dist(me, mob);
  const out = { goal: null, away: 0, tolerance: 0, urgent: false, walk: true, now: false, stop: false, swing: false, block: false, wall: false };
  const inReach = d <= reach && d >= minReach;
  // Where to stand: just inside our reach. A sword's (3.2) barely clears its fuse (2.9); a spear's (4)
  // clears it by a block. (Knockback is 1.21 blocks, measured: it's back in 9 ticks, before a spear's
  // 15-tick cooldown is up, so the sword covers in between.)
  const hold = reach > REACH_HIT ? reach - 0.2 : CREEPER_HOLD;
  // Is it coming at us? Distance now against ~half a second ago. And when it last was: a hit knocks
  // it back (it's "going away" for a moment, and walking in on it then meets it on its way back).
  st.hist = (st.hist ?? []).filter((h) => t - h.t <= 12);
  st.hist.push({ t, d });
  if ((st.hist.length > 1 && st.hist[0].d - d > 0.25) || st.lastComing === undefined) st.lastComing = t;
  const closing = t - st.lastComing < 40;
  // Cornered, no shield, and a hit won't send it anywhere (steps or rock right behind it, or it
  // barely moved when we hit it): wall it off. Blocks across its way in (feet, head, and higher if
  // it's coming down at us) take away its path and its sight of us, and a creeper's fuse needs
  // sight. Early (a wall is a few blocks, 3 ticks each), and once.
  if (canWall && !shield && (kbPoor || !canRetreat) && !st.walled && d <= 7 && d > 1.5 && (closing || lit)) {
    st.walled = t;
    out.wall = true; out.stop = true;
    return out;
  }
  const backOff = (to, urgent = false) => {
    out.away = to; out.urgent = urgent; out.walk = !urgent;
    out.now = !st.backing; st.backing = true;
  };
  if (lit) {
    // 1.5 s from the hiss. A hit throws it back (and buys the time to get clear); then away past 6.
    if (inReach && canSwing) out.swing = true;
    if (canRetreat) backOff(CREEPER_CALM + 1.5, true);
    else { out.stop = true; if (shield && !out.swing) out.block = true; } // take it on the shield
    return out;
  }
  if (inReach && canSwing) { out.swing = true; out.stop = true; st.backing = false; st.lastComing = t; return out; }
  // Too close for where our swing is at: keep it out of its fuse range until we can hit it.
  // (Swing ready but it's inside a spear's 2-block minimum: back off to where the jab lands.)
  if (canSwing ? d < minReach : d < hold + 0.4) { backOff(hold + 0.7); return out; }
  st.backing = false;
  // Coming at us, or near enough: stand and let it walk into the swing.
  if (closing || d <= reach + 0.9) { out.stop = true; return out; }
  // Not come any closer for 2 s (stuck, wandering): walk up to it (no sprint), stopping well short.
  out.goal = { x: mob.x, y: mob.y, z: mob.z }; out.tolerance = reach + 0.9;
  return out;
}

/**
 * Where to back off to: the nearest spot we can walk to that's at least `away` from the mob (feet to
 * feet, what its fuse goes by). A breadth-first search from our feet over the real terrain, capped
 * small (it runs on the spot, not as a background job: a creeper doesn't wait). Returns the path
 * (block cells) or null. findPath: the pathfinder's, passed in (tactics stays free of it).
 */
export function awayPath(findPath, classify, me, mob, away, maxNodes = 300) {
  const r = findPath(classify, me, me, {
    maxNodes,
    goalTest: (x, y, z, w) => w.standable(x, y, z) && Math.hypot(x + 0.5 - mob.x, y - mob.y, z + 0.5 - mob.z) >= away,
  });
  return r.complete && r.path.length >= 2 ? r.path : null;
}

/**
 * Room behind a mob to be knocked into, in blocks (0-2): along the line from us through it, the
 * columns past it that it could be pushed into (open at its feet and head, or up a 1-high step with
 * room over it). at(x, y, z) -> 'open' | 'solid' | 'other'. Under 1: a hit won't move it much.
 */
export function knockbackRoom(me, mob, at) {
  const dx = mob.x - me.x, dz = mob.z - me.z, l = Math.hypot(dx, dz) || 1;
  const fy = Math.floor(mob.y);
  let room = 0;
  for (const k of [1, 2]) {
    const x = Math.floor(mob.x + (dx / l) * k), z = Math.floor(mob.z + (dz / l) * k);
    const level = at(x, fy, z) === 'open' && at(x, fy + 1, z) === 'open';
    const stepUp = !level && at(x, fy + 1, z) === 'open' && at(x, fy + 2, z) === 'open';
    if (level) room += 1; else if (stepUp) { room += 0.5; break; } else break;
  }
  return room;
}

/**
 * Where to put blocks to wall off a creeper coming at us: the columns next to us toward it (straight
 * at it first, then the two either side of that), at our feet and head, and one higher when it's
 * coming down at us from above (else it sees over). Only open cells, never the one it's in. In the
 * order to place them: the straight line first (that's its sight of us gone soonest).
 * at(x, y, z) -> 'open' | 'solid' | 'other'. Returns [{ x, y, z }].
 */
export function blockOffCells(me, mob, at) {
  const f = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
  const dx = mob.x - me.x, dz = mob.z - me.z, l = Math.hypot(dx, dz) || 1;
  const cols = [];
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const dot = (ox * dx + oz * dz) / (l * Math.hypot(ox, oz));
    if (dot > 0.35) cols.push({ ox, oz, dot });
  }
  cols.sort((a, b) => b.dot - a.dot);
  const above = mob.y - me.y >= 0.9;
  const inMob = (c) => c.x === Math.floor(mob.x) && c.z === Math.floor(mob.z) && c.y >= Math.floor(mob.y) && c.y <= Math.floor(mob.y) + 1;
  const out = [];
  for (const { ox, oz } of cols) {
    for (const dy of above ? [0, 1, 2] : [0, 1]) {
      const c = { x: f.x + ox, y: f.y + dy, z: f.z + oz };
      if (at(c.x, c.y, c.z) === 'open' && !inMob(c)) out.push(c);
    }
  }
  return out;
}

/**
 * Running from something that's catching up (a spider, a zombie while the ground slows us): turn
 * and jab it with the spear from out of its reach (2.4-4 blocks; the knockback sends it back 1.21),
 * then run on. Only a melee mob, only one that's gaining on us, only in the spear's range, only
 * with the jab ready: facing back costs us the sprint for a moment, so it has to pay. Something
 * right on us (2.6 or less, still gaining) gets the sword instead: it's hitting us anyway.
 * st: per-mob state (its distance over the last half second). Returns 'spear' | 'sword' | null.
 */
export function fleeJab({ me, mob, t, st, melee = true, spearReady = false, swordReady = false, hasSpear = false }) {
  const d = dist(me, mob);
  st.hist = (st.hist ?? []).filter((h) => t - h.t <= 10);
  st.hist.push({ t, d });
  const gaining = st.hist.length > 1 && st.hist[0].d - d > 0.15;
  if (!melee || !gaining) return null;
  if (hasSpear && spearReady && d >= 2.4 && d <= 3.9) return 'spear';
  if (swordReady && d <= 2.6) return 'sword';
  return null;
}

/** Fight a creeper at all? Armed (a stone sword or better), healthy, and nothing else on us. */
export function creeperWorthFighting({ damage, health, others }) {
  void damage; void health;
  return !others; // the knockback keeps it off, whatever we hit it with
}

/**
 * A creeper about to go off next to us: stand and face it with the shield up (it takes the whole
 * blast from the front) rather than run a race we'll lose. Without a shield: run.
 * Returns 'block' | 'run'.
 */
export function creeperMove({ me, creeper, shield, lit = true }) {
  const d = dist(me, creeper);
  return shield && lit && d <= 4 ? 'block' : 'run';
}

/**
 * A fight that's going nowhere: no hit landed and not a block closer for `patience` ticks. The
 * caller writes the target off for a while (it counts as out of reach) and gets on with things.
 */
export class Stalemate {
  constructor(patience = 120) { this.patience = patience; this.id = null; }
  /** Call every fight tick. Returns true when it's time to give up on this target. */
  update(id, t, d, hpLost) {
    if (id !== this.id) { this.id = id; this.best = d; this.since = t; this.hp = hpLost; return false; }
    if (d < this.best - 1 || hpLost > this.hp) { this.best = Math.min(this.best, d); this.since = t; this.hp = hpLost; }
    return t - this.since > this.patience;
  }
  reset() { this.id = null; }
}

/**
 * Where to run to, from candidate spots we can walk to ({x, y, z, cost} in path blocks): as far as
 * possible from the threats (the nearest counts most), a little less for a long run, and a lot
 * better out of sight of anything shooting at us (sees(spot, mob) -> bool). Returns the spot or
 * null when nowhere is clearly better than here.
 */
export function pickRefuge(me, threats, candidates, sees = null, margin = 3) {
  const shooters = threats.filter((m) => MOBS[m.type]?.kind === 'ranged');
  const score = (p, cost) => {
    let nearest = Infinity;
    for (const t of threats) nearest = Math.min(nearest, Math.hypot(p.x - t.pos.x, (p.y - t.pos.y) * 1.5, p.z - t.pos.z));
    let s = Math.min(nearest, 24) - cost * 0.15;
    if (sees && shooters.length && shooters.every((m) => !sees(p, m))) s += 10; // out of the line of fire
    return s;
  };
  const here = score(me, 0);
  let best = null, bestS = here + margin;
  // Nearest-first by the run, so the line-of-sight checks (rays in game) go to the likely ones.
  // Only spots on our side of them: somewhere nearer a threat than to us is past it (down a tunnel,
  // that's running straight into the zombies).
  const ourSide = (c) => threats.every((m) => m.dist > 10 || Math.hypot(c.x - m.pos.x, c.z - m.pos.z) > Math.hypot(c.x - me.x, c.z - me.z));
  for (const c of [...candidates].filter(ourSide).sort((a, b) => a.cost - b.cost).slice(0, 60)) {
    const s = score(c, c.cost);
    if (s > bestS) { bestS = s; best = c; }
  }
  return best;
}

/**
 * Spears, Bedrock (minecraft.wiki, Spear: the jab). Damage and the forced use cooldown (ticks, shared
 * by every spear we carry). Reach 2 to 4 blocks (eye to the target's box, which a spear inflates by
 * 0.125) where a sword's is 3: less damage a second than a sword, but it hits a creeper from outside
 * its ~2.9-block fuse range with room to spare. Crafted from one of the material and two sticks.
 */
export const SPEAR_DAMAGE = { wooden_spear: 2, golden_spear: 2, stone_spear: 3, copper_spear: 3, iron_spear: 4, diamond_spear: 5, netherite_spear: 6 };
export const SPEAR_COOLDOWN = { wooden_spear: 13, golden_spear: 19, stone_spear: 15, copper_spear: 17, iron_spear: 19, diamond_spear: 21, netherite_spear: 23 };
export const isSpear = (id) => !!id && id.replace('minecraft:', '') in SPEAR_DAMAGE;

/**
 * How a weapon reaches and how often it hits, feet to feet (what our distances are): a sword or
 * axe 3 from the eye (~3.2 feet to feet, level), a spear 4 from the eye plus its 0.125 margin (~4.4;
 * 4.0 counted, to be safe) and nothing within 2 (~2.4). cooldown: ticks between hits that count
 * (a mob shrugs off hits for 10 ticks after one; a spear's own cooldown is longer).
 */
export function weaponReach(id) {
  const k = (id ?? '').replace('minecraft:', '');
  if (k in SPEAR_DAMAGE) return { reach: 4.0, minReach: 2.4, cooldown: Math.max(10, SPEAR_COOLDOWN[k]), damage: SPEAR_DAMAGE[k] };
  return { reach: REACH_HIT, minReach: 0, cooldown: 10, damage: weaponDamage(k) };
}

/**
 * Which weapon to swing at a creeper right now, when we carry a spear and a sword: the spear's jab
 * reaches 4 but has its own cooldown (15 ticks for stone, shared by all our spears); the sword
 * reaches 3 and is ready whenever the mob can be hurt again (10 ticks after the last hit). Switching
 * is instant in Bedrock. weapons: [{ id, reach, minReach, readyAt }]. Returns the one to use now
 * (ready and in reach), else the next one to be ready (to plan the spacing for), with ready.
 */
export function pickCreeperSwing(weapons, d, t) {
  const ready = weapons.filter((w) => t >= w.readyAt);
  const now = ready.find((w) => d <= w.reach && d >= w.minReach);
  if (now) return { ...now, ready: true };
  if (ready.length) return { ...ready.sort((a, b) => b.reach - a.reach)[0], ready: true };
  return { ...[...weapons].sort((a, b) => a.readyAt - b.readyAt)[0], ready: false };
}

/** What to hold against a creeper: a spear if we have one (reach), else our best weapon. */
export function creeperWeapon(items, best) {
  const spears = items.filter((i) => isSpear(i.id) && (i.uses ?? Infinity) >= 2);
  // Most damage a second among them (all reach the same).
  spears.sort((a, b) => SPEAR_DAMAGE[b.id] / SPEAR_COOLDOWN[b.id] - SPEAR_DAMAGE[a.id] / SPEAR_COOLDOWN[a.id]);
  return spears[0]?.id ?? best;
}

/**
 * What to fight with: [{ id, uses }] (uses: durability left, Infinity if unknown). Most damage a
 * hit (Bedrock has no attack cooldown, so that's damage per second too: swords beat axes and
 * spears), one about to break only if there's nothing else. Returns the id or null (fists).
 */
export function bestWeapon(items) {
  let best = null, bestScore = 1;
  for (const { id, uses = Infinity } of items) {
    // A spear by its damage a hit spread over its cooldown (10 ticks is a sword's pace).
    const dmg = id in SPEAR_DAMAGE ? SPEAR_DAMAGE[id] * 10 / SPEAR_COOLDOWN[id] : weaponDamage(id);
    if (dmg <= 1) continue;
    const score = dmg - (uses < 4 ? 3 : 0);
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}

/**
 * Wall ourselves off: in a 1-wide passage (a tunnel, the quarry stairs, a dead end) with the threats
 * coming the one way in, two blocks across it (feet and head height of the next step toward them)
 * keep zombies out, arrows off and a creeper's blast mostly away. at(x, y, z) -> 'open' | 'solid'
 * | 'other'. Returns the cells to fill (in order) or null if there's no single way in to block.
 */
export function barricadeCells(me, threat, at) {
  const f = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
  const w = oneWayIn(me, threat, at);
  if (!w) return null;
  const cells = [{ x: w.x, y: w.y, z: w.z }, { x: w.x, y: w.y + 1, z: w.z }];
  // Stairs going up toward it: our own headroom opens onto its step too.
  if (w.y > f.y && at(w.x, w.y + 2, w.z) === 'open') cells.push({ x: w.x, y: w.y + 2, z: w.z });
  return cells;
}

/**
 * The one way out of our cell (a neighbouring column we could step into: same level, one up, one
 * down), if there's exactly one and it's the way the threat comes from; else null (open ground, a
 * junction, or it's coming some other way). Returns { x, y, z, dx, dz }.
 */
export function oneWayIn(me, threat, at) {
  const f = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
  const ways = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [0, 1, -1]) {
      const x = f.x + dx, y = f.y + dy, z = f.z + dz;
      if (at(x, y, z) === 'open' && at(x, y + 1, z) === 'open' && at(x, y - 1, z) === 'solid' && (dy <= 0 || at(f.x, f.y + 2, f.z) === 'open')) { ways.push({ x, y, z, dx, dz }); break; }
    }
  }
  if (ways.length !== 1) return null; // open ground, or a junction: two blocks won't shut it
  const w = ways[0];
  // It has to be the way the threat comes from.
  return (threat.x - me.x) * w.dx + (threat.z - me.z) * w.dz > 0 ? w : null;
}

/**
 * A kill slot: at a dead end (a tunnel's end, a 1-wide passage with the only way in toward them)
 * with tall melee mobs coming, a block at our feet in the next cell toward them, and one over head
 * height there if the ceiling is higher, leaves a 1-high gap at eye level. A zombie can't get
 * through it or up onto it; pressed against it, it's 1.6+ from the middle of our cell and hits at
 * 1.4 (Bedrock's melee box: its box grown 0.8 each way). We hit it through the gap at eye level,
 * one at a time. No good against anything that fits through a 1-high gap (a spider, a baby zombie,
 * a slime) or that shoots through it.
 * at(x, y, z) -> 'open' | 'solid' | 'other'. Returns { cells, slot, stand, dir } or null:
 * cells to fill (in order), the gap, where to stand (a little back from the middle of our cell),
 * the unit step toward them.
 */
export function killSlotCells(me, threat, at) {
  const f = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
  const w = oneWayIn(me, threat, at);
  if (!w || w.y !== f.y) return null; // level with us only: on stairs the gap isn't at eye height
  if (at(f.x, f.y - 1, f.z) !== 'solid') return null;
  const cells = [{ x: w.x, y: w.y, z: w.z }];
  // A higher ceiling: close it over the gap too, or a zombie steps up onto the block and walks in.
  if (at(w.x, w.y + 2, w.z) === 'open') cells.push({ x: w.x, y: w.y + 2, z: w.z });
  const stand = { x: f.x + 0.5 - w.dx * 0.15, y: f.y, z: f.z + 0.5 - w.dz * 0.15 };
  return { cells, slot: { x: w.x, y: w.y + 1, z: w.z }, stand, dir: { x: w.dx, z: w.dz } };
}

/**
 * Worth building a kill slot? Everything after us is a tall melee mob (SLOT_SAFE: no spider, no
 * archer, no creeper at the gap), there's more than one of them or we're hurt, and the nearest is
 * far enough off to get the blocks down first (3.5: a zombie walks that in a second).
 * threats: [{ type, dist, baby? }] (the ones within 16).
 */
export function killSlotWorth({ threats, health }) {
  const near = threats.filter((m) => m.dist <= 16);
  if (!near.length || near.some((m) => !SLOT_SAFE.has(m.type) || m.baby)) return false;
  if (Math.min(...near.map((m) => m.dist)) < 3.5) return false;
  return near.length >= 2 || health <= 12;
}
