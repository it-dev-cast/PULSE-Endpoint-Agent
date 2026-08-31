# Creates the Pulse Command Centre PostgreSQL database/user, writes DATABASE_URL
# into %ProgramData%\Pulse Endpoint\backend\.env.local, rebuilds command-center.exe,
# and restarts it. Existing SQLite fleet data is imported automatically on first start.
#
# Run from an elevated or normal PowerShell (psql must be able to authenticate as
# the postgres superuser):
#   powershell -ExecutionPolicy Bypass -File "C:\Pulse endpoint\backend\setup-postgres.ps1"
#
# The script prompts for the PostgreSQL superuser password. It is not echoed.

$ErrorActionPreference = "Stop"
$Psql = Join-Path ${env:ProgramFiles} "PostgreSQL\17\bin\psql.exe"
if (-not (Test-Path $Psql)) { throw "psql not found at $Psql" }

$EnvDir = Join-Path $env:ProgramData "Pulse Endpoint\backend"
$EnvFile = Join-Path $EnvDir ".env.local"
$BackendDir = $PSScriptRoot
$DbName = "pulse_command_center"
$DbUser = "pulse_cc"

Write-Host "PostgreSQL superuser password (not shown):"
$secure = Read-Host -AsSecureString
$BSTR = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)

$bytes = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$AppPass = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','x').Replace('/','y')
$env:PGCONNECT_TIMEOUT = "8"

function Invoke-Psql([string]$sql) {
    & $Psql -w -U postgres -d postgres -v ON_ERROR_STOP=1 -c $sql
    if ($LASTEXITCODE -ne 0) { throw "psql failed: $sql" }
}

Write-Host "Creating role and database..."
Invoke-Psql "SELECT 1 FROM pg_roles WHERE rolname = '$DbUser'" | Out-Null
$roleExists = & $Psql -w -U postgres -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$DbUser'"
if ($roleExists -ne "1") {
    Invoke-Psql "CREATE ROLE $DbUser LOGIN PASSWORD '$AppPass'"
} else {
    Invoke-Psql "ALTER ROLE $DbUser PASSWORD '$AppPass'"
}
$dbExists = & $Psql -w -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DbName'"
if ($dbExists -ne "1") {
    Invoke-Psql "CREATE DATABASE $DbName OWNER $DbUser"
}
Invoke-Psql "GRANT ALL PRIVILEGES ON DATABASE $DbName TO $DbUser"

$Url = "postgres://${DbUser}:${AppPass}@127.0.0.1:5432/${DbName}?sslmode=disable"

if (-not (Test-Path $EnvDir)) { New-Item -ItemType Directory -Path $EnvDir -Force | Out-Null }
if (-not (Test-Path $EnvFile)) { New-Item -ItemType File -Path $EnvFile -Force | Out-Null }

$lines = @(Get-Content $EnvFile -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch '^\s*DATABASE_URL=' })
$lines += "DATABASE_URL=$Url"
Set-Content -Path $EnvFile -Value $lines -Encoding ascii

$RepoEnv = Join-Path $BackendDir ".env.local"
if (Test-Path $RepoEnv) {
    $repoLines = @(Get-Content $RepoEnv | Where-Object { $_ -notmatch '^\s*DATABASE_URL=' })
    $repoLines += "DATABASE_URL=$Url"
    Set-Content -Path $RepoEnv -Value $repoLines -Encoding ascii
}

Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
$AppPass = $null
$Url = $null

Write-Host "DATABASE_URL written (password not printed)."
Write-Host "Rebuilding command-center.exe..."

$cc = Get-CimInstance Win32_Process -Filter "Name = 'command-center.exe'" -ErrorAction SilentlyContinue
if ($cc) { Stop-Process -Id $cc.ProcessId -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }

Push-Location $BackendDir
try {
    go build -o command-center.exe .
    if ($LASTEXITCODE -ne 0) { throw "go build failed" }
} finally { Pop-Location }

$task = Get-ScheduledTask -TaskName "PulseEndpointCommandCenter" -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "Restarting PulseEndpointCommandCenter..."
    Start-ScheduledTask -TaskName "PulseEndpointCommandCenter"
} else {
    Write-Host "Scheduled task PulseEndpointCommandCenter not found - start Command Centre the way you usually do."
}

Write-Host "Done. First start copies SQLite fleet data into PostgreSQL if the Postgres devices table is empty."
