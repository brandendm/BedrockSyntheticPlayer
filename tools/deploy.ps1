<#
  Installs the behavior pack into a Bedrock Dedicated Server and enables what it needs.

    .\tools\deploy.ps1 -BdsPath "C:\bds"                 # uses level-name from server.properties
    .\tools\deploy.ps1 -BdsPath "C:\bds" -WorldName "Agent Test"

  It:
    1. copies behavior_pack -> <BDS>\development_behavior_packs\BedrockAgent
    2. adds the pack to worlds\<world>\world_behavior_packs.json
    3. allows @minecraft/server-net and -gametest in config\default\permissions.json
  The world itself must have the "Beta APIs" experiment on (see README).
#>
param(
  [Parameter(Mandatory = $true)][string]$BdsPath,
  [string]$WorldName
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)  # BDS wants JSON without a BOM

$repo = Split-Path -Parent $PSScriptRoot
$pack = Join-Path $repo 'behavior_pack'
$manifest = Get-Content (Join-Path $pack 'manifest.json') -Raw | ConvertFrom-Json

if (-not (Test-Path (Join-Path $BdsPath 'server.properties'))) { throw "No server.properties in $BdsPath. Is that the BDS folder?" }
if (-not $WorldName) {
  $line = Get-Content (Join-Path $BdsPath 'server.properties') | Where-Object { $_ -match '^level-name=' } | Select-Object -First 1
  $WorldName = $line -replace '^level-name=', ''
}

# 1. pack
$dest = Join-Path $BdsPath 'development_behavior_packs\BedrockAgent'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item $pack $dest -Recurse
Write-Host "Pack copied to $dest"

# 2. world pack list
$worldDir = Join-Path $BdsPath "worlds\$WorldName"
if (-not (Test-Path $worldDir)) { throw "World folder not found: $worldDir (start BDS once, or copy your Beta-APIs world there)" }
$wbp = Join-Path $worldDir 'world_behavior_packs.json'
$list = @()
if (Test-Path $wbp) { $list = @(Get-Content $wbp -Raw | ConvertFrom-Json) }
$list = @($list | Where-Object { $_.pack_id -and $_.pack_id -ne $manifest.header.uuid }) # (PS 5 turns an empty "[]" into a junk {value, Count} entry: drop it)
$list += [pscustomobject]@{ pack_id = $manifest.header.uuid; version = @($manifest.header.version) }
[IO.File]::WriteAllText($wbp, (ConvertTo-Json -InputObject $list -Depth 5), $utf8)
Write-Host "Enabled in world '$WorldName'"

# 3. module permissions
$permDir = Join-Path $BdsPath 'config\default'
New-Item -ItemType Directory -Force $permDir | Out-Null
$perm = Join-Path $permDir 'permissions.json'
$allowed = @('@minecraft/server', '@minecraft/server-ui', '@minecraft/server-admin', '@minecraft/server-gametest', '@minecraft/server-net', '@minecraft/common')
if (Test-Path $perm) {
  $cur = Get-Content $perm -Raw | ConvertFrom-Json
  if ($cur.allowed_modules) { $allowed = @($cur.allowed_modules + $allowed | Select-Object -Unique) }
}
[IO.File]::WriteAllText($perm, (ConvertTo-Json -InputObject @{ allowed_modules = $allowed } -Depth 5), $utf8)
Write-Host "Module permissions updated: $perm"
Write-Host "Done. Restart BDS, join, and type: !bot spawn"
