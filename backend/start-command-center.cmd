@echo off
REM Launcher for the "PulseEndpointCommandCenter" Scheduled Task.
REM schtasks.exe's classic /Create syntax has no working-directory switch (confirmed via
REM `schtasks /Create /?` - no /WD or equivalent), so this batch file sets it via `cd /d`
REM instead - both so command-center.exe is found by a relative path below, and so it reads
REM .env.local (PORT/JWT_SECRET/ADMIN_PASSWORD/DATABASE_URL) from the right place, since dotenv.go's loader
REM reads that file relative to the process's current working directory. signing-key.json is
REM also stored here. Fleet data itself lives in PostgreSQL (DATABASE_URL), not a local .db file.
REM
REM Runs the already-built command-center.exe directly, not `go run .` - a real launcher runs a
REM built artifact; recompiling on every logon would also require the Go toolchain to be
REM installed and on PATH for whatever account this task runs as, which a production launch
REM shouldn't depend on. Rebuild it yourself (`go build -o command-center.exe .`) after pulling
REM code changes - this script does not do that for you.
REM
REM REAL BUG FOUND BY TESTING, FIXED HERE: this used to `cd /d "%~dp0"` (the exe's own
REM directory) unconditionally - fine for local dev, but a real installer's default install
REM location is Program Files, and BUILTIN\Users only has ReadAndExecute there (confirmed
REM directly via Get-Acl on a real installed copy) - command-center.exe runs at RunLevel Limited
REM (unelevated, on purpose - it only needs outbound HTTP, not TPM/BitLocker access like the
REM telemetry server), so it genuinely cannot create .env.local or signing-key.json next to
REM itself once installed there. It failed with a real "unable to open database file: out of
REM memory (14)" (SQLite's own generic message for a permission-denied CANTOPEN), not a crash
REM that explained itself. %ProgramData% is the standard, correct Windows location for a
REM service's own writable state - the exe binary stays wherever it's installed (Program Files
REM or this repo's own backend/ folder in dev), only its mutable data moves.
set "PULSE_CC_BIN=%~dp0"
set "PULSE_CC_DATA=%ProgramData%\Pulse Endpoint\backend"
if not exist "%PULSE_CC_DATA%" mkdir "%PULSE_CC_DATA%" >nul 2>&1
if not exist "%PULSE_CC_DATA%\.env.local" (
    if exist "%PULSE_CC_BIN%.env.local" copy "%PULSE_CC_BIN%.env.local" "%PULSE_CC_DATA%\.env.local" >nul
)
cd /d "%PULSE_CC_DATA%"
"%PULSE_CC_BIN%command-center.exe"
