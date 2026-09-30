// Numbers the code leans on that only the real game can confirm, and what to do when a measure
// of them disagrees. game/calibrate.js takes the measures (at spawn, in the running game); this
// is the judging, in plain code so it can be tested.
//
// Why: two bugs in a row were a wrong constant nothing in the pure-code simulators could show
// (the head is 1.52 above the feet, not 1.62; the game refuses two item uses inside ~4 ticks).
// Bedrock updates change numbers like these without a word. A drift now says so in the log and
// in chat, and the ones that can be adopted are.

/** What the code was built and tuned on (BDS 1.26, measured in the real game). */
export const EXPECTED = Object.freeze({
  head: 1.52,       // head height above the feet, standing
  apex: 1.25,       // how high a standing jump takes the feet
  airTicks: 12,     // ticks from the jump to the feet down again
  useGap: 10,       // fewest ticks between two item uses that the game accepts (9 is refused, measured in BDS 1.26.51)
});

/** Live tuning the rest of the code reads (game/skills.js useGap). */
export const TUNING = { useGap: 10 };

const TOL = { head: 0.02, apex: 0.06, airTicks: 1, useGap: 1 };

/**
 * Compare measures with what's expected. m: { head?, apex?, airTicks?, useGap? } (any may be
 * missing). Returns { notes: [what differs], adopt: { eyeHeight?, useGap? } }.
 */
export function judge(m, expected = EXPECTED) {
  const notes = [];
  const adopt = {};
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (num(m.head)) {
    if (m.head < 1.3 || m.head > 1.9) notes.push(`head height ${m.head.toFixed(3)} is not believable: keeping ${expected.head}`);
    else {
      adopt.eyeHeight = Math.round(m.head * 1000) / 1000;
      if (Math.abs(m.head - expected.head) > TOL.head) notes.push(`head is ${m.head.toFixed(2)} above the feet here, the code was built for ${expected.head}: using ${adopt.eyeHeight}`);
    }
  }
  if (num(m.apex) && Math.abs(m.apex - expected.apex) > TOL.apex) notes.push(`a jump takes the feet ${m.apex.toFixed(2)} up, expected ${expected.apex}: the jump tables in core/jump.js may be off`);
  if (num(m.airTicks) && Math.abs(m.airTicks - expected.airTicks) > TOL.airTicks) notes.push(`a jump lasts ${m.airTicks} ticks, expected ${expected.airTicks}: the jump tables in core/jump.js may be off`);
  if (num(m.useGap)) {
    // (The fewest that worked is what's left: the count is in whole ticks, the same way it's kept.)
    adopt.useGap = Math.min(16, Math.max(2, Math.round(m.useGap)));
    if (Math.abs(m.useGap - expected.useGap) > TOL.useGap) notes.push(`the game takes an item use every ${m.useGap} ticks here, expected ${expected.useGap}: leaving ${adopt.useGap}`);
  }
  return { notes, adopt };
}
