# Publishes the current agent as a real, signed PRD Section 31 Self-Update v1 release.
# Command Centre serves GET /v1/agent/latest from:
#   %ProgramData%\Pulse Endpoint\backend\agent-release.json
# Running agents poll that every backend cycle and, once a real embedded-public-key signature and
# a strictly-newer sequence number both verify, download/verify-by-hash/silently install it
# themselves (see telemetry-server.mjs's own PRD Section 31 comment) - this is no longer just a
# "show a badge" publish, it's the actual trust root for what every device will treat as genuine.
#
# Version comes from frontend/package.json. Bump that first, then build, then this script.
# Requires backend/release-signing-key.json to exist (run backend/cmd/gen-release-key once, on a
# fresh checkout, and back up that file immediately - see that tool's own comment).
# Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File "C:\Pulse endpoint\installer\publish-agent-release.ps1"

$ErrorActionPreference = "Stop"
$InstallerDir = $PSScriptRoot
$Root = Split-Path $InstallerDir
$PackageJson = Join-Path $Root "frontend\package.json"
$DataDir = Join-Path $env:ProgramData "Pulse Endpoint\backend"
$SourceBackend = Join-Path $Root "backend"
$ReleaseKey = Join-Path $SourceBackend "release-signing-key.json"
$InnoSetup = Join-Path $InstallerDir "output\PulseEndpointSetup.exe"
$NsisDir = Join-Path $Root "frontend\src-tauri\target\release\bundle\nsis"
$NsisSetup = Get-ChildItem $NsisDir -Filter "*setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName

if (-not (Test-Path $PackageJson)) { throw "package.json not found: $PackageJson" }
if (-not (Test-Path $ReleaseKey)) { throw "release-signing-key.json not found at $ReleaseKey - run 'go run ./cmd/gen-release-key' from backend\ once (and back up the result immediately)." }
$pkg = Get-Content $PackageJson -Raw | ConvertFrom-Json
$Version = ([string]$pkg.version).Trim().TrimStart("v")
if (-not $Version) { throw "frontend/package.json has no version" }

$Installer = $null
if (Test-Path $InnoSetup) { $Installer = $InnoSetup }
elseif ($NsisSetup -and (Test-Path $NsisSetup)) { $Installer = $NsisSetup }
else { throw "No installer found. Build first (installer\output\PulseEndpointSetup.exe)." }

# Version-specific filename, never overwritten by a later publish - this IS the manual-rollback
# path (PRD Section 31: "keep the last-known-good installer accessible so a human can re-run it
# if an update goes bad"). The old behavior (always "PulseEndpointSetup.exe", overwritten every
# publish) left nothing to roll back to.
$InstallerName = "PulseEndpointSetup-$Version.exe"

function Publish-To($dir) {
    $releases = Join-Path $dir "releases"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if (-not (Test-Path $releases)) { New-Item -ItemType Directory -Path $releases -Force | Out-Null }
    $dest = Join-Path $releases $InstallerName
    Copy-Item $Installer $dest -Force

    $manifestPath = Join-Path $dir "agent-release.json"
    Push-Location $SourceBackend
    try {
        & go run ./cmd/sign-release `
            -version $Version `
            -installer $dest `
            -installer-name $InstallerName `
            -key $ReleaseKey `
            -out $manifestPath
        if ($LASTEXITCODE -ne 0) { throw "sign-release failed for $dir (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

Publish-To $DataDir
Publish-To $SourceBackend
Write-Host "Published signed agent release v$Version"
Write-Host "  installer: $InstallerName (retained - previous versions still in releases\ for manual rollback)"
Write-Host "  $($DataDir)\agent-release.json"
Write-Host "Endpoints will verify the signature and sequence number, then update themselves within ~60s."
