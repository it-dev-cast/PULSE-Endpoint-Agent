// Real, shared time/date formatting - every clock-time and calendar-date label in this app
// (alert timestamps, snooze labels, last-synced, warranty/entitlement dates) goes through the
// two functions below instead of each call site independently hardcoding its own
// {hour:"numeric", minute:"2-digit"} or "D Mon YYYY" logic - so Settings' real Time Format/Date
// Format preferences actually apply everywhere a time or date is shown, not just wherever
// happened to read the preference directly. Plain module-level reads (not React state/context):
// most call sites are one-off imperative string construction (a toast message, an alert's own
// `time` field at the moment it fires), not something that needs to live-update mid-render the
// instant the setting changes - the one place that DOES need to reactively show the current
// value (Settings' own Time Format/Date Format controls) keeps its own local useState, refreshed
// on click, same pattern as any other settings field in this file.
import { loadJSON, saveJSON } from "./storage";

export type TimeFormatPref = "12h" | "24h";
export type DateFormatPref = "DD MMM YYYY" | "MM/DD/YYYY";

const TIME_FORMAT_KEY = "clpa:settings:time-format:v1";
const DATE_FORMAT_KEY = "clpa:settings:date-format:v1";

export function getTimeFormatPref(): TimeFormatPref {
  return loadJSON<TimeFormatPref>(TIME_FORMAT_KEY, "12h");
}

export function setTimeFormatPref(pref: TimeFormatPref): void {
  saveJSON(TIME_FORMAT_KEY, pref);
}

export function getDateFormatPref(): DateFormatPref {
  return loadJSON<DateFormatPref>(DATE_FORMAT_KEY, "DD MMM YYYY");
}

export function setDateFormatPref(pref: DateFormatPref): void {
  saveJSON(DATE_FORMAT_KEY, pref);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatTimeLabel(date: Date): string {
  if (getTimeFormatPref() === "24h") {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatDateLabel(date: Date): string {
  const d = date.getDate();
  const m = date.getMonth();
  const y = date.getFullYear();
  if (getDateFormatPref() === "MM/DD/YYYY") {
    return `${String(m + 1).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
  }
  return `${d} ${MONTHS[m]} ${y}`;
}
