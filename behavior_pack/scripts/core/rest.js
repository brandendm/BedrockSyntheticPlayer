// Hurt: stop and heal before going on. Pure, unit-tested (tests/rest.test.js).
//
// The bot's health came back only as a side effect of eating between jobs, so a creeper and a fall
// that left it on 1.5 hp still sent it down the mine at night to branch-mine (and to its death from
// the first skeleton). Under REST_BELOW it stops working: home if the house is close, otherwise
// where it stands (the fight and flee reflexes still run), eats (health comes back at 1 hp per 4 s
// with the food bar at 18 or more, and quickly on saturation), and waits until REST_UNTIL.
// It only rests if it can heal at all (food bar high enough, or something to eat), for at most
// REST_MAX_S a bout, and not again for REST_COOLDOWN_S after a bout that got nowhere.

export const REST_BELOW = 8;        // hp: under four hearts, no more work until better
export const REST_UNTIL = 14;       // hp: seven hearts, back to it
export const REST_MAX_S = 240;      // a bout's cap (health that won't come back isn't waited on for ever)
export const REST_COOLDOWN_S = 180; // after a bout that ran out of time or of food
export const HEAL_HUNGER = 18;      // the food bar level natural healing needs (Bedrock)
export const REST_HOME_M = 48;      // the house is this close: rest inside

/**
 * Should we be resting now? { health, hunger, canEat (something in the pack worth eating),
 * resting (a bout's under way), coolingDown }.
 */
export function shouldRest({ health, hunger = 20, canEat = false, resting = false, coolingDown = false }) {
  if (health >= REST_UNTIL) return false;
  if (resting) return true;                       // (the bout has its own time cap)
  if (coolingDown || health >= REST_BELOW) return false;
  return hunger >= HEAL_HUNGER || canEat;         // nothing to heal with: no point sitting about
}

/** Can health come back right now? The food bar high enough, or a meal to raise it. */
export function canHeal({ hunger = 20, canEat = false }) {
  return hunger >= HEAL_HUNGER || canEat;
}
