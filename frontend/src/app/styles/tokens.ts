/** CLPA design tokens — single source for page polish (frontend only).
 *  colors.* are real CSS variables (styles/theme.css), not literal hex - each already has a
 *  real dark-mode value, so the handful of call sites reading these (App.tsx, clpa.tsx) are
 *  theme-aware automatically, with no code change needed when Theme switches. */
export const CLPA_TOKENS = {
  colors: {
    bg: "var(--clpa-bg)",
    card: "var(--clpa-card)",
    cardBorder: "var(--clpa-card-border)",
    cardShadow: "var(--clpa-shadow)",
    title: "var(--clpa-title)",
    body: "var(--clpa-body)",
    muted: "var(--clpa-muted)",
    subtle: "var(--clpa-subtle)",
    primary: "var(--clpa-primary)",
    success: "var(--clpa-success)",
    divider: "var(--clpa-divider)",
  },
  radius: {
    card: 16,
    button: 8,
    badge: 999,
  },
  spacing: {
    page: 10,
    row: 10,
    // Real Settings > View: Comfortable/Compact density (theme.css's --clpa-card-pad) - every
    // CLPACard consumer (the app's dominant card padding source) now responds to the toggle.
    cardPad: "var(--clpa-card-pad)",
    cardPadCompact: "10px 12px",
  },
  type: {
    pageTitle: { fontSize: 15.5, fontWeight: 700 },
    section: { fontSize: 11, fontWeight: 800, letterSpacing: 0.4 },
    label: { fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5 },
    body: { fontSize: 9.5, fontWeight: 500 },
    caption: { fontSize: 8.5, fontWeight: 600 },
    micro: { fontSize: 7.5, fontWeight: 700 },
  },
  shell: {
    width: 1100,
    height: 728,
  },
} as const;
