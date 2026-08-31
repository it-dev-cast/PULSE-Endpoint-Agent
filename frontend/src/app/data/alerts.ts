import type { LucideIcon } from "lucide-react";

export type AlertSeverity = "critical" | "warning" | "info";

export type AlertItem = {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  category: string;
  time: string;
  unread: boolean;
  Icon: LucideIcon;
  iconColor: string;
  iconBg: string;
  source: "real" | "sample";
  // The useAlertEngine rule this alert was generated from — present only for real,
  // engine-produced alerts. Lets snooze suppress future firing of the actual rule instead of
  // just hiding this one alert instance; sample alerts have no rule behind them, so this is
  // undefined for them rather than a fragile parse of the id string.
  ruleId?: string;
  // How many times this exact ruleId has fired without a genuinely new AlertItem being created -
  // useAlertEngine dedupes repeated re-crossings of the same rule into one entry (bumping this
  // instead of appending a duplicate card), and the one-time migration collapses whatever had
  // already accumulated under the old, non-deduping behavior. Always 1 for a sample alert or a
  // real alert that has only ever fired once.
  occurrenceCount: number;
  // Epoch ms this alert (or, for a deduped rule, its current still-open occurrence) was created -
  // reset to a fresh value if a previously-resolved alert's rule re-fires (see useAlertEngine's
  // fire logic), since that's genuinely a new incident for response-time purposes. Used by
  // AAlertHistoryCard's real "Avg response" stat; sample alerts carry a real value here too (set
  // at app load) but are excluded from that calculation since their timeline isn't real.
  createdAt: number;
  // Epoch ms this alert was acknowledged or snoozed (AppContext's acknowledgeAlert/snoozeAlert) -
  // undefined while still unread/open. Dismissing an alert removes it outright rather than
  // setting this, matching how dismissed alerts already never appeared in Alert History's
  // "Resolved" list before this field existed.
  resolvedAt?: number;
};

export const INITIAL_ALERTS: AlertItem[] = [];

export const SEVERITY_META: Record<AlertSeverity, { label: string; color: string; bg: string }> = {
  critical: { label: "Critical", color: "var(--clpa-critical)", bg: "rgba(var(--clpa-critical-bright-rgb),0.1)" },
  warning: { label: "Warning", color: "var(--clpa-warning)", bg: "rgba(var(--clpa-warning-bright-rgb),0.12)" },
  info: { label: "Info", color: "var(--clpa-info-blue)", bg: "rgba(var(--clpa-primary-rgb),0.1)" },
};
