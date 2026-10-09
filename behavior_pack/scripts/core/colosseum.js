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
  const take = (key) => { const i = a.indexOf(key); if (i < 0) return null; const n = Number(a[i + 1]); a = a.filter((_, j) => j !== i && j !== i + 1); return Number.isFinite(n) ? n : null; };
  const rounds = take('rounds'), team = take('team');
  const out = { cmd: 'show', mode: 'mobs', mob: null, count: 1, team: 2, rounds: Math.max(1, Math.min(9, Math.floor(rounds ?? 3))) };
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
