$ErrorActionPreference = 'SilentlyContinue'

$sys = Get-CimInstance Win32_ComputerSystemProduct |
    Select-Object Vendor, Name, IdentifyingNumber, UUID

$bios = Get-CimInstance Win32_BIOS |
    Select-Object Manufacturer, SMBIOSBIOSVersion, ReleaseDate, SerialNumber

$cpuInfo = Get-CimInstance Win32_Processor |
    Select-Object -First 1 Manufacturer, Name, NumberOfCores, NumberOfLogicalProcessors,
        MaxClockSpeed, CurrentClockSpeed, L2CacheSize, L3CacheSize, LoadPercentage

$memModules = Get-CimInstance Win32_PhysicalMemory |
    Select-Object Manufacturer, PartNumber, SerialNumber, Capacity, Speed,
        ConfiguredClockSpeed, DeviceLocator, MemoryType

$os = Get-CimInstance Win32_OperatingSystem |
    Select-Object FreePhysicalMemory, TotalVisibleMemorySize

$disks = Get-CimInstance Win32_DiskDrive |
    Select-Object Model, SerialNumber, Size, InterfaceType, MediaType, Index, DeviceID

$battery = Get-CimInstance Win32_Battery |
    Select-Object Name, EstimatedChargeRemaining, BatteryStatus, DesignCapacity, FullChargeCapacity

# Win32_Battery.EstimatedRunTime uses a sentinel (71582788, ~136 years) when Windows can't
# currently calculate a real estimate (e.g. while charging) - that's not a real number, so it's
# normalized to $null rather than shown as a nonsensical multi-year countdown.
$batteryRunTimeRaw = (Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedRunTime).EstimatedRunTime
$batteryRunTimeMinutes = if ($null -ne $batteryRunTimeRaw -and $batteryRunTimeRaw -ne 71582788) { $batteryRunTimeRaw } else { $null }

$gpu = Get-CimInstance Win32_VideoController |
    Select-Object Name, AdapterRAM, DriverVersion, AdapterCompatibility

$net = Get-CimInstance Win32_NetworkAdapter |
    Where-Object {
        $_.PhysicalAdapter -eq $true -and $_.NetConnectionStatus -eq 2 -and
        $_.Name -notmatch "Tailscale|vEthernet|Virtual|Bluetooth|WAN Miniport"
    } |
    Sort-Object { if ($_.Name -match "Wi-Fi|Wireless") { 0 } else { 1 } } |
    Select-Object Name, MACAddress, AdapterType

$osDetail = Get-CimInstance Win32_OperatingSystem |
    Select-Object Caption, BuildNumber, Version, LastBootUpTime, OSArchitecture

$board = Get-CimInstance Win32_BaseBoard |
    Select-Object Product, SerialNumber

$enclosure = Get-CimInstance Win32_SystemEnclosure |
    Select-Object SMBIOSAssetTag

$thermalZones = @()
try {
    $thermalZones = @(Get-CimInstance -Namespace "root/wmi" -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop |
        Select-Object InstanceName, CurrentTemperature)
} catch {
    $thermalZones = @()
}

$tpm = $null
try {
    $tpm = Get-CimInstance -Namespace "root/cimv2/Security/MicrosoftTpm" -ClassName Win32_Tpm -ErrorAction Stop |
        Select-Object ManufacturerIdTxt, ManufacturerVersion, SpecVersion, IsActivated_InitialValue, IsEnabled_InitialValue
} catch {
    $tpm = $null
}

# Confirm-SecureBootUEFI throws outright on legacy BIOS (non-UEFI) systems, and can also require
# elevation beyond what's already guaranteed on some configurations - the catch handles both the
# same way, falling back to null/sample rather than distinguishing the reason.
$secureBootEnabled = $null
try {
    $secureBootEnabled = Confirm-SecureBootUEFI -ErrorAction Stop
} catch {
    $secureBootEnabled = $null
}

# Get-BitLockerVolume needs the BitLocker PowerShell module, which isn't present on all Windows
# editions (notably Home) - absent module or any other failure both fall back the same way.
$bitlockerStatus = $null
try {
    $volume = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop
    $bitlockerStatus = $volume.ProtectionStatus.ToString()
} catch {
    $bitlockerStatus = $null
}

# Get-ComputerInfo also exposes BiosFirmwareType, but it gathers a large amount of unrelated
# system info (hotfix lists, etc.) and is known to take several seconds - too slow for a poller
# on a 5s interval with a 15s timeout. $env:firmware_type is the same underlying data (set by
# Windows itself to "UEFI" or "Legacy"), read instantly with no query at all.
$bootMode = $null
try {
    $firmwareType = $env:firmware_type
    $bootMode = if ($firmwareType -eq "UEFI") { "UEFI" } elseif ($firmwareType -eq "Legacy") { "Legacy" } else { $null }
} catch {
    $bootMode = $null
}

# root/wmi battery classes — more reliable than Win32_Battery for voltage/health/cycle count,
# but genuinely absent on some OEMs/hardware, hence each wrapped independently.
$batteryStatus = $null
try {
    $batteryStatus = Get-CimInstance -Namespace "root/wmi" -ClassName BatteryStatus -ErrorAction Stop |
        Select-Object Voltage, ChargeRate, DischargeRate, RemainingCapacity, Charging, Discharging, PowerOnline, Critical
} catch {
    $batteryStatus = $null
}

$batteryStatic = $null
try {
    $batteryStatic = Get-CimInstance -Namespace "root/wmi" -ClassName BatteryStaticData -ErrorAction Stop |
        Select-Object DesignedCapacity, DeviceName, ManufactureDate
} catch {
    $batteryStatic = $null
}

$batteryFullCharge = $null
try {
    $batteryFullCharge = Get-CimInstance -Namespace "root/wmi" -ClassName BatteryFullChargedCapacity -ErrorAction Stop |
        Select-Object FullChargedCapacity
} catch {
    $batteryFullCharge = $null
}

$batteryCycle = $null
try {
    $batteryCycle = Get-CimInstance -Namespace "root/wmi" -ClassName BatteryCycleCount -ErrorAction Stop |
        Select-Object CycleCount
} catch {
    $batteryCycle = $null
}

# Win32_PortableBattery.SerialNumber - PRD §6.1 hardware fingerprint extension. Confirmed live on
# this dev machine that the class itself exists and returns real Chemistry/DesignVoltage/
# Manufacturer values, but SerialNumber comes back blank - a real, known OEM gap (many vendors
# never populate this ACPI field), not a query failure, so this is collected generically for
# hardware where it IS populated rather than skipped as pointless here.
$batteryPortable = $null
try {
    $batteryPortable = Get-CimInstance Win32_PortableBattery -ErrorAction Stop |
        Select-Object SerialNumber
} catch {
    $batteryPortable = $null
}

# powercfg /batteryreport - a second, independent route to design/full-charge capacity for
# when root/wmi's BatteryStaticData class isn't present on this OEM (it's absent on this dev
# machine). The report is an HTML file; capacities appear as "XX,XXX mWh" next to their row
# label, so each value is located by searching near its label text rather than assuming a
# fixed table layout (row order/markup differs across Windows versions).
$batteryReportHealth = [ordered]@{ designCapacityMwh = $null; fullChargeCapacityMwh = $null }
try {
    $reportPath = Join-Path $env:TEMP "battery-report-telemetry.html"
    powercfg /batteryreport /output $reportPath /duration 1 | Out-Null

    if (Test-Path $reportPath) {
        $html = Get-Content $reportPath -Raw
        Remove-Item $reportPath -ErrorAction SilentlyContinue

        $designMatch = [regex]::Match($html, '(?is)DESIGN\s*CAPACITY.{1,300}?([\d,]+)\s*mWh')
        $fullMatch = [regex]::Match($html, '(?is)FULL\s*CHARGE\s*CAPACITY.{1,300}?([\d,]+)\s*mWh')

        if ($designMatch.Success) {
            $batteryReportHealth.designCapacityMwh = [int]($designMatch.Groups[1].Value -replace ',', '')
        }
        if ($fullMatch.Success) {
            $batteryReportHealth.fullChargeCapacityMwh = [int]($fullMatch.Groups[1].Value -replace ',', '')
        }

        if ($batteryReportHealth.designCapacityMwh -and $batteryReportHealth.fullChargeCapacityMwh) {
            [Console]::Error.WriteLine("[diag] powercfg battery report parsed OK: design=$($batteryReportHealth.designCapacityMwh)mWh full=$($batteryReportHealth.fullChargeCapacityMwh)mWh")
        } else {
            [Console]::Error.WriteLine("[diag] powercfg battery report generated but capacity values were not found in the expected format")
        }
    } else {
        [Console]::Error.WriteLine("[diag] powercfg battery report was not generated - no report file at expected path")
    }
} catch {
    [Console]::Error.WriteLine("[diag] powercfg battery report failed: $($_.Exception.Message)")
}

# smartctl.exe — optional external tool, not bundled with Windows. Degrades to $null if absent,
# if --scan finds no devices, or if the query fails (e.g. lacking admin rights — NVMe SMART
# queries need an elevated handle on Windows). \\.\PhysicalDriveN is NOT what smartctl expects
# here: it wants a /dev/sdX-style path plus a -d type, and that mapping is drive/OEM-specific,
# so it's discovered via --scan rather than assumed.
$smartctlPath = Get-Command smartctl.exe -ErrorAction SilentlyContinue
[Console]::Error.WriteLine("[diag] smartctlPath: $(if ($smartctlPath) { $smartctlPath.Source } else { 'NOT FOUND' })")
$storageHealth = $null
if ($smartctlPath) {
    try {
        $scanText = & smartctl.exe --scan -j 2>&1 | Out-String
        $scanResult = $scanText | ConvertFrom-Json
        $firstDevice = $scanResult.devices | Select-Object -First 1

        if (-not $firstDevice) {
            [Console]::Error.WriteLine("[diag] smartctl --scan found no devices")
        } else {
            [Console]::Error.WriteLine("[diag] smartctl --scan found device: $($firstDevice.name) (type: $($firstDevice.type))")

            $smartText = & smartctl.exe -a -j -d $firstDevice.type $firstDevice.name 2>&1 | Out-String

            # Non-admin NVMe access on Windows doesn't always fail with a clean "Access is
            # denied" — smartmontools' Windows port has been observed surfacing it as things
            # like "Invalid argument" or "Input/output error" instead, so match broadly.
            if ($smartText -match 'Invalid argument|Permission denied|Access is denied|Input/output error') {
                [Console]::Error.WriteLine("[telemetry] smartctl requires elevated PowerShell - run this server as Administrator for real storage health data.")
            }

            try {
                $storageHealth = $smartText | ConvertFrom-Json
                [Console]::Error.WriteLine("[diag] smartctl query result: parsed OK")
            } catch {
                [Console]::Error.WriteLine("[diag] smartctl query output was not valid JSON (likely the issue reported above)")
                $storageHealth = $null
            }
        }
    } catch {
        [Console]::Error.WriteLine("[diag] smartctl --scan threw: $($_.Exception.Message)")
        $storageHealth = $null
    }
}

# GPU Engine performance counter — instance names vary by driver/session, so this can fail.
$gpuUtil = $null
try {
    $gpuCounter = Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction Stop
    $gpuUtil = [math]::Round(($gpuCounter.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum, 0)
} catch {
    $gpuUtil = $null
}

# netsh text output — no native cmdlet exposes Wi-Fi signal/link speed, so this is parsed from
# `netsh wlan show interfaces`. Absent entirely if not on Wi-Fi (e.g. wired-only, or no adapter).
$wifiInfo = $null
try {
    $netshOutput = netsh wlan show interfaces
    $signalLine = $netshOutput | Select-String "Signal"
    $speedLine = $netshOutput | Select-String "Receive rate"
    $stateLine = $netshOutput | Select-String "^\s*State"
    $ssidLine = $netshOutput | Select-String "^\s*SSID\s+:" | Select-Object -First 1
    $wifiInfo = [ordered]@{
        signalPercent   = if ($signalLine) { ($signalLine -split ":")[1].Trim().TrimEnd('%') } else { $null }
        receiveRateMbps = if ($speedLine) { ($speedLine -split ":")[1].Trim() } else { $null }
        state           = if ($stateLine) { ($stateLine -split ":")[1].Trim() } else { $null }
        ssid            = if ($ssidLine) { ($ssidLine -split ":", 2)[1].Trim() } else { $null }
    }
} catch {
    $wifiInfo = $null
}

# First non-link-local IPv4 address on a Wi-Fi or Ethernet adapter - null if neither adapter
# type has one (e.g. adapter disabled, or only a 169.254.* APIPA address available).
$localIp = $null
try {
    $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -notlike "169.254.*" })
    $wifiAddr = $addrs | Where-Object {
        $_.InterfaceAlias -match "Wi-?Fi|Wireless" -and
        $_.InterfaceAlias -notmatch "vEthernet|Virtual|Tailscale|Bluetooth"
    } | Select-Object -First 1
    $ethAddr = $addrs | Where-Object {
        $_.InterfaceAlias -match "Ethernet" -and
        $_.InterfaceAlias -notmatch "vEthernet|Virtual|Tailscale"
    } | Select-Object -First 1
    $localIp = if ($wifiAddr) { $wifiAddr.IPAddress } elseif ($ethAddr) { $ethAddr.IPAddress } else { $null }
} catch {
    $localIp = $null
}

# Real driver-version source for the Drivers & Firmware card, distinct from BIOS version/SSD
# firmware which already have real values elsewhere (SMBIOSBIOSVersion, SMART data) and are
# reused as-is rather than re-queried here. GPU driver version is also already real elsewhere
# (Win32_VideoController.DriverVersion, read directly by the frontend) and reused rather than
# duplicated below. Queried once and reused for all five categories rather than filtering
# Win32_PnPSignedDriver five separate times. Each match pattern below was derived from what
# this specific machine's driver list actually contains (captured live, not guessed) - like
# hwinfo.rs's own sensor-name pattern lists, this can't be a single universal identifier since
# there's no OS-standard "the chipset driver" or "the WiFi driver" marker; naming varies by
# vendor and Windows lists many unrelated drivers under the same DeviceClass (e.g. a dozen
# Microsoft-authored generic Bluetooth stack components alongside the one real Intel radio
# driver). A device this pattern doesn't match on a different machine just stays null/sample,
# same as everywhere else in this app.
$pnpDrivers = $null
try {
    $pnpDrivers = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop |
        Select-Object DeviceName, DeviceClass, Manufacturer, DriverVersion, DriverDate)
} catch {
    $pnpDrivers = @()
}

function Select-PnpDriverVersion($drivers, [scriptblock]$matchPredicate) {
    $match = $drivers | Where-Object $matchPredicate | Select-Object -First 1
    if (-not $match) { return $null }
    # Windows' own inbox/generic INF stubs report an obviously-bogus placeholder ship date
    # (seen live: 7/18/1968 for this machine's Intel SMBus/chipset entry, long before this
    # hardware or driver could exist) rather than leaving DriverDate blank - showing that
    # literally would be a fabricated-looking date attached to a real version number, so any
    # date before 1990 is treated the same as no date at all.
    $dateVal = $null
    if ($match.DriverDate -and $match.DriverDate.Year -ge 1990) {
        $dateVal = $match.DriverDate.ToString("o")
    }
    return [ordered]@{ deviceName = $match.DeviceName; version = $match.DriverVersion; date = $dateVal }
}

$driverVersions = [ordered]@{
    chipset   = Select-PnpDriverVersion $pnpDrivers { $_.DeviceName -match "SMBus|LPC Controller" -and $_.Manufacturer -eq "INTEL" }
    intelMe   = Select-PnpDriverVersion $pnpDrivers { $_.DeviceName -match "Management Engine Interface" }
    wifi      = Select-PnpDriverVersion $pnpDrivers { $_.DeviceClass -eq "NET" -and $_.DeviceName -match "Wi-Fi" -and $_.DeviceName -notmatch "Direct" }
    audio     = Select-PnpDriverVersion $pnpDrivers { $_.DeviceClass -eq "MEDIA" -and $_.DeviceName -match "^(Realtek Audio|.*High Definition Audio.*)$" }
    bluetooth = Select-PnpDriverVersion $pnpDrivers { $_.DeviceClass -eq "BLUETOOTH" -and $_.DeviceName -match "Wireless Bluetooth" }
}

# Real fingerprint sensor presence (Hardware Integrity card's "Fingerprint" row). Enrollment
# status itself isn't reliably determinable here - that requires calling the WinBio API
# (winbio.dll) directly, which needs native interop this project has nowhere else and whose real
# enrollment introspection is restricted to the enrolled user's own logon session, not something
# a background elevated process can cleanly read. Hardware PRESENCE, though, is a real, fully
# determinable fact from the exact same PnP device state Windows' own Settings > Sign-in options
# page relies on to decide whether to even offer fingerprint sign-in. Filtered to the Biometric
# PNP class AND a name containing "Fingerprint" specifically - this hardware also has a real
# "Facial Recognition (Windows Hello) Software Device" under the same Biometric class, a
# different biometric modality this row isn't asking about.
$fingerprintSensorPresent = $null
try {
    $fingerprintDevice = Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Biometric'" -ErrorAction Stop |
        Where-Object { $_.Name -match "Fingerprint" } |
        Select-Object -First 1
    $fingerprintSensorPresent = [bool]($fingerprintDevice -and $fingerprintDevice.Present)
} catch {
    $fingerprintSensorPresent = $null
}

# MDM/domain enrollment - real device state via dsregcmd.exe (built into Windows 10/11, no
# admin required), not something WMI exposes. AzureAdJoined/DomainJoined/EnterpriseJoined
# specifically (not WorkplaceJoined, a weaker "added a work account" state that doesn't mean
# this device itself is enrolled/managed). Falls back to $null - not "not enrolled" - if
# dsregcmd is missing or its output doesn't match the expected "FieldName : YES/NO" format, so
# the frontend can tell "genuinely confirmed not enrolled" apart from "couldn't determine".
$mdmEnrollment = $null
try {
    $dsregOutput = dsregcmd /status 2>&1
    $azureAdMatch = $dsregOutput | Select-String "^\s*AzureAdJoined\s*:\s*(YES|NO)\s*$"
    $domainMatch = $dsregOutput | Select-String "^\s*DomainJoined\s*:\s*(YES|NO)\s*$"
    $enterpriseMatch = $dsregOutput | Select-String "^\s*EnterpriseJoined\s*:\s*(YES|NO)\s*$"
    if ($azureAdMatch -and $domainMatch -and $enterpriseMatch) {
        $mdmEnrollment = [ordered]@{
            azureAdJoined    = ($azureAdMatch.Matches[0].Groups[1].Value -eq "YES")
            domainJoined     = ($domainMatch.Matches[0].Groups[1].Value -eq "YES")
            enterpriseJoined = ($enterpriseMatch.Matches[0].Groups[1].Value -eq "YES")
        }
    }
} catch {
    $mdmEnrollment = $null
}

$logicalDisks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
    $vol = $_
    if ($null -eq $vol.Size -or $vol.Size -le 0) { return }
    $diskModel = $null
    $diskSerial = $null
    $letter = $null
    if ($vol.DeviceID -match '^([A-Za-z]):') { $letter = $Matches[1] }
    if ($letter) {
        try {
            $part = Get-Partition -DriveLetter $letter -ErrorAction Stop | Select-Object -First 1
            if ($null -ne $part) {
                $pd = Get-Disk -Number $part.DiskNumber -ErrorAction Stop
                if ($pd) {
                    $diskModel = $pd.FriendlyName
                    $diskSerial = $pd.SerialNumber
                }
            }
        } catch {}
    }
    [ordered]@{
        DeviceID    = $vol.DeviceID
        VolumeName  = $vol.VolumeName
        FileSystem  = $vol.FileSystem
        Size        = $vol.Size
        FreeSpace   = $vol.FreeSpace
        DiskModel   = $diskModel
        DiskSerial  = $diskSerial
    }
})

$uptimeFormatted = $null
if ($osDetail -and $osDetail.LastBootUpTime) {
    $uptimeSpan = (Get-Date) - $osDetail.LastBootUpTime
    $uptimeFormatted = "{0}d {1}h {2}m" -f $uptimeSpan.Days, $uptimeSpan.Hours, $uptimeSpan.Minutes
}
if ($osDetail) {
    $osDetail | Add-Member -NotePropertyName UptimeFormatted -NotePropertyValue $uptimeFormatted -Force
}

$result = [ordered]@{
    timestamp = (Get-Date).ToString("o")
    system    = $sys
    bios      = $bios
    cpu       = $cpuInfo
    memory    = [ordered]@{
        modules  = @($memModules)
        freeKB   = $os.FreePhysicalMemory
        totalKB  = $os.TotalVisibleMemorySize
    }
    storage   = @($disks)
    battery   = @($battery)
    gpu       = @($gpu)
    network   = @($net)
    osDetail  = $osDetail
    board     = $board
    enclosure = $enclosure
    thermal   = @($thermalZones)
    tpm       = $tpm
    batteryDetail = [ordered]@{
        status     = $batteryStatus
        static     = $batteryStatic
        fullCharge = $batteryFullCharge
        cycle      = $batteryCycle
        portable   = $batteryPortable
    }
    storageHealth = $storageHealth
    gpuUtilization = $gpuUtil
    wifi          = $wifiInfo
    logicalDisks  = @($logicalDisks)
    batteryRunTimeMinutes = $batteryRunTimeMinutes
    batteryReportHealth   = $batteryReportHealth
    secureBootEnabled     = $secureBootEnabled
    bitlockerStatus       = $bitlockerStatus
    bootMode              = $bootMode
    localIp               = $localIp
    driverVersions        = $driverVersions
    mdmEnrollment         = $mdmEnrollment
    fingerprintSensorPresent = $fingerprintSensorPresent
}

$result | ConvertTo-Json -Depth 6 -Compress
# Native tools (smartctl, powercfg) can leave a non-zero $LASTEXITCODE even when this
# payload is complete. Node's execFile treats that as a failed collection.
exit 0
