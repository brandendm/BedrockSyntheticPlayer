"""Statistics for deciding from few real-game runs: confidence intervals, did a build make a test better or worse, and where the next runs should go.

A test run in the game is slow and a sweep is a handful of runs per test, so "0/5 -> 2/5" is noise and "3/4 -> 4/4" says nothing. This module is the rule for when a change counts:
  wilson(k, n)            pass-rate interval (Wilson score, 90%)
  compare(old, new)       one test, two builds: better / worse / same / need_more, from Fisher's exact test on pass rates and Mann-Whitney on the times of the passes
  allocate(stats, n)      where to spend the next n runs: the tests we know least about, the ones that just changed, the ones that need attention; settled ones get few
Pure (no I/O), unit-tested in tests/test_runstats.py.
"""
from __future__ import annotations

import math
from typing import Iterable

Z90 = 1.645


def wilson(k: int, n: int, z: float = Z90) -> tuple:
    """The Wilson score interval for k passes in n runs: (low, high), both 0..1. (0, 1) with no runs."""
    if n <= 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (c - m) / d), min(1.0, (c + m) / d))


def fisher_p(a: int, b: int, c: int, d: int) -> float:
    """Two-sided Fisher exact p for [[a, b], [c, d]] (a, b = old pass/fail; c, d = new pass/fail)."""
    n1, n2, k = a + b, c + d, a + c
    n = n1 + n2
    if n == 0:
        return 1.0
    def pr(x):
        return math.comb(n1, x) * math.comb(n2, k - x) / math.comb(n, k)
    lo, hi = max(0, k - n2), min(n1, k)
    p0 = pr(a)
    return min(1.0, sum(pr(x) for x in range(lo, hi + 1) if pr(x) <= p0 * (1 + 1e-9)))


def mannwhitney_p(x: list, y: list) -> float:
    """Two-sided Mann-Whitney U p-value (normal approximation, tie-corrected); 1.0 when either sample has under 3 values."""
    n1, n2 = len(x), len(y)
    if n1 < 3 or n2 < 3:
        return 1.0
    pooled = sorted([(v, 0) for v in x] + [(v, 1) for v in y])
    ranks, i, ties = [0.0] * len(pooled), 0, 0.0
    while i < len(pooled):
        j = i
        while j + 1 < len(pooled) and pooled[j + 1][0] == pooled[i][0]:
            j += 1
        r = (i + j) / 2 + 1
        for t in range(i, j + 1):
            ranks[t] = r
        t_n = j - i + 1
        ties += t_n ** 3 - t_n
        i = j + 1
    r1 = sum(r for r, (_, g) in zip(ranks, pooled) if g == 0)
    u1 = r1 - n1 * (n1 + 1) / 2
    n = n1 + n2
    mu = n1 * n2 / 2
    sd = math.sqrt(n1 * n2 / 12 * ((n + 1) - ties / (n * (n - 1)))) if n > 1 else 0
    if sd == 0:
        return 1.0
    z = (abs(u1 - mu) - 0.5) / sd
    return math.erfc(max(0.0, z) / math.sqrt(2))


def compare(old: list, new: list, *, min_n: int = 6, alpha: float = 0.1) -> dict:
    """Did `new` runs (a list of {pass, secs}) beat `old` on this test? verdict: need_more | better | worse | same."""
    ko, kn = sum(1 for r in old if r["pass"]), sum(1 for r in new if r["pass"])
    no, nn = len(old), len(new)
    out = {"n_old": no, "n_new": nn, "rate_old": (ko / no) if no else None, "rate_new": (kn / nn) if nn else None,
           "ci_old": wilson(ko, no), "ci_new": wilson(kn, nn)}
    if no < min_n or nn < min_n:
        # (clear-cut at small n still counts: 0/5 -> 5/5 is not noise)
        p = fisher_p(ko, no - ko, kn, nn - kn) if no and nn else 1.0
        if p < alpha / 5 and no >= 3 and nn >= 3:
            out.update(verdict="better" if kn / nn > ko / no else "worse", p_rate=p, why=f"pass rate {ko}/{no} -> {kn}/{nn} (p={p:.3f}) even at this size")
        else:
            out.update(verdict="need_more", p_rate=p, why=f"{min(no, nn)} runs on the smaller side, need {min_n}")
        return out
    p_rate = fisher_p(ko, no - ko, kn, nn - kn)
    to, tn = [r["secs"] for r in old if r["pass"] and r.get("secs")], [r["secs"] for r in new if r["pass"] and r.get("secs")]
    p_time = mannwhitney_p(to, tn)
    out.update(p_rate=p_rate, p_time=p_time)
    mo = sorted(to)[len(to) // 2] if to else None
    mn = sorted(tn)[len(tn) // 2] if tn else None
    out.update(med_old=mo, med_new=mn)
    if p_rate < alpha and kn / nn != ko / no:
        out.update(verdict="better" if kn / nn > ko / no else "worse", why=f"pass rate {ko}/{no} -> {kn}/{nn} (p={p_rate:.3f})")
    elif p_time < alpha and mo and mn and kn / nn >= ko / no - 0.1:
        out.update(verdict="better" if mn < mo else "worse", why=f"median time {mo:.0f}s -> {mn:.0f}s (p={p_time:.3f}), pass rate unchanged")
    else:
        out.update(verdict="same", why="no difference the runs can show")
    return out


def allocate(stats: dict, budget: int, *, cap_share: float = 0.5) -> dict:
    """Spend `budget` runs. stats: name -> {k, n, changed (bool: its code changed since its last runs), attention (bool), retire (bool)}.
    A run's value is the narrowing of that test's interval, so each extra run to the same test is worth less;
    changed tests count double (the new code is unmeasured), attention x1.5, retire candidates x0.25. No test gets more than cap_share of the budget."""
    n_runs = {k: int(v.get("n", 0)) for k, v in stats.items()}
    w0 = {}
    for k, v in stats.items():
        lo, hi = wilson(int(v.get("k", 0)), int(v.get("n", 0)))
        mult = (2.0 if v.get("changed") else 1.0) * (1.5 if v.get("attention") else 1.0) * (0.25 if v.get("retire") else 1.0)
        w0[k] = (hi - lo) * mult
    got = {k: 0 for k in stats}
    cap = max(1, int(budget * cap_share))
    for _ in range(max(0, budget)):
        best, bv = None, -1.0
        for k in stats:
            if got[k] >= cap:
                continue
            n = n_runs[k] + got[k]
            val = w0[k] / (n + 1.5)   # (the interval narrows about like 1/sqrt(n): one more run is worth less the more there are)
            if val > bv:
                best, bv = k, val
        if best is None:
            break
        got[best] += 1
    return {k: v for k, v in got.items() if v}


def runs_since(runs: Iterable, build: str) -> list:
    """The runs that happened on `build`."""
    return [r for r in runs if r.get("build") == build]


def compare_scores(old: list, new: list, *, min_n: int = 6, alpha: float = 0.1, min_gain: float = 0.02) -> dict:
    """(u301) Did `new` beat `old` on the continuous run scores (0..1, core/score.js)? Same verdicts as compare(). A score carries how fast, how hurt and how far a
    failure got, so a few runs say what pass/fail needs dozens for. Mann-Whitney on the scores plus a minimum mean gain, so a real but trivial difference is 'same'."""
    so = [float(r["score"]) for r in old if r.get("score") is not None]
    sn = [float(r["score"]) for r in new if r.get("score") is not None]
    out = {"n_old": len(so), "n_new": len(sn)}
    if len(so) < 3 or len(sn) < 3:
        out.update(verdict="need_more", why="too few scored runs")
        return out
    mo, mn = sum(so) / len(so), sum(sn) / len(sn)
    p = mannwhitney_p(so, sn)
    out.update(mean_old=round(mo, 3), mean_new=round(mn, 3), p_score=p)
    if len(so) < min_n or len(sn) < min_n:
        if p < alpha / 5 and abs(mn - mo) >= min_gain:
            out.update(verdict="better" if mn > mo else "worse", why=f"score {mo:.2f} -> {mn:.2f} (p={p:.3f}) even at this size")
        else:
            out.update(verdict="need_more", why=f"{min(len(so), len(sn))} scored runs on the smaller side, need {min_n}")
        return out
    if p < alpha and abs(mn - mo) >= min_gain:
        out.update(verdict="better" if mn > mo else "worse", why=f"score {mo:.2f} -> {mn:.2f} (p={p:.3f})")
    else:
        out.update(verdict="same", why=f"scores {mo:.2f} -> {mn:.2f}, no difference the runs can show")
    return out
