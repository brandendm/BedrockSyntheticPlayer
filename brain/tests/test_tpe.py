import random, sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tpe

R = {"a": (0.0, 10.0, 5.0), "b": (0.0, 1.0, 0.5), "c": (0.0, 4.0, 2.0), "d": (-1.0, 1.0, 0.0), "e": (0.0, 100.0, 50.0)}


def score(p):                      # a hill: best at a=7, b=0.2
    return -((p["a"] - 7) / 10) ** 2 - (p["b"] - 0.2) ** 2 - ((p["c"] - 1) / 4) ** 2 - ((p["d"] - 0.5) / 2) ** 2 - ((p["e"] - 80) / 100) ** 2


class TpeTests(unittest.TestCase):
    def test_suggestions_stay_in_range_and_keep_the_base(self):
        rng = random.Random(1)
        s = tpe.suggest([], R, rng, base={"other": 3})
        self.assertEqual(s["other"], 3)
        self.assertTrue(0 <= s["a"] <= 10 and 0 <= s["b"] <= 1)

    def test_it_homes_in_on_a_hill_far_faster_than_random(self):
        def run(use_tpe, seed):
            rng = random.Random(seed)
            hist, best = [], -9
            for _ in range(40):
                p = tpe.suggest(hist, R, rng) if use_tpe else {k: rng.uniform(v[0], v[1]) for k, v in R.items()}
                sc = score(p) + rng.gauss(0, 0.01)
                hist.append({"params": p, "score": sc})
                best = max(best, score(p))
            return best
        t = sum(run(True, s) for s in range(12)) / 12
        r = sum(run(False, s) for s in range(12)) / 12
        self.assertGreater(t, r, f"tpe {t:.4f} vs random {r:.4f}")
        self.assertGreater(t, r + 0.005)


try:
    import optuna  # noqa: F401
    HAVE = True
except ImportError:
    HAVE = False


@unittest.skipUnless(HAVE, "optuna not installed")
class OptunaTests(unittest.TestCase):
    def test_optuna_homes_in_on_the_hill(self):
        def run(seed):
            rng = random.Random(seed)
            hist, best = [], -9
            for _ in range(40):
                p = tpe.suggest_optuna(hist, R, rng)
                hist.append({"params": p, "score": score(p) + rng.gauss(0, 0.01)})
                best = max(best, score(p))
            return best
        self.assertGreater(sum(run(s) for s in range(5)) / 5, -0.05)

    def test_keeps_base_and_range(self):
        s = tpe.suggest_optuna([], R, random.Random(2), base={"other": 3})
        self.assertEqual(s["other"], 3)
        self.assertTrue(0 <= s["a"] <= 10)


if __name__ == "__main__":
    unittest.main()
