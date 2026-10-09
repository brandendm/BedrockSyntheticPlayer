import json, math, random, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from brain import fights


def eps(n, seed=1):
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        r = math.exp(rng.uniform(-2, 0.5))
        p = 1 / (1 + math.exp(-(3 * (math.log(r) - math.log(0.7)))))   # risk 20% near ratio 0.5
        out.append({"ratio": r, "hp0": 20, "lost": 15 if rng.random() < p else 2, "died": False})
    return out


class FightTests(unittest.TestCase):
    def test_it_recovers_the_ratio_where_risk_is_acceptable(self):
        res = fights.analyse(eps(600))
        self.assertTrue(res["enough"])
        self.assertTrue(0.4 < res["margin"] < 0.65, res)

    def test_too_few_or_one_sided_data_gives_no_margin(self):
        self.assertIsNone(fights.analyse(eps(10))["margin"])
        self.assertIsNone(fights.analyse([{"ratio": 0.5, "hp0": 20, "lost": 1} for _ in range(50)])["margin"])

    def test_store_and_report_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for e in eps(200):
                fights.store(root, e)
            res = fights.write_report(root)
            self.assertEqual(res["n"], 200)
            self.assertTrue((root / "fights" / "report.md").exists())


if __name__ == "__main__":
    unittest.main()
