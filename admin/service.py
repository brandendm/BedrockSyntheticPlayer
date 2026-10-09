"""The Bedrock admin service: a program of its own (not part of the brain or the bot) that owns the Bedrock Dedicated Server process.

  python -m admin.service            start it (the panel is at http://127.0.0.1:8780/, the owner token is printed the first time and kept in admin/config.json)
  python -m admin.service --open     the same and open the panel in the browser, already signed in

What it does that nothing inside the game can: start, stop and restart the server, type console commands and read what they print, take hot
backups (the server's own `save hold` / `save query` / `save resume`, files cut to the lengths it reports) and restore them, edit server.properties,
and run saved command chains. Two kinds of caller, each with its own token and its own list of what it may do:

  owner   you (the panel): everything.
  bot     the bot (through the brain: brain/admin_client.py): status, the console log, a safe list of console commands (time, weather, gamerule,
          give, summon, event, effect, ride...), taking a backup, and the chains you have marked bot_ok. Never stop/restart/restore, op or permission
          changes, kick, allowlist, scriptevent, properties, or editing chains.

Every call is written to admin/audit.jsonl (who, what, result). Standard library only.
"""
from __future__ import annotations

import argparse
import collections
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import request as urlrequest
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent

DEFAULTS = {
    "host": "127.0.0.1",
    "port": 8780,
    "server_dir": str(REPO / "server"),
    "server_cmd": None,                       # default: <server_dir>/bedrock_server(.exe)
    "autostart": False,
    "brain_url": "http://127.0.0.1:8765",     # chain lines "game ..." are queued here for the bot/dashboard
    "backups_dir": str(ROOT / "backups"),
    "keep_backups": 20,
    "bot_verbs": ["time", "weather", "gamerule", "give", "summon", "event", "effect", "say", "tell", "tp", "teleport", "setblock", "fill", "clear",
                  "replaceitem", "ride", "locate", "difficulty", "xp", "enchant", "playsound", "particle", "title", "list", "kill", "structure", "camera"],
}
BOT_ACTIONS = {"players", "status", "console", "console_log", "backup_create", "backups_list", "chain_run", "chains_list"}


# ---------- config ----------

def load_config(path: Path) -> dict:
    """admin/config.json merged over the defaults; created on first run with fresh random owner and bot tokens."""
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    toks = dict(cfg.get("tokens") or {})
    changed = not path.exists()
    for who in ("owner", "bot"):
        if not toks.get(who):
            toks[who] = secrets.token_urlsafe(24)
            changed = True
    cfg["tokens"] = toks
    if changed:
        path.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    return cfg


def role_of(tokens: dict, presented: str | None) -> str | None:
    """'owner' | 'bot' | None for a presented token (constant-time compare)."""
    if not presented:
        return None
    for who in ("owner", "bot"):
        if hmac.compare_digest(str(tokens.get(who, "")), presented):
            return who
    return None


# ---------- what a role may type into the console ----------

DENIED_ANYWHERE = re.compile(r"[\r\n;]")


def console_allowed(role: str, command: str, verbs) -> tuple[bool, str]:
    """(ok, why). The owner may type anything. The bot only commands whose verb (also the verb after each `run` of an execute) is in the list."""
    cmd = command.strip().lstrip("/").strip()
    if not cmd:
        return False, "empty command"
    if DENIED_ANYWHERE.search(cmd):
        return False, "one command per line"
    if role == "owner":
        return True, ""
    verbs = set(verbs)
    parts = re.split(r"\brun\b", cmd) if cmd.split()[0] == "execute" else [cmd]
    for i, part in enumerate(parts):
        words = part.split()
        if i == 0 and len(parts) > 1:
            continue        # (the "execute as ... at ..." part before the first run)
        verb = words[0].lower() if words else ""
        if verb not in verbs:
            return False, f"the bot may not use {verb or 'that'}"
    if len(parts) > 1 and not parts[-1].split():
        return False, "execute needs a command after run"
    return True, ""


# ---------- a target player ----------

TARGET_OK = re.compile(r"[A-Za-z0-9 _.-]{1,32}")


def with_target(command: str, target: str | None) -> str:
    """Run `command` as the target player, standing where they stand (so @s, ~ ~ ~ and @e[...,c=1] mean them): execute as "Name" at @s run ... ."""
    cmd = command.strip().lstrip("/").strip()
    if not target:
        return cmd
    if not TARGET_OK.fullmatch(target):
        raise ValueError("bad target name")
    return f'execute as "{target}" at @s run {cmd}'


def parse_players(lines: list[str]) -> list[str]:
    """The names in the server's answer to `list`: 'There are 2/10 players online:' then 'Alice, Bob'."""
    for i, text in enumerate(lines):
        if re.search(r"players online", text, re.I):
            names = []
            for nxt in lines[i + 1:i + 3]:
                body = re.sub(r"^\s*\[[^\]]*\]\s*", "", nxt).strip()
                if body and not re.search(r"players online", body, re.I):
                    names += [n.strip() for n in body.split(",") if n.strip()]
            return names
    return []


# ---------- the server process ----------

class ServerManager:
    def __init__(self, cmd: list[str], cwd: Path, log_path: Path | None = None):
        self.cmd, self.cwd, self.log_path = cmd, cwd, log_path
        self.proc: subprocess.Popen | None = None
        self.started_at = 0.0
        self.lines: collections.deque = collections.deque(maxlen=4000)   # (seq, time, text)
        self.seq = 0
        self.cv = threading.Condition()
        self.cmd_lock = threading.Lock()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> dict:
        if self.alive():
            return {"ok": False, "error": "already running", "pid": self.proc.pid}
        try:
            self.proc = subprocess.Popen(self.cmd, cwd=str(self.cwd), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         text=True, bufsize=1, errors="replace")
        except OSError as e:
            return {"ok": False, "error": f"could not start: {e}"}
        self.started_at = time.time()
        threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()
        return {"ok": True, "pid": self.proc.pid}

    def _read(self, proc):
        log = None
        try:
            if self.log_path:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                log = open(self.log_path, "a", encoding="utf-8", errors="replace")
        except OSError:
            log = None
        for raw in proc.stdout:
            text = raw.rstrip("\r\n")
            with self.cv:
                self.seq += 1
                self.lines.append((self.seq, time.time(), text))
                self.cv.notify_all()
            if log:
                try:
                    log.write(text + "\n")
                    log.flush()
                except OSError:
                    pass
        with self.cv:
            self.seq += 1
            self.lines.append((self.seq, time.time(), "[admin] the server process ended"))
            self.cv.notify_all()
        if log:
            log.close()

    def send(self, line: str) -> bool:
        try:
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
            return True
        except Exception:
            return False

    def stop(self, timeout: float = 30.0) -> dict:
        if not self.alive():
            return {"ok": True, "was_running": False}
        self.send("stop")
        try:
            self.proc.wait(timeout=timeout)
            how = "stopped cleanly"
        except subprocess.TimeoutExpired:
            self.proc.kill()
            how = "killed after the timeout"
        return {"ok": True, "was_running": True, "how": how}

    def restart(self) -> dict:
        s = self.stop()
        time.sleep(0.5)
        r = self.start()
        return {"ok": r.get("ok", False), "stop": s, "start": r}

    def tail(self, since: int = 0, n: int = 200) -> dict:
        with self.cv:
            out = [{"seq": s, "t": t, "text": x} for s, t, x in self.lines if s > since][-n:]
            return {"lines": out, "next": self.seq}

    def run(self, command: str, wait: float = 1.5, quiet: float = 0.35) -> list[str]:
        """Type a command and return what the server printed in answer: until `quiet` seconds of silence, or `wait` seconds at most."""
        if not self.alive():
            raise RuntimeError("the server is not running")
        with self.cmd_lock:
            with self.cv:
                mark = self.seq
            if not self.send(command):
                raise RuntimeError("could not write to the server")
            end = time.time() + wait
            last = time.time()
            got = 0
            with self.cv:
                while True:
                    now = time.time()
                    if self.seq > mark + got:
                        got = self.seq - mark
                        last = now
                    if now >= end or (got and now - last >= quiet):
                        break
                    self.cv.wait(0.05)
                return [x for s, t, x in self.lines if s > mark]


# ---------- server.properties ----------

PROP_KEY = re.compile(r"^[a-z][a-z0-9.-]*$")


def read_properties(path: Path) -> dict:
    out = {}
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    except OSError:
        pass
    return out


def write_properties(path: Path, updates: dict) -> list[str]:
    """Change existing keys in place (comments and order kept). Unknown keys and values with line breaks are refused. Returns the keys changed."""
    cur = read_properties(path)
    bad = [k for k in updates if k not in cur or not PROP_KEY.match(k) or re.search(r"[\r\n]", str(updates[k]))]
    if bad:
        raise ValueError(f"not a setting of this server: {', '.join(bad)}")
    changed = []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    for i, line in enumerate(lines):
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            k = line.split("=", 1)[0].strip()
            if k in updates and str(updates[k]) != cur[k]:
                lines[i] = f"{k}={updates[k]}"
                changed.append(k)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return changed


# ---------- backups ----------

SAVE_READY = "Data saved. Files are now ready to be copied."


def parse_save_query(lines: list[str]) -> dict | None:
    """The server's answer to `save query` -> { 'Level/db/000003.log': length, ... }, or None while it is not ready."""
    for i, text in enumerate(lines):
        if SAVE_READY in text:
            rest = ", ".join(l for l in lines[i + 1:i + 3] if l.strip())
            files = {}
            for m in re.finditer(r"\s*([^,]+?):(\d+)\s*(?:,|$)", rest):
                files[m.group(1).strip()] = int(m.group(2))
            return files
    return None


class Backups:
    def __init__(self, server: ServerManager, server_dir: Path, dest: Path, keep: int = 20):
        self.server, self.server_dir, self.dest, self.keep = server, Path(server_dir), Path(dest), keep

    def level(self) -> str:
        return read_properties(self.server_dir / "server.properties").get("level-name", "Bedrock level")

    def world_dir(self) -> Path:
        return self.server_dir / "worlds" / self.level()

    def list(self) -> list[dict]:
        self.dest.mkdir(parents=True, exist_ok=True)
        out = []
        for p in sorted(self.dest.glob("*.zip"), key=lambda q: q.stat().st_mtime, reverse=True):
            out.append({"name": p.name, "mb": round(p.stat().st_size / 1e6, 2), "t": p.stat().st_mtime})
        return out

    def create(self, label: str = "") -> dict:
        """A backup of the running (or stopped) world, as one zip."""
        world = self.world_dir()
        if not world.exists():
            return {"ok": False, "error": f"no world folder at {world}"}
        self.dest.mkdir(parents=True, exist_ok=True)
        label = re.sub(r"[^A-Za-z0-9_-]+", "-", label).strip("-")[:40]
        name = f"{self.level().replace(' ', '_')}-{time.strftime('%Y%m%d-%H%M%S')}{'-' + label if label else ''}.zip"
        lens: dict = {}
        held = False
        try:
            if self.server.alive():
                self.server.run("save hold", wait=2.0)
                held = True
                ready = None
                for _ in range(40):
                    ready = parse_save_query(self.server.run("save query", wait=1.2))
                    if ready is not None:
                        break
                    time.sleep(0.5)
                if ready is None:
                    return {"ok": False, "error": "the server never said the files were ready"}
                lens = ready
            tmp = self.dest / (name + ".part")
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
                for f in sorted(world.rglob("*")):
                    if not f.is_file():
                        continue
                    arc = f.relative_to(world.parent).as_posix()
                    limit = lens.get(arc)
                    data = f.read_bytes()
                    z.writestr(arc, data[:limit] if limit is not None else data)
            tmp.replace(self.dest / name)
        finally:
            if held:
                try:
                    self.server.run("save resume", wait=1.5)
                except RuntimeError:
                    pass
        self.prune()
        return {"ok": True, "name": name, "mb": round((self.dest / name).stat().st_size / 1e6, 2), "truncated": len(lens)}

    def prune(self):
        for old in self.list()[self.keep:]:
            if "pre-restore" not in old["name"]:
                try:
                    (self.dest / old["name"]).unlink()
                except OSError:
                    pass

    def restore(self, name: str) -> dict:
        """Stop the server, set the current world aside (as a pre-restore backup), unpack the chosen backup, start again if it was running."""
        if not re.fullmatch(r"[A-Za-z0-9_.-]+\.zip", name or ""):
            return {"ok": False, "error": "bad backup name"}
        src = self.dest / name
        if not src.exists():
            return {"ok": False, "error": "no such backup"}
        with zipfile.ZipFile(src) as z:
            for n in z.namelist():
                if n.startswith("/") or ".." in Path(n).parts:
                    return {"ok": False, "error": f"unsafe path in the backup: {n}"}
            was = self.server.alive()
            if was:
                self.server.stop()
            world = self.world_dir()
            kept = None
            if world.exists():
                kept = self.dest / f"{self.level().replace(' ', '_')}-{time.strftime('%Y%m%d-%H%M%S')}-pre-restore.zip"
                with zipfile.ZipFile(kept, "w", zipfile.ZIP_DEFLATED) as k:
                    for f in sorted(world.rglob("*")):
                        if f.is_file():
                            k.write(f, f.relative_to(world.parent).as_posix())
                shutil.rmtree(world)
            z.extractall(self.server_dir / "worlds")
        started = self.server.start() if was else None
        return {"ok": True, "restored": name, "kept_previous": kept.name if kept else None, "restarted": bool(started and started.get("ok"))}


# ---------- chains ----------

# What a fresh install starts with (they run as the target player: `execute as "Name" at @s run ...`, so @s and c=1 mean them).
DEFAULT_CHAINS = [
    {"name": "Saddled horse + mount", "bot_ok": False, "lines": [
        "/summon horse ~ ~ ~ ~ ~ minecraft:ageable_grow_up",
        "/event entity @e[type=horse,c=1] minecraft:on_tame",
        "/replaceitem entity @e[type=horse,c=1] slot.saddle 0 saddle 1",
        "/ride @s start_riding @e[type=horse,c=1] teleport_rider"]},
    {"name": "Day + clear weather", "bot_ok": True, "lines": ["/time set day", "/weather clear"]},
]


class Chains:
    """Named lists of lines. Grammar: `/command` or `console command` -> the server console; `game text` -> the brain's command queue (the bot and the
    dashboard); `backup [label]`; `wait N` (seconds, at most 60 in all); `# comment`."""

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> list[dict]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return [dict(c, lines=list(c["lines"])) for c in DEFAULT_CHAINS] if not self.path.exists() else []

    def save(self, chains) -> int:
        if not isinstance(chains, list) or len(chains) > 80:
            raise ValueError("chains must be a list of at most 80")
        clean = []
        for c in chains:
            name = str(c.get("name", "")).strip()[:60] if isinstance(c, dict) else ""
            if not name:
                raise ValueError("a chain needs a name")
            lines = [str(x).strip()[:300] for x in (c.get("lines") or []) if str(x).strip()][:80]
            clean.append({"name": name, "lines": lines, "bot_ok": bool(c.get("bot_ok"))})
        self.path.write_text(json.dumps(clean, indent=1), encoding="utf-8")
        return len(clean)

    def get(self, name: str) -> dict | None:
        return next((c for c in self.load() if c["name"] == name), None)


class Admin:
    """Everything the HTTP handler calls: one place that checks who may do what, does it, and writes the audit line."""

    def __init__(self, cfg: dict, server: ServerManager, base: Path = ROOT):
        self.cfg, self.server = cfg, server
        self.base = Path(base)
        self.server_dir = Path(cfg["server_dir"])
        self.backups = Backups(server, self.server_dir, Path(cfg["backups_dir"]), int(cfg["keep_backups"]))
        self.chains = Chains(self.base / "chains.json")
        self.audit_path = self.base / "audit.jsonl"
        self.lock = threading.Lock()

    # -- audit --
    def audit(self, who, action, detail, ok):
        try:
            with self.lock, open(self.audit_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "who": who, "action": action, "detail": str(detail)[:300], "ok": bool(ok)}) + "\n")
        except OSError:
            pass

    def audit_tail(self, n=100) -> list[dict]:
        try:
            lines = self.audit_path.read_text(encoding="utf-8").splitlines()[-n:]
            return [json.loads(x) for x in lines if x.strip()]
        except (OSError, ValueError):
            return []

    # -- the one entry point --
    def allowed(self, role: str | None, action: str) -> bool:
        return role == "owner" or (role == "bot" and action in BOT_ACTIONS)

    def status(self, role):
        sv = self.server
        return {"role": role, "server": {"running": sv.alive(), "pid": sv.proc.pid if sv.alive() else None, "up_s": round(time.time() - sv.started_at) if sv.alive() else 0},
                "level": self.backups.level(), "backups": len(self.backups.list()), "chains": len(self.chains.load())}

    def players(self):
        try:
            return {"ok": True, "players": parse_players(self.server.run("list", wait=1.5))}
        except RuntimeError as e:
            return {"ok": False, "players": [], "error": str(e)}

    def console(self, role, command, wait=1.5, target=None):
        try:
            command = with_target(command, target)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        ok, why = console_allowed(role, command, self.cfg["bot_verbs"])
        if not ok:
            return {"ok": False, "error": why}
        try:
            out = self.server.run(command, wait=min(10.0, max(0.3, float(wait))))
        except RuntimeError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "lines": out}

    def run_chain(self, role, name, target=None):
        chain = self.chains.get(name)
        if not chain:
            return {"ok": False, "error": f"no chain called {name}"}
        if role == "bot" and not chain.get("bot_ok"):
            return {"ok": False, "error": "this chain is not marked safe for the bot"}
        results, waited = [], 0.0
        for line in chain["lines"]:
            if not line or line.startswith("#"):
                continue
            m = re.fullmatch(r"wait\s+(\d+(?:\.\d+)?)", line, re.I)
            if m:
                s = min(float(m.group(1)), max(0.0, 60 - waited))
                waited += s
                time.sleep(s)
                results.append({"line": line, "ok": True})
                continue
            if line.lower().startswith("game "):
                results.append({"line": line, **self._to_brain(line[5:].strip())})
            elif line.lower().startswith("backup"):
                r = self.backups.create(line[6:].strip())
                results.append({"line": line, "ok": r.get("ok", False), "out": r.get("name") or r.get("error")})
            else:
                cmd = line[8:] if line.lower().startswith("console ") else line
                r = self.console(role, cmd, target=target)
                results.append({"line": line, "ok": r["ok"], "out": " | ".join(r.get("lines", []))[:300] or r.get("error", "")})
            if not results[-1]["ok"]:
                break
        return {"ok": all(r["ok"] for r in results), "results": results}

    def _to_brain(self, text):
        try:
            req = urlrequest.Request(self.cfg["brain_url"].rstrip("/") + "/api/command", data=json.dumps({"text": text}).encode(), headers={"Content-Type": "application/json"})
            with urlrequest.urlopen(req, timeout=3) as r:
                return {"ok": r.status == 200, "out": "queued for the bot"}
        except Exception as e:
            return {"ok": False, "out": f"the brain did not answer: {e}"}

    def handle(self, role, action, body=None, query=None):
        """-> (http status, json). The role check, the action, the audit line."""
        body, query = body or {}, query or {}
        if not self.allowed(role, action):
            self.audit(role or "nobody", action, "refused", False)
            return (401 if role is None else 403), {"error": "not allowed" if role else "token needed"}
        try:
            res = self._do(role, action, body, query)
        except ValueError as e:
            res = {"ok": False, "error": str(e)}
        except Exception as e:      # a bug here must not take the service down
            res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        if action not in ("status", "console_log", "audit", "players"):
            self.audit(role, action, json.dumps(body)[:200] if body else query, res.get("ok", True))
        return 200, res

    def _do(self, role, action, b, q):
        sv = self.server
        if action == "status":
            return self.status(role)
        if action == "console":
            return self.console(role, str(b.get("command", "")), b.get("wait", 1.5), b.get("target") or None)
        if action == "players":
            return self.players()
        if action == "console_log":
            return sv.tail(int(q.get("since", 0) or 0), int(q.get("n", 200) or 200))
        if action == "server_start":
            return sv.start()
        if action == "server_stop":
            return sv.stop()
        if action == "server_restart":
            return sv.restart()
        if action == "backups_list":
            return {"backups": self.backups.list()}
        if action == "backup_create":
            return self.backups.create(str(b.get("label", "")))
        if action == "backup_restore":
            return self.backups.restore(str(b.get("name", "")))
        if action == "properties_get":
            return {"properties": read_properties(self.server_dir / "server.properties")}
        if action == "properties_set":
            changed = write_properties(self.server_dir / "server.properties", dict(b.get("set") or {}))
            return {"ok": True, "changed": changed, "note": "restart the server to apply" if changed else "nothing changed"}
        if action == "chains_list":
            return {"chains": self.chains.load()}
        if action == "chains_save":
            return {"ok": True, "saved": self.chains.save(b.get("chains"))}
        if action == "chain_run":
            return self.run_chain(role, str(b.get("name", "")), b.get("target") or None)
        if action == "audit":
            return {"audit": self.audit_tail(int(q.get("n", 100) or 100))}
        raise ValueError(f"unknown action {action}")


# ---------- HTTP ----------

ROUTES = {
    ("GET", "/v1/status"): "status", ("GET", "/v1/players"): "players", ("POST", "/v1/console"): "console", ("GET", "/v1/console/log"): "console_log",
    ("POST", "/v1/server/start"): "server_start", ("POST", "/v1/server/stop"): "server_stop", ("POST", "/v1/server/restart"): "server_restart",
    ("GET", "/v1/backups"): "backups_list", ("POST", "/v1/backups"): "backup_create", ("POST", "/v1/backups/restore"): "backup_restore",
    ("GET", "/v1/properties"): "properties_get", ("PUT", "/v1/properties"): "properties_set",
    ("GET", "/v1/chains"): "chains_list", ("PUT", "/v1/chains"): "chains_save", ("POST", "/v1/chains/run"): "chain_run",
    ("GET", "/v1/audit"): "audit",
}


def make_handler(admin: Admin, port: int):
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
    tokens = admin.cfg["tokens"]

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj, headers=None, raw=None, ctype="application/json"):
            body = raw if raw is not None else json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _role(self, q):
            auth = self.headers.get("Authorization", "")
            tok = auth[7:] if auth.startswith("Bearer ") else None
            if not tok:
                m = re.search(r"(?:^|;\s*)admin_token=([^;]+)", self.headers.get("Cookie", ""))
                tok = m.group(1) if m else None
            return role_of(tokens, tok or q.get("token", [None])[0])

        def _go(self, method):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            host = self.headers.get("Host", "")
            if admin.cfg["host"] in ("127.0.0.1", "localhost", "::1") and host not in hosts:
                return self._send(403, {"error": "wrong Host header"})
            if u.path == "/health":
                return self._send(200, {"ok": True})
            if method == "GET" and u.path in ("/", "/index.html"):
                # (?token=... signs in: the token goes into a cookie and out of the address bar)
                tok = q.get("token", [None])[0]
                if tok and role_of(tokens, tok):
                    return self._send(302, {}, {"Location": "/", "Set-Cookie": f"admin_token={tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000"})
                return self._send(200, None, raw=(ROOT / "panel.html").read_bytes(), ctype="text/html; charset=utf-8")
            action = ROUTES.get((method, u.path))
            if not action:
                return self._send(404, {"error": "not found"})
            body = {}
            if method in ("POST", "PUT"):
                try:
                    n = int(self.headers.get("Content-Length", 0))
                    body = json.loads(self.rfile.read(n) or b"{}")
                    if method != "GET" and "json" not in self.headers.get("Content-Type", ""):
                        return self._send(415, {"error": "send JSON"})
                except ValueError:
                    return self._send(400, {"error": "bad json"})
            code, res = admin.handle(self._role(q), action, body, {k: v[0] for k, v in q.items()})
            self._send(code, res)

        def do_GET(self):
            self._go("GET")

        def do_POST(self):
            self._go("POST")

        def do_PUT(self):
            self._go("PUT")

    return H


def build(cfg: dict, base: Path = ROOT) -> tuple[Admin, ServerManager]:
    sd = Path(cfg["server_dir"])
    cmd = cfg.get("server_cmd") or [str(sd / ("bedrock_server.exe" if os.name == "nt" else "bedrock_server"))]
    if isinstance(cmd, str):
        cmd = [cmd]
    sm = ServerManager(cmd, sd, Path(base) / "logs" / "server.log")
    return Admin(cfg, sm, base), sm


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--open", action="store_true", help="open the panel in the browser, signed in")
    ap.add_argument("--no-server", action="store_true", help="do not start the Bedrock server now (start it from the panel)")
    args = ap.parse_args(argv)
    cfg_path = ROOT / "config.json"
    first = not cfg_path.exists()
    cfg = load_config(cfg_path)
    admin, sm = build(cfg)
    httpd = ThreadingHTTPServer((cfg["host"], int(cfg["port"])), make_handler(admin, int(cfg["port"])))
    url = f"http://127.0.0.1:{cfg['port']}/"
    print(f"Admin service on {url}")
    if first:
        print("First run: tokens were made and saved in admin/config.json (owner = you, bot = the bot via the brain).")
    print(f"Sign in once:  {url}?token={cfg['tokens']['owner']}")
    if cfg.get("autostart") and not args.no_server:
        print("Starting the server:", sm.start())
    if args.open:
        import webbrowser
        webbrowser.open(f"{url}?token={cfg['tokens']['owner']}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if sm.alive():
            print("Stopping the server...")
            sm.stop()


if __name__ == "__main__":
    main()
