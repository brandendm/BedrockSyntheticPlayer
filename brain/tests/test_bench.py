import tempfile
import unittest
from pathlib import Path

from brain import bench

EVT = {"type": "bench_result", "build": "u296", "minutes": 12, "ran_s": 720, "bots": 2,
       "summary": {"score_median": 4.2, "deaths": 1, "milestones": [{"id": "log", "reached": 2, "of": 2, "median_s": 40}, {"id": "planks", "reached": 1, "of": 2, "median_s": 75}],
                   "top_stalls": [{"what": "get_stone / none", "count": 3}], "top_deaths": [{"what": "zombie (after log)", "count": 1}]},
       "runs": [{"name": "ScoutB1", "achieved": {"log": 40}}], "notes": ["only 2 of 3 land spots found"]}


class Bench(unittest.TestCase):
    def test_store_keeps_history_and_writes_the_leaderboard(self):
        root = Path(tempfile.mkdtemp())
        bench.store(root, EVT)
        bench.store(root, {**EVT, "build": "u297"})
        self.assertEqual([r["build"] for r in bench.read(root)], ["u296", "u297"])
        text = (root / "bench" / "leaderboard.md").read_text(encoding="utf-8")
        self.assertIn("get_stone / none: 3", text)
        self.assertIn("planks", text)
        self.assertIn("1:15", text)

    def test_weakest_is_the_first_milestone_not_everyone_reached(self):
        self.assertEqual(bench.weakest(EVT["summary"]), "planks")
        self.assertIsNone(bench.weakest({"milestones": [{"id": "log", "reached": 2, "of": 2}]}))

    def test_empty_leaderboard_says_how_to_run(self):
        self.assertIn("No runs yet", bench.write_leaderboard(Path(tempfile.mkdtemp())))


if __name__ == "__main__":
    unittest.main()
