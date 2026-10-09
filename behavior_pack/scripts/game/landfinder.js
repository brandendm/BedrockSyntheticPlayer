// Finding dry land (u296): the top solid block of a column, loading the chunk first with a short-lived ticking area; and the nearest good spawn column round a point.
// Used by the world-spawn check (main.js fixWorldSpawn) and by the progression benchmark (game/bench.js) to drop bots on land, well apart.
import { world, system } from '@minecraft/server';
import { goodSpawnColumn, spiral } from '../core/spawnpick.js';

let tagN = 0;
/** { id, y } of the highest non-air block at (x, z), or null if the chunk never loaded. */
export async function topColumn(dim, x, z) {
  const name = `agent_land_${tagN++ % 6}`;
  try { dim.runCommand(`tickingarea add circle ${x} 64 ${z} 1 ${name} true`); } catch { /* */ }
  try {
    for (let i = 0; i < 24; i++) {
      let loaded = null;
      try { loaded = dim.getBlock({ x, y: 100, z }); } catch { loaded = null; }
      if (loaded) {
        const { min, max } = dim.heightRange;
        for (let y = Math.min(max - 1, 200); y > min; y--) {
          const t = dim.getBlock({ x, y, z });
          if (!t) return null;
          if (!t.isAir) return { id: t.typeId, y };
        }
        return null;
      }
      await system.waitTicks(5);
    }
    return null;
  } finally { try { dim.runCommand(`tickingarea remove ${name}`); } catch { /* */ } }
}

/** The nearest good land column round (cx, cz) (a square spiral, `step` apart), or null after `tries`. Returns { x, y (feet), z, id }. */
export async function findLand(dim, cx, cz, { step = 48, tries = 40 } = {}) {
  let n = 0;
  for (const c of spiral(Math.floor(cx), Math.floor(cz), step, tries)) {
    n++;
    const f = await topColumn(dim, c.x, c.z);
    if (f && goodSpawnColumn(f.id, f.y)) return { x: c.x, y: f.y + 1, z: c.z, id: f.id };
  }
  return null;
}

/** `n` land spots far apart: spread round a ring (golden-angle steps) at 1500 + 700 i blocks from `centre`, each found on dry land. Fewer if land was not found. */
export async function spreadLand(dim, centre, n) {
  const out = [];
  const a0 = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = a0 + i * 2.399963, r = 1500 + 700 * i;
    const spot = await findLand(dim, centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r, { step: 64, tries: 25 });
    if (spot) out.push(spot);
  }
  return out;
}
export const worldSpawn = () => world.getDefaultSpawnLocation();
