import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runstats import wilson, fisher_p, mannwhitney_p, compare, allocate


def runs(passes, fails, secs=10.0):
    return [{"pass": True, "secs": secs + i * 0.1} for i in range(passes)] + [{"pass": False, "secs": None} for _ in range(fails)]


class StatsTests(unittest.TestCase):
    def test_wilson(self):
        lo, hi = wilson(0, 5)
        self.assertEqual(lo, 0.0)
        self.assertTrue(0.3 < hi < 0.5)
        lo, hi = wilson(50, 100)
        self.assertTrue(0.41 < lo < 0.43 and 0.57 < hi < 0.59)
        self.assertEqual(wilson(0, 0), (0.0, 1.0))

    def test_fisher_known_value(self):
        # the classic tea-tasting table
        self.assertAlmostEqual(fisher_p(3, 1, 1, 3), 0.4857, places=3)
        self.assertAlmostEqual(fisher_p(5, 0, 0, 5), 0.00794, places=4)
        self.assertEqual(fisher_p(0, 0, 0, 0), 1.0)

    def test_mannwhitney(self):
        a, b = [10, 11, 12, 13, 14, 15], [20, 21, 22, 23, 24, 25]
        self.assertLess(mannwhitney_p(a, b), 0.02)
        self.assertGreater(mannwhitney_p(a, a), 0.9)
        self.assertEqual(mannwhitney_p([1, 2], [3, 4]), 1.0)

    def test_compare_small_noise_is_not_a_verdict(self):
        c = compare(runs(0, 5), runs(2, 3))
        self.assertEqual(c["verdict"], "need_more")

    def test_compare_clear_cut_small(self):
        c = compare(runs(0, 5), runs(5, 0))
        self.assertEqual(c["verdict"], "better")

    def test_compare_better_worse_same(self):
        self.assertEqual(compare(runs(3, 9), runs(11, 1))["verdict"], "better")
        self.assertEqual(compare(runs(11, 1), runs(3, 9))["verdict"], "worse")
        self.assertEqual(compare(runs(8, 4), runs(9, 3))["verdict"], "same")

    def test_compare_faster_with_same_pass_rate(self):
        c = compare(runs(10, 0, secs=20), runs(10, 0, secs=12))
        self.assertEqual(c["verdict"], "better")
        self.assertIn("median time", c["why"])

    def test_allocate_prefers_the_unknown_and_the_changed(self):
        stats = {"settled": {"k": 40, "n": 40}, "fresh": {"k": 0, "n": 0}, "changed": {"k": 5, "n": 6, "changed": True}, "retire": {"k": 20, "n": 20, "retire": True}}
        a = allocate(stats, 12)
        self.assertEqual(sum(a.values()), 12)
        self.assertGreater(a.get("fresh", 0) + a.get("changed", 0), a.get("settled", 0) + a.get("retire", 0))
        self.assertLessEqual(max(a.values()), 6)  # no test takes more than half

    def test_allocate_budget_zero(self):
        self.assertEqual(allocate({"a": {"k": 1, "n": 2}}, 0), {})


if __name__ == "__main__":
    unittest.main()
