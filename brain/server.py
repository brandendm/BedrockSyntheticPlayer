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
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .decisions import DecisionEngine
from .jev_client import Budget, JevClient
from .llm_client import LocalLLM

ROOT = Path(__file__).resolve().parent
log = logging.getLogger("brain")


LOG_DIR = ROOT / "logs"

# Dashboard state (in memory; the game resends status every second).
_lock = threading.Lock()
_status = {"data": None, "at": 0.0}
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
_recent: collections.deque = collections.deque(maxlen=400)
# The bot's decision notes (the live trace panel), flight reports and test results, newest last.
_traces: collections.deque = collections.deque(maxlen=5000)
_trace_seq = 0
_flights: collections.deque = collections.deque(maxlen=12)
_paths: collections.deque = collections.deque(maxlen=6000)  # the pathfinding log (searches and walks)
_why: collections.deque = collections.deque(maxlen=3000)  # the planner's reasons, one per step chosen (brain/logs/why.jsonl)
_tests: dict = {"batch": None, "results": {}}


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
        with (LOG_DIR / "learned_house.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(keep) + "\n")
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


def remember(evt: dict) -> None:
    """Keep what the dashboard shows from a logged event: flight reports, test results, the last batch."""
    kind = evt.get("type")
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with _lock:
        if kind == "flight":
            _flights.append({"t": now, "why": str(evt.get("why", ""))[:300], "build": evt.get("build"),
                             "report": [str(x)[:400] for x in (evt.get("report") or [])][:80], "pos": (evt.get("state") or {}).get("pos")})
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
        _recent.append({k: v for k, v in rec.items() if k not in ("report", "results")})
    names = ["events.jsonl"] + (["tests.jsonl"] if evt.get("type") in ("test_result", "test_batch") else []) + (["flight.jsonl"] if evt.get("type") == "flight" else [])
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


def make_handler(engine: DecisionEngine, key: str | None = None):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, obj: dict):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

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
                return self._send(200, ABOUT)
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
            if self.path == "/api/flight":
                with _lock:
                    return self._send(200, {"reports": list(_flights)})
            if self.path == "/api/tests":
                with _lock:
                    return self._send(200, {"batch": _tests["batch"], "results": dict(_tests["results"])})
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
            if self.path == "/api/command":
                try:
                    text = str(self._read_json().get("text", "")).strip()[:200]
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
            if evt.get("type") in ("log", "test_result", "test_batch", "flight"):
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


def main():
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
    ThreadingHTTPServer((host, port), make_handler(engine, key)).serve_forever()


if __name__ == "__main__":
    main()
