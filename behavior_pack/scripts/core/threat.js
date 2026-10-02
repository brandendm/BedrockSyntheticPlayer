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
export const COMMITTED_MARGIN = 1.3;    // toe to toe with a melee mob: running gives it free hits
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
  witch: { hp: 26, dps: 1.5, kind: 'ranged', potions: true }, // fought: rushed and hit (core/tactics.js fightMove), its potions dodged (a splash mostly lands wide: ~1.2 a second in the arena, and running only gives it more throws)
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

/** Tall melee mobs: can't get through a 1-high gap (core/tactics.js killSlotCells). Grown ones only. */
export const SLOT_SAFE = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'zombie_villager_v2', 'vindicator', 'wither_skeleton']);

export function weaponDamage(typeId) {
  if (!typeId) return FIST_DAMAGE;
  return WEAPON_DAMAGE[typeId.replace('minecraft:', '')] ?? FIST_DAMAGE;
}

/**
 * What's left of a hit of `hit` after armor (Minecraft's formula: armor points take 4% each, less
 * against big hits; toughness keeps more of it against those). 0-1.
 */
export function armorFactor(hit, armor = 0, toughness = 0) {
  if (!armor) return 1;
  return 1 - Math.min(20, Math.max(armor / 5, armor - hit / (2 + toughness / 4))) / 25;
}

/** Is this mob actually a threat right now? */
export function isActiveThreat(m, isNight, alert = false) {
  const info = MOBS[m.type];
  if (!info) return false;
  const provoked = m.targetingMe || m.attackedMe;
  // A creeper hissing near us is heard, seen or not; one right next to us is there, seen or not.
  // (Not one we've walled off: can't get at us, can't see us, not hissing.)
  const walledOff = m.canReach === false && m.visible === false && !m.lit;
  if (m.type === 'creeper' && ((m.lit && m.dist <= 8) || (m.dist <= 4 && !walledOff))) return true;
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
 * input: { health, damage, isNight, prevMode, mobs: [{id, type, dist, visible, targetingMe, attackedMe}], armor, toughness }
 * (armor: points worn, 0-20; toughness: diamond/netherite's, core/wants.js armorTotal)
 * slot: we're standing behind a kill slot (core/tactics.js killSlotCells): a grown zombie on the far
 * side can't hit us, and we can hit it through the gap. Fight it from there, hurt or not.
 * output: { mode: 'none'|'fight'|'flee', target?: id, threats: [mob], reason }
 */
export function decide({ health, damage = FIST_DAMAGE, isNight = false, prevMode = 'none', mobs, inWater = false, shield = false, slot = false, witches = true, armor = 0, toughness = 0, bow = false }) {
  const held = (m) => slot && SLOT_SAFE.has(m.type) && !m.baby; // at the gap: can't get at us
  const alert = prevMode !== 'none';
  const threats = mobs.filter((m) => isActiveThreat(m, isNight, alert)).sort((a, b) => a.dist - b.dist);
  if (!threats.length) return { mode: 'none', threats, reason: 'clear' };

  // Creepers. Noticed early: one we can see within 8, one after us within 12, one hissing within 8
  // (heard, seen or not) and anything within 4 whatever the path search said (it's right there).
  // Handled by keeping it at arm's length (core/tactics.js creeperFight: it never gets to light) if
  // it's the only thing on us; with company, away from it.
  const creeper = threats.find((m) => m.type === 'creeper' && (
    (m.dist <= 4 && !(m.canReach === false && m.visible === false && !m.lit)) || (m.lit && m.dist <= 8) ||
    ((m.canReach ?? true) && (m.visible || m.recent) && m.dist <= (alert ? 12 : m.targetingMe ? 12 : 8))));
  // With a bow and arrows: creepers still 6+ off are shot, one after another, even in a crowd of them (running from four for ever
  // took 10 s and 3.5 hp where a player walked at them and shot or hit them down in 4). Nothing lit or close, no melee mob near.
  if (bow) {
    const shots = threats.filter((m) => m.type === 'creeper' && m.visible && m.dist >= 6 && m.dist <= 20 && !m.lit);
    const close = threats.some((m) => (m.type === 'creeper' && (m.lit || m.dist < 5.5)) || (m.type !== 'creeper' && MOBS[m.type].kind === 'melee' && m.dist <= 8 && (m.visible || m.attackedMe)));
    if (shots.length && !close) return { mode: 'fight', target: shots[0].id, threats, reason: 'creeper: shoot it from afar' };
  }
  if (creeper) {
    // Company that rules it out: something that would be on us while we hold the creeper off (a
    // zombie within 10, another creeper). A skeleton at range is less than a blast: hold the creeper
    // off anyway.
    const others = threats.some((m) => m !== creeper && (m.visible || m.attackedMe) &&
      (m.type === 'creeper' ? m.dist <= 8 : MOBS[m.type].kind === 'melee' ? m.dist <= 10 : m.dist <= 3));
    if (!others && creeper.canReach !== false && !inWater) return { mode: 'fight', target: creeper.id, threats, reason: 'creeper: keep it at arm\'s length' };
    // Company, but the creeper's well back (it walks at about half a zombie's pace: running strings
    // them out, the creeper last): turn on the rest while it's 10+ off (8+ once we're at it), then
    // run again as it comes up. Running from all of them for ever never won the fight.
    const creeperBack = !creeper.lit && creeper.dist > (prevMode === 'fight' ? 8 : 10) && !threats.some((m) => m !== creeper && m.type === 'creeper' && m.dist <= 10);
    if (!creeperBack) return { mode: 'flee', threats, reason: 'creeper' };
  }
  // (witches: the goal switched off, `!bot goal witches off`: run from them as before)
  const never = threats.find((m) => (MOBS[m.type].never || (m.type === 'witch' && !witches)) && m.dist <= 16);
  if (never) return { mode: 'flee', threats, reason: `won't fight ${never.type}` };
  // Low on health: run. Except already up close to an archer and nothing else on us: turning our
  // back on it in the open is how it gets the last few shots in; finish it.
  // (Behind a kill slot with only zombies at it: nothing can hurt us; running is what would.)
  // Armor counts as health: iron all over takes over half of a zombie's hit, so 10 hp in it is
  // more like 22. Confidence goes on what we can take (health through armor), not bare health.
  const closeOnes = threats.filter((m) => m.dist <= 16 && (m.visible || m.attackedMe));
  const lowAt = Math.max(3, FLEE_HEALTH * armorFactor(3, armor, toughness));
  if (health <= lowAt && !(closeOnes.length && closeOnes.every(held))) {
    const close = threats.filter((m) => m.dist <= 16 && (m.visible || m.attackedMe));
    const archerOnly = close.length > 0 && close.every((m) => MOBS[m.type].kind === 'ranged');
    const nearest = close[0];
    // Or a melee mob on us that one more hit or two finishes: running is free hits for it.
    const finishing = prevMode === 'fight' && nearest && nearest.dist <= 3.5 && MOBS[nearest.type].kind === 'melee' &&
      nearest.hp !== undefined && Math.ceil(nearest.hp / damage) <= 2;
    if (finishing) return { mode: 'fight', target: nearest.id, threats, reason: 'low health, but one more hit or two finishes it' };
    if (!(prevMode === 'fight' && archerOnly && nearest && nearest.dist <= 5 && damage >= 4)) return { mode: 'flee', threats, reason: 'low health' };
    return { mode: 'fight', target: nearest.id, threats, reason: 'low health, but it is right here: finishing it' };
  }

  // Only the mobs close enough to matter in the next few seconds go into the race.
  // Only mobs that can actually get at us: seen (not a zombie in the cave under our feet or
  // behind a wall that's merely "targeting" us), on roughly our level, and close. A skeleton
  // that isn't aiming at us is ignored unless it's right here.
  // A melee mob also has to be able to walk to us (m.canReach, from a short path search).
  // (A drowned bobbing in the lake next to us is not our problem until it comes out and hits us.)
  // Archers too: one we can't get a path to (up at the mouth of the quarry, across a ravine) is no
  // fight: going for it was the staring contest. If it's hitting us, take cover instead (below).
  const reachable = (m) => (held(m) && m.visible && m.dist <= 8) || (m.attackedMe && m.canReach !== false) || (m.inWater && !inWater ? false : m.dist <= 2.5 || ((m.visible || (alert && (m.recent ?? true))) &&
    (m.canReach ?? (MOBS[m.type].kind === 'ranged' || Math.abs(m.dy ?? 0) <= 4))));
  const engaged = threats.filter((m) => m.type !== 'creeper' && reachable(m) &&
    (m.attackedMe || m.dist <= (MOBS[m.type].kind === 'ranged' ? (m.targetingMe ? 16 : 4) : alert ? 16 : m.targetingMe ? 12 : 8)));
  const engagedCount = engaged.length;
  if (!engaged.length) {
    // Shot at by something we can't get to: out of its line of fire (a corner, back down the tunnel).
    const shooter = threats.find((m) => MOBS[m.type].kind === 'ranged' && m.attackedMe && m.canReach === false);
    if (shooter) return { mode: 'flee', threats, reason: 'cover', cover: true };
    return { mode: 'none', threats, reason: 'threats not engaged yet' };
  }

  // An archer has to be walked up to first, and it shoots all the way: that time counts too.
  const walkIn = (m) => (MOBS[m.type].kind === 'ranged' ? Math.max(0, m.dist - 3) / 4.3 : 0);
  // Health it has left (m.hp) when known: a skeleton we've already hit twice is nearly done.
  const ttk = engaged.reduce((s, m) => s + Math.ceil(Math.max(1, m.hp ?? MOBS[m.type].hp) / damage) * ATTACK_INTERVAL_S + walkIn(m), 0);
  // A shield takes arrows from the front and much of what's in front of us up close.
  // (Only from the front, and not while swinging: with two or more after us, less.)
  const guard = (m) => held(m) ? 0 : (!shield ? 1 : (MOBS[m.type].kind === 'ranged' ? 0.4 : 0.7) + (engagedCount > 1 ? 0.2 : 0));
  const enemyDps = engaged.reduce((s, m) => s + MOBS[m.type].dps * guard(m) * armorFactor(MOBS[m.type].dps, armor, toughness), 0) * KNOCKBACK;
  const ttd = enemyDps > 0 ? health / enemyDps : Infinity;
  // Already trading blows with something right on us: turning our back is free hits for it (a
  // zombie keeps up for the first seconds, and in a tunnel for ever). Run only if clearly losing.
  const toeToToe = prevMode === 'fight' && engaged.some((m) => MOBS[m.type].kind === 'melee' && m.dist <= 3);
  // A witch in range: running gives it more throws (it follows, and throws from 10 blocks), so it's
  // fought unless we'd clearly lose (tools/sim_combat.mjs --witch: running from one was the
  // deadliest thing to do with it).
  const outranged = engaged.some((m) => MOBS[m.type].potions && m.dist <= 16);
  const margin = Math.max(toeToToe ? COMMITTED_MARGIN : prevMode === 'fight' ? KEEP_FIGHTING_MARGIN : FIGHT_MARGIN, outranged ? 1 : 0);
  const why = `kill ${ttk.toFixed(1)}s vs die ${ttd.toFixed(1)}s`;

  // In water we swing slowly, can't dodge and drowned out-swim us: get to land first.
  if (inWater) return { mode: 'flee', threats, reason: `in water (${why})` };
  if (ttk < margin * ttd) {
    // Whatever's in our face first (a zombie in the tunnel between us and the skeleton that shot
    // us: going for the skeleton meant not swinging at the zombie hitting us), then whoever is
    // actually hitting us, then the nearest.
    // Of those in our face, the one with least health left: one nearly dead gets finished (two
    // hitting us is twice the damage; killing one sooner halves it sooner), not left at 4 hp for a
    // fresh one that stepped in front.
    const inFace = (m) => MOBS[m.type].kind === 'melee' && m.dist <= 3.5;
    const hpLeft = (m) => m.hp ?? MOBS[m.type].hp;
    const faced = engaged.filter(inFace).sort((a, b) => hpLeft(a) - hpLeft(b) || (b.attackedMe ? 1 : 0) - (a.attackedMe ? 1 : 0));
    const target = faced[0] || engaged.find((m) => m.attackedMe) || engaged[0];
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
export const BACK_OFF = 2.6;    // a melee mob this close: step back to HOLD_AT while swinging (a zombie hits from ~1.6: at 2.0 it was often in; tools/sim_combat.mjs --zombies: 0.76 hits a fight -> 0.28)

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
