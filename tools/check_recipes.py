"""Check core/recipes.js RECIPES (output count, total ingredient count) against Mojang's recipe files (bedrock-samples behavior_pack/recipes/<name>.json).
  python3 tools/check_recipes.py     (cached in tools/.mobcache/recipes/)
A recipe file with several shapes/tags is matched if any of them agrees. Names with no file of that name are listed, not failed."""
import json, subprocess, re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = Path(__file__).resolve().parent / ".mobcache" / "recipes"
BASE = "https://raw.githubusercontent.com/Mojang/bedrock-samples/main/behavior_pack/recipes/{}.json"


def mine():
    js = "import {RECIPES} from './behavior_pack/scripts/core/recipes.js'; console.log(JSON.stringify(Object.fromEntries(Object.entries(RECIPES).map(([k,r])=>[k,{out:r.out,n:r.inputs.reduce((s,i)=>s+i.n,0)}]))))"
    return json.loads(subprocess.check_output(["node", "--input-type=module", "-e", js], cwd=ROOT, text=True))


def get(name):
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{name}.json"
    if not f.exists():
        r = subprocess.run(["curl", "-sSf", "-m", "20", BASE.format(name)], capture_output=True)
        if r.returncode:
            return None
        f.write_bytes(r.stdout)
    t = re.sub(r'(?m)^\s*//.*$', "", f.read_text(encoding="utf-8"))
    return json.loads(t)


def shapes(d):
    out = []
    for key, v in d.items():
        if not key.startswith("minecraft:recipe_"):
            continue
        res = v.get("result") or {}
        cnt = res.get("count", 1) if isinstance(res, dict) else 1
        if "pattern" in v:
            n = sum(1 for row in v["pattern"] for ch in row if ch != " ")
            out.append((cnt, n))
        elif "ingredients" in v:
            out.append((cnt, sum(i.get("count", 1) if isinstance(i, dict) else 1 for i in v["ingredients"])))
    return out


bad = 0
for name, m in sorted(mine().items()):
    d = get(name)
    if d is None:
        print(f"?  {name}: no recipe file of that name")
        continue
    ok = [s for s in shapes(d) if s == (m["out"], m["n"])]
    print(("ok " if ok else "!! ") + f"{name}: mine out {m['out']} from {m['n']}" + ("" if ok else f"; Mojang {shapes(d)}"))
    bad += not ok
print(f"\n{bad} to look at")
