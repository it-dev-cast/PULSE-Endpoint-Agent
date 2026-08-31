mod hwinfo;

use std::collections::HashMap;
use std::process::Command;
use std::thread;

use serde::Deserialize;
use serde_json::json;
use starship_battery::units::electric_potential::volt;
use starship_battery::units::energy::watt_hour;
use starship_battery::units::ratio::percent;
use starship_battery::units::thermodynamic_temperature::degree_celsius;
use sysinfo::{Disks, System};
use winreg::enums::HKEY_LOCAL_MACHINE;
use winreg::RegKey;
use wmi::{COMLibrary, FilterValue, WMIConnection, WMIError};

// Rounding an f32-origin value with plain arithmetic (x * 100.0).round() / 100.0 still leaves
// binary float noise when re-widened to f64 for JSON (e.g. 84.29000091552734 instead of 84.29) -
// formatting to a fixed-precision string and reparsing gives the actual shortest f64 that prints
// as "84.29", which is what a value genuinely meant to be shown as "84.29" should serialize as.
fn round2(value: f32) -> f64 {
    format!("{value:.2}").parse().unwrap()
}

fn main() {
    let mut sys = System::new_all();

    // CPU usage is a delta since the last refresh, so reading it immediately after new_all()
    // gives a meaningless first sample - sysinfo's own docs call for waiting
    // MINIMUM_CPU_UPDATE_INTERVAL and refreshing again before the number means anything.
    thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let cpus = sys.cpus();
    let first_cpu = cpus.first();

    let cpu = json!({
        // Field names match get-telemetry.ps1's Win32_Processor shape (Manufacturer, Name,
        // NumberOfCores, NumberOfLogicalProcessors, CurrentClockSpeed, LoadPercentage) so this
        // could eventually slot into the same payload without renaming on the consumer side.
        // L2CacheSize/L3CacheSize/MaxClockSpeed are left out entirely - sysinfo doesn't expose
        // them, and this first slice doesn't fabricate values WMI would have provided.
        "Manufacturer": first_cpu.map(|c| c.vendor_id().to_string()),
        "Name": first_cpu.map(|c| c.brand().to_string()),
        "NumberOfCores": sys.physical_core_count(),
        "NumberOfLogicalProcessors": cpus.len(),
        "CurrentClockSpeed": first_cpu.map(|c| c.frequency()),
        "LoadPercentage": sys.global_cpu_usage().round() as i64,
    });

    let memory = json!({
        // total/used/free in KB, matching get-telemetry.ps1's memory.totalKB/freeKB naming.
        // Its freeKB comes from Win32_OperatingSystem.FreePhysicalMemory; sysinfo's
        // free_memory() is the closest native-API equivalent on Windows, not guaranteed to be
        // byte-identical since the two APIs define "free" slightly differently.
        "totalKB": sys.total_memory() / 1024,
        "usedKB": sys.used_memory() / 1024,
        "freeKB": sys.free_memory() / 1024,
    });

    // sysinfo's Disks API works at the filesystem/volume level (statvfs/GetDiskFreeSpaceEx
    // territory), not the physical-drive level - it has no concept of a physical disk's
    // model/serial/interface. get-telemetry.ps1's storage.Model, .SerialNumber, .InterfaceType,
    // and .MediaType all come from Win32_DiskDrive, a completely different Windows API surface
    // that this crate doesn't wrap. Rather than leave those keys out silently (which would look
    // like a bug when compared side-by-side with the PowerShell payload) or fake them, they're
    // omitted entirely and called out below in the printed output.
    //
    // A genuine future option for physical-drive identity: the `windows` crate's raw
    // DeviceIoControl bindings to send IOCTL_STORAGE_QUERY_PROPERTY, which is exactly what
    // smartctl/WMI use under the hood - real, not excessive, but a separate unsafe-FFI slice of
    // work, not something to bolt onto this round.
    let disks = Disks::new_with_refreshed_list();
    let storage: Vec<_> = disks
        .list()
        .iter()
        .map(|d| {
            json!({
                "name": d.name().to_string_lossy(),
                "totalSpaceBytes": d.total_space(),
                "availableSpaceBytes": d.available_space(),
                "fileSystem": d.file_system().to_string_lossy(),
                "isRemovable": d.is_removable(),
            })
        })
        .collect();

    // sysinfo has no battery API at all (confirmed last round against its own src/lib.rs
    // exports) - starship-battery (the actively-maintained fork of the old `battery` crate) is
    // the real Rust-ecosystem equivalent of root\wmi's BatteryStatus/BatteryStaticData. Its
    // Battery struct also exposes vendor()/model()/serial_number()/technology()/temperature()/
    // energy_rate()/time_to_full()/time_to_empty() (all checked directly against
    // types/battery.rs) - genuinely available, just not asked for this round, so not added here
    // to keep this slice matching exactly what was requested.
    let battery: Vec<serde_json::Value> = match starship_battery::Manager::new() {
        Ok(manager) => match manager.batteries() {
            Ok(batteries) => {
                let mut out = Vec::new();
                for (i, result) in batteries.enumerate() {
                    match result {
                        Ok(b) => {
                            let energy_full_wh = b.energy_full().get::<watt_hour>();
                            let energy_full_design_wh = b.energy_full_design().get::<watt_hour>();
                            // Same formula as src/app/lib/derived.ts's getBatteryHealthPercent
                            // WMI tier: round(fullChargedCapacity / designedCapacity * 100).
                            // Guarded against a zero/negative design value, which would be a
                            // genuinely broken reading, not divide-by-zero-as-100%.
                            let health_percent = if energy_full_design_wh > 0.0 {
                                Some(((energy_full_wh / energy_full_design_wh) * 100.0).round() as i64)
                            } else {
                                None
                            };

                            // cycle_count() is Option<u32> - None means "this battery/driver
                            // doesn't report cycle count at all," which is common. Serializing
                            // it straight through (null vs. a real number, including a real 0)
                            // keeps that distinction intact instead of collapsing None into 0.
                            out.push(json!({
                                "chargePercent": b.state_of_charge().get::<percent>().round() as i64,
                                "state": b.state().to_string(),
                                "voltageV": round2(b.voltage().get::<volt>()),
                                "energyFullWh": round2(energy_full_wh),
                                "energyFullDesignWh": round2(energy_full_design_wh),
                                "healthPercent": health_percent,
                                "cycleCount": b.cycle_count(),
                                // Windows exposes this as BatteryStatus.Temperature (tenths of a
                                // Kelvin) when the EC reports it; None when this pack/driver
                                // doesn't - never a made-up Celsius value.
                                "temperatureC": b
                                    .temperature()
                                    .map(|t| round2(t.get::<degree_celsius>() as f32)),
                            }));
                        }
                        Err(e) => {
                            eprintln!("[pulse-telemetry] battery: skipping battery #{i}, backend returned an error reading it: {e}");
                        }
                    }
                }
                if out.is_empty() {
                    eprintln!("[pulse-telemetry] battery: Manager reported zero batteries on this system (not an error - just none found).");
                }
                out
            }
            Err(e) => {
                eprintln!("[pulse-telemetry] battery: Manager::batteries() failed: {e} - battery array left empty rather than guessed.");
                Vec::new()
            }
        },
        Err(e) => {
            eprintln!("[pulse-telemetry] battery: Manager::new() failed: {e} - battery array left empty rather than guessed.");
            Vec::new()
        }
    };

    // sysinfo has no TPM API either (same category of gap as battery). The wmi crate can query
    // the exact same root\cimv2\Security\MicrosoftTpm -> Win32_Tpm class get-telemetry.ps1
    // already uses successfully, rather than reaching for raw TSS/ESAPI TPM stack bindings,
    // which would be a much bigger, separate undertaking.
    //
    // The wmi crate builds "SELECT <fields> FROM <TypeName>" straight from this struct's name
    // and field names, so both have to match the real WMI class/property names exactly.
    #[derive(Deserialize, Debug)]
    #[allow(non_camel_case_types, non_snake_case)]
    struct Win32_Tpm {
        IsActivated_InitialValue: bool,
        IsEnabled_InitialValue: bool,
        ManufacturerIdTxt: String,
        SpecVersion: String,
    }

    // The two HRESULTs this namespace is documented to return when the calling process isn't
    // elevated - get-telemetry.ps1 hit exactly this failure mode before it was guaranteed to run
    // elevated (see README's Scheduled Task section). Checked explicitly so an elevation problem
    // never gets reported as "no TPM present."
    const WBEM_E_ACCESS_DENIED: i32 = 0x8004_1003_u32 as i32;
    const E_ACCESSDENIED: i32 = 0x8007_0005_u32 as i32;
    let is_access_denied = |hres: i32| hres == WBEM_E_ACCESS_DENIED || hres == E_ACCESSDENIED;

    let tpm: Option<serde_json::Value> = (|| {
        let com_lib = match COMLibrary::new() {
            Ok(c) => c,
            Err(e) => {
                eprintln!(
                    "[pulse-telemetry] tpm: COM initialization failed: {e} - not TPM-specific, something is wrong with COM in this process."
                );
                return None;
            }
        };

        let con = match WMIConnection::with_namespace_path("ROOT\\CIMV2\\Security\\MicrosoftTpm", com_lib) {
            Ok(c) => c,
            Err(WMIError::HResultError { hres }) if is_access_denied(hres) => {
                eprintln!(
                    "[pulse-telemetry] tpm: ACCESS DENIED connecting to ROOT\\CIMV2\\Security\\MicrosoftTpm (hres {hres:#X}). This process needs to run elevated - same requirement get-telemetry.ps1 has. This does NOT mean no TPM is present."
                );
                return None;
            }
            Err(e) => {
                eprintln!("[pulse-telemetry] tpm: failed to connect to the TPM WMI namespace: {e}");
                return None;
            }
        };

        match con.query::<Win32_Tpm>() {
            Ok(rows) => match rows.into_iter().next() {
                Some(t) => Some(json!({
                    "isActivated": t.IsActivated_InitialValue,
                    "isEnabled": t.IsEnabled_InitialValue,
                    "manufacturer": t.ManufacturerIdTxt,
                    "specVersion": t.SpecVersion,
                })),
                None => {
                    eprintln!(
                        "[pulse-telemetry] tpm: query succeeded but returned 0 instances - genuinely NO TPM CHIP PRESENT on this hardware (a real result, not an error)."
                    );
                    None
                }
            },
            Err(WMIError::HResultError { hres }) if is_access_denied(hres) => {
                eprintln!(
                    "[pulse-telemetry] tpm: ACCESS DENIED running the Win32_Tpm query (hres {hres:#X}). This process needs to run elevated. This does NOT mean no TPM is present."
                );
                None
            }
            Err(e) => {
                eprintln!("[pulse-telemetry] tpm: Win32_Tpm query failed: {e}");
                None
            }
        }
    })();

    // sysinfo has no dedicated GPU API. Its Components API (the same one used for CPU temps
    // elsewhere in this ecosystem) was checked directly on this machine via a throwaway probe
    // before writing this, rather than assumed - it returned ZERO components total, not just
    // "no GPU-labeled ones." So there's nothing to incidentally reuse there; this is WMI
    // (Win32_VideoController) territory, same as TPM, and this project already leans on
    // LibreHardwareMonitor elsewhere for exactly this reason - sysinfo/WMI don't expose real
    // per-component sensor data on this hardware.
    //
    // Name/AdapterRAM/DriverVersion/AdapterCompatibility are all Option<T> here (not required)
    // because WMI properties are nullable per-instance - a basic/virtual adapter reporting null
    // for one of these shouldn't take down deserialization of the whole result set.
    #[derive(Deserialize, Debug)]
    #[allow(non_camel_case_types, non_snake_case)]
    struct Win32_VideoController {
        Name: Option<String>,
        AdapterRAM: Option<u32>,
        DriverVersion: Option<String>,
        AdapterCompatibility: Option<String>,
    }

    let gpu: Vec<serde_json::Value> = (|| {
        let com_lib = match COMLibrary::new() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[pulse-telemetry] gpu: COM initialization failed: {e} - not GPU-specific, something is wrong with COM in this process.");
                return Vec::new();
            }
        };

        // Default ROOT\CIMV2 namespace, unlike TPM's special Security\MicrosoftTpm one - Win32_
        // VideoController is a standard inventory class and isn't expected to need elevation.
        let con = match WMIConnection::new(com_lib) {
            Ok(c) => c,
            Err(WMIError::HResultError { hres }) if is_access_denied(hres) => {
                eprintln!(
                    "[pulse-telemetry] gpu: ACCESS DENIED connecting to ROOT\\CIMV2 (hres {hres:#X}) - unexpected; this namespace normally doesn't require elevation, so treat this as a new, real finding rather than assuming it's the same TPM requirement."
                );
                return Vec::new();
            }
            Err(e) => {
                eprintln!("[pulse-telemetry] gpu: failed to connect to WMI: {e}");
                return Vec::new();
            }
        };

        match con.query::<Win32_VideoController>() {
            Ok(rows) => rows
                .into_iter()
                .map(|g| {
                    // Win32_VideoController.AdapterRAM is a 32-bit WMI property (max ~4 GiB) -
                    // documented to wrap or report a sentinel on GPUs with 4GB+ VRAM, which
                    // includes plenty of real discrete cards. 0 and u32::MAX are the two known
                    // wrap/sentinel symptoms; flagged rather than silently trusted as real VRAM.
                    let adapter_ram_unreliable = matches!(g.AdapterRAM, Some(0) | Some(u32::MAX));
                    if adapter_ram_unreliable {
                        eprintln!(
                            "[pulse-telemetry] gpu: {} reported AdapterRAM={:?} - this is one of the known wrap/sentinel values for this 32-bit property, not necessarily this card's real VRAM size.",
                            g.Name.as_deref().unwrap_or("<unnamed adapter>"),
                            g.AdapterRAM
                        );
                    }
                    json!({
                        "name": g.Name,
                        "adapterRAMBytes": g.AdapterRAM,
                        "adapterRAMUnreliable": adapter_ram_unreliable,
                        "driverVersion": g.DriverVersion,
                        "adapterCompatibility": g.AdapterCompatibility,
                    })
                })
                .collect(),
            Err(WMIError::HResultError { hres }) if is_access_denied(hres) => {
                eprintln!(
                    "[pulse-telemetry] gpu: ACCESS DENIED running the Win32_VideoController query (hres {hres:#X}) - unexpected for this class, a new finding rather than an assumed requirement."
                );
                Vec::new()
            }
            Err(e) => {
                eprintln!("[pulse-telemetry] gpu: Win32_VideoController query failed: {e}");
                Vec::new()
            }
        }
    })();

    // sysinfo does have a real Networks API (Networks::list() -> HashMap<String, NetworkData>),
    // checked directly against common/network.rs and empirically probed on this machine before
    // writing this. It genuinely exposes mac_address() and ip_networks(), so it's not useless -
    // but the HashMap key it uses for the interface (on this machine: "Wi-Fi 2", confirmed via
    // that probe) is the OS-assigned connection name from GetAdaptersAddresses, not the
    // driver/product name Win32_NetworkAdapter.Name returns - the two are documented to differ
    // on Windows and there's no reliable way to join them by string match. sysinfo also has no
    // AdapterType or PhysicalAdapter/NetConnectionStatus equivalent at all, which is exactly the
    // filter get-telemetry.ps1 relies on to pick "the real, currently-connected adapter" instead
    // of every virtual/tunnel/disabled one Windows reports. So this round uses WMI alone for
    // name/MAC/type - it already provides all three cleanly, matching get-telemetry.ps1 exactly,
    // and merging in sysinfo's data by a name that can't be reliably matched would risk pairing
    // the wrong MAC to the wrong adapter silently, which is worse than not merging at all.
    #[derive(Deserialize, Debug)]
    #[allow(non_camel_case_types, non_snake_case)]
    struct Win32_NetworkAdapter {
        Name: Option<String>,
        MACAddress: Option<String>,
        AdapterType: Option<String>,
    }

    let network: Vec<serde_json::Value> = (|| {
        let com_lib = match COMLibrary::new() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[pulse-telemetry] network: COM initialization failed: {e} - not network-specific, something is wrong with COM in this process.");
                return Vec::new();
            }
        };

        let con = match WMIConnection::new(com_lib) {
            Ok(c) => c,
            Err(WMIError::HResultError { hres }) if is_access_denied(hres) => {
                eprintln!(
                    "[pulse-telemetry] network: ACCESS DENIED connecting to ROOT\\CIMV2 (hres {hres:#X}) - unexpected; this namespace normally doesn't require elevation."
                );
                return Vec::new();
            }
            Err(e) => {
                eprintln!("[pulse-telemetry] network: failed to connect to WMI: {e}");
                return Vec::new();
            }
        };

        // Same filter get-telemetry.ps1 applies client-side with Where-Object - done here as a
        // real WQL WHERE clause instead, so only physical, currently-connected adapters come
        // back (NetConnectionStatus 2 = "Connected"), not every virtual/disabled adapter Windows
        // also reports through this class.
        let mut filters: HashMap<String, FilterValue> = HashMap::new();
        filters.insert("PhysicalAdapter".to_owned(), FilterValue::Bool(true));
        filters.insert("NetConnectionStatus".to_owned(), FilterValue::Number(2));

        match con.filtered_query::<Win32_NetworkAdapter>(&filters) {
            Ok(rows) => rows
                .into_iter()
                .map(|a| {
                    json!({
                        "name": a.Name,
                        "macAddress": a.MACAddress,
                        "adapterType": a.AdapterType,
                    })
                })
                .collect(),
            Err(WMIError::HResultError { hres }) if is_access_denied(hres) => {
                eprintln!(
                    "[pulse-telemetry] network: ACCESS DENIED running the filtered Win32_NetworkAdapter query (hres {hres:#X}) - unexpected for this class."
                );
                Vec::new()
            }
            Err(e) => {
                eprintln!("[pulse-telemetry] network: Win32_NetworkAdapter query failed: {e}");
                Vec::new()
            }
        }
    })();
    // NOT included: Wi-Fi signal strength and link speed. get-telemetry.ps1 gets these by
    // parsing `netsh wlan show interfaces` text output - confirmed (per this project's own
    // earlier build notes) there's no clean WMI or sysinfo equivalent, it's a genuine
    // text-parsing problem on Windows. Not replicated here rather than approximated - this is a
    // real, known gap, same one the PowerShell version already has to work around this way.

    // BitLocker's real data lives in Win32_EncryptableVolume, under the
    // root\cimv2\Security\MicrosoftVolumeEncryption namespace - what Get-BitLockerVolume wraps
    // under the hood (already confirmed elsewhere in this project to need elevation). Whether
    // read-only WMI access to THIS class needs the same elevation is a genuinely open question,
    // same as Secure Boot's registry read was - not assumed either way, tested for real below.
    //
    // Filtered server-side to the system drive (DriveLetter, e.g. "C:") the same way
    // get-telemetry.ps1 filters client-side to $env:SystemDrive, rather than grabbing every
    // volume Win32_EncryptableVolume knows about.
    #[derive(Deserialize, Debug)]
    #[allow(non_camel_case_types, non_snake_case)]
    struct Win32_EncryptableVolume {
        ProtectionStatus: u32,
    }

    // Distinct from access-denied: these are the HRESULTs for "this namespace/class genuinely
    // isn't registered on this system" (e.g. some Windows Home editions without BitLocker
    // support), not "exists but you're not allowed to see it."
    const WBEM_E_NOT_FOUND: i32 = 0x8004_1002_u32 as i32;
    const WBEM_E_INVALID_NAMESPACE: i32 = 0x8004_100E_u32 as i32;
    const WBEM_E_INVALID_CLASS: i32 = 0x8004_1010_u32 as i32;
    let is_not_supported =
        |hres: i32| hres == WBEM_E_NOT_FOUND || hres == WBEM_E_INVALID_NAMESPACE || hres == WBEM_E_INVALID_CLASS;

    let bitlocker_status: Option<&'static str> = (|| {
        let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_owned());

        let com_lib = match COMLibrary::new() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[pulse-telemetry] bitlocker: COM initialization failed: {e} - not BitLocker-specific, something is wrong with COM in this process.");
                return None;
            }
        };

        let con = match WMIConnection::with_namespace_path(
            "ROOT\\CIMV2\\Security\\MicrosoftVolumeEncryption",
            com_lib,
        ) {
            Ok(c) => c,
            Err(WMIError::HResultError { hres }) if is_access_denied(hres) => {
                eprintln!(
                    "[pulse-telemetry] bitlocker: ACCESS DENIED connecting to ROOT\\CIMV2\\Security\\MicrosoftVolumeEncryption (hres {hres:#X}) - this process needs to run elevated, the same requirement Get-BitLockerVolume has. This does NOT mean BitLocker is unsupported or off."
                );
                return None;
            }
            Err(WMIError::HResultError { hres }) if is_not_supported(hres) => {
                eprintln!(
                    "[pulse-telemetry] bitlocker: the MicrosoftVolumeEncryption namespace does not exist on this system (hres {hres:#X}) - genuinely NO BITLOCKER SUPPORT on this Windows edition (e.g. some Home editions). A real result, not an access problem."
                );
                return None;
            }
            Err(e) => {
                eprintln!("[pulse-telemetry] bitlocker: failed to connect to the BitLocker WMI namespace: {e}");
                return None;
            }
        };

        let mut filters: HashMap<String, FilterValue> = HashMap::new();
        filters.insert("DriveLetter".to_owned(), FilterValue::String(system_drive.clone()));

        match con.filtered_query::<Win32_EncryptableVolume>(&filters) {
            Ok(rows) => match rows.into_iter().next() {
                Some(v) => match v.ProtectionStatus {
                    0 => Some("unprotected"),
                    1 => Some("protected"),
                    2 => Some("unknown"),
                    other => {
                        eprintln!(
                            "[pulse-telemetry] bitlocker: {system_drive} returned an undocumented ProtectionStatus value ({other}) - not one of the documented 0/1/2, reporting as null rather than guessing which state it means."
                        );
                        None
                    }
                },
                None => {
                    eprintln!(
                        "[pulse-telemetry] bitlocker: query succeeded but returned 0 instances for drive {system_drive} - the class and namespace exist and access was fine, but no Win32_EncryptableVolume matched this drive letter."
                    );
                    None
                }
            },
            Err(WMIError::HResultError { hres }) if is_access_denied(hres) => {
                eprintln!(
                    "[pulse-telemetry] bitlocker: ACCESS DENIED running the Win32_EncryptableVolume query (hres {hres:#X}). This process needs to run elevated. This does NOT mean BitLocker is unsupported or off."
                );
                None
            }
            Err(WMIError::HResultError { hres }) if is_not_supported(hres) => {
                eprintln!(
                    "[pulse-telemetry] bitlocker: Win32_EncryptableVolume is not available on this system (hres {hres:#X}) - genuinely NO BITLOCKER SUPPORT on this Windows edition. A real result, not an access problem."
                );
                None
            }
            Err(e) => {
                eprintln!("[pulse-telemetry] bitlocker: Win32_EncryptableVolume query failed: {e}");
                None
            }
        }
    })();

    // Two real candidate sources exist for Secure Boot status on Windows. PowerShell's
    // Confirm-SecureBootUEFI has no direct WMI equivalent and is already confirmed elsewhere in
    // this project to need elevation. The registry value below is the other real source, tried
    // first specifically to check honestly whether read-only access to it needs elevation too -
    // read access to system registry keys is sometimes allowed for standard users even when the
    // equivalent cmdlet isn't, so this isn't assumed either way going in.
    //
    // Errors are matched on raw_os_error() rather than io::ErrorKind - checking the actual Win32
    // code directly (2/3 = not found, 5 = access denied) is exactly as explicit as matching
    // WMI's HRESULTs by value above, rather than trusting std's Kind categorization to stay
    // mapped the same way.
    let secure_boot_enabled: Option<bool> = {
        const SECURE_BOOT_KEY: &str = "SYSTEM\\CurrentControlSet\\Control\\SecureBoot\\State";
        const SECURE_BOOT_VALUE: &str = "UEFISecureBootEnabled";

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        match hklm.open_subkey(SECURE_BOOT_KEY) {
            Ok(key) => match key.get_value::<u32, _>(SECURE_BOOT_VALUE) {
                Ok(v) => Some(v != 0),
                Err(e) => {
                    match e.raw_os_error() {
                        Some(2) | Some(3) => eprintln!(
                            "[pulse-telemetry] secureBoot: {SECURE_BOOT_KEY} opened fine but its {SECURE_BOOT_VALUE} value is missing - unusual (the key existing normally implies the value does too), not an access problem."
                        ),
                        Some(5) => eprintln!(
                            "[pulse-telemetry] secureBoot: ACCESS DENIED reading {SECURE_BOOT_VALUE} (raw os error 5), even though opening the key itself succeeded. This process needs to run elevated to read this specific value. This does NOT mean Secure Boot capability is absent."
                        ),
                        _ => eprintln!("[pulse-telemetry] secureBoot: failed to read {SECURE_BOOT_VALUE}: {e}"),
                    }
                    None
                }
            },
            Err(e) => {
                match e.raw_os_error() {
                    Some(2) | Some(3) => eprintln!(
                        "[pulse-telemetry] secureBoot: {SECURE_BOOT_KEY} does not exist - genuinely NO SECURE BOOT CAPABILITY on this system (common on legacy BIOS/non-UEFI machines). A real result, not a read error."
                    ),
                    Some(5) => eprintln!(
                        "[pulse-telemetry] secureBoot: ACCESS DENIED opening {SECURE_BOOT_KEY} (raw os error 5). This process needs to run elevated to read this key. This does NOT mean Secure Boot capability is absent."
                    ),
                    _ => eprintln!("[pulse-telemetry] secureBoot: failed to open {SECURE_BOOT_KEY}: {e}"),
                }
                None
            }
        }
    };

    // Real storage health (SMART) via smartctl.exe, the same tool get-telemetry.ps1 already
    // shells out to - not a corner cut. smartctl already handles the genuinely messy
    // cross-vendor NVMe/SATA differences (device discovery, protocol quirks, per-vendor SMART
    // layouts); reimplementing that via raw DeviceIoControl/IOCTL_STORAGE_QUERY_PROPERTY would
    // be significant, error-prone systems work for a case an already-installed, already-proven
    // tool already solves correctly - the same category of choice already made for CPU/battery/
    // network (sysinfo/starship-battery/wmi over hand-rolled WMI/ioctl calls).
    #[derive(Deserialize)]
    struct ScanDevice {
        name: String,
        #[serde(rename = "type")]
        device_type: String,
    }
    #[derive(Deserialize)]
    struct ScanResult {
        devices: Vec<ScanDevice>,
    }

    // Mirrors get-telemetry.ps1's `Get-Command smartctl.exe` check - a manual PATH walk instead
    // of just trying to spawn "smartctl.exe" and catching NotFound, so the resolved path can be
    // logged (parity with the PS side's `[diag] smartctlPath: ...` line) and the exact same
    // resolved binary is used for both the scan and the health query below, not just "whatever
    // Command happens to find" twice independently.
    fn find_smartctl() -> Option<std::path::PathBuf> {
        let path_var = std::env::var_os("PATH")?;
        std::env::split_paths(&path_var)
            .map(|dir| dir.join("smartctl.exe"))
            .find(|candidate| candidate.is_file())
    }

    let storage_health: Option<serde_json::Value> = (|| {
        let smartctl_path = match find_smartctl() {
            Some(p) => {
                eprintln!("[pulse-telemetry] storageHealth: smartctl.exe found at {}", p.display());
                p
            }
            None => {
                eprintln!(
                    "[pulse-telemetry] storageHealth: smartctl.exe NOT FOUND on PATH - genuinely NOT INSTALLED, distinct from a query failure. Install smartmontools for real storage health data."
                );
                return None;
            }
        };

        let scan_output = match Command::new(&smartctl_path).args(["--scan", "-j"]).output() {
            Ok(o) => o,
            Err(e) => {
                eprintln!("[pulse-telemetry] storageHealth: failed to run smartctl --scan: {e}");
                return None;
            }
        };

        // smartctl's -j flag puts its full report on stdout even on a non-zero exit (confirmed
        // directly: an unelevated query here exits 2 with an error message embedded INSIDE
        // otherwise-valid JSON on stdout, stderr empty) - so stdout is parsed regardless of
        // exit status, rather than gating on it succeeding first.
        let scan_result: ScanResult = match serde_json::from_slice(&scan_output.stdout) {
            Ok(r) => r,
            Err(e) => {
                eprintln!(
                    "[pulse-telemetry] storageHealth: smartctl --scan produced unparseable JSON: {e} - raw stdout: {}",
                    String::from_utf8_lossy(&scan_output.stdout)
                );
                return None;
            }
        };

        let device = match scan_result.devices.first() {
            Some(d) => d,
            None => {
                eprintln!("[pulse-telemetry] storageHealth: smartctl --scan found no devices - genuinely NO SMART-CAPABLE DRIVE DETECTED, not a query failure.");
                return None;
            }
        };
        eprintln!("[pulse-telemetry] storageHealth: smartctl --scan found device: {} (type: {})", device.name, device.device_type);

        let health_output = match Command::new(&smartctl_path)
            .args(["-a", "-j", "-d", &device.device_type, &device.name])
            .output()
        {
            Ok(o) => o,
            Err(e) => {
                eprintln!("[pulse-telemetry] storageHealth: failed to run smartctl -a: {e}");
                return None;
            }
        };

        let report: serde_json::Value = match serde_json::from_slice(&health_output.stdout) {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "[pulse-telemetry] storageHealth: smartctl -a produced unparseable JSON: {e} - raw stdout: {}",
                    String::from_utf8_lossy(&health_output.stdout)
                );
                return None;
            }
        };

        // smartctl's own structured error reporting (its "messages" array with a severity, right
        // inside the JSON) is more precise than the PS side's broad text-pattern match against
        // several possible OS error strings for the same underlying problem - the real message
        // is just printed directly rather than guessed at. NVMe SMART access needing an elevated
        // process is a known, real requirement on Windows (confirmed elsewhere in this project),
        // but not assumed to be the cause here - the actual message is what's reported.
        let error_messages: Vec<&str> = report
            .pointer("/smartctl/messages")
            .and_then(|m| m.as_array())
            .map(|arr| arr.iter().filter_map(|m| m.get("string")?.as_str()).collect())
            .unwrap_or_default();
        if !error_messages.is_empty() {
            eprintln!(
                "[pulse-telemetry] storageHealth: smartctl -a reported error(s): {} - NVMe SMART queries typically need an elevated process on Windows, but that's not assumed here, just this real message.",
                error_messages.join("; ")
            );
        }

        let percentage_used = report.pointer("/nvme_smart_health_information_log/percentage_used").and_then(|v| v.as_i64());
        let temperature_c = report.pointer("/temperature/current").and_then(|v| v.as_i64());
        let power_on_hours = report.pointer("/nvme_smart_health_information_log/power_on_hours").and_then(|v| v.as_i64());

        if percentage_used.is_none() && temperature_c.is_none() && power_on_hours.is_none() {
            eprintln!(
                "[pulse-telemetry] storageHealth: query ran but none of percentage_used/temperature/power_on_hours were present - likely a non-NVMe drive (this parses the NVMe SMART log shape specifically, matching what get-telemetry.ps1/the frontend already read) or the query genuinely failed (see any error message above)."
            );
            return None;
        }

        Some(json!({
            // Inverted (100 - wear-used%) to a "health" framing, matching derived.ts's
            // storageWearToHealthPercent - a higher number reads as better, consistent with
            // every other health percentage in this project.
            "healthPercent": percentage_used.map(|p| 100 - p),
            "temperatureC": temperature_c,
            "powerOnHours": power_on_hours,
        }))
    })();

    // HWiNFO is a second, optional real source for exactly three fields this project previously
    // only had via LibreHardwareMonitor's Remote Web Server (see hwinfo.rs for the shared-memory
    // format itself). Reported as its own top-level key, not merged into `hardwareMonitor` here -
    // telemetry-server.mjs is what actually has both this and LHM's result to compare and prefer
    // whichever one is real per field.
    let hwinfo_result = hwinfo::read_hwinfo();
    let hwinfo_json = match &hwinfo_result {
        Some(r) => {
            eprintln!(
                "[pulse-telemetry] hwinfo: cpuVoltage={} motherboardTempC={} fanRpm={} perCoreVoltages={} pchTempC={} spdHubTempC={}",
                r.cpu_voltage
                    .as_ref()
                    .map(|v| format!("{:.3} (\"{}\" / \"{}\")", v.value, v.name_user, v.name_original))
                    .unwrap_or_else(|| "not found".to_string()),
                r.motherboard_temp_c
                    .as_ref()
                    .map(|v| format!("{:.1} (\"{}\" / \"{}\")", v.value, v.name_user, v.name_original))
                    .unwrap_or_else(|| "not found".to_string()),
                r.fan_rpm
                    .as_ref()
                    .map(|v| format!("{:.0} (\"{}\" / \"{}\")", v.value, v.name_user, v.name_original))
                    .unwrap_or_else(|| "not found".to_string()),
                r.per_core_voltages.len(),
                r.pch_temp_c.map(|v| format!("{v:.1}")).unwrap_or_else(|| "not found".to_string()),
                r.spd_hub_temp_c.map(|v| format!("{v:.1}")).unwrap_or_else(|| "not found".to_string()),
            );
            json!({
                "cpuVoltage": r.cpu_voltage.as_ref().map(|v| round2(v.value as f32)),
                "motherboardTempC": r.motherboard_temp_c.as_ref().map(|v| v.value.round() as i64),
                "fanRpm": r.fan_rpm.as_ref().map(|v| v.value.round() as i64),
                "perCoreVoltages": r.per_core_voltages.iter().map(|v| json!({
                    "label": v.label,
                    "volts": round2(v.volts as f32),
                })).collect::<Vec<_>>(),
                "pchTempC": r.pch_temp_c.map(|v| v.round() as i64),
                "spdHubTempC": r.spd_hub_temp_c.map(|v| v.round() as i64),
            })
        }
        None => {
            eprintln!(
                "[pulse-telemetry] hwinfo: not available (not running, \"Shared Memory Support\" not enabled in Options, or its data is stale) - install/run HWiNFO and enable Options > Shared Memory Support for CPU voltage, motherboard temp, and fan RPM as a second source alongside LibreHardwareMonitor."
            );
            serde_json::Value::Null
        }
    };

    let payload = json!({
        "cpu": cpu,
        "memory": memory,
        "storage": storage,
        "battery": battery,
        "tpm": tpm,
        "gpu": gpu,
        "network": network,
        "storageHealth": storage_health,
        "secureBootEnabled": secure_boot_enabled,
        "bitlockerStatus": bitlocker_status,
        "hwinfo": hwinfo_json,
    });

    println!("{}", serde_json::to_string_pretty(&payload).unwrap());
}
