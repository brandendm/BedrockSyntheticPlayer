"""Make a fresh world's level.dat from an existing one: the same settings (Beta APIs on, game mode, difficulty, cheats), a new seed and name,
and no spawn point or clock, so the server makes a new map and a new spawn the first time it loads it.

    python tools/new_world.py "<template level.dat>" "<new level.dat>" "<world name>"
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from enable_beta_apis import LONG, STRING, load, save  # noqa: E402


def make(template: Path, dest: Path, name: str) -> int:
    version, root_name, root = load(template)
    seed = random.SystemRandom().randint(-(2**62), 2**62)
    root["LevelName"] = (STRING, name)
    root["RandomSeed"] = (LONG, seed)
    for key in ("SpawnX", "SpawnY", "SpawnZ", "Time", "currentTick", "LastPlayed", "dayCycleStopTime"):
        root.pop(key, None)
    dest.parent.mkdir(parents=True, exist_ok=True)
    save(dest, version, root_name, root)
    return seed


if __name__ == "__main__":
    s = make(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
    print(f"New world '{sys.argv[3]}', seed {s}")
