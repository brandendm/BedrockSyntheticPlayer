// Waypoints for a rider (u309). A horse towing a boat is fast (9 blocks/s) and cannot turn on a point: a waypoint accepted only within 1.1 blocks was missed by a
// wide pass and then circled for seconds (the horse tows' turnYawDeg of 330-450 and 480-700 degrees/s turns in the u287-u289 logs). A rider accepts a waypoint within
// RIDE_REACH, or once it has been close and is now moving away (it went past it); walking keeps 1.1.
export const WALK_REACH = 1.1;
export const RIDE_REACH = 2.2;
const NEAR = 3.2;     // having been this close counts as having come to it
const AWAY = 0.9;     // ...and being this much further than the closest it got counts as having gone past

/** Fresh tracker for a waypoint. */
export const newReach = () => ({ wi: -1, best: Infinity });

/**
 * Has the walker (or rider) reached waypoint number `wi`, `dist` blocks away on the flat? Updates `st` ({wi, best}: the closest it has been to this waypoint).
 * hold: the last waypoint of a route (we stop there; no passing it).
 */
export function reached(st, wi, dist, { ride = false, hold = false } = {}) {
  if (st.wi !== wi) { st.wi = wi; st.best = Infinity; }
  st.best = Math.min(st.best, dist);
  const r = ride ? RIDE_REACH : WALK_REACH;
  if (dist < r) return true;
  return ride && !hold && st.best < NEAR && dist > st.best + AWAY;
}

/** Speed (0..1) for a rider heading for a waypoint `dist` away: full speed far off, slowing into the last blocks so it does not overshoot and circle. */
export const rideSpeed = (dist) => Math.max(0.35, Math.min(1, 0.3 + dist * 0.18));

/** Types that may sit in a boat with us (the ferry carries villagers; the player is the player). Anything else on board is in the way. */
export const WELCOME_ABOARD = /^minecraft:(villager|villager_v2|player)$/;
