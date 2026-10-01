"""Optional local LLM (Ollama) for the rare "System 2" cases: free-form requests the
grammar and Jev can't map. Free to run. Output is never trusted directly: it must
translate into a command the grammar accepts, or it is discarded."""
from __future__ import annotations

import json
import logging
import urllib.request

log = logging.getLogger("brain.llm")

PROMPT = """You control a Minecraft bot. Translate the player's request into ONE command from this list, or reply UNKNOWN.
Commands: come | follow <player> | stop | goto <x> <y> <z> | goto <x> <z>
The requesting player is {sender}. Bot state: {state}
Request: {text}
Reply with only the command."""


class LocalLLM:
    def __init__(self, url: str | None = "http://127.0.0.1:11434", model: str = "llama3.2:3b", timeout_s: float = 20):
        self.url = url
        self.model = model
        self.timeout = timeout_s

    @property
    def available(self) -> bool:
        return bool(self.url)

    def to_command(self, text: str, sender: str, state: dict) -> str | None:
        if not self.available:
            return None
        body = {
            "model": self.model,
            "prompt": PROMPT.format(sender=sender, state=json.dumps(state), text=text),
            "stream": False,
            "options": {"temperature": 0},
        }
        try:
            req = urllib.request.Request(
                f"{self.url}/api/generate", data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json"}, method="POST",
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                out = json.loads(r.read()).get("response", "").strip().splitlines()
        except Exception as e:  # noqa: BLE001 - any failure just means "no answer"
            log.info("local LLM unavailable: %s", e)
            return None
        cmd = out[0].strip().strip("`\"'") if out else ""
        return None if not cmd or cmd.upper() == "UNKNOWN" else cmd


MC_PROMPT = """You turn a Minecraft Bedrock player's request into slash commands, one per line, no explanations.
Use only: time, weather, gamemode, give, tp, effect, difficulty, gamerule, kill, summon, setblock, fill, clear, enchant, xp, title, playsound, particle, spawnpoint, execute.
Item ids look like diamond_pickaxe (no minecraft: prefix needed). Name the player in double quotes: "{sender}". Use `execute as "{sender}" at @s run <command>` for anything relative to them (~ ~ ~).
If the request is not something a command can do, reply UNKNOWN.
Request: {text}
Commands:"""


def _to_minecraft(self, text: str, sender: str) -> list[str]:
    if not self.available:
        return []
    body = {"model": self.model, "prompt": MC_PROMPT.format(sender=sender, text=text), "stream": False, "options": {"temperature": 0}}
    try:
        req = urllib.request.Request(f"{self.url}/api/generate", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            out = json.loads(r.read()).get("response", "")
    except Exception as e:  # noqa: BLE001
        log.info("local LLM unavailable: %s", e)
        return []
    lines = [ln.strip().strip("`") for ln in out.splitlines() if ln.strip().strip("`").startswith("/")]
    return lines[:6]


LocalLLM.to_minecraft = _to_minecraft
