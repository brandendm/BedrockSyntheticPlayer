// The pure parts of running tests on several bots at once (game/scenarios.js runPool). Unit-tested.

/** The next free one of `slots` sky sites after `counter` (round robin), skipping the busy ones; null when all are in use. */
export function nextSlot(counter, busy, slots = 8) {
  const first = ((counter % slots) + slots) % slots;
  for (let k = 0; k < slots; k++) { const s = (first + k) % slots; if (!busy.has(s)) return s; }
  return null;
}

/** Split test names into the phases that may each share the world: { calm, combat, serial }, order kept. classOf(name) -> 'calm' | 'combat' | null. */
export function partition(names, classOf) {
  const out = { calm: [], combat: [], serial: [] };
  for (const n of names) (out[classOf(n) ?? 'serial']).push(n);
  return out;
}

/** The ring of sky sites for a parallel batch: centre + radius at slot angle. Sites are at least `minApart` blocks from each other with radius r. */
export function siteAt(ctr, slot, slots = 8) {
  const a = (slot * 2 * Math.PI) / slots;
  return { x: Math.floor(ctr.x + ctr.r * Math.cos(a)), z: Math.floor(ctr.z + ctr.r * Math.sin(a)) };
}
export const minApart = (r, slots = 8) => 2 * r * Math.sin(Math.PI / slots);

/** Who works on what: jobs dealt to bots as each frees up (a shared queue); returns the queue puller. */
export const queueOf = (items) => { const q = [...items]; return () => q.shift(); };
