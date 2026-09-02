# Builds installer\output\PulseEndpointSetup.exe with every payload the .iss needs.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File "C:\Pulse endpoint\installer\build-setup.ps1"
#
# Laptop 2 silent install (after this succeeds):
#   PulseEndpointSetup.exe /VERYSILENT /TYPE=agent /BACKENDURL=http://YOUR-CC-HOST:8443

$ErrorActionPreference = "Stop"
$InstallerDir = $PSScriptRoot
$Root = Split-Path $InstallerDir
$SkipRelaunch = Join-Path $env:LOCALAPPDATA "PulseEndpoint\skip-desktop-relaunch"
$PayloadLhm = Join-Path $InstallerDir "payload\LibreHardwareMonitor"
$RedistDir = Join-Path $InstallerDir "redist"
$RedistExe = Join-Path $RedistDir "windowsdesktop-runtime-10.0.11-win-x64.exe"
$NsisExpected = Join-Path $Root "frontend\src-tauri\target\release\bundle\nsis\Pulse Endpoint agent_0.1.0_x64-setup.exe"
$IsccCandidates = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
)

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

function Ensure-Dir($p) {
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}

function Find-ISCC {
    foreach ($c in $IsccCandidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

Ensure-Dir (Split-Path $SkipRelaunch)
New-Item -ItemType File -Path $SkipRelaunch -Force | Out-Null
Get-Process -Name app -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Step "Stage LibreHardwareMonitor"
$lhmSrc = "C:\Program Files\LibreHardwareMonitor"
if (-not (Test-Path "$lhmSrc\LibreHardwareMonitor.exe")) {
    throw "LibreHardwareMonitor not found at $lhmSrc - install it once on this build PC"
}
Ensure-Dir $PayloadLhm
robocopy $lhmSrc $PayloadLhm /MIR /XF *.pdb *.config /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy LHM failed with $LASTEXITCODE" }
$LASTEXITCODE = 0

Step "Download .NET Desktop Runtime 10.0.11 redistributable (if missing)"
Ensure-Dir $RedistDir
if (-not (Test-Path $RedistExe)) {
    $url = "https://builds.dotnet.microsoft.com/dotnet/WindowsDesktop/10.0.11/windowsdesktop-runtime-10.0.11-win-x64.exe"
    Invoke-WebRequest -Uri $url -OutFile $RedistExe -UseBasicParsing
}

Step "Build rust-collector"
Push-Location (Join-Path $Root "local-agent\rust-collector")
try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build rust-collector failed" }
} finally { Pop-Location }

Step "Build telemetry-server.exe"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "local-agent\scripts\build-telemetry-exe.ps1")
if ($LASTEXITCODE -ne 0) { throw "telemetry-server.exe build failed" }

Step "Build command-center.exe"
Push-Location (Join-Path $Root "backend")
try {
    go build -o command-center.exe .
    if ($LASTEXITCODE -ne 0) { throw "go build command-center.exe failed" }
} finally { Pop-Location }

Step "Build ai-service.exe"
$aiBuild = Join-Path $Root "ai-service\build-exe.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $aiBuild
if ($LASTEXITCODE -ne 0) { throw "ai-service.exe build failed" }

Step "Build Tauri NSIS sub-installer (needs app.exe unlocked)"
Get-Process -Name app -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Push-Location (Join-Path $Root "frontend")
try {
    $env:CARGO_TARGET_DIR = Join-Path $Root "frontend\src-tauri\target"
    npx tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
} finally { Pop-Location }

if (-not (Test-Path $NsisExpected)) {
    $any = Get-ChildItem (Join-Path $Root "frontend\src-tauri\target\release\bundle\nsis\*.exe") -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*setup.exe" } | Select-Object -First 1
    if ($any) {
        Copy-Item $any.FullName $NsisExpected -Force
        Write-Host "Copied $($any.Name) -> Pulse Endpoint agent_0.1.0_x64-setup.exe"
    } else {
        throw "Tauri NSIS setup not found at $NsisExpected"
    }
}

Step "Install Inno Setup 6 if needed"
$iscc = Find-ISCC
if (-not $iscc) {
    winget install --id JRSoftware.InnoSetup -e --accept-package-agreements --accept-source-agreements --disable-interactivity
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $iscc = Find-ISCC
}
if (-not $iscc) { throw "ISCC.exe still not found after Inno Setup install" }

Step "Compile PulseEndpointSetup.exe"
& $iscc (Join-Path $InstallerDir "PulseEndpoint.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

$out = Join-Path $InstallerDir "output\PulseEndpointSetup.exe"
if (-not (Test-Path $out)) { throw "Expected output missing: $out" }
Write-Host "`nBuilt: $out"
Write-Host "Silent agent on laptop 2 (same Wi-Fi as this Command Centre PC):"
Write-Host "  `"$out`" /VERYSILENT /TYPE=agent /BACKENDURL=http://<command-center-ip>:8443"
Write-Host "If Tailscale accounts differ, use the Shared-in 100.x IP from laptop 2's Machines page, not this PC's own tailscale ip."

Step "Publish agent-release.json so running endpoints see Update available"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallerDir "publish-agent-release.ps1")
if ($LASTEXITCODE -ne 0) { throw "publish-agent-release.ps1 failed" }

Remove-Item $SkipRelaunch -Force -ErrorAction SilentlyContinue
