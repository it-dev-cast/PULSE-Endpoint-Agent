@echo off
REM Launcher for the "PulseEndpointWatchdog" Scheduled Task.
REM Exists so this task can be wrapped through run-hidden.vbs the same way
REM PulseEndpointTelemetryServer/CommandCenter/LibreHardwareMonitor already are - run-hidden.vbs
REM takes a single target argument (a .cmd path or a bare .exe path), matching that same
REM convention here rather than pointing schtasks directly at powershell.exe.
REM
REM watchdog.ps1's own `-WindowStyle Hidden` flag was NOT sufficient on its own: that's a
REM self-hiding request from inside the PowerShell process, and conhost.exe can still create
REM (and briefly show) the console window before PowerShell gets a chance to act on it - a real,
REM confirmed console flash once a minute, every minute. Routing through run-hidden.vbs applies
REM SW_HIDE at the WshShell.Run/CreateProcess level instead, the same reliable mechanism already
REM verified hidden for the other three background tasks.
REM %~dp0 (this batch file's own drive+path) replaces the old hardcoded "C:\Pulse
REM endpoint\local-agent\scripts" - the real installer can put this file anywhere.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "watchdog.ps1"
