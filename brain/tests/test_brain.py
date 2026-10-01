import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

from brain import command_parser
from brain.decisions import DecisionEngine
from brain.jev_client import Answer, Budget, Choice, JevClient, Noul
from brain.llm_client import LocalLLM


def fake_transport(value="flee", confidence=0.9, tokens=500):
    calls = []

    def t(url, headers, payload, timeout):
        calls.append(payload)
        answers = {}
        for qid, q in payload["questions"].items():
            if q["type"] == "choice":
                answers[qid] = {"type": "choice", "choice": value, "confidence": confidence,
                                "probabilities": {k: (1.0 if k == value else 0.0) for k in q["criteria"]}}
            elif q["type"] == "noul":
                answers[qid] = {"type": "noul", "noul": value}
            else:
                answers[qid] = {"type": "score", "score": value, "confidence": confidence}
        return {"model": "jev-1.13.0", "answers": answers, "usage": {"input_tokens": tokens, "output_tokens": 20}}

    t.calls = calls
    return t


NO_LLM = LocalLLM(url=None)


class ParserTests(unittest.TestCase):
    def test_goto_variants(self):
        self.assertEqual(command_parser.parse("goto 10 64 -5", "Bran").actions,
                         [{"type": "goto", "x": 10, "y": 64, "z": -5}])
        self.assertEqual(command_parser.parse("Go to 10, -5.", "Bran").actions,
                         [{"type": "goto", "x": 10, "z": -5}])

    def test_come_follow_stop(self):
        self.assertEqual(command_parser.parse("come here", "Bran").actions, [{"type": "come", "player": "Bran"}])
        self.assertEqual(command_parser.parse("follow Steve", "Bran").actions, [{"type": "follow", "player": "steve"}])
        self.assertEqual(command_parser.parse("STOP!", "Bran").actions, [{"type": "stop"}])

    def test_auto(self):
        self.assertEqual(command_parser.parse("auto", "B").actions, [{"type": "auto", "on": True}])
        self.assertEqual(command_parser.parse("auto off", "B").actions, [{"type": "auto", "on": False}])

    def test_unknown(self):
        self.assertIsNone(command_parser.parse("build me an iron farm", "Bran"))


class BudgetTests(unittest.TestCase):
    def test_caps(self):
        b = Budget(max_calls_per_hour=2, max_usd_per_day=1.0)
        self.assertTrue(b.allow(0.1, now=1000))
        b.charge(0.1, now=1000)
        b.charge(0.1, now=1001)
        self.assertFalse(b.allow(0.1, now=1002), "hourly call cap")
        self.assertTrue(b.allow(0.1, now=1000 + 3601), "window slides")

    def test_daily_usd_and_persistence(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "usage.json"
            b = Budget(max_usd_per_day=0.01, path=p)
            b.charge(0.009)
            self.assertFalse(b.allow(0.002))
            self.assertFalse(Budget(max_usd_per_day=0.01, path=p).allow(0.002), "survives restart")


class JevClientTests(unittest.TestCase):
    def test_no_key_means_no_calls(self):
        t = fake_transport()
        self.assertIsNone(JevClient(None, transport=t).decide({}, [Choice("a", "?", ["x"])]))
        self.assertEqual(t.calls, [])

    def test_cache_and_cost(self):
        t = fake_transport(value="x", tokens=1_000_000)
        c = JevClient("k", transport=t)
        q = [Choice("a", "?", ["x", "y"])]
        self.assertEqual(c.decide({"s": 1}, q)["a"].value, "x")
        c.decide({"s": 1}, q)
        self.assertEqual(len(t.calls), 1, "second identical call served from cache")
        self.assertAlmostEqual(c.budget.usd_today, 0.042)

    def test_invalid_option_falls_back(self):
        c = JevClient("k", transport=fake_transport(value="banana"))
        self.assertIsNone(c.decide({}, [Choice("a", "?", ["x", "y"])]))
        self.assertEqual(c.stats["errors"], 1)

    def test_wire_format_matches_docs(self):
        t = fake_transport(value="x")
        JevClient("k", transport=t).decide({"s": 1}, [Choice("a", "?", {"x": "when x", "y": None}), Noul("n", "yes?")])
        q = t.calls[0]["questions"]
        self.assertEqual(q["a"], {"type": "choice", "instructions": "?", "criteria": {"x": "when x", "y": None}})
        self.assertEqual(q["n"], {"type": "noul", "instructions": "yes?"})
        self.assertEqual(t.calls[0]["model"], "jev-latest")

    def test_budget_blocks(self):
        t = fake_transport(value="x")
        c = JevClient("k", transport=t, budget=Budget(max_calls_per_hour=0))
        self.assertIsNone(c.decide({}, [Choice("a", "?", ["x"])]))
        self.assertEqual(t.calls, [])


class DecisionTests(unittest.TestCase):
    STATE = {"pos": {"x": 0, "y": 64, "z": 0}, "health": 20, "task": "idle"}

    def engine(self, transport=None, key="k"):
        return DecisionEngine(JevClient(key, transport=transport or fake_transport()), NO_LLM)

    def test_grammar_first_no_jev_call(self):
        t = fake_transport()
        e = self.engine(t)
        acts = e.handle({"type": "command", "text": "come", "sender": "Bran", "state": self.STATE})
        self.assertEqual(acts, [{"type": "come", "player": "Bran"}])
        self.assertEqual(t.calls, [])

    def test_free_text_goes_to_jev(self):
        e = self.engine(fake_transport(value="follow_me", confidence=0.9))
        acts = e.handle({"type": "command", "text": "stick with me buddy", "sender": "Bran", "state": self.STATE})
        self.assertEqual(acts, [{"type": "follow", "player": "Bran"}])

    def test_low_confidence_not_trusted(self):
        e = self.engine(fake_transport(value="stop", confidence=0.3))
        acts = e.handle({"type": "command", "text": "hmm", "sender": "Bran", "state": self.STATE})
        self.assertEqual(acts[0]["type"], "say")

    def test_creeper_rule_skips_jev(self):
        t = fake_transport(value="ignore")
        e = self.engine(t)
        acts = e.handle({"type": "hostile_near", "state": self.STATE,
                         "hostiles": [{"type": "creeper", "dist": 4, "pos": {"x": 3, "y": 64, "z": 0}}]})
        self.assertEqual(acts[0]["type"], "flee")
        self.assertEqual(acts[0]["from"], {"x": 3, "y": 64, "z": 0})
        self.assertEqual(t.calls, [])

    def test_judgment_call_uses_jev_then_fallback(self):
        ev = {"type": "hostile_near", "state": self.STATE, "hostiles": [{"type": "zombie", "dist": 8, "pos": {"x": 8, "y": 64, "z": 0}}]}
        self.assertEqual(self.engine(fake_transport(value="ignore")).handle(ev), [])
        self.assertEqual(self.engine(key=None).handle(ev), [], "no key: rule fallback, lone zombie at 8 -> ignore")


class ChatTests(unittest.TestCase):
    def jev(self, addressed, intent, conf=0.9):
        def t(url, headers, payload, timeout):
            return {"answers": {"addressed": {"type": "noul", "noul": addressed},
                                "intent": {"type": "choice", "choice": intent, "confidence": conf, "probabilities": {}}},
                    "usage": {"input_tokens": 300}}
        return DecisionEngine(JevClient("k", transport=t), NO_LLM)

    def ev(self, text):
        return {"type": "chat", "text": text, "sender": "Branden", "bot": "Scout", "state": {"task": "auto"}}

    def test_talk_to_the_bot_without_prefix(self):
        acts = self.jev(0.95, "follow_me").handle(self.ev("hey buddy stick with me"))
        self.assertEqual(acts[-1], {"type": "follow", "player": "Branden"})

    def test_ignores_chat_with_other_players(self):
        self.assertEqual(self.jev(0.1, "come").handle(self.ev("lol come look at this")), [])

    def test_name_lowers_the_bar_and_grammar_handles_numbers(self):
        acts = self.jev(0.6, "unsupported").handle(self.ev("Scout, go to 10 64 -5"))
        self.assertEqual(acts, [{"type": "goto", "x": 10, "y": 64, "z": -5}])

    def test_no_key_only_named_commands(self):
        e = DecisionEngine(JevClient(None), NO_LLM)
        self.assertEqual(e.handle(self.ev("Scout come here")), [{"type": "come", "player": "Branden"}])
        self.assertEqual(e.handle(self.ev("come here")), [])


class ServerTests(unittest.TestCase):
    def test_roundtrip(self):
        from http.server import ThreadingHTTPServer
        from brain.server import make_handler

        srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(DecisionEngine(JevClient(None), NO_LLM)))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{srv.server_port}"
            req = urllib.request.Request(f"{url}/event", method="POST", headers={"Content-Type": "application/json"},
                                         data=json.dumps({"type": "command", "text": "stop", "sender": "B"}).encode())
            self.assertEqual(json.loads(urllib.request.urlopen(req).read()), {"actions": [{"type": "stop"}]})
            stats = json.loads(urllib.request.urlopen(f"{url}/stats").read())
            self.assertEqual(stats["decisions_by_layer"], {"grammar": 1})
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()


class DashboardEndpointTests(unittest.TestCase):
    """The dashboard's data: flight reports, test batches and the live trace, over real HTTP."""

    @classmethod
    def setUpClass(cls):
        import threading, urllib.request
        from http.server import ThreadingHTTPServer
        from brain import server
        cls.server = server
        engine = DecisionEngine(JevClient("", transport=fake_transport()), NO_LLM)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(engine))
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.tmp = __import__("tempfile").mkdtemp()
        server.LOG_DIR = __import__("pathlib").Path(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def call(self, path, body=None):
        import json, urllib.request
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req).read())

    def test_flight_report_is_kept_and_not_sent_to_the_decision_engine(self):
        out = self.call("/event", {"type": "flight", "build": "u88", "why": "frozen: 60 s", "report": ["a", "b"], "state": {"pos": {"x": 1, "y": 2, "z": 3}}})
        self.assertEqual(out, {"actions": []})
        reps = self.call("/api/flight")["reports"]
        self.assertEqual(reps[-1]["why"], "frozen: 60 s")
        self.assertEqual(reps[-1]["report"], ["a", "b"])
        recent = self.call("/api/status")["events"]
        self.assertNotIn("report", [k for e in recent for k in e])  # the poll stays light

    def test_test_batch_fills_the_results_table(self):
        self.call("/event", {"type": "test_batch", "build": "u88", "passed": 1, "total": 2, "secs": 90,
                             "results": [{"name": "roof", "pass": True, "secs": 20, "detail": "ok"}, {"name": "vines", "pass": False, "secs": 70, "detail": "vine"}]})
        d = self.call("/api/tests")
        self.assertEqual(d["batch"]["passed"], 1)
        self.assertTrue(d["results"]["roof"]["pass"])
        self.assertFalse(d["results"]["vines"]["pass"])
        self.assertEqual(d["results"]["vines"]["secs"], 70)

    def test_trace_since(self):
        self.call("/poll", {"status": {"online": True}, "traces": [{"tick": 1, "msg": "auto: get_stone8"}, {"tick": 2, "msg": "hurt: zombie"}]})
        d = self.call("/api/trace?since=0")
        msgs = [l["msg"] for l in d["lines"]]
        self.assertIn("hurt: zombie", msgs)
        again = self.call(f"/api/trace?since={d['next']}")
        self.assertEqual(again["lines"], [])
        self.call("/poll", {"status": {"online": True}, "traces": [{"tick": 3, "msg": "new one"}]})
        self.assertEqual([l["msg"] for l in self.call(f"/api/trace?since={d['next']}")["lines"]], ["new one"])


class PhoneAccessTests(unittest.TestCase):
    """Off this PC the dashboard needs the key (it can run server commands); this PC and the game never do."""

    def test_this_pc_never_needs_it(self):
        from brain.server import authorized
        self.assertEqual(authorized("127.0.0.1", "", "", "secret"), "ok")
        self.assertEqual(authorized("::1", "", "", "secret"), "ok")

    def test_no_key_set_means_open(self):
        from brain.server import authorized
        self.assertEqual(authorized("192.168.1.50", "", "", None), "ok")

    def test_phone_needs_key_then_cookie(self):
        from brain.server import authorized
        self.assertEqual(authorized("192.168.1.50", "", "", "secret"), "no")
        self.assertEqual(authorized("192.168.1.50", "", "wrong", "secret"), "no")
        self.assertEqual(authorized("192.168.1.50", "", "secret", "secret"), "set")
        self.assertEqual(authorized("192.168.1.50", "a=1; scout_key=secret", "", "secret"), "ok")
        self.assertEqual(authorized("192.168.1.50", "scout_key=nope", "", "secret"), "no")

    def test_over_http_a_stranger_is_refused_and_the_key_makes_a_cookie(self):
        import threading, http.client
        from http.server import ThreadingHTTPServer
        from brain import server
        engine = DecisionEngine(JevClient("", transport=fake_transport()), NO_LLM)
        # (Connections here come from 127.0.0.1, which is always allowed: pretend it isn't.)
        orig = server.authorized
        server.authorized = lambda ip, cookie, q, key: orig("10.0.0.9", cookie, q, key)
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(engine, "secret"))
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            c = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1])
            c.request("GET", "/api/status"); r = c.getresponse(); r.read()
            self.assertEqual(r.status, 401)
            c.request("POST", "/api/command", body='{"text":"/gamemode creative"}', headers={"Content-Type": "application/json"}); r = c.getresponse(); r.read()
            self.assertEqual(r.status, 401)
            c.request("GET", "/?key=secret"); r = c.getresponse(); r.read()
            self.assertEqual(r.status, 302)
            self.assertIn("scout_key=secret", r.getheader("Set-Cookie"))
            c.request("GET", "/api/status", headers={"Cookie": "scout_key=secret"}); r = c.getresponse(); r.read()
            self.assertEqual(r.status, 200)
            httpd.shutdown()
        finally:
            server.authorized = orig
