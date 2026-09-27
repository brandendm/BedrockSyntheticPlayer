// Fighting and running, move by move. Pure (unit-tested, and run against simulated mobs by
// tools/sim_combat.mjs), so what's tested is what the game does.
//
//   fightMove   where to go and whether to swing or raise the shield, against one target
//   Stalemate   notices a fight that's going nowhere (a skeleton at the top of the quarry we can't
//               get a path to, an arrow line that never reaches us): give it up, don't stare at it
//   pickRefuge  where to run: far from the threats, and out of a shooter's sight if one's hitting us
//   bestWeapon  what to hold: most damage per hit (Bedrock has no attack cooldown), worn-out last
import { HOLD_AT, REACH_HIT, BACK_OFF, STOP_AT, standOff, MOBS, weaponDamage } from './threat.js';

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

/**
 * Killing a creeper the way players do: walk in, hit it (the knockback throws it back), back straight
 * off until we're well clear (its fuse stops once we're out of range), again. Four hits with a stone
 * sword. st keeps the phase between calls ({ phase: 'in'|'out', since }). Shield up if it's still
 * close a second after the hit (it may go off before we're clear), and always if we can't get away.
 */
export function creeperFight({ me, mob, t, st, shield = false, canSwing = true, canRetreat = true }) {
  const d = dist(me, mob);
  const out = { goal: null, tolerance: 0, urgent: true, now: false, stop: false, swing: false, block: false };
  // Nowhere to back off to (a dead end, a pit): the dance can't work. Shield up and let it go off on
  // the shield; without one, keep hitting it back (each hit buys a moment) and hope.
  if (!canRetreat) {
    if (shield) { out.stop = true; out.block = d < 6; return out; }
    // No shield: stay as far back as we can get (the blast weakens fast with distance), and only
    // hit it if it comes into reach (the knockback buys a block or two).
    out.stop = true;
    if (d <= REACH_HIT && canSwing) out.swing = true;
    return out;
  }
  // Back in only once its fuse has gone off or died down (1.5 s from when it started hissing: 2 s
  // after our hit covers it) and we're clear.
  // (Or it's walked back up to us by then: hit it again, it's the same dance.)
  if (st.phase === 'out' && t - st.since >= 40 && (d >= 6 || d <= REACH_HIT + 0.3)) st.phase = 'in';
  if (st.phase !== 'out') {
    if (d <= REACH_HIT && canSwing) {
      // Hit, and pick the spot to back off to now, once (well past the fuse's range, straight away
      // from it): chasing a point that moves with us every few steps never got us clear.
      // Straight from walking in to backing off, no stop between (a fresh walk starts with a
      // moment's reaction: time the fuse doesn't give us).
      out.swing = true;
      st.phase = 'out'; st.since = t; st.retreat = standOff(me, mob, 8.5);
      out.goal = st.retreat; out.tolerance = 1; out.now = true;
      return out;
    }
    out.goal = { x: mob.x, y: mob.y, z: mob.z }; out.tolerance = HOLD_AT - 0.2;
  }
  if (st.phase === 'out') {
    if (!st.retreat || dist(me, st.retreat) < 1.6) st.retreat = standOff(me, mob, 8.5);
    out.goal = st.retreat;
    out.tolerance = 1;
    if (shield && d < 3.5 && t - st.since > 20) { out.block = true; out.goal = null; out.stop = true; }
  }
  return out;
}

/** Fight a creeper at all? Armed (a stone sword or better), healthy, and nothing else on us. */
export function creeperWorthFighting({ damage, health, others }) {
  return damage >= 5 && health >= 12 && !others;
}

/**
 * A creeper about to go off next to us: stand and face it with the shield up (it takes the whole
 * blast from the front) rather than run a race we'll lose. Without a shield: run.
 * Returns 'block' | 'run'.
 */
export function creeperMove({ me, creeper, shield }) {
  const d = dist(me, creeper);
  return shield && d <= 4 ? 'block' : 'run';
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
 * Spears: the jab hits for less than a sword of the same material. These are estimates (the
 * figures aren't settled for this game version), so a spear is only held with nothing better.
 */
export const SPEAR_DAMAGE = { wooden_spear: 2, stone_spear: 3, copper_spear: 3, iron_spear: 4, golden_spear: 2, diamond_spear: 5, netherite_spear: 6 };

/**
 * What to fight with: [{ id, uses }] (uses: durability left, Infinity if unknown). Most damage a
 * hit (Bedrock has no attack cooldown, so that's damage per second too: swords beat axes and
 * spears), one about to break only if there's nothing else. Returns the id or null (fists).
 */
export function bestWeapon(items) {
  let best = null, bestScore = 1;
  for (const { id, uses = Infinity } of items) {
    const dmg = SPEAR_DAMAGE[id] ?? weaponDamage(id);
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
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  // Ways out of our cell: a neighbouring column we could step into (same level, one up, one down).
  const ways = [];
  for (const [dx, dz] of dirs) {
    for (const dy of [0, 1, -1]) {
      const x = f.x + dx, y = f.y + dy, z = f.z + dz;
      if (at(x, y, z) === 'open' && at(x, y + 1, z) === 'open' && at(x, y - 1, z) === 'solid' && (dy <= 0 || at(f.x, f.y + 2, f.z) === 'open')) { ways.push({ x, y, z, dx, dz }); break; }
    }
  }
  if (ways.length !== 1) return null; // open ground, or a junction: two blocks won't shut it
  const w = ways[0];
  // It has to be the way the threat comes from.
  if ((threat.x - me.x) * w.dx + (threat.z - me.z) * w.dz <= 0) return null;
  const cells = [{ x: w.x, y: w.y, z: w.z }, { x: w.x, y: w.y + 1, z: w.z }];
  // Stairs going up toward it: our own headroom opens onto its step too.
  if (w.y > f.y && at(w.x, w.y + 2, w.z) === 'open') cells.push({ x: w.x, y: w.y + 2, z: w.z });
  return cells;
}
