// A fighting doctrine: every number a bot's fight is decided by, in one table (the colosseum's drive() reads them; the lab (brain/lab.py) searches them).
// Each has a default (what the bots did before), a range (a search never goes outside it), a group, one line saying what it does, and, for the few
// the real survival fight also reads (core/tunables.js), `real`: how it becomes that constant. A value above 0.5 on a use* switch means yes.

export const DOCTRINE = {
  // --- spacing: where to stand against a melee mob
  holdAt:       { v: 2.8, min: 2.0, max: 3.2, group: 'spacing', about: 'walk in until this close to a melee target (blocks)', real: { key: 'holdAt' } },
  backOff:      { v: 2.6, min: 1.4, max: 3.0, group: 'spacing', about: 'step back when a target is nearer than this (blocks)', real: { key: 'backOff' } },
  weave:        { v: 0.9, min: 0, max: 1.5, group: 'spacing', about: 'how far it swerves sideways while closing in with no clear line', },
  rideHold:     { v: 1.8, min: 1.0, max: 3.0, group: 'spacing', about: 'nearest it goes to a target while on a horse (blocks)' },
  // --- strafing
  strafePeriod: { v: 22, min: 8, max: 70, group: 'strafe', about: 'ticks before it changes the side it circles to' },
  strafeJitter: { v: 15, min: 0, max: 40, group: 'strafe', about: 'random extra ticks on each side change (so it is not predictable)' },
  strafeSpeed:  { v: 0.8, min: 0.3, max: 1.0, group: 'strafe', about: 'how fast it circles a melee target (1 = full)' },
  // --- the bow
  useBow:       { v: 1, min: 0, max: 1, group: 'bow', about: 'carry and use a bow at all' },
  bowFrom:      { v: 9, min: 4, max: 16, group: 'bow', about: 'shoot a target farther than this (blocks); nearer, use the sword' },
  bowStrafe:    { v: 0.6, min: 0.1, max: 1.0, group: 'bow', about: 'how fast it sidesteps while drawing' },
  bowGap:       { v: 4, min: 0, max: 16, group: 'bow', about: 'ticks of rest between one shot and the next' },
  bowFlyers:    { v: 3, min: 2, max: 8, group: 'bow', about: 'shoot flying targets from this far (a sword cannot reach them)' },
  creeperBow:   { v: 9, min: 5, max: 13, group: 'bow', about: 'a creeper nearer than this is shot (and backed away from) rather than fought' },
  creeperAway:  { v: 7, min: 4, max: 10, group: 'bow', about: 'back away from a creeper that is nearer than this (blocks)' },
  // --- the shield
  useShield:    { v: 1, min: 0, max: 1, group: 'shield', about: 'carry and use a shield' },
  shieldRange:  { v: 3.7, min: 0, max: 8, group: 'shield', about: 'raise the shield between swings when a target is nearer than this (blocks); 0 = never', real: { key: 'shieldRange' } },
  // --- melee timing
  swingWait:    { v: 0, min: 0, max: 6, group: 'melee', about: 'extra ticks to wait after the weapon is ready (a fully charged hit hurts more)' },
  swingSlack:   { v: 0.3, min: -0.5, max: 0.5, group: 'melee', about: 'swing when the target is within weapon reach plus this (blocks)' },
  critJump:     { v: 0.2, min: 0, max: 1, group: 'melee', about: 'chance it jumps before a swing (a hit while falling is a critical)' },
  // --- staying alive
  retreatHp:    { v: 7.5, min: 4.5, max: 12, group: 'health', about: 'below this many hit points it breaks off and backs away behind the shield', real: { key: 'fleeHealth', add: -1.5 } },
  retreatTicks: { v: 40, min: 10, max: 120, group: 'health', about: 'how long it keeps away before it goes back in' },
  // --- choosing who to hit
  switchMargin: { v: 4, min: 0, max: 10, group: 'targeting', about: 'a nearer target must be this much nearer (blocks) before it changes target' },
  focusLow:     { v: 0.3, min: 0, max: 1, group: 'targeting', about: 'how much it prefers a hurt target over a near one' },
  // --- which weapon (each is a weight on the weapon's damage per second; 1 = as the damage numbers say)
  wSword:       { v: 1, min: 0.2, max: 4, group: 'weapon', about: 'how much it likes a sword (its damage a second is multiplied by this)' },
  wAxe:         { v: 1, min: 0.2, max: 4, group: 'weapon', about: 'how much it likes an axe' },
  wSpear:       { v: 1, min: 0.2, max: 4, group: 'weapon', about: 'how much it likes a spear (reach 4, slow recovery)' },
  wMace:        { v: 1, min: 0.2, max: 4, group: 'weapon', about: 'how much it likes a mace' },
  wTrident:     { v: 1, min: 0.2, max: 4, group: 'weapon', about: 'how much it likes a trident in the hand' },
  crowdAxe:     { v: 0, min: 0, max: 1.5, group: 'weapon', about: 'extra liking for an axe per extra enemy (a crowd)' },
  reachSpear:   { v: 0, min: 0, max: 2, group: 'weapon', about: 'extra liking for a spear against fast or far enemies (it hits from 4 blocks)' },
  xbowPref:     { v: 0.5, min: 0, max: 1, group: 'bow', about: 'with both a bow and a crossbow: above 0.5 it shoots the crossbow' },
  kiteMaxSpeed: { v: 0.3, min: 0.1, max: 0.45, group: 'health', about: 'it only backs away from enemies no faster than this (a baby zombie or a spider outruns it)' },
  // --- the horse
  useHorse:     { v: 0, min: 0, max: 1, group: 'horse', about: 'fight from a saddled horse (it must be ridden in; a hit knocks you off nothing, but the horse moves you)' },
};

/** Walking speed of mobs (the game's movement attribute) for when the entity does not say; a baby is faster. */
export const FOE_SPEED = { zombie: 0.23, husk: 0.23, drowned: 0.23, zombie_villager: 0.23, skeleton: 0.25, stray: 0.25, creeper: 0.25, spider: 0.3, cave_spider: 0.3, enderman: 0.3, witch: 0.25, pillager: 0.35, vindicator: 0.35, iron_golem: 0.25, blaze: 0.23, wither_skeleton: 0.25 };
export const speedOf = (type, baby = false) => (FOE_SPEED[String(type).replace('minecraft:', '')] ?? 0.25) * (baby ? 1.5 : 1);

export const KEYS = Object.keys(DOCTRINE);
export const defaults = () => Object.fromEntries(KEYS.map((k) => [k, DOCTRINE[k].v]));
const clampK = (k, v) => Math.min(DOCTRINE[k].max, Math.max(DOCTRINE[k].min, v));

/** Any object -> a full doctrine: unknown keys dropped, non-numbers defaulted, everything clamped; spacing kept sane (backing off starts inside the hold). */
export function norm(over) {
  const d = defaults();
  for (const k of KEYS) { const v = over?.[k]; if (typeof v === 'number' && Number.isFinite(v)) d[k] = clampK(k, v); }
  if (d.backOff > d.holdAt - 0.15) d.backOff = Math.max(DOCTRINE.backOff.min, d.holdAt - 0.15);
  return d;
}
export const flag = (v) => v > 0.5;

/** What the table sends to the lab (the brain holds no copy of it). */
export const table = () => Object.fromEntries(KEYS.map((k) => [k, { v: DOCTRINE[k].v, min: DOCTRINE[k].min, max: DOCTRINE[k].max, group: DOCTRINE[k].group, about: DOCTRINE[k].about, real: !!DOCTRINE[k].real }]));

/** The constants of the real survival fight (core/tunables.js keys) a doctrine changes: only those it has a `real` for and has moved off the default. */
export function realPolicy(d) {
  const out = {};
  for (const k of KEYS) {
    const r = DOCTRINE[k].real;
    if (r && Math.abs(d[k] - DOCTRINE[k].v) > 1e-9) out[r.key] = Math.round((d[k] + (r.add ?? 0)) * 1000) / 1000;
  }
  return out;
}

/** The old three personalities as doctrines (a show that is not the lab). */
export function fromStyle(style) {
  return norm({ bowFrom: style.bowFrom, strafePeriod: style.strafe, backOff: Math.max(1.4, style.close - 0.8) });
}

/** Where a fighter stands: walks in to `far`, backs off inside `near`. wr: weaponReach(). */
export function spacing(d, wr, riding) {
  const far = Math.max(2.2, Math.min(d.holdAt, wr.reach - 0.2));
  const near = riding ? Math.max(1.2, Math.min(d.rideHold, far - 0.2), wr.minReach + 0.2) : Math.max(wr.minReach + 0.25, Math.min(d.backOff, far - 0.2));
  return { far, near };
}

/** Whether to shoot rather than swing. */
export function shootNow(d, { hasBow, arrows, clear, dist, flying, creeper, nextShotOk }) {
  if (!flag(d.useBow) || !hasBow || arrows <= 0 || !clear || !nextShotOk) return false;
  return dist > d.bowFrom || (flying && dist > d.bowFlyers) || (creeper && dist < d.creeperBow);
}

/** The target to hit: the current one unless another is clearly better. foes: [{ id, dist, hp }] (any order). Returns an id. */
export function pickTarget(d, foes, currentId) {
  if (!foes.length) return null;
  const score = (f) => f.dist + d.focusLow * (f.hp ?? 10) / 2;
  const best = [...foes].sort((a, b) => score(a) - score(b))[0];
  const cur = foes.find((f) => f.id === currentId);
  if (!cur) return best.id;
  return score(cur) > score(best) + d.switchMargin ? best.id : cur.id;
}

/** A change from a base doctrine in words, largest first: "holdAt 2.8 -> 2.3 (walk in until ...)". */
export function describeChange(d, base = defaults()) {
  return KEYS.filter((k) => Math.abs(d[k] - base[k]) > 1e-9).map((k) => {
    const span = DOCTRINE[k].max - DOCTRINE[k].min;
    return { k, from: base[k], to: d[k], size: Math.abs(d[k] - base[k]) / span, about: DOCTRINE[k].about };
  }).sort((a, b) => b.size - a.size).map((c) => `${c.k} ${+c.from.toFixed(2)} -> ${+c.to.toFixed(2)} (${c.about})`);
}

// ---------- choosing the weapon ----------

const DPS = { sword: 1, axe: 1, spear: 1, mace: 1, trident: 1 };
export const kindOf = (id) => { const k = String(id ?? '').replace('minecraft:', ''); return /sword/.test(k) ? 'sword' : /axe/.test(k) ? 'axe' : /spear/.test(k) ? 'spear' : k === 'mace' ? 'mace' : k === 'trident' ? 'trident' : null; };

/**
 * The weapon to hold. items: [{ id, rate }] where rate is its damage a second (from the game's own numbers); ctx: { foes, fast, far }.
 * Score = rate x the doctrine's weight for its kind, with the situation's extra liking (axe in a crowd, spear against fast or far enemies). Returns an id or null (bare hands).
 */
export function pickWeapon(d, items, ctx = {}) {
  let best = null, bs = -1;
  for (const it of items) {
    const k = kindOf(it.id);
    if (!k) continue;
    let w = d[`w${k[0].toUpperCase()}${k.slice(1)}`] ?? DPS[k];
    if (k === 'axe') w *= 1 + d.crowdAxe * Math.max(0, (ctx.foes ?? 1) - 1) / 3;
    if (k === 'spear' && (ctx.fast || ctx.far)) w *= 1 + d.reachSpear;
    const sc = it.rate * w;
    if (sc > bs) { bs = sc; best = it.id; }
  }
  return best;
}

// ---------- the scenarios a lab bout is played in ----------
// What the bot meets and wears: survival-like, so a doctrine is judged on what it will really face. The brain picks one per pair (both doctrines play the same).

/**
 * The gear a doctrine takes into a bout. scn (picked by the brain): { armor, weapon (tier), weapons: ['sword', ...] (what it HAS: may be nothing), ranged: 'none'|'bow'|'crossbow'|'both',
 * shield, horse (one is available) }. The doctrine decides which of what it has it is willing to use (the use* switches). (core/colosseum.js LOADOUT shape.)
 */
export function labLoad(scn, d) {
  const r = scn.ranged ?? 'none', willing = flag(d.useBow);
  return {
    armor: scn.armor ?? 'iron', weapon: scn.weapon ?? 'iron', weapons: [...(scn.weapons ?? ['sword'])], apples: 0, enchant: false, wench: null, bench: null, aench: null,
    bow: willing && (r === 'bow' || r === 'both'), crossbow: willing && (r === 'crossbow' || r === 'both'),
    shield: !!scn.shield && flag(d.useShield), mount: !!scn.horse && flag(d.useHorse),
  };
}
