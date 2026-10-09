"""Brain HTTP server. Zero dependencies (stdlib only).

    python -m brain.server              # from the repo root
    GET  /              the dashboard (brain/dashboard.html): bot status and controls
    GET  /api/status    latest status the game sent, recent events, Jev spend
    POST /api/command   {text}: queue a command for the bot ("come Steve", "test house", "/time set day")
    POST /poll          from the game, once a second: {status} -> {commands: [...]}
    GET  /stats         decisions by layer, Jev spend today, cache hits
    POST /event         {type, state, ...} -> {actions: [...]}
"""
from __future__ import annotations

import collections
import json
import logging
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .decisions import DecisionEngine
from .durable import append_line
from .jev_client import Budget, JevClient
from .llm_client import LocalLLM

ROOT = Path(__file__).resolve().parent
log = logging.getLogger("brain")


LOG_DIR = ROOT / "logs"

# Dashboard state (in memory; the game resends status every second).
_lock = threading.Lock()
_status = {"data": None, "at": 0.0}
_fight_n = [0]
_commands: collections.deque = collections.deque(maxlen=50)


def _about() -> dict:
    """What this brain is: the commit it runs from (if git is there), Python, when it started."""
    import platform
    import subprocess
    out = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "python": platform.python_version(), "platform": platform.platform()}
    try:
        out["commit"] = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=str(ROOT), capture_output=True, text=True, timeout=3).stdout.strip() or None
        out["dirty"] = bool(subprocess.run(["git", "status", "--porcelain"], cwd=str(ROOT), capture_output=True, text=True, timeout=3).stdout.strip())
    except Exception:
        pass
    return out


ABOUT = _about()
# The world session the logs belong to: reset when the bot first spawns into a different world, or into the same one
# after the game restarted (its tick count went back). Deaths and script reloads don't count.
_session: dict = {"world": None, "started": None, "build": None}
_last_tick = {"v": None}
LIVE_REPORT = LOG_DIR / "live_report.txt"


def new_session(world_id, build, tick) -> bool:
    """A `session` event from the game. Returns True if it began a new session (the logs were saved aside and cleared)."""
    last = _last_tick["v"]
    changed = _session["world"] != world_id or (tick is not None and last is not None and tick + 200 < last)
    if not changed:
        _session["build"] = build
        return False
    stamp = time.strftime("%Y%m%d-%H%M%S")
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        if LIVE_REPORT.exists() and _session["world"] is not None:
            LIVE_REPORT.replace(LOG_DIR / f"live_report.{stamp}.txt")
            for old in sorted(LOG_DIR.glob("live_report.2*.txt"))[:-10]:
                old.unlink()
        with (LOG_DIR / "trace.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "tick": tick, "msg": f"--- new world session: world {world_id}, build {build} ---"}) + "\n")
    except OSError:
        pass
    with _lock:
        _traces.clear()
        _why.clear()
        _paths.clear()
    _session.update({"world": world_id, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "build": build})
    _last_tick["v"] = tick
    return True

_recent: collections.deque = collections.deque(maxlen=400)
# The bot's decision notes (the live trace panel), flight reports and test results, newest last.
_traces: collections.deque = collections.deque(maxlen=5000)
_trace_seq = 0
_flights: collections.deque = collections.deque(maxlen=12)
# (u250) The repro capsules the bot sends when something goes wrong (game/capsule.js), newest last; also kept whole in logs/capsules.jsonl.
_capsules: collections.deque = collections.deque(maxlen=8)
_paths: collections.deque = collections.deque(maxlen=6000)  # the pathfinding log (searches and walks)
_why: collections.deque = collections.deque(maxlen=3000)  # the planner's reasons, one per step chosen (brain/logs/why.jsonl)
_tests: dict = {"batch": None, "results": {}, "stats": {}}


def append_traces(traces: list) -> None:
    """The bot's decision notes (brain/logs/trace.jsonl, rolls over at 2 MB): why it did what it did."""
    import time
    LOG_DIR.mkdir(exist_ok=True)
    f = LOG_DIR / "trace.jsonl"
    if f.exists() and f.stat().st_size > 2_000_000:
        f.replace(f.with_suffix(".old.jsonl"))
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    global _trace_seq
    with f.open("a", encoding="utf-8") as fh:
        for t in traces[:500]:
            m = str(t.get("msg", ""))
            if isinstance(t.get("tick"), int):
                _last_tick["v"] = max(_last_tick["v"] or 0, t["tick"])
            rec = {"t": now, "tick": t.get("tick"), "msg": m[:2500] if "\n" in m else m[:300]}
            if isinstance(t.get("p"), list) and len(t["p"]) == 3:
                rec["p"] = t["p"]
            fh.write(json.dumps(rec) + "\n")
            with _lock:
                _trace_seq += 1
                _traces.append({"id": _trace_seq, **rec})


SETTINGS_FILE = ROOT / "settings.json"
_SETTING_KEYS = {"beds", "nights", "house", "torches", "farm", "iron", "hunting", "storage", "witches", "villages", "chat", "learnedHouse"}


def load_settings() -> dict:
    """The goal toggles and chat setting kept for every new world (brain/settings.json)."""
    try:
        d = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        return {k: bool(v) for k, v in (d.get("settings") or {}).items() if k in _SETTING_KEYS}
    except (OSError, ValueError):
        return {}


def save_setting(key: str | None, on: bool = True, reset: bool = False) -> dict:
    with _lock:
        cur = {} if reset else load_settings()
        if key in _SETTING_KEYS:
            cur[key] = bool(on)
        try:
            SETTINGS_FILE.write_text(json.dumps({"settings": cur}, indent=1), encoding="utf-8")
        except OSError:
            pass
        return cur


_demo = {"player": None, "last": 0.0, "rows": 0}
_profile = {"at": 0.0, "data": None}
_house = {"at": 0.0, "data": None}  # the last house learned off the player (core/learnhouse.js): verdict, picture, plan


def store_demo(evt: dict) -> None:
    """Keep a batch of rows from the player's recording (brain/logs/demos/<player>-<session>.jsonl)."""
    import re
    rows = evt.get("rows") or []
    if not isinstance(rows, list):
        return
    player = re.sub(r"[^A-Za-z0-9_-]", "_", str(evt.get("player", "player")))[:32]
    session = re.sub(r"[^0-9A-Za-z_-]", "_", str(evt.get("session", "x")))[:32]
    d = LOG_DIR / "demos"
    d.mkdir(parents=True, exist_ok=True)
    with (d / f"{player}-{session}.jsonl").open("a", encoding="utf-8") as fh:
        for r in rows[:2000]:
            if isinstance(r, dict):
                fh.write(json.dumps(r) + "\n")
    with _lock:
        _demo.update(player=player, last=time.time(), rows=_demo["rows"] + len(rows))
        _profile["at"] = 0.0  # worked out afresh next time it's asked for


def store_house(evt: dict) -> None:
    """Keep the verdict on a house the player built (brain/logs/learned_house.jsonl, the last one in memory)."""
    keep = {k: evt.get(k) for k in ("ok", "problems", "notes", "stats", "ascii", "plan", "player")}
    keep["at"] = time.time()
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        append_line(LOG_DIR / "learned_house.jsonl", json.dumps(keep))
    except OSError:
        pass
    with _lock:
        _house.update(at=keep["at"], data=keep)


def path_summary(rows: list) -> dict:
    """Totals and the worst offenders from the pathfinding log: searches by who asked, walks that got stuck."""
    plans = [r for r in rows if r.get("k") == "plan"]
    walks = [r for r in rows if r.get("k") == "walk"]
    by: dict = {}
    for r in plans:
        d = by.setdefault(r.get("who", "?"), {"n": 0, "nodes": 0, "ticks": 0, "partial": 0})
        d["n"] += 1
        d["nodes"] += r.get("nodes", 0)
        d["ticks"] += r.get("ticks", 0)
        d["partial"] += 0 if r.get("ok") else 1
    top = sorted(by.items(), key=lambda kv: -kv[1]["nodes"])[:8]
    ticks = sorted(r.get("ticks", 0) for r in plans)
    return {
        "plans": len(plans), "walks": len(walks),
        "p95_ticks": ticks[int(len(ticks) * 0.95)] if ticks else 0,
        "partial_pct": round(100 * sum(1 for r in plans if not r.get("ok")) / len(plans)) if plans else 0,
        "stuck_walks": sum(1 for r in walks if r.get("status") == "stuck"),
        "by_caller": [{"who": k, **v} for k, v in top],
        "slowest": sorted(plans, key=lambda r: -r.get("ticks", 0))[:5],
    }


def get_profile() -> dict:
    """The profile from the recordings, worked out again at most every 20 s."""
    from . import learn
    with _lock:
        if _profile["data"] is not None and time.time() - _profile["at"] < 20:
            return _profile["data"]
    data = learn.build(LOG_DIR / "demos")
    try:
        learn.write(data)
    except OSError:
        pass
    with _lock:
        _profile.update(at=time.time(), data=data)
    return data


def _save_test_stats() -> None:
    """Pass/fail counts per test and side live on this computer, not in any one world (brain/logs/test_stats.json)."""
    try:
        LOG_DIR.mkdir(exist_ok=True)
        (LOG_DIR / "test_stats.json").write_text(json.dumps(_tests["stats"]), encoding="utf-8")
    except OSError:
        pass


def _load_test_stats() -> None:
    try:
        data = json.loads((LOG_DIR / "test_stats.json").read_text(encoding="utf-8"))
        if isinstance(data, dict):
            _tests["stats"] = data
    except (OSError, ValueError):
        pass


def _load_test_runs() -> None:
    """The latest run of each test and side (with its path), read back from tests.jsonl so a restart does not empty the dashboard."""
    try:
        with (LOG_DIR / "tests.jsonl").open(encoding="utf-8") as fh:
            lines = fh.readlines()[-3000:]
    except OSError:
        return
    runs = _tests.setdefault("runs", {})
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "test_run" and e.get("name") and e.get("who"):
            runs.setdefault(str(e["name"]), {})[str(e["who"])] = {"t": e.get("t"), "pass": bool(e.get("pass")), "summary": e.get("summary"), "trace": e.get("trace")}


def remember(evt: dict) -> None:
    """Keep what the dashboard shows from a logged event: flight reports, test results, the last batch."""
    kind = evt.get("type")
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with _lock:
        if kind == "flight":
            _flights.append({"t": now, "why": str(evt.get("why", ""))[:300], "build": evt.get("build"),
                             "report": [str(x)[:400] for x in (evt.get("report") or [])][:80], "pos": (evt.get("state") or {}).get("pos")})
        elif kind == "test_run":
            if not evt.get("stopped"):
                st = _tests["stats"].setdefault(str(evt.get("name")), {}).setdefault(str(evt.get("who")), {"p": 0, "n": 0, "last": None})
                st["n"] += 1
                st["p"] += 1 if evt.get("pass") else 0
                st["last"] = {"pass": bool(evt.get("pass")), "at": now, "build": evt.get("build")}
                _save_test_stats()
            _tests.setdefault("runs", {}).setdefault(str(evt.get("name")), {})[str(evt.get("who"))] = {
                "t": now, "pass": bool(evt.get("pass")), "summary": evt.get("summary"), "trace": evt.get("trace")}
        elif kind == "test_result" and evt.get("who") == "human":
            pass  # the player's own run: kept with the runs, not as the bot's result
        elif kind == "test_result":
            _tests["results"][str(evt.get("name"))] = {"t": now, "pass": bool(evt.get("pass")), "detail": str(evt.get("detail", ""))[:400]}
        elif kind == "test_batch":
            _tests["batch"] = {"t": now, "build": evt.get("build"), "passed": evt.get("passed"), "total": evt.get("total"), "secs": evt.get("secs"),
                               "results": [{"name": r.get("name"), "pass": bool(r.get("pass")), "secs": r.get("secs"), "detail": str(r.get("detail", ""))[:300]} for r in (evt.get("results") or [])][:80]}
            for r in _tests["batch"]["results"]:
                _tests["results"][str(r["name"])] = {"t": now, "pass": r["pass"], "detail": r["detail"], "secs": r["secs"]}


def append_log(evt: dict) -> None:
    """Append to brain/logs/events.jsonl (tests also to tests.jsonl); rolls over at 2 MB."""
    import time
    LOG_DIR.mkdir(exist_ok=True)
    rec = {"t": time.strftime("%Y-%m-%d %H:%M:%S"), **{k: v for k, v in evt.items() if k != "state"}}
    if isinstance(evt.get("state"), dict):
        rec["pos"] = evt["state"].get("pos")
        rec["task"] = evt["state"].get("task")
    with _lock:
        # (The dashboard's Recent list gets a light copy: the full flight report and batch go to
        # their own endpoints, not into the status poll every second.)
        _recent.append({k: v for k, v in rec.items() if k not in ("report", "results", "trace", "rows")})
    if evt.get("type") == "probe":
        # a physics probe's per-tick trace (the simulator's calibration data): its own file, not the event log
        f = LOG_DIR / "probes.jsonl"
        if f.exists() and f.stat().st_size > 60_000_000:
            f.replace(f.with_suffix(".old.jsonl"))
        with f.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")
        return
    names = ["events.jsonl"] + (["tests.jsonl"] if evt.get("type") in ("test_result", "test_batch", "test_run") else []) + (["flight.jsonl"] if evt.get("type") == "flight" else [])
    for name in names:
        f = LOG_DIR / name
        if f.exists() and f.stat().st_size > 2_000_000:
            f.replace(f.with_suffix(".old.jsonl"))
        with f.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")


def load_config() -> dict:
    cfg = json.loads((ROOT / "config.example.json").read_text())
    user = ROOT / "config.json"
    if user.exists():
        cfg.update(json.loads(user.read_text()))
    cfg["jev_api_key"] = os.environ.get("JEV_API_KEY") or cfg.get("jev_api_key") or None
    return cfg


def build_engine(cfg: dict) -> DecisionEngine:
    budget = Budget(
        max_calls_per_hour=cfg["jev_max_calls_per_hour"],
        max_usd_per_day=cfg["jev_max_usd_per_day"],
        path=ROOT / "usage.json",
    )
    jev = JevClient(
        cfg["jev_api_key"],
        endpoint=cfg["jev_endpoint"],
        model=cfg["jev_model"],
        usd_per_mtok_input=cfg["jev_usd_per_mtok_input"],
        budget=budget,
        cache_ttl_s=cfg["jev_cache_ttl_s"],
        timeout_s=cfg["jev_timeout_s"],
    )
    llm = LocalLLM(cfg.get("ollama_url"), cfg.get("ollama_model", "llama3.2:3b"))
    return DecisionEngine(jev, llm, cfg["min_confidence"], bool(cfg.get("mc_commands", True)))


def lan_ip() -> str:
    """This PC's address on the local network (what a phone types), or 127.0.0.1 if there's none."""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sk:
            sk.connect(("10.255.255.255", 1))  # (no packet is sent: it only picks the interface)
            return sk.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def access_key(cfg: dict) -> str:
    """The key a phone needs: config's "access_key", else one made once and kept in brain/access_key.txt."""
    if cfg.get("access_key"):
        return str(cfg["access_key"])
    f = ROOT / "access_key.txt"
    if f.exists() and f.read_text().strip():
        return f.read_text().strip()
    import secrets
    k = secrets.token_urlsafe(9)
    f.write_text(k + "\n")
    return k


def authorized(client_ip: str, cookie: str, query_key: str, key: str | None) -> str:
    """'ok' (this PC, or no key needed, or the cookie matches), 'set' (the key in the URL: hand out the
    cookie), or 'no'. The game talks from this PC, so it never needs the key; a phone on the Wi-Fi does."""
    if key is None or client_ip in ("127.0.0.1", "::1", "localhost"):
        return "ok"
    import hmac
    for part in (cookie or "").split(";"):
        name, _, val = part.strip().partition("=")
        if name == "scout_key" and hmac.compare_digest(val, key):
            return "ok"
    if query_key and hmac.compare_digest(query_key, key):
        return "set"
    return "no"


_server = {"proc": None, "jobs": None, "admin": None}
_lab: dict = {"run": None}   # (u323) brain/lab.py: the arena lab
_train: dict = {"run": None}   # (u290) brain/trainer.py: the bot trains itself (off until switched on in the dashboard)
_auto: dict = {"run": None}   # (u253) brain/autorun.py: Claude starts bot tests while you are away (off until switched on in the dashboard)


def make_handler(engine: DecisionEngine, key: str | None = None):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, obj: dict):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            try:
                self.end_headers()
                self.wfile.write(body)
            except (ConnectionResetError, BrokenPipeError):
                pass  # the game gave up waiting (its request timed out): nothing to send to

        def _read_json(self):
            n = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(n) or b"{}")

        def _gate(self) -> bool:
            """False if the request was answered here (not allowed, or the key turned into a cookie)."""
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query).get("key", [""])[0]
            verdict = authorized(self.client_address[0], self.headers.get("Cookie", ""), q, key)
            if verdict == "ok":
                return True
            if verdict == "set":
                self.send_response(302)
                self.send_header("Set-Cookie", f"scout_key={key}; Path=/; Max-Age=31536000; SameSite=Strict")
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return False
            body = b"Scout dashboard: open the link with ?key=... that the brain window printed."
            self.send_response(401)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return False

        def _admin_get(self):
            from urllib.parse import urlparse, parse_qs
            from . import admin
            u = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            what = u.path[len("/api/admin/"):]
            repo = ROOT.parent
            try:
                if what == "doctor":
                    with _lock:
                        data, at = _status["data"], _status["at"]
                    ar = _auto["run"]
                    return self._send(200, {"checks": admin.doctor(repo, data, (time.time() - at) if at else None, ar.info() if ar else None, LOG_DIR, ar.inbox if ar else ROOT / "inbox")})
                if what == "scenarios":
                    return self._send(200, {"scenarios": admin.scenarios(repo)})
                if what == "logs":
                    return self._send(200, {"logs": admin.list_logs(LOG_DIR)})
                if what == "log":
                    return self._send(200, admin.tail_log(LOG_DIR, q.get("name", ""), int(q.get("n", 200)), q.get("grep", "")))
                if what == "history":
                    return self._send(200, admin.history(LOG_DIR))
                if what == "result":
                    f = (_auto["run"].inbox if _auto["run"] else ROOT / "inbox") / "result.txt"
                    return self._send(200, {"text": f.read_text(encoding="utf-8", errors="replace")[:300_000] if f.exists() else "(no result yet)"})
                if what == "reports":
                    return self._send(200, {"reports": admin.reports(repo)})
                if what == "report":
                    return self._send(200, admin.report(repo, q.get("name", "")))
            except (OSError, ValueError) as e:
                return self._send(500, {"error": str(e)})
            self._send(404, {"error": "not found"})

        def _admin_post(self):
            from . import admin
            what = self.path[len("/api/admin/"):]
            try:
                body = self._read_json()
            except ValueError:
                return self._send(400, {"error": "bad json"})
            ar = _auto["run"]
            say = lambda text: (_commands.append(text), _recent.append({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "type": "command", "text": text}))
            try:
                if what == "reload":
                    send = _auto_server_send()
                    if send is None:
                        return self._send(200, {"ok": False, "detail": "the brain does not own a running server; type reload in the server window"})
                    send("reload")
                    return self._send(200, {"ok": True, "detail": "reload sent to the server"})
                if what == "spawn":
                    with _lock:
                        say("spawn")
                    return self._send(200, {"ok": True, "detail": "spawn queued"})
                if what == "stop":
                    if ar is None:
                        return self._send(500, {"error": "not available"})
                    (ar.inbox / "STOP").write_text("stopped from the admin panel\n")
                    ar.set_enabled(False)
                    return self._send(200, {"ok": True, "detail": "autorun off, STOP file written"})
                if what == "clear_stop":
                    if ar:
                        try:
                            (ar.inbox / "STOP").unlink()
                        except OSError:
                            pass
                    return self._send(200, {"ok": True, "detail": "STOP file removed"})
                if what == "run":
                    if ar is None:
                        return self._send(500, {"error": "not available"})
                    run = admin.validate_run(body)
                    (ar.inbox / "run.json").write_text(json.dumps(run), encoding="utf-8")
                    return self._send(200, {"ok": True, "detail": "run.json written", "run": run})
                if what == "test":
                    name = str(body.get("name", ""))
                    who = "me" if body.get("me") else ""
                    if not re.fullmatch(r"[a-z0-9]+", name):
                        return self._send(400, {"error": "bad test name"})
                    with _lock:
                        say(f"test {name} {who}".strip())
                    return self._send(200, {"ok": True, "detail": f"queued: test {name} {who}".strip()})
            except (OSError, ValueError) as e:
                return self._send(400, {"error": str(e)})
            self._send(404, {"error": "not found"})

        def do_GET(self):
            if self.path != "/health" and not self._gate():
                return
            if self.path.split("?")[0] in ("/", "/index.html", "/dashboard"):
                body = (ROOT / "dashboard.html").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path.split("?")[0] == "/admin":
                body = (ROOT / "admin.html").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path.startswith("/api/admin/"):
                return self._admin_get()
            if self.path == "/api/status":
                j = engine.jev
                with _lock:
                    data, at, recent = _status["data"], _status["at"], list(_recent)
                return self._send(200, {
                    "status": data,
                    "age_s": round(time.time() - at, 1) if at else None,
                    "events": recent[-40:],
                    "jev": {"enabled": j.available, "usd_today": round(j.budget.usd_today, 6),
                            "calls_last_hour": j.budget.calls_last_hour},
                })
            if self.path == "/api/settings":
                return self._send(200, {"settings": load_settings()})
            if self.path == "/api/paths":
                with _lock:
                    rows = list(_paths)
                return self._send(200, {"rows": rows, "summary": path_summary(rows)})
            if self.path == "/api/why":
                with _lock:
                    return self._send(200, {"why": list(_why)})
            if self.path == "/api/about":
                return self._send(200, {**ABOUT, "session": dict(_session)})
            if self.path == "/api/events":
                with _lock:
                    return self._send(200, {"events": list(_recent)})
            if self.path == "/stats":
                j = engine.jev
                return self._send(200, {
                    "decisions_by_layer": dict(engine.sources),
                    "jev": {**j.stats, "enabled": j.available, "usd_today": round(j.budget.usd_today, 6),
                            "calls_last_hour": j.budget.calls_last_hour},
                })
            if self.path.startswith("/api/trace"):
                # ?since=<id>: only the notes after that one (the live decisions panel polls this).
                since = 0
                if "since=" in self.path:
                    try:
                        since = int(self.path.split("since=", 1)[1].split("&")[0])
                    except ValueError:
                        since = 0
                with _lock:
                    lines = [t for t in _traces if t["id"] > since]
                    if "all=1" not in self.path:
                        lines = lines[-300:]
                    nxt = _trace_seq
                return self._send(200, {"next": nxt, "lines": lines})
            if self.path == "/api/autorun":
                ar = _auto["run"]
                return self._send(200, ar.info() if ar else {"enabled": False, "state": "not available"})
            if self.path == "/api/trainer":
                tr = _train["run"]
                return self._send(200, tr.info() if tr else {"enabled": False, "state": "not available"})
            if self.path == "/api/lab":
                with _lock:
                    if _lab["run"] is None:
                        from .lab import Lab
                        _lab["run"] = Lab(ROOT)
                    return self._send(200, _lab["run"].info())
            if self.path == "/api/bench":
                from . import bench as _bench
                return self._send(200, {"runs": _bench.read(ROOT, 12), "leaderboard": _bench.write_leaderboard(ROOT)})
            if self.path == "/api/trainer/digest":
                tr = _train["run"]
                return self._send(200, {"text": tr.write_digest() if tr else ""})
            if self.path == "/api/capsules":
                with _lock:
                    return self._send(200, {"capsules": list(_capsules)})
            if self.path == "/api/flight":
                with _lock:
                    return self._send(200, {"reports": list(_flights)})
            if self.path == "/api/analytics":
                from . import analytics
                return self._send(200, analytics.compute(analytics.load_runs(LOG_DIR)))
            if self.path == "/api/tests":
                with _lock:
                    return self._send(200, {"batch": _tests["batch"], "results": dict(_tests["results"]), "runs": dict(_tests.get("runs", {})), "stats": dict(_tests["stats"])})
            if self.path == "/profile":
                from . import learn
                return self._send(200, learn.for_game(get_profile()))
            if self.path == "/api/profile":
                from . import learn
                with _lock:
                    rec = {"recording": _demo["player"] if time.time() - _demo["last"] < 20 else None, "rows": _demo["rows"]}
                return self._send(200, {**get_profile(), "demo": rec, "report": learn.report(get_profile())})
            if self.path == "/api/house":
                with _lock:
                    return self._send(200, {"house": _house["data"]})
            if self.path == "/health":
                return self._send(200, {"ok": True})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if not self._gate():
                return
            if self.path == "/poll":
                try:
                    body = self._read_json()
                except ValueError:
                    return self._send(400, {"error": "bad json"})
                if body.get("traces"):
                    append_traces(body["traces"])
                with _lock:
                    _status["data"], _status["at"] = body.get("status"), time.time()
                    cmds = list(_commands)
                    _commands.clear()
                return self._send(200, {"commands": cmds})
            if self.path == "/locate":
                # The add-on asks where the game says the nearest village (structure) or forest (biome) is: typed into the server's console.
                try:
                    body = self._read_json()
                except ValueError:
                    return self._send(400, {"error": "bad json"})
                sp = _server["proc"]
                if sp is None:
                    return self._send(200, {"error": "the server is not run by the brain (start it with Start Agent.bat, or set up the admin service)"})
                return self._send(200, _server["jobs"].ask(str(body.get("kind", "")), str(body.get("name", "")), body.get("x"), body.get("z")))
            if self.path in ("/lab/next", "/lab/result"):
                # The colosseum's lab loop (game/lab.js): the next bout to play, and a bout's record.
                try:
                    body = self._read_json()
                except ValueError:
                    return self._send(400, {"error": "bad json"})
                with _lock:
                    if _lab["run"] is None:
                        from .lab import Lab
                        _lab["run"] = Lab(ROOT)
                    lb = _lab["run"]
                try:
                    if self.path == "/lab/next":
                        return self._send(200, lb.next(body.get("table") or {}))
                    return self._send(200, lb.result(str(body.get("id", "")), body.get("rec") or {}))
                except Exception as e:
                    return self._send(200, {"ok": False, "say": f"lab: {e}"})
            if self.path == "/api/lab":
                try:
                    body = self._read_json()
                except ValueError:
                    return self._send(400, {"error": "bad json"})
                with _lock:
                    if _lab["run"] is None:
                        from .lab import Lab
                        _lab["run"] = Lab(ROOT)
                    if body.get("action") == "reset":
                        _lab["run"].reset()
                    return self._send(200, _lab["run"].info())
            if self.path == "/admin":
                # The bot asks the Bedrock admin service (a separate program) for something, with the bot token it is allowed: the game never sees the token.
                ad = _server["admin"]
                if ad is None or not ad.configured:
                    return self._send(200, {"ok": False, "say": "The admin service is not set up (admin_url and admin_bot_token in brain/config.json)."})
                try:
                    body = self._read_json()
                except ValueError:
                    return self._send(400, {"error": "bad json"})
                return self._send(200, ad.act(body))
            if self.path == "/api/live_report":
                # The dashboard's full report, rewritten every few seconds: brain/logs/live_report.txt.
                try:
                    n = min(int(self.headers.get("Content-Length", 0)), 16_000_000)
                    text = self.rfile.read(n).decode("utf-8", "replace")
                    LOG_DIR.mkdir(parents=True, exist_ok=True)
                    tmp = LOG_DIR / "live_report.txt.tmp"
                    tmp.write_text(text, encoding="utf-8")
                    tmp.replace(LOG_DIR / "live_report.txt")
                except (OSError, ValueError) as e:
                    return self._send(500, {"error": str(e)})
                return self._send(200, {"bytes": len(text)})
            if self.path == "/api/autorun":
                ar = _auto["run"]
                if ar is None:
                    return self._send(500, {"error": "not available"})
                try:
                    on = bool(self._read_json().get("on"))
                except ValueError:
                    return self._send(400, {"error": "bad json"})
                try:
                    (ar.inbox / "STOP").unlink()
                except OSError:
                    pass
                ar.set_enabled(on)
                _switches_set("autorun", on)
                return self._send(200, ar.info())
            if self.path == "/api/trainer":
                tr = _train["run"]
                if tr is None:
                    return self._send(500, {"error": "not available"})
                try:
                    on = bool(self._read_json().get("on"))
                except ValueError:
                    return self._send(400, {"error": "bad json"})
                tr.set_enabled(on)
                _switches_set("trainer", on)
                return self._send(200, tr.info())
            if self.path.startswith("/api/admin/"):
                return self._admin_post()
            if self.path == "/api/command":
                try:
                    text = str(self._read_json().get("text", "")).strip()[:480]
                except ValueError:
                    return self._send(400, {"error": "bad json"})
                if not text:
                    return self._send(400, {"error": "empty"})
                with _lock:
                    _commands.append(text)
                    _recent.append({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "type": "command", "text": text})
                return self._send(200, {"queued": text})
            if self.path != "/event":
                return self._send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("Content-Length", 0))
                evt = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return self._send(400, {"error": "bad json"})
            if evt.get("type") == "bench_result":
                try:
                    from . import bench as _bench
                    _bench.store(ROOT, {**evt, "policy": (_train["run"].champion if _train.get("run") else None)})
                except Exception as e:  # noqa: BLE001 - a bad result never takes the brain down
                    log.warning("bench result not stored: %s", e)
                return self._send(200, {"actions": []})
            if evt.get("type") == "fight_episode":
                try:
                    from . import fights as _fights
                    _fights.store(ROOT, evt)
                    _fight_n[0] += 1
                    if _fight_n[0] % 25 == 0:
                        _fights.write_report(ROOT)
                except Exception as e:  # noqa: BLE001
                    log.warning("fight episode not stored: %s", e)
                return self._send(200, {"actions": []})
            if evt.get("type") == "demo":
                store_demo(evt)
                return self._send(200, {"actions": []})
            if evt.get("type") == "setting":
                save_setting(evt.get("key"), bool(evt.get("on", True)), bool(evt.get("reset")))
                return self._send(200, {"actions": []})
            if evt.get("type") == "paths":
                rows = [r for r in (evt.get("rows") or [])[:500] if isinstance(r, dict)]
                stamp = time.strftime("%H:%M:%S")
                with _lock:
                    for r in rows:
                        _paths.append({"at": stamp, **r})
                try:
                    LOG_DIR.mkdir(exist_ok=True)
                    f = LOG_DIR / "paths.jsonl"
                    if f.exists() and f.stat().st_size > 6_000_000:
                        f.replace(f.with_suffix(".old.jsonl"))
                    with f.open("a", encoding="utf-8") as fh:
                        for r in rows:
                            fh.write(json.dumps({"at": stamp, **r}) + "\n")
                except OSError:
                    pass
                return self._send(200, {"actions": []})
            if evt.get("type") == "session":
                began = new_session(evt.get("world"), evt.get("build"), evt.get("tick"))
                return self._send(200, {"actions": [], "new_session": began})
            if evt.get("type") == "why":
                rec = {"t": time.strftime("%H:%M:%S"), **{k: v for k, v in evt.items() if k != "type"}}
                with _lock:
                    _why.append(rec)
                try:
                    LOG_DIR.mkdir(exist_ok=True)
                    f = LOG_DIR / "why.jsonl"
                    if f.exists() and f.stat().st_size > 4_000_000:
                        f.replace(f.with_suffix(".old.jsonl"))
                    with f.open("a", encoding="utf-8") as fh:
                        fh.write(json.dumps(rec) + "\n")
                except OSError:
                    pass
                return self._send(200, {"actions": []})
            if evt.get("type") == "learned_house":
                store_house(evt)
                return self._send(200, {"actions": []})
            if evt.get("type") == "capsule" and isinstance(evt.get("capsule"), dict):
                cap = evt["capsule"]
                with _lock:
                    _capsules.append({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "capsule": cap, "lines": [str(x)[:400] for x in (evt.get("lines") or [])][:400]})
                try:
                    LOG_DIR.mkdir(exist_ok=True)
                    f = LOG_DIR / "capsules.jsonl"
                    if f.exists() and f.stat().st_size > 20_000_000:
                        f.replace(f.with_suffix(".old.jsonl"))
                    with f.open("a", encoding="utf-8") as fh:
                        fh.write(json.dumps({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "capsule": cap}) + "\n")
                except OSError:
                    pass
                return self._send(200, {"actions": []})
            if evt.get("type") in ("log", "test_result", "test_batch", "test_run", "flight", "probe"):
                # What the bot said and test results, kept on disk so they can be read later
                # without watching the server window. No decisions, no API calls.
                append_log(evt)
                remember(evt)
                return self._send(200, {"actions": []})
            actions = engine.handle(evt)
            log.info("%s -> %s", evt.get("type"), actions)
            self._send(200, {"actions": actions})

        def log_message(self, *args):  # silence default access log
            pass

    return Handler


def _auto_server_send():
    f = _auto.get("server_send")
    return f() if f else None


def _switch_file() -> Path:
    return ROOT / "switches.json"


def _switches_read() -> dict:
    """(u301) Which of Auto runs / Training the dashboard last had on. They used to reset to OFF at every brain restart, which stopped the passive
    training silently for hours; now a restart brings them back as they were (a STOP file or the dashboard switch still turns them off)."""
    try:
        d = json.loads(_switch_file().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _switches_set(name: str, on: bool) -> None:
    d = _switches_read()
    d[name] = bool(on)
    try:
        _switch_file().write_text(json.dumps(d), encoding="utf-8")
    except OSError:
        pass


def _setup_autorun() -> None:
    """(u253) Auto runs: see brain/autorun.py. Off until switched on in the dashboard."""
    from .autorun import AutoRun

    def status():
        with _lock:
            return _status["data"], time.time() - (_status["at"] or 0)

    def queue(text):
        with _lock:
            _commands.append(text)
            _recent.append({"t": time.strftime("%Y-%m-%d %H:%M:%S"), "type": "command", "text": text})

    def server_send():
        sp = _server["proc"]
        return sp.send if sp is not None and sp.alive() else None

    _auto["server_send"] = server_send

    def batch():
        with _lock:
            return _tests.get("batch")

    def capsules():
        with _lock:
            return list(_capsules)

    def trace_mark():
        with _lock:
            return _trace_seq

    keep = ("tow", "bridge", "Test", "test ", "capsule", "stuck", "sling")

    def traces_since(mark):
        with _lock:
            return [f"{t.get('t', '')[11:]} t{t.get('tick')} {t.get('msg', '')}" for t in _traces if t["id"] > mark and any(k in str(t.get("msg", "")) for k in keep)]

    def test_events(since):
        out = []
        try:
            with (LOG_DIR / "tests.jsonl").open(encoding="utf-8") as fh:
                for line in fh.readlines()[-600:]:
                    try:
                        e = json.loads(line)
                    except ValueError:
                        continue
                    if e.get("t", "") >= since and e.get("type") in ("test_result", "test_run"):
                        out.append(e)
        except OSError:
            pass
        return out

    ar = AutoRun(ROOT, LOG_DIR, status=status, queue=queue, server_send=server_send, batch=batch, capsules=capsules,
                 traces_since=traces_since, trace_mark=trace_mark, test_events=test_events)
    _auto["run"] = ar
    ar.start()
    if _switches_read().get("autorun"):
        ar.set_enabled(True)


def _setup_trainer() -> None:
    """(u290) Training: see brain/trainer.py. Off until switched on in the dashboard. Needs the auto-run machinery (it runs the real-game batches through it)."""
    import shutil
    import subprocess
    import tempfile
    from .trainer import Trainer
    ar = _auto["run"]
    if ar is None:
        return
    repo = ROOT.parent
    node = shutil.which("node") or shutil.which("node.exe")

    def sim_search(group, champion, seed, alive):
        """Run sim/train.mjs. Returns its result dict, None if the switch went off, or {"error": why} so the journal can say what went wrong."""
        if not node:
            return {"error": "node.js was not found on the brain's PATH (the simulator search needs it): install Node or start the brain from a shell where `node` works"}
        if not (repo / "sim" / "train.mjs").exists():
            return {"error": "sim/train.mjs is missing"}
        out = Path(tempfile.gettempdir()) / f"train_{group}_{seed}.json"
        errlog = ROOT / "trainer" / f"sim_{group}.log"
        try:
            out.unlink()
        except OSError:
            pass
        gens, pop = os.environ.get("TRAIN_GENS", "12"), os.environ.get("TRAIN_POP", "10")
        try:
            errf = errlog.open("w", encoding="utf-8")
            proc = subprocess.Popen([node, "sim/train.mjs", "--group", group, "--base", json.dumps(champion), "--seed", str(seed), "--gens", gens, "--pop", pop, "--out", str(out)],
                                    cwd=str(repo), stdout=errf, stderr=subprocess.STDOUT)
        except OSError as e:
            return {"error": f"could not start node: {e}"}
        while proc.poll() is None:
            if not alive():
                proc.kill()
                return None
            time.sleep(2)
        errf.close()
        try:
            return json.loads(out.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            try:
                tail = " | ".join(errlog.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-3:])
            except OSError:
                tail = ""
            return {"error": f"sim/train.mjs exited with code {proc.returncode} and wrote no result: {tail[:300]}"}

    def evolve(seed, alive):
        """Breed hard tow courses (sim/evolve_courses.mjs). Returns its summary, or {"error": why}; never raises."""
        if not node or not (repo / "sim" / "evolve_courses.mjs").exists():
            return {"error": "node or sim/evolve_courses.mjs not found"}
        try:
            r = subprocess.run([node, "sim/evolve_courses.mjs", "--gens", "4", "--pop", "12", "--seed", str(seed)], cwd=str(repo), capture_output=True, text=True, timeout=1500)
            return json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {"error": (r.stderr or "no output")[-200:]}
        except (OSError, ValueError, subprocess.TimeoutExpired) as e:
            return {"error": str(e)[:200]}

    def refit(alive):
        """(u301) Fit the simulator to the real tow runs (sim/fit_outcomes.mjs --apply) once 12 or more new real runs have come in since the last fit. The sim is only
        as good as its match to the game: a search in a sim that has drifted finds things that do not work. Returns a summary, {"skipped": why}, or {"error": why}."""
        if not node or not (repo / "sim" / "fit_outcomes.mjs").exists():
            return {"skipped": "no fitter"}
        n = 0
        try:
            for f in LOG_DIR.glob("tests*.jsonl"):
                for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
                    if '"type": "test_result"' in line and '"name": "lead' in line and '"who": "bot"' in line:
                        n += 1
        except OSError:
            return {"skipped": "no logs"}
        mark = ROOT / "trainer" / "refit.json"
        try:
            last = int(json.loads(mark.read_text(encoding="utf-8")).get("runs", 0))
        except (OSError, ValueError):
            last = 0
        if n - last < 12:
            return {"skipped": f"{n - last} new real tow runs since the last fit"}
        try:
            r = subprocess.run([node, "sim/fit_outcomes.mjs", "--gens", "8", "--apply"], cwd=str(repo), capture_output=True, text=True, timeout=1500)
            mark.write_text(json.dumps({"runs": n, "t": time.strftime("%Y-%m-%d %H:%M:%S")}), encoding="utf-8")
            return {"runs": n, "tail": " | ".join((r.stdout or r.stderr).strip().splitlines()[-3:])[:400]}
        except (OSError, subprocess.TimeoutExpired) as e:
            return {"error": str(e)[:200]}

    def status():
        with _lock:
            return _status["data"], time.time() - (_status["at"] or 0)

    tr = Trainer(ROOT, run_batch=ar.run_batch, send=ar.queue, sim_search=sim_search, status=status, evolve=evolve, refit=refit)
    _train["run"] = tr
    tr.start()
    if _switches_read().get("trainer"):
        tr.set_enabled(True)


def main():
    _load_test_stats()
    _load_test_runs()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    cfg = load_config()
    engine = build_engine(cfg)
    host, port = cfg["host"], cfg["port"]
    key = None
    # Phone mode: "lan": true listens on the local network too (the dashboard can run server
    # commands, so anything off this PC needs the key: this PC and the game never do).
    if cfg.get("lan"):
        host = "0.0.0.0"
        key = access_key(cfg)
    log.info("brain on http://%s:%d  (Jev %s, local LLM %s)", host, port,
             "ON" if engine.jev.available else "off: rules only",
             cfg.get("ollama_url") or "off")
    if key:
        log.info("PHONE: on the same Wi-Fi, open  http://%s:%d/?key=%s", lan_ip(), port, key)
        log.info("(first time only: allow Python through the Windows firewall for Private networks)")
    from .admin_client import AdminClient, AdminLocator
    _server["admin"] = AdminClient(cfg.get("admin_url", ""), cfg.get("admin_bot_token", ""))
    if _server["admin"].configured and "--server" not in sys.argv:
        # The Bedrock admin service owns the server: /locate and the auto runs' console commands go through it (as the bot).
        from .serverproc import LocateJobs
        loc = AdminLocator(_server["admin"])
        _server["proc"], _server["jobs"] = loc, LocateJobs(loc)
        log.info("admin service at %s: /locate and console commands go through it", cfg.get("admin_url"))
    _setup_autorun()
    _setup_trainer()
    httpd = ThreadingHTTPServer((host, port), make_handler(engine, key))
    if "--server" in sys.argv:
        # The Bedrock server as our child (its console is this window): needed for /locate answers.
        from .serverproc import ServerProc
        exe = ROOT.parent / "server" / ("bedrock_server.exe" if os.name == "nt" else "bedrock_server")
        if exe.exists():
            sp = ServerProc(exe)
            _server["proc"] = sp
            from .serverproc import LocateJobs
            _server["jobs"] = LocateJobs(sp)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            sp.start()
            try:
                while sp.alive():
                    time.sleep(1)
            except KeyboardInterrupt:
                pass
            finally:
                sp.stop()
            return
        log.warning("--server: %s not found; running the brain alone", exe)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
