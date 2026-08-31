import { Component, type ErrorInfo, type ReactNode } from "react";

// Last-resort safety net, not a substitute for the per-field `connected && x?.y` guards already
// used throughout App.tsx - those prevent most rendering errors from happening at all. This
// exists for whatever could still slip through (a future edit that misses a guard, a genuinely
// unanticipated shape from the telemetry server) so a single render error takes down this one
// subtree instead of white-screening the whole dashboard. React error boundaries can only be
// class components - there's no hook equivalent as of React 18.
type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] caught a render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: 24,
            textAlign: "center",
            background: "var(--clpa-surface)",
            fontFamily: "inherit",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--clpa-title)" }}>Something went wrong displaying this page.</div>
          <div style={{ fontSize: 12, color: "var(--clpa-muted)", maxWidth: 420 }}>
            The dashboard hit an unexpected error and can't continue rendering. Reloading usually resolves it - if it keeps happening, check the browser console for details.
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8,
              background: "var(--clpa-primary)",
              border: "none",
              borderRadius: 8,
              padding: "8px 16px",
              color: "white",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
