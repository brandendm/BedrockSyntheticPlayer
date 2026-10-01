// A player's house, built in a grid, for the learn-your-house tests and sims (tests/learnhouse.test.js,
// tools/sim_home.mjs with LAYOUT=learned).
import { buildPlan, capture } from '../behavior_pack/scripts/core/learnhouse.js';

/**
 * A player's house in a world grid: W wide (x) by D deep (z), walls H high, door in the middle of the
 * south wall (z = D-1 side, facing +z). Everything in the cells map; `o` turns parts off or adds.
 * Returns { get, box, placed, heads, door } with the ground at y = 0 (floor level y = 1).
 */
export function house(o = {}) {
  const W = o.W ?? 7, D = o.D ?? 6, H = o.H ?? 3;
  const cells = new Map(), placed = new Set(), heads = new Set();
  const set = (x, y, z, id, mine = true) => { cells.set(`${x},${y},${z}`, id); if (mine) placed.add(`${x},${y},${z}`); };
  for (let x = -3; x < W + 3; x++) for (let z = -3; z < D + 3; z++) { set(x, 0, z, 'grass_block', false); set(x, -1, z, 'dirt', false); }
  // Walls and roof.
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    const edge = x === 0 || z === 0 || x === W - 1 || z === D - 1;
    for (let y = 1; y <= H; y++) if (edge) set(x, y, z, y === 1 || (x % (W - 1) === 0 && z % (D - 1) === 0) ? 'cobblestone' : 'oak_planks');
    set(x, H + 1, z, o.roof?.(x, z) ?? 'oak_planks');
  }
  if (o.noRoof) for (let x = 1; x < W - 1; x++) for (let z = 1; z < D - 1; z++) cells.delete(`${x},${H + 1},${z}`);
  const dx = Math.floor(W / 2), dz = D - 1;
  cells.delete(`${dx},1,${dz}`); cells.delete(`${dx},2,${dz}`);
  if (!o.noDoor) { set(dx, 1, dz, 'oak_door'); set(dx, 2, dz, 'oak_door'); }
  // Windows.
  if (o.windows === 'holes') { cells.delete(`0,3,2`); cells.delete(`${W - 1},3,2`); }
  if (o.windows === 'glass') { set(0, 3, 2, 'glass'); set(W - 1, 3, 2, 'glass'); }
  if (o.windows === 'low') { set(0, 2, 2, 'glass'); }
  // Inside: bed along the back wall, table, furnace, chest, torch.
  if (!o.noBed) { set(W - 2, 1, 1, 'bed'); set(W - 2, 1, 2, 'bed'); heads.add(`${W - 2},1,2`); }
  if (!o.noTable) set(1, 1, 1, 'crafting_table');
  if (!o.noFurnace) set(3, 1, 1, 'furnace');
  if (!o.noChest) set(1, 1, 3, 'chest');
  if (o.walledChests) for (let x = 1; x < W - 1; x++) set(x, 1, 3, 'chest'); // a row of chests across the room (the door's side cut off)
  if (!o.noTorch) set(W - 2, 2, D - 2, 'torch');
  if (o.hill) for (let x = 0; x < W; x++) for (let y = 1; y <= H; y++) { set(x, y, 0, 'dirt', false); placed.delete(`${x},${y},0`); } // the back wall is the hillside (not placed)
  const box = { x0: -2, x1: W + 1, y0: -1, y1: H + 3, z0: -2, z1: D + 2 };
  const get = (x, y, z) => cells.get(`${x},${y},${z}`);
  return { cells, get, box, placed, heads, door: `${dx},1,${dz}`, W, D, H };
}
export const plan = (o, opts = {}) => { const h = house(o); const snap = capture(h.get, h.box, (x, y, z) => h.heads.has(`${x},${y},${z}`)); return buildPlan(snap, { placed: h.placed, firstDoor: h.door, ...opts }); };

