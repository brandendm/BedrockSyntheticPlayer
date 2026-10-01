import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

from brain import command_parser, mc_commands
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


class MinecraftCommandTests(unittest.TestCase):
    STATE = {"pos": {"x": 0, "y": 64, "z": 0}, "health": 20, "task": "idle", "bot": "Scout"}

    def cmds(self, text, engine=None):
        e = engine or DecisionEngine(JevClient(None), NO_LLM)
        acts = e.handle({"type": "command", "text": text, "sender": "Bran", "state": self.STATE})
        return [a.get("command", a["type"]) for a in acts]

    def test_chain_of_two(self):
        self.assertEqual(self.cmds("Make it day and clear weather"), ["time set day", "weather clear"])

    def test_three_things_incl_give_list(self):
        self.assertEqual(self.cmds("make it night, make it rain and give me 2 steaks and a bow"),
                         ["time set night", "weather rain", 'give "Bran" cooked_beef 2', 'give "Bran" bow 1'])

    def test_bot_commands_mix_with_game_commands_in_order(self):
        self.assertEqual(self.cmds("come here and make it day"), ["come", "time set day"])

    def test_kill_list_carries_the_verb(self):
        self.assertEqual(self.cmds("kill all zombies and creepers"), ["kill @e[type=zombie]", "kill @e[type=creeper]"])

    def test_misc_kinds(self):
        for text, want in [("set gamemode creative", 'gamemode creative "Bran"'), ("turn on keep inventory", "gamerule keepInventory true"),
                           ("set difficulty to peaceful", "difficulty peaceful"), ("stop the rain", "weather clear"),
                           ("tp me to 10 64 -20", 'tp "Bran" 10 64 -20'), ("give me speed 2 for 5 minutes", 'effect "Bran" speed 300 1 true'),
                           ("give me 10 levels", 'xp 10L "Bran"'), ("heal me", 'effect "Bran" instant_health 1 255 true')]:
            self.assertEqual(self.cmds(text)[0], want, text)

    def test_unsafe_commands_never_pass(self):
        self.assertIsNone(mc_commands.validate("op Steve"))
        self.assertIsNone(mc_commands.validate("whitelist add x"))
        self.assertIsNone(mc_commands.validate("execute as @a run op x"))
        self.assertEqual(mc_commands.validate("/time set day"), "time set day")
        self.assertEqual(self.cmds("/op steve"), ["say"])  # refused: "I didn't understand"... nothing ran
        self.assertNotIn("op steve", self.cmds("/op steve"))

    def test_jev_fills_finite_slots_for_a_paraphrase(self):
        def t(url, headers, payload, timeout):
            ans = {"kind": {"type": "choice", "choice": "time", "confidence": 0.95},
                   "time_value": {"type": "choice", "choice": "day", "confidence": 0.95}}
            for k, v in {"weather_value": "clear", "gamemode_value": "creative", "difficulty_value": "easy"}.items():
                ans[k] = {"type": "choice", "choice": v, "confidence": 0.9}
            return {"answers": ans, "usage": {"input_tokens": 50}}
        e = DecisionEngine(JevClient("k", transport=t), NO_LLM)
        self.assertEqual(self.cmds("it's too dark out here, fix that", e), ["time set day"])

    def test_nothing_understood_falls_through(self):
        self.assertEqual(self.cmds("what is the meaning of life"), ["say"])

    def test_can_be_turned_off(self):
        e = DecisionEngine(JevClient(None), NO_LLM, mc_enabled=False)
        self.assertEqual(self.cmds("make it day", e), ["say"])


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


class LearnTests(unittest.TestCase):
    """What the bot works out of recordings of the player."""

    def recording(self):
        rows = [{"k": "start"}]
        t = 0
        # Eats at food 12, eight times (a golden apple at full food and a potion are not meals).
        for _ in range(8):
            rows += [{"t": t, "k": "s", "x": 0, "y": 64, "z": 0, "food": 12, "sp": 1, "sn": 0, "g": 1}, {"t": t + 5, "k": "eat", "item": "cooked_beef"}]
            t += 20
        rows += [{"t": t, "k": "s", "x": 0, "y": 64, "z": 0, "food": 20}, {"t": t, "k": "eat", "item": "golden_apple"}, {"t": t, "k": "eat", "item": "potion"}]
        # Iron at Y -50 (nine blocks), underground, a few torches 6 apart.
        for i in range(9):
            rows += [{"t": t, "k": "s", "x": i, "y": -50, "z": 0, "food": 18, "sp": 0, "sn": 1, "g": 1}, {"t": t, "k": "b", "id": "deepslate_iron_ore", "x": i, "y": -50, "z": 0, "tool": "stone_pickaxe"}]
        for i in range(4):
            rows.append({"t": t, "k": "p", "id": "torch", "x": i * 6, "y": -50, "z": 0})
        rows += [{"k": "hurt", "cause": "entityAttack", "amt": 3, "by": "zombie"}, {"k": "kill", "mob": "zombie"}, {"k": "die"}]
        return rows

    def test_what_you_eat_at_and_where_you_find_iron(self):
        from brain import learn
        p = learn.analyze([self.recording()])
        self.assertEqual(p["params"]["eat_at"]["value"], 12)
        self.assertEqual(p["params"]["eat_at"]["n"], 8)          # golden apple and potion left out
        self.assertEqual(p["params"]["iron_y"]["value"], -50)
        self.assertEqual(p["params"]["iron_y"]["n"], 9)
        self.assertEqual(p["stats"]["torch_gap"], 6.0)
        self.assertEqual(p["stats"]["deaths"], 1)
        self.assertEqual(p["stats"]["kills"], [("zombie", 1)])
        self.assertGreater(p["stats"]["underground_pct"], 30)

    def test_nothing_recorded_is_not_a_crash(self):
        from brain import learn
        p = learn.analyze([])
        self.assertIsNone(p["params"]["eat_at"]["value"])
        self.assertIn("0 recording", learn.report(p))

    def test_the_game_only_gets_the_numbers(self):
        from brain import learn
        g = learn.for_game(learn.analyze([self.recording()]))
        self.assertEqual(g, {"params": {"eat_at": {"value": 12, "n": 8}, "iron_y": {"value": -50, "n": 9}}})

    def test_recording_over_http_becomes_a_profile(self):
        import threading, tempfile, pathlib, json, urllib.request
        from http.server import ThreadingHTTPServer
        from brain import server
        old = server.LOG_DIR
        server.LOG_DIR = pathlib.Path(tempfile.mkdtemp())
        try:
            engine = DecisionEngine(JevClient("", transport=fake_transport()), NO_LLM)
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(engine))
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            body = json.dumps({"type": "demo", "player": "Br/anden", "session": "2026-10-01", "rows": self.recording()}).encode()
            urllib.request.urlopen(urllib.request.Request(base + "/event", data=body, headers={"Content-Type": "application/json"})).read()
            prof = json.loads(urllib.request.urlopen(base + "/profile").read())
            self.assertEqual(prof["params"]["eat_at"]["value"], 12)
            full = json.loads(urllib.request.urlopen(base + "/api/profile").read())
            self.assertEqual(full["demo"]["recording"], "Br_anden")   # (the name can't make a path)
            self.assertIn("you eat at food: 12", full["report"])
            self.assertTrue(list((server.LOG_DIR / "demos").glob("Br_anden-*.jsonl")))
            httpd.shutdown()
        finally:
            server.LOG_DIR = old
            server._profile.update(at=0.0, data=None)

    def test_a_learned_house_is_kept_and_shown(self):
        import threading, tempfile, pathlib, json, urllib.request
        from http.server import ThreadingHTTPServer
        from brain import server
        old = server.LOG_DIR
        server.LOG_DIR = pathlib.Path(tempfile.mkdtemp())
        try:
            engine = DecisionEngine(JevClient("", transport=fake_transport()), NO_LLM)
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(engine))
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            none = json.loads(urllib.request.urlopen(base + "/api/house").read())
            self.assertIsNone(none["house"])
            evt = {"type": "learned_house", "ok": False, "problems": ["no bed"], "notes": [], "stats": None, "ascii": [], "plan": None, "player": "B"}
            body = json.dumps(evt).encode()
            urllib.request.urlopen(urllib.request.Request(base + "/event", data=body, headers={"Content-Type": "application/json"})).read()
            got = json.loads(urllib.request.urlopen(base + "/api/house").read())["house"]
            self.assertFalse(got["ok"])
            self.assertEqual(got["problems"], ["no bed"])
            self.assertTrue((server.LOG_DIR / "learned_house.jsonl").exists())
            httpd.shutdown()
        finally:
            server.LOG_DIR = old
            server._house.update(at=0.0, data=None)

    def test_the_planner_log_is_kept(self):
        import threading, tempfile, pathlib, json, urllib.request
        from http.server import ThreadingHTTPServer
        from brain import server
        old = server.LOG_DIR
        server.LOG_DIR = pathlib.Path(tempfile.mkdtemp())
        try:
            engine = DecisionEngine(JevClient("", transport=fake_transport()), NO_LLM)
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(engine))
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            body = json.dumps({"type": "why", "tick": 5, "build": "u105", "pos": [1, 2, 3], "step": "{\"step\":\"craft\"}", "key": "craftfurnace", "facts": {"wood": 3}}).encode()
            urllib.request.urlopen(urllib.request.Request(base + "/event", data=body, headers={"Content-Type": "application/json"})).read()
            got = json.loads(urllib.request.urlopen(base + "/api/why").read())["why"]
            self.assertEqual(got[-1]["key"], "craftfurnace")
            self.assertEqual(got[-1]["facts"]["wood"], 3)
            self.assertTrue((server.LOG_DIR / "why.jsonl").exists())
            httpd.shutdown()
        finally:
            server.LOG_DIR = old
            server._why.clear()

    def test_the_path_log_is_kept_and_summed(self):
        import threading, tempfile, pathlib, json, urllib.request
        from http.server import ThreadingHTTPServer
        from brain import server
        old = server.LOG_DIR
        server.LOG_DIR = pathlib.Path(tempfile.mkdtemp())
        try:
            engine = DecisionEngine(JevClient("", transport=fake_transport()), NO_LLM)
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(engine))
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            rows = [{"k": "plan", "who": "S.goNear", "nodes": 100, "ticks": 2, "ok": True}, {"k": "plan", "who": "S.sweep", "nodes": 25000, "ticks": 63, "ok": False}, {"k": "walk", "status": "stuck"}]
            body = json.dumps({"type": "paths", "rows": rows}).encode()
            urllib.request.urlopen(urllib.request.Request(base + "/event", data=body, headers={"Content-Type": "application/json"})).read()
            got = json.loads(urllib.request.urlopen(base + "/api/paths").read())
            self.assertEqual(len(got["rows"]), 3)
            self.assertEqual(got["summary"]["plans"], 2)
            self.assertEqual(got["summary"]["partial_pct"], 50)
            self.assertEqual(got["summary"]["stuck_walks"], 1)
            self.assertEqual(got["summary"]["by_caller"][0]["who"], "S.sweep")   # the worst by nodes first
            self.assertTrue((server.LOG_DIR / "paths.jsonl").exists())
            httpd.shutdown()
        finally:
            server.LOG_DIR = old
            server._paths.clear()

    def test_settings_are_kept_for_new_worlds(self):
        import threading, tempfile, pathlib, json, urllib.request
        from http.server import ThreadingHTTPServer
        from brain import server
        oldf = server.SETTINGS_FILE
        server.SETTINGS_FILE = pathlib.Path(tempfile.mkdtemp()) / "settings.json"
        try:
            engine = DecisionEngine(JevClient("", transport=fake_transport()), NO_LLM)
            httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(engine))
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            post = lambda o: urllib.request.urlopen(urllib.request.Request(base + "/event", data=json.dumps(o).encode(), headers={"Content-Type": "application/json"})).read()
            get = lambda: json.loads(urllib.request.urlopen(base + "/api/settings").read())["settings"]
            self.assertEqual(get(), {})
            post({"type": "setting", "key": "beds", "on": False})
            post({"type": "setting", "key": "chat", "on": True})
            post({"type": "setting", "key": "../etc", "on": True})        # not a setting: ignored
            self.assertEqual(get(), {"beds": False, "chat": True})
            self.assertTrue(server.SETTINGS_FILE.exists())                  # (so a restart of the brain keeps them)
            post({"type": "setting", "key": "beds", "on": True})
            self.assertEqual(get()["beds"], True)
            post({"type": "setting", "reset": True})
            self.assertEqual(get(), {})
            httpd.shutdown()
        finally:
            server.SETTINGS_FILE = oldf
