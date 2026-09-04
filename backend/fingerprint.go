package main

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"
)

// StorageFingerprint is one storage device's identifying facts within a HardwareFingerprint -
// model/serial/capacity only, never firmware version (that's already tracked separately, e.g.
// storageHealth's own real firmware_version field on the frontend, and legitimately changes on
// a firmware update with no hardware actually swapped).
type StorageFingerprint struct {
	Model     string `json:"model"`
	Serial    string `json:"serial"`
	SizeBytes int64  `json:"sizeBytes"`
}

// HardwareFingerprint is the real device-registry hardware baseline Hardware page's Tamper
// Detection needs - deliberately narrow to fields that identify the physical hardware itself
// and never legitimately change on a routine driver/BIOS/firmware update: real serials/model
// names only, never a clock speed, microcode version, or driver version (those change on their
// own without any hardware having been touched, and would otherwise make this false-positive on
// every update cycle).
type HardwareFingerprint struct {
	SystemSerial     string               `json:"systemSerial"`
	SystemUUID       string               `json:"systemUUID"`
	BoardProduct     string               `json:"boardProduct"`
	BoardSerial      string               `json:"boardSerial"`
	CPUModel         string               `json:"cpuModel"`
	RAMTotalCapacity int64                `json:"ramTotalCapacity"`
	RAMModuleSerials []string             `json:"ramModuleSerials"`
	Storage          []StorageFingerprint `json:"storage"`
	GPUModels        []string             `json:"gpuModels"`
	// WifiMac/BatterySerial were added after both real devices already had locked baselines - see
	// compareFingerprints' checkIfBothPresent for why they're compared differently from the 9
	// fields above.
	WifiMac       string `json:"wifiMac"`
	BatterySerial string `json:"batterySerial"`
}

// normalize sorts every slice field whose real-world enumeration order isn't guaranteed stable
// across boots (RAM module order, storage device order, multi-GPU order can all legitimately
// shuffle between runs with zero hardware changed) - without this, a reboot alone could read as
// a false-positive tamper mismatch. Comparison and storage always happen on the normalized form.
func (f HardwareFingerprint) normalize() HardwareFingerprint {
	out := f
	out.RAMModuleSerials = append([]string(nil), f.RAMModuleSerials...)
	sort.Strings(out.RAMModuleSerials)
	out.Storage = append([]StorageFingerprint(nil), f.Storage...)
	sort.Slice(out.Storage, func(i, j int) bool { return out.Storage[i].Serial < out.Storage[j].Serial })
	out.GPUModels = append([]string(nil), f.GPUModels...)
	sort.Strings(out.GPUModels)
	return out
}

func storageLabel(devices []StorageFingerprint) string {
	parts := make([]string, len(devices))
	for i, d := range devices {
		parts[i] = fmt.Sprintf("%s (serial %s, %d bytes)", d.Model, d.Serial, d.SizeBytes)
	}
	return strings.Join(parts, "; ")
}

// compareFingerprints returns exactly which real fields changed between a locked baseline and a
// device's current fingerprint - both a short label (the API response's "fields") and a full
// human-readable old->new description (the hardware-tamper-detected event's message), so
// whoever investigates the event sees precisely what changed, not just that something did.
// Both inputs are normalized here rather than trusted pre-sorted, since the baseline may have
// been captured by an older local-agent build with different ordering behavior.
func compareFingerprints(baseline, current HardwareFingerprint) (fields []string, details []string) {
	baseline = baseline.normalize()
	current = current.normalize()

	check := func(label, oldVal, newVal string) {
		if oldVal != newVal {
			fields = append(fields, label)
			details = append(details, fmt.Sprintf("%s changed from %q to %q", label, oldVal, newVal))
		}
	}

	// checkIfBothPresent is check's counterpart for WifiMac/BatterySerial, added to
	// HardwareFingerprint after both real devices already had locked baselines. An old baseline
	// unmarshals a field it never had as Go's zero value ("") - unconditionally comparing that
	// against a freshly-collected real value would read as "changed" for every already-enrolled
	// device the moment this ships, not a genuine hardware change. Skipping whenever either side
	// is empty defers enforcement to this device's next fresh baseline lock (re-enrollment, or an
	// explicit fingerprint reset) - no schema-version bookkeeping needed. The same rule also
	// correctly no-ops on hardware that genuinely never reports a field (confirmed live: this dev
	// machine's own battery serial is blank via Win32_PortableBattery) rather than treating
	// "unknown" as "known and different." The 9 fields above intentionally keep using check()
	// unmodified - they've been part of every baseline since this feature's first version, so an
	// empty value there is a real fact worth comparing, not a migration gap.
	checkIfBothPresent := func(label, oldVal, newVal string) {
		if oldVal == "" || newVal == "" {
			return
		}
		check(label, oldVal, newVal)
	}

	check("System Serial Number", baseline.SystemSerial, current.SystemSerial)
	check("System UUID", baseline.SystemUUID, current.SystemUUID)
	check("Motherboard Product", baseline.BoardProduct, current.BoardProduct)
	check("Motherboard Serial Number", baseline.BoardSerial, current.BoardSerial)
	check("CPU Model", baseline.CPUModel, current.CPUModel)
	check("Total RAM Capacity", fmt.Sprintf("%d bytes", baseline.RAMTotalCapacity), fmt.Sprintf("%d bytes", current.RAMTotalCapacity))
	check("RAM Module Serials", strings.Join(baseline.RAMModuleSerials, ", "), strings.Join(current.RAMModuleSerials, ", "))
	check("Storage Devices", storageLabel(baseline.Storage), storageLabel(current.Storage))
	check("GPU Models", strings.Join(baseline.GPUModels, ", "), strings.Join(current.GPUModels, ", "))
	checkIfBothPresent("WiFi MAC Address", baseline.WifiMac, current.WifiMac)
	checkIfBothPresent("Battery Serial Number", baseline.BatterySerial, current.BatterySerial)

	return fields, details
}

// getDeviceFingerprint returns the device's stored baseline JSON, or nil if none has been
// captured yet (a fresh device, or one whose baseline was just cleared via
// resetDeviceFingerprint) - the caller's signal to store whatever it was just sent as the new
// baseline rather than comparing against nothing.
func getDeviceFingerprint(db *DB, deviceID string) (*string, error) {
	var fp sql.NullString
	err := db.QueryRow(`SELECT hardware_fingerprint FROM devices WHERE id = ?`, deviceID).Scan(&fp)
	if err != nil {
		return nil, err
	}
	if !fp.Valid {
		return nil, nil
	}
	return &fp.String, nil
}

func setDeviceFingerprint(db *DB, deviceID, fingerprintJSON string, now time.Time) error {
	_, err := db.Exec(
		`UPDATE devices SET hardware_fingerprint = ?, fingerprint_locked_at = ? WHERE id = ?`,
		fingerprintJSON, now.UTC().Format(time.RFC3339Nano), deviceID,
	)
	return err
}

// resetDeviceFingerprint is the real, necessary escape hatch for a legitimate hardware upgrade -
// without it, a real RAM/storage/GPU swap would permanently misflag as tamper forever, since
// nothing else in this system ever clears a locked baseline on its own.
func resetDeviceFingerprint(db *DB, deviceID string) error {
	_, err := db.Exec(`UPDATE devices SET hardware_fingerprint = NULL, fingerprint_locked_at = NULL WHERE id = ?`, deviceID)
	return err
}
