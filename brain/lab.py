"""The arena lab (u323): the colosseum plays bouts and learns how to fight.

A bout is one bot in gear against a set of mobs in the sky arena. Every pair of bouts is the SAME scenario (who it fights, and what it carries: armor, weapons or none, bow, crossbow, shield, horse) played twice: once with the
champion doctrine, once with a candidate (the champion with one to three numbers changed, or a TPE suggestion). The candidate has to beat the champion over a
short trial of pairs before it takes over. Everything is kept (brain/lab/bouts.jsonl), and from it the lab writes a plain-language report: what the champion
does differently from the defaults, what each knob is worth (a ridge regression over every bout, scenario difficulty removed), what separates won bouts from
lost ones (damage by source, shots landed, horse, shield, distances), and how the horse did per mob.

The game sends its parameter table with each request (core/doctrine.js is the one place the ranges live). Pure Python, stdlib only; `tpe.py` suggests.
"""
from __future__ import annotations

import json
import math
import random
import threading
import time
from pathlib import Path

from . import tpe
from .durable import append_line, atomic_write

TRIAL_PAIRS = 3          # pairs a candidate plays before it is judged
PROMOTE_MARGIN = 0.10    # its mean score gain over the champion it must beat
MOBS = [("zombie", [2, 3, 4]), ("husk", [2, 3]), ("skeleton", [1, 2, 3]), ("creeper", [1, 2]), ("spider", [1, 2, 3]), ("witch", [1]), ("pillager", [1, 2]), ("vindicator", [1]), ("enderman", [1])]
BABY_OK = {"zombie", "husk", "zombie_villager"}
WEARERS = {"zombie", "husk", "drowned", "zombie_villager", "skeleton", "stray", "bogged", "wither_skeleton", "piglin", "piglin_brute"}   # mobs that put armor on
JOCKEYS = [("skeleton", "spider"), ("zombie", "chicken")]   # (rider, mount): the rider is the mob, and for the chicken jockey it is a baby
ARMORS = ["none", "leather", "chain", "iron", "diamond"]
TIERS = ["stone", "iron", "diamond"]
WEAPON_SETS = [[], ["sword"], ["axe"], ["spear"], ["mace"], ["trident"], ["sword", "axe"], ["sword", "spear"], ["axe", "spear"], ["sword", "axe", "spear", "mace", "trident"]]
RANGED = ["none", "bow", "crossbow", "both"]
MOBS_WATER = [("zombie", [2, 3]), ("husk", [2, 3]), ("drowned", [2, 3]), ("skeleton", [1, 2]), ("creeper", [1, 2]), ("spider", [1, 2]), ("guardian", [1, 2]), ("pillager", [1, 2]), ("vindicator", [1]), ("witch", [1])]
ENVS = ("land", "water")   # the arena dry, or flooded to the roof with everyone breathing water: fought differently, so trained and kept apart
# Enchantment sets by name; each item takes the ones that fit it (a sword has no density), the game filters. None = unenchanted.
_W_FULL = [["sharpness", 5], ["fire_aspect", 2], ["knockback", 2], ["density", 5], ["impaling", 5], ["unbreaking", 3]]
ENCH = {
    "w": {"none": None, "light": [["sharpness", 2]], "full": _W_FULL, "fire": [["fire_aspect", 2]], "knockback": [["knockback", 2]]},
    "b": {"none": None, "power": [["power", 3]], "full": [["power", 5], ["punch", 2], ["flame", 1]], "infinity": [["infinity", 1]]},
    "x": {"none": None, "quick": [["quick_charge", 3]], "piercing": [["piercing", 4]], "multishot": [["multishot", 1]]},
    "a": {"none": None, "light": [["protection", 2]], "full": [["protection", 4], ["unbreaking", 3], ["thorns", 3]]},
}
SCN_KEYS = ("env", "mob", "count", "baby", "jockey", "armor", "weapon", "weapons", "ranged", "shield", "horse", "ench", "foeArmor", "apples")
LIMIT = 60 * 20          # a bout's time limit in ticks (the game enforces it; the score uses it)


def now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def score(rec: dict) -> float:
    """One bout, one number, higher is better: how much of the mobs it brought down, whether it was knocked out, health kept if it cleared them, and speed."""
    foe0 = max(1.0, float(rec.get("foeHp0") or 1))
    frac = min(1.0, max(0.0, 1.0 - float(rec.get("foeHpEnd") or 0) / foe0))
    out = rec.get("outcome")
    ko = out in ("ko", "dead")
    left = 0.0 if ko else min(1.0, max(0.0, float(rec.get("hpEnd") or 0) / 20.0))
    t = min(1.0, float(rec.get("ticks") or 0) / float(rec.get("limit") or LIMIT))
    taken = sum(float(rec.get(k) or 0) for k in ("takenMelee", "takenArrow", "takenBlast", "takenOther"))
    return round(2.0 * frac - (1.0 if ko else 0.0) + (0.8 * left if out == "cleared" else 0.0) - 0.4 * t - 0.5 * min(1.5, taken / 20.0), 4)


def _mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else 0.0


def _solve(a: list, b: list) -> list:
    """Solve a x = b (Gauss-Jordan with pivoting); also returns nothing else: see _inverse for the covariance."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        if abs(m[c][c]) < 1e-12:
            continue
        piv = m[c][c]
        m[c] = [v / piv for v in m[c]]
        for r in range(n):
            if r != c and m[r][c]:
                f = m[r][c]
                m[r] = [v - f * w for v, w in zip(m[r], m[c])]
    return [m[i][n] for i in range(n)]


def _inverse_diag(a: list) -> list:
    n = len(a)
    m = [a[i][:] + [1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        if abs(m[c][c]) < 1e-12:
            continue
        piv = m[c][c]
        m[c] = [v / piv for v in m[c]]
        for r in range(n):
            if r != c and m[r][c]:
                f = m[r][c]
                m[r] = [v - f * w for v, w in zip(m[r], m[c])]
    return [m[i][n + i] for i in range(n)]


def effects(rows: list, table: dict, lam: float = 2.0) -> list:
    """What each knob is worth: ridge regression of the (scenario-centred) score on the knobs scaled to 0..1.
    rows: [{"doctrine": {...}, "score": float, "scn": str}]. Returns [{k, effect, se, n}] sorted by |effect|: effect = score change from the knob's lowest to its highest value."""
    keys = sorted(table)
    if len(rows) < 8:
        return []
    by = {}
    for r in rows:
        by.setdefault(r["scn"], []).append(r["score"])
    rows = [r for r in rows if len(by[r["scn"]]) >= 2]   # (a bout is only compared with its pair-mate: the same scenario, so its difficulty cancels)
    if len(rows) < 8:
        return []
    mu = {k: _mean(v) for k, v in by.items()}
    ys = [r["score"] - mu[r["scn"]] for r in rows]
    raw = [[((r["doctrine"].get(k, table[k]["v"]) - table[k]["min"]) / ((table[k]["max"] - table[k]["min"]) or 1)) for k in keys] for r in rows]
    mx = {}
    for r, x in zip(rows, raw):
        mx.setdefault(r["scn"], []).append(x)
    mx = {sc: [_mean(col) for col in zip(*xs)] for sc, xs in mx.items()}
    X = [[v - m for v, m in zip(x, mx[r["scn"]])] for r, x in zip(rows, raw)]   # (centred inside the pair too: only what differs between pair-mates counts)
    n, p = len(X), len(keys)
    xtx = [[sum(X[i][a] * X[i][b] for i in range(n)) + (lam if a == b else 0.0) for b in range(p)] for a in range(p)]
    xty = [sum(X[i][a] * ys[i] for i in range(n)) for a in range(p)]
    beta = _solve(xtx, xty)
    resid = [ys[i] - sum(X[i][a] * beta[a] for a in range(p)) for i in range(n)]
    s2 = sum(e * e for e in resid) / max(1, n - 1)
    dg = _inverse_diag(xtx)
    out = [{"k": k, "effect": beta[i], "se": math.sqrt(max(0.0, s2 * dg[i])), "n": n} for i, k in enumerate(keys)]
    out.sort(key=lambda e: -abs(e["effect"]))
    return out


def _scn(b: dict) -> str:
    """The scenario a bout was played in: one per pair (both bouts of a pair share it)."""
    return f"pair{b['pair']}"


def _label(b: dict) -> str:
    return f"{'baby ' if b.get('baby') else ''}{b['mob']} x{b['count']}{' on a ' + b['jockey'] if b.get('jockey') else ''}"


class Lab:
    def __init__(self, root: Path, rng: random.Random | None = None):
        self.dir = Path(root) / "lab"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.rng = rng or random.Random()
        self.lock = threading.RLock()
        self.state = self._load()
        self._reconcile()

    # ----- files
    def _reconcile(self) -> None:
        """After a kill between a bout's row being written and the state being saved: bouts already on disk are not played or counted twice, and a pair whose second half
        was recorded but never judged is judged now."""
        try:
            s = self.state
            rows = self.read("bouts.jsonl")
            done = {r["id"] for r in rows}
            if not rows and not s.get("queue"):
                return
            s["queue"] = [b for b in s.get("queue", []) if b["id"] not in done]
            for i in list(s.get("served", {})):
                if i in done:
                    s["served"].pop(i, None)
            s["bouts"] = len(rows)
            pending = {b["pair"] for b in s["queue"]}
            for pair in sorted({r["pair"] for r in rows} - pending):
                env = next((r.get("env") or "land" for r in rows if r["pair"] == pair), "land")
                T = s.get("tracks", {}).get(env)
                if T and T.get("cand") and not any(p["pair"] == pair for p in T["cand"]["pairs"]) and any(r["pair"] == pair and r["cand"] == T["cand"]["id"] for r in rows):
                    self._pair_done(pair, env)
            self._save()
        except Exception as e:  # (never stop the brain starting over a lab file)
            print(f"[lab] reconcile: {e}")
    def _load(self) -> dict:
        try:
            return json.loads((self.dir / "state.json").read_text(encoding="utf-8"))
        except Exception:
            return {"table": {}, "tracks": {}, "queue": [], "served": {}, "seq": 0, "bouts": 0, "started": now()}

    def _save(self) -> None:
        atomic_write(self.dir / "state.json", json.dumps(self.state, indent=1))

    def _append(self, name: str, obj: dict) -> None:
        append_line(self.dir / name, json.dumps(obj))

    def read(self, name: str, last: int = 0) -> list:
        out = []
        try:
            for line in (self.dir / name).read_text(encoding="utf-8").splitlines():
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
        except Exception:
            pass
        return out[-last:] if last else out

    def reset(self) -> None:
        with self.lock:
            for f in self.dir.iterdir():
                try:
                    f.unlink()
                except Exception:
                    pass
            self.state = self._load()

    # ----- the doctrine table (from the game)
    def _defaults(self) -> dict:
        return {k: d["v"] for k, d in self.state["table"].items()}

    def _clamp(self, params: dict) -> dict:
        t = self.state["table"]
        return {k: round(min(t[k]["max"], max(t[k]["min"], float(params.get(k, t[k]["v"])))), 3) for k in t}

    # ----- proposing
    def _track(self, env: str) -> dict:
        """One environment's own champion, trial and record: land and water are trained apart."""
        tr = self.state["tracks"]
        if env not in tr:
            tr[env] = {"champion": None, "since": 0, "cand": None, "promotions": [], "dropped": 0}
        return tr[env]

    def _candidate(self, env: str) -> dict:
        t, T = self.state["table"], self._track(env)
        champ = T["champion"]
        hist = [h for h in self.read("cands.jsonl") if h.get("since") == T["since"] and h.get("env", "land") == env]
        if len(hist) >= 10 and self.rng.random() < 0.4:
            ranges = {k: (d["min"], d["max"], champ[k]) for k, d in t.items()}
            cand = self._clamp(tpe.suggest([{"params": h["doctrine"], "score": h["mean"]} for h in hist], ranges, self.rng, base=champ, min_hist=6))
            src = "tpe"
        else:
            n = self.rng.choices([1, 2, 3], [5, 3, 2])[0]
            cand = dict(champ)
            for k in self.rng.sample(sorted(t), min(n, len(t))):
                d = t[k]
                if d["max"] - d["min"] <= 1.0 and d["min"] == 0 and d["max"] == 1 and k.startswith("use"):
                    cand[k] = 0.0 if champ[k] > 0.5 else 1.0
                else:
                    span = d["max"] - d["min"]
                    cand[k] = champ[k] + self.rng.gauss(0, 0.25) * span
            cand = self._clamp(cand)
            src = "tweak"
        changed = [k for k in t if abs(cand[k] - champ[k]) > 1e-6]
        if not changed:  # nothing moved: nudge one
            k = self.rng.choice(sorted(t))
            cand[k] = self._clamp({**cand, k: cand[k] + (t[k]["max"] - t[k]["min"]) * 0.2})[k]
            changed = [k]
        return {"doctrine": cand, "changed": changed, "source": src, "pairs": [], "id": self.state["seq"] + 1, "env": env}

    def _balanced(self, key: str, options: list):
        """The option played least so far (ties at random): every kind of fight gets trained, not just the likely ones."""
        cnt = self.state.setdefault("seen", {}).setdefault(key, {})
        names = [json.dumps(o) for o in options]
        low = min(cnt.get(n, 0) for n in names)
        pick = self.rng.choice([o for o, n in zip(options, names) if cnt.get(n, 0) == low])
        cnt[json.dumps(pick)] = cnt.get(json.dumps(pick), 0) + 1
        return pick

    def _scenario(self, env: str = "land") -> dict:
        """Who it fights (kind, count, baby or on a mount), where (dry or flooded) and what it has (armor, which weapons if any, a bow or crossbow or neither, a shield, a horse, which enchantments)."""
        jockey = None
        baby = False
        water = env == "water"
        if not water and self.rng.random() < 0.15:
            rider, mount = self.rng.choice(JOCKEYS)
            mob, counts, jockey, baby = rider, [1, 2], mount, rider == "zombie"
        else:
            mob, counts = self.rng.choice(MOBS_WATER if water else MOBS)
            baby = mob in BABY_OK and self.rng.random() < 0.3
        ench = {k: self._balanced(f"ench{k}{env}", list(ENCH[k])) for k in ENCH}
        return {"env": env, "mob": mob, "count": self.rng.choice(counts), "baby": baby, "jockey": jockey,
                "armor": self._balanced("armor", ARMORS), "weapon": self.rng.choice(TIERS), "weapons": self._balanced("weapons", WEAPON_SETS),
                "ranged": self._balanced("ranged", RANGED), "shield": self._balanced("shield", [True, False]),
                "horse": (not water) and self._balanced("horse", [True, False]),   # (a horse cannot be ridden under water)
                "ench": ench, "enchLists": {k: ENCH[k][v] for k, v in ench.items()},
                "foeArmor": self._balanced("foeArmor", ["none", "leather", "chain", "iron", "diamond"]) if mob in WEARERS else "none",
                "apples": self._balanced("apples", [0, 0, 2, 4])}

    def _new_pair(self) -> None:
        s = self.state
        env = "water" if self.rng.random() < 0.3 else "land"
        T = self._track(env)
        if T["cand"] is None:
            T["cand"] = self._candidate(env)
        s["seq"] += 1
        pair = s["seq"]
        scn = self._scenario(env)
        order = ["cand", "champ"] if pair % 2 else ["champ", "cand"]
        for i, role in enumerate(order):
            s["queue"].append({"id": f"{pair}-{role}", "pair": pair, "role": role, "cand": T["cand"]["id"], "pos": i, **scn})

    def next(self, table: dict) -> dict:
        """The next bout for the game: {id, pair, role, env, scenario fields..., doctrine, limit}."""
        with self.lock:
            s = self.state
            if table:
                s["table"] = table
            if not s["table"]:
                return {"ok": False, "say": "no parameter table yet"}
            for env in ENVS:
                T = self._track(env)
                if T["champion"] is None or set(T["champion"]) != set(s["table"]):
                    T["champion"] = self._clamp({**self._defaults(), **(T["champion"] or {})})
                    T["since"] = (T["since"] if isinstance(T["since"], int) else 0) + 1
            # (a bout given out and never answered, the show having been stopped, is still first in the queue: it is given again)
            if not s["queue"]:
                self._new_pair()
            b = s["queue"][0]
            T = self._track(b["env"])
            s["served"][b["id"]] = time.time()
            doc = T["champion"] if b["role"] == "champ" else T["cand"]["doctrine"]
            self._save()
            return {"ok": True, "bout": {**b, "doctrine": doc, "limit": LIMIT}}

    # ----- results
    def result(self, bout_id: str, rec: dict) -> dict:
        with self.lock:
            s = self.state
            b = next((x for x in s["queue"] if x["id"] == bout_id), None)
            if b is None:
                return {"ok": False, "say": "unknown bout"}
            s["queue"].remove(b)
            s["served"].pop(bout_id, None)
            T = self._track(b["env"])
            sc = score(rec)
            doc = T["champion"] if b["role"] == "champ" else T["cand"]["doctrine"]
            row = {"t": now(), "id": bout_id, "pair": b["pair"], "role": b["role"], "cand": b["cand"], **{k: b.get(k) for k in SCN_KEYS}, "doctrine": doc, "score": sc, "rec": rec, "since": T["since"]}
            self._append("bouts.jsonl", row)
            s["bouts"] += 1
            out = {"ok": True, "score": sc, "event": None}
            # the other half of the pair?
            mate = next((x for x in s["queue"] if x["pair"] == b["pair"]), None)
            if mate is None:
                out["event"] = self._pair_done(b["pair"], b["env"])
            self._save()
            self._write_report()
            return out

    def _pair_done(self, pair: int, env: str):
        s = self.state
        T = self._track(env)
        rows = [r for r in self.read("bouts.jsonl") if r["pair"] == pair]
        c = next((r for r in rows if r["role"] == "cand"), None)
        h = next((r for r in rows if r["role"] == "champ"), None)
        cand = T["cand"]
        if not c or not h or not cand or c["cand"] != cand["id"]:
            return None
        cand["pairs"].append({"pair": pair, "diff": round(c["score"] - h["score"], 4), "cand": c["score"], "champ": h["score"], "scn": _scn(c)})
        diffs = [p["diff"] for p in cand["pairs"]]
        verdict = None
        if len(diffs) >= 2 and all(d <= 0 for d in diffs) and len(diffs) < TRIAL_PAIRS:
            verdict = "drop"
        elif len(diffs) >= TRIAL_PAIRS:
            verdict = "promote" if _mean(diffs) > PROMOTE_MARGIN and sum(1 for d in diffs if d > 0) >= 2 else "drop"
        if verdict is None:
            return {"type": "pair", "diff": cand["pairs"][-1]["diff"], "env": env}
        mean = _mean(diffs)
        self._append("cands.jsonl", {"t": now(), "env": env, "id": cand["id"], "doctrine": cand["doctrine"], "changed": cand["changed"], "source": cand["source"], "mean": round(mean, 4), "pairs": cand["pairs"], "verdict": verdict, "since": T["since"]})
        T["cand"] = None
        if verdict == "promote":
            old = T["champion"]
            why = self._why(cand)
            T["champion"] = cand["doctrine"]
            T["since"] = (T["since"] if isinstance(T["since"], int) else 0) + 1   # (a counter, not a clock: two promotions in one second must not share history)
            note = {"t": now(), "env": env, "changed": {k: [old[k], cand["doctrine"][k]] for k in cand["changed"]}, "mean": round(mean, 3), "pairs": len(diffs), "why": why, "source": cand["source"]}
            T["promotions"].append(note)
            self._append("promotions.jsonl", note)
            return {"type": "promoted", "note": note, "env": env}
        T["dropped"] += 1
        return {"type": "dropped", "mean": round(mean, 3), "changed": cand["changed"], "env": env}

    def _why(self, cand: dict) -> list:
        """What the candidate did better than the champion over its trial pairs, in numbers from the bouts' own records."""
        pairs = {p["pair"] for p in cand["pairs"]}
        rows = [r for r in self.read("bouts.jsonl") if r["pair"] in pairs]
        c = [r["rec"] for r in rows if r["role"] == "cand"]
        h = [r["rec"] for r in rows if r["role"] == "champ"]
        return compare(c, h)

    # ----- the report
    def info(self) -> dict:
        s = self.state
        tr = s["tracks"]
        cands = [{"env": e, "changed": T["cand"]["changed"], "source": T["cand"]["source"], "pairs": T["cand"]["pairs"]} for e, T in tr.items() if T.get("cand")]
        return {"bouts": s["bouts"], "champion": (tr.get("land") or {}).get("champion"), "champions": {e: T["champion"] for e, T in tr.items()},
                "promotions": sum(len(T["promotions"]) for T in tr.values()), "dropped": sum(T["dropped"] for T in tr.values()),
                "cand": cands[0] if cands else None, "cands": cands, "started": s["started"], "report": self.report()}

    def report(self) -> str:
        try:
            return (self.dir / "report.md").read_text(encoding="utf-8")
        except Exception:
            return "No bouts yet. Start the loop in the game: !bot colosseum lab"

    def _write_report(self) -> None:
        try:
            atomic_write(self.dir / "report.md", self.build_report())
        except Exception as e:  # a report that cannot be written must not lose a result
            print(f"[lab] report: {e}")

    def build_report(self) -> str:
        s = self.state
        t = s["table"]
        allb = self.read("bouts.jsonl")
        tr = s["tracks"]
        L = [f"# Arena lab report ({now()})", "", f"{len(allb)} bouts played, {sum(len(T['promotions']) for T in tr.values())} promotions, {sum(T['dropped'] for T in tr.values())} candidates dropped.",
             "Dry-land and underwater fights are trained apart: each has its own champion, trials and numbers below."]
        if not t or not any(T["champion"] for T in tr.values()):
            return "\n".join(L + ["", "No champion yet."])
        for env in ENVS:
            T = tr.get(env)
            bouts = [b for b in allb if (b.get("env") or "land") == env]
            if not T or not T["champion"]:
                continue
            L += ["", f"# {'Underwater (flooded arena, everyone breathes water)' if env == 'water' else 'On dry land'} - {len(bouts)} bouts", ""]
            L += self._env_report(env, T, t, bouts)
        if all(tr.get(e) and tr[e]["champion"] for e in ENVS):
            diff = [k for k in t if abs(tr["land"]["champion"][k] - tr["water"]["champion"][k]) > 1e-9]
            L += ["", "# Underwater against land", ""]
            ms = {e: _mean(b["score"] for b in allb if (b.get("env") or "land") == e and b["role"] == "champ") for e in ENVS}
            L.append(f"- champions' average score: land {ms['land']:+.2f}, underwater {ms['water']:+.2f}")
            for k in sorted(diff, key=lambda k: -abs(tr['land']['champion'][k] - tr['water']['champion'][k]) / ((t[k]['max'] - t[k]['min']) or 1))[:8]:
                L.append(f"- {k}: land {tr['land']['champion'][k]:g}, water {tr['water']['champion'][k]:g} ({t[k]['about']})")
            if not diff:
                L.append("- the two champions are still the same doctrine")
        return "\n".join(L) + "\n"

    def _env_report(self, env: str, T: dict, t: dict, bouts: list) -> list:
        champ = T["champion"]
        L = [f"{len(T['promotions'])} promotions, {T['dropped']} candidates dropped here.", "", "## The champion doctrine", ""]
        base = {k: d["v"] for k, d in t.items()}
        ch = [k for k in t if abs(champ[k] - base[k]) > 1e-9]
        if ch:
            for k in sorted(ch, key=lambda k: -abs(champ[k] - base[k]) / ((t[k]["max"] - t[k]["min"]) or 1)):
                L.append(f"- **{k}** {base[k]:g} -> {champ[k]:g}: {t[k]['about']}")
        else:
            L.append("Still the starting doctrine: nothing has beaten it yet.")
        if T["promotions"]:
            L += ["", "## Why the last promotions won", ""]
            for n in T["promotions"][-5:]:
                mv = ", ".join(f"{k} {a:g} -> {b:g}" for k, (a, b) in n["changed"].items())
                L.append(f"- {n['t']}: {mv} (+{n['mean']:.2f} score over {n['pairs']} paired bouts)")
                for w in n["why"][:5]:
                    L.append(f"    - {w}")
        rows = [{"doctrine": b["doctrine"], "score": b["score"], "scn": _scn(b)} for b in bouts]
        eff = effects(rows, t)
        if eff:
            L += ["", f"## What each knob is worth ({len(rows)} bouts, ridge regression, compared only within a pair)", "",
                  "Change = score gained going from the knob's lowest to its highest value, others held. 'sure' means the effect is more than twice its error.", ""]
            for e in eff[:10]:
                sure = abs(e["effect"]) > 2 * e["se"]
                L.append(f"- {e['k']}: {e['effect']:+.2f} +/- {e['se']:.2f}{' (sure)' if sure else ''}: {t[e['k']]['about']}")
        if len(bouts) >= 12:
            srt = sorted(bouts, key=lambda b: -b["score"])
            k = max(4, len(srt) // 3)
            L += ["", "## What the best bouts have that the worst do not", ""]
            L += [f"- {w}" for w in compare([b["rec"] for b in srt[:k]], [b["rec"] for b in srt[-k:]], "best third", "worst third")]
        for title, lines in (("Which fights are hard for the champion", self._scenarios(bouts)), ("Enchanted against plain", self._enchants(bouts)),
                             ("Weapons (score against the other bout of the same pair)", self._weapons(bouts)), ("Spear charges on horseback", self._charges(bouts)), ("The horse", self._horse(bouts))):
            if lines:
                L += ["", f"## {title}", ""] + [f"- {x}" for x in lines]
        return L

    def _scenarios(self, bouts: list) -> list:
        """Mean score of the champion's bouts by enemy kind, armor, what it carried: the lower, the harder that fight."""
        ch = [b for b in bouts if b["role"] == "champ"]
        out = []

        def grp(name, fn, minn=3):
            g = {}
            for b in ch:
                g.setdefault(fn(b), []).append(b["score"])
            items = sorted(((k, _mean(v), len(v)) for k, v in g.items() if len(v) >= minn), key=lambda x: x[1])
            if len(items) >= 2:
                out.append(f"{name}: " + "; ".join(f"{k} {m:+.2f} (n={n})" for k, m, n in items))

        grp("by enemy", lambda b: _label(b).split(" x")[0] if not b.get("jockey") and not b.get("baby") else _label(b).split(" x")[0] + (" (jockey)" if b.get("jockey") else " (baby)"))
        grp("by armor", lambda b: b.get("armor"))
        grp("by ranged weapon", lambda b: b.get("ranged"))
        grp("by weapons carried", lambda b: "+".join(b.get("weapons") or []) or "none (fists)" if len(b.get("weapons") or []) < 5 else "all five")
        grp("with a shield", lambda b: "yes" if b.get("shield") else "no")
        grp("enemy armor (mobs that wear it)", lambda b: b.get("foeArmor") if b.get("mob") in WEARERS else None)
        grp("golden apples carried", lambda b: str(b.get("apples") or 0))
        return out

    @staticmethod
    def _enchants(bouts: list) -> list:
        """For each kind of enchantment set: the score of all bouts that had it, and the damage of an average hit (from the bouts' own records), against unenchanted."""
        out = []
        for key, what, dealt, hits in (("w", "weapon", "dealtMelee", "hitsMelee"), ("b", "bow", "dealtArrow", "hitsArrow"), ("x", "crossbow", "dealtArrow", "hitsArrow"), ("a", "armor", None, None)):
            g = {}
            for b in bouts:
                name = (b.get("ench") or {}).get(key, "none")
                if key == "b" and b.get("ranged") not in ("bow", "both"):
                    continue
                if key == "x" and b.get("ranged") not in ("crossbow", "both"):
                    continue
                g.setdefault(name, []).append(b)
            if len(g) < 2 or "none" not in g:
                continue
            parts = []
            for name, rows in sorted(g.items(), key=lambda kv: kv[0] != "none"):
                if len(rows) < 3:
                    continue
                sc = _mean(r["score"] for r in rows)
                if dealt:
                    n = sum(float(r["rec"].get(hits) or 0) for r in rows)
                    hit = (sum(float(r["rec"].get(dealt) or 0) for r in rows) / n) if n >= 5 else None
                    parts.append(f"{name} {sc:+.2f}" + (f", {hit:.1f} per hit" if hit is not None else "") + f" (n={len(rows)})")
                else:
                    taken = _mean(sum(float(r["rec"].get(k) or 0) for k in ("takenMelee", "takenArrow", "takenBlast", "takenOther")) for r in rows)
                    parts.append(f"{name} {sc:+.2f}, {taken:.1f} damage taken (n={len(rows)})")
            if len(parts) >= 2:
                out.append(f"{what} enchantments: " + "; ".join(parts))
        return out

    @staticmethod
    def _charges(bouts: list) -> list:
        """The mounted spear charge: how many, what a charging hit does against an ordinary spear or other hit."""
        rows = [b for b in bouts if float(b["rec"].get("charges") or 0) > 0]
        if not rows:
            return []
        ch = sum(float(r["rec"].get("chargeHits") or 0) for r in rows)
        cd = sum(float(r["rec"].get("chargeDealt") or 0) for r in rows)
        oh = sum(float(r["rec"].get("hitsMelee") or 0) - float(r["rec"].get("chargeHits") or 0) for r in rows)
        od = sum(float(r["rec"].get("dealtMelee") or 0) - float(r["rec"].get("chargeDealt") or 0) for r in rows)
        out = [f"{len(rows)} bouts with charges, {sum(float(r['rec'].get('charges') or 0) for r in rows):.0f} runs at the enemy, {ch:.0f} hits landed in them"]
        if ch >= 3 and oh >= 3:
            out.append(f"a charging hit does {cd / ch:.1f} damage against {od / oh:.1f} for other melee hits")
        return out

    @staticmethod
    def _weapons(bouts: list) -> list:
        """Per weapon kind actually used most in a bout: its average advantage over the other bout of the pair. (Honest only where the pair-mates used different weapons.)"""
        by_pair = {}
        for b in bouts:
            by_pair.setdefault(b["pair"], []).append(b)
        adv = {}
        for rows in by_pair.values():
            if len(rows) != 2:
                continue
            for me, other in (rows[0], rows[1]), (rows[1], rows[0]):
                wm, wo = me["rec"].get("weapon") or "fist", other["rec"].get("weapon") or "fist"
                if wm != wo:
                    adv.setdefault(_kind(wm), []).append(me["score"] - other["score"])
        return [f"{k}: {_mean(v):+.2f} when it used {k} and the pair-mate used something else (n={len(v)})" for k, v in sorted(adv.items(), key=lambda kv: -_mean(kv[1])) if len(v) >= 3]

    @staticmethod
    def _horse(bouts: list) -> list:
        out = []
        by = {}
        for b in bouts:
            by.setdefault(b["mob"], {True: [], False: []})[bool(b["rec"].get("mounted"))].append(b["score"])
        for mob, g in sorted(by.items()):
            if len(g[True]) >= 3 and len(g[False]) >= 3:
                d = _mean(g[True]) - _mean(g[False])
                out.append(f"vs {mob}: mounted {_mean(g[True]):+.2f} (n={len(g[True])}) vs on foot {_mean(g[False]):+.2f} (n={len(g[False])}): {'the horse helps' if d > 0.15 else 'the horse hurts' if d < -0.15 else 'no clear difference'}")
        allm = [b["score"] for b in bouts if b["rec"].get("mounted")]
        if bouts and not allm and any(b.get("horse") for b in bouts):
            out.append("No bout has been fought mounted yet (the horse switch is still off in every doctrine tried).")
        return out


def _kind(w: str) -> str:
    for k in ("sword", "axe", "spear", "mace", "trident"):
        if k in w:
            return k
    return "fists" if w in ("fist", "") else w


def compare(a: list, b: list, an: str = "the winner", bn: str = "the loser") -> list:
    """Lines saying how two sets of bout records differ in how the fight went."""
    if not a or not b:
        return []
    out = []

    def m(rs, f):
        return _mean(f(r) for r in rs)

    def taken(r):
        return float(r.get("takenMelee", 0)) + float(r.get("takenArrow", 0)) + float(r.get("takenBlast", 0)) + float(r.get("takenOther", 0))

    ha, hb = m(a, taken), m(b, taken)
    if abs(ha - hb) >= 1.0:
        out.append(f"{an} took {ha:.1f} damage per bout against {hb:.1f} for {bn}")
    for key, label in (("takenMelee", "from melee hits"), ("takenArrow", "from arrows"), ("takenBlast", "from explosions")):
        x, y = m(a, lambda r: float(r.get(key, 0))), m(b, lambda r: float(r.get(key, 0)))
        if abs(x - y) >= 1.5:
            out.append(f"  of which {x:.1f} {label} against {y:.1f}")
    ta, tb = m(a, lambda r: float(r.get("ticks", 0))) / 20, m(b, lambda r: float(r.get("ticks", 0))) / 20
    if abs(ta - tb) >= 2:
        out.append(f"{an} finished in {ta:.0f}s against {tb:.0f}s")

    def acc(rs):
        shots = sum(float(r.get("shots", 0)) for r in rs)
        return (sum(float(r.get("hitsArrow", 0)) for r in rs) / shots) if shots >= 5 else None

    xa, xb = acc(a), acc(b)
    if xa is not None and xb is not None and abs(xa - xb) >= 0.1:
        out.append(f"arrows landed {xa:.0%} of the time against {xb:.0%}")
    sa, sb = m(a, lambda r: float(r.get("shots", 0))), m(b, lambda r: float(r.get("shots", 0)))
    if abs(sa - sb) >= 2:
        out.append(f"{sa:.1f} arrows shot per bout against {sb:.1f}")
    wa, wb = m(a, lambda r: float(r.get("swings", 0))), m(b, lambda r: float(r.get("swings", 0)))
    if abs(wa - wb) >= 3:
        out.append(f"{wa:.1f} sword swings per bout against {wb:.1f}")
    for key, label in (("mountedTicks", "on the horse"), ("shieldTicks", "behind the shield"), ("retreatTicks", "backing away to recover")):
        x = m(a, lambda r: float(r.get(key, 0)) / max(1.0, float(r.get("ticks", 1))))
        y = m(b, lambda r: float(r.get(key, 0)) / max(1.0, float(r.get("ticks", 1))))
        if abs(x - y) >= 0.08:
            out.append(f"{an} spent {x:.0%} of the bout {label} against {y:.0%}")
    da = m(a, lambda r: float(r.get("distSum", 0)) / max(1.0, float(r.get("distN", 1))))
    db = m(b, lambda r: float(r.get("distSum", 0)) / max(1.0, float(r.get("distN", 1))))
    if abs(da - db) >= 0.7:
        out.append(f"it fought from {da:.1f} blocks away on average against {db:.1f}")
    def early(r):
        tl = r.get("hpTL") or []
        return (tl[0] - tl[min(5, len(tl) - 1)]) if len(tl) >= 3 else None

    def late(r):
        tl = r.get("hpTL") or []
        return (tl[min(5, len(tl) - 1)] - tl[-1]) if len(tl) >= 8 else None

    for fn, label in ((early, "in the first 5 seconds"), (late, "after the first 5 seconds")):
        xs, ys = [fn(r) for r in a if fn(r) is not None], [fn(r) for r in b if fn(r) is not None]
        if len(xs) >= 2 and len(ys) >= 2 and abs(_mean(xs) - _mean(ys)) >= 1.5:
            out.append(f"{an} lost {_mean(xs):.1f} hp {label} against {_mean(ys):.1f}")
    for key, label in (("eats", "golden apples eaten"), ("hitRuns", "hit-and-run steps back"), ("cornerTicks", "ticks backed into a corner")):
        x, y = m(a, lambda r: float(r.get(key, 0))), m(b, lambda r: float(r.get(key, 0)))
        if abs(x - y) >= (0.5 if key != "cornerTicks" else 20):
            out.append(f"{x:.1f} {label} per bout against {y:.1f}")
    ja, jb = m(a, lambda r: float(r.get("jumps", 0))), m(b, lambda r: float(r.get("jumps", 0)))
    if abs(ja - jb) >= 2:
        out.append(f"{ja:.1f} jump-attacks per bout against {jb:.1f}")
    ko_a, ko_b = m(a, lambda r: 1.0 if r.get("outcome") in ("ko", "dead") else 0.0), m(b, lambda r: 1.0 if r.get("outcome") in ("ko", "dead") else 0.0)
    if abs(ko_a - ko_b) >= 0.1:
        out.append(f"knocked out in {ko_a:.0%} of bouts against {ko_b:.0%}")
    return out or ["no single measured thing stands out"]
