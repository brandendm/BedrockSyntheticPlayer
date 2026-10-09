"""The progression benchmark's results (u296): what the game's `bench` test sends (a `bench_result` event), kept as a history and a leaderboard.

brain/bench/runs.jsonl   one line per benchmark (build, minutes, per-bot results, the summary)
brain/bench/leaderboard.md   the last runs side by side, the failures ranked, and what to fix next
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

KEEP = 40


def store(root: Path, evt: dict) -> dict:
    """Append a benchmark result; rewrite the leaderboard. Returns the compact record."""
    d = root / "bench"
    d.mkdir(parents=True, exist_ok=True)
    summary = evt.get("summary") or {}
    rec = {
        "t": time.strftime("%Y-%m-%d %H:%M:%S"), "build": evt.get("build"), "minutes": evt.get("minutes"), "ran_s": evt.get("ran_s"), "bots": evt.get("bots"),
        "summary": summary, "runs": evt.get("runs") or [], "notes": evt.get("notes") or [], "policy": evt.get("policy"),
    }
    with (d / "runs.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")
    write_leaderboard(root)
    return rec


def read(root: Path, n: int = KEEP) -> list:
    f = root / "bench" / "runs.jsonl"
    out = []
    try:
        for line in f.read_text(encoding="utf-8").splitlines()[-n:]:
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        pass
    return out


def weakest(summary: dict) -> Optional[str]:
    for m in summary.get("milestones") or []:
        if m.get("reached", 0) < m.get("of", 0):
            return m.get("id")
    return None


def fmt_s(s) -> str:
    if s is None:
        return "-"
    return f"{int(s) // 60}:{int(s) % 60:02d}"


def write_leaderboard(root: Path) -> str:
    runs = read(root, 12)
    lines = ["# Progression benchmark", "", f"Written {time.strftime('%Y-%m-%d %H:%M:%S')}. Bots start with nothing, on dry land far apart, and play alone.", ""]
    if not runs:
        lines.append("No runs yet. Run `!bot test bench 15` (or add `bench` to a run request).")
    else:
        lines += ["| when | build | bots x min | score (median) | deaths | furthest milestone (median time) | next to fix |", "|---|---|---|---|---|---|---|"]
        for r in reversed(runs):
            s = r.get("summary") or {}
            reached = [m for m in (s.get("milestones") or []) if m.get("reached")]
            far = f"{reached[-1]['id']} ({fmt_s(reached[-1].get('median_s'))})" if reached else "none"
            lines.append(f"| {r.get('t')} | {r.get('build')} | {r.get('bots')} x {r.get('minutes')} | {s.get('score_median')} | {s.get('deaths')} | {far} | {weakest(s) or 'all reached'} |")
        last = runs[-1]
        s = last.get("summary") or {}
        lines += ["", f"## Latest run ({last.get('t')}, build {last.get('build')})", "", "| milestone | reached | median time |", "|---|---|---|"]
        for m in s.get("milestones") or []:
            lines.append(f"| {m.get('id')} | {m.get('reached')}/{m.get('of')} | {fmt_s(m.get('median_s'))} |")
        if s.get("top_stalls"):
            lines += ["", "## Where it stalls (a minute with nothing new and no movement): step / mode", ""] + [f"- {x['what']}: {x['count']}" for x in s["top_stalls"]]
        if s.get("top_deaths"):
            lines += ["", "## How it dies", ""] + [f"- {x['what']}: {x['count']}" for x in s["top_deaths"]]
        for n in last.get("notes") or []:
            lines.append(f"- note: {n}")
    text = "\n".join(lines) + "\n"
    try:
        (root / "bench").mkdir(parents=True, exist_ok=True)
        (root / "bench" / "leaderboard.md").write_text(text, encoding="utf-8")
    except OSError:
        pass
    return text
