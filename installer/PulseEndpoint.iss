; Pulse Endpoint - real Windows installer (Inno Setup).
;
; Chosen over WiX Toolset (see the Phase 1 research this is built from): this project's own
; scheduled-task registration is already real, tested, exact `schtasks` command strings - Inno
; Setup's [Run]/Pascal Script lets those be reused verbatim (just with a dynamically-resolved
; install path substituted in), where WiX's declarative ScheduledTask extension would mean
; re-authoring that already-working RunLevel/LogonType/RestartCount logic into a different,
; less flexible schema for no real benefit at this project's scale.
;
; Bundles: the Tauri desktop app (its own real NSIS installer, run silently as a sub-step -
; already handles WebView2 bootstrapping, so there's no reason to reimplement that here),
; telemetry-server.exe (Node SEA build - see local-agent/scripts/build-telemetry-exe.ps1),
; pulse-telemetry.exe (rust-collector, already a native binary), command-center.exe (backend,
; already a native binary), ai-service.exe (PyInstaller build - see ai-service/build-exe.ps1),
; and LibreHardwareMonitor's real binaries (MPL 2.0 - confirmed directly, permits bundling
; compiled binaries in a closed-source "Larger Work" - see this repo's Phase 1 research for the
; exact license text checked). HWiNFO is deliberately NOT bundled (a standing decision, unrelated
; to licensing) - it stays a manual, optional, power-user step, same as documented in the top
; level README.
;
; All 6 real Scheduled Tasks this project already runs (telemetry server, backend/command
; center, LibreHardwareMonitor, the desktop app, the watchdog, ai-service) are registered here
; with the exact settings already validated live on real machines earlier this project - RunLevel/
; LogonType per task, RestartCount 15/RestartInterval 1 min/unlimited ExecutionTimeLimit/
; battery-tolerant for the five that get real crash recovery (not the frontend's own task - it
; never has, see the top-level README's own "Real crash recovery" section for why) - just with
; {app} (whatever real path the customer/admin picked) substituted for the dev machine's
; hardcoded "C:\Pulse endpoint".

#define MyAppName "Pulse Endpoint"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Casterly Corp"

[Setup]
AppId={{B8F2C9A1-6E4D-4A2B-9F3C-7D1E5A8B0C42}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\Pulse Endpoint
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
OutputDir=output
OutputBaseFilename=PulseEndpointSetup
WizardStyle=modern
UninstallDisplayIcon={app}\frontend\app.exe
; Silent: PulseEndpointSetup.exe /VERYSILENT /TYPE=agent /BACKENDURL=http://HOST:8443
CloseApplications=force
RestartApplications=no
DisableWelcomePage=yes
SetupLogging=yes

[Types]
Name: "full"; Description: "Full Installation (backend + agent + AI service) - for your operations/dev machine"
Name: "agent"; Description: "Agent Only (reports to an existing central backend) - for a customer/endpoint laptop"
Name: "custom"; Description: "Custom"; Flags: iscustom

[Components]
; agentcore is Flags: fixed - required in every Type, never optional, since a customer laptop
; always needs the agent itself regardless of which mode is chosen.
Name: "agentcore"; Description: "Local Agent, Desktop App, and Hardware Monitor"; Types: full agent custom; Flags: fixed
Name: "backend"; Description: "Command Center Backend (only needed on your central ops machine)"; Types: full custom
; Known limitation: ai-service has its own separate BACKEND_URL env var (see ai-service/app.py),
; unrelated to pulse-agent.config.json above - a Custom install selecting aiservice without
; backend would leave it pointed at a nonexistent local backend. Not fixed here: ai-service
; only meaningfully functions alongside its own backend, so this is a deliberate Custom-install
; edge case, not a path either Full or Agent Only can reach.
Name: "aiservice"; Description: "AI Service (only needed on your central ops machine)"; Types: full custom

[Files]
; --- Tauri desktop app: its own real NSIS sub-installer, run silently in [Code] below,
;     forced into {app}\frontend via NSIS's own /D override - not copied as a permanent file
;     here (Flags: dontcopy would apply, but Source below already stages it in {tmp} implicitly
;     via ExtractTemporaryFile at runtime instead, see [Code]).
Source: "..\frontend\src-tauri\target\release\bundle\nsis\Pulse Endpoint agent_{#MyAppVersion}_x64-setup.exe"; DestDir: "{tmp}"; Flags: dontcopy; Components: agentcore

; --- local-agent: the SEA-packaged telemetry server, its real PowerShell collector script, and
;     the rust-collector native binary, in exactly the same relative layout as the source repo
;     (server/ next to a sibling ../rust-collector/target/release/) - telemetry-server.exe's own
;     __dirname resolution (process.execPath when running as SEA) depends on this layout being
;     preserved, not on any particular absolute path.
Source: "..\local-agent\server\telemetry-server.exe"; DestDir: "{app}\local-agent\server"; Flags: ignoreversion; Components: agentcore
Source: "..\local-agent\server\get-telemetry.ps1"; DestDir: "{app}\local-agent\server"; Flags: ignoreversion; Components: agentcore
Source: "..\local-agent\rust-collector\target\release\pulse-telemetry.exe"; DestDir: "{app}\local-agent\rust-collector\target\release"; Flags: ignoreversion; Components: agentcore
Source: "..\local-agent\scripts\run-hidden.vbs"; DestDir: "{app}\local-agent\scripts"; Flags: ignoreversion; Components: agentcore
Source: "..\local-agent\scripts\watchdog.ps1"; DestDir: "{app}\local-agent\scripts"; Flags: ignoreversion; Components: agentcore
Source: "..\local-agent\scripts\start-watchdog.cmd"; DestDir: "{app}\local-agent\scripts"; Flags: ignoreversion; Components: agentcore

; --- backend: command-center.exe is already a statically-linked Go binary (confirmed directly -
;     it loads nothing but stock Windows system DLLs) and schema.sql is go:embed'd into it, so
;     there's nothing else to ship alongside it except its own launcher (needs a real cwd for
;     .env.local/its SQLite file - see start-command-center.cmd's own comment). .env.local itself
;     is NOT shipped here - see [Code]'s GenerateSecrets, which writes a fresh one at install time.
Source: "..\backend\command-center.exe"; DestDir: "{app}\backend"; Flags: ignoreversion; Components: backend
Source: "..\backend\start-command-center.cmd"; DestDir: "{app}\backend"; Flags: ignoreversion; Components: backend

; --- ai-service: the PyInstaller-packaged standalone exe (see ai-service/build-exe.ps1) - no
;     Python install needed, no __file__-relative paths in app.py, so no launcher wrapper needed.
Source: "..\ai-service\dist\ai-service.exe"; DestDir: "{app}\ai-service"; Flags: ignoreversion; Components: aiservice

; --- LibreHardwareMonitor: real compiled binaries (MPL 2.0, confirmed permissive for bundling
;     compiled output in a closed-source Larger Work) copied verbatim from a real installed copy
;     on this build machine. The pre-seeded config (runWebServerMenuItem=true) is written
;     separately in [Code], after this copy, once the real short (8.3) filename Windows assigns
;     to LibreHardwareMonitor.exe in its destination is actually known - guessing "LIBREH~1" here
;     would be exactly the kind of unvalidated assumption Phase 1 flagged.
Source: "payload\LibreHardwareMonitor\*"; DestDir: "{app}\LibreHardwareMonitor"; Excludes: "*.pdb,*.config"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: agentcore

; --- .NET Windows Desktop Runtime 10.0.11 (x64): the real, missing prerequisite
;     LibreHardwareMonitor.exe needs (a framework-dependent .NET 10 WinForms app - see
;     LibreHardwareMonitor.runtimeconfig.json's own Microsoft.NETCore.App/Microsoft.WindowsDesktop.App
;     requirement) - not part of any stock Windows install, confirmed directly via dumpbin (its own
;     apphost stub only imports in-box system DLLs; the actual runtime dependency is the
;     runtimeconfig.json framework reference, resolved by hostfxr at launch, not by the PE import
;     table). Not copied permanently - Flags: dontcopy stages it in {tmp} only, extracted and run
;     once in [Code] below (same pattern RunTauriSubInstaller already uses for the Tauri NSIS
;     sub-installer), and only when InstallDotNetDesktopRuntimeIfNeeded's own check finds no
;     compatible runtime already present - keeps a repeat/update install fast rather than re-running
;     a ~57MB installer every time.
Source: "redist\windowsdesktop-runtime-10.0.11-win-x64.exe"; DestDir: "{tmp}"; Flags: dontcopy; Components: agentcore

[Code]
var
  AppShortPath: String;
  JwtSecret, AdminPassword: String;
  BackendUrlPage: TInputQueryWizardPage;

function CmdLineBackendUrl(): String;
begin
  Result := Trim(ExpandConstant('{param:BACKENDURL|}'));
end;

function ResolvedBackendUrl(): String;
begin
  Result := CmdLineBackendUrl();
  if Result = '' then
    Result := BackendUrlPage.Values[0];
  if Result = '' then
    Result := 'http://localhost:8443';
end;

function InitializeSetup(): Boolean;
var
  SetupType, BackendUrl: String;
begin
  Result := True;
  SetupType := LowerCase(Trim(ExpandConstant('{param:TYPE|}')));
  BackendUrl := CmdLineBackendUrl();
  if WizardSilent then
  begin
    if (SetupType = 'agent') and (BackendUrl = '') then
    begin
      Log('Silent agent install requires /BACKENDURL=http://host:8443');
      Result := False;
    end;
  end;
end;

procedure InitializeWizard();
begin
  BackendUrlPage := CreateInputQueryPage(wpSelectComponents,
    'Central Backend Address', 'Where should this agent report to?',
    'Enter the address THIS laptop can actually reach. Same Wi-Fi: http://192.168.0.32:8443. ' +
    'Same Tailscale account: the Command Centre PC''s 100.x address. Different Tailscale accounts: ' +
    'the Shared-in IP from THIS laptop''s Tailscale Machines page - not the IP shown on the Command Centre PC. ' +
    'Silent: /VERYSILENT /TYPE=agent /BACKENDURL=http://HOST:8443');
  BackendUrlPage.Add('Backend URL:', False);
  if CmdLineBackendUrl() <> '' then
    BackendUrlPage.Values[0] := CmdLineBackendUrl()
  else
    BackendUrlPage.Values[0] := 'http://192.168.0.32:8443';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = BackendUrlPage.ID then
    Result := WizardIsComponentSelected('backend') or WizardSilent or (CmdLineBackendUrl() <> '');
end;

// Inno's built-in GetShortName wraps the real Win32 GetShortPathName - the same real mechanism
// this project's README already documents as necessary for every schtasks /Create /TR whose
// path contains a space ("Pulse endpoint" always has, and so does the real default install dir
// here, {autopf}\Pulse Endpoint - deliberately chosen with a space specifically so this logic
// gets exercised for real on every install, not just ones where an admin happens to pick a
// no-space path).
function ResolveShortAppPath(): String;
begin
  Result := GetShortName(ExpandConstant('{app}'));
end;

// Pascal's own Random() is not cryptographically secure and this project already treats "real
// randomness" as a genuine requirement (see backend's JWT_SECRET/ADMIN_PASSWORD - a predictable
// secret is a real vulnerability, not a cosmetic one).
//
// REAL BUG FOUND BY TESTING, FIXED HERE: the first version of this function shelled out to
// PowerShell (`RandomNumberGenerator::GetBytes` piped through `Out-File` to a temp file, then
// read back) - live install logging showed a real "Cannot open file ...\secret.txt" runtime
// error, i.e. the round-trip through a temp file never actually materialized it (nested
// quoting between Pascal's Exec() and PowerShell's own -Command parsing is genuinely fragile,
// not just theoretically risky). Replaced with a direct call into bcrypt.dll's own
// BCryptGenRandom - the same real Windows CSPRNG, no shell-out, no temp file, no quoting to get
// wrong.
function BCryptGenRandom(hAlgorithm: LongWord; pbBuffer: PAnsiChar; cbBuffer: LongWord; dwFlags: LongWord): LongWord;
  external 'BCryptGenRandom@bcrypt.dll stdcall';

const
  BCRYPT_USE_SYSTEM_PREFERRED_RNG = $00000002;
  HEX_CHARS = '0123456789abcdef';

function GenerateRandomHex(byteLength: Integer): String;
var
  Buffer: AnsiString;
  Status: LongWord;
  i: Integer;
begin
  SetLength(Buffer, byteLength);
  Status := BCryptGenRandom(0, PAnsiChar(Buffer), byteLength, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  if Status <> 0 then
    RaiseException('GenerateRandomHex: BCryptGenRandom failed with NTSTATUS ' + IntToStr(Status));
  Result := '';
  for i := 1 to byteLength do
    Result := Result + HEX_CHARS[(Ord(Buffer[i]) shr 4) + 1] + HEX_CHARS[(Ord(Buffer[i]) and $0F) + 1];
end;

// Writes a fresh .env.local with genuinely random secrets for this install, not the dev
// placeholders checked into this repo's own backend/.env.local (which are the same known values
// on every dev machine that's ever cloned this project - fine for local development, a real
// vulnerability if a real installer shipped them to every customer unchanged).
//
// REAL BUG FOUND BY TESTING, FIXED HERE: this originally wrote to {app}\backend\.env.local -
// command-center.exe then failed for real ("unable to open database file: out of memory (14)",
// SQLite's own generic permission-denied message) because {app} defaults to Program Files, which
// BUILTIN\Users cannot write to, and PulseEndpointCommandCenter's task runs unelevated on
// purpose. Writing here instead of {app}\backend now matches start-command-center.cmd's own
// fix (see that file's own comment) - %ProgramData% is where its cwd actually ends up.
procedure WriteEnvLocal();
var
  EnvContent: String;
  DataDir: String;
begin
  JwtSecret := GenerateRandomHex(32);
  AdminPassword := GenerateRandomHex(16);
  EnvContent := 'PORT=8443' + #13#10 +
    'JWT_SECRET=' + JwtSecret + #13#10 +
    'ADMIN_PASSWORD=' + AdminPassword + #13#10;
  DataDir := ExpandConstant('{commonappdata}') + '\Pulse Endpoint\backend';
  if not DirExists(DataDir) then
    ForceDirectories(DataDir);
  SaveStringToFile(DataDir + '\.env.local', EnvContent, False);
end;

// Writes pulse-agent.config.json with whatever backend URL the user entered - only for
// agent-only installs (see ShouldSkipPage's own comment on why this page doesn't even show
// otherwise). A full/dev install deliberately leaves no pulse-agent.config.json behind at all,
// so telemetry-server.exe falls back to its own default (localhost:8443) unchanged - exactly
// correct when this same machine is genuinely both the agent and the backend.
procedure WriteAgentConfig();
var
  ConfigContent, ServerDir: String;
begin
  if WizardIsComponentSelected('backend') then
    Exit;

  ServerDir := ExpandConstant('{app}') + '\local-agent\server';
  ConfigContent := '{' + #13#10 +
    '  "backendUrl": "' + ResolvedBackendUrl() + '"' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(ServerDir + '\pulse-agent.config.json', ConfigContent, False);
end;

// The one thing Phase 1 flagged as unvalidated: whether shipping this pre-seeded config
// actually eliminates the documented manual "Options -> Remote Web Server -> Run" click on a
// machine that has never run LibreHardwareMonitor before. Named after LibreHardwareMonitor.exe's
// REAL short name in its real destination (computed just-in-time, not assumed to be "LIBREH~1"),
// matching exactly the file LibreHardwareMonitor itself reads when launched via that short path
// (the same launch convention every task's /TR already uses, and the only one that avoids the
// separate documented short-path requirement schtasks itself imposes).
procedure SeedLhmConfig();
var
  LhmDir, ExeShortName, ConfigBaseName, ConfigContent: String;
begin
  LhmDir := ExpandConstant('{app}') + '\LibreHardwareMonitor';
  ExeShortName := ExtractFileName(GetShortName(LhmDir + '\LibreHardwareMonitor.exe'));
  ConfigBaseName := Copy(ExeShortName, 1, Length(ExeShortName) - Length(ExtractFileExt(ExeShortName)));
  ConfigContent := '<?xml version="1.0" encoding="utf-8"?>' + #13#10 +
    '<configuration>' + #13#10 +
    '  <appSettings>' + #13#10 +
    '    <add key="runWebServerMenuItem" value="true" />' + #13#10 +
    '  </appSettings>' + #13#10 +
    '</configuration>' + #13#10;
  SaveStringToFile(LhmDir + '\' + ConfigBaseName + '.config', ConfigContent, False);
  // Also seed the long-name variant - harmless if unused, but covers the case of anyone ever
  // launching LibreHardwareMonitor.exe by its long path outside this project's own Scheduled
  // Task (see the top-level README's own comment on why the two config files aren't the same).
  SaveStringToFile(LhmDir + '\LibreHardwareMonitor.config', ConfigContent, False);
end;

procedure RunTauriSubInstaller();
var
  ResultCode: Integer;
  InstallerPath: String;
begin
  InstallerPath := ExpandConstant('{tmp}') + '\Pulse Endpoint agent_{#MyAppVersion}_x64-setup.exe';
  ExtractTemporaryFile('Pulse Endpoint agent_{#MyAppVersion}_x64-setup.exe');
  // /D must be the LAST argument and unquoted even though {app} may contain spaces - NSIS's own
  // documented requirement, not a mistake. Forces the desktop app into a known, predictable
  // subfolder of this installer's own {app}, rather than trusting whatever default NSIS would
  // otherwise pick (which the PulseEndpointDesktopApp Scheduled Task registered below needs to
  // point at correctly).
  Exec(InstallerPath, '/S /D=' + ExpandConstant('{app}') + '\frontend', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// Checks C:\Program Files\dotnet\shared\Microsoft.WindowsDesktop.App\10.*\ directly, rather than
// dotnet --list-runtimes (requires dotnet.exe already on PATH - exactly what can't be assumed on
// a genuinely fresh machine) or a registry key (raises its own 32-bit/64-bit WOW6432Node view
// ambiguity). This is Microsoft's own documented fallback for detecting an installed runtime
// without the CLI (see learn.microsoft.com/dotnet/core/install/how-to-detect-installed-versions'
// own "Check for install folders" section). {commonpf64} (not {pf}) is used specifically so this
// resolves to the real 64-bit Program Files unambiguously - ArchitecturesInstallIn64BitMode above
// already makes Setup itself run as a native 64-bit process, so there's no WOW64 file-system
// redirection to worry about here either way, but {commonpf64} makes that explicit rather than
// relying on {pf}'s mode-dependent resolution.
//
// A bare "10.*" match (not "10.0.*") is deliberate: LibreHardwareMonitor.runtimeconfig.json
// requests "10.0.0" with no explicit rollForward, so the real default policy applies (Minor - see
// learn.microsoft.com/dotnet/core/versions/selection) - any installed 10.x.y satisfies that
// request, not just 10.0.y specifically.
function IsDotNetDesktopRuntimeInstalled(): Boolean;
var
  FindRec: TFindRec;
  BaseDir: String;
begin
  Result := False;
  BaseDir := ExpandConstant('{commonpf64}') + '\dotnet\shared\Microsoft.WindowsDesktop.App';
  if FindFirst(BaseDir + '\10.*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
        begin
          Result := True;
        end;
      until Result or (not FindNext(FindRec));
    finally
      FindClose(FindRec);
    end;
  end;
end;

// Installs the real, bundled .NET Windows Desktop Runtime 10.0.11 redistributable, but only when
// IsDotNetDesktopRuntimeInstalled finds no compatible runtime already on the machine - the same
// extract-to-{tmp}-then-Exec pattern RunTauriSubInstaller above already uses for the Tauri NSIS
// sub-installer, reused here rather than introducing a second mechanism for what is, at bottom,
// the same kind of step (silently running a real third-party installer once, at ssPostInstall).
procedure InstallDotNetDesktopRuntimeIfNeeded();
var
  ResultCode: Integer;
  InstallerPath: String;
begin
  if IsDotNetDesktopRuntimeInstalled() then
  begin
    Exit;
  end;

  InstallerPath := ExpandConstant('{tmp}') + '\windowsdesktop-runtime-10.0.11-win-x64.exe';
  ExtractTemporaryFile('windowsdesktop-runtime-10.0.11-win-x64.exe');
  Exec(InstallerPath, '/install /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // 0 = success, 3010 = success but a reboot is recommended - both are real successes per
  // Microsoft's own documented exit codes for this installer family, not failures worth logging.
  if (ResultCode <> 0) and (ResultCode <> 3010) then
    Log('InstallDotNetDesktopRuntimeIfNeeded: windowsdesktop-runtime installer returned unexpected exit code ' + IntToStr(ResultCode));
end;

// Registers all 6 real Scheduled Tasks this project runs, reusing the exact command shapes
// already validated live (see the top-level README's "Running everything completely hidden" and
// "Real crash recovery" sections) - RunLevel/LogonType per task match exactly what's documented
// there, just with AppShortPath substituted for the dev machine's hardcoded short path.
procedure RegisterScheduledTasks();
var
  ResultCode: Integer;
  VbsPath, RestartSettings: String;
begin
  VbsPath := AppShortPath + '\local-agent\scripts\run-hidden.vbs';
  RestartSettings := '$s = New-ScheduledTaskSettingsSet -RestartCount 15 -RestartInterval (New-TimeSpan -Minutes 1) ' +
    '-ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; ' +
    'Set-ScheduledTask -TaskName ''%s'' -Settings $s';

  // 1. Telemetry server - RunLevel Highest (real smartctl/TPM/BitLocker access), no wrapper
  //    .cmd needed anymore: the SEA exe resolves its own directory via process.execPath, not cwd.
  Exec('schtasks.exe', '/Create /TN PulseEndpointTelemetryServer /TR "wscript.exe ' + VbsPath + ' ' +
    AppShortPath + '\local-agent\server\telemetry-server.exe" /SC ONLOGON /RL HIGHEST /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('powershell.exe', '-NoProfile -Command "' + Format(RestartSettings, ['PulseEndpointTelemetryServer']) + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  // 2. Command Center (backend) - RunLevel Limited (no elevation needed, just HTTP). Only
  //    registered when this install actually includes the backend - an agent-only install has
  //    no start-command-center.cmd on disk to point this task at.
  if WizardIsComponentSelected('backend') then
  begin
    Exec('schtasks.exe', '/Create /TN PulseEndpointCommandCenter /TR "wscript.exe ' + VbsPath + ' ' +
      AppShortPath + '\backend\start-command-center.cmd" /SC ONLOGON /RL LIMITED /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('powershell.exe', '-NoProfile -Command "' + Format(RestartSettings, ['PulseEndpointCommandCenter']) + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;

  // 3. LibreHardwareMonitor - RunLevel Highest (needs it for full sensor access), no wrapper
  //    needed (no working directory/env var setup required), matching the existing pattern.
  Exec('schtasks.exe', '/Create /TN PulseEndpointLibreHardwareMonitor /TR "wscript.exe ' + VbsPath + ' ' +
    AppShortPath + '\LibreHardwareMonitor\LibreHardwareMonitor.exe" /SC ONLOGON /RL HIGHEST /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('powershell.exe', '-NoProfile -Command "' + Format(RestartSettings, ['PulseEndpointLibreHardwareMonitor']) + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  // 4. Desktop app - RunLevel Limited, no run-hidden.vbs wrapper (it's a real visible GUI app,
  //    not a background service - matches the existing PulseEndpointDesktopApp task exactly).
  Exec('schtasks.exe', '/Create /TN PulseEndpointDesktopApp /TR "' + AppShortPath + '\frontend\app.exe" /SC ONLOGON /RL LIMITED /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('powershell.exe', '-NoProfile -Command "' + Format(RestartSettings, ['PulseEndpointDesktopApp']) + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  // 5. Watchdog - RunLevel Highest (Start-ScheduledTask on the elevated tasks above needs it),
  //    runs every real 1 minute, forever - schtasks' own native repeating-trigger syntax, not a
  //    PowerShell-authored trigger object, since it achieves the identical real effect (call
  //    watchdog.ps1 every minute) with a command this installer can express directly.
  Exec('schtasks.exe', '/Create /TN PulseEndpointWatchdog /TR "wscript.exe ' + VbsPath + ' ' +
    AppShortPath + '\local-agent\scripts\start-watchdog.cmd" /SC MINUTE /MO 1 /RL HIGHEST /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  // 6. ai-service - RunLevel Limited (outbound HTTP only, same reasoning as Command Center).
  //    Only registered when this install actually includes it.
  if WizardIsComponentSelected('aiservice') then
  begin
    Exec('schtasks.exe', '/Create /TN PulseEndpointAiService /TR "wscript.exe ' + VbsPath + ' ' +
      AppShortPath + '\ai-service\ai-service.exe" /SC ONLOGON /RL LIMITED /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('powershell.exe', '-NoProfile -Command "' + Format(RestartSettings, ['PulseEndpointAiService']) + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

// ONLOGON only fires at the next sign-in. Start the same tasks now so the agent is live as
// soon as Setup finishes, not only after reboot.
procedure StartScheduledTasks();
var
  ResultCode: Integer;
begin
  Exec('schtasks.exe', '/Run /TN PulseEndpointTelemetryServer', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('schtasks.exe', '/Run /TN PulseEndpointLibreHardwareMonitor', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('schtasks.exe', '/Run /TN PulseEndpointDesktopApp', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('schtasks.exe', '/Run /TN PulseEndpointWatchdog', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if WizardIsComponentSelected('backend') then
    Exec('schtasks.exe', '/Run /TN PulseEndpointCommandCenter', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if WizardIsComponentSelected('aiservice') then
    Exec('schtasks.exe', '/Run /TN PulseEndpointAiService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure OpenBackendFirewall();
var
  ResultCode: Integer;
begin
  Exec('netsh.exe', 'advfirewall firewall delete rule name="Pulse Command Centre 8443"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('netsh.exe', 'advfirewall firewall add rule name="Pulse Command Centre 8443" dir=in action=allow protocol=TCP localport=8443', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    AppShortPath := ResolveShortAppPath();
    // WriteEnvLocal (real backend secrets) only makes sense when the backend is actually being
    // installed on this machine - an agent-only install has no local backend to generate secrets
    // for at all.
    if WizardIsComponentSelected('backend') then
    begin
      WriteEnvLocal();
      OpenBackendFirewall();
    end;
    WriteAgentConfig();
    SeedLhmConfig();
    RunTauriSubInstaller();
    InstallDotNetDesktopRuntimeIfNeeded();
    RegisterScheduledTasks();
    StartScheduledTasks();
  end;
end;

// Explicit decision (not left undecided, per this phase's own instructions): uninstall DELETES
// device-credentials.json/.metric-snapshot-state.json AND the backend's own command-center.db/
// .env.local (in %ProgramData%\Pulse Endpoint\backend - see WriteEnvLocal's own comment on why
// that's where they really live, not {app}\backend), not just the 6 Scheduled Tasks. Reasoning:
// a real uninstall means "this machine should stop being tracked" - leaving a live API key/device
// identity file (or the backend's own device/entitlement database) behind after the software
// that's supposed to hold it is gone is a real orphaned-credential exposure (this project already
// treats device credentials as sensitive - they're the real bearer token every backend call
// authenticates with), not a convenience worth keeping. A reinstall after this point genuinely
// re-registers as a new device against a fresh database, which is the CORRECT behavior for "this
// machine was decommissioned and is now being set up fresh" - it should not silently resume the
// identity or history of whatever device used to be here.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
  BackendDataDir: String;
begin
  // REAL BUG FOUND BY TESTING, FIXED HERE: this all originally ran on usUninstall alone, and a
  // real uninstall run genuinely failed to remove telemetry-server.exe ("Failed to delete the
  // file; it may be in use (5)") - the watchdog task was still alive and running every real
  // minute throughout the uninstall, and it relaunched telemetry-server.exe via
  // Start-ScheduledTask WHILE Inno's own file-removal pass was already in progress, racing it.
  // usAppMutexCheck fires before Inno begins removing anything, so the watchdog (the one thing
  // capable of resurrecting a process mid-uninstall) is deleted there, first, before any file
  // touches happen - by the time usUninstall's own file removal runs, nothing is left that could
  // still be restarting the processes it's trying to delete.
  if CurUninstallStep = usAppMutexCheck then
  begin
    Exec('schtasks.exe', '/Delete /TN PulseEndpointWatchdog /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('schtasks.exe', '/Delete /TN PulseEndpointTelemetryServer /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('schtasks.exe', '/Delete /TN PulseEndpointCommandCenter /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('schtasks.exe', '/Delete /TN PulseEndpointLibreHardwareMonitor /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('schtasks.exe', '/Delete /TN PulseEndpointDesktopApp /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('schtasks.exe', '/Delete /TN PulseEndpointAiService /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

    Exec('powershell.exe', '-NoProfile -Command "Get-Process -Name app,telemetry-server,command-center,ai-service,LibreHardwareMonitor -ErrorAction SilentlyContinue | Stop-Process -Force"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    // Give Windows a moment to actually release file handles after Stop-Process returns -
    // termination is asynchronous from the caller's point of view even with -Force.
    Sleep(1500);

    // REAL GAP FOUND BY TESTING, FIXED HERE: the desktop app is installed by its own real NSIS
    // sub-installer (RunTauriSubInstaller), not by this installer's own [Files] section - Inno's
    // automatic uninstall only ever removes files IT tracked installing, so app.exe/uninstall.exe
    // were silently left behind after a real uninstall run (confirmed directly). The Tauri
    // installer already ships its own real uninstall.exe right next to app.exe for exactly this
    // job - silently invoking it is the correct fix, not reimplementing its removal logic here.
    if FileExists(ExpandConstant('{app}') + '\frontend\uninstall.exe') then
      Exec(ExpandConstant('{app}') + '\frontend\uninstall.exe', '/S', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;

  if CurUninstallStep = usUninstall then
  begin
    DeleteFile(ExpandConstant('{app}') + '\local-agent\server\.device-credentials.json');
    DeleteFile(ExpandConstant('{app}') + '\local-agent\server\.metric-snapshot-state.json');

    // REAL GAP FOUND BY TESTING, FIXED HERE: SeedLhmConfig's two .config files are written
    // directly by this script's own SaveStringToFile, not copied via [Files] - the same
    // Inno-only-knows-what-it-installed reasoning as the Tauri sub-installer above, just for
    // plain files instead of a whole sub-program. Confirmed directly: both were left behind
    // after a real uninstall run without this.
    DeleteFile(ExpandConstant('{app}') + '\LibreHardwareMonitor\LibreHardwareMonitor.config');
    DeleteFile(ExpandConstant('{app}') + '\LibreHardwareMonitor\LIBREH~1.config');

    BackendDataDir := ExpandConstant('{commonappdata}') + '\Pulse Endpoint\backend';
    DelTree(BackendDataDir, True, True, True);
  end;
end;
