"""The Bedrock server run as a child of the brain, so the brain can type commands into its console and read what it prints.

Why: `/locate structure village` and `/locate biome forest` use the game's own generator (exact, unlike a Java-based seed map), but a script's
runCommand does not return the command's text. The server's console prints it. So: the brain starts bedrock_server.exe with its stdin and stdout
piped, shows everything the server prints in this window, passes what you type here on to the server ("stop" works as before), and offers
locate(kind, name, x, z) to the rest of the brain (POST /locate from the add-on).
"""
import logging
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger("serverproc")
# "The nearest village is at (1056, ~, 112)", "... at block 1056, (y), 112", "... located at 1056, 64, 112": two numbers with a middle that is
# a third number, ~ or (y).
COORDS = re.compile(r"(-?\d+)\s*[, ]\s*(?:\(y\??\)|~|-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+)")
PREFIX = re.compile(r"^\s*\[[^\]]*\]\s*")
FAIL = re.compile(r"could not|cannot|no (?:\w+ )*(?:found|within)|not found|unknown|syntax|incorrect|invalid", re.I)


class ServerProc:
    def __init__(self, exe: Path):
        self.exe = exe
        self.proc = None
        self.lines = []          # recent output (for locate): [(time, text)]
        self.cv = threading.Condition()
        self.lock = threading.Lock()   # one locate at a time

    def start(self):
        self.proc = subprocess.Popen([str(self.exe)], cwd=str(self.exe.parent), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, bufsize=1, errors="replace")
        threading.Thread(target=self._read_out, daemon=True).start()
        threading.Thread(target=self._read_in, daemon=True).start()
        log.info("server started (pid %s): its console is this window", self.proc.pid)

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def send(self, line: str):
        try:
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
        except Exception as e:  # the server has gone
            log.warning("could not send %r: %s", line, e)

    def _read_out(self):
        for raw in self.proc.stdout:
            sys.stdout.write(raw)
            sys.stdout.flush()
            with self.cv:
                self.lines.append((time.time(), raw.rstrip("\r\n")))
                del self.lines[:-400]
                self.cv.notify_all()

    def _read_in(self):
        # What is typed in the brain's window goes to the server ("stop" shuts it down cleanly).
        try:
            for line in sys.stdin:
                if not self.alive():
                    break
                self.send(line.rstrip("\r\n"))
        except Exception:
            pass

    def _ask(self, command: str, timeout: float):
        """Send a command and return the first output line after it with coordinates, or ('fail', text), or None on silence."""
        t0 = time.time()
        self.send(command)
        end = t0 + timeout
        seen = len(self.lines)
        with self.cv:
            while time.time() < end:
                for ts, text in self.lines[:]:
                    if ts < t0:
                        continue
                    body = PREFIX.sub("", text)
                    m = COORDS.search(body)
                    if m and not body.lower().startswith(("execute", "locate", "running", "player connected", "player disconnected")):
                        return (int(m.group(1)), int(m.group(2)))
                    if FAIL.search(body) and "locate" not in body.lower().split("command")[0] and ts >= t0:
                        return ("fail", body)
                self.cv.wait(0.2)
        return None

    def locate(self, kind: str, name: str, x=None, z=None, timeout: float = 15.0) -> dict:
        """kind: 'structure' or 'biome'. Returns {x, z} or {error}."""
        if not self.alive():
            return {"error": "the server is not running under the brain"}
        if kind not in ("structure", "biome") or not re.fullmatch(r"[a-z_]+", name or ""):
            return {"error": "bad request"}
        with self.lock:
            t_start = time.time()
            cmds = []
            if x is not None and z is not None:
                cmds.append(f"execute positioned {int(x)} 64 {int(z)} run locate {kind} {name}")
            cmds.append(f"locate {kind} {name}")
            last = None
            for i, c in enumerate(cmds):
                r = self._ask(c, 6.0 if i == 0 and len(cmds) > 1 else timeout)
                last = r
                if isinstance(r, tuple) and r and r[0] != "fail":
                    log.info("locate %s %s -> %s", kind, name, r)
                    return {"x": r[0], "z": r[1], "how": c.split(" run ")[0] if " run " in c else "console"}
            seen = [PREFIX.sub("", t) for ts, t in self.lines if ts >= t_start][-4:]
            return {"error": f"no answer ({last[1] if isinstance(last, tuple) else 'silence'}); the console said: {' | '.join(seen)[:300] or 'nothing'}"}

    def stop(self):
        if self.alive():
            self.send("stop")
            try:
                self.proc.wait(timeout=20)
            except Exception:
                self.proc.kill()


class LocateJobs:
    """/locate can take a while and a game-side HTTP request gives up after a few seconds: the request starts a job (one per question) and
    waits a short time for it; if it is not done the reply is {pending: true} and the add-on asks again, until the answer is there."""
    def __init__(self, proc):
        self.proc = proc
        self.jobs = {}
        self.guard = threading.Lock()

    def ask(self, kind, name, x, z, wait: float = 3.5) -> dict:
        key = (kind, name, None if x is None else int(x) // 256, None if z is None else int(z) // 256)
        with self.guard:
            job = self.jobs.get(key)
            if job is None or (job["done"] and time.time() - job["at"] > 600):
                job = {"done": False, "res": None, "at": time.time()}
                self.jobs[key] = job

                def run():
                    job["res"] = self.proc.locate(kind, name, x, z)
                    job["done"] = True
                    job["at"] = time.time()
                threading.Thread(target=run, daemon=True).start()
        end = time.time() + wait
        while time.time() < end and not job["done"]:
            time.sleep(0.1)
        if job["done"]:
            res = job["res"]
            if "error" in res:           # a miss is asked again next time, not remembered for ten minutes
                with self.guard:
                    self.jobs.pop(key, None)
            return res
        return {"pending": True}
