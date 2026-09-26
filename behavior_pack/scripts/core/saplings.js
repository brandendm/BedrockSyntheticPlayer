// Replanting: which sapling, on what, with how much room. Pure (unit-tested).
//
// Rules (Minecraft Wiki, Sapling): saplings go on dirt-type ground; the block above needs light 9+
// to grow; each tree needs clear space above (oak 5, jungle 5, birch 6, spruce 6, acacia 6,
// cherry 8, dark oak / pale oak 7); logs, wood and leaves above stop it growing. Dark oak and pale
// oak only grow as a 2x2 of four saplings. Mangrove propagules also take mud and clay.
//
// Where: on the stump of a tree we just cut (the forest grows back where it was), never near the
// house (a grown canopy spreads 2-3 blocks), our stations or our quarry stairs, and never right
// next to another sapling (they'd crowd each other; a 2x2 is the one exception).

const SAPLING = {
  oak: 'oak_sapling', birch: 'birch_sapling', spruce: 'spruce_sapling', jungle: 'jungle_sapling',
  acacia: 'acacia_sapling', dark_oak: 'dark_oak_sapling', cherry: 'cherry_sapling', pale_oak: 'pale_oak_sapling',
  mangrove: 'mangrove_propagule',
};
const HEIGHT = {
  oak_sapling: 5, birch_sapling: 6, spruce_sapling: 6, jungle_sapling: 5, acacia_sapling: 6,
  cherry_sapling: 8, dark_oak_sapling: 7, pale_oak_sapling: 7, mangrove_propagule: 6,
};
const TWO_BY_TWO = new Set(['dark_oak_sapling', 'pale_oak_sapling']);
const GROUND = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|dirt_with_roots|moss_block|mud|muddy_mangrove_roots|farmland)$/;

/** The sapling a log grows from (null: nether stems and the like). */
export function saplingFor(logId) {
  const m = /^(?:stripped_)?(oak|birch|spruce|jungle|acacia|dark_oak|cherry|pale_oak|mangrove)_(?:log|wood)$/.exec(logId);
  return m ? SAPLING[m[1]] : null;
}

export const isSapling = (id) => /_sapling$/.test(id) || id === 'mangrove_propagule';
export const needs2x2 = (sapling) => TWO_BY_TWO.has(sapling);
export const growHeight = (sapling) => HEIGHT[sapling] ?? 6;

/** Can this sapling be planted on this block? */
export function plantsOn(groundId, sapling) {
  if (sapling === 'mangrove_propagule' && groundId === 'clay') return true;
  return GROUND.test(groundId);
}

/** Saplings to hold back from the furnace, per kind: enough to replant (four for a 2x2 tree). */
export const keepForPlanting = (sapling) => (needs2x2(sapling) ? 4 : 2);

/**
 * Is `cell` (where the sapling goes; ground is the block under it) a good spot?
 * at(p) -> block id; light(p) -> light level or null; avoid: [{x,z,r}] no-go circles
 * (house, stations, quarry). others: positions of saplings already planted.
 * Returns null if fine, else the reason.
 * @param {{x:number,y:number,z:number}} cell
 * @param {string} sapling
 * @param {{ at: (p: any) => string | null | undefined, light?: (p: any) => number | null, avoid?: Array<{x:number,z:number,r:number,why?:string}>, others?: Array<{x:number,z:number}> }} o
 */
export function plantProblem(cell, sapling, { at, light = (_p) => null, avoid = [], others = [] }) {
  const ground = at({ x: cell.x, y: cell.y - 1, z: cell.z }) ?? '';
  if (!plantsOn(ground, sapling)) return `ground is ${ground}`;
  const here = at(cell) ?? '';
  if (!/^(air|short_grass|tall_grass|fern|large_fern|leaf_litter|snow_layer)$/.test(here)) return `spot has ${here}`;
  // Room to grow: nothing solid straight up (leaves left over from the old tree decay by themselves).
  for (let dy = 1; dy <= growHeight(sapling); dy++) {
    const id = at({ x: cell.x, y: cell.y + dy, z: cell.z }) ?? 'air';
    if (id !== 'air' && !/leaves|vine|snow_layer|short_grass|tall_grass/.test(id)) return `${id} ${dy} up`;
  }
  const l = light(cell);
  if (l != null && l < 9) return `too dark (${l})`;
  for (const a of avoid) if (Math.hypot(cell.x - a.x, cell.z - a.z) < a.r) return a.why ?? 'too close to our things';
  for (const o of others) {
    const d = Math.max(Math.abs(o.x - cell.x), Math.abs(o.z - cell.z));
    if (d === 0) return 'already planted';
    if (d <= 1 && !needs2x2(sapling)) return 'next to another sapling';
  }
  return null;
}
