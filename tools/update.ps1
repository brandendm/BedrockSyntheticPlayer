<#
  Brings this folder up to date from GitHub. Only that: a fast-forward of the branch you are on,
  never a merge, and never over anything you have not committed.

    Update Agent.bat                  (double-click)
    .\tools\update.ps1                update
    .\tools\update.ps1 -Check         say what would come in and change nothing
    .\tools\update.ps1 -Adopt         first time only, see below

  What it does, in order:
    1. Refuses if git is missing, this isn't a git folder, or a git command is still running.
    2. Fetches. If GitHub has nothing new, says so and stops.
    3. Refuses if you have uncommitted changes to tracked files (it lists them). Commit or stash them.
    4. Refuses if you have commits GitHub doesn't (it would need a merge; that's yours to say).
    5. Fast-forwards, lists what came in, and copies the pack into server\ if there is one.

  -Adopt is for when this folder's files were put here by hand (a copied build) and differ from
  the branch: every differing file is first copied to ..\bedrock-agent-backup-<time>\ and after you
  type YES the folder is made to match GitHub. Only tracked files change.

  Never touched (git ignores them): brain\config.json (your key), brain\logs, brain\usage.json, server\
  (the game server and its worlds). The pack in server\ is replaced only by the copy step.
#>
param(
  [switch]$Check,
  [switch]$Adopt
)
# (git writes progress to stderr: don't let PowerShell 5 treat that as an error; every call is checked by its exit code)
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Say($msg, $color = 'White') { Write-Host $msg -ForegroundColor $color }
function Stop-Here($msg) { Say $msg 'Yellow'; Say 'Nothing was changed.' 'Yellow'; exit 1 }
# Run git, return its output lines; $script:gitOk says whether it succeeded.
function Invoke-Git {
  $out = & (Get-Command git -CommandType Application | Select-Object -First 1).Source @args 2>&1
  $script:gitOk = ($LASTEXITCODE -eq 0)
  return @($out | ForEach-Object { "$_" })
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Stop-Here 'git is not installed (or not on PATH).' }
if (-not (Test-Path (Join-Path $repo '.git'))) { Stop-Here 'This folder is not a git checkout, so there is nothing to update from.' }
if (Test-Path (Join-Path $repo '.git/index.lock')) { Stop-Here 'Git says another git command is running (.git\index.lock exists). Close it, or delete that file if nothing is.' }

$branch = (Invoke-Git rev-parse --abbrev-ref HEAD | Select-Object -First 1)
if (-not $gitOk -or $branch -eq 'HEAD') { Stop-Here 'Not on a branch (detached HEAD). Check a branch out first.' }
$remote = "origin/$branch"

Say "Branch $branch. Fetching from GitHub..."
$null = Invoke-Git fetch origin $branch
if (-not $gitOk) { Stop-Here "Could not fetch $branch from origin (offline, or no such branch on GitHub)." }

$behind = [int](Invoke-Git rev-list --count "HEAD..$remote" | Select-Object -First 1)
$ahead = [int](Invoke-Git rev-list --count "$remote..HEAD" | Select-Object -First 1)
$dirty = @(Invoke-Git diff --name-only HEAD | Where-Object { $_ })

if ($behind -eq 0 -and $ahead -eq 0 -and -not $dirty) { Say 'Already up to date.' 'Green'; exit 0 }

if ($behind -gt 0) {
  Say ("{0} new commit(s) on GitHub:" -f $behind)
  Invoke-Git log "--format=  %h %s" "HEAD..$remote" | ForEach-Object { Say $_ }
}
if ($ahead -gt 0) { Say ("{0} commit(s) here that GitHub doesn't have." -f $ahead) }
if ($dirty) {
  Say ("{0} file(s) with uncommitted changes:" -f $dirty.Count)
  $dirty | Select-Object -First 15 | ForEach-Object { Say "  $_" }
  if ($dirty.Count -gt 15) { Say ("  ...and {0} more" -f ($dirty.Count - 15)) }
}
if ($Check) { Say 'Check only: nothing changed.'; exit 0 }
if ($behind -eq 0) {
  if ($ahead -gt 0) { Say 'Nothing to bring in. (Your commits still need pushing.)' 'Green' } else { Say 'Nothing to bring in.' 'Green' }
  exit 0
}

if ($ahead -gt 0) { Stop-Here 'You have commits GitHub does not, and GitHub has commits you do not: that needs a merge, which is not done for you. Push yours first, or say what to do.' }

if ($dirty -and -not $Adopt) {
  Stop-Here 'Commit or stash those changes first. (If they are just a copied build and can go, run this again with -Adopt: it backs them up first.)'
}

if ($dirty -and $Adopt) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path (Split-Path -Parent $repo) "bedrock-agent-backup-$stamp"
  Say ''
  Say ("-Adopt: {0} changed file(s) (and any new ones) will be copied to {1} and then this folder made to match GitHub." -f $dirty.Count, $backup) 'Yellow'
  $answer = Read-Host 'Type YES to go on'
  if ($answer -ne 'YES') { Stop-Here 'Not confirmed.' }
  # (Also every new file git isn't ignoring: the reset can write over one with the same name.)
  $untracked = @(Invoke-Git ls-files --others --exclude-standard | Where-Object { $_ })
  foreach ($f in (@($dirty) + $untracked)) {
    $src = Join-Path $repo $f
    if (Test-Path -LiteralPath $src) {
      $dst = Join-Path $backup $f
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
      Copy-Item -LiteralPath $src -Destination $dst -Force
    }
  }
  $null = Invoke-Git reset --hard $remote
  if (-not $gitOk) { Say 'git reset failed; your backup is in ' 'Red'; Say $backup 'Red'; exit 1 }
  Say "Backed up to $backup" 'Green'
} else {
  $out = Invoke-Git merge --ff-only $remote
  if (-not $gitOk) { $out | ForEach-Object { Say $_ 'Red' }; Stop-Here 'The fast-forward did not go through.' }
}

$build = Select-String -Path (Join-Path $repo 'behavior_pack/scripts/config.js') -Pattern "build:\s*'([^']+)'" | Select-Object -First 1
if ($build) { Say ("Now at build {0}." -f $build.Matches[0].Groups[1].Value) 'Green' }

# The server keeps its own copy of the pack.
$server = Join-Path $repo 'server'
if (Test-Path (Join-Path $server 'server.properties')) {
  & (Join-Path $PSScriptRoot 'deploy.ps1') -BdsPath $server
  if (Get-Process bedrock_server -ErrorAction SilentlyContinue) {
    Say 'The server is running: type stop in its window and start it again (Start Agent.bat) to load the new pack and brain.' 'Yellow'
  }
} else {
  Say 'No server folder here, so no pack was copied.'
}
Say 'Updated.' 'Green'
