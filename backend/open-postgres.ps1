$ErrorActionPreference = "Stop"
$envFile = Join-Path $env:ProgramData "Pulse Endpoint\backend\.env.local"
$line = Get-Content -LiteralPath $envFile | Where-Object { $_ -like "DATABASE_URL=*" } | Select-Object -First 1
if (-not $line) { throw "DATABASE_URL missing in $envFile" }
$u = [Uri]($line.Substring("DATABASE_URL=".Length).Trim())
$userInfo = $u.UserInfo.Split(":", 2)
$env:PGPASSWORD = [Uri]::UnescapeDataString($userInfo[1])
$psql = Join-Path ${env:ProgramFiles} "PostgreSQL\17\bin\psql.exe"
Write-Host ""
Write-Host "pulse_command_center  (127.0.0.1:5432)"
Write-Host "Type these, then Enter:"
Write-Host "  \dt"
Write-Host "  SELECT hostname, status, last_seen_at FROM devices;"
Write-Host "  SELECT device_id, cpu_pct, ram_pct, disk_pct FROM device_live_status;"
Write-Host "  \q"
Write-Host ""
& $psql -h 127.0.0.1 -p 5432 -U pulse_cc -d pulse_command_center
