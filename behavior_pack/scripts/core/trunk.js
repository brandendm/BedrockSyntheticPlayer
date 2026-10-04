// Cutting a tree from inside its own trunk (pure, unit-tested). The way the owner cut the forest test's trees: the log at eye height from beside
// the trunk, the one at the foot, then a step INTO the cell the trunk stood in and straight up the column with the crosshair never leaving it,
// every drop falling onto his feet. The u204 bot stood 3 blocks off and cut from the side: a ring of leaves hid the upper logs (a leaf broken, or
// a walk to get round it, before the third log of every tree: 1.9 s against 0.9), every drop landed 1 to 4 blocks away and was walked to, and a
// search ran for the logs still falling. 39 logs to his 59.
import { isLog } from './recipes.js';

export const TUNNEL_MIN = 3;            // a trunk of fewer logs is not worth stepping into
export const STEP_TICKS = 0.2155;       // blocks a walking step covers in a tick (the strafe's pace)
// What cannot be stood on (the ground under the trunk becomes the floor of the cell we stand in).
const NOT_FLOOR = /(^|_)(air|water|lava|leaves|vine|vines|magma|fire|cactus|campfire|berry|berries|powder_snow|dripstone|snow_layer|slab|stairs|fence|fence_gate|wall|door|trapdoor|carpet|sapling|bed|pane|rail|button|torch|lantern|web|cane|bamboo|bubble_column)(_|$)/;
const OPEN_CELL = /^(air|cave_air|void_air)$/;

/**
 * Can this trunk be cut by standing in it? at(x, y, z) -> block id; column: the logs of the straight trunk, lowest first ({x, y, z}); feetY: where
 * our feet are (beside the trunk's foot). Returns { ok, why }.
 */
export function tunnelCheck(at, column, feetY) {
  if (column.length < TUNNEL_MIN) return { ok: false, why: `only ${column.length} logs` };
  const b = column[0];
  if (Math.abs(feetY - b.y) > 0.3) return { ok: false, why: `feet ${feetY.toFixed(1)}, foot of the trunk at ${b.y}` };
  const floor = at(b.x, b.y - 1, b.z) ?? 'air';
  if (NOT_FLOOR.test(floor)) return { ok: false, why: `${floor} under the trunk` };
  // The two cells we stand in: a log to cut away, or already clear.
  for (let dy = 0; dy <= 1; dy++) {
    const id = at(b.x, b.y + dy, b.z) ?? 'air';
    if (!isLog(id) && !OPEN_CELL.test(id)) return { ok: false, why: `${id} in the trunk's cell ${dy} up` };
  }
  return { ok: true, why: '' };
}

/** The logs to take from beside the trunk, in order (the one at eye height first, the crosshair is level there; then the foot), and the rest from inside it. */
export function cutOrder(column) {
  const base = column[0].y;
  const side = [column.find((b) => b.y === base + 1), column[0]].filter(Boolean);
  const up = column.filter((b) => b.y > base + 1);
  return { side, up };
}

/** Ticks to slide `d` blocks into the cell at a walking pace (one more for the stop). */
export function stepTicks(d) {
  return Math.max(2, Math.ceil(d / STEP_TICKS) + 1);
}
