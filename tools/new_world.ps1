<#
  A new world for each update. Start Agent.bat runs this before the server starts: if the pack's build (behavior_pack\scripts\config.js) is not
  the one the current server world was made for, a fresh world is made ("Agent u181": the settings of the current world, a new seed, an empty
  map) and the server pointed at it, with the pack enabled in it. The old worlds stay in server\worlds. Nothing happens when the build is the
  same as last time, so restarting the server keeps the world.

    Start Agent.bat keep        skips this once (keeps the current world)
#>
param([switch]$Keep)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $root 'server'
$props = Join-Path $server 'server.properties'
if (-not (Test-Path $props)) { exit 0 }
if ($Keep) { Write-Host 'Keeping the current world.'; exit 0 }
if (Get-Process bedrock_server -ErrorAction SilentlyContinue) { Write-Host 'The server is already running: not changing its world.'; exit 0 }

$cfg = Get-Content (Join-Path $root 'behavior_pack\scripts\config.js') -Raw
if ($cfg -notmatch "build:\s*'(u\d+)'") { Write-Host 'Could not read the build number: keeping the current world.'; exit 0 }
$build = $Matches[1]
$marker = Join-Path $server '.world_build'
if ((Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $build)) { exit 0 }

$utf8 = New-Object System.Text.UTF8Encoding $false
$lines = [IO.File]::ReadAllLines($props, $utf8)
$cur = ($lines | Where-Object { $_ -match '^level-name=' } | Select-Object -First 1) -replace '^level-name=', ''
$template = Join-Path $server "worlds\$cur\level.dat"
if (-not (Test-Path $template)) {
  Write-Host "No world '$cur' to take the settings from (start the server once, or Use My World.bat first): keeping things as they are." -ForegroundColor Yellow
  exit 0
}
$name = "Agent $build"
$dest = Join-Path $server "worlds\$name"
$py = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' } else { $null }
if (-not $py) { Write-Host 'Python is needed to make the new world: keeping the current one.' -ForegroundColor Yellow; exit 0 }

if (-not (Test-Path $dest)) {
  & $py (Join-Path $PSScriptRoot 'new_world.py') $template (Join-Path $dest 'level.dat') $name
  if ($LASTEXITCODE -ne 0) { Write-Host 'Could not make the new world: keeping the current one.' -ForegroundColor Yellow; exit 0 }
}
$text = $lines -replace '^level-name=.*', "level-name=$name"
[IO.File]::WriteAllLines($props, $text, $utf8)
& (Join-Path $PSScriptRoot 'deploy.ps1') -BdsPath $server -WorldName $name
Set-Content -Path $marker -Value $build -Encoding ascii
Write-Host "New world '$name' for build $build (the old ones are still in server\worlds)." -ForegroundColor Green
