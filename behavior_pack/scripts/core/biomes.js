// What a biome is good for, from its id. Pure (unit-tested).
//
// The bot uses this to know where to look: sheep and cows spawn on grassy biomes (plains,
// meadows, forests), not in deserts, oceans or on mushroom islands; trees are thick in forests
// and absent on plains-by-the-sea islands; bare stone shows on mountains and stony shores.
// Bedrock ids differ from Java's in places (roofed_forest = dark forest, extreme_hills =
// windswept hills, ice_plains = snowy plains, mega_taiga = old growth taiga, mesa = badlands),
// so ids are matched by pattern, most specific first.

/** @typedef {{ land: boolean, trees: number, sheep: number, food: number, stone: number, danger: number }} Traits */

/** @type {Array<[RegExp, Traits]>} trees/sheep/food/stone: 0 none .. 3 plenty; danger: extra hostile risk */
const TABLE = [
  [/caves|deep_dark/,                           { land: true,  trees: 0, sheep: 0, food: 0, stone: 3, danger: 2 }],
  [/mushroom/,                                  { land: true,  trees: 0, sheep: 0, food: 2, stone: 0, danger: -1 }], // mooshrooms, no hostiles
  [/ocean|deep/,                                { land: false, trees: 0, sheep: 0, food: 0, stone: 0, danger: 1 }],  // drowned
  [/river/,                                     { land: false, trees: 0, sheep: 0, food: 0, stone: 0, danger: 0 }],
  [/stone_beach|stony_shore/,                   { land: true,  trees: 0, sheep: 0, food: 0, stone: 3, danger: 0 }],
  [/beach/,                                     { land: true,  trees: 0, sheep: 0, food: 0, stone: 0, danger: 0 }],
  [/desert/,                                    { land: true,  trees: 0, sheep: 0, food: 0, stone: 1, danger: 1 }],  // husks
  [/mesa|badlands/,                             { land: true,  trees: 0, sheep: 0, food: 0, stone: 2, danger: 0 }],
  [/jagged|frozen_peaks|stony_peaks|snowy_slopes/, { land: true, trees: 0, sheep: 0, food: 0, stone: 3, danger: 1 }],
  [/ice_plains_spikes|ice_spikes/,              { land: true,  trees: 0, sheep: 0, food: 0, stone: 0, danger: 1 }],
  [/ice_plains|snowy_plains|snowy_tundra/,      { land: true,  trees: 1, sheep: 1, food: 1, stone: 0, danger: 1 }],  // strays
  [/swamp/,                                     { land: true,  trees: 2, sheep: 0, food: 1, stone: 0, danger: 1 }],  // slimes, witches
  [/jungle/,                                    { land: true,  trees: 3, sheep: 0, food: 2, stone: 0, danger: 0 }],
  [/roofed_forest|dark_forest|pale_garden/,     { land: true,  trees: 3, sheep: 1, food: 1, stone: 0, danger: 2 }],  // dark in the day
  [/cherry/,                                    { land: true,  trees: 2, sheep: 2, food: 2, stone: 1, danger: 0 }],
  [/grove/,                                     { land: true,  trees: 2, sheep: 0, food: 0, stone: 1, danger: 1 }],
  [/meadow/,                                    { land: true,  trees: 1, sheep: 3, food: 3, stone: 1, danger: 0 }],
  [/extreme_hills|windswept|mountain/,          { land: true,  trees: 1, sheep: 2, food: 2, stone: 3, danger: 0 }],
  [/savanna/,                                   { land: true,  trees: 1, sheep: 2, food: 2, stone: 0, danger: 0 }],
  [/taiga/,                                     { land: true,  trees: 3, sheep: 2, food: 2, stone: 1, danger: 0 }],
  [/forest|birch/,                              { land: true,  trees: 3, sheep: 2, food: 2, stone: 0, danger: 0 }],
  [/plains/,                                    { land: true,  trees: 1, sheep: 3, food: 3, stone: 0, danger: 0 }],
];
const UNKNOWN = { land: true, trees: 1, sheep: 1, food: 1, stone: 1, danger: 0 };

/** @returns {Traits} */
export function traitsOf(id) {
  const s = String(id ?? '').replace(/^minecraft:/, '');
  for (const [re, t] of TABLE) if (re.test(s)) return t;
  return UNKNOWN;
}

/** Friendly name: "minecraft:roofed_forest" -> "dark forest". */
export function biomeName(id) {
  const s = String(id ?? '').replace(/^minecraft:/, '');
  const alias = { roofed_forest: 'dark forest', extreme_hills: 'windswept hills', ice_plains: 'snowy plains', mega_taiga: 'old growth taiga', mesa: 'badlands', swampland: 'swamp', stone_beach: 'stony shore', mushroom_island: 'mushroom island', cold_taiga: 'snowy taiga' };
  return alias[s] ?? s.replace(/_/g, ' ');
}

/** What we're after, as a trait: log -> trees, sheep -> sheep, food -> food, stone -> stone. */
const TRAIT = { log: 'trees', trees: 'trees', sheep: 'sheep', food: 'food', stone: 'stone', land: 'land' };

/** How good a biome is for what we want, 0..3 (land counts 3 for any land biome). */
export function wantScore(id, want) {
  const t = traitsOf(id);
  const k = TRAIT[want];
  if (!k) return 0;
  if (k === 'land') return t.land ? 3 : 0;
  return t.land ? t[k] : 0;
}

/**
 * Biomes to search the world seed for, best first, when nothing near has what we want (used
 * sparingly: a seed search is a heavy call). Bedrock ids.
 */
export const SEARCH = {
  trees: ['minecraft:forest', 'minecraft:birch_forest', 'minecraft:taiga', 'minecraft:plains'],
  sheep: ['minecraft:plains', 'minecraft:meadow', 'minecraft:forest'],
  food: ['minecraft:plains', 'minecraft:forest'],
  stone: ['minecraft:extreme_hills', 'minecraft:stone_beach'],
  land: ['minecraft:plains', 'minecraft:forest', 'minecraft:taiga'],
  village: ['minecraft:plains', 'minecraft:desert', 'minecraft:savanna', 'minecraft:snowy_plains'], // (where villages generate; the biome is only where to look)
};
export const searchFor = (want) => SEARCH[TRAIT[want] === 'trees' ? 'trees' : want] ?? SEARCH.land;

/**
 * Surface summary of a chunk from a few sampled columns: { n, water, land, trees, stone }.
 * "island": land we're on is small and water is most of what's around.
 */
export function classifyTop(id) {
  const s = String(id ?? '').replace(/^minecraft:/, '');
  if (/water|kelp|seagrass|ice$|^ice|packed_ice/.test(s)) return 'water';
  if (/leaves|_log$|_wood$|_stem$|_hyphae$|mangrove_roots/.test(s)) return 'trees';
  if (/^(stone|granite|diorite|andesite|deepslate|tuff|calcite|cobblestone|gravel)$/.test(s)) return 'stone';
  return 'land';
}

/**
 * Are we stuck on an island? landCells: how much walkable land the flood fill reached (capped),
 * rings: surface samples around us [{ kind, dist }]. Island = little land, mostly water beyond it.
 */
export function onIsland(landCells, rings) {
  if (landCells > 1500) return false;
  const far = rings.filter((r) => r.dist >= 16);
  if (far.length < 8) return false;
  const water = far.filter((r) => r.kind === 'water').length;
  return water / far.length >= 0.6;
}
