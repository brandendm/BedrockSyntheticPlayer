import random
import tempfile
import unittest
from pathlib import Path

from brain import lab as L

TABLE = {
    "holdAt": {"v": 2.8, "min": 2.0, "max": 3.2, "group": "spacing", "about": "walk in until this close", "real": True},
    "strafePeriod": {"v": 22, "min": 8, "max": 70, "group": "strafe", "about": "ticks per side"},
    "bowFrom": {"v": 9, "min": 4, "max": 16, "group": "bow", "about": "shoot beyond this"},
    "useShield": {"v": 1, "min": 0, "max": 1, "group": "shield", "about": "use a shield"},
    "useHorse": {"v": 0, "min": 0, "max": 1, "group": "horse", "about": "fight mounted"},
}


def fake_bout(doc, rng, mob):
    """A made-up game: the horse is worth a lot against zombies, a closer hold is worth a little, and noise on top."""
    q = 2.0 * (doc["useHorse"] > 0.5 if mob == "zombie" else 0) - 0.8 * (doc["holdAt"] - 2.8) + rng.gauss(0, 0.3)
    hp_end = max(0.0, min(20.0, 10 + 4 * q))
    cleared = q > -0.5
    return {"outcome": "cleared" if cleared else "ko", "ticks": 600 if cleared else 900, "limit": 1200, "hp0": 20, "hpEnd": hp_end, "foeHp0": 40, "foeHpEnd": 0 if cleared else 20,
            "mounted": doc["useHorse"] > 0.5, "mountedTicks": 500 if doc["useHorse"] > 0.5 else 0, "takenMelee": 20 - hp_end, "shots": 6, "hitsArrow": 3, "swings": 20}


class ScoreTest(unittest.TestCase):
    def test_order(self):
        win = {"outcome": "cleared", "foeHp0": 40, "foeHpEnd": 0, "hpEnd": 18, "ticks": 300, "limit": 1200}
        slow = {**win, "hpEnd": 6, "ticks": 1000}
        ko = {"outcome": "ko", "foeHp0": 40, "foeHpEnd": 20, "hpEnd": 3, "ticks": 500, "limit": 1200}
        self.assertGreater(L.score(win), L.score(slow))
        self.assertGreater(L.score(slow), L.score(ko))
        self.assertLess(L.score(ko), 0.5)


class LabTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.lab = L.Lab(Path(self.tmp.name), random.Random(5))

    def play(self, n, rng):
        events = []
        for _ in range(n):
            r = self.lab.next(TABLE)
            self.assertTrue(r["ok"])
            b = r["bout"]
            res = self.lab.result(b["id"], fake_bout(b["doctrine"], rng, b["mob"]))
            if res["event"] and res["event"]["type"] in ("promoted", "dropped"):
                events.append(res["event"])
        return events

    def test_pairs_share_scenario_and_alternate(self):
        a = self.lab.next(TABLE)["bout"]
        self.lab.result(a["id"], fake_bout(a["doctrine"], random.Random(1), a["mob"]))
        b = self.lab.next(TABLE)["bout"]
        self.assertEqual((a["mob"], a["count"], a["gear"], a["pair"]), (b["mob"], b["count"], b["gear"], b["pair"]))
        self.assertNotEqual(a["role"], b["role"])
        self.lab.result(b["id"], fake_bout(b["doctrine"], random.Random(1), b["mob"]))
        c = self.lab.next(TABLE)["bout"]
        self.assertNotEqual(c["pair"], a["pair"])
        self.assertNotEqual(c["role"], a["role"])  # sides alternate between pairs

    def test_unanswered_bout_is_served_again(self):
        a = self.lab.next(TABLE)["bout"]
        again = self.lab.next(TABLE)["bout"]
        self.assertEqual(a["id"], again["id"])

    def test_candidate_changes_one_to_three(self):
        self.lab.next(TABLE)
        c = self.lab.state["cand"]
        self.assertTrue(1 <= len(c["changed"]) <= 3)
        for k, d in TABLE.items():
            self.assertTrue(d["min"] <= c["doctrine"][k] <= d["max"])

    def test_it_learns_the_horse(self):
        rng = random.Random(9)
        self.play(400, rng)
        champ = self.lab.state["champion"]
        self.assertGreater(champ["useHorse"], 0.5, champ)
        self.assertGreaterEqual(len(self.lab.state["promotions"]), 1)
        rep = self.lab.build_report()
        self.assertIn("useHorse", rep)
        self.assertIn("The horse", rep)

    def test_effects_find_the_big_knob(self):
        rng = random.Random(3)
        rows = []
        for _ in range(120):
            d = {k: rng.uniform(v["min"], v["max"]) for k, v in TABLE.items()}
            d["useHorse"] = float(rng.random() > 0.5)
            rows.append({"doctrine": d, "score": 1.5 * d["useHorse"] + rng.gauss(0, 0.2), "scn": "x"})
        e = L.effects(rows, TABLE)
        self.assertEqual(e[0]["k"], "useHorse")
        self.assertGreater(e[0]["effect"], 1.0)
        self.assertGreater(abs(e[0]["effect"]), 2 * e[0]["se"])

    def test_compare_says_what_differs(self):
        a = [{"takenMelee": 4, "ticks": 400, "shots": 10, "hitsArrow": 8, "mountedTicks": 300}]
        b = [{"takenMelee": 14, "ticks": 900, "shots": 10, "hitsArrow": 2, "mountedTicks": 0}]
        t = " | ".join(L.compare(a, b))
        self.assertIn("damage", t)
        self.assertIn("horse", t)
        self.assertIn("arrows landed", t)

    def test_state_survives_restart(self):
        self.play(12, random.Random(2))
        n = self.lab.state["bouts"]
        again = L.Lab(Path(self.tmp.name))
        self.assertEqual(again.state["bouts"], n)
        self.assertEqual(again.state["champion"], self.lab.state["champion"])


if __name__ == "__main__":
    unittest.main()
