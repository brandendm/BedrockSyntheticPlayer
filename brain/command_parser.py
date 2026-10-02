"""Plain grammar for commands. Free, instant, and handles the common cases, so the
paid model only sees what this can't parse."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

NUM = r"(-?\d+(?:\.\d+)?)"


@dataclass
class Parsed:
    actions: list[dict] = field(default_factory=list)


def _num(s: str) -> float:
    v = float(s)
    return int(v) if v.is_integer() else v


# (pattern, builder(match, sender) -> list[action])
_RULES: list[tuple[re.Pattern, callable]] = [
    (re.compile(rf"^(?:goto|go to|go|walk to|move to)\s+{NUM}[\s,]+{NUM}[\s,]+{NUM}$"),
     lambda m, s: [{"type": "goto", "x": _num(m[1]), "y": _num(m[2]), "z": _num(m[3])}]),
    (re.compile(rf"^(?:goto|go to|go|walk to|move to)\s+{NUM}[\s,]+{NUM}$"),
     lambda m, s: [{"type": "goto", "x": _num(m[1]), "z": _num(m[2])}]),
    (re.compile(r"^(?:come|come here|here|come to me|get over here)$"),
     lambda m, s: [{"type": "come", "player": s}]),
    (re.compile(r"^(?:follow|follow me)$"),
     lambda m, s: [{"type": "follow", "player": s}]),
    (re.compile(r"^follow\s+(\w{1,32})$"),
     lambda m, s: [{"type": "follow", "player": m[1]}]),
    (re.compile(r"^(?:stop|halt|wait|stay|cancel)$"),
     lambda m, s: [{"type": "stop"}]),
    (re.compile(r"^(?:auto|auto on|resume|carry on|keep going|do your thing)$"),
     lambda m, s: [{"type": "auto", "on": True}]),
    (re.compile(r"^(?:dig|dig down|dig for stone|get stone)$"),
     lambda m, s: [{"type": "dig"}]),
    (re.compile(r"^(?:surface|go up|get out|get to the surface|come up)$"),
     lambda m, s: [{"type": "surface"}]),
    (re.compile(r"^(?:memory|where|where is everything\??|what do you remember\??|remember)$"),
     lambda m, s: [{"type": "memory"}]),
    (re.compile(r"^(?:beds|sleep)\s+(on|off)$"),
     lambda m, s: [{"type": "beds", "on": m[1] == "on"}]),
    (re.compile(r"^goals?\s+([a-z]+)\s+(on|off)$"),
     lambda m, s: [{"type": "goal", "goal": m[1], "on": m[2] == "on"}]),
    (re.compile(r"^goals?$"),
     lambda m, s: [{"type": "goal", "goal": "", "on": True}]),
    (re.compile(r"^auto off$"),
     lambda m, s: [{"type": "auto", "on": False}]),
    (re.compile(r"^(?:mount|ride|get on|get on it|(?:get on|mount|ride)(?: on)? (?:your|the|that|a) horse)$"),
     lambda m, s: [{"type": "mount"}]),
    (re.compile(r"^(?:dismount|get off|get off it|get down|(?:get off|dismount)(?: of)? (?:your|the|that|a) horse)$"),
     lambda m, s: [{"type": "dismount"}]),
    (re.compile(r"^(?:tame|find|get|saddle)(?: and (?:saddle|tame))? (?:a |the |your |that )?horse$"),
     lambda m, s: [{"type": "chain", "item": "horse", "n": 1}]),
    (re.compile(rf"^tow (?:the |a )?boat (?:to )?{NUM}[\s,]+{NUM}$"),
     lambda m, s: [{"type": "tow", "x": _num(m[1]), "z": _num(m[2])}]),
    (re.compile(r"^(?:status|what are you doing\??)$"),
     lambda m, s: [{"type": "status"}]),
]


def parse(text: str, sender: str) -> Parsed | None:
    t = " ".join(text.strip().lower().rstrip(".!").split())
    for pat, build in _RULES:
        m = pat.match(t)
        if m:
            return Parsed(build(m, sender))
    return None
