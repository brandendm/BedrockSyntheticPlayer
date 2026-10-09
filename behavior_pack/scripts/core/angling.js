// Fishing and campfire cooking: the pure parts (what to carry, when a fish has bitten, which food goes on the fire).
// The game side is game/fishing.js and game/campfire.js.
import { RAW } from './settle.js';

/** A fishing rod: 3 sticks and 2 string (string comes from spiders and cobwebs: a rod is only made if the string is already in the pack). */
export const ROD_STICKS = 3;
export const ROD_STRING = 2;
/** A campfire: 3 sticks, a coal or charcoal, 3 logs. It burns for ever (no fuel), cooks four items at a time, 30 s each. */
export const FIRE_STICKS = 3;
export const FIRE_LOGS = 3;
export const FIRE_SLOTS = 4;
export const COOK_TICKS = 600;

const isFuelCoal = (id) => id === 'coal' || id === 'charcoal';
const isLogId = (id) => /(_log|_stem|_hyphae|_wood)$/.test(id) && !id.startsWith('stripped_');

/** Can a campfire be made from the pack (sticks may be made from planks: 2 planks are 4 sticks)? */
export function canMakeCampfire(inv) {
  const logs = Object.entries(inv).filter(([id]) => isLogId(id)).reduce((a, [, n]) => a + n, 0);
  const coal = Object.entries(inv).filter(([id]) => isFuelCoal(id)).reduce((a, [, n]) => a + n, 0);
  const planks = Object.entries(inv).filter(([id]) => id.endsWith('_planks')).reduce((a, [, n]) => a + n, 0);
  const sticks = (inv.stick ?? 0) + Math.floor(planks / 2) * 4;
  return coal >= 1 && logs >= FIRE_LOGS && sticks >= FIRE_STICKS;
}

/** Up to FIRE_SLOTS raw items to put on a fire, most plentiful kind first: [{ id, n }] (n summing to at most the slots). */
export function cookBatch(inv, slots = FIRE_SLOTS) {
  const kinds = Object.keys(RAW).filter((id) => (inv[id] ?? 0) > 0).sort((a, b) => inv[b] - inv[a]);
  const out = [];
  let left = slots;
  for (const id of kinds) {
    if (left <= 0) break;
    const n = Math.min(left, inv[id]);
    out.push({ id, n });
    left -= n;
  }
  return out;
}

/** Is a campfire worth it: raw food enough to be worth the 30 s wait, and the fire in the pack or makeable. */
export function wantCampfire(inv, { furnaceHandy = false, minRaw = 2 } = {}) {
  const raw = Object.keys(RAW).reduce((a, id) => a + (inv[id] ?? 0), 0);
  if (raw < minRaw || furnaceHandy) return false;
  return (inv.campfire ?? 0) > 0 || canMakeCampfire(inv);
}

// ---------- fishing ----------

/** The rod's hook goes down (a quick dip, vy under -0.1, or the hook falling 0.2 under where it floated) when a fish bites; it must have been in the water 2 s first. */
export const BITE_DY = 0.2;
export const BITE_VY = -0.1;
export const SETTLE_TICKS = 40;
export const CAST_TIMEOUT = 20 * 45;

export function newBite() { return { t: 0, top: -Infinity, bit: false }; }

/** One tick of the hook (its height y, vertical speed vy, whether it is in water): true on the tick a bite is seen. */
export function biteStep(st, { y, vy, wet }) {
  st.t++;
  if (!wet) { st.t = 0; st.top = -Infinity; return false; }
  st.top = Math.max(st.top, y);
  if (st.t < SETTLE_TICKS || st.bit) return false;
  if (vy < BITE_VY || st.top - y > BITE_DY) { st.bit = true; return true; }
  return false;
}

/** What is a catch from the water: fish and the junk and treasure of the fishing loot. */
export const CATCH = /^(cod|salmon|tropical_fish|pufferfish|bowl|leather|leather_boots|rotten_flesh|stick|string|bone|ink_sac|tripwire_hook|fishing_rod|name_tag|saddle|nautilus_shell|enchanted_book|bow|lily_pad|water_bottle|potion)$/;
export const FISH = new Set(['cod', 'salmon', 'tropical_fish', 'pufferfish']);

/** New fish in the pack between two counts. */
export function fishGained(before, after) {
  let n = 0;
  for (const id of ['cod', 'salmon', 'cooked_cod', 'cooked_salmon']) n += Math.max(0, (after[id] ?? 0) - (before[id] ?? 0));
  return n;
}
