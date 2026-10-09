import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from enable_beta_apis import INT, LONG, STRING, load, save  # noqa: E402
import new_world  # noqa: E402


class NewWorld(unittest.TestCase):
    def test_spawn_is_left_unset_not_at_bedrock(self):
        d = Path(tempfile.mkdtemp())
        save(d / "a.dat", 10, "", {"LevelName": (STRING, "old"), "RandomSeed": (LONG, 5), "SpawnX": (INT, 100), "SpawnY": (INT, 70), "SpawnZ": (INT, -40), "Time": (LONG, 99)})
        seed = new_world.make(d / "a.dat", d / "b" / "level.dat", "Agent u1")
        _, _, r = load(d / "b" / "level.dat")
        self.assertEqual((r["SpawnX"][1], r["SpawnY"][1], r["SpawnZ"][1]), (0, 32767, 0))
        self.assertEqual(r["RandomSeed"][1], seed)
        self.assertNotEqual(seed, 5)
        self.assertNotIn("Time", r)
        self.assertEqual(r["LevelName"][1], "Agent u1")


if __name__ == "__main__":
    unittest.main()
