# Fixed, local, read-only inventory for the Windows security assessment.
# Only aggregate counts and allow-listed security settings leave this process.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Read-Fact([scriptblock]$Query) {
    try { & $Query }
    catch {
        $reason = 'unavailable'
        if ($_.Exception -is [System.UnauthorizedAccessException] -or $_.CategoryInfo.Category -eq 'PermissionDenied') { $reason = 'access-denied' }
        @{ available = $false; reason = $reason }
    }
}
function Nullable-Bool($Value) { if ($null -eq $Value) { $null } else { [bool]$Value } }
function Nullable-Int($Value) { if ($null -eq $Value) { $null } else { [int]$Value } }

$facts = [ordered]@{ schemaVersion = 1 }
$facts.defender = Read-Fact {
    $d = Get-MpComputerStatus -ErrorAction Stop
    $mode = switch ([string]$d.AMRunningMode) {
        'Normal' { 'active' }
        'Passive Mode' { 'passive' }
        'EDR Block Mode' { 'edr-block' }
        default { 'unknown' }
    }
    $age = $null
    if ($null -ne $d.AntivirusSignatureAge -and [double]$d.AntivirusSignatureAge -lt 65535) { $age = [double]$d.AntivirusSignatureAge }
    @{ available = $true; mode = $mode; antivirusEnabled = (Nullable-Bool $d.AntivirusEnabled); realtimeEnabled = (Nullable-Bool $d.RealTimeProtectionEnabled); signatureAgeDays = $age }
}
$facts.antivirus = Read-Fact {
    # Windows Security registration is not an independent product-health test.
    $products = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -OperationTimeoutSec 5 -ErrorAction Stop | Select-Object -First 100)
    $other = @($products | Where-Object { [string]$_.displayName -notmatch '^(Windows Defender|Microsoft Defender)( Antivirus)?$' })
    @{ available = $true; registeredCount = $products.Count; otherRegisteredCount = $other.Count; truncated = ($products.Count -ge 100) }
}
$facts.firewall = Read-Fact {
    $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop)
    $result = @($profiles | Where-Object { [string]$_.Name -in @('Domain', 'Private', 'Public') } | ForEach-Object {
        # Enabled is a GpoBoolean enum: values other than 0/1 must stay unknown.
        $enabled = $null
        if ([string]$_.Enabled -in @('True', '1')) { $enabled = $true }
        if ([string]$_.Enabled -in @('False', '0')) { $enabled = $false }
        @{ name = [string]$_.Name; enabled = $enabled }
    })
    @{ available = $true; profiles = $result }
}
$facts.smbServer = Read-Fact {
    $s = Get-SmbServerConfiguration -ErrorAction Stop
    @{ available = $true; smb1Enabled = (Nullable-Bool $s.EnableSMB1Protocol); signingRequired = (Nullable-Bool $s.RequireSecuritySignature) }
}
$facts.smbClient = Read-Fact {
    $s = Get-SmbClientConfiguration -ErrorAction Stop
    @{ available = $true; signingRequired = (Nullable-Bool $s.RequireSecuritySignature) }
}
$facts.rdp = Read-Fact {
    $base = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -ErrorAction Stop
    $tcp = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -ErrorAction Stop
    $denied = Nullable-Int $base.fDenyTSConnections
    $nla = Nullable-Int $tcp.UserAuthentication
    # Group policy overrides the ordinary configuration when the values exist.
    $policyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services'
    if (Test-Path -LiteralPath $policyPath -ErrorAction Stop) {
        $policy = Get-ItemProperty -LiteralPath $policyPath -ErrorAction Stop
        if ($null -ne $policy.fDenyTSConnections) { $denied = [int]$policy.fDenyTSConnections }
        if ($null -ne $policy.UserAuthentication) { $nla = [int]$policy.UserAuthentication }
    }
    @{ available = $true; denyConnections = $denied; nlaRequired = $nla }
}
$facts.uac = Read-Fact {
    $u = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Stop
    @{ available = $true; enabled = (Nullable-Int $u.EnableLUA); adminPrompt = (Nullable-Int $u.ConsentPromptBehaviorAdmin); secureDesktop = (Nullable-Int $u.PromptOnSecureDesktop) }
}
$facts.secureBoot = Read-Fact {
    @{ available = $true; enabled = [bool](Confirm-SecureBootUEFI -ErrorAction Stop) }
}
$facts.bitlocker = Read-Fact {
    # The environment variable is used only as a local mount point, never emitted.
    $v = Get-BitLockerVolume -MountPoint $env:SystemDrive -ErrorAction Stop
    $protection = switch ([string]$v.ProtectionStatus) { 'On' { 'on' }; 'Off' { 'off' }; default { 'unknown' } }
    $status = switch ([string]$v.VolumeStatus) {
        'FullyEncrypted' { 'encrypted' }; 'FullyDecrypted' { 'decrypted' }
        'EncryptionInProgress' { 'encrypting' }; 'EncryptionPaused' { 'paused' }
        'DecryptionInProgress' { 'decrypting' }; 'DecryptionPaused' { 'paused' }
        default { 'unknown' }
    }
    @{ available = $true; protection = $protection; volumeStatus = $status }
}
$facts.updates = Read-Fact {
    # This list is incomplete by design; it does not query Windows Update online.
    $items = @(Get-HotFix -ErrorAction Stop | Select-Object -First 500)
    $latest = $null
    foreach ($item in $items) {
        if ($item.InstalledOn -is [DateTime] -and $item.InstalledOn.Year -ge 1970 -and $item.InstalledOn -le (Get-Date).AddDays(1)) {
            if ($null -eq $latest -or $item.InstalledOn -gt $latest) { $latest = $item.InstalledOn }
        }
    }
    $date = $null
    if ($null -ne $latest) { $date = $latest.ToUniversalTime().ToString('o') }
    @{ available = $true; count = $items.Count; truncated = ($items.Count -ge 500); latestInstalledAt = $date }
}
$facts.accounts = Read-Fact {
    $users = @(Get-LocalUser -ErrorAction Stop | Select-Object -First 1000)
    $enabled = @($users | Where-Object { $_.Enabled -eq $true })
    $noRequirement = @($enabled | Where-Object { $_.PasswordRequired -eq $false })
    $unknownRequirement = @($enabled | Where-Object { $null -eq $_.PasswordRequired })
    $guest = @($enabled | Where-Object { [string]$_.SID -match '-501$' })
    @{ available = $true; count = $users.Count; enabledCount = $enabled.Count; passwordNotRequiredCount = $noRequirement.Count; passwordRequirementUnknownCount = $unknownRequirement.Count; guestEnabled = ($guest.Count -gt 0); truncated = ($users.Count -ge 1000) }
}
$facts | ConvertTo-Json -Depth 6 -Compress
