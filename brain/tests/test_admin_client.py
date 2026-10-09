import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from admin import service as S
from admin.tests.test_service import make_env
from brain.admin_client import AdminClient, AdminLocator


class Fake(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg, self.admin, self.sm, self.sd = make_env(Path(self.tmp.name))
        self.sm.start()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), S.make_handler(self.admin, 0))
        self.port = self.httpd.server_address[1]
        self.httpd.RequestHandlerClass = S.make_handler(self.admin, self.port)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.c = AdminClient(f"http://127.0.0.1:{self.port}", "BOT")

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.sm.stop(5)
        self.tmp.cleanup()

    def test_unconfigured(self):
        self.assertFalse(AdminClient("", "").act({"action": "status"})["ok"])

    def test_actions(self):
        r = self.c.act({"action": "status"})
        self.assertTrue(r["ok"] and "up" in r["say"], r)
        r = self.c.act({"action": "console", "command": "say hi"})
        self.assertTrue(r["ok"] and "hi" in r["say"], r)
        r = self.c.act({"action": "console", "command": "op me"})
        self.assertFalse(r["ok"])
        self.assertIn("may not", r["say"])
        self.admin.chains.save([{"name": "ok", "lines": ["/say a"], "bot_ok": True}, {"name": "no", "lines": ["/say a"]}])
        self.assertEqual(self.c.act({"action": "chains"})["names"], ["ok"])
        self.assertTrue(self.c.act({"action": "chain", "name": "ok"})["ok"])
        self.assertFalse(self.c.act({"action": "chain", "name": "no"})["ok"])
        r = self.c.act({"action": "backup", "label": "x"})
        self.assertTrue(r["ok"], r)
        self.assertFalse(self.c.act({"action": "bogus"})["ok"])

    def test_wrong_token_and_owner_only(self):
        r = AdminClient(f"http://127.0.0.1:{self.port}", "WRONG").act({"action": "status"})
        self.assertFalse(r["ok"])
        self.assertIn("401", r["say"])
        self.assertIn("403", self.c._call("POST", "/v1/server/stop", {}).get("error", ""))
        self.assertTrue(self.sm.alive())

    def test_locator(self):
        loc = AdminLocator(self.c)
        self.assertTrue(loc.alive())
        r = loc.locate("structure", "village")
        self.assertIn("error", r)           # the fake server does not know /locate
        self.assertIn("error", loc.locate("structure", "Bad Name!"))


if __name__ == "__main__":
    unittest.main()
