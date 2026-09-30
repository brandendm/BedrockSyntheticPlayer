// Going back for what we dropped when we died. Pure (unit-tested).
//
// Everything we carried lies on the ground at the death spot for 5 minutes (item entities despawn
// then). The rule used to be "four tries, then it's gone": every restart of the job burned a try
// (a pickup trigger restarted it every two seconds), so the gear was written off after ten seconds
// with the pile still lying there. Now: keep at it for the whole 5 minutes, count only real
// failures (no way there, been there and couldn't pick it up), back off between them so other jobs
// get done in between, and go through the dark for gear (iron tools and armor are hours of work)
// but not for cobblestone.

export const LOOT_WINDOW_MS = 295000;
export const MAX_FAILS = 10;   // legs that got nowhere near it
export const MAX_STUCK = 5;    // visits where it was lying there and we couldn't pick it up

/** Gear and rare things: worth a trip through the night. */
export const VALUABLE = /(_helmet|_chestplate|_leggings|_boots|_sword|_pickaxe|_axe|_shovel|_hoe|_spear)$|^(shield|bucket|water_bucket|bow|crossbow|trident|mace|totem_of_undying|ender_pearl|lead|name_tag|saddle|elytra|diamond|emerald|netherite_ingot|iron_ingot|gold_ingot|raw_iron|raw_gold|iron_ore|deepslate_iron_ore|coal|charcoal)$/;

/** How many of these item ids are worth going back for (stone_ and wooden_ tools and armor count: they're a table's work). */
export function lootWorth(ids) {
  return ids.filter((id) => VALUABLE.test(String(id).replace('minecraft:', ''))).length;
}

/** Seconds to wait before the next try, after n failures. */
export const backoffMs = (n) => Math.min(30000, 3000 * Math.max(1, n));

/**
 * What to do about a death spot right now.
 * d: { at (ms), worth, fails, stuck, retryAt (ms) }; ctx: { now (ms), dist (blocks), night, health }.
 *   expired  the 5 minutes are up: clear it
 *   wait     not yet (not respawned, standing on the spot, a failed try's back-off): carry on with other jobs
 *   skip     junk far off at night: leave it (it stays until it expires)
 *   giveup   tried and tried: clear it
 *   go       go and get it
 */
export function lootPlan(d, { now, dist, night = false, health = 20 }) {
  const age = now - d.at;
  if (age > LOOT_WINDOW_MS) return { do: 'expired' };
  if (age < 3000 || health <= 0) return { do: 'wait', why: 'not respawned yet' };
  if (dist < 4 && age < 10000) return { do: 'wait', why: 'still where we died' };
  if ((d.fails ?? 0) >= MAX_FAILS) return { do: 'giveup', why: 'no way there' };
  if ((d.stuck ?? 0) >= MAX_STUCK) return { do: 'giveup', why: 'could not pick it up' };
  if (now < (d.retryAt ?? 0)) return { do: 'wait', why: 'backing off' };
  if (night && dist > 40 && !(d.worth > 0)) return { do: 'skip', why: 'nothing worth the dark' };
  return { do: 'go' };
}
