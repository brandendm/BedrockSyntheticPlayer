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
    const v = pv.filter((_, i) => sep[i] >= EDGES[e] && sep[i] < EDGES[e + 1]);
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
    maxSep: Math.round(Math.max(...sep) * 10) / 10,
    snapped: last.leashed === false && S.slice(0, -1).some((s) => s.leashed !== false),
  };
}

/** The player's speed as a fraction of their quickest at this separation, from a learned curve (1 if there isn't one). */
export function speedFrac(curve, d) {
  if (!curve?.length) return 1;
  const row = curve.find((r) => d >= r.from && d < r.to) ?? curve[curve.length - 1];
  return Math.max(0, Math.min(1, row.frac));
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
    maxSep: Math.max(old.maxSep ?? 0, fresh.maxSep ?? 0),
  };
}
