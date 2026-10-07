// Learning to tow a boat on a lead from a player who does it well (`!bot learn tow`). Pure (unit-tested).
//
// samples: [{ t (tick), px, pz (the player, or the horse they are on), bx, bz (the boat), by, rise (how much higher the ground
// is 1.6 blocks from the boat toward the player than where the boat is), leashed, ride }], four a second.
// Out comes what the tow controller (game/leadtow.js) otherwise guesses:
//   pullAt    how far apart they were when the boat started to follow
//   holdAt    how far apart they were when the player eased off to wait
//   curve     the player's speed (as a fraction of their quickest) at each separation
//   patience  ticks the player waited with the boat stuck before doing something about it
//   flank     where they went to free it: distance from the boat and how far round (degrees) from where they stood
//   blockedRise  how high the ground ahead of the boat was when it stuck (what it can't get over)

const flat = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
export const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const EDGES = [0, 2, 4, 5, 6, 7, 8, 9, 10, 12, 99];
const angleBetween = (a, b) => { let d = Math.abs(a - b) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d * 180 / Math.PI; };

export function analyseTow(samples) {
  const S = samples.filter((s) => s && Number.isFinite(s.px) && Number.isFinite(s.bx));
  if (S.length < 24) return null;
  const dt = (i) => Math.max(0.05, (S[i].t - S[i - 1].t) / 20);
  const pv = [0], bv = [0], sep = S.map((s) => flat(s.px, s.pz, s.bx, s.bz));
  for (let i = 1; i < S.length; i++) { pv.push(flat(S[i].px, S[i].pz, S[i - 1].px, S[i - 1].pz) / dt(i)); bv.push(flat(S[i].bx, S[i].bz, S[i - 1].bx, S[i - 1].bz) / dt(i)); }
  const top = Math.max(1, pct(pv, 0.95));
  // Speed against separation.
  const curve = [];
  for (let e = 0; e + 1 < EDGES.length; e++) {
    // (Moving samples only: standing still while the boat is close says nothing about how fast to go; the waiting is `holdAt`.)
    const v = pv.filter((x, i) => x > 0.5 && sep[i] >= EDGES[e] && sep[i] < EDGES[e + 1]);
    if (v.length >= 3) curve.push({ from: EDGES[e], to: EDGES[e + 1], frac: Math.min(1.2, median(v) / top) });
  }
  // Where the boat starts to follow: separation at the first sample it moves after sitting still for a second.
  const pulls = [];
  for (let i = 5; i < S.length; i++) if (bv[i] > 0.3 && bv.slice(i - 4, i).every((v) => v < 0.15) && sep[i - 1] > 2) pulls.push(sep[i - 1]); // (the gap just before it moved)
  // Where the player eases off: the start of a second or more at under a quarter of top speed with the two well apart.
  const pullAt = median(pulls);
  const holds = [];
  for (let i = 1; i + 3 < S.length; i++) {
    if (pv[i] < 0.25 * top && pv[i - 1] >= 0.25 * top && pv.slice(i, i + 4).every((v) => v < 0.25 * top) && sep[i] >= (pullAt ?? 5) - 0.5) holds.push(sep[i]);
  }
  // Stuck: the boat still (a second and a half) with the lead taut. What the player did about it.
  const events = [];
  for (let i = 1; i < S.length;) {
    const taut = (j) => sep[j] > (pullAt ?? 5) + 0.5 && bv[j] < 0.15 && S[j].leashed !== false;
    if (!taut(i)) { i++; continue; }
    let j = i;
    while (j + 1 < S.length && taut(j + 1)) j++;
    if (j - i + 1 >= 6) {
      const heading0 = Math.atan2(S[i].pz - S[i - 1].pz, S[i].px - S[i - 1].px);
      let turned = null;
      for (let k = i; k <= Math.min(S.length - 1, j + 12); k++) {
        if (k > 0 && pv[k] > 0.3 && angleBetween(Math.atan2(S[k].pz - S[k - 1].pz, S[k].px - S[k - 1].px), heading0) > 60) { turned = (S[k].t - S[i].t); break; }
      }
      let end = j; while (end + 1 < S.length && bv[end + 1] < 0.3 && end - j < 60) end++;
      const a0 = Math.atan2(S[i].pz - S[i].bz, S[i].px - S[i].bx), a1 = Math.atan2(S[end].pz - S[end].bz, S[end].px - S[end].bx);
      events.push({ patience: turned ?? (S[j].t - S[i].t), round: angleBetween(a0, a1), dist: sep[end], rise: S[i].rise });
    }
    i = j + 1;
  }
  // Slings: a jump (up 0.35+ within half a second) with the lead taut and the boat still, and what the boat did in the next 2 s.
  const slings = [];
  for (let i = 2; i + 8 < S.length; i++) {
    if (!Number.isFinite(S[i].py) || !Number.isFinite(S[i - 2].py)) continue;
    if (S[i].py - S[i - 2].py < 0.35 || S[i - 2].py - (S[i - 3]?.py ?? S[i - 2].py) > 0.2) continue; // (a rise that starts here)
    if (sep[i] < 4.5 || !bv.slice(Math.max(1, i - 4), i).every((v) => v < 0.5)) continue;
    const peak = Math.max(...bv.slice(i, i + 8));
    // (u241) How high the step was, whether the player had just built forward for room (blocks placed in the 12 s before the jump, and how
    // much further apart that got them), and whether the boat came.
    const w0 = Math.max(0, i - 48);
    const built = Number.isFinite(S[i].placed) && Number.isFinite(S[w0].placed) ? S[i].placed - S[w0].placed : 0;
    slings.push({ stretch: sep[i], peak, rise: Number.isFinite(S[i].rise) ? Math.max(0, Math.round(S[i].rise)) : null, built, gain: sep[i] - sep[w0], came: peak > 1.5 });
    i += 8;
  }
  const came = slings.filter((x) => x.came);
  const useS = came.length ? came : slings;
  const r1 = (v) => Math.round(v * 10) / 10;
  const byRise = {};
  for (const x of useS) if (x.rise >= 1) (byRise[Math.min(4, x.rise)] ??= []).push(x.stretch);
  for (const k of Object.keys(byRise)) byRise[k] = r1(median(byRise[k]));
  const builds = slings.filter((x) => x.built >= 2);
  // A jump that pulled the boat with no step in the way (jammed on a corner, a gate's edge): yanking it, not lifting it.
  const flatCame = came.filter((x) => x.rise === 0);
  const sling = slings.length ? { n: slings.length, came: came.length, stretch: r1(median(useS.map((x) => x.stretch))), boatPeak: r1(median(useS.map((x) => x.peak))), byRise: Object.keys(byRise).length ? byRise : null, flat: flatCame.length ? { n: flatCame.length, stretch: r1(median(flatCame.map((x) => x.stretch))) } : null } : null;
  // Built forward for room before a jump: how many blocks, and how much further apart it let them get.
  const runway = builds.length ? { n: builds.length, blocks: Math.round(median(builds.map((x) => x.built))), gain: r1(median(builds.map((x) => x.gain))) } : null;
  const flank = events.length ? { dist: median(events.map((e) => e.dist)), angle: median(events.map((e) => e.round)) } : null;
  const rises = events.map((e) => e.rise).filter(Number.isFinite);
  const last = S[S.length - 1];
  return {
    n: S.length, secs: Math.round((last.t - S[0].t) / 20), ride: S.some((s) => s.ride), top: Math.round(top * 10) / 10,
    pullAt: pullAt == null ? null : Math.round(pullAt * 10) / 10,
    holdAt: median(holds) == null ? null : Math.round(median(holds) * 10) / 10,
    curve, stuckEvents: events.length,
    patience: events.length ? Math.round(median(events.map((e) => e.patience))) : null,
    flank: flank && { dist: Math.round(flank.dist * 10) / 10, angle: Math.round(flank.angle) },
    blockedRise: rises.length ? Math.round(median(rises) * 10) / 10 : null,
    sling, runway,
    maxSep: Math.round(Math.max(...sep) * 10) / 10,
    snapped: last.leashed === false && S.slice(0, -1).some((s) => s.leashed !== false),
  };
}

/** The player's speed as a fraction of their quickest at this separation, from a learned curve (1 if there isn't one). */
export function speedFrac(curve, d) {
  if (!curve?.length) return 1;
  const row = curve.find((r) => d >= r.from && d < r.to) ?? curve[curve.length - 1];
  return Math.max(0.35, Math.min(1, row.frac)); // (never a standstill from the curve: easing to a stop is the hold distance's job)
}

/** Fold a new session into what's learned already, weighted by how long each watched. */
export function mergeLearned(old, fresh) {
  if (!fresh) return old ?? null;
  if (!old) return { ...fresh, sessions: 1 };
  const w0 = old.secs, w1 = fresh.secs, w = w0 + w1 || 1;
  const mix = (a, b) => (a == null ? b : b == null ? a : Math.round(((a * w0 + b * w1) / w) * 10) / 10);
  return {
    ...fresh, sessions: (old.sessions ?? 1) + 1, secs: w,
    pullAt: mix(old.pullAt, fresh.pullAt), holdAt: mix(old.holdAt, fresh.holdAt), patience: mix(old.patience, fresh.patience),
    blockedRise: mix(old.blockedRise, fresh.blockedRise),
    flank: old.flank && fresh.flank ? { dist: mix(old.flank.dist, fresh.flank.dist), angle: mix(old.flank.angle, fresh.flank.angle) } : fresh.flank ?? old.flank,
    curve: fresh.curve?.length >= (old.curve?.length ?? 0) ? fresh.curve : old.curve,
    sling: fresh.sling ? { ...fresh.sling, byRise: { ...(old.sling?.byRise ?? {}), ...(fresh.sling.byRise ?? {}) }, flat: fresh.sling.flat ?? old.sling?.flat ?? null } : old.sling,
    runway: fresh.runway ?? old.runway,
    maxSep: Math.max(old.maxSep ?? 0, fresh.maxSep ?? 0),
  };
}

/**
 * Did a sling bring the boat? Read from what the boat did, not from where it ended: a boat that never moved looked like it
 * had come (it was "level with us" or "close enough" from the start), 16 slings in a row in the u202 leadboat run, each
 * counted as a success so the stuck count started over and the unstick/reroute never came.
 * m: { snapped, valid (the boat still exists), moved (how far it travelled, blocks), closer (how much nearer to us it ended
 * than the stretch we jumped at), climbed (how much higher it ended than it began) }.
 * It came if it really travelled toward us (at least 1.5 blocks and 1 nearer), or went up the step (0.5 or more).
 */
export function slingCame(m) {
  if (!m || m.snapped || !m.valid) return false;
  return (m.moved >= 1.5 && m.closer >= 1) || m.climbed >= 0.5;
}

/**
 * The stuck counter's key: the same spot if the boat is within `tol` blocks of where the count started (a boat that rocks
 * or creeps a fraction is still stuck; rounding its position to a whole block started the count over whenever it crossed
 * a .5). Returns { anchor, count }.
 */
export function stuckTrack(prev, p, tol = 1.5) {
  if (prev?.anchor && Math.hypot(prev.anchor.x - p.x, prev.anchor.z - p.z) < tol) return { anchor: prev.anchor, count: prev.count + 1 };
  return { anchor: { x: p.x, z: p.z }, count: 1 };
}

/**
 * (u241) The stretch to jump at for a step of this rise, from what was learned: the player's own jumps at that height, else the nearest
 * height they did (a taller step takes a longer stretch, a lower one no more than that), else their overall median. null if nothing learned.
 */
export function learnedStretch(sling, rise) {
  if (!sling) return null;
  const by = sling.byRise ?? {};
  const want = Math.min(4, Math.max(1, Math.ceil(rise)));
  if (by[want] != null) return by[want];
  const keys = Object.keys(by).map(Number).sort((a, b) => a - b);
  const up = keys.find((k) => k > want), down = [...keys].reverse().find((k) => k < want);
  if (down != null) return by[down] + (up != null ? 0 : 0.5 * (want - down));
  if (up != null) return by[up];
  return sling.stretch ?? null;
}
