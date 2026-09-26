<#
  Copies one of your single-player worlds into the agent's server so the bot can play in it.
  Your original world is never modified: the server gets its own copy.
  Run it through "Use My World.bat" (double-click), with the server stopped.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'server'

if (Get-Process bedrock_server -ErrorAction SilentlyContinue) {
  Write-Host "The server is running. Type 'stop' in the server window first, then run this again." -ForegroundColor Yellow
  exit 1
}

# Where Minecraft keeps worlds: current launcher layout, then the older Store-app layout.
$roots = @()
$roots += Get-ChildItem "$env:APPDATA\Minecraft Bedrock\Users" -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { Join-Path $_.FullName 'games\com.mojang\minecraftWorlds' }
$roots += "$env:LOCALAPPDATA\Packages\Microsoft.MinecraftUWP_8wekyb3d8bbwe\LocalState\games\com.mojang\minecraftWorlds"

$worlds = foreach ($r in $roots) {
  if (Test-Path $r) {
    Get-ChildItem $r -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'level.dat') } | ForEach-Object {
      $nameFile = Join-Path $_.FullName 'levelname.txt'
      $name = if (Test-Path $nameFile) { (Get-Content $nameFile -Raw).Trim() } else { $_.Name }
      [pscustomobject]@{ Name = $name; Path = $_.FullName; Modified = $_.LastWriteTime }
    }
  }
}
$worlds = @($worlds | Sort-Object Modified -Descending)
if (-not $worlds.Count) { Write-Host 'No single-player worlds found.'; exit 1 }

Write-Host "`nYour worlds (most recently played first):`n"
for ($i = 0; $i -lt $worlds.Count; $i++) {
  Write-Host ("  {0,2}. {1}   (last played {2:g})" -f ($i + 1), $worlds[$i].Name, $worlds[$i].Modified)
}
$pick = Read-Host "`nNumber of the world to use"
$w = $worlds[[int]$pick - 1]
if (-not $w) { Write-Host 'Invalid choice.'; exit 1 }

$safe = ($w.Name -replace '[\\/:*?"<>|]', '_').Trim()
if (-not $safe) { $safe = 'My World' }
$dest = Join-Path $server "worlds\$safe"
if (Test-Path $dest) {
  $backup = "$dest.old-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Write-Host "A server copy of '$safe' already exists; moving it to $(Split-Path $backup -Leaf)"
  Move-Item $dest $backup
}
Write-Host "Copying '$($w.Name)'..."
Copy-Item $w.Path $dest -Recurse

# Beta APIs must be on for the bot's scripts. This only changes the server's copy.
$py = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' } else { $null }
if (-not $py) { throw 'Python is needed to switch on Beta APIs in the copied world. Install it from python.org.' }
& $py (Join-Path $PSScriptRoot 'enable_beta_apis.py') (Join-Path $dest 'level.dat')
if ($LASTEXITCODE -ne 0) { throw 'Could not enable Beta APIs.' }

# Point the server at it and install the pack.
$props = Join-Path $server 'server.properties'
# Read and write as UTF-8 explicitly (no BOM): Windows PowerShell reads as ANSI by default, and
# writing that back as UTF-8 doubles every non-ASCII character on each run until BDS can't
# parse the file at all ("Contents of server.properties: {}").
$utf8 = New-Object System.Text.UTF8Encoding $false
$text = [IO.File]::ReadAllLines($props, $utf8) -replace '^level-name=.*', "level-name=$safe"
[IO.File]::WriteAllLines($props, $text, $utf8)
& (Join-Path $PSScriptRoot 'deploy.ps1') -BdsPath $server -WorldName $safe

Write-Host "`nDone. The server will now load '$safe'. Start it with Start Agent.bat." -ForegroundColor Green
Write-Host "Your original single-player world is untouched. Progress made on the server stays in:"
Write-Host "  $dest"
