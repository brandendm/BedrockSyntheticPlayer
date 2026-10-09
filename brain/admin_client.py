"""The brain's side of the Bedrock admin service (admin/service.py, a separate program that owns the server process).

The brain holds the *bot* token only: the service itself decides what that token may do (status, the console log, a safe list of console
commands, backups, and chains marked bot_ok). Config keys in brain/config.json:  "admin_url": "http://127.0.0.1:8780", "admin_bot_token": "...".
Used for: POST /admin from the game (`!bot admin ...`), and /locate when the brain does not run the server itself (AdminLocator).
"""
import json
import logging
import re
from urllib import request as urlrequest
from urllib.error import HTTPError

from .serverproc import COORDS, FAIL, PREFIX

log = logging.getLogger("admin_client")


class AdminClient:
    def __init__(self, url: str, token: str, timeout: float = 20.0):
        self.url, self.token, self.timeout = (url or "").rstrip("/"), token or "", timeout

    @property
    def configured(self) -> bool:
        return bool(self.url and self.token)

    def _call(self, method: str, path: str, body=None, timeout=None) -> dict:
        if not self.configured:
            return {"ok": False, "error": "the admin service is not set up (admin_url and admin_bot_token in brain/config.json)"}
        data = json.dumps(body).encode() if body is not None else None
        req = urlrequest.Request(self.url + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        try:
            with urlrequest.urlopen(req, timeout=timeout or self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except HTTPError as e:
            try:
                msg = json.loads(e.read()).get("error", "")
            except Exception:
                msg = ""
            return {"ok": False, "error": f"admin service said {e.code} {msg}".strip()}
        except Exception as e:
            return {"ok": False, "error": f"the admin service did not answer: {e}"}

    def status(self) -> dict:
        return self._call("GET", "/v1/status", timeout=4)

    def console(self, command: str, wait: float = 1.5) -> dict:
        return self._call("POST", "/v1/console", {"command": command, "wait": wait}, timeout=wait + 8)

    def run_chain(self, name: str) -> dict:
        return self._call("POST", "/v1/chains/run", {"name": name}, timeout=90)

    def chains(self) -> dict:
        return self._call("GET", "/v1/chains", timeout=4)

    def backup(self, label: str = "") -> dict:
        return self._call("POST", "/v1/backups", {"label": label}, timeout=120)

    def act(self, body: dict) -> dict:
        """The game's request -> one call. body: { action: status | console | chain | chains | backup, ... } -> a short result with a `say` line."""
        act = str(body.get("action", ""))
        if act == "status":
            r = self.status()
            if "server" not in r:
                return {"ok": False, "say": r.get("error", "no status")}
            s = r["server"]
            return {"ok": True, "say": f"Server {'up %d min' % round(s['up_s'] / 60) if s['running'] else 'stopped'}; world {r['level']}; {r['backups']} backups; {r['chains']} chains."}
        if act == "console":
            r = self.console(str(body.get("command", ""))[:300])
            if not r.get("ok"):
                return {"ok": False, "say": r.get("error", "failed")}
            lines = [PREFIX.sub("", x) for x in r.get("lines", [])]
            return {"ok": True, "say": " | ".join(lines)[:240] or "(no output)", "lines": lines}
        if act == "chain":
            r = self.run_chain(str(body.get("name", ""))[:60])
            if "results" not in r:
                return {"ok": False, "say": r.get("error", "failed")}
            bad = next((x for x in r["results"] if not x["ok"]), None)
            return {"ok": r["ok"], "say": f"Chain ran {len(r['results'])} steps." if r["ok"] else f"Chain stopped at: {bad['line']} ({bad.get('out', '')})"}
        if act == "chains":
            r = self.chains()
            names = [c["name"] for c in r.get("chains", []) if c.get("bot_ok")]
            return {"ok": "chains" in r, "say": ("Chains I may run: " + ", ".join(names)) if names else r.get("error", "No chains are marked for me."), "names": names}
        if act == "backup":
            r = self.backup(str(body.get("label", ""))[:40])
            return {"ok": bool(r.get("ok")), "say": f"Backup saved: {r['name']} ({r['mb']} MB)." if r.get("ok") else r.get("error", "backup failed")}
        return {"ok": False, "say": f"unknown admin action {act}"}


class AdminLocator:
    """Stands in for ServerProc.locate when the admin service owns the server: the same /locate command, typed through the admin console."""

    def __init__(self, client: AdminClient):
        self.client = client

    def alive(self) -> bool:
        return "server" in (s := self.client.status()) and bool(s["server"]["running"])

    def send(self, line: str):
        """(what the auto runs type into the server console) through the admin console, as the bot: a command outside the bot's list is refused there."""
        r = self.client.console(line, wait=0.3)
        if not r.get("ok"):
            log.warning("admin console refused %r: %s", line, r.get("error"))

    def _ask(self, command: str):
        r = self.client.console(command, wait=6.0)
        if not r.get("ok"):
            return ("fail", r.get("error", ""))
        for text in r.get("lines", []):
            body = PREFIX.sub("", text)
            m = COORDS.search(body)
            if m and not body.lower().startswith(("execute", "locate", "running", "player connected", "player disconnected")):
                return (int(m.group(1)), int(m.group(2)))
            if FAIL.search(body):
                return ("fail", body)
        return None

    def locate(self, kind: str, name: str, x=None, z=None, timeout: float = 15.0) -> dict:
        if kind not in ("structure", "biome") or not re.fullmatch(r"[a-z_]+", name or ""):
            return {"error": "bad request"}
        cmds = []
        if x is not None and z is not None:
            cmds.append(f"execute positioned {int(x)} 64 {int(z)} run locate {kind} {name}")
        cmds.append(f"locate {kind} {name}")
        last = None
        for c in cmds:
            last = self._ask(c)
            if isinstance(last, tuple) and last[0] != "fail":
                return {"x": last[0], "z": last[1], "how": "admin console"}
        return {"error": f"no answer ({last[1] if isinstance(last, tuple) else 'silence'}) through the admin console"}
