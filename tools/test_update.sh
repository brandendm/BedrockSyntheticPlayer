#!/usr/bin/env bash
# Tests tools/update.ps1 against scratch git repos (needs PowerShell 7: `pwsh`; skipped without it).
#   tools/test_update.sh
# Cases: check only, clean fast-forward, up to date, dirty tree refused, -Adopt declined and confirmed
# (files backed up, ignored files untouched), commits on both sides refused, ahead only.
set -u
PW=$(command -v pwsh || true)
[ -z "$PW" ] && [ -x /tmp/claude-0/pwshtool/node_modules/.bin/pwsh ] && PW=/tmp/claude-0/pwshtool/node_modules/.bin/pwsh
[ -z "$PW" ] && { echo "pwsh not found: skipped"; exit 0; }
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
SRC="$(cd "$(dirname "$0")" && pwd)/update.ps1"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { if [ "$2" = "0" ]; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
has() { grep -qF -- "$2" <<<"$1"; }

fresh() {
  rm -rf "$T"/*; cd "$T"
  git init -q --bare -b main origin.git
  git clone -q origin.git dev 2>/dev/null; cd dev; git config user.email t@t; git config user.name t
  mkdir -p behavior_pack/scripts tools brain
  printf "  build: 'u1',\n" > behavior_pack/scripts/config.js
  cp "$SRC" tools/update.ps1; printf 'param($BdsPath)\nWrite-Host "STUB deploy to $BdsPath"\n' > tools/deploy.ps1
  printf 'brain/config.json\nserver/\nbrain/logs/\n' > .gitignore; echo a > file.txt; echo t > tracked.txt
  git add -A; git commit -qm one; git push -q origin main 2>/dev/null
  cd "$T"; git clone -q origin.git pc 2>/dev/null; cd pc; git config user.email t@t; git config user.name t
  mkdir -p server brain; echo secret > brain/config.json; echo x > server/server.properties
}
upstream() { (cd "$T/dev"; printf "  build: 'u2',\n" > behavior_pack/scripts/config.js; echo "$1" >> file.txt; git commit -qam "$1"; git push -q origin main 2>/dev/null); }
run() { (cd "$T/pc"; "$PW" -NoProfile -File tools/update.ps1 "$@" 2>&1); }

fresh; upstream b; upstream c
out=$(run -Check); has "$out" "2 new commit(s)"; ok "check lists the incoming commits" $?
[ "$(cat "$T/pc/file.txt" | wc -l)" = 1 ]; ok "check changes nothing" $?
out=$(run); has "$out" "Now at build u2"; ok "clean fast-forward" $?
[ "$(cat "$T/pc/file.txt" | wc -l)" = 3 ] && [ "$(cat "$T/pc/brain/config.json")" = secret ]; ok "files came in, ignored files untouched" $?
has "$out" "STUB deploy"; ok "pack copied to server/" $?
out=$(run); has "$out" "Already up to date"; ok "up to date" $?

fresh; upstream b
echo "mine" >> "$T/pc/tracked.txt"
out=$(run); has "$out" "Commit or stash"; ok "dirty tree refused" $?
[ "$(cat "$T/pc/file.txt" | wc -l)" = 1 ]; ok "dirty refused: nothing changed" $?
out=$(echo no | run -Adopt); has "$out" "Not confirmed"; ok "-Adopt declined" $?
grep -q mine "$T/pc/tracked.txt"; ok "-Adopt declined: edit still there" $?
echo new > "$T/pc/file2.txt"
out=$(echo YES | run -Adopt); has "$out" "Backed up to"; ok "-Adopt confirmed" $?
b=$(ls -d "$T"/bedrock-agent-backup-* 2>/dev/null | head -1)
grep -q mine "$b/tracked.txt" && [ -f "$b/file2.txt" ]; ok "-Adopt backed up changed and new files" $?
[ "$(cat "$T/pc/file.txt" | wc -l)" = 2 ] && ! grep -q mine "$T/pc/tracked.txt" && [ "$(cat "$T/pc/brain/config.json")" = secret ]; ok "-Adopt matched GitHub, ignored files kept" $?

fresh; upstream b
(cd "$T/pc"; echo local > local.txt; git add local.txt; git commit -qm local)
out=$(run); has "$out" "needs a merge"; ok "commits on both sides refused" $?
[ "$(cat "$T/pc/file.txt" | wc -l)" = 1 ]; ok "diverged: nothing changed" $?

fresh
(cd "$T/pc"; echo local > local.txt; git add local.txt; git commit -qm local)
out=$(run); has "$out" "Nothing to bring in"; ok "ahead only: nothing to do" $?

[ $fail = 0 ] && echo "all passed" || echo "FAILED"
exit $fail
