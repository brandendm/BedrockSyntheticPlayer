import json
import tempfile
import time
import unittest
from pathlib import Path

from brain import admin


def mk(repo: Path, build="u9", pack_build=None, extra=None):
    (repo / "behavior_pack/scripts").mkdir(parents=True)
    (repo / "behavior_pack/scripts/config.js").write_text(f"export const CONFIG = {{\n  build: '{build}',\n}};\n")
    (repo / "behavior_pack/scripts/a.js").write_text("x")
    p = repo / "server/development_behavior_packs/BedrockAgent/scripts"
    p.mkdir(parents=True)
    (p / "config.js").write_text(f"export const CONFIG = {{\n  build: '{pack_build or build}',\n}};\n")
    (p / "a.js").write_text("x" if not extra else extra)


class AdminTests(unittest.TestCase):
    def test_doctor_flags_a_stale_pack_and_game(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            mk(repo, build="u10", pack_build="u9", extra="y")
            (repo / "brain/inbox").mkdir(parents=True); (repo / "brain/logs").mkdir(parents=True)
            checks = {c["name"]: c for c in admin.doctor(repo, {"build": "u8"}, 2.0, {"enabled": False, "tests_this_hour": 20, "limit_per_hour": None}, repo / "brain/logs", repo / "brain/inbox")}
            self.assertFalse(checks["build in the server's pack"]["ok"])
            self.assertFalse(checks["server pack identical to the repo's"]["ok"])
            self.assertFalse(checks["build the game runs"]["ok"])
            self.assertTrue(checks["game talking to the brain"]["ok"])
            self.assertIsNone(checks["autorun switch"]["ok"])
            self.assertIn("20 (no limit)", checks["test runs this hour"]["detail"])

    def test_doctor_all_good(self):
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d); mk(repo)
            (repo / "brain/inbox").mkdir(parents=True); (repo / "brain/logs").mkdir(parents=True)
            checks = {c["name"]: c for c in admin.doctor(repo, {"build": "u9"}, 1.0, {"enabled": True, "state": "waiting", "tests_this_hour": 0, "limit_per_hour": None}, repo / "brain/logs", repo / "brain/inbox")}
            for n in ("build in the repo", "build in the server's pack", "server pack identical to the repo's", "build the game runs", "game talking to the brain", "autorun switch"):
                self.assertTrue(checks[n]["ok"], n)

    def test_tail_log_is_safe_and_filters(self):
        with tempfile.TemporaryDirectory() as d:
            ld = Path(d)
            (ld / "events.jsonl").write_text("\n".join(f'{{"n": {i}, "t": "{"odd" if i % 2 else "even"}"}}' for i in range(50)))
            self.assertEqual(len(admin.tail_log(ld, "events.jsonl", 10)["lines"]), 10)
            self.assertTrue(all("odd" in l for l in admin.tail_log(ld, "events.jsonl", 100, "ODD")["lines"]))
            for bad in ("../x", "a/b", "", "..", "x" * 200):
                self.assertIn("error", admin.tail_log(ld, bad))
            self.assertIn("error", admin.tail_log(ld, "missing.log"))

    def test_history_counts_the_hour(self):
        with tempfile.TemporaryDirectory() as d:
            ld = Path(d)
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            rows = [{"t": "2000-01-01 00:00:00", "event": "start", "request": {"tests": ["a", "b"]}}, {"t": now, "event": "start", "request": {"tests": ["c", "d", "e"]}}]
            (ld / "autorun.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
            self.assertEqual(admin.history(ld)["tests_started_last_hour"], 3)

    def test_validate_run(self):
        self.assertEqual(admin.validate_run({"tests": ["leadstep"], "expect_build": "u275"})["expect_build"], "u275")
        for bad in ({"tests": []}, {"tests": ["a b"]}, {"tests": ["Lead"]}, {"tests": list("abcdefghi")}, {"tests": ["a"], "expect_build": "x"}):
            with self.assertRaises(ValueError):
                admin.validate_run(bad)

    def test_scenarios_reads_the_real_files(self):
        repo = Path(__file__).resolve().parents[2]
        names = {s["name"]: s for s in admin.scenarios(repo)}
        for n in ("leadstep", "leadstephorse", "villagerferry", "probewall", "roof"):
            self.assertIn(n, names)
        self.assertEqual(names["leadstephorse"]["group"], "tow, horse")
        self.assertTrue(names["leadstep"]["you"])
        self.assertFalse(names["probewall"]["you"])


if __name__ == "__main__":
    unittest.main()
