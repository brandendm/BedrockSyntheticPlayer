import random, sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from brain import curriculum as C


class CurriculumTests(unittest.TestCase):
    def test_level_is_read_from_the_detail(self):
        self.assertEqual(C.level_of("died; level 3 seed 17, lowest"), 3)
        self.assertIsNone(C.level_of("reached the gold block"))

    def test_unknown_tests_get_no_level(self):
        self.assertIsNone(C.choose({}, "wild", random.Random(1)))

    def test_it_trains_where_the_bot_wins_about_sixty_percent(self):
        t = {"cavemobs": {"1": [20, 20], "2": [12, 20], "3": [0, 20]}}
        rng = random.Random(4)
        picks = [C.choose(t, "cavemobs", rng) for _ in range(200)]
        self.assertGreater(picks.count(2), 150)

    def test_it_moves_up_when_the_bot_improves(self):
        t = {"x": {"1": [20, 20], "2": [19, 20], "3": [11, 20]}}
        rng = random.Random(4)
        self.assertGreater([C.choose(t, "x", rng) for _ in range(100)].count(3), 70)

    def test_a_level_with_no_runs_still_gets_tried(self):
        t = {"x": {"1": [20, 20]}}
        rng = random.Random(2)
        self.assertTrue(any(C.choose(t, "x", rng) != 1 for _ in range(50)))


if __name__ == "__main__":
    unittest.main()
