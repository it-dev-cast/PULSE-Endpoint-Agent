// True only when this React app is actually running inside the Tauri-packaged desktop app (its
// own webview injects window.__TAURI_INTERNALS__) - false in an ordinary browser tab (plain
// `npm run dev`/`vite preview`), where there is no window/tray/autostart to control and any of
// the real @tauri-apps/api calls would just throw. isTauri() itself is Tauri's own real
// detection, not a guess based on user agent sniffing. Shared by every Tauri-specific hook/
// module in this app (tray sync, autostart, window controls) rather than each re-implementing
// the same check.
export async function isRunningInTauri(): Promise<boolean> {
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    return isTauri();
  } catch {
    return false;
  }
}
