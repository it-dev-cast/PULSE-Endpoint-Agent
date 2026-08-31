Set objShell = CreateObject("WScript.Shell")
' The third argument (True = wait for the child to exit) is required for the Scheduled Tasks'
' RestartCount/RestartInterval settings to mean anything. With False (the original setting - see
' README.md's own comment on why it was chosen), wscript.exe returns immediately after launching
' the real target process and Task Scheduler considers the task "completed successfully" within
' milliseconds of every logon - it never sees the real long-running process (node/command-center.exe/
' LibreHardwareMonitor.exe) again, so a later crash of THAT process is invisible to Task Scheduler
' and can never trigger a restart. Waiting here makes wscript.exe's own lifetime track the real
' process's lifetime, which is what Task Scheduler actually needs to detect a crash and restart it.
' The window stays hidden either way - window style (the "0" below) is independent of this.
' The exit code has to be captured and propagated as wscript.exe's OWN exit code (via WScript.Quit)
' - not just waited on - because Task Scheduler's RestartCount/RestartInterval only treats a task
' as "failed" (worth restarting) when its action process exits non-zero. Without this, wscript.exe
' would still exit 0 (its own default) no matter how the real target process died, and Task
' Scheduler would keep seeing every crash as a normal, successful completion.
exitCode = objShell.Run("""" & WScript.Arguments(0) & """", 0, True)
WScript.Quit(exitCode)
