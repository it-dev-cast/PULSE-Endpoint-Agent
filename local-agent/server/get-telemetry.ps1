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

# Real, observed sentinel: some NVMe controllers' legacy ATA-translation layer returns an
# all-F placeholder (e.g. "FFFF-FFFF-FFFF-FFFF-FFFF-FFFF") through Win32_DiskDrive.SerialNumber
# instead of the drive's real NVMe serial - a genuine driver/WMI-surface limitation, not a query
# failure (the call itself succeeds and returns a value, just not a usable one). Flagged here so
# the dashboard can show "why" instead of just a dash or a meaningless placeholder string.
foreach ($d in $disks) {
    $sn = if ($d.SerialNumber) { $d.SerialNumber.Trim() } else { $null }
    $reason = if ([string]::IsNullOrEmpty($sn)) {
        @{ code = "no-data-returned"; message = "Win32_DiskDrive returned no serial number for this drive." }
    } elseif ($sn -match '^[F0]+$' -or $sn -match '^-*$') {
        @{ code = "sentinel-value"; message = "This drive's controller returned a placeholder serial ($sn) through Windows' legacy ATA-translation WMI surface, not its real NVMe serial - a known driver/OEM limitation, not a query failure." }
    } else {
        $null
    }
    Add-Member -InputObject $d -MemberType NoteProperty -Name "SerialNumberReason" -Value $reason -Force
}

$battery = Get-CimInstance Win32_Battery |
    Select-Object Name, EstimatedChargeRemaining, BatteryStatus, DesignCapacity, FullChargeCapacity

# Win32_Battery.EstimatedRunTime uses a sentinel (71582788, ~136 years) when Windows can't
# currently calculate a real estimate (e.g. while charging) - that's not a real number, so it's
# normalized to $null rather than shown as a nonsensical multi-year countdown.
$batteryRunTimeRaw = (Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedRunTime).EstimatedRunTime
$batteryRunTimeMinutes = if ($null -ne $batteryRunTimeRaw -and $batteryRunTimeRaw -ne 71582788) { $batteryRunTimeRaw } else { $null }

# Win32_PhysicalMemoryArray.MemoryDevices - the TOTAL physical RAM slot count on the
# motherboard, including empty ones (Win32_PhysicalMemory above only reports INSTALLED modules,
# used for ramModuleSerials in the hardware fingerprint) - genuinely new collection, not queried
# anywhere else in this project. Summed across all returned instances - real hardware normally
# has exactly one physical memory array (confirmed on this dev machine), but a server/workstation
# with multiple would have more than one, and each contributes real slots.
$memoryTotalSlots = $null
try {
    $memoryTotalSlots = (Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction Stop | Measure-Object -Property MemoryDevices -Sum).Sum
} catch {
    $memoryTotalSlots = $null
}

$gpuSkip = "Microsoft Basic Display|Remote Display|Virtual Display|IDD Driver|Parsec|spacedesk|USB Display|Mirage Driver|Indirect Display"
$gpu = @(Get-CimInstance Win32_VideoController |
    Where-Object { $_.Name -and $_.Name -notmatch $gpuSkip } |
    Select-Object Name, AdapterRAM, DriverVersion, AdapterCompatibility, DriverDate, VideoProcessor)
if ($gpu.Count -eq 0) {
    $gpu = @(Get-CimInstance Win32_VideoController |
        Select-Object Name, AdapterRAM, DriverVersion, AdapterCompatibility, DriverDate, VideoProcessor)
}
foreach ($g in $gpu) {
    if (-not $g.Name -and $g.VideoProcessor) {
        $g | Add-Member -NotePropertyName Name -NotePropertyValue $g.VideoProcessor -Force
    }
}

$net = Get-CimInstance Win32_NetworkAdapter |
    Where-Object {
        $_.PhysicalAdapter -eq $true -and $_.NetConnectionStatus -eq 2 -and
        $_.Name -notmatch "Tailscale|vEthernet|Virtual|Bluetooth|WAN Miniport"
    } |
    Sort-Object { if ($_.Name -match "Wi-Fi|Wireless") { 0 } else { 1 } } |
    Select-Object Name, MACAddress, AdapterType

$osDetail = Get-CimInstance Win32_OperatingSystem |
    Select-Object Caption, BuildNumber, Version, LastBootUpTime, OSArchitecture
if ($osDetail) {
    if (-not $osDetail.OSArchitecture) {
        $osArch = if ([Environment]::Is64BitOperatingSystem) { "64-bit" } else { "32-bit" }
        $osDetail | Add-Member -NotePropertyName OSArchitecture -NotePropertyValue $osArch -Force
    }
    if ($osDetail.BuildNumber -ne $null) { $osDetail.BuildNumber = [string]$osDetail.BuildNumber }
    if ($osDetail.Version -ne $null) { $osDetail.Version = [string]$osDetail.Version }
}

$board = Get-CimInstance Win32_BaseBoard |
    Select-Object Product, SerialNumber
if ($board -and -not $board.Product) {
    try {
        $csp = Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop
        if ($csp.Name) {
            $board | Add-Member -NotePropertyName Product -NotePropertyValue $csp.Name -Force
        }
    } catch {}
}

$enclosure = Get-CimInstance Win32_SystemEnclosure |
    Select-Object SMBIOSAssetTag

$thermalZones = @()
try {
    $thermalZones = @(Get-CimInstance -Namespace "root/wmi" -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop |
        Select-Object InstanceName, CurrentTemperature)
} catch {
    $thermalZones = @()
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

# TPM (Win32_Tpm) and BitLocker (Get-BitLockerVolume) are NOT queried here anymore - profiled at
# ~5s EACH on this real machine (non-elevated; unverified whether the real elevated Scheduled Task
# timing differs), together over a third of this script's own ~27s baseline. rust-collector
# already supplies both independently via its own separate, already-elevated read every cycle
# (see mergeRustData) - this was a redundant fallback attempt costing real time on every single 5s
# cycle. Moved to runTpmBitlockerFallbackCheck's hourly cadence (telemetry-server.mjs) instead,
# used only when rust hasn't supplied a value that cycle.

# MSFT_MpComputerStatus - Windows Defender's own native status API, confirmed live on this
# machine to work from a non-elevated session (unlike TPM/BitLocker above) - real
# RealTimeProtectionEnabled boolean and real AntivirusSignatureLastUpdated/QuickScanEndTime/
# FullScanEndTime timestamps, no elevation-vs-absence ambiguity to catch separately here.
# FullScanEndTime genuinely comes back $null on this real machine (never run a full scan, only
# quick scans) - a real, honest absence, not a query failure.
$defenderStatus = $null
try {
    $defenderStatus = Get-CimInstance -Namespace "root/Microsoft/Windows/Defender" -ClassName MSFT_MpComputerStatus -ErrorAction Stop |
        Select-Object RealTimeProtectionEnabled, AntivirusSignatureLastUpdated, QuickScanEndTime, FullScanEndTime
} catch {
    $defenderStatus = $null
}

# SecurityCenter2's AntiVirusProduct - the same registration mechanism Windows Security Center's
# own UI reads, so it also picks up third-party AV (a machine running Norton/McAfee instead of
# Defender shows THAT product's displayName here, not Defender's). Deliberately only reads
# displayName - productState is an undocumented, unofficially reverse-engineered bitmask with no
# Microsoft-published bit layout, and would add nothing for Defender specifically anyway since
# MSFT_MpComputerStatus above already gives clean, documented booleans for the same facts.
# @(...) wraps the result because Select-Object collapses a single CIM instance to a bare object,
# not a one-element array - the same gotcha $net/$disks below already guard against - which would
# otherwise break downstream array handling on the (common) single-AV-product case.
$avProducts = @()
try {
    $avProducts = @(Get-CimInstance -Namespace "root/SecurityCenter2" -ClassName AntiVirusProduct -ErrorAction Stop |
        Select-Object displayName)
} catch {
    $avProducts = @()
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
#
# Bundled copy checked first (same private sibling location as rust-collector's own lookup - see
# main.rs's find_smartctl and PulseEndpoint.iss) so this independent PS-side query finds the
# shipped binary too, not just a machine's own separately-installed copy on PATH.
$bundledSmartctl = Join-Path $PSScriptRoot "..\rust-collector\smartmontools\smartctl.exe"
$smartctlPath = if (Test-Path $bundledSmartctl) {
    Get-Item $bundledSmartctl
} else {
    Get-Command smartctl.exe -ErrorAction SilentlyContinue
}
[Console]::Error.WriteLine("[diag] smartctlPath: $(if ($smartctlPath) { $smartctlPath.Source } else { 'NOT FOUND' })")
$storageHealth = $null
$storageHealthReason = $null
if (-not $smartctlPath) {
    $storageHealthReason = @{ code = "tool-not-found"; message = "smartctl.exe NOT FOUND - genuinely NOT INSTALLED, distinct from a query failure. Install smartmontools for real storage health data." }
} else {
    $smartctlExe = $smartctlPath.Source
    try {
        $scanText = & $smartctlExe --scan -j 2>&1 | Out-String
        $scanResult = $scanText | ConvertFrom-Json
        $firstDevice = $scanResult.devices | Select-Object -First 1

        if (-not $firstDevice) {
            [Console]::Error.WriteLine("[diag] smartctl --scan found no devices")
            $storageHealthReason = @{ code = "hardware-unsupported"; message = "smartctl --scan found no devices - genuinely NO SMART-CAPABLE DRIVE DETECTED, not a query failure." }
        } else {
            [Console]::Error.WriteLine("[diag] smartctl --scan found device: $($firstDevice.name) (type: $($firstDevice.type))")

            $smartText = & $smartctlExe -a -j -d $firstDevice.type $firstDevice.name 2>&1 | Out-String

            # Non-admin NVMe access on Windows doesn't always fail with a clean "Access is
            # denied" — smartmontools' Windows port has been observed surfacing it as things
            # like "Invalid argument" or "Input/output error" instead, so match broadly.
            $elevationLike = $smartText -match 'Invalid argument|Permission denied|Access is denied|Input/output error'
            if ($elevationLike) {
                [Console]::Error.WriteLine("[telemetry] smartctl requires elevated PowerShell - run this server as Administrator for real storage health data.")
            }

            try {
                $storageHealth = $smartText | ConvertFrom-Json
                [Console]::Error.WriteLine("[diag] smartctl query result: parsed OK")
                if ($elevationLike) {
                    $storageHealthReason = @{ code = "elevation-required"; message = "smartctl requires elevated PowerShell - run this server as Administrator for real storage health data." }
                }
            } catch {
                [Console]::Error.WriteLine("[diag] smartctl query output was not valid JSON (likely the issue reported above)")
                $storageHealth = $null
                $storageHealthReason = @{
                    code    = if ($elevationLike) { "elevation-required" } else { "no-data-returned" }
                    message = if ($elevationLike) { "smartctl requires elevated PowerShell - run this server as Administrator for real storage health data." } else { "smartctl query output was not valid JSON." }
                }
            }
        }
    } catch {
        [Console]::Error.WriteLine("[diag] smartctl --scan threw: $($_.Exception.Message)")
        $storageHealth = $null
        $storageHealthReason = @{ code = "no-data-returned"; message = "smartctl --scan threw: $($_.Exception.Message)" }
    }
}

# GPU Engine performance counter — instance names vary by driver/session, so this can fail.
$gpuUtil = $null
try {
    $gpuCounter = Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction Stop
    $gpuUtil = [math]::Round(($gpuCounter.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum, 0)
    if ($gpuUtil -gt 100) { $gpuUtil = 100 }
    if ($gpuUtil -lt 0) { $gpuUtil = 0 }
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

# Driver versions (Win32_PnPSignedDriver) and fingerprint-sensor presence (Win32_PnPEntity) are
# NOT queried here anymore - profiled at ~5.5s and ~0.8s respectively on this real machine.
# PnPSignedDriver in particular is structurally slow (has to verify Authenticode signing details
# for every driver package in the store, not just return cached inventory), unrelated to
# filtering. Both are exactly the "essentially never changes between reboots" class of fact, so
# both moved to runDriverVersionsCheck's/runFingerprintSensorCheck's hourly cadence
# (telemetry-server.mjs) instead of the 5s hot path.

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

# Size/FreeSpace/DeviceID/VolumeName/FileSystem stay on this 5s path - real-time disk usage %
# feeds the live Disk StatCard/diskPct, a genuinely fast-changing fact. DiskModel/DiskSerial
# (per-volume Get-Partition/Get-Disk enrichment) do NOT - profiled at ~1.3-2.2s combined with the
# LogicalDisk query itself, and model/serial are static hardware facts that never change between
# reboots. Moved to runDiskEnrichmentCheck's hourly cadence (telemetry-server.mjs), which
# telemetry-server.mjs overlays onto these same entries by drive letter after this script returns
# - see mergeRustData's own "additive overlay by Name" precedent (GPU) for why overlay-by-key,
# not wholesale replace, is the safe way to combine a fast-path array with a slow-path enrichment.
$logicalDisks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
    $vol = $_
    if ($null -eq $vol.Size -or $vol.Size -le 0) { return }
    [ordered]@{
        DeviceID    = $vol.DeviceID
        VolumeName  = $vol.VolumeName
        FileSystem  = $vol.FileSystem
        Size        = $vol.Size
        FreeSpace   = $vol.FreeSpace
    }
})

$wmiFanRpm = $null
try {
    $speeds = @(Get-CimInstance Win32_Fan -ErrorAction Stop |
        ForEach-Object { $_.DesiredSpeed } |
        Where-Object { $null -ne $_ -and $_ -ge 80 -and $_ -le 20000 })
    if ($speeds.Count -gt 0) {
        $wmiFanRpm = [int](($speeds | Measure-Object -Maximum).Maximum)
    }
} catch {
    $wmiFanRpm = $null
}

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
        modules    = @($memModules)
        freeKB     = $os.FreePhysicalMemory
        totalKB    = $os.TotalVisibleMemorySize
        totalSlots = $memoryTotalSlots
    }
    storage   = @($disks)
    battery   = @($battery)
    gpu       = @($gpu)
    network   = @($net)
    osDetail  = $osDetail
    board     = $board
    enclosure = $enclosure
    thermal   = @($thermalZones)
    batteryDetail = [ordered]@{
        status     = $batteryStatus
        static     = $batteryStatic
        fullCharge = $batteryFullCharge
        cycle      = $batteryCycle
        portable   = $batteryPortable
    }
    storageHealth = $storageHealth
    storageHealthReason = $storageHealthReason
    gpuUtilization = $gpuUtil
    wifi          = $wifiInfo
    logicalDisks  = @($logicalDisks)
    batteryRunTimeMinutes = $batteryRunTimeMinutes
    batteryReportHealth   = $batteryReportHealth
    wmiFanRpm             = $wmiFanRpm
    secureBootEnabled     = $secureBootEnabled
    defenderStatus        = $defenderStatus
    avProducts            = @($avProducts)
    bootMode              = $bootMode
    localIp               = $localIp
    mdmEnrollment         = $mdmEnrollment
}

$result | ConvertTo-Json -Depth 6 -Compress
# Native tools (smartctl, powercfg) can leave a non-zero $LASTEXITCODE even when this
# payload is complete. Node's execFile treats that as a failed collection.
exit 0
