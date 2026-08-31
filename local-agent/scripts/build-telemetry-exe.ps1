# Builds local-agent/server/telemetry-server.mjs into a real, standalone telemetry-server.exe
# via Node's Single Executable Application (SEA) feature - no system Node.js install needed to
# run the result. This is the exact pipeline validated directly against this real file during
# Phase 1/2 research (a plain SEA blob of the .mjs as-is throws "Cannot use import statement
# outside a module" - SEA runs the entry point as CommonJS, not ESM):
#   1. esbuild bundles the ESM source to a single CommonJS file (no real deps to inline - the
#      source only imports node: built-ins - but the entry point itself still has to become CJS).
#   2. node --experimental-sea-config snapshots that CJS file into a preparation blob.
#   3. A copy of node.exe has its Authenticode signature stripped (postject's own documented
#      requirement - injecting into a signed binary invalidates the signature anyway, and
#      Windows won't run a binary whose signature became invalid without this step first).
#   4. postject injects the blob into the stripped copy under the fuse Node's SEA loader checks
#      for at startup.
#
# Output path is deliberate: local-agent/server/telemetry-server.exe, sitting right next to
# get-telemetry.ps1 - exactly where telemetry-server.mjs itself already sits. This means the
# server's own RUST_BINARY/PS_SCRIPT/state-file path construction (all relative to __dirname)
# needs no change beyond the __dirname derivation itself (see telemetry-server.mjs's own comment
# on isSea() vs import.meta.url) - the installer just has to preserve this same relative layout
# (server/ next to a sibling ../rust-collector/target/release/) under whatever real install root
# the customer picks.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot   # local-agent/
$serverDir = Join-Path $root "server"
$mjsPath = Join-Path $serverDir "telemetry-server.mjs"
$cjsPath = Join-Path $serverDir "telemetry-server.cjs"
$blobPath = Join-Path $serverDir "telemetry-server.blob"
$seaConfigPath = Join-Path $serverDir "sea-config.json"
$exePath = Join-Path $serverDir "telemetry-server.exe"

Write-Host "[build] Bundling ESM -> CJS with esbuild..."
Push-Location $root
try {
    & npx esbuild $mjsPath --bundle --platform=node --format=cjs --outfile=$cjsPath --external:node:*
    if ($LASTEXITCODE -ne 0) { throw "esbuild failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host "[build] Writing sea-config.json..."
@{
    main = "telemetry-server.cjs"
    output = "telemetry-server.blob"
    disableExperimentalSEAWarning = $true
} | ConvertTo-Json | Set-Content -Path $seaConfigPath

Write-Host "[build] Generating SEA preparation blob..."
Push-Location $serverDir
try {
    & node --experimental-sea-config sea-config.json
    if ($LASTEXITCODE -ne 0) { throw "node --experimental-sea-config failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host "[build] Copying node.exe..."
$nodePath = (Get-Command node).Source
Copy-Item -Path $nodePath -Destination $exePath -Force

Write-Host "[build] Stripping Authenticode signature (required before postject injection)..."
$signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like "*x64*" } | Select-Object -First 1 -ExpandProperty FullName
if (-not $signtool) { throw "signtool.exe not found - install the Windows SDK to build this target" }
& $signtool remove /s $exePath | Out-Null

Write-Host "[build] Injecting SEA blob via postject..."
Push-Location $serverDir
try {
    & npx --yes postject $exePath NODE_SEA_BLOB $blobPath `
        --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 `
        --overwrite
    if ($LASTEXITCODE -ne 0) { throw "postject failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Host "[build] Cleaning up intermediate build artifacts..."
Remove-Item -Path $cjsPath, $blobPath, $seaConfigPath -Force -ErrorAction SilentlyContinue

Write-Host "[build] Done: $exePath"
