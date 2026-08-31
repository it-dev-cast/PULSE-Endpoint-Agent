' Diagnostic-only launcher: starts the frontend app.exe with WebView2 remote debugging
' enabled ONLY for this process (via WScript.Shell's own process environment, not the
' system/user-wide environment - unlike a global env var, this can't collide with any other
' WebView2-based app also running on the machine, e.g. Microsoft Teams).
' Temporary - see the "Pulse Endpoint agent" Run key comment for how to revert.
Set objShell = CreateObject("WScript.Shell")
objShell.Environment("Process")("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") = "--remote-debugging-port=9333"
objShell.Run """C:\Pulse endpoint\frontend\src-tauri\target\release\app.exe""", 1, False
