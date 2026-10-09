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


# ---- the fix queue (u301) --------------------------------------------------------------------------------------------------------------
# For each of the top failures a folder in brain/fixqueue/ with everything needed to fix it in one sitting: what failed and how often, the last runs'
# detail text, the newest repro capsule for that test, and the code to start from. Whoever fixes things (a session with Claude, you) clears the queue top-down
# instead of rediscovering each failure from the logs.
import re as _re
import shutil as _shutil

# test family / failure signal -> where to look first
CODE_HINTS = [
    (_re.compile(r"^(thicket|jungle|swamp|ambush|siege|mobmaze|minecollapse|lavafield|raid|chasm)\b"), ["behavior_pack/scripts/core/terrain.js (the course)", "behavior_pack/scripts/game/scenarios.js (case 'thicket'... the test)", "behavior_pack/scripts/core/threat.js, core/tactics.js (fight or flee)"]),
    (_re.compile(r"^(cave\w*|oceandrop|oceandeep)\b"), ["behavior_pack/scripts/core/caves.js, core/ocean.js (the course)", "behavior_pack/scripts/game/skills.js (toSurface, needsEscape, walkOut)", "behavior_pack/scripts/game/scenarios.js (case 'caveescape'...)"]),
    (_re.compile(r"^lead|^villager|^boat"), ["behavior_pack/scripts/game/leadtow.js", "behavior_pack/scripts/core/towtune.js, core/towcourses.js", "sim/run_tow.mjs (reproduce offline)"]),
    (_re.compile(r"^bench stall"), ["behavior_pack/scripts/game/agent.js (runAuto, planStep)", "behavior_pack/scripts/core/plan*.js", "behavior_pack/scripts/game/bench.js"]),
    (_re.compile(r"^bench death"), ["behavior_pack/scripts/core/threat.js", "behavior_pack/scripts/game/agent.js (restNeeded, hurtNoFood)", "behavior_pack/scripts/core/rest.js"]),
]


def _slug(s: str) -> str:
    return _re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "failure"


def _capsule_for(root: Path, name: str) -> str:
    f = root / "logs" / "capsules.jsonl"
    best = ""
    try:
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines()[-300:]:
            if f"test {name} failed" in line[:400]:
                best = line
    except OSError:
        pass
    return best[:7000]


def write_fixqueue(root: Path, top: int = 8) -> list:
    """Rewrite brain/fixqueue/: one folder per top failure cluster (README.md + last_runs.txt + capsule.json), plus INDEX.md. Returns the cluster keys written."""
    m = mine(root)
    tests = _read_jsonl(root / "logs" / "tests.jsonl", 4000)
    q = root / "fixqueue"
    keys = [k for k, _ in m["clusters"][:top]]
    try:
        q.mkdir(parents=True, exist_ok=True)
        for old in q.iterdir():
            if old.is_dir() and old.name not in {_slug(k) for k in keys}:
                _shutil.rmtree(old, ignore_errors=True)
        index = ["# Fix queue", "", "Top failures, worst first. Each folder has what is needed to fix it. Clear from the top; the list rewrites itself as training and tests run.", ""]
        for rank, key in enumerate(keys, 1):
            count = dict(m["clusters"])[key]
            test = key.split(":")[0]
            d = q / _slug(key)
            d.mkdir(exist_ok=True)
            runs = [e for e in tests if e.get("type") == "test_result" and e.get("who") != "human" and e.get("name") == test]
            fails = [e for e in runs if not e.get("pass")]
            hints = next((h for rx, h in CODE_HINTS if rx.match(key) or rx.match(test)), ["(no hint: grep the test's name in behavior_pack/scripts/game/scenarios.js)"])
            rate = f"{len(runs) - len(fails)}/{len(runs)}" if runs else "n/a"
            (d / "README.md").write_text(
                f"# {key}\n\nRank {rank}, seen {count} times. Pass rate over the logged runs of `{test}`: {rate}.\n\n## Start here\n" + "\n".join(f"- {h}" for h in hints) +
                "\n\n## To reproduce\n`!bot test " + test + "` in game, or queue it: `{\"tests\":[\"" + test + "\"],\"reload\":true,\"workers\":1}` in brain/inbox/run.json (Auto runs on).\n"
                "\n## Then\nFix, add a unit test, bump the build, ship, and run the test 3+ times (a single pass proves little).\n", encoding="utf-8")
            (d / "last_runs.txt").write_text("\n".join(f"{e.get('t', '')}  {'PASS' if e.get('pass') else 'FAIL'}  {str(e.get('detail', ''))[:300]}" for e in runs[-12:]) + "\n", encoding="utf-8")
            cap = _capsule_for(root, test)
            if cap:
                (d / "capsule.json").write_text(cap, encoding="utf-8")
            index.append(f"{rank}. **{key}** ({count}x) -> `{d.name}/`")
        (q / "INDEX.md").write_text("\n".join(index) + "\n", encoding="utf-8")
    except OSError:
        pass
    return keys
