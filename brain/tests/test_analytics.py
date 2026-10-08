import tempfile
import unittest
from pathlib import Path

from brain import analytics


def ev(t, name, who, ok, secs, build="u1"):
    import json
    return json.dumps({"t": t, "type": "test_run", "name": name, "who": who, "pass": ok, "summary": {"secs": secs}, "build": build})


class AnalyticsTests(unittest.TestCase):
    def test_efficiency_and_trend(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            lines = [ev("2026-01-01 00:00:0%d" % i, "leadstair", "bot", i >= 5, 20.0) for i in range(10)]
            lines += [ev("2026-01-01 00:01:00", "leadstair", "human", True, 10.0), ev("2026-01-01 00:01:01", "leadstair", "human", True, 10.0)]
            lines += [ev("2026-01-01 00:02:00", "x", "bot", True, 5.0)]
            (d / "tests.jsonl").write_text("\n".join(lines))
            rows = analytics.load_runs(d)
            r = analytics.compute(rows)
            t = {x["name"]: x for x in r["tests"]}["leadstair"]
            self.assertEqual(t["bot"]["recent_rate"], 1.0)
            self.assertEqual(t["bot"]["prior_rate"], 0.0)
            self.assertEqual(t["trend"], "up")
            self.assertAlmostEqual(t["speed"], 0.5)          # twice as slow as you
            self.assertAlmostEqual(r["overall"]["efficiency"], 50.0)  # only leadstair has a baseline from you
            self.assertEqual(r["overall"]["efficiency_n"], 1)
            self.assertIn("leadstair", r["improved"])
            self.assertEqual(r["by_build"][0]["build"], "u1")

    def test_retire_and_attention(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            L = [ev("2026-01-01 00:00:%02d" % i, "easy", "bot", True, 10.0) for i in range(10)]
            L += [ev("2026-01-01 00:01:00", "easy", "human", True, 12.0)]
            L += [ev("2026-01-01 00:02:%02d" % i, "hard", "bot", i == 0, 40.0) for i in range(6)]
            L += [ev("2026-01-01 00:03:%02d" % i, "slow", "bot", True, 100.0) for i in range(6)]
            L += [ev("2026-01-01 00:04:00", "slow", "human", True, 20.0)]
            L += [ev("2026-01-01 00:05:%02d" % i, "few", "bot", True, 5.0) for i in range(2)]
            (d / "tests.jsonl").write_text("\n".join(L))
            r = analytics.compute(analytics.load_runs(d))
            st = {t["name"]: t["status"] for t in r["tests"]}
            self.assertEqual(st, {"easy": "retire", "hard": "attention", "slow": "attention", "few": "new"})
            self.assertEqual(r["retire"], ["easy"])
            self.assertIn("efficiency", {t["name"]: t for t in r["tests"]}["slow"]["why"])

    def test_empty(self):
        with tempfile.TemporaryDirectory() as d:
            r = analytics.compute(analytics.load_runs(Path(d)))
            self.assertIsNone(r["overall"]["efficiency"])
            self.assertEqual(r["tests"], [])
