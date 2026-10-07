// Watching a player tow a boat (`!bot learn tow`): four samples a second of where they (or the horse they're on) and the boat
// are, until `!bot learn off`; core/towlearn.js works the numbers out and game/leadtow.js uses them in place of its guesses.
import { world } from '@minecraft/server';
import { analyseTow, mergeLearned } from '../core/towlearn.js';
import { sendEvent, trace } from './bridge.js';

const MAX_SAMPLES = 4800; // 20 minutes

export class TowLearn {
  constructor(agent) {
    this.a = agent; this.name = null; this.samples = []; this.noBoatSince = null; this.placed = 0; this.auto = false;
    // (u241) Blocks the watched player puts down: building forward for room to jump is part of what is learned.
    try {
      const wa = /** @type {any} */ (world.afterEvents);
      wa.playerPlaceBlock?.subscribe((e) => { if (this.name && e.player?.name === this.name) this.placed++; });
    } catch { /* no such event: nothing about building is learned */ }
  }

  get on() { return !!this.name; }

  /** (u241) Started by a test on your turn (the tow courses): the same watching, quiet, and told when it ends. */
  startFor(player) {
    if (this.name) return false;
    this.name = player.name; this.samples = []; this.noBoatSince = null; this.placed = 0; this.auto = true;
    return true;
  }

  start(player) {
    this.name = player.name; this.samples = []; this.noBoatSince = null; this.placed = 0; this.auto = false;
    return `Watching ${player.name} tow a boat: put a lead on a boat and lead it through the rough ground (on foot, or on a horse). \`!bot learn off\` when done.`;
  }

  /** The boat on this player's lead, nearest first. */
  boatOf(player) {
    let out = null, best = Infinity;
    try {
      for (const b of this.a.dim.getEntities({ type: 'minecraft:boat', location: player.location, maxDistance: 64 })) {
        let holder = null;
        try { holder = b.getComponent('minecraft:leashable')?.leashHolder ?? null; } catch { /* */ }
        if (!holder || holder.id !== player.id) continue;
        const d = Math.hypot(b.location.x - player.location.x, b.location.z - player.location.z);
        if (d < best) { best = d; out = b; }
      }
    } catch { /* none */ }
    return out;
  }

  /** Every 5 ticks from the agent's tick. */
  sample(t) {
    if (!this.name) return;
    const player = world.getPlayers().find((p) => p.name === this.name);
    if (!player) return;
    const boat = this.boatOf(player);
    if (!boat) {
      this.noBoatSince ??= t;
      if (!this.samples.length && !this.auto && t - this.noBoatSince > 600) { this.a.say('No boat on your lead after 30 s: say `!bot learn tow` again once one is.', true); this.name = null; }
      return;
    }
    this.noBoatSince = null;
    /** @type {import('@minecraft/server').Entity} */
    let subject = player;
    let ride = false;
    try { const r = player.getComponent('minecraft:riding')?.entityRidingOn; if (r) { subject = r; ride = true; } } catch { /* on foot */ }
    const S = this.a.skills, b = boat.location, p = subject.location;
    let rise = null;
    try {
      const dx = p.x - b.x, dz = p.z - b.z, len = Math.hypot(dx, dz) || 1;
      const top = S.groundTop(Math.floor(b.x + (dx / len) * 1.6), Math.floor(b.z + (dz / len) * 1.6));
      if (Number.isFinite(top)) rise = Math.round((top + 1 - b.y) * 10) / 10;
    } catch { /* unloaded */ }
    let leashed = true;
    try { leashed = !!boat.getComponent('minecraft:leashable')?.isLeashed; } catch { /* */ }
    this.samples.push({ t, px: p.x, py: p.y, pz: p.z, bx: b.x, bz: b.z, by: b.y, rise, leashed, ride, placed: this.placed });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** Stop, work it out, keep it. Returns a line for chat. */
  stop() {
    if (!this.name) return 'Not watching a tow.';
    const who = this.name; this.name = null;
    const res = analyseTow(this.samples);
    this.samples = [];
    if (!res) return 'Not enough of a tow to learn from (under 6 s with a boat on the lead).';
    const key = res.ride ? 'ride' : 'walk';
    const cal = this.a.memory.data.leadCal ?? {};
    const learned = { ...(cal.learned ?? {}) };
    learned[key] = mergeLearned(learned[key], res);
    // What the player's slings looked like (the jump with the lead stretched, and how fast the boat flew): the tow's own stretch.
    this.a.memory.data.leadCal = { ...cal, learned };
    this.a.memory.save();
    trace(`tow learned (${key}) from ${who}: ${JSON.stringify(res)}`);
    sendEvent({ type: 'tow_learned', who, key, result: res }).catch(() => {});
    return `Learned from ${who}'s tow (${key}, ${res.secs} s): the boat follows from ${res.pullAt ?? '?'} apart, you wait at ${res.holdAt ?? '?'}, ${res.stuckEvents} stuck moment${res.stuckEvents === 1 ? '' : 's'}${res.flank ? `, freed by going ${res.flank.angle} deg round at ${res.flank.dist} blocks` : ''}${res.sling ? `, ${res.sling.n} sling${res.sling.n === 1 ? '' : 's'} (jumped at ${res.sling.stretch} apart, the boat flew ${res.sling.boatPeak} blocks/s${res.sling.byRise ? `; stretch by step height ${JSON.stringify(res.sling.byRise)}` : ''})` : ''}${res.runway ? `, built forward ${res.runway.blocks} blocks for room before ${res.runway.n} of them (${res.runway.gain} further apart)` : ''}${res.snapped ? ', and the lead snapped' : ''}.`;
  }
}
