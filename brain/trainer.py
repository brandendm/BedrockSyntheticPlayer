"""Training: the bot improves itself while nobody is watching (u290).

Switch it on in the dashboard ("Training"). Each cycle, for one group of constants in turn (the tow, fight-or-run, the caves):

1. SEARCH   `node sim/train.mjs`: separable CMA-ES over the group's tunables (behavior_pack/scripts/core/tunables.js), scored by the simulators (common random
            numbers, successive halving, a held-out set it never searched on). The caves have no simulator (it has no mobs), so their candidate is a small random
            step from the champion and the real game is the only judge.
2. CONFIRM  the real game, with the bots running tests in parallel (autorun.run_batch): the champion and the candidate take turns, in alternating order, over the
            group's tests and a set of guard tests that must not get worse. brain/runstats.py decides (Wilson intervals, Fisher exact on pass rates, Mann-Whitney
            on times). A candidate that wins promotes; one that loses a guard, or loses, is dropped.
3. KEEP     the champion (only the values that differ from the defaults) goes in brain/trainer/champion.json and into the bot (`!bot policy {json}`: it is stored in
            the world's memory and read at once, no reload). A journal line is written for every cycle and a digest (brain/trainer/digest.md) is rewritten, so
            whoever comes back after a week reads one page.

Safety: nothing here edits code. It only moves numbers inside the ranges in tunables.js. Off at every start. Stops when the switch goes off or a file called STOP
appears in brain/trainer/. If the champion's guard tests fall well below what the defaults scored, it goes back to the defaults and pauses with an alert.
"""
from __future__ import annotations

import json
import random
import threading
import time
from pathlib import Path
from typing import Callable, Optional

from . import runstats

GROUPS = ["tow", "combat", "cave"]
# What each group's real-game confirmation runs, and the guards that must not get worse whatever the group. (Names: behavior_pack/scripts/game/scenarios.js.)
GROUP_TESTS = {
    "tow": ["leadledge", "leadstep", "leadstair", "leadturn", "leadgate", "villagerhaul", "leadboat"],
    "combat": ["husk", "creepers", "skel", "shield", "enderman"],
    "cave": ["cavewalk", "cavemobs", "caveescape", "cavedeep"],
}
GUARD_TESTS = ["ravine", "hole", "pit", "bow", "ladder"]
# Ranges for the real-only (cave) steps: mirrors tunables.js (kept in step by tests/test_trainer.py).
CAVE_RANGES = {"caveTorchEvery": (4, 12, 7), "caveFleeLight": (0, 8, 4)}
ROUNDS_MIN, ROUNDS_MAX = 2, 6
WORKERS = 4


def now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def judge(champ: list, cand: list, guard_champ: list, guard_cand: list, *, sim_ok: bool) -> dict:
    """The decision from the real runs. Each list holds {pass, secs}. Returns { verdict: accept|reject|need_more, why }.
    A candidate is dropped if its guard tests are clearly worse than the champion's (the intervals do not overlap). It wins on the group's tests if runstats says better, or on a tie
    when the simulator already showed a gain and the real pass count is no lower."""
    kg_c, kg_n = sum(1 for r in guard_champ if r["pass"]), sum(1 for r in guard_cand if r["pass"])
    if guard_champ and guard_cand and runstats.wilson(kg_n, len(guard_cand))[1] < runstats.wilson(kg_c, len(guard_champ))[0]:
        return {"verdict": "reject", "why": f"guard tests clearly worse: {kg_c}/{len(guard_champ)} -> {kg_n}/{len(guard_cand)}"}
    cmp_ = runstats.compare(champ, cand)
    if cmp_["verdict"] == "better":
        return {"verdict": "accept", "why": cmp_["why"], "stats": cmp_}
    if cmp_["verdict"] == "worse":
        return {"verdict": "reject", "why": cmp_["why"], "stats": cmp_}
    if cmp_["verdict"] == "need_more":
        return {"verdict": "need_more", "why": cmp_["why"], "stats": cmp_}
    k_c, k_n = sum(1 for r in champ if r["pass"]), sum(1 for r in cand if r["pass"])
    if sim_ok and k_n >= k_c and kg_n >= kg_c:
        return {"verdict": "accept", "why": f"no real difference ({k_c}/{len(champ)} vs {k_n}/{len(cand)}), the simulator showed a gain", "stats": cmp_}
    return {"verdict": "reject", "why": f"no gain in the real game ({cmp_['why']})", "stats": cmp_}


def perturb(champion: dict, rng: random.Random, keys: dict, n_keys: int = 1, step: float = 0.2) -> dict:
    """A small random step for the real-only groups: n_keys of the keys, each moved by up to `step` of its range, kept in range."""
    out = dict(champion)
    for k in rng.sample(sorted(keys), min(n_keys, len(keys))):
        lo, hi, dflt = keys[k]
        cur = out.get(k, dflt)
        out[k] = round(min(hi, max(lo, cur + rng.uniform(-step, step) * (hi - lo))), 3)
    return out


def diff(policy: dict) -> dict:
    return {k: v for k, v in policy.items() if isinstance(v, (int, float))}


class Trainer:
    def __init__(self, root: Path, *, run_batch: Callable, send: Callable[[str], None], sim_search: Callable, status: Callable[[], tuple],
                 clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep, seed: int = 1):
        self.dir = root / "trainer"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.run_batch, self.send, self.sim_search, self.status = run_batch, send, sim_search, status
        self.clock, self.sleep = clock, sleep
        self.rng = random.Random(seed)
        self.enabled = False            # off at every start
        self.state = "off"
        self.alert: Optional[str] = None
        self.group_i = 0
        self.cycle_n = 0
        self.candidate: dict = {}
        self.current_group: Optional[str] = None
        self.lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self.champion = self._load("champion.json", {})
        st = self._load("state.json", {})
        self.counts = st.get("counts", {"accepted": 0, "rejected": 0, "sim_none": 0, "aborted": 0})
        self.guard_baseline = st.get("guard_baseline")       # [k, n] of the defaults on the guard tests
        self.cycle_n = st.get("cycle_n", 0)
        self.group_i = st.get("group_i", 0)
        self.group_stats = {g: list(st.get("group_stats", {}).get(g, [0, 0])) for g in GROUPS}   # g -> [accepted, tried]

    # ---- files --------------------------------------------------------------------------------
    def _load(self, name: str, default):
        try:
            return json.loads((self.dir / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return default

    def _save(self, name: str, obj) -> None:
        try:
            (self.dir / name).write_text(json.dumps(obj, indent=1), encoding="utf-8")
        except OSError:
            pass

    def _save_state(self) -> None:
        self._save("state.json", {"counts": self.counts, "guard_baseline": self.guard_baseline, "cycle_n": self.cycle_n, "group_i": self.group_i, "group_stats": self.group_stats})

    def journal(self, rec: dict) -> None:
        try:
            with (self.dir / "journal.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"t": now(), **rec}) + "\n")
        except OSError:
            pass

    def read_journal(self, n: int = 200) -> list:
        out = []
        try:
            for line in (self.dir / "journal.jsonl").read_text(encoding="utf-8").splitlines()[-n:]:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
        except OSError:
            pass
        return out

    def write_digest(self) -> str:
        j = [e for e in self.read_journal(400) if e.get("event") == "cycle"]
        lines = ["# Training digest", "", f"Written {now()}.  Cycles so far: {self.cycle_n}  (accepted {self.counts['accepted']}, rejected {self.counts['rejected']}, "
                 f"no simulator gain {self.counts['sim_none']}, aborted {self.counts['aborted']}).", ""]
        if self.alert:
            lines += [f"**ALERT: {self.alert}**", ""]
        lines += ["## Champion (only the values that differ from the defaults)", "", "```json", json.dumps(self.champion, indent=1), "```", "", "## Last cycles", "",
                  "| when | group | outcome | what changed | why |", "|---|---|---|---|---|"]
        for e in reversed(j[-25:]):
            lines.append(f"| {e.get('t')} | {e.get('group')} | {e.get('outcome')} | {json.dumps(e.get('candidate_diff', {}))} | {str(e.get('why', ''))[:120]} |")
        text = "\n".join(lines) + "\n"
        try:
            (self.dir / "digest.md").write_text(text, encoding="utf-8")
        except OSError:
            pass
        return text

    # ---- what the dashboard shows and sets ----------------------------------------------------
    def info(self) -> dict:
        j = [e for e in self.read_journal(60) if e.get("event") == "cycle"]
        return {"enabled": self.enabled, "state": self.state if self.enabled else "off", "alert": self.alert, "group": self.current_group, "champion": self.champion,
                "candidate": self.candidate, "counts": self.counts, "cycles": self.cycle_n, "last": j[-8:], "guard_baseline": self.guard_baseline}

    def set_enabled(self, on: bool) -> None:
        self.enabled = bool(on)
        if on:
            self.alert = None
            try:
                (self.dir / "STOP").unlink()
            except OSError:
                pass
        self.state = "starting" if on else "off"
        self.journal({"event": "switched " + ("on" if on else "off")})

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _alive(self) -> bool:
        if (self.dir / "STOP").exists() and self.enabled:
            self.set_enabled(False)
        return self.enabled

    # ---- the loop -----------------------------------------------------------------------------
    def _loop(self) -> None:
        while True:
            try:
                if self._alive():
                    self.cycle()
                else:
                    self.sleep(2)
            except Exception as e:  # never takes the brain down
                self.journal({"event": "error", "error": repr(e)})
                self.state = f"error: {e}"
                self.sleep(30)

    def _arm(self, policy: dict, tests: list, workers: int = WORKERS):
        """Run `tests` with `policy` in force. Returns (results, outcome); results are {name, pass, secs}."""
        self.send("policy " + json.dumps(diff(policy)) if policy else "policy clear")
        self.sleep(2)
        outcome, events = self.run_batch(tests, workers, self._alive)
        res = [{"name": e.get("name"), "pass": bool(e.get("pass")), "secs": e.get("secs") or 0} for e in events if e.get("type") == "test_result" and e.get("who") != "human"]
        return res, outcome

    def _measure_baseline(self) -> bool:
        """Once: how the defaults do on the guard tests, so a later collapse can be told from noise."""
        if self.guard_baseline:
            return True
        self.state = "measuring the defaults on the guard tests"
        ks, ns = 0, 0
        for _ in range(2):
            res, outcome = self._arm({}, GUARD_TESTS)
            if outcome != "ok":
                return False
            ks += sum(1 for r in res if r["pass"])
            ns += len(res)
        self.guard_baseline = [ks, ns]
        self._save_state()
        self.journal({"event": "baseline", "guard": self.guard_baseline})
        return True

    def cycle(self) -> None:
        ready, _ = self._bot_ready()
        if not ready:
            self.state = "waiting for the game (the bot is not online)"
            self.sleep(15)
            return
        if not self._measure_baseline():
            self.state = "the guard-test baseline did not finish: trying again"
            self.sleep(30)
            return
        group = self._pick_group()
        self.group_i += 1
        self.cycle_n += 1
        self.current_group = group
        rec = {"event": "cycle", "n": self.cycle_n, "group": group, "outcome": "?", "candidate_diff": {}, "why": ""}
        # 1. SEARCH
        sim_ok = False
        if group == "cave":
            self.state = f"cycle {self.cycle_n}: {group}: trying a small step from the champion"
            cand = perturb(self.champion, self.rng, CAVE_RANGES, n_keys=1 + self.rng.randrange(2))
            rec["search"] = "random step (no simulator for caves)"
        else:
            self.state = f"cycle {self.cycle_n}: {group}: searching in the simulator"
            res = self.sim_search(group, self.champion, self.rng.randrange(1, 10**6), self._alive)
            if not res or not res.get("accepted"):
                rec.update(outcome="no simulator gain", why=(f"train {res['train'][0]:.2f}->{res['train'][1]:.2f}, held {res['held'][0]:.2f}->{res['held'][1]:.2f}" if res else "the search did not finish"))
                self.counts["sim_none" if res else "aborted"] += 1
                self._finish(rec)
                return
            cand = {**self.champion, **res["best"]}
            sim_ok = True
            rec["search"] = f"sim train {res['train'][0]:.2f}->{res['train'][1]:.2f}, held {res['held'][0]:.2f}->{res['held'][1]:.2f}, {res['evals']} evaluations"
        rec["candidate_diff"] = {k: v for k, v in cand.items() if self.champion.get(k) != v}
        self.candidate = cand
        if not rec["candidate_diff"]:
            rec.update(outcome="no change", why="the search found the champion")
            self._finish(rec)
            return
        # 2. CONFIRM in the real game: champion and candidate in alternating order, a round at a time, until it is decided
        tests = GROUP_TESTS[group] + GUARD_TESTS
        champ_g, cand_g, champ_x, cand_x = [], [], [], []
        verdict = {"verdict": "need_more", "why": "no runs yet"}
        for rnd in range(ROUNDS_MAX):
            if not self._alive():
                rec.update(outcome="stopped", why="switched off")
                self.counts["aborted"] += 1
                self._finish(rec)
                return
            order = [("champ", self.champion), ("cand", cand)] if rnd % 2 == 0 else [("cand", cand), ("champ", self.champion)]
            for label, pol in order:
                self.state = f"cycle {self.cycle_n}: {group}: real game, round {rnd + 1}, {'champion' if label == 'champ' else 'candidate'}"
                res, outcome = self._arm(pol, tests)
                if outcome != "ok":
                    rec.update(outcome="aborted", why=f"the batch ended: {outcome}")
                    self.counts["aborted"] += 1
                    self._finish(rec)
                    return
                grp = [r for r in res if r["name"] in GROUP_TESTS[group]]
                gd = [r for r in res if r["name"] in GUARD_TESTS]
                (champ_g if label == "champ" else cand_g).extend(grp)
                (champ_x if label == "champ" else cand_x).extend(gd)
            if rnd + 1 >= ROUNDS_MIN:
                verdict = judge(champ_g, cand_g, champ_x, cand_x, sim_ok=sim_ok)
                if verdict["verdict"] != "need_more":
                    break
        if verdict["verdict"] == "need_more":
            verdict = {"verdict": "reject", "why": "undecided after the maximum rounds: " + verdict["why"]}
        rec["real"] = {"champion": [sum(1 for r in champ_g if r["pass"]), len(champ_g)], "candidate": [sum(1 for r in cand_g if r["pass"]), len(cand_g)],
                       "guard_champion": [sum(1 for r in champ_x if r["pass"]), len(champ_x)], "guard_candidate": [sum(1 for r in cand_x if r["pass"]), len(cand_x)]}
        rec["why"] = verdict["why"]
        # 3. KEEP
        if verdict["verdict"] == "accept":
            self.champion = diff(cand)
            self._save("champion.json", self.champion)
            self.counts["accepted"] += 1
            rec["outcome"] = "ACCEPTED"
        else:
            self.counts["rejected"] += 1
            rec["outcome"] = "rejected"
        self.candidate = {}
        # the bot is left on the champion, whatever the last arm was
        self.send("policy " + json.dumps(diff(self.champion)) if self.champion else "policy clear")
        # a champion whose guard tests collapsed against the defaults' own baseline goes back to the defaults
        self._check_collapse(rec, champ_x if verdict["verdict"] != "accept" else cand_x)
        self._finish(rec)

    def _pick_group(self) -> str:
        """Which group to work on: Thompson sampling on how often each has produced an accepted change (Beta(1+accepted, 1+rejected)), so the effort drifts to where
        training is paying and away from where it has dried up; one cycle in five goes to the least-tried group regardless, so none is ever written off."""
        if self.rng.random() < 0.2:
            fewest = min(self.group_stats[g][1] for g in GROUPS)
            return self.rng.choice([g for g in GROUPS if self.group_stats[g][1] == fewest])
        draw = {g: self.rng.betavariate(1 + self.group_stats[g][0], 1 + self.group_stats[g][1] - self.group_stats[g][0]) for g in GROUPS}
        return max(GROUPS, key=lambda g: draw[g])

    def _check_collapse(self, rec: dict, guard_runs: list) -> None:
        if not self.guard_baseline or len(guard_runs) < 6 or not self.champion:
            return
        base = self.guard_baseline[0] / max(1, self.guard_baseline[1])
        now_ = sum(1 for r in guard_runs if r["pass"]) / len(guard_runs)
        if now_ < base - 0.25:
            self.alert = f"the champion's guard tests fell to {now_:.0%} from the defaults' {base:.0%}: back to the defaults, training paused"
            self.champion = {}
            self._save("champion.json", {})
            self.send("policy clear")
            self.enabled = False
            self.state = "paused: " + self.alert
            rec["alert"] = self.alert

    def _finish(self, rec: dict) -> None:
        g = rec.get("group")
        if g in self.group_stats and rec.get("outcome") not in ("aborted", "stopped"):
            self.group_stats[g][1] += 1
            if rec.get("outcome") == "ACCEPTED":
                self.group_stats[g][0] += 1
        self.journal(rec)
        self._save_state()
        self.write_digest()
        if self.enabled:
            self.state = "between cycles"
        self.sleep(1)

    def _bot_ready(self) -> tuple:
        data, age = self.status()
        return (bool(data and data.get("online") and age < 6), data)
