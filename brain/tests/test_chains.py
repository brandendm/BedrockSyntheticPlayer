import json
import tempfile
import unittest
from pathlib import Path

from brain import server


class Chains(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = server.CHAINS_FILE
        server.CHAINS_FILE = Path(self.tmp.name) / "chains.json"

    def tearDown(self):
        server.CHAINS_FILE = self.old
        self.tmp.cleanup()

    def test_none_until_saved(self):
        self.assertIsNone(server.load_chains())

    def test_roundtrip_and_clean(self):
        n = server.save_chains([{"name": " Horse ", "as": "weird", "lines": ["/summon horse", "", "  /ride @s  "]}, {"name": "B", "as": "server", "lines": ["/time set day"]}])
        self.assertEqual(n, 2)
        got = server.load_chains()
        self.assertEqual(got[0], {"name": "Horse", "as": "player", "lines": ["/summon horse", "/ride @s"]})
        self.assertEqual(got[1]["as"], "server")

    def test_rejects_bad_input(self):
        for bad in ("x", [1], [{"name": "", "lines": ["a"]}], [{"name": "n"}] * 61):
            with self.assertRaises(ValueError):
                server.save_chains(bad)
        self.assertIsNone(server.load_chains())


if __name__ == "__main__":
    unittest.main()
