"""Check core/threat.js MOBS (hp, hit damage) against Mojang's own entity data (github.com/Mojang/bedrock-samples, behavior_pack/entities/<mob>.json).

  python3 tools/check_mobs.py            fetch (cached in tools/.mobcache/) and print every mismatch
Health is the largest `minecraft:health` value in the entity (adult form: baby/variant groups are smaller or equal); damage is the largest `minecraft:attack` damage
(a [min, max] pair counts its max; creeper/ranged/special attackers have no melee attack and are reported as such). Differences are for a person to judge: dps in the table is
a rough per-second figure, so only hp and the per-hit damage are compared, and hit damage is shown beside dps, not asserted.
"""
import json, re, subprocess, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(__file__).resolve().parent / ".mobcache"
URL = "https://raw.githubusercontent.com/Mojang/bedrock-samples/main/behavior_pack/entities/{}.json"


def mobs():
    js = "import {MOBS} from './behavior_pack/scripts/core/threat.js'; console.log(JSON.stringify(MOBS))"
    return json.loads(subprocess.check_output(["node", "--input-type=module", "-e", js], cwd=ROOT, text=True))


def fetch(name):
    CACHE.mkdir(exist_ok=True)
    f = CACHE / f"{name}.json"
    if not f.exists():
        try:
            f.write_bytes(urllib.request.urlopen(URL.format(name), timeout=20).read())
        except Exception:  # noqa: BLE001
            try:
                out = subprocess.check_output(["curl", "-sSf", "-m", "20", URL.format(name)])
                f.write_bytes(out)
            except Exception:  # noqa: BLE001
                return None
    return f.read_text(encoding="utf-8")


def strip_comments(t):
    return re.sub(r'(?m)^\s*//.*$|(?<=[,\{\[\s])//[^\n"]*$', "", t)


def walk(o, key, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key:
                out.append(v)
            walk(v, key, out)
    elif isinstance(o, list):
        for v in o:
            walk(v, key, out)


def num(v):
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, dict):
        for k in ("max", "value", "damage"):
            if k in v:
                return num(v[k])
    if isinstance(v, list) and v:
        return max(n for n in (num(x) for x in v) if n is not None) if any(num(x) is not None for x in v) else None
    return None


def facts(text):
    d = json.loads(strip_comments(text))
    hp, dmg = [], []
    h, a = [], []
    walk(d, "minecraft:health", h)
    walk(d, "minecraft:attack", a)
    hp = [n for n in (num(x) for x in h) if n is not None]
    dmg = [n for n in (num(x.get("damage")) if isinstance(x, dict) else None for x in a) if n is not None]
    return (max(hp) if hp else None), (max(dmg) if dmg else None)


def main():
    bad = 0
    for name, info in sorted(mobs().items()):
        t = fetch(name)
        if t is None:
            print(f"?  {name}: no entity file (id differs?)")
            continue
        try:
            hp, dmg = facts(t)
        except ValueError as e:
            print(f"?  {name}: could not parse ({e})")
            continue
        flags = []
        if hp is not None and abs(hp - info["hp"]) > 0.5:
            flags.append(f"hp table {info['hp']} vs Mojang {hp}")
        if dmg is not None and info["kind"] == "melee" and dmg < info["dps"] * 0.5 - 0.01:
            flags.append(f"dps table {info['dps']} looks high against a hit of {dmg}")
        print(("!! " if flags else "ok ") + f"{name}: hp {hp}, hit {dmg}" + (" -- " + "; ".join(flags) if flags else ""))
        bad += bool(flags)
    print(f"\n{bad} mob(s) to look at")


if __name__ == "__main__":
    main()
