// Shared WMI BatteryStatus code mapping — single source of truth reused by BatteryCard,
// HWComponentsSection, and the alert engine, so all three agree on what each code means.
export const BATTERY_STATUS_LABELS: Record<number, string> = {
  1: "Discharging",
  2: "Plugged In",
  3: "Fully Charged",
  6: "Charging",
  7: "Charging (High)",
  8: "Charging (Low)",
  9: "Undefined",
};

export function isBatteryDischarging(statusCode: number | null | undefined): boolean {
  return statusCode === 1;
}

export function isBatteryOnAc(statusCode: number | null | undefined): boolean {
  return statusCode === 2 || statusCode === 3 || statusCode === 6 || statusCode === 7 || statusCode === 8;
}
