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
_recent: collections.deque = collections.deque(maxlen=80)
# The bot's decision notes (the live trace panel), flight reports and test results, newest last.
_traces: collections.deque = collections.deque(maxlen=800)
_trace_seq = 0
_flights: collections.deque = collections.deque(maxlen=12)
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
            rec = {"t": now, "tick": t.get("tick"), "msg": str(t.get("msg", ""))[:300]}
            fh.write(json.dumps(rec) + "\n")
            with _lock:
                _trace_seq += 1
                _traces.append({"id": _trace_seq, **rec})


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
    return DecisionEngine(jev, llm, cfg["min_confidence"])


def make_handler(engine: DecisionEngine):
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

        def do_GET(self):
            if self.path in ("/", "/index.html", "/dashboard"):
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
                    lines = [t for t in _traces if t["id"] > since][-300:]
                    nxt = _trace_seq
                return self._send(200, {"next": nxt, "lines": lines})
            if self.path == "/api/flight":
                with _lock:
                    return self._send(200, {"reports": list(_flights)})
            if self.path == "/api/tests":
                with _lock:
                    return self._send(200, {"batch": _tests["batch"], "results": dict(_tests["results"])})
            if self.path == "/health":
                return self._send(200, {"ok": True})
            self._send(404, {"error": "not found"})

        def do_POST(self):
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
    log.info("brain on http://%s:%d  (Jev %s, local LLM %s)", host, port,
             "ON" if engine.jev.available else "off: rules only",
             cfg.get("ollama_url") or "off")
    ThreadingHTTPServer((host, port), make_handler(engine)).serve_forever()


if __name__ == "__main__":
    main()
