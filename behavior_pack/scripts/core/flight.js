// Reading a run back: what went wrong, from samples taken every second or so. Pure (unit-tested);
// game/flight.js collects the samples and prints what this finds.
//
// A sample: { t (tick), x, y, z, hp, food, step (the plan's step), mode, task, busy (the motor has
// a path), inv (a short signature of the pack), under (underground), night }.

/** Blocks walked along the samples (the path's length), and how far from the first the last is. */
export function pathAndNet(samples) {
  let path = 0;
  for (let i = 1; i < samples.length; i++) path += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y, samples[i].z - samples[i - 1].z);
  const a = samples[0], b = samples[samples.length - 1];
  return { path, net: a && b ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : 0 };
}

/**
 * What the last `windowS` seconds look like, or null if nothing's wrong:
 *   frozen    in place (within 2 blocks), the pack and the plan unchanged, not asleep or waiting on
 *             purpose: nothing's happening
 *   pacing    walked 30+ blocks and ended up within 5 of where it started, the pack unchanged:
 *             back and forth
 *   spinning  the plan changed 8+ times with the pack unchanged and nowhere gone
 *   hungry    food at 0 and health dropping with nothing eaten
 * windowS: 60 by default. Waiting steps (wait_smelt, shelter, rest, night at home) never count.
 */
export function diagnose(samples, { windowS = 60, sampleS = 1 } = {}) {
  const n = Math.round(windowS / sampleS);
  if (samples.length < n * 0.8) return null;
  const w = samples.slice(-n);
  const patient = new Set(['wait_smelt', 'shelter', 'rest', 'go_home', 'done', 'sleep']);
  if (w.some((s) => patient.has(s.step) || s.sleeping)) return null;
  const same = (k) => w.every((s) => s[k] === w[0][k]);
  const { path, net } = pathAndNet(w);
  const steps = w.reduce((c, s, i) => c + (i && s.step !== w[i - 1].step ? 1 : 0), 0);
  if (same('inv') && net < 2 && path < 3 && !w.some((s) => s.mode === 'fight' || s.mode === 'flee')) {
    return { kind: 'frozen', why: `in place for ${windowS} s (${net.toFixed(1)} blocks), pack unchanged, step ${w[w.length - 1].step ?? '-'}` };
  }
  if (same('inv') && path >= 30 && net < 5 && !w.some((s) => s.mode === 'flee')) {
    return { kind: 'pacing', why: `walked ${Math.round(path)} blocks and ended ${net.toFixed(1)} from where it started, pack unchanged` };
  }
  if (same('inv') && steps >= 8 && net < 12) {
    return { kind: 'spinning', why: `the plan changed ${steps} times in ${windowS} s with nothing gained` };
  }
  const last = w[w.length - 1];
  if (last.food === 0 && w[0].hp - last.hp >= 3 && same('inv')) {
    return { kind: 'starving', why: `food 0, health ${w[0].hp} -> ${last.hp}, nothing eaten` };
  }
  return null;
}

/** The plan's steps in order, runs of the same one folded: "get_stone x4 > craft > get_stone x3". */
export function stepRuns(samples) {
  const out = [];
  for (const s of samples) {
    const k = s.step ?? '-';
    if (out.length && out[out.length - 1].k === k) out[out.length - 1].n++;
    else out.push({ k, n: 1, t: s.t });
  }
  return out;
}

/** The runs as one line, newest last, with the seconds each ran. */
export function stepLine(samples, sampleS = 1, maxRuns = 14) {
  return stepRuns(samples).slice(-maxRuns).map((r) => `${r.k} ${Math.round(r.n * sampleS)}s`).join(' > ');
}

/** What changed between two pack signatures ("cobblestone +12, oak_log -3"): signature = { id: n }. */
export function invDiff(a = {}, b = {}) {
  const out = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[id] ?? 0) - (a[id] ?? 0);
    if (d) out.push(`${id} ${d > 0 ? '+' : ''}${d}`);
  }
  return out.join(', ') || 'nothing';
}

/** One character for a block in the surroundings picture: '.' air, '#' solid, 'o' ore, '~' water, 'L' lava, 'T' log, 'l' leaves, 'X' table/furnace/chest/door/bed, 't' torch. */
export function blockChar(id) {
  const b = String(id ?? 'air').replace(/^minecraft:/, '');
  if (b === 'air' || b === 'cave_air' || b === '') return '.';
  if (b === 'lava') return 'L';
  if (b === 'water') return '~';
  if (/_ore$/.test(b)) return 'o';
  if (/(^|_)(log|wood|stem)$/.test(b)) return 'T';
  if (/leaves$/.test(b)) return 'l';
  if (/torch/.test(b)) return 't';
  if (/^(crafting_table|furnace|lit_furnace|chest|barrel|.*_door|.*bed|bed)$/.test(b)) return 'X';
  if (/^(short_grass|tall_grass|fern|large_fern|vine|snow_layer|dead_bush|.*flower|dandelion|poppy|leaf_litter|glow_lichen|sweet_berry_bush)$/.test(b)) return ',';
  return '#';
}

/** Pack changes not worth a line each: building stone and dirt from mining, junk drops. */
export const LEDGER_NOISE = /^(cobblestone|stone|dirt|grass_block|andesite|diorite|granite|gravel|sand|sandstone|deepslate|cobbled_deepslate|tuff|netherrack|rotten_flesh|leaf_litter|oak_leaves|spruce_leaves|birch_leaves|dark_oak_leaves|jungle_leaves|acacia_leaves|flint|bone|string|spider_eye|gunpowder|arrow|feather)$/;
