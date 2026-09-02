# Publishes the current agent so running endpoints can show "Update available".
# Command Centre serves GET /v1/agent/latest from:
#   %ProgramData%\Pulse Endpoint\backend\agent-release.json
# Running agents (still on an older baked UI version) poll that every 60s.
#
# Version comes from frontend/package.json. Bump that first, then build, then this script.
# Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File "C:\Pulse endpoint\installer\publish-agent-release.ps1"

$ErrorActionPreference = "Stop"
$InstallerDir = $PSScriptRoot
$Root = Split-Path $InstallerDir
$PackageJson = Join-Path $Root "frontend\package.json"
$DataDir = Join-Path $env:ProgramData "Pulse Endpoint\backend"
$SourceBackend = Join-Path $Root "backend"
$InnoSetup = Join-Path $InstallerDir "output\PulseEndpointSetup.exe"
$NsisDir = Join-Path $Root "frontend\src-tauri\target\release\bundle\nsis"
$NsisSetup = Get-ChildItem $NsisDir -Filter "*setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName

if (-not (Test-Path $PackageJson)) { throw "package.json not found: $PackageJson" }
$pkg = Get-Content $PackageJson -Raw | ConvertFrom-Json
$Version = ([string]$pkg.version).Trim().TrimStart("v")
if (-not $Version) { throw "frontend/package.json has no version" }

$Installer = $null
if (Test-Path $InnoSetup) { $Installer = $InnoSetup }
elseif ($NsisSetup -and (Test-Path $NsisSetup)) { $Installer = $NsisSetup }
else { throw "No installer found. Build first (installer\output\PulseEndpointSetup.exe)." }

function Publish-To($dir) {
    $releases = Join-Path $dir "releases"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (-not (Test-Path $releases)) { New-Item -ItemType Directory -Path $releases -Force | Out-Null }
    $dest = Join-Path $releases (Split-Path $Installer -Leaf)
    Copy-Item $Installer $dest -Force
    @{
        version   = $Version
        installer = (Split-Path $Installer -Leaf)
    } | ConvertTo-Json | Set-Content -Path (Join-Path $dir "agent-release.json") -Encoding utf8
}

Publish-To $DataDir
Publish-To $SourceBackend
Write-Host "Published agent v$Version"
Write-Host "  installer: $(Split-Path $Installer -Leaf)"
Write-Host "  $($DataDir)\agent-release.json"
Write-Host "Endpoints still on an older version will show Update available within ~60s."
