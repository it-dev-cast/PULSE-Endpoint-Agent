@echo off
REM Launcher for the "PulseEndpointTelemetryServer" Scheduled Task.
REM schtasks.exe's classic /Create syntax has no working-directory switch (confirmed via
REM `schtasks /Create /?` - no /WD or equivalent), so this batch file sets it via `cd /d`
REM instead, then runs the server with the relative script path the project expects.
cd /d "C:\Pulse endpoint\local-agent"
node server\telemetry-server.mjs
