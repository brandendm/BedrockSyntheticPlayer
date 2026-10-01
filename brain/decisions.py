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

from . import command_parser, mc_commands
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
    def __init__(self, jev: JevClient, llm: LocalLLM, min_confidence: float = 0.7, mc_enabled: bool = True):
        self.mc_enabled = mc_enabled
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

        chain = self.minecraft(text, sender, state)
        if chain:
            return chain

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
            return (self.minecraft(stripped, sender, state) or []) if named else []

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
        chain = self.minecraft(stripped, sender, state)
        if chain:
            return chain
        if intent.value != "unsupported" and intent.confidence >= self.min_conf:
            self.sources["chat_jev"] += 1
            ack = {"come": "Coming.", "follow_me": "Right behind you.", "stop": "Okay, stopping.", "auto": "Back to work.",
                   "dig": "Digging for stone.", "surface": "Heading up.", "memory": None}[intent.value]
            return ([{"type": "say", "text": ack}] if ack else []) + [INTENT_ACTIONS[intent.value](sender)]
        self.sources["chat_unsure"] += 1
        return [{"type": "say", "text": f"Not sure what you want me to do, {sender}."}]

    # ---------- any Minecraft command, chains included ----------

    MC_KINDS = {
        "time": "change the time of day (make it day, night, noon...)",
        "weather": "change the weather (clear, rain, thunderstorm)",
        "gamemode": "change game mode (creative, survival, adventure, spectator)",
        "difficulty": "change the difficulty (peaceful, easy, normal, hard)",
        "heal": "restore the player's health",
        "feed": "restore the player's hunger",
        "none": "something else, or not a game command at all",
    }

    def minecraft(self, text: str, sender: str, state: dict) -> list[dict] | None:
        """"Make it day and clear weather" -> [mc time set day, mc weather clear]. Each clause goes
        through the bot's grammar, then the Minecraft grammar, then Jev (for the finite ones) and the
        local LLM (raw commands, checked). None if nothing in the line was understood."""
        if not self.mc_enabled:
            return None
        bot = state.get("bot") or "Scout"

        def bot_clause(clause):
            p = command_parser.parse(clause, sender)
            return [self._status(state) if a["type"] == "status" else a for a in p.actions] if p else None

        items, unknown = mc_commands.translate(text, sender, bot, other=bot_clause)
        out: list[dict] = []
        for it in items:
            out.extend(it if isinstance(it, list) else [{"type": "mc", "command": it}])
        failed = []
        if not items and unknown:
            unknown = [text]  # nothing read at all: a paraphrase, taken whole rather than cut at its commas
        for clause in unknown:
            cmds = self._mc_fallback(clause, sender, bot)
            if cmds:
                out.extend({"type": "mc", "command": c} for c in cmds)
            else:
                failed.append(clause)
        if not out:
            return None
        self.sources["minecraft"] += 1
        if failed:
            out.append({"type": "say", "text": "I didn't understand: " + "; ".join(failed)})
        return out

    def _mc_fallback(self, clause: str, sender: str, bot: str) -> list[str]:
        """A clause the grammar missed: Jev picks the kind and the finite value, else the local LLM writes the command."""
        if self.jev.available:
            ans = self.jev.decide(
                {"request": clause},
                [
                    Choice("kind", "Which Minecraft game command does the player's request ask for?", self.MC_KINDS),
                    Choice("time_value", "If it is about time of day, what time?", ["day", "night", "noon", "midnight", "sunrise", "sunset"]),
                    Choice("weather_value", "If it is about weather, what weather?", ["clear", "rain", "thunder"]),
                    Choice("gamemode_value", "If it is about game mode, which mode?", ["survival", "creative", "adventure", "spectator"]),
                    Choice("difficulty_value", "If it is about difficulty, which?", ["peaceful", "easy", "normal", "hard"]),
                ],
            )
            if ans and ans["kind"].confidence >= self.min_conf and ans["kind"].value != "none":
                kind = ans["kind"].value
                who = f'"{sender}"'
                made = {
                    "time": lambda: [f"time set {ans['time_value'].value}"],
                    "weather": lambda: [f"weather {ans['weather_value'].value}"],
                    "gamemode": lambda: [f"gamemode {ans['gamemode_value'].value} {who}"],
                    "difficulty": lambda: [f"difficulty {ans['difficulty_value'].value}"],
                    "heal": lambda: [f"effect {who} instant_health 1 255 true"],
                    "feed": lambda: [f"effect {who} saturation 5 255 true"],
                }[kind]()
                self.sources["minecraft_jev"] += 1
                return made
        raw = self.llm.to_minecraft(clause, sender) if hasattr(self.llm, "to_minecraft") else []
        ok = [c for c in (mc_commands.validate(r) for r in raw) if c]
        if ok:
            self.sources["minecraft_llm"] += 1
        return ok

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
