
  # Dashboard Redesign for CLPA

  This is a code bundle for Dashboard Redesign for CLPA. The original project is available at https://www.figma.com/design/7w2ssAZjYSaJQtQvCh0iz8/Dashboard-Redesign-for-CLPA.

  ## Project structure

  Three top-level folders, each independently runnable:

  - **`frontend/`** — the React/Vite dashboard (this README's "Running the code" section below). `cd frontend` before running any `npm` command.
  - **`local-agent/`** — everything that runs on the endpoint itself: `server/` (the Node telemetry HTTP server + its PowerShell script) and `rust-collector/` (the Rust binary it shells out to). These two stay siblings deliberately — `server/telemetry-server.mjs` locates the Rust binary via a path relative to itself (`../rust-collector/target/release/pulse-telemetry.exe`), not an absolute one.
  - **`backend/`** — the Cloud Command Center v1 (Go). See `backend/README.md` for its own setup/env vars/endpoints; `cd backend` and `go run .` to run it.

  Everything else at the repo root (this file, `ATTRIBUTIONS.md`, the PRD, and the various status/progress `.md` files) describes the whole project, not one folder, so it stays at the top level.

  > **If you already have the `PulseEndpointTelemetryServer` Scheduled Task registered on your machine from before this reorg:** it stores an absolute path to the old `server/start-telemetry-server.cmd` location, which moving the file breaks — the task itself doesn't get fixed just because the file's own contents did. See "How the telemetry server auto-start works" below for the exact delete-and-recreate commands. This is a one-time, per-machine manual step, the same category as LibreHardwareMonitor/HWiNFO's manual setup steps below — it can't be fixed from inside the repo.

  ## Running the code

  All commands in this section run from inside **`frontend/`** (`cd frontend` first).

  Run `npm i` to install the dependencies.

  Run `npm run dev:all` to start both the live telemetry collector and the dev server together. Open the URL Vite prints (usually http://localhost:5173). This one command is now fully self-sufficient — see the checklist below for exactly what it does and the one thing it still can't automate.

  The telemetry collector (`local-agent/server/telemetry-server.mjs`) queries Windows hardware info via PowerShell/WMI, so live data only appears on Windows. On other platforms the dashboard still runs, showing its sample/placeholder values.

  Real Storage Health % and SSD Temperature additionally require `smartctl.exe` (from [smartmontools](https://www.smartmontools.org/)) to be installed, plus elevation (Run as Administrator) — non-admin NVMe SMART queries fail on Windows, sometimes with a misleading error like "Invalid argument" rather than a clear permissions message. Both are now handled automatically (see the startup checklist below): the telemetry server always runs elevated via a Scheduled Task, and `C:\Program Files\smartmontools\bin` is on the System PATH permanently. Without either, these two fields fall back to sample values; the server logs a `[telemetry] smartctl requires elevated PowerShell` line at startup if it ever detects a lack of elevation.

  Battery Health % additionally falls back to a second real source, `powercfg /batteryreport`, when root/wmi's `BatteryStaticData` class isn't present on your hardware (common on some OEMs). If neither source is available it shows "Unknown" rather than a fabricated percentage. The server logs whether this parse succeeded at startup.

  CPU Temp, GPU Temp, Motherboard Temp, Fan RPM, and CPU Voltage require a separate, third-party application: [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor), installed and running, with its **Remote Web Server** enabled (in the app: Options menu → Remote Web Server → Run, default port 8085). This is not something `npm i` or this repo can install for you — it's a standalone `.exe` you run alongside the dashboard. Each of the five fields falls back to its sample value independently if LibreHardwareMonitor isn't running, isn't reachable at `http://localhost:8085`, or doesn't expose that particular sensor on your hardware (fan RPM in particular is absent on many laptops). The server logs which sensors it found vs. didn't at startup.

  ### Known real infrastructure requirements

  - **LibreHardwareMonitor** (above) — CPU/GPU temp, motherboard temp, fan RPM, CPU voltage. Third-party app, manual Remote Web Server step, see above.
  - **HWiNFO** (optional, second source for motherboard temp, fan RPM, and CPU voltage only) — [HWiNFO](https://www.hwinfo.com/) is a second, independent, optional source for exactly three of the five fields LibreHardwareMonitor covers: Motherboard Temp, Fan RPM, and CPU Voltage. It's read directly by `rust-collector` via HWiNFO's shared memory segment (`Global\HWiNFO_SENS_SM2`) — not through Node, and not through any officially published HWiNFO API (see the reverse-engineering citation in `local-agent/rust-collector/src/hwinfo.rs`). Like LibreHardwareMonitor's Remote Web Server, HWiNFO's **"Shared Memory Support"** must be enabled manually, once per session, in HWiNFO's own settings (right-click the HWiNFO tray icon or open its main Sensor window → Settings → check "Shared Memory Support" under the Main tab) — there's no CLI flag or config file toggle for this either, so it can't be automated the same way the elevated telemetry server and smartctl PATH setup already are. If HWiNFO isn't installed, isn't running, or this setting isn't enabled, `rust-collector` reports all three fields as unavailable and the app falls back to whatever LibreHardwareMonitor independently provides (or the sample value, if neither has it) — this degrades gracefully, the same as a missing LibreHardwareMonitor connection already does. Because HWiNFO's free version stops updating its shared memory after about 12 hours, `rust-collector` also checks the shared memory's own last-update timestamp and treats it as unavailable if it's gone stale, rather than serving frozen readings as if they were live.

  ### Real-data startup checklist

  The whole routine is now: **run `npm run dev:all`, approve the UAC prompt if one appears, and click "Run" in LibreHardwareMonitor if the console reminder says it isn't already serving.** No separate elevated terminal is ever needed. In detail:

  1. **Run `npm run dev:all`** (from inside `frontend/`). Before starting Vite, this runs `local-agent/server/ensure-telemetry-running.mjs`, which:
     - Checks `http://localhost:4317/api/telemetry` — if the telemetry server is already up (e.g. it auto-started at your last login via the Scheduled Task below), it does nothing and moves on. No prompt, no delay.
     - If it's *not* up, launches it elevated itself via `Start-Process -Verb RunAs` — the standard Windows UAC dialog. **Approve it if it appears**; this is the same prompt you'd click "Yes" on for any admin action, just triggered on demand instead of requiring you to open an elevated terminal yourself. It then polls for up to 25s to confirm the server actually came up before continuing.
     - Checks whether LibreHardwareMonitor is running and launches it if not (this launch itself needs no elevation).
     - Either way, prints `⚠ Remember to click Options → Remote Web Server → Run in LibreHardwareMonitor...` every time — the app's Remote Web Server can't be started without a manual click (no CLI flag exists, and its menu isn't accessible to UI-automation tooling either — both were investigated directly, not assumed). This is the one step left that's genuinely manual, and only needed once per session (until the next full restart).
  2. That's it. `smartctl` is also permanently on the System PATH now, so Storage Health/SSD Temp work automatically once the server is up elevated.

  #### How the telemetry server auto-start works

  A Scheduled Task named `PulseEndpointTelemetryServer` (`schtasks /Query /TN PulseEndpointTelemetryServer /V /FO LIST`) runs `local-agent/server/start-telemetry-server.cmd` at logon for the current user, with `/RL HIGHEST` (highest privileges) and `LogonType=InteractiveToken` (only runs in an actual logged-on session, not headless). Registering it from an already-elevated session is what avoids a UAC prompt on every future login — Task Scheduler grants the elevated token directly at logon for tasks configured this way, unlike `Run as Administrator`, which always prompts. `ensure-telemetry-running.mjs` (above) is the fallback for the gap this leaves: a machine that hasn't been logged into since the task was registered, or a task that got disabled/removed.

  Two non-obvious things worth knowing if you ever need to recreate this task:
  - `schtasks /Create /TR` cannot store a path containing a space — it strips one layer of quoting and then splits the stored command on the first space regardless of how the value was quoted going in. The task's action points at the project's Windows short (8.3) path (`C:\PULSEE~1\LOCAL-~1\server\START-~1.CMD`) specifically to avoid this, since "Pulse endpoint" contains a space. This applies equally to the hidden-launch wrapper path introduced below — it also needs its short form for the same reason.
  - `local-agent/server/start-telemetry-server.cmd` exists because `schtasks /Create` has no working-directory switch at all — the batch file's `cd /d` sets it before invoking `node`.

  If you ever want to remove or disable it: `schtasks /Delete /TN PulseEndpointTelemetryServer /F` (or `/Change /DISABLE`).

  **If a task registered before the frontend/backend/local-agent reorg still points at the old path** (check via the `schtasks /Query` command above — its "Task To Run" line will show the old `C:\PULSEE~1\server\START-~1.CMD`, missing the `LOCAL-~1` segment), delete and recreate it from an elevated terminal — using the hidden-launch `/TR` form from "Running everything completely hidden" below, not the bare `.cmd` path shown here, which is now obsolete on any machine that's already been updated:
  ```
  schtasks /Delete /TN PulseEndpointTelemetryServer /F
  schtasks /Create /TN PulseEndpointTelemetryServer /TR "wscript.exe C:\PULSEE~1\LOCAL-~1\scripts\RUN-HI~1.VBS C:\PULSEE~1\LOCAL-~1\server\START-~1.CMD" /SC ONLOGON /RL HIGHEST
  ```
  This can't be done from inside the repo — it's a real, one-time step on whichever machine actually has the task registered, the same category as LibreHardwareMonitor/HWiNFO's manual setup steps above.

  #### How the frontend auto-start works

  `npm run dev:all` (above) is a **development** command — hot-reload, source maps, and a dev server that recompiles on every file change. That's the right tool while actively working on the code, but not something a real auto-starting product should run forever in the background. For that, `frontend/start-frontend.cmd` instead serves the actual production build:

  ```
  npm run build     # produces frontend/dist/ — rebuild after any code change
  npm run preview   # vite preview --port 5173 --strictPort — serves dist/, no hot-reload
  ```

  `vite preview` (built into Vite, no extra dependency needed) was used instead of adding a separate static-file-server package — confirmed directly it serves `dist/` on the same port (`5173`) the dev server uses, over plain HTTP, with no behavior differences relevant here other than the obvious one: no hot-reload, no `@vite/client` script, no source maps — all expected and correct for this use case. Everything the app fetches at runtime (the telemetry server at `http://localhost:4317`, the backend at `http://localhost:8443`) is a direct browser-side `fetch()` call baked into the built JS bundle, not something the frontend's own server proxies — so which static server serves the HTML/JS/CSS has no bearing on whether the app can reach either of them.

  A Scheduled Task named `PulseEndpointFrontend` runs `frontend/start-frontend.cmd` at logon, same `cd /d`-then-invoke pattern as the other two launchers — **without** `/RL HIGHEST`: serving static files needs no elevation, only the telemetry server does (TPM/BitLocker access). It's now registered via the hidden-launch wrapper (see "Running everything completely hidden" below):

  ```
  schtasks /Create /TN PulseEndpointFrontend /TR "wscript.exe C:\PULSEE~1\LOCAL-~1\scripts\RUN-HI~1.VBS C:\PULSEE~1\frontend\START-~1.CMD" /SC ONLOGON
  ```

  To remove or disable it later: `schtasks /Delete /TN PulseEndpointFrontend /F` (or `/Change /DISABLE`).

  One thing worth confirming rather than assuming: `backend/start-command-center.cmd` had a real bug where cmd.exe, launched non-interactively (as a Scheduled Task does), wouldn't resolve a bare executable name sitting in the working directory it had just `cd /d`'d into — only an explicit `.\` prefix worked. `npm` isn't in `frontend/`'s working directory, though — it resolves via `PATH` (wherever Node.js is installed), which is a different lookup mechanism entirely. Tested this directly by launching `start-frontend.cmd` non-interactively via `Start-Process` (the same mechanism a Scheduled Task uses) rather than assuming PATH resolution "should" behave the same as the interactive case: it worked without any `.\`-style fix.

  **What happens to `ensure-telemetry-running.mjs` now that the telemetry server has its own independent Scheduled Task?** `start-frontend.cmd` deliberately does **not** call it, and `ensure-telemetry-running.mjs` itself is unchanged — it still only runs as part of `dev:all`. Two reasons it would be wrong to wire into the frontend's own unattended auto-start:
  - Its telemetry fallback launches an elevated process via `Start-Process -Verb RunAs`, which pops a real UAC consent dialog. That's fine in `dev:all` because a human is sitting there to click it — it's actively wrong for an unattended Scheduled Task at logon, where nobody is present to approve it.
  - Its console output (the `⚠ Remember to click Options → Remote Web Server → Run...` reminder, and the "already running" / "launching it" status lines) is only ever useful if a human can see it. `start-frontend.cmd` has no visible window, so anything it printed there would never be read by anyone.

  `ensure-telemetry-running.mjs`'s actual job — being the fallback for "the telemetry Scheduled Task didn't come up (not registered yet, disabled, or this machine hasn't been logged into since it was registered)" — now belongs entirely to `PulseEndpointTelemetryServer`'s own Scheduled Task and its `LogonType=InteractiveToken` behavior, not to whatever happens to run after it. If the telemetry server genuinely isn't up when the frontend starts, the dashboard just shows its existing, honest sample-tagged fallback values until it is — the same graceful degradation that already exists for every other real-data source in this app — rather than the frontend trying to fix that on telemetry's behalf.

  LibreHardwareMonitor's own launch was also bundled into `ensure-telemetry-running.mjs`, purely as a `dev:all` convenience — but it now additionally has its own independent Scheduled Task, `PulseEndpointLibreHardwareMonitor` (see "How LibreHardwareMonitor's auto-start works" below), so running all four Scheduled Tasks together does start LibreHardwareMonitor for you. Its Remote Web Server toggle itself still has no CLI/config-file automation and remains a real manual step the first time you ever enable it on a machine (documented above) — but once enabled, it persists across restarts and auto-resumes on every subsequent launch, including this Scheduled Task's, without needing to be clicked again (verified directly — see below).

  #### How LibreHardwareMonitor's auto-start works

  A Scheduled Task named `PulseEndpointLibreHardwareMonitor` runs `LibreHardwareMonitor.exe` directly at logon (no wrapper `.cmd` needed — there's no working directory or env var setup required, just the `.exe`), with `/RL HIGHEST` and `LogonType=InteractiveToken`, the same pattern as the telemetry server's task:

  ```
  schtasks /Create /TN PulseEndpointLibreHardwareMonitor /TR "wscript.exe C:\PULSEE~1\LOCAL-~1\scripts\RUN-HI~1.VBS C:\PROGRA~1\LIBREH~1\LIBREH~1.EXE" /SC ONLOGON /RL HIGHEST
  ```

  To remove or disable it later: `schtasks /Delete /TN PulseEndpointLibreHardwareMonitor /F` (or `/Change /DISABLE`).

  #### Running everything completely hidden (no visible windows)

  The four Scheduled Tasks above, plus `PulseEndpointAiService` (see its own section below) - five in total - are wrapped through a small generic launcher, `local-agent/scripts/run-hidden.vbs`:

  ```vbs
  Set objShell = CreateObject("WScript.Shell")
  objShell.Run """" & WScript.Arguments(0) & """", 0, False
  ```

  This is the standard Windows trick for launching any process with no visible window — `WshShell.Run`'s second argument (`0`) is the window style (`SW_HIDE`). The third argument is now `True` (wait for the child to exit) — it was originally `False` (return immediately, don't linger as its own process), which kept the window hidden just as well but meant `wscript.exe` reported the task as "completed successfully" within milliseconds of every logon and never looked at the real long-running process again. That silently broke real crash recovery: each task's `RestartCount`/`RestartInterval` settings (added later, see below) can only restart a task Task Scheduler still considers "running" — with `False`, a crash of the *real* process (node/command-center.exe/LibreHardwareMonitor.exe) was invisible to Task Scheduler, since the thing it was actually watching (`wscript.exe`) had already exited successfully and detached. `True` makes `wscript.exe`'s own lifetime track the real process's lifetime — hidden the whole time either way, since that's controlled by the window-style argument, not this one. The script also now captures `WshShell.Run`'s return value (the real target's exit code) and propagates it via `WScript.Quit` — without this, `wscript.exe` still exits `0` (its own default) regardless of how the real process died, and Task Scheduler's restart-on-failure only triggers on a non-zero exit code, so this was just as load-bearing as the wait fix itself; both were confirmed necessary by testing a real kill and watching it fail to recover before either fix, then again after only the wait fix, before both together actually worked. Each task's `/TR` now points at `wscript.exe` running this script with the *real* target (a `.cmd` file or an `.exe`) as its argument, instead of pointing at that target directly — e.g. `PulseEndpointCommandCenter`'s `/TR` is now `wscript.exe C:\PULSEE~1\LOCAL-~1\scripts\RUN-HI~1.VBS C:\PULSEE~1\backend\START-~1.CMD` rather than the bare `.cmd` path. The vbs script's own path also has to be the Windows short (8.3) form (`RUN-HI~1.VBS`) for the same reason every other launcher path in this project does — `schtasks /Create /TR` can't store a path containing a space, and "Pulse endpoint" has one.

  #### Real crash recovery (RestartCount/RestartInterval)

  All five of `PulseEndpointTelemetryServer`, `PulseEndpointCommandCenter`, `PulseEndpointLibreHardwareMonitor`, `PulseEndpointDesktopApp` (the Tauri desktop app's own task, see below), and `PulseEndpointAiService` (see its own section below) are configured with real restart-on-failure via PowerShell's `ScheduledTasks` module (the classic `schtasks /Create` syntax has no flag for this):

  ```powershell
  $settings = New-ScheduledTaskSettingsSet -RestartCount 15 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Set-ScheduledTask -TaskName <name> -Settings $settings   # Action/Trigger/Principal passed through unchanged
  ```

  - **1-minute retry interval, up to 15 attempts** (15 minutes of retrying total) — fast enough that a real transient failure (a brief resource hiccup, a momentary WMI stall) recovers quickly, but bounded so a genuinely broken process (missing dependency, corrupted install) doesn't retry forever and spam the Task Scheduler history/event log indefinitely.
  - **`ExecutionTimeLimit` set to unlimited (`PT0S`)**, not the default 72 hours — without this, Task Scheduler forcibly ends the whole logical task run (and stops honoring RestartCount) once 72 hours have elapsed since the logon trigger fired, silently disabling crash recovery for any machine left on longer than 3 days.
  - **`AllowStartIfOnBatteries` / `DontStopIfGoingOnBatteries`** — the default settings on these tasks (`DisallowStartIfOnBatteries`/`StopIfGoingOnBatteries` both `True`) would otherwise kill and refuse to restart every one of these background processes the moment this laptop switches off AC power, which defeats the entire point of "real" crash recovery on a machine that isn't always plugged in.
  - This restart mechanism **only works because of the `run-hidden.vbs` wait fix above** — Task Scheduler can only restart a task whose action process it's still tracking as running.

  #### The Tauri desktop app's own crash recovery (`PulseEndpointDesktopApp`)

  The desktop app (`app.exe`) used to launch only via `tauri-plugin-autostart`'s registry Run key (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Pulse Endpoint agent`) — logon-only, no restart-on-failure, since Windows has no built-in "restart this Run-key app if it crashes" behavior. It's now launched by its own Scheduled Task, `PulseEndpointDesktopApp` (`RunLevel Limited`, `LogonType Interactive`, same `RestartCount`/`RestartInterval` settings as above), and the Run key has been removed so the two mechanisms can't both fire at logon and launch two instances. This was chosen over a custom watchdog process specifically because `LibreHardwareMonitor` already proves a real interactive GUI app runs fine from a Scheduled Task with `LogonType Interactive` — reusing the same native, already-battle-tested mechanism for all four processes is simpler and more reliable than introducing new code (a watchdog) whose only job is to reimplement what Task Scheduler already does natively.

  **Resolved:** the separate "Launch on Startup (Desktop App)" toggle (and `tauri-plugin-autostart` itself, along with `useTauriAutostart.ts`) has since been removed entirely - there was no legitimate reason to expose a way to disable the desktop app's auto-start once `PulseEndpointDesktopApp` became the real mechanism. Settings' single "Launch on Startup" toggle now folds this task's real `Enabled` state into the same read-only six-task aggregate the others already use (see `SCHEDULED_TASK_NAMES` in `telemetry-server.mjs`), rather than keeping a competing, independently-toggleable control that could recreate the Run key it replaced.

  #### ai-service's own auto-start and crash recovery (`PulseEndpointAiService`)

  `ai-service/` (the Python/Flask prediction service behind AI Intel's SSD/Battery Remaining Life cards) used to have no auto-start and no crash recovery at all - it had to be started by hand (`ai-service\venv\Scripts\python.exe app.py`), which meant `data.predictions` stayed `null` (and the frontend correctly showed an honest "Unknown", never a fabricated day-count) on any machine where nobody had done that since the last logon. It now has its own Scheduled Task, `PulseEndpointAiService`, registered exactly like `PulseEndpointCommandCenter` - `RunLevel Limited` (unelevated - confirmed it only makes outbound HTTP calls to `backend/`, forwarding the caller's own bearer token, so it needs no WMI/TPM/BitLocker access the way the telemetry server does), `LogonType Interactive`, wrapped through the same `run-hidden.vbs` (wait-for-exit, hidden window) as the other background processes, with the same real `RestartCount 15` / `RestartInterval 1 minute` / unlimited `ExecutionTimeLimit` / battery-tolerant settings:

  ```
  schtasks /Create /TN PulseEndpointAiService /TR "wscript.exe C:\PULSEE~1\LOCAL-~1\scripts\RUN-HI~1.VBS C:\PULSEE~1\AI-SER~1\START-~1.CMD" /SC ONLOGON /RL LIMITED
  ```

  `ai-service/start-ai-service.cmd` follows the same `cd /d`-then-invoke pattern as the other launchers, running the service with its own venv's `python.exe` (not a bare `python` on PATH, and not `flask run` - `app.py` calls `app.run()` itself) - confirmed directly this is the real command that already starts the service correctly (`/health` returns `{"status":"ok"}` on `127.0.0.1:8001`).

  It's also added to `local-agent/scripts/watchdog.ps1`'s monitored target list, matched by its listening port (`8001`), same reasoning as `PulseEndpointTelemetryServer`/`PulseEndpointCommandCenter` above - a listening port confirms the service is actually reachable, not just that some `python.exe` with a matching path exists. Tested for real: killed the running `python.exe`, and the watchdog's own next scheduled tick (it runs every 1 minute) detected the miss and relaunched it via `Start-ScheduledTask` within seconds - confirmed in `watchdog.log`, not assumed.

  This was verified directly, not assumed, for both kinds of app this project auto-starts:
  - **Console apps** (`node`, `npm`) — confirmed a test batch script launched this way runs to completion (its output file gets written) with no visible console window.
  - **A WinForms GUI app** (LibreHardwareMonitor) — confirmed its main window has no visible handle after a hidden launch (`MainWindowHandle` is `0`), and — the actual thing worth doubting rather than assuming — that its **Remote Web Server still comes up on its own**, without a fresh manual click, even though it's now hidden from the moment it starts. This works because "Remote Web Server: Run" is a setting LibreHardwareMonitor persists into its own `.config` file and re-applies at every startup regardless of window visibility, not something that depends on the window ever being shown.

  One real, non-obvious thing found while confirming that: LibreHardwareMonitor writes to **two different config files** depending on how it's launched. Invoking it by its long path (e.g. double-clicking it from Explorer or a Start Menu shortcut) reads/writes `LibreHardwareMonitor.config`; invoking it by the Windows short (8.3) path — which is what this project's Scheduled Task has always used, and still uses — reads/writes a separate `LIBREH~1.config` instead. .NET derives the settings file name from the literal invoked executable name, short-path-vs-long-path included. Both happened to already have `runWebServerMenuItem=true` saved on this machine, so the Remote Web Server came back up immediately either way — but if you ever manually toggle this setting while running LibreHardwareMonitor by its long/Start-Menu path, that change goes to `LibreHardwareMonitor.config`, not the one this Scheduled Task's short-path launch actually reads. Toggle it while it's running as the Scheduled Task does (or edit `LIBREH~1.config` directly) if you want the change to actually take effect there.

  **On checking on it later, since its window is now hidden:** LibreHardwareMonitor does register a system tray icon at the OS level regardless of window visibility — confirmed via Windows' own persisted icon registry (`HKCU\Control Panel\NotifyIconSettings`), which has an entry recording `LibreHardwareMonitor.exe` as a registered notification-area icon. What this project could **not** conclusively confirm through automation is whether that icon actually *renders* in the visible tray vs. the collapsed "hidden icons" overflow on this specific Windows 11 build — its modernized taskbar no longer exposes the classic `Shell_TrayWnd\TrayNotifyWnd\SysPager\ToolbarWindow32` window chain that tools (and scripts) have traditionally used to enumerate tray icons, so both a UI Automation scan and a direct Win32 toolbar-button-count came back empty despite the icon registration existing. If you ever need to interact with LibreHardwareMonitor (adjust a sensor setting, look at a graph) rather than just read its Remote Web Server output, glance at your tray's overflow ("^") area first — if it's genuinely not there, the reliable fallback is unchanged: kill the hidden instance and relaunch `C:\Program Files\LibreHardwareMonitor\LibreHardwareMonitor.exe` directly (no wrapper) to get a normal visible window back.

  One more thing worth knowing if you ever need to re-point one of these tasks yourself: `schtasks /Change /TN <name> /TR "..."` reliably prompts for a run-as password interactively even though nothing about `/TR` alone should need one, and that prompt can hang forever in a non-interactive context with no console attached to answer it. `schtasks /Delete /TN <name> /F` followed by a fresh `schtasks /Create` with the same `/SC`/`/RL` flags (as shown for each task above) reliably avoids this — that's the delete-and-recreate pattern used throughout this section, not `/Change`.

  ### Running the pieces separately

  If you want to restart or debug one piece independently, run each in its own terminal instead of `dev:all`:

  ```
  node local-agent/server/telemetry-server.mjs   # from the repo root, or `node telemetry-server.mjs` from inside local-agent/server/
  npm run dev                                     # from inside frontend/
  ```

  `dev:all` no longer starts its own `telemetry-server.mjs` directly — it only runs `ensure-telemetry-running.mjs` (which starts one *if none is already running*) followed by Vite. This avoids two processes fighting over port 4317. Run `telemetry-server.mjs` by hand only if you're debugging it directly; it needs an elevated terminal, same as always.

  ### Resilience note for telemetry-derived fields

  Every value derived from `useTelemetry()` data — not just the raw fields — must check `connected` before rendering as real. A derived/computed field that skips this check will keep showing stale real-looking data after the telemetry server disconnects, even though its sibling fields correctly revert to fallback values. This bug was found once in `BatteryCard`'s status/health labels and fixed — check for this pattern whenever adding a new derived field.
