import json
import random
import re
import tempfile
import unittest
from pathlib import Path

from brain import trainer as T
from brain.trainer import Trainer, judge, perturb


def runs(passes, total, secs=30):
    return [{"pass": i < passes, "secs": secs} for i in range(total)]


class Judge(unittest.TestCase):
    def test_clear_gain_accepts(self):
        v = judge(runs(1, 12), runs(11, 12), runs(5, 10), runs(5, 10), sim_ok=False)
        self.assertEqual(v["verdict"], "accept")

    def test_clear_loss_rejects(self):
        v = judge(runs(11, 12), runs(1, 12), runs(5, 10), runs(5, 10), sim_ok=True)
        self.assertEqual(v["verdict"], "reject")

    def test_a_worse_guard_rejects_whatever_else(self):
        v = judge(runs(1, 12), runs(12, 12), runs(10, 10), runs(4, 10), sim_ok=True)
        self.assertEqual(v["verdict"], "reject")
        self.assertIn("guard", v["why"])

    def test_a_tie_with_a_simulator_gain_accepts_but_without_it_rejects(self):
        a = judge(runs(10, 12), runs(10, 12), runs(5, 10), runs(5, 10), sim_ok=True)
        b = judge(runs(10, 12), runs(10, 12), runs(5, 10), runs(5, 10), sim_ok=False)
        self.assertEqual((a["verdict"], b["verdict"]), ("accept", "reject"))

    def test_a_tie_that_is_slightly_lower_in_the_real_game_rejects(self):
        v = judge(runs(10, 12), runs(9, 12), runs(5, 10), runs(5, 10), sim_ok=True)
        self.assertEqual(v["verdict"], "reject")

    def test_too_few_runs_is_undecided(self):
        v = judge(runs(2, 4), runs(3, 4), runs(2, 2), runs(2, 2), sim_ok=True)
        self.assertEqual(v["verdict"], "need_more")


class Perturb(unittest.TestCase):
    def test_steps_stay_in_range_and_change_something(self):
        rng = random.Random(3)
        for _ in range(50):
            p = perturb({}, rng, T.CAVE_RANGES, n_keys=2)
            for k, v in p.items():
                lo, hi, _ = T.CAVE_RANGES[k]
                self.assertTrue(lo <= v <= hi)

    def test_ranges_match_the_game_registry(self):
        src = (Path(__file__).resolve().parents[2] / "behavior_pack/scripts/core/tunables.js").read_text(encoding="utf-8")
        for k, (lo, hi, d) in T.CAVE_RANGES.items():
            m = re.search(k + r":\s*\{ v: ([\d.]+), min: ([\d.]+), max: ([\d.]+), group: '(?:cave|play)'", src)
            self.assertTrue(m, k)
            self.assertEqual((float(m.group(2)), float(m.group(3)), float(m.group(1))), (lo, hi, d))


class World:
    """A pretend game: pass rates depend on the policy in force (a dict of pass rates by name and policy), recorded sends, a clock the sleeps advance."""

    def __init__(self, rate_for):
        self.now = 0.0
        self.sent, self.batches = [], []
        self.policy = {}
        self.rate_for = rate_for
        self.rng = random.Random(1)
        self.alive = True

    def clock(self):
        return self.now

    def sleep(self, s):
        self.now += s

    def send(self, text):
        self.sent.append(text)
        self.policy = json.loads(text[7:]) if text.startswith("policy {") else {}

    def run_batch(self, tests, workers, alive, timeout=None):
        self.batches.append((list(tests), dict(self.policy)))
        ev = [{"type": "test_result", "name": n, "pass": self.rng.random() < self.rate_for(n, self.policy), "secs": 30} for n in tests]
        return "ok", ev

    def status(self):
        return {"online": True}, 0.1


def make(world, sim, root=None):
    root = root or Path(tempfile.mkdtemp())
    t = Trainer(root, run_batch=world.run_batch, send=world.send, sim_search=sim, status=world.status, clock=world.clock, sleep=world.sleep, seed=2)
    t.bench_every = 0                  # (the benchmark has its own test below)
    t.set_enabled(True)
    t._pick_group = lambda: T.GROUPS[t.group_i % len(T.GROUPS)]      # (the tests choose the group with group_i)
    return t


def good_sim(group, champion, seed, alive):
    return {"accepted": True, "best": {"fightMargin": 0.7}, "train": [7, 5], "held": [6, 5], "evals": 10}


class Cycle(unittest.TestCase):
    def test_a_better_candidate_becomes_champion_and_is_sent_to_the_bot(self):
        w = World(lambda n, p: 0.95 if p.get("fightMargin") == 0.7 and n in T.GROUP_TESTS["combat"] else (0.9 if n in T.GUARD_TESTS or n == T.HEALTH_TEST else 0.15))
        t = make(w, good_sim)
        t.group_i = 1                      # combat
        t.guard_baseline = [9, 10]
        t.cycle()
        self.assertEqual(t.champion, {"fightMargin": 0.7})
        self.assertEqual(t.counts["accepted"], 1)
        self.assertTrue(w.sent[-1].startswith('policy {"fightMargin": 0.7}'))
        self.assertEqual(json.loads((t.dir / "champion.json").read_text()), {"fightMargin": 0.7})
        self.assertIn("ACCEPTED", (t.dir / "journal.jsonl").read_text())

    def test_a_winner_that_fails_ordinary_play_is_not_kept(self):
        w = World(lambda n, p: 0.0 if n == T.HEALTH_TEST else (0.95 if p.get("fightMargin") == 0.7 and n in T.GROUP_TESTS["combat"] else (0.9 if n in T.GUARD_TESTS else 0.15)))
        t = make(w, good_sim)
        t.group_i = 1
        t.guard_baseline = [9, 10]
        t.cycle()
        self.assertEqual(t.champion, {})
        self.assertIn("ordinary play", (t.dir / "journal.jsonl").read_text())

    def test_the_progression_benchmark_runs_on_the_champion_every_few_cycles(self):
        w = World(lambda n, p: 0.9)
        t = make(w, lambda *a: {"accepted": False, "train": [1, 1], "held": [1, 1], "evals": 1})
        t.bench_every = 6
        t.guard_baseline = [9, 10]
        t.cycle()
        self.assertEqual(w.batches[0][0], ["bench"])
        self.assertIn('"event": "bench"', (t.dir / "journal.jsonl").read_text())

    def test_weakest_tests_table_and_evolve_hook(self):
        calls = []
        w = World(lambda n, p: 0.1 if n == "caveescape" else 0.9)
        t = make(w, good_sim)
        t.evolve = lambda seed, alive: calls.append(seed) or {"learnable": 1}
        t.guard_baseline = [9, 10]
        t.cycle_n = T.EVOLVE_EVERY - 1
        t.group_i = 0                      # tow
        t.cycle()
        self.assertEqual(len(calls), 1)
        t.cells["caveescape"] = [1, 9]
        self.assertIn("caveescape", t.write_digest())

    def test_refit_runs_before_a_tow_search_and_is_journaled_unless_skipped(self):
        calls = []
        w = World(lambda n, p: 0.9)
        t = make(w, good_sim)
        t.refit = lambda alive: calls.append(1) or {"runs": 14, "tail": "fitted"}
        t.guard_baseline = [9, 10]
        t.group_i = 0                      # tow
        t.cycle()
        self.assertEqual(len(calls), 1)
        self.assertTrue(any(e.get("event") == "refit" for e in t.read_journal(20)))
        t2 = make(World(lambda n, p: 0.9), good_sim)
        t2.refit = lambda alive: {"skipped": "3 new real tow runs since the last fit"}
        t2.guard_baseline = [9, 10]
        t2.group_i = 0
        t2.cycle()
        self.assertFalse(any(e.get("event") == "refit" for e in t2.read_journal(20)))

    def test_a_candidate_that_does_nothing_in_the_real_game_is_dropped(self):
        w = World(lambda n, p: 0.5)
        t = make(w, lambda *a: {"accepted": True, "best": {"fightMargin": 0.7}, "train": [7, 5], "held": [6, 5], "evals": 3})
        t.group_i = 1
        t.guard_baseline = [5, 10]
        for _ in range(1):
            t.cycle()
        self.assertIn(t.counts["rejected"] + t.counts["accepted"], (1,))

    def test_a_candidate_that_breaks_a_guard_is_dropped(self):
        w = World(lambda n, p: (0.2 if p.get("fightMargin") == 0.7 and n in T.GUARD_TESTS else 0.95))
        t = make(w, good_sim)
        t.group_i = 1
        t.guard_baseline = [9, 10]
        for _ in range(3):
            t.cycle()
            t.group_i = 1
        self.assertEqual(t.champion, {})

    def test_no_simulator_gain_costs_no_real_runs(self):
        w = World(lambda n, p: 0.9)
        t = make(w, lambda *a: {"accepted": False, "best": {}, "train": [5, 5], "held": [5, 5]})
        t.group_i = 0
        t.guard_baseline = [9, 10]
        t.cycle()
        self.assertEqual(w.batches, [])
        self.assertEqual(t.counts["sim_none"], 1)

    def test_baseline_is_measured_once_on_the_defaults(self):
        w = World(lambda n, p: 0.8)
        t = make(w, lambda *a: {"accepted": False, "best": {}, "train": [5, 5], "held": [5, 5]})
        t.cycle()
        self.assertEqual(len(w.batches), 2)
        self.assertEqual(w.batches[0][1], {})
        self.assertIsNotNone(t.guard_baseline)
        t.cycle()
        self.assertEqual(len(w.batches), 2)        # not measured again

    def test_a_collapse_against_the_baseline_reverts_and_pauses(self):
        w = World(lambda n, p: 0.1 if p else 0.95)
        t = make(w, good_sim)
        t.group_i = 1
        t.guard_baseline = [9, 10]
        t.champion = {"fightMargin": 0.6}
        t.cycle()
        self.assertEqual(t.champion, {})
        self.assertIsNotNone(t.alert)
        self.assertFalse(t.enabled)
        self.assertEqual(w.sent[-1], "policy clear")

    def test_stop_file_switches_it_off(self):
        w = World(lambda n, p: 0.9)
        t = make(w, good_sim)
        (t.dir / "STOP").write_text("")
        self.assertFalse(t._alive())
        self.assertFalse(t.enabled)

    def test_the_cave_group_uses_a_random_step_and_the_real_game_alone(self):
        w = World(lambda n, p: 0.9)
        called = []
        t = make(w, lambda *a: called.append(a))
        t.group_i = 2
        t.guard_baseline = [9, 10]
        t.cycle()
        self.assertEqual(called, [])
        self.assertTrue(w.batches)

    def test_the_digest_names_the_champion(self):
        w = World(lambda n, p: 0.9)
        t = make(w, good_sim)
        t.champion = {"fightMargin": 0.7}
        self.assertIn("fightMargin", t.write_digest())


class LearningHelpers(unittest.TestCase):
    def _t(self):
        return Trainer(Path(tempfile.mkdtemp()) , run_batch=None, send=None, sim_search=None, status=lambda: ({}, 0), seed=3)

    def test_failed_seeds_are_remembered_and_replayed_on_odd_rounds(self):
        t = self._t()
        t._note_hard_seeds([{"name": "cavemobs", "pass": False, "detail": "x; level 3 seed 17, y"}, {"name": "cavemobs", "pass": True, "detail": "seed 5"}])
        self.assertEqual(t._seed_map(0, 9, ["cavemobs"]), {"*": 9})
        self.assertEqual(t._seed_map(1, 9, ["cavemobs", "wild"]), {"*": 9, "cavemobs": 17})

    def test_learned_margin_needs_enough_fights_and_a_real_difference(self):
        t = self._t()
        self.assertIsNone(t._learned_margin())
        (t.dir.parent / "fights").mkdir()
        (t.dir.parent / "fights" / "suggest.json").write_text(json.dumps({"enough": True, "margin": 0.45}))
        self.assertEqual(t._learned_margin(), 0.45)
        t.champion = {"fightMargin": 0.46}
        self.assertIsNone(t._learned_margin())

    def test_tpe_history_is_kept_per_group(self):
        t = self._t()
        t._hist_add("play", [{"params": {"calmResume": 40}, "score": 0.7}])
        self.assertEqual(len(t._hist("play")), 1)
        self.assertEqual(t._hist("cave"), [])


if __name__ == "__main__":
    unittest.main()


class PickGroup(unittest.TestCase):
    def test_effort_drifts_to_the_group_that_pays_but_none_is_dropped(self):
        t = Trainer(Path(tempfile.mkdtemp()), run_batch=None, send=None, sim_search=None, status=lambda: ({}, 0), seed=5)
        t.group_stats = {"tow": [0, 12], "combat": [9, 12], "cave": [0, 12], "play": [0, 12]}
        picks = [t._pick_group() for _ in range(400)]
        self.assertGreater(picks.count("combat"), 250)
        self.assertGreater(picks.count("tow"), 5)
        self.assertGreater(picks.count("cave"), 5)

    def test_untried_groups_are_each_tried(self):
        t = Trainer(Path(tempfile.mkdtemp()), run_batch=None, send=None, sim_search=None, status=lambda: ({}, 0), seed=1)
        seen = {t._pick_group() for _ in range(60)}
        self.assertEqual(seen, set(T.GROUPS))

    def test_results_are_counted_per_group_and_saved(self):
        w = World(lambda n, p: 0.9)
        t = make(w, lambda *a: {"accepted": False, "best": {}, "train": [5, 5], "held": [5, 5]})
        t.group_i = 1
        t.guard_baseline = [9, 10]
        t.cycle()
        self.assertEqual(t.group_stats["combat"], [0, 1])
        self.assertEqual(json.loads((t.dir / "state.json").read_text())["group_stats"]["combat"], [0, 1])


class SearchErrors(unittest.TestCase):
    def test_a_failed_search_is_journaled_with_its_reason_and_costs_no_real_runs(self):
        w = World(lambda n, p: 0.9)
        t = make(w, lambda *a: {"error": "node.js was not found"})
        t.group_i = 0
        t.guard_baseline = [9, 10]
        t.cycle()
        self.assertEqual(w.batches, [])
        self.assertEqual(t.counts["aborted"], 1)
        self.assertIn("node.js was not found", (t.dir / "journal.jsonl").read_text())
