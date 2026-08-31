# Real mid-session crash recovery for the five core Pulse Endpoint processes.
#
# Why this exists instead of relying only on each Scheduled Task's RestartCount/RestartInterval:
# confirmed directly (killed telemetry-server's node.exe, watched the Task Scheduler Operational
# event log) that Windows Task Scheduler's restart-on-failure only retries a task that FAILED TO
# LAUNCH - once wscript.exe has successfully started and is being waited on, a later crash of the
# real process it's watching gets logged as "Task Scheduler successfully completed task ... with
# return code <nonzero>" (event 201/102), not as a failure, and no restart is attempted. That
# mechanism is still worth having (see run-hidden.vbs's own wait/exit-code fix) for the case a
# launch itself fails, but it does not cover "the process ran fine for an hour then crashed" -
# which is the actual case this watchdog exists for.
#
# Each target's existing Scheduled Task is reused as the relaunch mechanism (Start-ScheduledTask)
# rather than duplicating its launch logic (working directory, hidden window, run level) here.

$stateDir = Join-Path $env:LOCALAPPDATA "PulseEndpoint"
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }
$stateFile = Join-Path $stateDir "watchdog-state.json"
$logFile = Join-Path $stateDir "watchdog.log"

# Same cap the Scheduled Tasks themselves use (RestartCount=15) - a genuinely broken process
# (missing dependency, corrupted install) stops getting retried after 15 consecutive misses
# instead of relaunching forever and spamming the log, until it's next seen running again (which
# resets its counter to 0) - e.g. after a manual fix or a real reboot.
$maxMisses = 15

# telemetry-server and command-center are matched by their listening TCP port, not process
# identity - both run elevated (RunLevel Highest / a separate integrity level from whatever
# unelevated context might inspect them), and Win32_Process.CommandLine came back blank when
# queried across that boundary during testing, which would cause the same kind of false "not
# running" positive LibreHardwareMonitor's .Path check hit below. A listening port is also a more
# meaningful liveness signal anyway - it confirms the service is actually reachable, not just that
# some process with a matching name exists.
# Node never reloads telemetry-server.mjs. A listener on 4317 can still be last week's process
# (GET /api/enrollment 404). Port-only liveness would leave that copy running forever. This
# watchdog is RunLevel Highest, so it can stop that PID; the unelevated agent UI cannot.
$justRestartedTelemetry = $false
$curl = Join-Path $env:SystemRoot "System32\curl.exe"
$telemetryListen = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($telemetryListen -and (Test-Path $curl)) {
    $enrollCode = & $curl -s -o NUL -w "%{http_code}" --max-time 3 "http://127.0.0.1:4317/api/enrollment" 2>$null
    if ($enrollCode -eq "404") {
        try {
            Stop-ScheduledTask -TaskName "PulseEndpointTelemetryServer" -ErrorAction SilentlyContinue
            Stop-Process -Id $telemetryListen.OwningProcess -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
            Start-ScheduledTask -TaskName "PulseEndpointTelemetryServer" -ErrorAction Stop
            $justRestartedTelemetry = $true
            "$(Get-Date -Format o)  PulseEndpointTelemetryServer was stale (GET /api/enrollment HTTP 404) - restarted" | Add-Content $logFile
        } catch {
            "$(Get-Date -Format o)  failed to restart stale PulseEndpointTelemetryServer: $_" | Add-Content $logFile
        }
    }
}

$targets = @(
    @{ TaskName = "PulseEndpointTelemetryServer"; Check = { Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue } }
    @{ TaskName = "PulseEndpointCommandCenter"; Check = { Get-NetTCPConnection -LocalPort 8443 -State Listen -ErrorAction SilentlyContinue } }
    # Port-based, same reasoning as telemetryServer/commandCenter/ai-service - LHM's Remote
    # Web Server is the signal the agent actually uses (localhost:8085/data.json). Matching the
    # process name "LIBREH~1" missed a running server whose listener is owned by http.sys
    # (PID 4) rather than a process named LibreHardwareMonitor.
    @{ TaskName = "PulseEndpointLibreHardwareMonitor"; Check = { Get-NetTCPConnection -LocalPort 8085 -State Listen -ErrorAction SilentlyContinue } }
    # CIM ExecutablePath (not Get-Process .Path): Path can be empty without elevation, which
    # made this check miss a running agent and Start-ScheduledTask a second copy — two tray icons.
    @{ TaskName = "PulseEndpointDesktopApp"; Check = {
        Get-CimInstance Win32_Process -Filter "Name='app.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.ExecutablePath -like "*Pulse endpoint*" }
    } }
    # Port-based, same reasoning as telemetryServer/commandCenter above - ai-service is a Flask
    # HTTP service (127.0.0.1:8001), and a listening port confirms it's actually reachable, not
    # just that some python.exe with a matching path exists.
    @{ TaskName = "PulseEndpointAiService"; Check = { Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue } }
)

$state = @{}
if (Test-Path $stateFile) {
    try {
        (Get-Content $stateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value }
    } catch {
        $state = @{}
    }
}

# Each Pulse Endpoint desktop process registers its own tray icon. Keep the oldest, stop extras.
# skip-desktop-relaunch: present while app.exe is being rebuilt so this watchdog does not start
# a copy that would lock the binary (Access denied on the linker).
$skipDesktopRelaunch = Test-Path (Join-Path $stateDir "skip-desktop-relaunch")
$desktopApps = @(
    Get-CimInstance Win32_Process -Filter "Name='app.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -like "*Pulse endpoint*" }
)
if (-not $skipDesktopRelaunch -and $desktopApps.Count -gt 1) {
    $ordered = @($desktopApps | Sort-Object CreationDate)
    $keepId = $ordered[0].ProcessId
    foreach ($p in $ordered[1..($ordered.Length - 1)]) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            "$(Get-Date -Format o)  extra Pulse Endpoint app.exe PID $($p.ProcessId) stopped (kept PID $keepId)" | Add-Content $logFile
        } catch {
            "$(Get-Date -Format o)  failed to stop extra app.exe PID $($p.ProcessId): $_" | Add-Content $logFile
        }
    }
}

foreach ($t in $targets) {
    # Agent-only installs never register Command Centre / AI tasks. Do not Start-ScheduledTask
    # a name that does not exist (that used to spam watchdog.log every minute).
    if (-not (Get-ScheduledTask -TaskName $t.TaskName -ErrorAction SilentlyContinue)) {
        continue
    }
    if ($skipDesktopRelaunch -and $t.TaskName -eq "PulseEndpointDesktopApp") {
        continue
    }
    if ($justRestartedTelemetry -and $t.TaskName -eq "PulseEndpointTelemetryServer") {
        continue
    }
    $running = & $t.Check
    if ($running) {
        $state[$t.TaskName] = 0
        continue
    }

    $misses = 0
    if ($state.ContainsKey($t.TaskName)) { $misses = [int]$state[$t.TaskName] }

    if ($misses -ge $maxMisses) {
        continue
    }

    try {
        Start-ScheduledTask -TaskName $t.TaskName -ErrorAction Stop
        $state[$t.TaskName] = $misses + 1
        "$(Get-Date -Format o)  $($t.TaskName) not running (miss #$($misses + 1) of $maxMisses) - relaunched via Start-ScheduledTask" | Add-Content $logFile
    } catch {
        "$(Get-Date -Format o)  $($t.TaskName) not running but Start-ScheduledTask itself failed: $_" | Add-Content $logFile
    }
}

$state | ConvertTo-Json | Set-Content $stateFile
