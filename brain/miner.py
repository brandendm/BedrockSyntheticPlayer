"""Failure miner (u301): what keeps going wrong, found from the runs the bot already does, ranked, and used to aim the next training runs.

Sources: brain/logs/tests.jsonl (every test result with its detail text), brain/bench/runs.jsonl (benchmark stalls and deaths, with what the bot was doing).
Each failure becomes a cluster key ("raid: died while fleeing", "bench stall: shelter @plan", "caveascent: still below the surface"), counted and ranked by how often and how recently.
`write_report(root)` writes brain/failures.md (for reading) and brain/failures.json; `hot_tests(root, names)` says which of a group's tests need the runs.
Pure functions over parsed lines; the I/O is only in read_*/write_report. Tests: brain/tests/test_miner.py.
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path


def _cause(detail: str) -> str:
    d = detail.lower()
    if "died" in d or "dead" in d:
        return "died" + (" while fleeing" if "flee" in d else "")
    if "below" in d:
        return "still below the surface"
    if "short of" in d:
        return "stopped short of the goal"
    if "did not" in d or "didn't" in d or "never" in d:
        return "step did not happen"
    if "timed out" in d or "gave up" in d:
        return "gave up"
    return "failed"


def cluster_tests(events: list) -> Counter:
    """test_result events -> Counter of 'test: cause' for the failures."""
    c: Counter = Counter()
    for e in events:
        if e.get("type") == "test_result" and e.get("who") != "human" and not e.get("pass"):
            c[f"{e.get('name')}: {_cause(str(e.get('detail', '')))}"] += 1
    return c


def cluster_bench(runs: list) -> Counter:
    """Benchmark records -> Counter of stall and death keys, weighted by how many stalls (each is a minute without progress)."""
    c: Counter = Counter()
    for rec in runs:
        for r in rec.get("runs") or []:
            for s in r.get("stalls") or []:
                where = f" @{s['where']}" if s.get("where") else ""
                c[f"bench stall: {s.get('step') or '-'} / {s.get('mode') or '-'}{where} (after {s.get('last') or 'nothing'})"] += 1
            for d in r.get("deaths") or []:
                c[f"bench death: {d.get('cause') or 'unknown'} while {d.get('step') or '-'}"] += 3
    return c


def pass_rates(events: list) -> dict:
    """name -> [passed, tried] over the bot's test results."""
    out: dict = defaultdict(lambda: [0, 0])
    for e in events:
        if e.get("type") == "test_result" and e.get("who") != "human":
            out[e.get("name")][1] += 1
            out[e.get("name")][0] += 1 if e.get("pass") else 0
    return dict(out)


def hot_tests(rates: dict, names: list, *, keep_settled: int = 2, min_runs: int = 4, settled_at: float = 0.9) -> list:
    """Of a group's tests, the ones worth the runs: every one that is not settled (under `settled_at` pass rate, or too few runs to know), and only
    `keep_settled` of the settled ones (the first not run longest is up to the caller; here the alphabetically rotating head) so a confirm round is
    spent where the information is. Never returns fewer than 3 (or all of them if fewer)."""
    unsettled = [n for n in names if n not in rates or rates[n][1] < min_runs or rates[n][0] / rates[n][1] < settled_at]
    settled = [n for n in names if n not in unsettled]
    out = unsettled + settled[:keep_settled]
    if len(out) < min(3, len(names)):
        out += [n for n in names if n not in out][: min(3, len(names)) - len(out)]
    return [n for n in names if n in out]


def _read_jsonl(f: Path, tail: int) -> list:
    out = []
    try:
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines()[-tail:]:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        pass
    return out


def mine(root: Path) -> dict:
    tests = _read_jsonl(root / "logs" / "tests.jsonl", 4000)
    bench = _read_jsonl(root / "bench" / "runs.jsonl", 20)
    clusters = cluster_tests(tests) + cluster_bench(bench)
    return {"clusters": clusters.most_common(25), "rates": pass_rates(tests)}


def write_report(root: Path) -> dict:
    m = mine(root)
    try:
        (root / "failures.json").write_text(json.dumps(m), encoding="utf-8")
        lines = ["# What keeps going wrong", "", "Ranked from the bot's own test results and benchmark runs (brain/miner.py). Fix the top of this list first.", "", "| count | failure |", "|---|---|"]
        lines += [f"| {n} | {k} |" for k, n in m["clusters"]]
        weak = sorted(((v[0] / v[1], k, v) for k, v in m["rates"].items() if v[1] >= 3))[:10]
        lines += ["", "## Weakest tests", "", "| test | passed |", "|---|---|"] + [f"| {k} | {v[0]}/{v[1]} |" for _, k, v in weak]
        (root / "failures.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass
    return m
