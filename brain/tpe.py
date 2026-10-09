"""Bayesian-style suggestion for the real-game-only groups (u301): a Tree-structured Parzen Estimator in pure Python (no numpy, nothing to install).

The old way was one random small step from the champion, and every past run was thrown away. TPE (Bergstra et al.) keeps all of them: split the history into the better
quarter and the rest, model each with a kernel density over the (unit-scaled) parameters, and suggest the candidate where good-density over bad-density is highest among
many random draws. With few runs it explores; as the history grows it homes in. History entries: {"params": {key: value}, "score": float (higher is better)}.
"""
from __future__ import annotations

import math
import random


def _unit(v: float, lo: float, hi: float) -> float:
    return 0.5 if hi <= lo else min(1.0, max(0.0, (v - lo) / (hi - lo)))


def _kde(points: list, x: list, bw: float) -> float:
    """Mean Gaussian-kernel density of `points` at `x` (all in the unit cube), with a uniform floor so an empty region is never zero."""
    if not points:
        return 1.0
    s = 0.0
    for p in points:
        d2 = sum((a - b) ** 2 for a, b in zip(p, x))
        s += math.exp(-d2 / (2 * bw * bw))
    return 0.1 + s / len(points)


def suggest(history: list, ranges: dict, rng: random.Random, *, base: dict | None = None, gamma: float = 0.25, n_cand: int = 96, min_hist: int = 6) -> dict:
    """The next parameter set to try. ranges: key -> (lo, hi, default). base: the values for keys not in `ranges` (the champion's other constants). Returns a full dict."""
    keys = sorted(ranges)
    base = dict(base or {})
    hist = [h for h in history if h.get("score") is not None and all(k in h["params"] or True for k in keys)]

    def vec(params):
        return [_unit(params.get(k, ranges[k][2]), ranges[k][0], ranges[k][1]) for k in keys]

    def draw(center=None, spread=0.15):
        if center is None or rng.random() < 0.3:
            return [rng.random() for _ in keys]
        return [min(1.0, max(0.0, c + rng.gauss(0, spread))) for c in center]

    if len(hist) < min_hist:
        # explore: a draw around the best so far if there is one, else anywhere
        best = max(hist, key=lambda h: h["score"]) if hist else None
        u = draw(vec(best["params"]) if best else None, 0.2)
    else:
        ordered = sorted(hist, key=lambda h: -h["score"])
        k = max(2, int(math.ceil(gamma * len(ordered))))
        good, bad = [vec(h["params"]) for h in ordered[:k]], [vec(h["params"]) for h in ordered[k:]]
        bw = max(0.08, 0.5 * len(keys) ** 0.5 / (len(hist) ** (1 / (len(keys) + 4))) * 0.5)
        cands = [draw(rng.choice(good), 0.12) for _ in range(n_cand)]
        u = max(cands, key=lambda c: _kde(good, c, bw) / _kde(bad, c, bw))
    out = dict(base)
    for k, v in zip(keys, u):
        lo, hi, _ = ranges[k]
        out[k] = round(lo + v * (hi - lo), 3)
    return out


def suggest_optuna(history: list, ranges: dict, rng: random.Random, *, base: dict | None = None, min_hist: int = 6):
    """The same job done by Optuna's TPE sampler (u302: on a noisy 5-parameter hill it got within 0.03 of the best where the pure-Python one above did no better than random). The
    history is replayed into a fresh study each call, so nothing is kept in memory. Returns None when optuna is not installed (the caller falls back to `suggest`)."""
    try:
        import optuna
        from optuna.distributions import FloatDistribution
    except ImportError:
        return None
    optuna.logging.set_verbosity(optuna.logging.ERROR)
    keys = sorted(ranges)
    dist = {k: FloatDistribution(ranges[k][0], ranges[k][1]) for k in keys}
    study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=rng.randrange(1 << 30), n_startup_trials=min_hist, multivariate=True))
    for h in history:
        if h.get("score") is None:
            continue
        ps = {k: min(ranges[k][1], max(ranges[k][0], h["params"].get(k, ranges[k][2]))) for k in keys}
        study.add_trial(optuna.trial.create_trial(params=ps, distributions=dist, value=float(h["score"])))
    t = study.ask(dist)
    out = dict(base or {})
    for k in keys:
        out[k] = round(t.params[k], 3)
    return out
