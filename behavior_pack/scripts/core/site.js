// Is this a good place for the house, and how long would it take to get it ready? Pure (tested).
//
// Not "perfectly flat or nothing": a bump to dig, a dip to fill, a small tree in the way (free
// logs), our own crafting table or furnace (just move them) are all fine if the clearing is
// quick. Water, lava, holes 3+ deep and anyone's build are not. Grassy plains and ordinary
// forests are preferred; dense forest, swamp, desert, snow and shore are not.
import { chooseTool } from './costs.js';
import { isLog } from './recipes.js';
import { traitsOf } from './biomes.js';

export const BUILD_S = 170; // placing ~120 blocks (the house with its chest room) from the middle of each room
const SOFT = /^(air|short_grass|tall_grass|fern|large_fern|dead_bush|deadbush|snow_layer|vine|.*_flower|dandelion|poppy|.*_tulip|azure_bluet|allium|blue_orchid|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush|bush|leaf_litter|wildflowers|pink_petals|short_dry_grass|tall_dry_grass|firefly_bush|moss_carpet)$/;
const GROUND = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mycelium|sand|red_sand|gravel|snow|stone|andesite|diorite|granite|tuff|clay|mud|moss_block|dirt_with_roots)$/;
const STATION = /^(crafting_table|furnace|lit_furnace)$/;
const PLACE_S = 0.8;

/**
 * cells: [{ id, part: 'clear' | 'foot', below?: id, below2?: id }]
 *   clear: the room's volume (floor level up to the roof); foot: the ground under the floor
 *   (below/below2: what's under it, for filling a dip)
 * returns { ok, seconds, logs, moves, reason }
 */
export function siteWork(cells, inv = {}) {
  let seconds = 0, logs = 0, moves = 0;
  const brk = (id) => (chooseTool(id, inv, { needDrop: false })?.seconds ?? 3) + 0.3; // + aim and swing
  for (const c of cells) {
    const id = c.id ?? 'air';
    if (/water|lava/.test(id)) return { ok: false, reason: 'water' };
    if (c.part === 'clear') {
      if (SOFT.test(id)) { if (id !== 'air') seconds += 0.2; continue; }
      if (/leaves$/.test(id)) { seconds += brk(id); continue; }
      if (isLog(id)) { seconds += brk(id); logs++; continue; }
      if (STATION.test(id)) { seconds += brk(id) + 2; moves++; continue; } // ours: pick it up, it goes inside
      if (GROUND.test(id)) { seconds += brk(id); continue; }
      return { ok: false, reason: `built (${id})` };
    }
    // Under the floor: solid ground, or a dip we fill (at most 2 deep).
    if (!SOFT.test(id)) continue;
    if (!SOFT.test(c.below ?? 'stone')) { seconds += PLACE_S; continue; }
    if (!SOFT.test(c.below2 ?? 'stone')) { seconds += 2 * PLACE_S; continue; }
    return { ok: false, reason: 'hole' };
  }
  return { ok: true, seconds, logs, moves };
}

/** Seconds added (or taken off, for good land) for the biome: where a first house belongs. */
export function biomeCost(id) {
  const s = String(id ?? '').replace(/^minecraft:/, '');
  if (!s) return 0;
  if (/ocean|river|beach|shore/.test(s)) return 60;
  if (/roofed|dark_forest|jungle|swamp|mangrove|pale_garden/.test(s)) return 40; // dense, dark, wet
  if (/desert|mesa|badlands|ice|snow|frozen|peaks|slopes|mushroom/.test(s)) return 30;
  if (/plains|meadow|flower_forest|cherry|savanna/.test(s)) return -25; // open grass: the classic
  if (/forest|birch/.test(s)) return -15; // ordinary forest: wood right there
  const t = traitsOf(s);
  return t.land ? 0 : 60;
}

/**
 * Total score (lower is better) for a site: clearing work, the walk there, the biome, and
 * whether it can all be done before dark (secondsLeft of daylight; Infinity to ignore).
 */
export function siteScore(work, { dist = 0, biome = null, secondsLeft = Infinity } = {}) {
  if (!work.ok) return Infinity;
  let s = work.seconds + dist / 4.3 + biomeCost(biome) - Math.min(work.logs, 6) * 1.5;
  if (work.seconds + BUILD_S > secondsLeft) s += 500; // wouldn't be done by dusk: only if nothing else
  return s;
}
