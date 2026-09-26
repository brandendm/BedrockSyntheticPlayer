"""Event -> actions. Order of escalation, cheapest first:
    1. rules / grammar       (free, instant)
    2. Jev                   (fractions of a cent, ~100-500 ms) - only for real judgment calls
    3. local LLM via Ollama  (free, slow) - only for requests nothing else understood
Every path has a fallback, so the bot works with no API key at all.
"""
from __future__ import annotations

import logging
import re
from collections import Counter

from . import command_parser
from .jev_client import Choice, JevClient, Noul
from .llm_client import LocalLLM

log = logging.getLogger("brain.decisions")

INTENTS = {
    "come": "walk over to the player once",
    "follow_me": "keep following the player around",
    "stop": "stop what it is doing and wait",
    "auto": "go back to working on its own (gathering, crafting, mining)",
    "dig": "get stone: dig down or mine rocks, cobblestone",
    "surface": "get out of a cave or hole, go back up to the surface",
    "memory": "tell the player what it remembers finding",
    "unsupported": "anything else",
}

INTENT_ACTIONS = {
    "come": lambda sender: {"type": "come", "player": sender},
    "follow_me": lambda sender: {"type": "follow", "player": sender},
    "stop": lambda sender: {"type": "stop"},
    "auto": lambda sender: {"type": "auto", "on": True},
    "dig": lambda sender: {"type": "dig"},
    "surface": lambda sender: {"type": "surface"},
    "memory": lambda sender: {"type": "memory"},
}


class DecisionEngine:
    def __init__(self, jev: JevClient, llm: LocalLLM, min_confidence: float = 0.7):
        self.jev = jev
        self.llm = llm
        self.min_conf = min_confidence
        self.sources = Counter()  # which layer made each decision

    def handle(self, evt: dict) -> list[dict]:
        kind = evt.get("type")
        fn = getattr(self, f"on_{kind}", None)
        if fn is None:
            return []
        return fn(evt, evt.get("state", {}))

    # ---------- commands ----------

    def on_command(self, evt: dict, state: dict) -> list[dict]:
        text, sender = evt.get("text", ""), evt.get("sender", "")
        p = command_parser.parse(text, sender)
        if p:
            self.sources["grammar"] += 1
            return [self._status(state) if a["type"] == "status" else a for a in p.actions]

        ans = self.jev.decide(
            {"request": text},
            [Choice("intent", "What does the player want the Minecraft bot to do?", INTENTS)],
        )
        if ans and ans["intent"].confidence >= self.min_conf and ans["intent"].value != "unsupported":
            self.sources["jev"] += 1
            return [INTENT_ACTIONS[ans["intent"].value](sender)]

        cmd = self.llm.to_command(text, sender, state)
        if cmd:
            p = command_parser.parse(cmd, sender)  # LLM output must pass the grammar
            if p:
                self.sources["llm"] += 1
                return p.actions

        self.sources["none"] += 1
        return [{"type": "say", "text": "I don't know how to do that yet."}]

    # ---------- plain chat (the Jev feature) ----------

    def on_chat(self, evt: dict, state: dict) -> list[dict]:
        """Any chat line from a player, no "!bot" prefix. Jev decides, in one call, whether the
        line is meant for the bot and what it asks for; the bot acts only when both are confident.
        Without a key it still reacts to lines that start with or mention its name."""
        text, sender, bot = evt.get("text", ""), evt.get("sender", ""), evt.get("bot", "Scout")
        named = re.search(rf"\b{re.escape(bot)}\b", text, re.I) is not None
        stripped = re.sub(rf"\b{re.escape(bot)}\b[,:!]?", " ", text, flags=re.I).strip()

        if not self.jev.available:
            p = command_parser.parse(stripped, sender) if named else None
            if p:
                self.sources["chat_grammar"] += 1
                return [self._status(state) if a["type"] == "status" else a for a in p.actions]
            return []

        ans = self.jev.decide(
            {"message": text, "speaker": sender, "bot_name": bot, "bot_is_doing": state.get("task", "idle")},
            [
                Noul("addressed", f"Is the speaker talking to the bot named {bot} or asking it to do something, "
                                  "rather than chatting with other people?"),
                Choice("intent", f"If this is a request for {bot}, what does the speaker want it to do?", INTENTS),
            ],
        )
        if not ans:
            return []
        if ans["addressed"].value < (0.5 if named else 0.8):
            self.sources["chat_ignored"] += 1
            return []
        intent = ans["intent"]
        p = command_parser.parse(stripped, sender)  # exact commands with numbers ("go to 10 64 -5")
        if p:
            self.sources["chat_grammar"] += 1
            return p.actions
        if intent.value != "unsupported" and intent.confidence >= self.min_conf:
            self.sources["chat_jev"] += 1
            ack = {"come": "Coming.", "follow_me": "Right behind you.", "stop": "Okay, stopping.", "auto": "Back to work.",
                   "dig": "Digging for stone.", "surface": "Heading up.", "memory": None}[intent.value]
            return ([{"type": "say", "text": ack}] if ack else []) + [INTENT_ACTIONS[intent.value](sender)]
        self.sources["chat_unsure"] += 1
        return [{"type": "say", "text": f"Not sure what you want me to do, {sender}."}]

    def _status(self, state: dict) -> dict:
        p = state.get("pos", {})
        return {"type": "say", "text": f"{state.get('task', 'idle')} at {p.get('x')} {p.get('y')} {p.get('z')}, health {state.get('health')}"}

    # ---------- threats ----------

    def on_hostile_near(self, evt: dict, state: dict) -> list[dict]:
        hostiles = sorted(evt.get("hostiles", []), key=lambda h: h.get("dist", 99))
        if not hostiles:
            return []
        nearest = hostiles[0]
        health = state.get("health") or 20
        flee = {"type": "flee", "from": nearest.get("pos") or state.get("pos"), "distance": 14}

        # Rules for the obvious cases.
        if any(h["type"] == "creeper" and h["dist"] <= 6 for h in hostiles):
            self.sources["rule"] += 1
            return [flee]
        if health <= 6 and nearest["dist"] <= 10:
            self.sources["rule"] += 1
            return [flee]
        if nearest["dist"] > 10:
            self.sources["rule"] += 1
            return []

        # Judgment call: ask Jev with a compact snapshot.
        compact = {
            "health": health,
            "time_of_day": state.get("time"),
            "task": state.get("task"),
            "hostiles": [{"type": h["type"], "dist": h["dist"]} for h in hostiles[:6]],
            "can_fight": False,  # no combat yet (milestone 2+)
        }
        ans = self.jev.decide(compact, [Choice("response", "Best response for a survival bot?", ["flee", "ignore"])])
        if ans and ans["response"].confidence >= 0.6:
            self.sources["jev"] += 1
            return [flee] if ans["response"].value == "flee" else []

        self.sources["rule"] += 1
        return [flee] if len(hostiles) >= 2 or nearest["dist"] <= 5 else []

    # ---------- task lifecycle ----------

    def on_stuck(self, evt: dict, state: dict) -> list[dict]:
        at = evt.get("at") or state.get("pos") or {}
        self.sources["rule"] += 1
        # Milestone 3: hand this to the local LLM / recovery planner (dig, pillar, detour).
        return [{"type": "say", "text": f"I'm stuck near {int(at.get('x', 0))} {int(at.get('y', 0))} {int(at.get('z', 0))}."}]

    def on_task_done(self, evt: dict, state: dict) -> list[dict]:
        return [{"type": "say", "text": "Here."}] if evt.get("task") == "goto" else []

    def on_goto_failed(self, evt: dict, state: dict) -> list[dict]:
        return []

    def on_died(self, evt: dict, state: dict) -> list[dict]:
        return []

    def on_combat(self, evt: dict, state: dict) -> list[dict]:
        # Fight/flee reflexes run in-game (they can't wait on a network call). This is a report,
        # logged for tuning; the brain can react later (e.g. plan to craft a sword after fleeing).
        self.sources[f"reflex_{evt.get('mode')}"] += 1
        return []
