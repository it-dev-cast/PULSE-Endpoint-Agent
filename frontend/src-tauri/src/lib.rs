use std::sync::Mutex;
use tauri::{
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  Manager, WindowEvent,
};

// Shared by both the real "Open Dashboard" menu item and the real tray left-click handler below
// - one real implementation of "show and focus the main window," not two copies that could
// silently drift apart.
fn show_and_focus_main_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

// Holds the one real, live menu item this app updates at runtime (the connection-status line) -
// stored via app.manage() so the commands below can reach it without re-querying the whole menu
// tree on every call.
struct StatusMenuItem(MenuItem<tauri::Wry>);

// Real, mutable shared state for the two independent facts the tray tooltip reflects (connection
// state, real unread alert count). Tracked here - not recomputed from just whichever command's
// own single argument happens to fire - so update_connection_status and update_unread_count can
// each update their own fact without silently clobbering the other's most recent value in the
// combined tooltip text (see refresh_tray_tooltip below).
struct TrayStatus {
  connected: Mutex<bool>,
  unread_count: Mutex<u32>,
}

// Rebuilds the tooltip from BOTH current facts every time either one changes - there's no
// TrayIcon numeric-badge/overlay API in this Tauri version (confirmed directly against the
// docs.rs reference for this exact tauri version - TrayIcon only exposes icon/tooltip/menu/
// visibility, nothing badge-shaped), so the real unread count surfaces in the tooltip text
// instead of a counter overlay on the icon glyph itself.
fn refresh_tray_tooltip(app: &tauri::AppHandle, tray_status: &tauri::State<TrayStatus>) {
  let connected = *tray_status.connected.lock().unwrap();
  let unread = *tray_status.unread_count.lock().unwrap();

  let base = if connected {
    "Pulse Endpoint agent — Connected"
  } else {
    "Pulse Endpoint agent — Disconnected"
  };
  let tooltip = if unread > 0 {
    format!("{base} — {unread} unread alert{}", if unread == 1 { "" } else { "s" })
  } else {
    base.to_string()
  };
  if let Some(tray) = app.tray_by_id("main") {
    let _ = tray.set_tooltip(Some(tooltip.as_str()));
  }
}

// Called from React (useTelemetry's own `connected` state) every time the real telemetry-server
// connection genuinely changes, not on a timer and not guessed independently here. Updates the
// disabled "Connection: ..." menu line directly, and the shared tooltip via refresh_tray_tooltip
// (which also folds in the current real unread count, not just connection state alone).
#[tauri::command]
fn update_connection_status(
  app: tauri::AppHandle,
  status: tauri::State<StatusMenuItem>,
  tray_status: tauri::State<TrayStatus>,
  connected: bool,
) {
  let label = if connected {
    "Connection: Online"
  } else {
    "Connection: Offline"
  };
  let _ = status.0.set_text(label);
  *tray_status.connected.lock().unwrap() = connected;
  refresh_tray_tooltip(&app, &tray_status);
}

// Called from React (AppContext's real, already-computed `unreadCount`) every time it changes -
// see Settings' "Tray badge count" toggle for where this is gated on.
#[tauri::command]
fn update_unread_count(
  app: tauri::AppHandle,
  tray_status: tauri::State<TrayStatus>,
  count: u32,
) {
  *tray_status.unread_count.lock().unwrap() = count;
  refresh_tray_tooltip(&app, &tray_status);
}

// PRD §30 Remote Assist hardening - called from ScreenSharePOC.tsx the instant a join-request
// arrives, so it's impossible to miss even if the window is minimized to tray. Reuses
// show_and_focus_main_window rather than duplicating it - one real implementation, per that
// function's own comment. request_user_attention is the fallback for the case Windows sometimes
// blocks a background process from stealing foreground focus outright (a real, documented OS
// behavior, not a bug in show()/set_focus() above) - Critical flashes the taskbar icon until the
// window is actually focused, so there's still a real signal even then.
#[tauri::command]
fn request_remote_assist_attention(app: tauri::AppHandle) {
  show_and_focus_main_window(&app);
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
  }
}

// Real TrayIcon::set_visible - Settings' "Show in Tray" toggle. Note a known upstream Tauri v2
// issue on Windows (tauri-apps/tauri#10150): hiding works reliably, but re-showing after a hide
// doesn't always re-expose the icon. Real, not faked, but disclosed here rather than assumed
// flawless - if a user reports the icon not reappearing after re-enabling this toggle, that's
// this known upstream bug, not a wiring error in this app.
#[tauri::command]
fn set_tray_visible(app: tauri::AppHandle, visible: bool) {
  if let Some(tray) = app.tray_by_id("main") {
    let _ = tray.set_visible(visible);
  }
}

// WebView fetch to http://127.0.0.1:4317 POSTs a CORS preflight; the telemetry server 404s
// OPTIONS, so Share surfaces as "Failed to fetch". This command talks to 4317 from Rust, which
// has no CORS, using the same POST the curl path already succeeds with.
#[tauri::command]
fn create_remote_session(mode: String) -> Result<serde_json::Value, String> {
  if mode != "screen" && mode != "voice" && mode != "chat" {
    return Err("invalid mode".into());
  }
  let body = serde_json::json!({ "mode": mode }).to_string();
  let result = ureq::post("http://127.0.0.1:4317/api/remote-session")
    .set("Content-Type", "application/json")
    .timeout(std::time::Duration::from_secs(20))
    .send_string(&body);
  let resp = match result {
    Ok(resp) => resp,
    Err(ureq::Error::Status(_code, resp)) => {
      let text = resp.into_string().unwrap_or_default();
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
          let extra = v.get("lastError").and_then(|x| x.as_str()).unwrap_or("");
          let url = v.get("backendUrl").and_then(|x| x.as_str()).unwrap_or("");
          let mut msg = err.to_string();
          if !url.is_empty() {
            msg.push_str(&format!(" (Command Centre {url})"));
          }
          if !extra.is_empty() {
            msg.push_str(&format!(": {extra}"));
          }
          return Err(msg);
        }
      }
      return Err(if text.is_empty() {
        "local telemetry refused the remote-session request".into()
      } else {
        text
      });
    }
    Err(e) => {
      return Err(format!("Can't reach local telemetry on port 4317: {e}"));
    }
  };
  let status = resp.status();
  let text = resp.into_string().map_err(|e| e.to_string())?;
  if !(200..300).contains(&status) {
    return Err(text);
  }
  serde_json::from_str(&text).map_err(|e| e.to_string())
}

// The real, instant Stop Sharing action (see backend/remote_session.go's endImmediately) - same
// CORS-preflight-avoidance reason create_remote_session above talks to 127.0.0.1:4317 from Rust
// rather than the WebView doing it directly. No response body is expected on success (backend
// returns 204), so this only needs to report whether the call succeeded.
#[tauri::command]
fn end_remote_session(session_id: String) -> Result<(), String> {
  let url = format!("http://127.0.0.1:4317/api/remote-session/{session_id}/end");
  let result = ureq::post(&url)
    .timeout(std::time::Duration::from_secs(10))
    .call();
  match result {
    Ok(_) => Ok(()),
    Err(ureq::Error::Status(_code, resp)) => {
      let text = resp.into_string().unwrap_or_default();
      Err(if text.is_empty() { "failed to end the session".into() } else { text })
    }
    Err(e) => Err(format!("Can't reach local telemetry on port 4317: {e}")),
  }
}

// PRD §30 Remote Assist hardening - real, time-limited TURN relay credentials (see
// backend/turn.go's own comment). A plain GET with no body doesn't trigger the same CORS
// preflight create_remote_session's own comment describes for POST, but this command exists
// anyway for consistency within this file and because it's cheap insurance against the exact
// class of bug that one was found live to have - untested assumptions about WebView fetch
// behavior aren't worth carrying forward silently.
#[tauri::command]
fn get_turn_credentials() -> Result<serde_json::Value, String> {
  let result = ureq::get("http://127.0.0.1:4317/api/turn-credentials")
    .timeout(std::time::Duration::from_secs(10))
    .call();
  let resp = match result {
    Ok(resp) => resp,
    Err(_) => return Ok(serde_json::json!({ "configured": false })),
  };
  let text = resp.into_string().map_err(|e| e.to_string())?;
  serde_json::from_str(&text).or_else(|_| Ok(serde_json::json!({ "configured": false })))
}

// PRD §30 Remote Assist hardening - real audit-trail events (operator joined, session ended,
// join denied, file transferred) logged from the WebView via Rust for the same reason
// create_remote_session already is (POST + JSON body triggers a CORS preflight the local
// telemetry server 404s). Best-effort by design, matching every other real event-logging call in
// this project: an audit event that fails to log doesn't undo the real thing that already
// happened (the join/deny/transfer), so this never blocks or surfaces an error to the caller.
#[tauri::command]
fn log_remote_assist_event(event_type: String, message: String, severity: String) {
  let body = serde_json::json!({ "eventType": event_type, "message": message, "severity": severity }).to_string();
  let _ = ureq::post("http://127.0.0.1:4317/api/event")
    .set("Content-Type", "application/json")
    .timeout(std::time::Duration::from_secs(10))
    .send_string(&body);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      show_and_focus_main_window(app);
    }))
    .invoke_handler(tauri::generate_handler![
      update_connection_status,
      update_unread_count,
      set_tray_visible,
      create_remote_session,
      end_remote_session,
      get_turn_credentials,
      log_remote_assist_event,
      request_remote_assist_attention
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Real menu items - "Open Dashboard" and "Quit" both do exactly what they say (see
      // on_menu_event below), and the status line is a real, disabled (non-clickable) label
      // whose text update_connection_status keeps live, not a decorative placeholder.
      let open_item = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
      let status_item =
        MenuItem::with_id(app, "status", "Connection: checking…", false, None::<&str>)?;
      let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
      let menu = Menu::with_items(
        app,
        &[
          &open_item,
          &PredefinedMenuItem::separator(app)?,
          &status_item,
          &PredefinedMenuItem::separator(app)?,
          &quit_item,
        ],
      )?;

      app.manage(StatusMenuItem(status_item));
      app.manage(TrayStatus {
        connected: Mutex::new(false),
        unread_count: Mutex::new(0),
      });

      TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Pulse Endpoint agent")
        // Left-click alone now opens the window directly (see on_tray_icon_event below) rather
        // than also showing the menu - conventional tray behavior is left-click = primary
        // action, right-click = menu, not the same action bound to both buttons. Right-click
        // still shows the real menu on its own; Tauri does that natively without this flag.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
          "open" => show_and_focus_main_window(app),
          // A real, working exit - app.exit(0) genuinely terminates the process, unlike the
          // window-close handler below, which only ever hides the window.
          "quit" => {
            app.exit(0);
          }
          _ => {}
        })
        .on_tray_icon_event(|tray, event| {
          // Real left-click-to-open, matching how tray icons conventionally behave - the exact
          // same action as the menu's own "Open Dashboard" item, just also reachable with one
          // plain left-click rather than only through the menu. Gated on button_state == Up
          // (the completed click, not the initial press) so this fires once per real click, not
          // once per press-and-release.
          if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            show_and_focus_main_window(tray.app_handle());
          }
        })
        .build(app)?;

      Ok(())
    })
    .on_window_event(|window, event| {
      // Real "minimize to tray" behavior: the window's own close (X) button hides the window
      // rather than exiting the process. Without this, the tray's "Quit" item would be
      // meaningless busywork identical to the window's close button - there'd be no state where
      // the app is genuinely still running with only the tray icon visible, which is the entire
      // point of having a tray icon and a distinct Quit action in the first place. Settings'
      // "Minimize to Tray" toggle is a real, read-only disclosure of this exact behavior (see
      // App.tsx's own SSContent) - genuinely always-on, not gated behind a setting, since there's
      // no real reason a background monitoring agent's user would want it off.
      if let WindowEvent::CloseRequested { api, .. } = event {
        let _ = window.hide();
        api.prevent_close();
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
