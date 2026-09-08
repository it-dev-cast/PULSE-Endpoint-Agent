// HWiNFO shared-memory reader ("Global\HWiNFO_SENS_SM2").
//
// This struct layout is NOT an officially documented/supported HWiNFO API - HWiNFO's own
// interface headers are under a proprietary license. What's implemented below follows the
// community reverse-engineered format published at
// https://gist.github.com/namazso/0c37be5a53863954c8c8279f66cfb1cc ("HWiNFOSharedMem -
// Reverse engineered HWiNFO shared memory format", namazso, 2021), itself derived by
// inspecting the shared memory section with ReClass and cross-checking against HWiNFO's own
// "Shared Memory Viewer" tool - not from any HWiNFO SDK or published spec. Because it's
// reverse-engineered rather than a stable contract, a future HWiNFO version could silently
// change this layout (field order, added fields, a different element size) and break parsing
// here without any error surfacing it as anything other than "fields came back null" - the
// same class of fragility this project already documents for LibreHardwareMonitor's Remote Web
// Server sensor tree and smartctl's JSON shape.
//
// Only the Entry ("reading") array is read, not the separate Sensor array the header also
// describes - each HWiNFOEntry already carries its own name_original/name_user for the
// specific reading, which is all the substring matching below needs. The Sensor array (parent
// hardware node identity/instance) is left unparsed since nothing here groups by hardware
// category the way LHM's SensorId path does.

use std::time::{SystemTime, UNIX_EPOCH};

use windows::core::PCWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Memory::{MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ};

const SHARED_MEM_NAME: &str = "Global\\HWiNFO_SENS_SM2";

// `#define HWiNFO_HEADER_MAGIC ((uint32_t)'SiWH')` in the gist's C header - MSVC packs a
// multi-character constant most-significant-character-first, so 'S','i','W','H' (0x53, 0x69,
// 0x57, 0x48) becomes 0x53695748. Confirmed self-consistent: read little-endian, that value's
// bytes in memory order are 0x48,0x57,0x69,0x53 ("HWiS"), the byte sequence other independent
// HWiNFO shared-memory reader implementations cite for this same tag.
const HEADER_MAGIC: u32 = 0x5369_5748;

// Header field byte offsets, per the gist verbatim (all structs there are declared with 1-byte
// packing, so these are also each field's natural size-aligned offset with no padding).
// Only the entry-section fields are read (see the module comment on why the Sensor array is
// skipped entirely) - sensor_section_offset/sensor_element_size/sensor_element_count exist in
// the real header at 0x14/0x18/0x1C but aren't needed here.
const OFF_MAGIC: usize = 0x00;
const OFF_LAST_UPDATE: usize = 0x0C;
const OFF_ENTRY_SECTION_OFFSET: usize = 0x20;
const OFF_ENTRY_ELEMENT_SIZE: usize = 0x24;
const OFF_ENTRY_ELEMENT_COUNT: usize = 0x28;

// HWiNFOEntry field offsets, relative to the start of each entry. Iteration below steps by the
// header's own `entry_element_size` (not this file's HEADER_SIZE-style constant), so a future
// HWiNFO version that appends new fields after value_avg still parses correctly - only a change
// to these low, fixed offsets themselves (unlikely, per the gist, but not guaranteed) would
// silently break this.
const ENTRY_OFF_TYPE: usize = 0x00;
const ENTRY_OFF_NAME_ORIGINAL: usize = 0x0C;
const ENTRY_OFF_NAME_USER: usize = 0x8C;
const ENTRY_NAME_LEN: usize = 128;
const ENTRY_OFF_VALUE: usize = 0x11C;

// SensorType enum, in the exact declared order from the gist (None=0 first).
const SENSOR_TYPE_TEMPERATURE: u32 = 1;
const SENSOR_TYPE_VOLTAGE: u32 = 2;
const SENSOR_TYPE_FAN: u32 = 3;

// Generous relative to HWiNFO's own typical sensor-polling cadence (commonly a couple of
// seconds), but minuscule next to the free version's 12-hour shared-memory cutoff - so that
// cutoff is naturally caught by this check without hardcoding "12 hours" as a special case.
// Anything reading as older than this is treated as HWiNFO having stopped updating (exited,
// crashed, or the free-version window elapsed), not live data.
const MAX_STALENESS_SECS: i64 = 60;

pub struct HwInfoReading {
    pub value: f64,
    pub name_user: String,
    pub name_original: String,
}

pub struct PerCoreVoltage {
    pub label: String,
    pub volts: f64,
}

#[derive(Default)]
pub struct HwInfoResult {
    pub cpu_voltage: Option<HwInfoReading>,
    pub motherboard_temp_c: Option<HwInfoReading>,
    pub fan_rpm: Option<HwInfoReading>,
    // Distinct from cpu_voltage above, not a replacement for it - these are the individual
    // per-core/per-rail VID (Voltage IDentification) readings modern Intel hybrid (P-core/
    // E-core) CPUs expose instead of one aggregate "CPU Core"/"VCORE" rail. Collapsing them
    // into a single averaged "CPU Voltage" would misrepresent several genuinely different
    // electrical rails as one fact, so each is surfaced under its own real HWiNFO label
    // instead. Empty (not absent) when this hardware doesn't expose any - see read_hwinfo's
    // caller for how that's distinguished from "HWiNFO unavailable entirely".
    pub per_core_voltages: Vec<PerCoreVoltage>,
    // PCH (Platform Controller Hub / chipset) and SPD Hub (memory serial-presence-detect hub)
    // temperatures - real, separately-named facts, not a "Motherboard Temp" substitute. Many
    // laptops (this dev machine included) have no classic Super I/O "Motherboard"/"System"
    // sensor at all, but do expose these two instead.
    pub pch_temp_c: Option<f64>,
    pub spd_hub_temp_c: Option<f64>,
}

// Case-insensitive substring patterns for each of the three original fields this project wants
// - a short, explicit allowlist, not an attempt to model every sensor label HWiNFO can produce.
// Exact names vary by hardware/BIOS/EC vendor (the same caveat this project already documents
// for LibreHardwareMonitor's sensor tree), so any of the three can legitimately come back None
// on hardware that either doesn't expose it or labels it something not on this list.
const CPU_VOLTAGE_PATTERNS: &[&str] = &["cpu core", "vcore"];
const MOTHERBOARD_TEMP_PATTERNS: &[&str] = &["motherboard", "system"];
const FAN_PATTERNS: &[&str] = &[
    "cpu fan",
    "chassis fan",
    "system fan",
    "sys fan",
    "gpu fan",
    "fan #",
    "fan1",
    "fan 1",
    "fan speed",
    "cpu",
    "gpu",
    "chassis",
    "system",
];

// "VID" (Voltage IDentification) is Intel's own term for these per-core/per-rail readings -
// confirmed against this project's real hardware to cover "P-core N VID", "E-core N VID",
// "SA VID", and "iGPU VID" all with this one substring, independent of (and non-overlapping
// with) CPU_VOLTAGE_PATTERNS above.
const PER_CORE_VOLTAGE_PATTERN: &str = "vid";
const PCH_TEMP_PATTERNS: &[&str] = &["pch"];
const SPD_HUB_TEMP_PATTERNS: &[&str] = &["spd hub"];

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn read_u32(base: *const u8, offset: usize) -> u32 {
    unsafe { std::ptr::read_unaligned(base.add(offset) as *const u32) }
}

unsafe fn read_i64(base: *const u8, offset: usize) -> i64 {
    unsafe { std::ptr::read_unaligned(base.add(offset) as *const i64) }
}

unsafe fn read_f64(base: *const u8, offset: usize) -> f64 {
    unsafe { std::ptr::read_unaligned(base.add(offset) as *const f64) }
}

// HWiNFO's char[] label fields are NUL-terminated within their fixed-size buffer (ANSI/UTF-8
// in practice for the Latin sensor names this project matches against) - anything after the
// first NUL, if any, is padding, not part of the name.
unsafe fn read_fixed_str(base: *const u8, offset: usize, len: usize) -> String {
    let slice = unsafe { std::slice::from_raw_parts(base.add(offset), len) };
    let nul_pos = slice.iter().position(|&b| b == 0).unwrap_or(len);
    String::from_utf8_lossy(&slice[..nul_pos]).into_owned()
}

fn matches_any(name_lower: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| name_lower.contains(p))
}

// Reads the three fields this project can use from HWiNFO's shared memory, or None entirely if
// HWiNFO isn't running, "Shared Memory Support" isn't enabled in its settings (Options > Shared
// Memory Support - the same kind of one-time manual step already required for LibreHardwareMonitor's
// Remote Web Server), or the data it holds has gone stale. This never panics on a missing/
// misbehaving source - every failure path returns None, the same graceful-degradation contract
// the LHM integration already has.
pub fn read_hwinfo() -> Option<HwInfoResult> {
    let name = to_wide(SHARED_MEM_NAME);
    let handle = unsafe { OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(name.as_ptr())) }.ok()?;

    // MapViewOfFile with a 0 byte count maps from the given offset (0 here) to the end of the
    // mapping as HWiNFO originally sized it - the only practical option, since nothing here
    // knows that size in advance without first mapping it.
    let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0) };
    if view.Value.is_null() {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return None;
    }

    let result = unsafe { parse_shared_memory(view.Value as *const u8) };

    unsafe {
        let _ = UnmapViewOfFile(view);
        let _ = CloseHandle(handle);
    }

    result
}

unsafe fn parse_shared_memory(base: *const u8) -> Option<HwInfoResult> {
    // A too-small mapping (shouldn't happen for a real HWiNFO segment, but this is
    // reverse-engineered, unversioned-here memory, not a type-checked API) would make even the
    // header read past the mapped region - there's no length available from MapViewOfFile
    // itself to check against, so the magic check below is the first real signal of "this
    // isn't what we think it is," same as it would be for a genuinely wrong/stale mapping.
    let magic = unsafe { read_u32(base, OFF_MAGIC) };
    if magic != HEADER_MAGIC {
        eprintln!(
            "[pulse-telemetry] hwinfo: shared memory opened but magic {magic:#010x} != expected {HEADER_MAGIC:#010x} - not treating this as real HWiNFO data."
        );
        return None;
    }

    let last_update = unsafe { read_i64(base, OFF_LAST_UPDATE) };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let age_secs = now - last_update;
    if age_secs > MAX_STALENESS_SECS || age_secs < -MAX_STALENESS_SECS {
        // Negative (HWiNFO's clock ahead of this machine's, or a garbage read) is just as much
        // "don't trust this" as positive staleness - either way this isn't a fresh live reading.
        eprintln!(
            "[pulse-telemetry] hwinfo: last_update is {age_secs}s old (> {MAX_STALENESS_SECS}s threshold) - treating as stale/not running rather than serving frozen readings. This is what covers the free version's 12-hour shared-memory cutoff."
        );
        return None;
    }

    let entry_section_offset = unsafe { read_u32(base, OFF_ENTRY_SECTION_OFFSET) } as usize;
    let entry_element_size = unsafe { read_u32(base, OFF_ENTRY_ELEMENT_SIZE) } as usize;
    let entry_element_count = unsafe { read_u32(base, OFF_ENTRY_ELEMENT_COUNT) } as usize;

    let mut out = HwInfoResult::default();

    for i in 0..entry_element_count {
        let entry_base = unsafe { base.add(entry_section_offset + i * entry_element_size) };
        let sensor_type = unsafe { read_u32(entry_base, ENTRY_OFF_TYPE) };

        // Only Voltage/Temperature/Fan readings are ever candidates for the three fields this
        // project wants - skip everything else (Current/Power/Clock/Usage/Other) without even
        // reading their names.
        if sensor_type != SENSOR_TYPE_VOLTAGE && sensor_type != SENSOR_TYPE_TEMPERATURE && sensor_type != SENSOR_TYPE_FAN {
            continue;
        }

        let name_user = unsafe { read_fixed_str(entry_base, ENTRY_OFF_NAME_USER, ENTRY_NAME_LEN) };
        let name_original = unsafe { read_fixed_str(entry_base, ENTRY_OFF_NAME_ORIGINAL, ENTRY_NAME_LEN) };
        // Checked together (not just one field) since either can carry the vendor-meaningful
        // label depending on whether the user renamed the sensor in HWiNFO's UI.
        let name_lower = format!("{name_user} {name_original}").to_lowercase();

        // Opt-in diagnostic (set HWINFO_DEBUG_DUMP=1) - dumps every Voltage/Temperature/Fan
        // entry's real name and value, exactly as HWiNFO reports them on this specific machine.
        // Used to derive/extend CPU_VOLTAGE_PATTERNS/MOTHERBOARD_TEMP_PATTERNS/FAN_PATTERNS
        // above against real hardware rather than guessing - e.g. this is what showed a hybrid
        // P-core/E-core Intel laptop reporting per-core "P-core N VID"/"E-core N VID" instead of
        // a single "CPU Core"/"VCORE" reading, and "PCH Temperature"/"SPD Hub Temperature"
        // instead of "Motherboard"/"System" - genuinely different sensor topology, not a mismatch
        // this pattern list should paper over by guessing which per-core reading is "the" one.
        if std::env::var("HWINFO_DEBUG_DUMP").is_ok() {
            let value = unsafe { read_f64(entry_base, ENTRY_OFF_VALUE) };
            eprintln!(
                "[hwinfo-debug] type={sensor_type} name_user={name_user:?} name_original={name_original:?} value={value}"
            );
        }

        if sensor_type == SENSOR_TYPE_VOLTAGE && out.cpu_voltage.is_none() && matches_any(&name_lower, CPU_VOLTAGE_PATTERNS) {
            let value = unsafe { read_f64(entry_base, ENTRY_OFF_VALUE) };
            out.cpu_voltage = Some(HwInfoReading { value, name_user, name_original });
            continue;
        }
        if sensor_type == SENSOR_TYPE_TEMPERATURE && out.motherboard_temp_c.is_none() && matches_any(&name_lower, MOTHERBOARD_TEMP_PATTERNS) {
            let value = unsafe { read_f64(entry_base, ENTRY_OFF_VALUE) };
            out.motherboard_temp_c = Some(HwInfoReading { value, name_user, name_original });
            continue;
        }
        if sensor_type == SENSOR_TYPE_FAN {
            let value = unsafe { read_f64(entry_base, ENTRY_OFF_VALUE) };
            if value >= 80.0 && value <= 20000.0 {
                let named = matches_any(&name_lower, FAN_PATTERNS) || name_lower.contains("fan");
                if named && (out.fan_rpm.is_none() || value > out.fan_rpm.as_ref().map(|r| r.value).unwrap_or(0.0)) {
                    out.fan_rpm = Some(HwInfoReading { value, name_user, name_original });
                }
            }
            continue;
        }

        // Additive, honestly-named facts - never collapsed into cpu_voltage/motherboard_temp_c
        // above, and not mutually exclusive with them (a reading could in principle match both
        // an old pattern and a new one; `continue`s above mean the old fields still win their
        // own match first, but none of PER_CORE_VOLTAGE_PATTERN/PCH/SPD_HUB actually overlaps
        // CPU_VOLTAGE_PATTERNS/MOTHERBOARD_TEMP_PATTERNS on real hardware seen so far).
        if sensor_type == SENSOR_TYPE_VOLTAGE && name_lower.contains(PER_CORE_VOLTAGE_PATTERN) {
            let value = unsafe { read_f64(entry_base, ENTRY_OFF_VALUE) };
            let label = if name_user.is_empty() { name_original } else { name_user };
            out.per_core_voltages.push(PerCoreVoltage { label, volts: value });
            continue;
        }
        if sensor_type == SENSOR_TYPE_TEMPERATURE && out.pch_temp_c.is_none() && matches_any(&name_lower, PCH_TEMP_PATTERNS) {
            out.pch_temp_c = Some(unsafe { read_f64(entry_base, ENTRY_OFF_VALUE) });
            continue;
        }
        if sensor_type == SENSOR_TYPE_TEMPERATURE && out.spd_hub_temp_c.is_none() && matches_any(&name_lower, SPD_HUB_TEMP_PATTERNS) {
            out.spd_hub_temp_c = Some(unsafe { read_f64(entry_base, ENTRY_OFF_VALUE) });
        }
    }

    Some(out)
}
