"""(u276) The admin / debug panel's backend: pure helpers the /admin page asks for. Nothing here changes anything; the actions
(reload, spawn, run tests, stop) are wired in server.py behind the same login key as the dashboard.

  doctor()        one list of checks: is the build in the repo the one in the server's pack and the one the game is running, is the pack
                  identical, is the game talking to us, the autorun's switch and hourly allowance, disk, log sizes, stale git locks, node
  scenarios()     every test name with flags (slow, you can do it), read from game/scenarios.js, core/towcourses.js and core/probes.js
  list_logs / tail_log   the brain's logs, a safe name only, the last lines, optionally filtered
  history()       the autorun's own log: what was asked, how it ended, how many test runs in the last hour
  reports()/report()     brain/reports/*.md (nightly, regression)
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from pathlib import Path
from typing import Optional

SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")


def parse_build(config_js: Path) -> Optional[str]:
    try:
        m = re.search(r"build:\s*'(u\d+)'", config_js.read_text(encoding="utf-8"))
        return m.group(1) if m else None
    except OSError:
        return None


def _hash(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def pack_diff(src: Path, dst: Path) -> dict:
    """Files of the pack in the repo that are missing or different in the server's copy."""
    missing, different, n = [], [], 0
    if not src.is_dir():
        return {"n": 0, "missing": [], "different": [], "src_missing": True}
    for f in sorted(src.rglob("*")):
        if not f.is_file():
            continue
        n += 1
        rel = str(f.relative_to(src)).replace("\\", "/")
        g = dst / rel
        if not g.is_file():
            missing.append(rel)
        elif _hash(f) != _hash(g):
            different.append(rel)
    return {"n": n, "missing": missing, "different": different, "src_missing": False}


def _check(name: str, ok: Optional[bool], detail: str) -> dict:
    """ok: True good, False wrong, None worth a look."""
    return {"name": name, "ok": ok, "detail": detail}


def doctor(repo: Path, status: Optional[dict], status_age: Optional[float], auto: Optional[dict], log_dir: Path, inbox: Path, now: Optional[float] = None) -> list:
    now = now if now is not None else time.time()
    out = []
    repo_build = parse_build(repo / "behavior_pack/scripts/config.js")
    pack = repo / "server/development_behavior_packs/BedrockAgent"
    pack_build = parse_build(pack / "scripts/config.js")
    game_build = (status or {}).get("build")
    out.append(_check("build in the repo", repo_build is not None, repo_build or "config.js not found"))
    out.append(_check("build in the server's pack", pack_build is not None and pack_build == repo_build, f"{pack_build or 'none'} (repo {repo_build})" + ("" if pack_build == repo_build else ": copy behavior_pack into the server's pack (tools/ship.mjs does)")))
    d = pack_diff(repo / "behavior_pack", pack)
    out.append(_check("server pack identical to the repo's", not d["missing"] and not d["different"] and not d.get("src_missing"),
                      f"{d['n']} files" if not d["missing"] and not d["different"] else f"{len(d['different'])} different, {len(d['missing'])} missing: " + ", ".join((d["different"] + d["missing"])[:4])))
    if game_build is None:
        out.append(_check("build the game runs", None, "the game has not reported one (not running, or no poll yet)"))
    else:
        out.append(_check("build the game runs", game_build == pack_build, f"{game_build}" + ("" if game_build == pack_build else f": the pack has {pack_build}: type `reload` in the server window (or the Reload button), or restart the server")))
    alive = status_age is not None and status_age < 8
    out.append(_check("game talking to the brain", alive, f"last poll {status_age:.0f} s ago" if status_age is not None else "never heard from the game"))
    if auto is not None:
        out.append(_check("autorun switch", True if auto.get("enabled") else None, ("ON: " + str(auto.get("state"))) if auto.get("enabled") else "OFF (it resets whenever the brain restarts): turn it on to take run.json requests"))
        used = auto.get("tests_this_hour", 0)
        out.append(_check("test runs this hour", True, f"{used} (no limit)"))
    if (inbox / "STOP").exists():
        out.append(_check("STOP file", False, "brain/inbox/STOP exists: a run in progress is stopped and new ones refused until it is removed or the switch is turned on"))
    if (inbox / "run.json").exists():
        out.append(_check("pending request", None, "brain/inbox/run.json is waiting to be picked up"))
    try:
        free = shutil.disk_usage(repo).free / 1e9
        out.append(_check("disk free", free > 2, f"{free:.1f} GB"))
    except OSError:
        pass
    big = []
    try:
        for f in log_dir.iterdir():
            if f.is_file() and f.stat().st_size > 150e6:
                big.append(f"{f.name} {f.stat().st_size / 1e6:.0f} MB")
    except OSError:
        pass
    out.append(_check("log sizes", not big, "all under 150 MB" if not big else "big: " + ", ".join(big)))
    locks = []
    gd = repo / ".git"
    try:
        for f in gd.rglob("*.lock"):
            if "stale" not in str(f):
                locks.append(str(f.relative_to(gd)).replace("\\", "/"))
    except OSError:
        pass
    out.append(_check("git lock files", not locks, "none" if not locks else "left behind: " + ", ".join(locks[:3]) + " (move them aside; git fails with 'File exists')"))
    out.append(_check("node on the PATH", shutil.which("node") is not None, shutil.which("node") or "not found (sim/gate, tools/ship need it)"))
    return out


def scenarios(repo: Path) -> list:
    """[{name, group, slow, you}] for every test name."""
    src = (repo / "behavior_pack/scripts/game/scenarios.js").read_text(encoding="utf-8")
    quoted = lambda m: set(re.findall(r"'([a-z0-9_]+)'", m.group(1))) if m else set()
    names = re.findall(r"'([a-z0-9_]+)'", (re.search(r"const NAMES = \[([^\]]*)\]", src) or [None, ""])[1])
    slow = quoted(re.search(r"const SLOW = new Set\(\[([^\]]*)\]", src))
    human = quoted(re.search(r"const HUMAN_OK = new Set\(\[([^\]]*)\]", src))
    player_only = quoted(re.search(r"const PLAYER_ONLY = new Set\(\[([^\]]*)\]", src))
    tow = re.findall(r"^  (lead[a-z]+): \{", (repo / "behavior_pack/scripts/core/towcourses.js").read_text(encoding="utf-8"), re.M)
    probes = re.findall(r"^  (probe[a-z0-9]+): \{", (repo / "behavior_pack/scripts/core/probes.js").read_text(encoding="utf-8"), re.M)
    allnames = list(dict.fromkeys(names + tow + [t + "horse" for t in tow] + probes))
    out = []
    for n in allnames:
        group = "probe" if n in probes else "tow" if n in tow else "tow, horse" if n.endswith("horse") and n[:-5] in tow else "horse" if "horse" in n else "scenario"
        out.append({"name": n, "group": group, "slow": n in slow or group in ("probe", "tow", "tow, horse"), "you": (n in human or group in ("tow", "tow, horse")) and group != "probe", "player_only": n in player_only})
    return out


def list_logs(log_dir: Path) -> list:
    out = []
    try:
        for f in sorted(log_dir.iterdir()):
            if f.is_file() and SAFE_NAME.match(f.name):
                st = f.stat()
                out.append({"name": f.name, "bytes": st.st_size, "age_s": int(time.time() - st.st_mtime)})
    except OSError:
        pass
    return out


def tail_log(log_dir: Path, name: str, n: int = 200, grep: str = "") -> dict:
    if not SAFE_NAME.match(name or ""):
        return {"error": "bad name"}
    f = log_dir / name
    if not f.is_file():
        return {"error": "no such log"}
    n = max(1, min(int(n), 2000))
    with f.open("rb") as fh:
        fh.seek(0, 2)
        size = fh.tell()
        fh.seek(max(0, size - 600_000))
        data = fh.read().decode("utf-8", "replace")
    lines = data.split("\n")
    if size > 600_000:
        lines = lines[1:]
    g = (grep or "").lower()
    if g:
        lines = [l for l in lines if g in l.lower()]
    lines = [l[:1500] for l in lines if l.strip()][-n:]
    return {"name": name, "bytes": size, "lines": lines}


def history(log_dir: Path, n: int = 40) -> dict:
    f = log_dir / "autorun.jsonl"
    rows = []
    try:
        for line in f.read_text(encoding="utf-8").splitlines()[-800:]:
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        pass
    cutoff = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - 3600))
    hour = sum(len(r.get("request", {}).get("tests", [])) for r in rows if r.get("event") == "start" and r.get("t", "") >= cutoff)
    return {"rows": rows[-n:], "tests_started_last_hour": hour}


def reports(repo: Path) -> list:
    d = repo / "brain/reports"
    try:
        return [{"name": f.name, "bytes": f.stat().st_size, "age_s": int(time.time() - f.stat().st_mtime)} for f in sorted(d.glob("*.md"), reverse=True)[:60]]
    except OSError:
        return []


def report(repo: Path, name: str) -> dict:
    if not SAFE_NAME.match(name or "") or not name.endswith((".md", ".log")):
        return {"error": "bad name"}
    f = repo / "brain/reports" / name
    if not f.is_file():
        return {"error": "no such report"}
    return {"name": name, "text": f.read_text(encoding="utf-8", errors="replace")[:200_000]}


def validate_run(d: dict) -> dict:
    """The same shape the autorun accepts: names of letters and digits, at most 8."""
    tests = [str(t) for t in (d.get("tests") or [])]
    if not tests or len(tests) > 8 or not all(re.fullmatch(r"[a-z0-9]+", t) for t in tests):
        raise ValueError("tests: 1 to 8 names, lower-case letters and digits")
    out = {"tests": tests, "reload": bool(d.get("reload", False)), "note": str(d.get("note", "from the admin panel"))[:300]}
    eb = d.get("expect_build")
    if eb:
        if not re.fullmatch(r"u\d+", str(eb)):
            raise ValueError("expect_build looks like u275")
        out["expect_build"] = str(eb)
    return out
