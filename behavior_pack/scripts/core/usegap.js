// How soon after one item use the game takes the next (pure, unit-tested). The u204 farm race: the bot waited 10 ticks before every use (the
// game refused one at 9, measured with plain blocks) and alternated hoe and seeds, 24 uses in 12 s; the owner, a real client, used the hoe 17
// times in 4.1 s and planted 12 seeds in 3.2 s: 4 to 6 ticks a use. The 10 is a limit on putting BLOCKS down, not shown to apply to a hoe or
// seeds. So the farm starts at 5 and lets the game answer: a use that is refused (the call says false) or silently ignored (it says true and
// nothing changes) puts the gap up, and a run of taken ones tries one tick less, never down to a gap that was refused. Whatever it settles
// on, a use is never made sooner than the game took one.

export const GAP_START = 5;
export const GAP_MIN = 3;
export const GAP_MAX = 10;   // (what always worked)

export class GapTuner {
  /** @param {{start?: number, min?: number, max?: number, down?: number}} [o] down: taken uses in a row before one tick less is tried */
  constructor({ start = GAP_START, min = GAP_MIN, max = GAP_MAX, down = 4 } = {}) {
    this.min = min; this.max = max; this.down = down;
    this.gap = Math.min(max, Math.max(min, start));
    this.floor = min - 1;      // the highest gap known refused
    this.streak = 0;
    this.refusals = 0;
  }

  /** A use `gap` ticks after the last was taken. */
  ok() {
    this.streak++;
    if (this.streak >= this.down && this.gap - 1 > this.floor && this.gap > this.min) { this.gap--; this.streak = 0; return true; }
    return false;
  }

  /** A use was refused or ignored: wait longer (two ticks more, to settle in fewer tries), and never again down to this one. */
  refused() {
    this.refusals++;
    this.floor = Math.max(this.floor, this.gap);
    this.gap = Math.min(this.max, this.gap + 2);
    this.streak = 0;
    return this.gap;
  }
}
