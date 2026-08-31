import type { CSSProperties, ReactNode } from "react";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { CLPA_TOKENS } from "../../styles/tokens";

export const CLPA_STYLES = {
  card: {
    background: CLPA_TOKENS.colors.card,
    border: `1px solid ${CLPA_TOKENS.colors.cardBorder}`,
    boxShadow: CLPA_TOKENS.colors.cardShadow,
  },
  padding: CLPA_TOKENS.spacing.cardPad,
} as const;

export function CLPAPage({
  children,
  compact = false,
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  return <div className={compact ? "clpa-page clpa-page--compact" : "clpa-page"}>{children}</div>;
}

export function CLPASectionTitle({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-center justify-between mb-0.5">
      <span style={{ ...CLPA_TOKENS.type.section, color: CLPA_TOKENS.colors.title }}>{title}</span>
      {action && (
        <button
          onClick={onAction}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: CLPA_TOKENS.colors.primary, fontWeight: 600 }}
        >
          {action} ›
        </button>
      )}
    </div>
  );
}

export function CLPACard({
  children,
  className = "",
  style = {},
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`clpa-card-hover rounded-2xl ${className}`}
      style={{
        position: "relative",
        height: "100%",
        ...CLPA_STYLES.card,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function CLPAInfo() {
  return (
    <div
      className="flex items-center justify-center rounded-full flex-shrink-0"
      style={{ width: 14, height: 14, border: "1.5px solid var(--clpa-track)" }}
    >
      <span style={{ fontSize: 8, color: "var(--clpa-subtle)", fontWeight: 700, lineHeight: 1 }}>i</span>
    </div>
  );
}

export function CLPAHeader({
  title,
  action,
  onAction,
  badge,
  badgeColor = "var(--clpa-success)",
  badgeBg = "rgba(var(--clpa-success-bright-rgb),0.1)",
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  badge?: string;
  badgeColor?: string;
  badgeBg?: string;
}) {
  return (
    <div className="flex items-center justify-between mb-2.5">
      <div className="flex items-center gap-1.5">
        <span style={{ fontSize: 11, fontWeight: 800, color: "var(--clpa-title)", letterSpacing: 0.4 }}>{title}</span>
        <CLPAInfo />
        {badge && <CLPABadge label={badge} color={badgeColor} bg={badgeBg} />}
      </div>
      {action && (
        <button
          onClick={onAction}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10.5, color: "var(--clpa-primary)", fontWeight: 600 }}
        >
          {action} ›
        </button>
      )}
    </div>
  );
}

export function CLPABadge({
  label,
  color = "var(--clpa-success)",
  bg = "rgba(var(--clpa-success-bright-rgb),0.1)",
}: {
  label: string;
  color?: string;
  bg?: string;
}) {
  return (
    <span style={{ fontSize: 8.5, fontWeight: 700, color, background: bg, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

export function CLPASectionLabel({
  label,
  live,
  Icon,
}: {
  label: string;
  live?: boolean;
  // size/strokeWidth?: string | number, matching lucide-react's actual LucideProps - narrowing
  // either to just number (this codebase only ever passes numeric literals) made every Lucide
  // icon passed here structurally incompatible with this prop's declared ComponentType, since TS
  // also compares the icons' static propTypes validator, which Lucide declares as string | number.
  Icon?: React.ComponentType<{ size?: number | string; style?: CSSProperties; strokeWidth?: number | string }>;
}) {
  return (
    <div className="flex items-center gap-1.5 mb-2">
      {Icon && <Icon size={11} style={{ color: "var(--clpa-primary)" }} strokeWidth={2} />}
      <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--clpa-muted)", letterSpacing: 0.5 }}>{label}</span>
      {live && (
        <div className="flex items-center gap-1 ml-2">
          <div className="clpa-dot w-1.5 h-1.5 rounded-full" style={{ background: "var(--clpa-success-bright)" }} />
          <span style={{ fontSize: 9.5, color: "var(--clpa-subtle)" }}>Live · 5s refresh</span>
        </div>
      )}
    </div>
  );
}

export function CLPAPageActions({
  syncedLabel = "Last synced: Today 10:42 AM",
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
}: {
  syncedLabel?: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  onPrimary?: () => void;
  onSecondary?: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-3">
      <span style={{ fontSize: 10, color: "var(--clpa-subtle)" }}>{syncedLabel}</span>
      {secondaryLabel && (
        <button
          onClick={onSecondary}
          className="flex items-center gap-1.5"
          style={{ background: "var(--clpa-card)", border: "1px solid rgba(0,0,0,0.08)", borderRadius: 8, padding: "5px 12px", cursor: "pointer" }}
        >
          <CheckCircle2 size={11} style={{ color: "var(--clpa-muted)" }} strokeWidth={2.2} />
          <span style={{ fontSize: 10.5, color: "var(--clpa-body-alt)", fontWeight: 600 }}>{secondaryLabel}</span>
        </button>
      )}
      {primaryLabel && (
        <button
          onClick={onPrimary}
          className="flex items-center gap-1.5"
          style={{ background: "var(--clpa-primary)", border: "none", borderRadius: 8, padding: "5px 12px", cursor: "pointer" }}
        >
          <RefreshCw size={11} color="white" strokeWidth={2.2} />
          <span style={{ fontSize: 10.5, color: "white", fontWeight: 600 }}>{primaryLabel}</span>
        </button>
      )}
    </div>
  );
}

export function CLPARow({
  children,
  columns,
  compact = false,
  align = "stretch",
}: {
  children: ReactNode;
  columns: string;
  compact?: boolean;
  align?: "stretch" | "start";
}) {
  return (
    <div className={`grid ${compact ? "gap-2" : "gap-2.5"}`} style={{ gridTemplateColumns: columns, alignItems: align }}>
      {children}
    </div>
  );
}
