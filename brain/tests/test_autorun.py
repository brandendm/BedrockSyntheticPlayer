import json
import tempfile
import unittest
from pathlib import Path

from brain.autorun import AutoRun, RequestError, build_result, parse_request


class Fake:
    """A pretend brain: a bot that comes back after a reload, runs the tests it is told to, and a clock that the sleeps advance."""

    def __init__(self, build="u253", can_reload=True, needs_spawn=False):
        self.needs_spawn = needs_spawn
        self.now = 1000.0
        self.build = build
        self.queued, self.sent = [], []
        self.batch_v = None
        self.running = False
        self.can_reload = can_reload
        self.caps = []

    def clock(self):
        return self.now

    def sleep(self, s):
        self.now += s
        # (the pretend game: a queued `test ...` runs for 5 s and then there is a batch)
        if any(q.startswith("test ") and q != "test stop" for q in self.queued) and not self.batch_v:
            self.running = True
            self.batch_v = {"t": "2999-01-01 00:00:00", "passed": 1, "total": 1}

    def status(self):
        # (after a reload the game has no bot until `spawn` is queued)
        online = not (self.needs_spawn and "spawn" not in self.queued)
        return {"online": online, "build": self.build, "tests": {"running": self.running}}, 0.5

    def server_send(self):
        if not self.can_reload:
            return None
        return lambda line: self.sent.append(line)


def make(tmp, fake):
    return AutoRun(Path(tmp), Path(tmp) / "logs", status=fake.status, queue=fake.queued.append, server_send=fake.server_send,
                   batch=lambda: fake.batch_v, capsules=lambda: fake.caps, traces_since=lambda m: ["10:00:01 t5 tow: arrived in 15s"],
                   trace_mark=lambda: 0, test_events=lambda s: [{"type": "test_result", "name": "leadledge", "pass": True, "who": "bot", "detail": "got there"}],
                   clock=fake.clock, sleep=fake.sleep)


class ParseTests(unittest.TestCase):
    def test_good_request(self):
        r = parse_request('{"tests": ["leadledge", "leadgate", "leadledge"], "reload": true, "expect_build": "u253", "note": "x"}')
        self.assertEqual(r["tests"], ["leadledge", "leadgate"])
        self.assertTrue(r["reload"])

    def test_workers(self):
        self.assertEqual(parse_request('{"tests": ["aa"]}')["workers"], 1)
        self.assertEqual(parse_request('{"tests": ["aa"], "workers": 4}')["workers"], 4)
        for bad in ('0', '7', '"2"', 'true', '1.5'):
            with self.assertRaises(RequestError, msg=bad):
                parse_request('{"tests": ["aa"], "workers": ' + bad + '}')

    def test_no_cap_on_how_many_tests(self):
        names = [f"t{i:03d}" for i in range(60)]
        self.assertEqual(len(parse_request(json.dumps({"tests": names}))["tests"]), 60)

    def test_refused(self):
        for bad in ['nope', '[]', '{}', '{"tests": []}', '{"tests": ["a b"]}', '{"tests": ["x;stop"]}', '{"tests": ["/op me"]}',
                    '{"tests": ["leadledge"], "expect_build": "u1 2"}']:
            with self.assertRaises(RequestError, msg=bad):
                parse_request(bad)


class RunTests(unittest.TestCase):
    def test_off_does_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Fake(); a = make(tmp, f)
            (Path(tmp) / "inbox" / "run.json").write_text('{"tests": ["leadledge"]}')
            self.assertFalse(a.poll_once())
            self.assertEqual(f.queued, [])
            self.assertTrue((Path(tmp) / "inbox" / "run.json").exists())

    def test_on_runs_reloads_and_writes_the_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Fake(); a = make(tmp, f); a.set_enabled(True)
            (Path(tmp) / "inbox" / "run.json").write_text('{"tests": ["leadledge"], "reload": true, "expect_build": "u253", "note": "try it"}')
            self.assertTrue(a.poll_once())
            self.assertEqual(f.sent, ["reload"])
            self.assertIn("test leadledge", f.queued)
            self.assertTrue(any(q.startswith("/say ") for q in f.queued))
            res = (Path(tmp) / "inbox" / "result.txt").read_text()
            self.assertIn("leadledge: PASS", res)
            self.assertIn("tow: arrived", res)
            self.assertIn("outcome: ok", res)
            self.assertFalse((Path(tmp) / "inbox" / "run.json").exists())
            self.assertEqual(len(list((Path(tmp) / "inbox" / "done").iterdir())), 1)

    def test_a_reload_that_leaves_no_bot_is_followed_by_spawn(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Fake(needs_spawn=True); a = make(tmp, f); a.set_enabled(True)
            (Path(tmp) / "inbox" / "run.json").write_text('{"tests": ["leadledge"], "reload": true, "expect_build": "u253"}')
            a.poll_once()
            self.assertIn("spawn", f.queued)
            self.assertLess(f.queued.index("spawn"), f.queued.index("test leadledge"))

    def test_wrong_build_says_so_and_runs_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Fake(build="u252"); a = make(tmp, f); a.set_enabled(True)
            (Path(tmp) / "inbox" / "run.json").write_text('{"tests": ["leadledge"], "reload": true, "expect_build": "u253"}')
            a.poll_once()
            self.assertEqual([q for q in f.queued if q.startswith("test ")], [])
            self.assertIn("did not reload", (Path(tmp) / "inbox" / "result.txt").read_text())

    def test_no_server_to_reload_is_said(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Fake(can_reload=False); a = make(tmp, f); a.set_enabled(True)
            (Path(tmp) / "inbox" / "run.json").write_text('{"tests": ["leadledge"], "reload": true}')
            a.poll_once()
            self.assertIn("could not reload", (Path(tmp) / "inbox" / "result.txt").read_text())

    def test_bad_request_is_refused_and_there_is_no_hourly_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Fake(); a = make(tmp, f); a.set_enabled(True)
            (Path(tmp) / "inbox" / "run.json").write_text('{"tests": ["x;y"]}')
            a.poll_once()
            self.assertIn("refused", (Path(tmp) / "inbox" / "result.txt").read_text())
            a.run_times = [f.now] * 500   # (a lot of runs this hour: still not refused)
            (Path(tmp) / "inbox" / "run.json").write_text('{"tests": ["leadledge"]}')
            a.poll_once()
            self.assertNotIn("refused", (Path(tmp) / "inbox" / "result.txt").read_text())

    def test_stop_file_switches_it_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Fake(); a = make(tmp, f); a.set_enabled(True)
            (Path(tmp) / "inbox" / "STOP").write_text("")
            (Path(tmp) / "inbox" / "run.json").write_text('{"tests": ["leadledge"]}')
            self.assertFalse(a.poll_once())
            self.assertFalse(a.enabled)

    def test_result_text_lists_capsules(self):
        t = build_result({"tests": ["a1"], "reload": False, "note": ""}, started="t", build="u253", outcome="ok", events=[], traces=["x"],
                         capsules=[{"t": "t", "lines": ["why: stalled"], "capsule": {"why": "stalled"}}], notes=[])
        self.assertIn("why: stalled", t)
        self.assertIn("CAPSULE JSON", t)


if __name__ == "__main__":
    unittest.main()
