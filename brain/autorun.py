"""Auto runs: lets Claude start bot tests while you are away, and read the answer.

How it works, in plain words
----------------------------
1. You switch it ON in the dashboard ("Auto runs" box). It is OFF every time the brain starts.
2. Claude writes a small file, brain/inbox/run.json:
       {"tests": ["leadledge", "leadgate"], "reload": true, "expect_build": "u253", "note": "why"}
3. This module sees it, and (only if it is ON):
       - reloads the game's scripts if "reload" is true (types `reload` into the server window; needs the brain to be
         running the server, as Start Agent.bat does),
       - waits for the bot to be back (and on the build Claude expects),
       - queues the command  `test leadledge,leadgate`  (the same as typing it in the dashboard),
       - waits for the batch to finish (at most 20 minutes),
       - writes brain/inbox/result.txt: the result of each test, the tow's trace lines, and any repro capsules.
4. The request file moves to brain/inbox/done/, and every step is logged in brain/logs/autorun.jsonl.

What it will NOT do: anything but `test <names>` and the reload. Names are letters and digits only. At most 8 tests in a request and
24 test runs an hour. Turn it OFF in the dashboard (or put a file called STOP in brain/inbox) and it stops the run in progress.
"""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Callable, Optional

MAX_TESTS_PER_REQUEST = 8
MAX_TESTS_PER_HOUR = 24
BATCH_TIMEOUT_S = 20 * 60
NAME_RE = re.compile(r"^[a-z][a-z0-9]{1,24}$")

README = """AUTO RUNS (what this folder is)
================================
Claude can start bot tests while you are away. It is OFF until you switch it on in the dashboard ("Auto runs" box).

  run.json     a request Claude wrote:  {"tests": ["leadledge"], "reload": true, "expect_build": "u253", "note": "why"}
  result.txt   the answer, written when the tests finish: results, the tow's trace, repro capsules
  done/        every request already handled (with what was done)

It can only (1) reload the game's scripts, and (2) run `test <names>`. Nothing else. At most 8 tests per request and 24 an hour.
To stop it: switch it off in the dashboard, or create an empty file called STOP in this folder.
"""


class RequestError(ValueError):
    pass


def parse_request(text: str) -> dict:
    """The request in run.json, checked. Raises RequestError with a plain reason."""
    try:
        d = json.loads(text)
    except ValueError as e:
        raise RequestError(f"not valid JSON ({e})")
    if not isinstance(d, dict):
        raise RequestError("must be a JSON object")
    tests = d.get("tests")
    if not isinstance(tests, list) or not tests:
        raise RequestError('"tests" must be a list of test names')
    if len(tests) > MAX_TESTS_PER_REQUEST:
        raise RequestError(f"at most {MAX_TESTS_PER_REQUEST} tests in a request")
    clean = []
    for t in tests:
        if not isinstance(t, str) or not NAME_RE.match(t):
            raise RequestError(f"{t!r} is not a test name (letters and digits only)")
        if t not in clean:
            clean.append(t)
    build = d.get("expect_build")
    if build is not None and not (isinstance(build, str) and re.match(r"^[A-Za-z0-9._-]{1,16}$", build)):
        raise RequestError('"expect_build" must be like "u253"')
    return {"tests": clean, "reload": bool(d.get("reload", False)), "expect_build": build, "note": str(d.get("note", ""))[:300]}


def build_result(req: dict, *, started: str, build: Optional[str], outcome: str, events: list, traces: list, capsules: list, notes: list) -> str:
    """The text of result.txt. `events` are the test_result / test_run events since the start (full detail); `traces` the trace lines."""
    out = [f"AUTO RUN RESULT  started {started}  game build {build or '?'}",
           f"asked: {', '.join(req['tests'])}  (reload: {'yes' if req['reload'] else 'no'}{', expecting ' + req['expect_build'] if req.get('expect_build') else ''})",
           f"why: {req.get('note') or '-'}", f"outcome: {outcome}"]
    for n in notes:
        out.append(f"  note: {n}")
    out.append("")
    out.append("RESULTS (the bot's runs; yours are marked)")
    seen = False
    for e in events:
        if e.get("type") == "test_result":
            seen = True
            out.append(f"  {e.get('name')}: {'PASS' if e.get('pass') else 'FAIL'}{' (your turn)' if e.get('who') == 'human' else ''} - {str(e.get('detail', ''))[:1500]}")
    if not seen:
        out.append("  (none came back)")
    for e in events:
        if e.get("type") == "test_run" and e.get("who") == "bot":
            s = e.get("summary") or {}
            out.append(f"  run {e.get('name')}: {s.get('secs')} s, path {s.get('path')}, idle {s.get('idleS')} s, jumps {s.get('jumps')}, placed {s.get('placed')}")
    out.append("")
    out.append(f"TOW AND TEST TRACE ({len(traces)} lines)")
    out.extend(f"  {t}" for t in traces[-250:])
    out.append("")
    out.append(f"REPRO CAPSULES ({len(capsules)})")
    for c in capsules:
        out.append(f"--- {c.get('t')}")
        out.extend(c.get("lines") or [])
        out.append(f"CAPSULE JSON: {json.dumps(c.get('capsule'))}")
    return "\n".join(out) + "\n"


class AutoRun:
    """Watches brain/inbox/run.json. Everything it needs from the brain comes in through the functions given."""

    def __init__(self, root: Path, log_dir: Path, *, status: Callable[[], tuple], queue: Callable[[str], None], server_send: Callable[[], Optional[Callable[[str], None]]],
                 batch: Callable[[], Optional[dict]], capsules: Callable[[], list], traces_since: Callable[[int], list], trace_mark: Callable[[], int],
                 test_events: Callable[[str], list], clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep):
        self.inbox = root / "inbox"
        self.log_file = log_dir / "autorun.jsonl"
        self.status, self.queue, self.server_send = status, queue, server_send
        self.batch, self.capsules, self.traces_since, self.trace_mark, self.test_events = batch, capsules, traces_since, trace_mark, test_events
        self.clock, self.sleep = clock, sleep
        self.enabled = False            # OFF at every start
        self.state = "off"             # what it is doing, in a few words, for the dashboard
        self.history: list = []         # the last runs: {t, tests, outcome}
        self.run_times: list = []       # when each test was started (for the hourly limit)
        self.lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self.inbox.mkdir(parents=True, exist_ok=True)
        (self.inbox / "done").mkdir(exist_ok=True)
        (self.inbox / "README.txt").write_text(README, encoding="utf-8")

    # ---- what the dashboard shows and sets -------------------------------------------------
    def info(self) -> dict:
        h = [t for t in self.run_times if self.clock() - t < 3600]
        return {"enabled": self.enabled, "state": self.state if self.enabled else "off", "last": self.history[-6:], "tests_this_hour": len(h), "limit_per_hour": MAX_TESTS_PER_HOUR}

    def set_enabled(self, on: bool) -> None:
        self.enabled = bool(on)
        self.state = "waiting for a request from Claude" if on else "off"
        self._log({"event": "switched " + ("on" if on else "off")})

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    # ---- the loop --------------------------------------------------------------------------
    def _log(self, rec: dict) -> None:
        try:
            self.log_file.parent.mkdir(exist_ok=True)
            with self.log_file.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"t": time.strftime("%Y-%m-%d %H:%M:%S"), **rec}) + "\n")
        except OSError:
            pass

    def _loop(self) -> None:
        while True:
            try:
                self.poll_once()
            except Exception as e:  # never takes the brain down
                self._log({"event": "error", "error": repr(e)})
                self.state = f"error: {e}"
            time.sleep(2)

    def poll_once(self) -> bool:
        """One look at the inbox. True if a request was handled."""
        req_file = self.inbox / "run.json"
        if (self.inbox / "STOP").exists() and self.enabled:
            self.set_enabled(False)
        if not self.enabled or not req_file.exists():
            return False
        try:
            text = req_file.read_text(encoding="utf-8")
        except OSError:
            return False
        stamp = time.strftime("%Y%m%d-%H%M%S")
        try:
            req = parse_request(text)
        except RequestError as e:
            self._finish(req_file, stamp, {"tests": [], "reload": False, "note": ""}, f"refused: {e}", None)
            return True
        hour = [t for t in self.run_times if self.clock() - t < 3600]
        if len(hour) + len(req["tests"]) > MAX_TESTS_PER_HOUR:
            self._finish(req_file, stamp, req, f"refused: that would be more than {MAX_TESTS_PER_HOUR} test runs in an hour ({len(hour)} so far)", None)
            return True
        self.run_times = hour + [self.clock()] * len(req["tests"])
        self._run(req_file, stamp, req)
        return True

    def _bot_ready(self) -> tuple:
        data, age = self.status()
        return (bool(data and data.get("online") and age < 6), data)

    def _wait(self, cond: Callable[[], bool], timeout: float, state: str) -> bool:
        end = self.clock() + timeout
        self.state = state
        while self.clock() < end:
            if not self.enabled or (self.inbox / "STOP").exists():
                return False
            if cond():
                return True
            self.sleep(1)
        return False

    def _run(self, req_file: Path, stamp: str, req: dict) -> None:
        started = time.strftime("%Y-%m-%d %H:%M:%S")
        notes: list = []
        self._log({"event": "start", "request": req})
        t_mark, caps0 = self.trace_mark(), len(self.capsules())
        outcome = "ok"
        if req["reload"]:
            send = self.server_send()
            if send is None:
                notes.append("could not reload: the brain is not running the server (start it with Start Agent.bat); ran on whatever the game has loaded")
            else:
                self.state = "reloading the game's scripts"
                send("reload")
                self.sleep(3)
                self._wait(lambda: not self._bot_ready()[0], 10, "reloading the game's scripts")  # it goes away briefly
        ok = self._wait(lambda: self._bot_ready()[0] and (not req.get("expect_build") or (self._bot_ready()[1] or {}).get("build") == req["expect_build"]), 120, "waiting for the bot to be back")
        _, data = self._bot_ready()
        build = (data or {}).get("build")
        if not ok:
            outcome = "stopped" if not self.enabled else (f"the game is on build {build}, not the expected {req['expect_build']}: the scripts did not reload" if req.get("expect_build") and build != req["expect_build"] and data and data.get("online") else "the bot did not come online in 2 minutes")
        else:
            self.queue("/say [Auto run from Claude] testing: " + ", ".join(req["tests"]) + ". Switch it off in the dashboard to stop.")
            t0 = time.strftime("%Y-%m-%d %H:%M:%S")
            self.queue("test " + ",".join(req["tests"]))
            self._log({"event": "queued", "tests": req["tests"]})

            def finished() -> bool:
                b = self.batch()
                return bool(b and b.get("t", "") >= t0)

            def running() -> bool:
                d = self._bot_ready()[1] or {}
                return bool((d.get("tests") or {}).get("running"))
            if not self._wait(lambda: running() or finished(), 60, "waiting for the tests to start"):
                outcome = "stopped" if not self.enabled else "the game did not start the tests within a minute"
            elif not self._wait(finished, BATCH_TIMEOUT_S, "tests running: " + ", ".join(req["tests"])):
                outcome = "stopped" if not self.enabled else "the tests did not finish in 20 minutes"
                self.queue("test stop")
        self.sleep(1)
        traces = [t for t in self.traces_since(t_mark)]
        caps = self.capsules()[caps0:]
        events = self.test_events(started)
        text = build_result(req, started=started, build=build, outcome=outcome, events=events, traces=traces, capsules=caps, notes=notes)
        (self.inbox / "result.txt").write_text(text, encoding="utf-8")
        self._finish(req_file, stamp, req, outcome, build)

    def _finish(self, req_file: Path, stamp: str, req: dict, outcome: str, build: Optional[str]) -> None:
        try:
            if outcome.startswith("refused"):
                (self.inbox / "result.txt").write_text(f"AUTO RUN {outcome}\n", encoding="utf-8")
            req_file.replace(self.inbox / "done" / f"{stamp}-run.json")
        except OSError:
            pass
        self.history.append({"t": time.strftime("%H:%M:%S"), "tests": req.get("tests"), "outcome": outcome})
        self._log({"event": "finished", "tests": req.get("tests"), "outcome": outcome, "build": build})
        self.state = "waiting for a request from Claude" if self.enabled else "off"
