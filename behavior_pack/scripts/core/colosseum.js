// The colosseum (game/colosseum.js): the pure parts. What a command means, which mobs there are, how a round is scored.

/** Mobs by id (no namespace). Anything else typed is tried as an id anyway. */
export const MOB_LIST = [
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'endermite', 'silverfish',
  'witch', 'slime', 'magma_cube', 'blaze', 'ghast', 'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'zombie_pigman', 'pillager', 'vindicator', 'evoker', 'vex', 'ravager', 'phantom',
  'guardian', 'elder_guardian', 'shulker', 'warden', 'breeze', 'creaking', 'wither', 'ender_dragon', 'iron_golem', 'snow_golem', 'wolf', 'polar_bear', 'panda', 'bee', 'goat', 'llama',
  'fox', 'dolphin', 'cat', 'ocelot', 'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'mule', 'zombie_horse', 'skeleton_horse', 'camel', 'villager', 'wandering_trader',
  'squid', 'glow_squid', 'cod', 'salmon', 'pufferfish', 'tropical_fish', 'axolotl', 'turtle', 'frog', 'sniffer', 'armadillo', 'bat', 'parrot', 'strider', 'allay', 'copper_golem',
];
const BOSSES = new Set(['wither', 'ender_dragon', 'warden', 'elder_guardian', 'ravager']);
/** Mobs that need water under them. */
export const AQUATIC = new Set(['guardian', 'elder_guardian', 'squid', 'glow_squid', 'dolphin', 'cod', 'salmon', 'pufferfish', 'tropical_fish', 'axolotl']);
/** Mobs that fly: a bot shoots them (a sword does not reach). */
export const FLYERS = new Set(['ghast', 'phantom', 'blaze', 'vex', 'bat', 'bee', 'allay', 'parrot', 'breeze', 'ender_dragon']);

const ALIASES = {
  golem: 'iron_golem', 'iron golem': 'iron_golem', dragon: 'ender_dragon', 'ender dragon': 'ender_dragon', pigman: 'zombie_pigman', 'zombie pigman': 'zombie_pigman', 'zombified piglin': 'zombie_pigman',
  'snow golem': 'snow_golem', snowman: 'snow_golem', 'polar bear': 'polar_bear', 'wither skeleton': 'wither_skeleton', 'cave spider': 'cave_spider', 'magma cube': 'magma_cube', 'elder guardian': 'elder_guardian',
  'zombie villager': 'zombie_villager', 'piglin brute': 'piglin_brute', 'glow squid': 'glow_squid', 'tropical fish': 'tropical_fish', 'wandering trader': 'wandering_trader', 'skeleton horse': 'skeleton_horse', 'zombie horse': 'zombie_horse',
};

/** "iron golem", "minecraft:zombie", "Creeper" -> { id: 'iron_golem', known: true } (a prefix that fits one mob counts); null for an empty name. */
export function resolveMob(words) {
  const raw = String(Array.isArray(words) ? words.join(' ') : words ?? '').toLowerCase().replace(/^minecraft:/, '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  if (ALIASES[raw]) return { id: ALIASES[raw], known: true };
  const id = raw.replace(/ /g, '_');
  if (MOB_LIST.includes(id)) return { id, known: true };
  const part = MOB_LIST.filter((m) => m.startsWith(id));
  if (part.length === 1) return { id: part[0], known: true };
  if (!/^[a-z0-9_]+$/.test(id)) return null;
  return { id, known: false };
}

/**
 * `colosseum ...` (the words after it) -> what to do:
 *   { cmd: 'help' | 'list' | 'stop' | 'clear' } or { cmd: 'show', mode: 'mobs' | 'bots', mob, count, team, rounds }.
 * `bots [team N] [rounds N]` is team against team (team = bots a side, default 1); anything else is a mob (`zombie 5`, `iron golem 2`, `random`)
 * for a team of bots (default 2) to fight; bosses are one at a time.
 */
export function parseShow(args) {
  let a = args.map((s) => String(s).toLowerCase());
  if (!a.length || a[0] === 'help') return { cmd: 'help' };
  if (['list', 'stop', 'clear'].includes(a[0])) return { cmd: a[0] };
  // key=value words are the gear (armor=iron weapon=netherite weapons=sword,axe bow=off shield=off enchant=on, blue.armor=... for the blue team)
  const opts = {};
  a = a.filter((w) => { const m = /^([a-z.]+)=(.*)$/.exec(w); if (!m) return true; opts[m[1]] = m[2]; return false; });
  const gear = gearFrom(opts, 'red'), blueGear = gearFrom(opts, 'blue', gear.load);
  const warn = [...gear.warn, ...blueGear.warn];
  const take = (key) => { const i = a.indexOf(key); if (i < 0) return null; const n = Number(a[i + 1]); a = a.filter((_, j) => j !== i && j !== i + 1); return Number.isFinite(n) ? n : null; };
  const rounds = take('rounds'), team = take('team'), bouts = take('bouts');
  if (a[0] === 'lab') {
    // the learning loop: `lab [bouts N]` runs, `lab report|apply|reset|status` talk to the brain's lab
    if (['report', 'apply', 'reset', 'status'].includes(a[1])) return { cmd: 'lab', sub: a[1] };
    return { cmd: 'show', mode: 'mobs', mob: { id: 'zombie', known: true }, count: 1, team: 1, rounds: 9999, park: truth(opts.park, true), gear: gear.load, blueGear: blueGear.load, warn, lab: { bouts: Math.max(1, Math.min(9999, Math.floor(bouts ?? 9999))) } };
  }
  const out = { cmd: 'show', mode: 'mobs', mob: null, count: 1, team: 2, rounds: Math.max(1, Math.min(9, Math.floor(rounds ?? 3))), park: truth(opts.park, true), water: truth(opts.water, false), foeArmor: ARMOR_TIERS.includes(opts.foearmor) ? opts.foearmor : 'none', gear: gear.load, blueGear: blueGear.load, warn };
  if (a[0] === 'bots' || a[0] === 'bot') {
    out.mode = 'bots'; out.team = Math.max(1, Math.min(3, Math.floor(team ?? Number(a[1]) ?? 1) || 1));
    return out;
  }
  out.team = Math.max(1, Math.min(3, Math.floor(team ?? 2)));
  const nums = a.filter((w) => /^\d+$/.test(w));
  const words = a.filter((w) => !/^\d+$/.test(w) && w !== 'x');
  if (words.length === 1 && words[0] === 'random') out.mob = { id: MOB_LIST[Math.floor(Math.random() * MOB_LIST.length)], known: true, random: true };
  else out.mob = resolveMob(words);
  if (!out.mob) return { cmd: 'help' };
  const want = nums.length ? Number(nums[0]) : 1;
  out.count = BOSSES.has(out.mob.id) ? 1 : Math.max(1, Math.min(12, Math.floor(want)));
  return out;
}

/** A round's result from who is left: 'bots' | 'foes' | 'draw'. */
export function roundWinner({ botsLeft, foesLeft, timedOut }) {
  if (botsLeft > 0 && foesLeft === 0) return 'bots';
  if (foesLeft > 0 && botsLeft === 0) return 'foes';
  if (timedOut) return botsLeft === foesLeft ? 'draw' : botsLeft > foesLeft ? 'bots' : 'foes';
  return botsLeft === 0 && foesLeft === 0 ? 'draw' : '';
}

/** Hit points (of 20) at which a bot is knocked out and taken to the bench: a fight goes on to the last bot and nobody has to die. */
export const KO_HP = 4;

/** A bot's fighting style, drawn per bot so a match has variety: how early it takes to the bow, how close it will stand, how often it changes side. */
export function personality(rnd = Math.random) {
  const styles = [
    { name: 'archer', bowFrom: 6, close: 3.4, strafe: 22 },
    { name: 'brawler', bowFrom: 14, close: 1.8, strafe: 40 },
    { name: 'dancer', bowFrom: 10, close: 2.6, strafe: 12 },
  ];
  return styles[Math.floor(rnd() * styles.length)];
}

// ---------- gear ----------

export const ARMOR_TIERS = ['none', 'leather', 'chain', 'iron', 'gold', 'diamond', 'netherite'];
export const WEAPON_TIERS = ['wood', 'stone', 'iron', 'gold', 'diamond', 'netherite'];
export const WEAPON_KINDS = ['sword', 'axe', 'spear', 'mace', 'trident'];
const ARMOR_PREFIX = { leather: 'leather', chain: 'chainmail', iron: 'iron', gold: 'golden', diamond: 'diamond', netherite: 'netherite' };
const TIER_PREFIX = { wood: 'wooden', stone: 'stone', iron: 'iron', gold: 'golden', diamond: 'diamond', netherite: 'netherite' };
const TIERED = new Set(['sword', 'axe', 'spear']);

export const LOADOUT_DEFAULT = { armor: 'diamond', weapon: 'diamond', weapons: ['sword', 'axe', 'spear'], bow: true, crossbow: false, shield: true, enchant: false, apples: 4, mount: false, wench: null, bench: null, aench: null };

// Enchantments: what each kind of item takes (id -> top level), and the ones that exclude each other.
export const ENCH_MELEE = { sharpness: 5, smite: 5, bane_of_arthropods: 5, knockback: 2, fire_aspect: 2, looting: 3, unbreaking: 3, mending: 1 };
export const ENCH_MACE = { density: 5, breach: 4, wind_burst: 3, fire_aspect: 2, unbreaking: 3, mending: 1 };
export const ENCH_TRIDENT = { impaling: 5, loyalty: 3, channeling: 1, unbreaking: 3, mending: 1 };
export const ENCH_XBOW = { quick_charge: 3, piercing: 4, multishot: 1, unbreaking: 3, mending: 1 };
export const ENCH_BOW = { power: 5, punch: 2, flame: 1, infinity: 1, unbreaking: 3, mending: 1 };
export const ENCH_ARMOR = { protection: 4, fire_protection: 4, blast_protection: 4, projectile_protection: 4, thorns: 3, feather_falling: 4, unbreaking: 3, mending: 1 };
const EXCLUSIVE = [['sharpness', 'smite', 'bane_of_arthropods'], ['protection', 'fire_protection', 'blast_protection', 'projectile_protection'], ['infinity', 'mending'], ['density', 'breach']];
const WEAPON_ANY = { ...ENCH_MELEE, ...ENCH_MACE, ...ENCH_TRIDENT };
const maxOf = (m) => m;

/** "sharpness:5,fire_aspect" -> [['sharpness', 5], ['fire_aspect', 2]] (level defaults to the top, is clamped to it); unknown names go to warn. */
export function parseEnch(str, table, warn = [], label = 'enchantment') {
  if (str === undefined) return null;
  if (str === 'none' || str === '') return [];
  const out = [];
  for (const tok of str.split(',').map((t) => t.trim()).filter(Boolean)) {
    const [id, lv] = tok.split(':');
    const top = maxOf(table)[id];
    if (!top) { warn.push(`${label} "${id}" (try ${Object.keys(table).join(', ')})`); continue; }
    const level = Math.max(1, Math.min(top, Math.floor(Number(lv)) || top));
    if (!out.some(([i]) => i === id)) out.push([id, level]);
  }
  return out;
}

/** A wanted list cut down to what this item takes, and to one of each exclusive group (the first named). */
export function fitEnch(list, allowed) {
  if (!list) return undefined;
  const out = [];
  for (const [id, lv] of list) {
    if (!allowed[id]) continue;
    if (EXCLUSIVE.some((g) => g.includes(id) && out.some(([o]) => g.includes(o)))) continue;
    out.push([id, Math.min(lv, allowed[id])]);
  }
  return out.length ? out : undefined;
}

const ALIAS = { wooden: 'wood', golden: 'gold', chainmail: 'chain', nothing: 'none', off: 'none', no: 'none' };
const truth = (v, d) => (v === undefined ? d : /^(on|yes|true|1)$/.test(v) ? true : /^(off|no|false|0)$/.test(v) ? false : d);

/** A loadout from key=value options for a team ('red', or 'blue' = the red one with `blue.` overrides). { load, warn }. */
export function gearFrom(opts, team = 'red', base = null) {
  const warn = [];
  const load = { ...LOADOUT_DEFAULT, weapons: [...LOADOUT_DEFAULT.weapons], ...(base ?? {}) };
  if (base) load.weapons = [...base.weapons];
  const get = (k) => (team === 'blue' ? opts[`blue.${k}`] ?? (base ? undefined : opts[k]) : opts[k]);
  const armor = get('armor');
  if (armor !== undefined) { const t = ALIAS[armor] ?? armor; if (ARMOR_TIERS.includes(t)) load.armor = t; else warn.push(`armor "${armor}" (try ${ARMOR_TIERS.join(', ')})`); }
  const weapon = get('weapon');
  if (weapon !== undefined) { const t = ALIAS[weapon] ?? weapon; if (WEAPON_TIERS.includes(t)) load.weapon = t; else warn.push(`weapon tier "${weapon}" (try ${WEAPON_TIERS.join(', ')})`); }
  const weapons = get('weapons');
  if (weapons !== undefined) {
    const ws = weapons === 'none' ? [] : weapons.split(',').map((w) => w.trim()).filter(Boolean);
    const ok = ws.filter((w) => WEAPON_KINDS.includes(w)), bad = ws.filter((w) => !WEAPON_KINDS.includes(w));
    if (bad.length) warn.push(`weapons ${bad.join(', ')} (try ${WEAPON_KINDS.join(', ')})`);
    load.weapons = [...new Set(ok)];
  }
  load.bow = truth(get('bow'), load.bow);
  load.crossbow = truth(get('crossbow'), load.crossbow);
  load.shield = truth(get('shield'), load.shield);
  load.enchant = truth(get('enchant'), load.enchant);
  load.mount = truth(get('mount'), load.mount);
  const we = parseEnch(get('weaponench'), WEAPON_ANY, warn, 'weapon enchantment'); if (we) load.wench = we;
  const be = parseEnch(get('bowench'), ENCH_BOW, warn, 'bow enchantment'); if (be) load.bench = be;
  const ae = parseEnch(get('armorench'), ENCH_ARMOR, warn, 'armor enchantment'); if (ae) load.aench = ae;
  const ap = Number(get('apples'));
  if (Number.isFinite(ap) && get('apples') !== undefined) load.apples = Math.max(0, Math.min(16, Math.floor(ap)));
  return { load, warn };
}

/** Mobs that put armor on (the rest ignore a helmet given to them). */
export const ARMOR_WEARERS = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'piglin', 'piglin_brute', 'zombie_pigman']);
/** The four items of a tier for `replaceitem entity ... slot.armor.<slot>`: { head, chest, legs, feet } (null for 'none'). */
export function armorItems(tier) {
  const pre = ARMOR_PREFIX[tier];
  return pre ? { head: `${pre}_helmet`, chest: `${pre}_chestplate`, legs: `${pre}_leggings`, feet: `${pre}_boots` } : null;
}

/** The item ids a loadout's melee weapons are (best first is the driver's choice). */
export function meleeIds(load) {
  return load.weapons.map((k) => (TIERED.has(k) ? `${TIER_PREFIX[load.weapon]}_${k}` : k));
}

/** A loadout as the arena kit() arguments: { slots: [[slot, id, n, enchants?]], worn: { Head: [id, enchants?], ... } }. */
export function loadoutKit(load) {
  const slots = [];
  const wlist = load.wench ?? (load.enchant ? [['sharpness', 5], ['unbreaking', 3]] : null);
  const blist = load.bench ?? (load.enchant ? [['power', 5], ['unbreaking', 3]] : null);
  const alist = load.aench ?? (load.enchant ? [['protection', 4], ['unbreaking', 3]] : null);
  let i = 0;
  for (const id of meleeIds(load)) slots.push([i++, id, 1, fitEnch(wlist, id === 'mace' ? ENCH_MACE : id === 'trident' ? ENCH_TRIDENT : ENCH_MELEE)]);
  if (load.crossbow) slots.push([i++, 'crossbow', 1, fitEnch(load.xench ?? null, ENCH_XBOW)]);
  if (load.bow) slots.push([i++, 'bow', 1, fitEnch(blist, ENCH_BOW)]);
  if (load.bow || load.crossbow) {
    if (!load.bow || !(blist ?? []).some(([id]) => id === 'infinity')) slots.push([i++, 'arrow', 64], [i++, 'arrow', 64]);
    else slots.push([i++, 'arrow', 1]);
  }
  if (load.apples > 0) slots.push([i++, 'golden_apple', load.apples]);
  const worn = {};
  if (load.armor !== 'none') {
    const pre = ARMOR_PREFIX[load.armor];
    for (const [slot, piece] of [['Head', 'helmet'], ['Chest', 'chestplate'], ['Legs', 'leggings'], ['Feet', 'boots']]) worn[slot] = [`${pre}_${piece}`, fitEnch(alist, slot === 'Feet' ? ENCH_ARMOR : { ...ENCH_ARMOR, feather_falling: 0 })];
  }
  if (load.shield) worn.Offhand = ['shield'];
  return { slots, worn };
}

/** One line for chat. */
export function describeLoadout(load) {
  const w = [...meleeIds(load).map((x) => x.replace(/_/g, ' ')), ...(load.bow ? ['bow'] : []), ...(load.crossbow ? ['crossbow'] : [])];
  const nice = (l) => l.map(([id, lv]) => `${id.replace(/_/g, ' ')} ${lv}`).join(', ');
  const ench = [load.wench ? `weapons: ${nice(load.wench) || 'plain'}` : '', load.bench ? `bow: ${nice(load.bench) || 'plain'}` : '', load.aench ? `armor: ${nice(load.aench) || 'plain'}` : ''].filter(Boolean);
  return `${load.armor === 'none' ? 'no armor' : `${load.armor} armor`}${load.shield ? ' + shield' : ''}, ${w.join(', ') || 'bare hands'}${load.enchant && !ench.length ? ', enchanted' : ''}${ench.length ? `, enchanted (${ench.join('; ')})` : ''}${load.mount ? ', on horseback' : ''}`;
}
