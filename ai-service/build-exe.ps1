# Builds ai-service/app.py into a real, standalone ai-service.exe via PyInstaller - no system
# Python install needed to run the result. Validated directly during Phase 1/2 research: unlike
# telemetry-server.mjs, app.py has no __file__-based path resolution and no bundled assets, so
# this needs no source changes at all - --onefile just works, confirmed by actually calling the
# packaged exe's real /predict/{deviceId} endpoint against the live backend and getting a real
# computed result back.
#
# Requires pyinstaller from requirements-dev.txt (`venv\Scripts\pip install -r
# requirements-dev.txt`) - not a runtime dependency of app.py itself, only needed to run this
# script.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$distPath = Join-Path $root "dist"
$buildPath = Join-Path $root "build"
$specPath = $root

$python = Join-Path $root "venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "venv not found at $python - create it and install requirements-dev.txt first" }

Write-Host "[build] Running PyInstaller..."
& $python -m PyInstaller --onefile --name ai-service `
    --distpath $distPath --workpath $buildPath --specpath $specPath `
    (Join-Path $root "app.py")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

Write-Host "[build] Cleaning up intermediate build artifacts..."
Remove-Item -Path $buildPath, (Join-Path $root "ai-service.spec") -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[build] Done: $(Join-Path $distPath 'ai-service.exe')"
