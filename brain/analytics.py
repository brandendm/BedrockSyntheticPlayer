"""(u277) Pass-rate analytics from the test log: per-test rates, trend, speed against you, one efficiency score, progress over runs and builds.

Efficiency of a test = the bot's recent pass rate x its speed against yours (your median time / its median time, capped at 1.5).
The overall score is the mean over tests you have both run (100 = it passes as often and is as fast as you on every one)."""
from __future__ import annotations

import json
import statistics
from pathlib import Path

SPEED_CAP = 1.5
RECENT = 5
# Retire: mastered. At least RETIRE_MIN counted bot runs, the last RECENT all passed, lifetime rate >= RETIRE_RATE,
# and (when you have a time to compare with) efficiency >= RETIRE_EFF.
RETIRE_MIN, RETIRE_RATE, RETIRE_EFF = 8, 0.9, 0.9
# Needs attention: at least ATTN_MIN bot runs and either the recent pass rate <= ATTN_RATE, efficiency < ATTN_EFF,
# or it is falling (trend down) while below 60%.
ATTN_MIN, ATTN_RATE, ATTN_EFF = 3, 0.4, 0.5


def verdict(b: dict, eff, speed, trend) -> tuple:
    """(status, reason): 'retire' | 'attention' | 'ok' | 'new' (too few runs to say)."""
    if not b.get("n") or b["n"] < ATTN_MIN:
        return "new", "fewer than %d bot runs" % ATTN_MIN
    why = []
    if b["recent_rate"] <= ATTN_RATE:
        why.append("recent pass rate %d%%" % round(b["recent_rate"] * 100))
    if eff is not None and eff < ATTN_EFF:
        why.append("efficiency %d%% of yours" % round(eff * 100))
    if trend == "down" and b["recent_rate"] < 0.6 and not why:
        why.append("getting worse (%d%% now)" % round(b["recent_rate"] * 100))
    if why:
        return "attention", ", ".join(why)
    if b["n"] >= RETIRE_MIN and b["recent_rate"] == 1.0 and b["rate"] >= RETIRE_RATE and (eff is None or eff >= RETIRE_EFF):
        return "retire", "%d/%d passed, last %d clean%s" % (b["p"], b["n"], RECENT, "" if eff is None else ", efficiency %d%%" % round(eff * 100))
    return "ok", ""


def load_runs(log_dir: Path) -> list:
    """Every counted test_run in order: {t, name, who, pass, secs, build}."""
    rows = []
    for fn in ("tests.prev.jsonl", "tests.jsonl", "test_history.jsonl"):
        try:
            lines = (log_dir / fn).read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") != "test_run" or e.get("stopped") or not e.get("name") or not e.get("who"):
                continue
            s = e.get("summary") or {}
            rows.append({"t": e.get("t", ""), "name": str(e["name"]), "who": str(e["who"]), "pass": bool(e.get("pass")),
                         "secs": s.get("secs") if isinstance(s.get("secs"), (int, float)) else None,
                         "build": e.get("build") or s.get("build")})
    seen, out = set(), []
    for r in sorted(rows, key=lambda r: r["t"]):  # tests.jsonl rolls into .prev and history repeats: drop duplicates
        k = (r["t"], r["name"], r["who"])
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


def _side(runs: list) -> dict:
    n = len(runs)
    if not n:
        return {"n": 0}
    p = sum(1 for r in runs if r["pass"])
    pass_secs = [r["secs"] for r in runs if r["pass"] and r["secs"]]
    rec = runs[-RECENT:]
    prior = runs[-2 * RECENT:-RECENT]
    return {"n": n, "p": p, "rate": p / n, "recent_rate": sum(1 for r in rec if r["pass"]) / len(rec),
            "prior_rate": (sum(1 for r in prior if r["pass"]) / len(prior)) if prior else None,
            "med_secs": statistics.median(pass_secs) if pass_secs else None,
            "recent_secs": statistics.median([r["secs"] for r in rec if r["pass"] and r["secs"]] or [0]) or None,
            "pips": [1 if r["pass"] else 0 for r in runs[-10:]], "last": runs[-1]["pass"]}


def compute(rows: list) -> dict:
    names = sorted({r["name"] for r in rows})
    per = []
    for n in names:
        h = _side([r for r in rows if r["name"] == n and r["who"] == "human"])
        b = _side([r for r in rows if r["name"] == n and r["who"] == "bot"])
        speed = eff = None
        if b.get("n") and h.get("med_secs") and b.get("recent_secs"):
            speed = min(SPEED_CAP, h["med_secs"] / b["recent_secs"])
        if b.get("n") and h.get("n"):
            eff = b["recent_rate"] * (speed if speed is not None else 1.0)
        trend = None
        if b.get("prior_rate") is not None:
            d = b["recent_rate"] - b["prior_rate"]
            trend = "up" if d > 0.15 else "down" if d < -0.15 else "flat"
        status, why = verdict(b, eff, speed, trend)
        per.append({"name": n, "human": h, "bot": b, "speed": speed, "efficiency": eff, "trend": trend, "status": status, "why": why})
    effs = [p["efficiency"] for p in per if p["efficiency"] is not None]
    bot = [r for r in rows if r["who"] == "bot"]
    hum = [r for r in rows if r["who"] == "human"]
    rate = lambda rs: (sum(1 for r in rs if r["pass"]) / len(rs)) if rs else None
    # progress: rolling pass rate over the bot's runs (window 10), and by build
    roll = []
    for i in range(len(bot)):
        w = bot[max(0, i - 9):i + 1]
        roll.append({"i": i + 1, "t": bot[i]["t"], "build": bot[i]["build"], "rate": rate(w)})
    builds, order = {}, []
    for r in bot:
        k = r["build"] or "?"
        if k not in builds:
            builds[k] = []
            order.append(k)
        builds[k].append(r)
    by_build = [{"build": k, "n": len(builds[k]), "rate": rate(builds[k]), "secs": statistics.median([x["secs"] for x in builds[k] if x["pass"] and x["secs"]] or [0]) or None} for k in order]
    last20, prev20 = bot[-20:], bot[-40:-20]
    improved = sorted([p for p in per if p["trend"] == "up"], key=lambda p: -(p["bot"]["recent_rate"] - p["bot"]["prior_rate"]))
    regressed = sorted([p for p in per if p["trend"] == "down"], key=lambda p: p["bot"]["recent_rate"] - p["bot"]["prior_rate"])
    return {"tests": per,
            "overall": {"bot_rate": rate(bot), "human_rate": rate(hum), "bot_runs": len(bot), "human_runs": len(hum),
                        "efficiency": (sum(effs) / len(effs) * 100) if effs else None, "efficiency_n": len(effs),
                        "last20": rate(last20), "prev20": rate(prev20) if prev20 else None,
                        "gap": [p["name"] for p in sorted(per, key=lambda p: (p["efficiency"] if p["efficiency"] is not None else 9)) if p["efficiency"] is not None and p["efficiency"] < 0.8][:8]},
            "retire": [p["name"] for p in per if p["status"] == "retire"], "attention": [p["name"] for p in per if p["status"] == "attention"],
            "rolling": roll[-300:], "by_build": by_build[-24:],
            "improved": [p["name"] for p in improved[:6]], "regressed": [p["name"] for p in regressed[:6]]}
