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

from . import miner, runstats

GROUPS = ["tow", "combat", "cave", "play"]
# What each group's real-game confirmation runs, and the guards that must not get worse whatever the group. (Names: behavior_pack/scripts/game/scenarios.js.)
GROUP_TESTS = {
    "tow": ["leadledge", "leadstep", "leadstair", "leadturn", "leadgate", "villagerhaul", "leadboat"],
    "combat": ["husk", "creepers", "skel", "shield", "enderman"],
    "cave": ["cavewalk", "cavemobs", "caveescape", "cavedeep", "caveascent", "oceandrop", "oceandeep", "minecollapse", "chasm"],
    "play": ["thicket", "jungle", "swamp", "ambush", "siege", "mobmaze", "lavafield", "raid", "wild"],
}
GUARD_TESTS = ["ravine", "hole", "pit", "bow", "ladder"]
# Normal play for 5 minutes with no setup: run once after a policy is accepted (a champion that dies in ordinary play is undone), and it feeds the weakest-tests table.
HEALTH_TEST = "wild"
BENCH_EVERY = 6      # every 6th cycle (the first, then the 7th ...) the progression benchmark runs on the champion: the real measure of progress (brain/bench.py)
BENCH_TIMEOUT_S = 40 * 60
EVOLVE_EVERY = 5     # every 5th tow cycle first breeds new hard courses (sim/evolve_courses.mjs)
# Ranges for the real-only (cave) steps: mirrors tunables.js (kept in step by tests/test_trainer.py).
REAL_RANGES = {"cave": {"quarryTorchLight": (1, 7, 3)},
               "play": {"calmResume": (10, 100, 40), "attackerMemory": (60, 400, 200), "exploreCost": (30, 100, 60), "digCost": (15, 60, 30), "stickyCost": (3, 20, 10)}}
CAVE_RANGES = {k: v for g in REAL_RANGES.values() for k, v in g.items()}      # (all of them, for the mirror test)
REAL_ONLY = tuple(REAL_RANGES)
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
    # (u301) The continuous scores second opinion: a pass-rate tie that the scores separate decides, and either measure saying "worse" rejects.
    sc = runstats.compare_scores(champ, cand)
    if sc["verdict"] in ("better", "worse") and cmp_["verdict"] in ("same", "need_more"):
        cmp_ = {**cmp_, "verdict": sc["verdict"], "why": sc["why"], "scores": sc}
    elif sc["verdict"] == "worse" and cmp_["verdict"] == "better":
        cmp_ = {**cmp_, "verdict": "same", "why": "pass rate up but scores down: " + sc["why"], "scores": sc}
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
    def __init__(self, root: Path, *, run_batch: Callable, send: Callable[[str], None], sim_search: Callable, status: Callable[[], tuple], evolve: Optional[Callable] = None, refit: Optional[Callable] = None,
                 clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep, seed: int = 1):
        self.dir = root / "trainer"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.run_batch, self.send, self.sim_search, self.status = run_batch, send, sim_search, status
        self.evolve = evolve
        self.refit = refit              # (u301) refits the simulator's physics to the real tow runs so far (sim/fit_outcomes.mjs); throttles itself
        self.bench_every = BENCH_EVERY
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
        self.cells = {k: list(v) for k, v in st.get("cells", {}).items()}   # test -> [passed, tried] over every real run (the weakest-tests table)
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
        self._save("state.json", {"counts": self.counts, "guard_baseline": self.guard_baseline, "cycle_n": self.cycle_n, "group_i": self.group_i, "group_stats": self.group_stats, "cells": self.cells})

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
        weak = sorted(((v[0] / v[1], k, v) for k, v in self.cells.items() if v[1] >= 3))[:8]
        if weak:
            lines += ["", "## Weakest tests (pass rate over every real run, any policy)", "", "| test | passed | tried |", "|---|---|---|"]
            lines += [f"| {k} | {v[0]} | {v[1]} |" for _, k, v in weak]
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

    def _arm(self, policy: dict, tests: list, workers: int = WORKERS, timeout: Optional[float] = None):
        """Run `tests` with `policy` in force. Returns (results, outcome); results are {name, pass, secs}."""
        self.send("policy " + json.dumps(diff(policy)) if policy else "policy clear")
        self.sleep(2)
        outcome, events = self.run_batch(tests, workers, self._alive, **({"timeout": timeout} if timeout else {}))
        res = [{"name": e.get("name"), "pass": bool(e.get("pass")), "secs": e.get("secs") or 0, "score": e.get("score")} for e in events if e.get("type") == "test_result" and e.get("who") != "human"]
        for r in res:
            c = self.cells.setdefault(r["name"], [0, 0])
            c[0] += 1 if r["pass"] else 0
            c[1] += 1
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
        if self.bench_every and self.cycle_n % self.bench_every == 1:
            self.state = f"cycle {self.cycle_n}: progression benchmark on the champion"
            res, outcome = self._arm(self.champion, ["bench"], 1, BENCH_TIMEOUT_S)
            self.journal({"event": "bench", "outcome": outcome, "pass": [r["pass"] for r in res if r["name"] == "bench"], "champion": self.champion})
            if not self._alive():
                return
        self.current_group = group
        rec = {"event": "cycle", "n": self.cycle_n, "group": group, "outcome": "?", "candidate_diff": {}, "why": ""}
        # 1. SEARCH
        sim_ok = False
        if group in REAL_ONLY:
            self.state = f"cycle {self.cycle_n}: {group}: trying a small step from the champion"
            cand = perturb(self.champion, self.rng, REAL_RANGES[group], n_keys=1 + self.rng.randrange(2))
            rec["search"] = "random step (no simulator for this group)"
        else:
            if group == "tow" and self.evolve and self.cycle_n % EVOLVE_EVERY == 0:
                self.state = f"cycle {self.cycle_n}: breeding harder tow courses"
                try:
                    ev = self.evolve(self.rng.randrange(1, 10**6), self._alive)
                except Exception as e:  # noqa: BLE001 - a failed breed never stops training
                    ev = {"error": str(e)}
                self.journal({"event": "evolve", "result": ev})
            if group == "tow" and self.refit:
                self.state = f"cycle {self.cycle_n}: checking the simulator against the real tow runs"
                try:
                    fit = self.refit(self._alive)
                except Exception as e:  # noqa: BLE001 - a failed fit never stops training
                    fit = {"error": str(e)}
                if fit and not fit.get("skipped"):
                    self.journal({"event": "refit", "result": fit})
            self.state = f"cycle {self.cycle_n}: {group}: searching in the simulator"
            res = self.sim_search(group, self.champion, self.rng.randrange(1, 10**6), self._alive)
            if res and res.get("error"):
                rec.update(outcome="aborted", why=res["error"])
                self.counts["aborted"] += 1
                self.alert = None
                self._finish(rec)
                self.sleep(60)          # a broken search is not retried in a tight loop
                return
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
        tests = miner.hot_tests(self.cells, GROUP_TESTS[group]) + GUARD_TESTS   # (u301: the group's settled tests only keep two places: the runs go where the information is)
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
            self.state = f"cycle {self.cycle_n}: {group}: candidate won, checking ordinary play"
            wres, wout = self._arm(cand, [HEALTH_TEST])
            wild = [r for r in wres if r["name"] == HEALTH_TEST]
            if wout == "ok" and wild and not wild[0]["pass"]:         # ordinary play is noisy: one more go before a winner is thrown out
                wres, wout = self._arm(cand, [HEALTH_TEST])
                wild += [r for r in wres if r["name"] == HEALTH_TEST]
            rec["wild"] = [sum(1 for r in wild if r["pass"]), len(wild)]
            if wout == "ok" and wild and not any(r["pass"] for r in wild):
                verdict = {"verdict": "reject", "why": "won the tests but failed ordinary play (the wild test)"}
                rec["why"] = verdict["why"]
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
        try:
            miner.write_report(self.dir.parent)
            miner.write_fixqueue(self.dir.parent)
        except Exception:   # a report never stops the loop
            pass
        if self.enabled:
            self.state = "between cycles"
        self.sleep(1)

    def _bot_ready(self) -> tuple:
        data, age = self.status()
        return (bool(data and data.get("online") and age < 6), data)
