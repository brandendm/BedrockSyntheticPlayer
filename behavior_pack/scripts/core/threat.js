// Survival reflexes: decide fight / flee / nothing from what the bot can see.
// Pure and fast; runs in-game every few ticks. No API calls: reflexes can't wait 300 ms.
//
// The rule is a race, not a list of special cases: fight only if we'd kill everything that's
// after us well before it kills us.
//     time_to_kill = sum over enemies of ceil(hp / our damage) * swing interval
//     time_to_die  = our HP / (total enemy DPS * KNOCKBACK)
//     fight if time_to_kill < FIGHT_MARGIN * time_to_die
// KNOCKBACK: every hit knocks the mob back, so while we're swinging it lands roughly half its attacks.
// Overrides on top: creepers are never meleed, some mobs are never fought, very low HP always flees,
// neutral mobs (endermen, daytime spiders, zombified piglins) only count once they're after us.

export const ATTACK_INTERVAL_S = 0.6; // how often we swing (12 ticks)
export const FIGHT_MARGIN = 0.6;       // need to win the race by this margin to start a fight
export const KEEP_FIGHTING_MARGIN = 0.9; // hysteresis: once engaged, keep going unless clearly losing
export const FLEE_HEALTH = 6;
export const FIST_DAMAGE = 1;
export const KNOCKBACK = 0.5;

// hp, dps (roughly, on normal difficulty), kind: melee | ranged | explode
// neutral: only a threat when it's targeting or has hit us. never: don't melee it, just run.
export const MOBS = {
  zombie: { hp: 20, dps: 3, kind: 'melee' },
  husk: { hp: 20, dps: 3, kind: 'melee' },
  drowned: { hp: 20, dps: 3, kind: 'melee' },
  zombie_villager: { hp: 20, dps: 3, kind: 'melee' },
  zombie_villager_v2: { hp: 20, dps: 3, kind: 'melee' },
  skeleton: { hp: 20, dps: 2, kind: 'ranged' },
  stray: { hp: 20, dps: 2, kind: 'ranged' },
  bogged: { hp: 16, dps: 2.5, kind: 'ranged' },
  spider: { hp: 16, dps: 2, kind: 'melee', neutralInDay: true },
  cave_spider: { hp: 12, dps: 2.5, kind: 'melee' },
  silverfish: { hp: 8, dps: 1, kind: 'melee' },
  endermite: { hp: 8, dps: 2, kind: 'melee' },
  slime: { hp: 8, dps: 2, kind: 'melee' },
  magma_cube: { hp: 8, dps: 3, kind: 'melee' },
  phantom: { hp: 20, dps: 2, kind: 'melee' },
  creeper: { hp: 20, dps: 20, kind: 'explode' },
  witch: { hp: 26, dps: 3, kind: 'ranged', never: true },
  pillager: { hp: 24, dps: 3, kind: 'ranged' },
  vindicator: { hp: 24, dps: 10, kind: 'melee', never: true },
  evoker: { hp: 24, dps: 6, kind: 'ranged', never: true },
  ravager: { hp: 100, dps: 12, kind: 'melee', never: true },
  enderman: { hp: 40, dps: 7, kind: 'melee', neutral: true },
  zombie_pigman: { hp: 20, dps: 5, kind: 'melee', neutral: true },
  piglin: { hp: 16, dps: 5, kind: 'melee', neutral: true },
  hoglin: { hp: 40, dps: 6, kind: 'melee' },
  blaze: { hp: 20, dps: 5, kind: 'ranged', never: true },
  wither_skeleton: { hp: 20, dps: 8, kind: 'melee' },
  guardian: { hp: 30, dps: 4, kind: 'ranged', never: true },
  warden: { hp: 500, dps: 30, kind: 'melee', never: true },
};

// Melee/axe damage in Bedrock (base, no enchantments).
export const WEAPON_DAMAGE = {
  wooden_sword: 5, golden_sword: 5, stone_sword: 6, iron_sword: 7, diamond_sword: 8, netherite_sword: 9,
  wooden_axe: 4, golden_axe: 4, stone_axe: 4, iron_axe: 5, diamond_axe: 6, netherite_axe: 7,
  trident: 9, mace: 7,
};

export function weaponDamage(typeId) {
  if (!typeId) return FIST_DAMAGE;
  return WEAPON_DAMAGE[typeId.replace('minecraft:', '')] ?? FIST_DAMAGE;
}

/** Is this mob actually a threat right now? */
export function isActiveThreat(m, isNight, alert = false) {
  const info = MOBS[m.type];
  if (!info) return false;
  const provoked = m.targetingMe || m.attackedMe;
  if (info.neutral) return provoked;
  if (info.neutralInDay && !isNight) return provoked;
  // Once we're already fighting or running, keep tracking mobs a bit further and around corners:
  // a zombie that stepped behind a tree hasn't stopped chasing us.
  // Only mobs we can see, or saw in the last few seconds: a cave full of zombies behind the walls
  // isn't a fight (otherwise we'd never calm down underground).
  const range = (info.kind === 'ranged' ? 16 : 12) + (alert ? 8 : 0);
  return provoked || (m.dist <= range && (m.visible || (alert && (m.recent ?? true))));
}

/**
 * input: { health, damage, isNight, prevMode, mobs: [{id, type, dist, visible, targetingMe, attackedMe}] }
 * output: { mode: 'none'|'fight'|'flee', target?: id, threats: [mob], reason }
 */
export function decide({ health, damage = FIST_DAMAGE, isNight = false, prevMode = 'none', mobs, inWater = false }) {
  const alert = prevMode !== 'none';
  const threats = mobs.filter((m) => isActiveThreat(m, isNight, alert)).sort((a, b) => a.dist - b.dist);
  if (!threats.length) return { mode: 'none', threats, reason: 'clear' };

  // Creepers: never melee. Keep well clear of one that's closing in; stop only once it's lost interest.
  // Creepers only matter up close: one hissing at us from 15 blocks away is a reason to keep an
  // eye on it, not to drop everything (it has to get within 3 to blow).
  const creeper = threats.find((m) => m.type === 'creeper' && (m.canReach ?? true) &&
    ((m.visible || m.recent) && m.dist <= (alert ? 10 : m.targetingMe ? 8 : 5)));
  if (creeper) return { mode: 'flee', threats, reason: 'creeper' };
  const never = threats.find((m) => MOBS[m.type].never && m.dist <= 16);
  if (never) return { mode: 'flee', threats, reason: `won't fight ${never.type}` };
  if (health <= FLEE_HEALTH) return { mode: 'flee', threats, reason: 'low health' };

  // Only the mobs close enough to matter in the next few seconds go into the race.
  // Only mobs that can actually get at us: seen (not a zombie in the cave under our feet or
  // behind a wall that's merely "targeting" us), on roughly our level, and close. A skeleton
  // that isn't aiming at us is ignored unless it's right here.
  // A melee mob also has to be able to walk to us (m.canReach, from a short path search).
  // (A drowned bobbing in the lake next to us is not our problem until it comes out and hits us.)
  const reachable = (m) => m.attackedMe || (m.inWater && !inWater ? false : m.dist <= 2.5 || ((m.visible || (alert && (m.recent ?? true))) &&
    (MOBS[m.type].kind === 'ranged' || (m.canReach ?? Math.abs(m.dy ?? 0) <= 4))));
  const engaged = threats.filter((m) => m.type !== 'creeper' && reachable(m) &&
    (m.attackedMe || m.dist <= (MOBS[m.type].kind === 'ranged' ? (m.targetingMe ? 16 : 4) : alert ? 16 : m.targetingMe ? 12 : 8)));
  if (!engaged.length) return { mode: 'none', threats, reason: 'threats not engaged yet' };

  const ttk = engaged.reduce((s, m) => s + Math.ceil(MOBS[m.type].hp / damage) * ATTACK_INTERVAL_S, 0);
  const enemyDps = engaged.reduce((s, m) => s + MOBS[m.type].dps, 0) * KNOCKBACK;
  const ttd = health / enemyDps;
  const margin = prevMode === 'fight' ? KEEP_FIGHTING_MARGIN : FIGHT_MARGIN;
  const why = `kill ${ttk.toFixed(1)}s vs die ${ttd.toFixed(1)}s`;

  // In water we swing slowly, can't dodge and drowned out-swim us: get to land first.
  if (inWater) return { mode: 'flee', threats, reason: `in water (${why})` };
  if (ttk < margin * ttd) {
    // Hit whoever is actually hitting us first, then the nearest.
    const target = engaged.find((m) => m.attackedMe) || engaged[0];
    return { mode: 'fight', target: target.id, threats, reason: why };
  }
  return { mode: 'flee', threats, reason: why };
}

/** Point `distance` blocks away from the threats, weighted toward the closest ones. */
/**
 * How good a place is to run to: as far as possible from every threat (the nearest one counts
 * most), minus a little for how long it takes to get there.
 */
export function refugeScore(p, threats, pathCost) {
  let nearest = Infinity;
  for (const t of threats) nearest = Math.min(nearest, Math.hypot(p.x - t.pos.x, (p.y - t.pos.y) * 1.5, p.z - t.pos.z));
  return Math.min(nearest, 24) - pathCost * 0.15;
}

export function fleePoint(me, threats, distance = 16) {
  let vx = 0, vz = 0;
  for (const t of threats) {
    const dx = me.x - t.pos.x, dz = me.z - t.pos.z;
    const d = Math.max(0.5, Math.hypot(dx, dz));
    vx += dx / (d * d);
    vz += dz / (d * d);
  }
  const len = Math.hypot(vx, vz);
  if (len < 1e-6) { vx = 1; vz = 0; } else { vx /= len; vz /= len; }
  return { x: Math.floor(me.x + vx * distance), z: Math.floor(me.z + vz * distance) };
}

// ---------- melee spacing ----------
// A player's reach is 3 blocks from the eye to the mob's hitbox (~3.2 feet-to-feet on level
// ground); a zombie has to be within about 2 to hit back. Fighting from the edge of our reach
// means we land hits while it's still walking in, like a player keeping distance with a sword.
export const REACH_HIT = 3.2;   // swing if the target is this close (feet to feet)
export const STOP_AT = 3.0;     // stop walking in at this distance (momentum carries a little further)
export const HOLD_AT = 2.8;     // where to stand when closing in
export const BACK_OFF = 2.0;    // a melee mob this close: step back to HOLD_AT while swinging

/** 'approach' | 'hold' | 'back' for a target d blocks away (feet to feet). */
export function spacing(d, melee) {
  if (d > STOP_AT) return 'approach';
  if (melee && d < BACK_OFF) return 'back';
  return 'hold';
}

/** Point on the line from the mob toward us, r blocks from the mob (where to stand). */
export function standOff(me, mob, r = HOLD_AT) {
  const dx = me.x - mob.x, dz = me.z - mob.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: mob.x + (dx / len) * r, y: mob.y, z: mob.z + (dz / len) * r };
}
