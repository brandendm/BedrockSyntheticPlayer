"""Learned fight margin (u302): the game logs one `fight_episode` per fight it chose to take (the kill-vs-die race it saw, and how the fight went); this fits
P(bad outcome) against ln(time-to-kill / time-to-die) with a one-variable logistic regression and reports the race ratio at which a fight stops being worth it.

brain/fights/episodes.jsonl   one line per fight
brain/fights/suggest.json     {"n", "bad_rate", "slope", "margin" (the ratio where P(bad) = TARGET), "enough"}; the trainer offers `margin` as a fightMargin candidate once `enough`
brain/fights/report.md        the same in words
Bad = died, or lost more than half the health the fight started with. Pure Python.
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

MIN_N = 150
TARGET = 0.2           # the bad-outcome rate we accept at the margin
LO, HI = 0.35, 1.0     # tunables.js fightMargin's range


def bad(e: dict) -> bool:
    return bool(e.get("died")) or (e.get("hp0") or 0) > 0 and (e.get("lost") or 0) > 0.5 * e["hp0"]


def store(root: Path, evt: dict) -> None:
    d = root / "fights"
    d.mkdir(parents=True, exist_ok=True)
    keep = {k: evt.get(k) for k in ("t", "build", "ratio", "margin", "n", "ranged", "hp0", "lost", "died", "secs", "armor", "shield", "night", "types")}
    keep["t"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with (d / "episodes.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(keep) + "\n")


def load(root: Path, last: int = 3000) -> list:
    f = root / "fights" / "episodes.jsonl"
    if not f.exists():
        return []
    out = []
    for line in f.read_text(encoding="utf-8").splitlines()[-last:]:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if isinstance(e.get("ratio"), (int, float)) and e["ratio"] > 0:
            out.append(e)
    return out


def fit(xs: list, ys: list, iters: int = 400, l2: float = 0.01) -> tuple:
    """Logistic regression y ~ sigmoid(b + w x) by Newton's method. Returns (b, w)."""
    b = w = 0.0
    for _ in range(iters // 10):
        g0 = g1 = h00 = h01 = h11 = 0.0
        for x, y in zip(xs, ys):
            p = 1 / (1 + math.exp(-max(-30, min(30, b + w * x))))
            r, q = p - y, p * (1 - p) + 1e-9
            g0 += r; g1 += r * x; h00 += q; h01 += q * x; h11 += q * x * x
        g1 += l2 * w; h11 += l2
        det = h00 * h11 - h01 * h01
        if abs(det) < 1e-12:
            break
        db, dw = (h11 * g0 - h01 * g1) / det, (h00 * g1 - h01 * g0) / det
        b -= db; w -= dw
        if abs(db) + abs(dw) < 1e-7:
            break
    return b, w


def analyse(episodes: list) -> dict:
    n = len(episodes)
    ys = [1.0 if bad(e) else 0.0 for e in episodes]
    out = {"n": n, "bad_rate": round(sum(ys) / n, 3) if n else None, "enough": False, "margin": None, "slope": None}
    if n < 20 or sum(ys) == 0 or sum(ys) == n:
        return out
    b, w = fit([math.log(e["ratio"]) for e in episodes], ys)
    out["slope"] = round(w, 3)
    if w > 0.05:                       # (a fight that is riskier at a worse ratio: the sensible direction)
        x = (math.log(TARGET / (1 - TARGET)) - b) / w
        out["margin"] = round(min(HI, max(LO, math.exp(x))), 2)
        out["enough"] = n >= MIN_N
    return out


def write_report(root: Path) -> dict:
    eps = load(root)
    res = analyse(eps)
    d = root / "fights"
    d.mkdir(parents=True, exist_ok=True)
    (d / "suggest.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
    lines = ["# Fights the bot chose to take", "", f"{res['n']} fights, {res['bad_rate']} bad (died, or lost over half its health).", ""]
    if res["margin"] is None:
        lines.append("Not enough variety yet to fit (needs both good and bad outcomes, and risk rising with the kill/die ratio).")
    else:
        lines.append(f"Fitted: risk rises with ln(kill time / die time) at slope {res['slope']}; the ratio where a fight is bad {int(TARGET * 100)}% of the time is **{res['margin']}**"
                     f" (fightMargin now starts a fight under 0.6 by default). {'Enough data: the trainer will try it.' if res['enough'] else f'Needs {MIN_N} fights before the trainer uses it.'}")
    (d / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return res
