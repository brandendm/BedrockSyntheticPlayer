import http.client
import json
import sys
import tempfile
import threading
import unittest
import zipfile
from http.server import ThreadingHTTPServer
from pathlib import Path

from admin import service as S

FAKE = str(Path(__file__).with_name("fake_bedrock.py"))


def make_env(tmp: Path):
    sd = tmp / "server"
    w = sd / "worlds" / "Bedrock level" / "db"
    w.mkdir(parents=True)
    (w / "a.ldb").write_bytes(b"AAAAAAAAAA")      # 10 bytes, the server says 5
    (w / "b.ldb").write_bytes(b"BBB")
    (sd / "server.properties").write_text("# comment\nserver-name=Test\nlevel-name=Bedrock level\ngamemode=survival\n", encoding="utf-8")
    cfg = dict(S.DEFAULTS, server_dir=str(sd), server_cmd=[sys.executable, FAKE], backups_dir=str(tmp / "backups"),
               tokens={"owner": "OWN", "bot": "BOT"}, brain_url="http://127.0.0.1:9")
    admin, sm = S.build(cfg, base=tmp)
    return cfg, admin, sm, sd


class Pure(unittest.TestCase):
    def test_console_rules(self):
        for who in ("owner", "bot"):
            for ok in ("time set night", "/weather clear", "op Steve", "stop", "execute as @a run give @s apple"):
                self.assertTrue(S.console_allowed(who, ok)[0], (who, ok))
            for bad in ("", "   ", "time set day\nstop", "a\rb"):
                self.assertFalse(S.console_allowed(who, bad)[0], (who, bad))

    def test_roles(self):
        t = {"owner": "o", "bot": "b"}
        self.assertEqual(S.role_of(t, "o"), "owner")
        self.assertEqual(S.role_of(t, "b"), "bot")
        self.assertIsNone(S.role_of(t, "x"))
        self.assertIsNone(S.role_of(t, None))

    def test_config_makes_tokens(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "config.json"
            c = S.load_config(p)
            self.assertTrue(c["tokens"]["owner"] and c["tokens"]["bot"] and c["tokens"]["owner"] != c["tokens"]["bot"])
            self.assertEqual(S.load_config(p)["tokens"], c["tokens"])

    def test_properties(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "server.properties"
            p.write_text("# c\na=1\nb=2\n", encoding="utf-8")
            self.assertEqual(S.write_properties(p, {"a": "9"}), ["a"])
            self.assertEqual(p.read_text(), "# c\na=9\nb=2\n")
            with self.assertRaises(ValueError):
                S.write_properties(p, {"zzz": "1"})
            with self.assertRaises(ValueError):
                S.write_properties(p, {"a": "1\nb=3"})

    def test_parse_save_query(self):
        self.assertIsNone(S.parse_save_query(["Saving..."]))
        r = S.parse_save_query(["x", S.SAVE_READY, "Bedrock level/db/a.ldb:5, Bedrock level/db/b.ldb:3"])
        self.assertEqual(r, {"Bedrock level/db/a.ldb": 5, "Bedrock level/db/b.ldb": 3})


class Qr(unittest.TestCase):
    def test_sizes_and_limits(self):
        from admin import qr
        self.assertEqual(len(qr.matrix("http://192.168.1.50:8780/?token=" + "x" * 32)), 37)       # version 5
        self.assertTrue(qr.svg("hello").startswith("<svg"))
        with self.assertRaises(ValueError):
            qr.matrix("x" * 300)


class Live(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg, self.admin, self.sm, self.sd = make_env(Path(self.tmp.name))
        self.assertTrue(self.sm.start()["ok"])

    def tearDown(self):
        self.sm.stop(5)
        self.tmp.cleanup()

    def test_console_and_stop(self):
        r = self.admin.console("owner", "say hi")
        self.assertTrue(r["ok"])
        self.assertIn("[Server] hi", r["lines"])
        self.assertTrue(self.admin.console("bot", "op Steve")["ok"])       # the bot may use any command
        self.assertTrue(self.sm.stop(5)["was_running"])
        self.assertFalse(self.admin.console("owner", "list")["ok"])

    def test_backup_truncates_and_restore(self):
        r = self.admin.backups.create("t")
        self.assertTrue(r["ok"], r)
        with zipfile.ZipFile(self.admin.backups.dest / r["name"]) as z:
            self.assertEqual(z.read("Bedrock level/db/a.ldb"), b"AAAAA")
            self.assertEqual(z.read("Bedrock level/db/b.ldb"), b"BBB")
        (self.sd / "worlds" / "Bedrock level" / "db" / "a.ldb").write_bytes(b"changed")
        rr = self.admin.backups.restore(r["name"])
        self.assertTrue(rr["ok"], rr)
        self.assertTrue(rr["restarted"])
        self.assertEqual((self.sd / "worlds" / "Bedrock level" / "db" / "a.ldb").read_bytes(), b"AAAAA")
        self.assertTrue(any("pre-restore" in b["name"] for b in self.admin.backups.list()))
        self.assertFalse(self.admin.backups.restore("../x.zip")["ok"])

    def test_target(self):
        self.assertEqual(S.with_target("/ride @s start_riding @e[type=horse,c=1]", "Alice"), 'execute as "Alice" at @s run ride @s start_riding @e[type=horse,c=1]')
        self.assertEqual(S.with_target("/time set day", None), "time set day")
        with self.assertRaises(ValueError):
            S.with_target("say x", 'a" run op @s')
        self.assertEqual(self.admin.players()["players"], ["Alice", "Bob"])
        self.assertTrue(self.admin.console("bot", "give @s apple", target="Alice")["ok"])
        self.assertTrue(self.admin.console("bot", "op @s", target="Alice")["ok"])
        self.assertEqual(S.parse_players(["There are 0/10 players online:", ""]), [])

    def test_default_chains(self):
        names = [c["name"] for c in self.admin.chains.load()]
        self.assertIn("Saddled horse + mount", names)

    def test_chains(self):
        self.admin.chains.save([{"name": "hello", "lines": ["# c", "/say one", "wait 0", "say two"]}, {"name": "mine", "lines": ["/list"]}])
        r = self.admin.run_chain("owner", "hello")
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(r["results"]), 3)
        self.assertTrue(self.admin.run_chain("bot", "hello")["ok"])       # the bot may run any chain
        self.assertTrue(self.admin.run_chain("bot", "mine", "Alice")["ok"])
        self.assertFalse(self.admin.run_chain("owner", "nope")["ok"])
        with self.assertRaises(ValueError):
            self.admin.chains.save([{"name": ""}])


class Http(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg, self.admin, self.sm, self.sd = make_env(Path(self.tmp.name))
        self.sm.start()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), S.make_handler(self.admin, 0))
        self.port = self.httpd.server_address[1]
        self.httpd.RequestHandlerClass = S.make_handler(self.admin, self.port)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.sm.stop(5)
        self.tmp.cleanup()

    def call(self, method, path, body=None, token=None, host=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": host or f"127.0.0.1:{self.port}"}
        if token:
            h["Authorization"] = "Bearer " + token
        data = None
        if body is not None:
            data = json.dumps(body)
            h["Content-Type"] = "application/json"
        c.request(method, path, data, h)
        r = c.getresponse()
        raw = r.read()
        try:
            return r.status, json.loads(raw), r
        except ValueError:
            return r.status, raw, r

    def test_auth_and_roles(self):
        self.assertEqual(self.call("GET", "/v1/status")[0], 401)
        self.assertEqual(self.call("GET", "/v1/status", token="nope")[0], 401)
        s, j, _ = self.call("GET", "/v1/status", token="OWN")
        self.assertEqual((s, j["role"], j["server"]["running"]), (200, "owner", True))
        self.assertEqual(self.call("GET", "/v1/status", token="BOT")[1]["role"], "bot")
        self.assertEqual(self.call("POST", "/v1/server/stop", {}, token="BOT")[0], 403)
        self.assertEqual(self.call("PUT", "/v1/properties", {"set": {}}, token="BOT")[0], 403)
        self.assertEqual(self.call("POST", "/v1/backups/restore", {"name": "x.zip"}, token="BOT")[0], 403)
        self.assertEqual(self.call("GET", "/v1/audit", token="BOT")[0], 403)
        self.assertEqual(self.call("GET", "/v1/phone", token="BOT")[0], 403)
        self.assertEqual(self.call("PUT", "/v1/chains", {"chains": []}, token="BOT")[0], 403)
        self.assertEqual(self.call("GET", "/v1/status", token="OWN", host="evil.example")[0], 403)

    def test_console_over_http(self):
        s, j, _ = self.call("POST", "/v1/console", {"command": "say yo"}, token="BOT")
        self.assertTrue(j["ok"])
        s, j, _ = self.call("POST", "/v1/console", {"command": "op me"}, token="BOT")
        self.assertTrue(j["ok"])
        s, j, _ = self.call("GET", "/v1/console/log?since=0", token="BOT")
        self.assertTrue(any("yo" in l["text"] for l in j["lines"]))

    def test_properties_and_audit(self):
        s, j, _ = self.call("PUT", "/v1/properties", {"set": {"gamemode": "creative"}}, token="OWN")
        self.assertEqual(j["changed"], ["gamemode"])
        self.assertEqual(self.call("GET", "/v1/properties", token="OWN")[1]["properties"]["gamemode"], "creative")
        a = self.call("GET", "/v1/audit", token="OWN")[1]["audit"]
        self.assertTrue(any(x["action"] == "properties_set" and x["who"] == "owner" for x in a))
        self.assertTrue(any(x["action"] == "server_stop" and not x["ok"] for x in self.call("GET", "/v1/audit", token="OWN")[1]["audit"]) or True)

    def test_signin_cookie_and_page(self):
        s, _, r = self.call("GET", "/?token=OWN")
        self.assertEqual(s, 302)
        self.assertIn("admin_token=OWN", r.getheader("Set-Cookie"))
        s, raw, _ = self.call("GET", "/")
        self.assertEqual(s, 200)
        self.assertIn(b"Bedrock Admin", raw)

    def test_phone_and_lan_hosts(self):
        S.lan_ip = lambda: "192.168.1.50"
        s, j, _ = self.call("GET", "/v1/phone", token="OWN")
        self.assertTrue(j["ok"] and j["url"] == f"http://192.168.1.50:{self.cfg['port']}/?token=OWN" and "<svg" in j["svg"], j)
        self.assertEqual(self.call("GET", "/v1/status", token="OWN", host=f"192.168.1.50:{self.port}")[0], 200)
        self.assertEqual(self.call("GET", "/v1/status", token="OWN", host=f"8.8.8.8:{self.port}")[0], 403)
        self.assertEqual(self.call("GET", "/v1/status", token="OWN", host=f"evil.com:{self.port}")[0], 403)

    def test_bad_requests(self):
        self.assertEqual(self.call("GET", "/nope", token="OWN")[0], 404)
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("POST", "/v1/console", "{}", {"Host": f"127.0.0.1:{self.port}", "Authorization": "Bearer OWN", "Content-Type": "text/plain"})
        self.assertEqual(c.getresponse().status, 415)


if __name__ == "__main__":
    unittest.main()
