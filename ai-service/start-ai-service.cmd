@echo off
REM Launcher for the "PulseEndpointAiService" Scheduled Task.
REM schtasks.exe's classic /Create syntax has no working-directory switch (confirmed via
REM `schtasks /Create /?` - no /WD or equivalent), so this batch file sets it via `cd /d`
REM instead, then runs the real service with its venv's own python.exe - not the system `python`
REM (which may not exist, or may resolve to a different, dependency-less interpreter on PATH),
REM and not `flask run` (a project convention this app.py never adopted - it calls app.run()
REM itself under `if __name__ == "__main__"`). Confirmed directly this is how the service already
REM runs manually: `venv\Scripts\python.exe app.py` from inside ai-service/ starts Flask on
REM 127.0.0.1:8001 and serves /health.
cd /d "C:\Pulse endpoint\ai-service"
venv\Scripts\python.exe app.py
