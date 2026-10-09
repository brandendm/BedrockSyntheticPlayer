"""Auto-curriculum (u302): for the tests that come in three difficulty levels, train at the level the bot passes about CURRICULUM_TARGET of the time.

A test it always passes teaches nothing and one it never passes teaches nothing either (a win/loss comparison of two policies is empty at both ends); the useful level is the
one in between. table: {test: {"1": [passes, runs], "2": ..., "3": ...}}, kept by the trainer in trainer/curriculum.json. Each choice is a Thompson draw from every level's
Beta posterior, so a level with few runs still gets tried and the choice follows the bot as it improves.
"""
from __future__ import annotations

import random
import re

TARGET = 0.6
LEVELS = (1, 2, 3)


def level_of(detail: str):
    m = re.search(r"level (\d)", detail or "")
    return int(m.group(1)) if m and int(m.group(1)) in LEVELS else None


def record(table: dict, name: str, level: int, passed: bool) -> None:
    row = table.setdefault(name, {})
    c = row.setdefault(str(level), [0, 0])
    c[0] += 1 if passed else 0
    c[1] += 1


def choose(table: dict, name: str, rng: random.Random):
    """The level to run `name` at, or None if it has never been seen to have levels."""
    row = table.get(name)
    if not row:
        return None
    draws = {}
    for lv in LEVELS:
        p, n = row.get(str(lv), [0, 0])
        draws[lv] = rng.betavariate(1 + p, 1 + n - p)
    return min(LEVELS, key=lambda lv: (abs(draws[lv] - TARGET), lv))
