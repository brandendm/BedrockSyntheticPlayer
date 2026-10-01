"""What the bot can learn from watching you play: your habits, worked out of the recordings.

The game records one player (`!bot learn on`, game/demo.js) and sends rows to the brain, which keeps
them in brain/logs/demos/. This reads them and works out:

  eat_at   the food level you eat at (the bot takes it up after enough samples)
  iron_y   the height you mine iron at (same)

and, for the report only: how long you played, what you broke and placed most, how often you
sprint and sneak, damage by cause, kills, deaths, how much of your time was spent underground, your
mining rate, how far apart you put torches. `python -m brain.learn` prints it all and writes
brain/profile.json; the brain serves it at /profile (what the bot adopts) and /api/profile (everything).

Rows: {"t": ticks since the start, "k": "s"|"b"|"p"|"eat"|"hurt"|"hit"|"kill"|"die"|"start"|"stop", ...}
"""
from __future__ import annotations

import json
import statistics
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEMO_DIR = ROOT / "logs" / "demos"
PROFILE = ROOT / "profile.json"

# What the bot does without having seen you (core/profile.js has the same numbers and the limits).
DEFAULTS = {"eat_at": 14, "iron_y": 16}
IRON_ORES = ("iron_ore", "deepslate_iron_ore")
NOT_FOOD = ("potion", "milk", "bucket", "honey_bottle", "golden_apple", "enchanted_golden_apple", "suspicious_stew")


def load_rows(directory: Path = DEMO_DIR) -> list[list[dict]]:
    """One list of rows per recording (file), in order."""
    out = []
    for f in sorted(directory.glob("*.jsonl")) if directory.exists() else []:
        rows = []
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
        out.append(rows)
    return out


def _median(xs):
    return statistics.median(xs) if xs else None


def analyze(sessions: list[list[dict]]) -> dict:
    """Everything worked out of the recordings: params (what the bot adopts), stats (the report)."""
    eat_levels, iron_ys = [], []
    broke, placed, hurt_by, hits = Counter(), Counter(), Counter(), Counter()
    kills, deaths, eats = Counter(), 0, Counter()
    samples = sprint = sneak = under = ground_samples = 0
    torch_gaps: list[float] = []
    tools = Counter()
    mined = 0
    seconds = 0
    for rows in sessions:
        last_food = None
        last_torch = None
        last_y = None
        for r in rows:
            k = r.get("k")
            if k == "s":
                samples += 1
                seconds += 1
                if r.get("food") is not None:
                    last_food = r["food"]
                sprint += 1 if r.get("sp") else 0
                sneak += 1 if r.get("sn") else 0
                ground_samples += 1 if r.get("g") else 0
                last_y = r.get("y")
                # Underground: low down (the surface is about Y 62-90, so below 50 is a mine or a cave).
                under += 1 if last_y is not None and last_y < 50 else 0
            elif k == "b":
                broke[r.get("id", "?")] += 1
                mined += 1
                if r.get("tool"):
                    tools[r["tool"]] += 1
                if r.get("id") in IRON_ORES and r.get("y") is not None:
                    iron_ys.append(r["y"])
            elif k == "p":
                placed[r.get("id", "?")] += 1
                if r.get("id") in ("torch", "wall_torch", "soul_torch"):
                    pos = (r.get("x", 0), r.get("y", 0), r.get("z", 0))
                    if last_torch is not None:
                        d = ((pos[0] - last_torch[0]) ** 2 + (pos[1] - last_torch[1]) ** 2 + (pos[2] - last_torch[2]) ** 2) ** 0.5
                        if 2 <= d <= 30:
                            torch_gaps.append(d)
                    last_torch = pos
            elif k == "eat":
                item = str(r.get("item", ""))
                eats[item] += 1
                if last_food is not None and last_food < 20 and not any(n in item for n in NOT_FOOD):
                    eat_levels.append(last_food)
            elif k == "hurt":
                hurt_by[str(r.get("cause") or r.get("by") or "?")] += r.get("amt", 0) or 0
            elif k == "hit":
                hits[str(r.get("target", "?"))] += 1
            elif k == "kill":
                kills[str(r.get("mob", "?"))] += 1
            elif k == "die":
                deaths += 1
    minutes = seconds / 60
    params = {
        "eat_at": {"value": _median(eat_levels), "n": len(eat_levels), "default": DEFAULTS["eat_at"]},
        "iron_y": {"value": _median(iron_ys), "n": len(iron_ys), "default": DEFAULTS["iron_y"]},
    }
    stats = {
        "sessions": len(sessions),
        "minutes": round(minutes, 1),
        "blocks_broken": mined,
        "blocks_per_minute": round(mined / minutes, 1) if minutes else 0,
        "broke_top": broke.most_common(8),
        "placed_top": placed.most_common(8),
        "tools": tools.most_common(5),
        "eaten": eats.most_common(5),
        "sprint_pct": round(100 * sprint / samples) if samples else 0,
        "sneak_pct": round(100 * sneak / samples) if samples else 0,
        "underground_pct": round(100 * under / samples) if samples else 0,
        "damage_by": [(k, round(v, 1)) for k, v in hurt_by.most_common(6)],
        "hits_on": hits.most_common(5),
        "kills": kills.most_common(6),
        "deaths": deaths,
        "torch_gap": round(_median(torch_gaps), 1) if torch_gaps else None,
        "iron_y_spread": [min(iron_ys), max(iron_ys)] if iron_ys else None,
    }
    return {"updated": time.strftime("%Y-%m-%d %H:%M:%S"), "params": params, "stats": stats}


def report(profile: dict) -> str:
    s, p = profile["stats"], profile["params"]
    lines = [f"Learned from {s['sessions']} recording(s), {s['minutes']} minutes of you playing:"]
    for name, label in (("eat_at", "you eat at food"), ("iron_y", "you mine iron at Y")):
        q = p[name]
        have = "not enough yet" if q["value"] is None else f"{q['value']:g}"
        lines.append(f"  {label}: {have} ({q['n']} samples; the bot's default is {q['default']})")
    lines += [
        f"  mining: {s['blocks_broken']} blocks, {s['blocks_per_minute']} a minute; mostly {', '.join(f'{k} {n}' for k, n in s['broke_top'][:4]) or '-'}",
        f"  placing: {', '.join(f'{k} {n}' for k, n in s['placed_top'][:4]) or '-'}; torches about {s['torch_gap'] or '?'} blocks apart",
        f"  you sprint {s['sprint_pct']}% of the time, sneak {s['sneak_pct']}%, {s['underground_pct']}% below the surface",
        f"  fights: kills {', '.join(f'{k} {n}' for k, n in s['kills']) or '-'}; damage taken {', '.join(f'{k} {v}' for k, v in s['damage_by']) or '-'}; deaths {s['deaths']}",
    ]
    return "\n".join(lines)


def build(directory: Path = DEMO_DIR) -> dict:
    return analyze(load_rows(directory))


def write(profile: dict, path: Path = PROFILE) -> None:
    path.write_text(json.dumps(profile, indent=2), encoding="utf-8")


def for_game(profile: dict) -> dict:
    """The small version the bot fetches: just { params: { name: {value, n} } }."""
    return {"params": {k: {"value": v["value"], "n": v["n"]} for k, v in profile["params"].items()}}


if __name__ == "__main__":
    prof = build()
    write(prof)
    print(report(prof))
