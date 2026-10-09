import sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import miner


class MinerTests(unittest.TestCase):
    def test_test_failures_are_clustered_by_cause(self):
        ev = [{"type": "test_result", "name": "raid", "pass": False, "detail": "died in 36s; mode flee"}] * 3 + \
             [{"type": "test_result", "name": "raid", "pass": True, "detail": "ok"},
              {"type": "test_result", "name": "caveascent", "pass": False, "detail": "still 9 below it in 8s"},
              {"type": "test_result", "name": "raid", "pass": False, "detail": "died", "who": "human"}]
        c = miner.cluster_tests(ev)
        self.assertEqual(c["raid: died while fleeing"], 3)
        self.assertEqual(c["caveascent: still below the surface"], 1)

    def test_bench_stalls_and_deaths(self):
        rec = {"runs": [{"stalls": [{"step": None, "mode": "none", "where": "plan"}] * 2, "deaths": [{"cause": "fall", "step": "get_stone"}]}]}
        c = miner.cluster_bench([rec])
        self.assertEqual(c["bench stall: - / none @plan (after nothing)"], 2)
        self.assertEqual(c["bench death: fall while get_stone"], 3)

    def test_hot_tests_keep_unsettled_and_a_few_settled(self):
        rates = {"a": [10, 10], "b": [10, 10], "c": [10, 10], "d": [2, 8], "e": [1, 2]}
        out = miner.hot_tests(rates, ["a", "b", "c", "d", "e"])
        self.assertEqual(out, ["a", "b", "d", "e"])
        self.assertEqual(len(miner.hot_tests({}, ["x", "y"])), 2)

    def test_write_report(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "logs").mkdir()
            (root / "logs" / "tests.jsonl").write_text('{"type":"test_result","name":"raid","pass":false,"detail":"died"}\n', encoding="utf-8")
            m = miner.write_report(root)
            self.assertTrue((root / "failures.md").read_text(encoding="utf-8").count("raid: died") == 1)
            self.assertEqual(m["clusters"][0][1], 1)


if __name__ == "__main__":
    unittest.main()
