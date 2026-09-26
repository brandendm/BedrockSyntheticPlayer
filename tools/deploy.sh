#!/usr/bin/env bash
# Linux equivalent of deploy.ps1:  tools/deploy.sh <BDS dir> [world name]
set -euo pipefail
BDS="$1"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORLD="${2:-$(grep '^level-name=' "$BDS/server.properties" | cut -d= -f2-)}"
python3 - "$REPO" "$BDS" "$WORLD" <<'EOF'
import json, shutil, sys
from pathlib import Path
repo, bds, world = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
m = json.loads((repo / "behavior_pack/manifest.json").read_text())
dest = bds / "development_behavior_packs/BedrockAgent"
shutil.rmtree(dest, ignore_errors=True)
shutil.copytree(repo / "behavior_pack", dest)
wbp = bds / "worlds" / world / "world_behavior_packs.json"
lst = json.loads(wbp.read_text()) if wbp.exists() else []
lst = [p for p in lst if p["pack_id"] != m["header"]["uuid"]] + [{"pack_id": m["header"]["uuid"], "version": m["header"]["version"]}]
wbp.write_text(json.dumps(lst, indent=2))
perm = bds / "config/default/permissions.json"
cur = json.loads(perm.read_text()) if perm.exists() else {"allowed_modules": []}
for mod in ["@minecraft/server", "@minecraft/server-gametest", "@minecraft/server-net", "@minecraft/common"]:
    if mod not in cur["allowed_modules"]:
        cur["allowed_modules"].append(mod)
perm.parent.mkdir(parents=True, exist_ok=True)
perm.write_text(json.dumps(cur, indent=2))
print(f"deployed to {dest}, enabled in '{world}'")
EOF
