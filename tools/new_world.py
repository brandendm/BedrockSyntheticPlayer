"""Make a fresh world's level.dat from an existing one: the same settings (Beta APIs on, game mode, difficulty, cheats), a new seed and name,
and an unset spawn point (y 32767) and no clock, so the server makes a new map and chooses a land spawn the first time it loads it.

    python tools/new_world.py "<template level.dat>" "<new level.dat>" "<world name>"
"""
from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from enable_beta_apis import INT, LONG, STRING, load, save  # noqa: E402


def make(template: Path, dest: Path, name: str) -> int:
    version, root_name, root = load(template)
    seed = random.SystemRandom().randint(-(2**62), 2**62)
    root["LevelName"] = (STRING, name)
    root["RandomSeed"] = (LONG, seed)
    for key in ("Time", "currentTick", "LastPlayed", "dayCycleStopTime"):
        root.pop(key, None)
    # (u296) NOT removed: a level.dat without the spawn keys loads as (0, 0, 0), bedrock level, so players started in caves or at the bottom of an ocean. SpawnY 32767 is
    # the game's own "not chosen yet" marker: it looks for a land spawn on first load. (The behavior pack checks it again: main.js fixWorldSpawn.)
    root["SpawnX"], root["SpawnY"], root["SpawnZ"] = (INT, 0), (INT, 32767), (INT, 0)
    dest.parent.mkdir(parents=True, exist_ok=True)
    save(dest, version, root_name, root)
    return seed


if __name__ == "__main__":
    s = make(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
    print(f"New world '{sys.argv[3]}', seed {s}")
