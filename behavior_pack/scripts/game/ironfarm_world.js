// Small things game/ironfarm.js and game/ironfarm_aids.js both need: running commands, reading blocks, and reading the real world with the
// same golem-spawn rule core/ironfarm_grid.js applies to the plan (so what is built can be checked against what the game will do, not against
// what the plan says it built).
import { system, world } from '@minecraft/server';
import { SPAWN_VOLUME } from '../core/ironfarm.js';

export const TAG = '§b[IronFarm]§r';
export const say = (m) => { try { world.sendMessage(`${TAG} ${m}`); } catch { /* */ } console.warn(`[ironfarm] ${m}`); };
export const wait = (n) => system.waitTicks(n);
export const W = (o, p) => ({ x: p.x + o.x, y: p.y + o.y, z: p.z + o.z });

/** Run a command; returns '' if it worked, else why not. */
export function run(dim, cmd) {
  try {
    const r = dim.runCommand(cmd);
    if (r && r.successCount === 0) return 'did nothing';
    return '';
  } catch (e) { return String(e).slice(0, 120); }
}

export const idAt = (dim, q) => { try { return (dim.getBlock(q)?.typeId ?? 'unloaded').replace('minecraft:', ''); } catch { return 'unloaded'; } };
export const stateAt = (dim, q, name) => { try { return dim.getBlock(q)?.permutation.getState(name); } catch { return undefined; } };
export const isWater = (id) => id === 'water' || id === 'flowing_water';

/** A block update next to a cell: a block put in a free neighbour and taken out again. */
export async function kick(dim, q) {
  for (const [dx, dy, dz] of [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0]]) {
    const n = { x: q.x + dx, y: q.y + dy, z: q.z + dz };
    if (idAt(dim, n) !== 'air') continue;
    run(dim, `setblock ${n.x} ${n.y} ${n.z} cobblestone`);
    await wait(2);
    run(dim, `setblock ${n.x} ${n.y} ${n.z} air`);
    await wait(2);
    return true;
  }
  return false;
}

/** How many slots the chest at q has: 27 for a single chest, 54 for a double one (0 if it cannot be read). */
export function chestSize(dim, q) {
  try { return dim.getBlock(q)?.getComponent('minecraft:inventory')?.container?.size ?? 0; } catch { return 0; }
}

// ---- the real world, read with the golem-spawn rule ----
/** Plants and the like: a golem's box can pass through them (and the builder does not count them as being in the way). */
export const PLANT = /(^|_)(grass|fern|flower|dandelion|poppy|tulip|orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily|rose|peony|lilac|bush|sapling|mushroom|vine|snow_layer|snow|seagrass|kelp|bamboo_sapling|moss_carpet|tallgrass|double_plant|yellow_flower|red_flower|sweet_berry_bush|deadbush|dead_bush)(_|$)/;
const FREE_IDS = new Set(['air', 'water', 'flowing_water', 'wall_sign', 'standing_sign', 'torch', 'unloaded_free']);
const free = (id) => FREE_IDS.has(id) || PLANT.test(id) || /_wall_sign$|^(oak|spruce)_sign$|fence_gate$/.test(id);
/** Not something a golem could be spawned on: slabs, stairs, campfires, doors, ladders, lava, carpets, signs, torches and so on. */
const NOT_SUPPORT = /slab|stairs|campfire|door|lava|ladder|trapdoor|carpet|sign|torch|button|plate|rail|fence|pane|chain|lantern|water|air|^unloaded$/;
const supports = (id) => !free(id) && !NOT_SUPPORT.test(id);

/**
 * The places an iron golem could spawn inside the spawn volume round a centre block (world coordinates), read from the real blocks: a full block
 * under the feet and nothing solid in the 2 x 4 x 2 box from the feet up. Returns { spots: [{x,y,z}], unloaded } .
 */
export function scanSpawnSpots(dim, centre) {
  const V = SPAWN_VOLUME;
  const cache = new Map();
  let unloaded = 0;
  const id = (x, y, z) => {
    const k = `${x},${y},${z}`;
    let v = cache.get(k);
    if (v === undefined) { v = idAt(dim, { x, y, z }); if (v === 'unloaded') unloaded++; cache.set(k, v); }
    return v;
  };
  const spots = [];
  for (let x = centre.x - V.rx; x <= centre.x + V.rx; x++) for (let y = centre.y - V.ry; y <= centre.y + V.ry; y++) for (let z = centre.z - V.rz; z <= centre.z + V.rz; z++) {
    if (!supports(id(x, y - 1, z))) continue;
    let ok = true;
    for (let i = x - 1; ok && i <= x; i++) for (let j = y; ok && j <= y + 3; j++) for (let k = z - 1; ok && k <= z; k++) if (!free(id(i, j, k))) ok = false;
    if (ok) spots.push({ x, y, z });
  }
  return { spots, unloaded };
}
