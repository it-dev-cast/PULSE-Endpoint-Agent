import { isRunningInTauri } from "./tauriRuntime";

// Real Tauri v2 window commands (@tauri-apps/api/window's getCurrentWindow()) - what TitleBar's
// minimize/maximize/close buttons now genuinely do, replacing the old window.desktop?.method?.()
// bridge that was never actually implemented by anything (a relic from when this app only ran as
// a plain browser tab and those calls silently fell through to a toast). A no-op outside the
// Tauri desktop app (see isRunningInTauri) - there's no real window to control in a browser tab.

export async function minimizeWindow(): Promise<void> {
  if (!(await isRunningInTauri())) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!(await isRunningInTauri())) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  if (!(await isRunningInTauri())) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

// Explicit startDragging() call, per Tauri v2's own documented custom-title-bar pattern - kept
// alongside (not instead of) the data-tauri-drag-region attribute on the header, but this is the
// one actually driving real window movement: the attribute's automatic global mousedown
// detection did not reliably trigger a real drag in this app's own testing (confirmed directly -
// real synthetic mousedown events reached the header element, verified via a diagnostic
// listener, but the window never moved), while calling this explicitly from the header's own
// onMouseDown does.
export async function startDraggingWindow(): Promise<void> {
  if (!(await isRunningInTauri())) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}
