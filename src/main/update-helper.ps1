param([Parameter(Mandatory = $true)][string]$PlanPath, [switch]$Launch)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$plan = $null
$parentProcess = $null
$parentExited = $false
$replacementMade = $false
$stagedPortable = $null
$backupPath = $null
$failedPath = $null
$ownsPayload = $false
$terminalPhase = 'failed'
$terminalMessage = 'The update helper could not complete.'
$exitCode = 0
$directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PlanPath))
$statusPath = [IO.Path]::Combine($directory, 'status.json')
$utf8 = New-Object System.Text.UTF8Encoding($false)

# Node's DETACHED_PROCESS flag causes Windows PowerShell 5.1 to exit before -File;
# a normal inherited console dies when its owner exits. ShellExecute with Hidden
# creates the independent helper console without showing a window. All command
# arguments below are fixed switches or separately quoted, validated file paths.
if ($Launch) {
    try {
        if ($PlanPath -match '[\x00\r\n"]' -or $PSCommandPath -match '[\x00\r\n"]') { throw 'The helper path is invalid.' }
        $launchPlan = [IO.File]::ReadAllText($PlanPath) | ConvertFrom-Json
        if ($launchPlan.token -notmatch '^[a-f0-9]{48}$') { throw 'The helper identity is invalid.' }
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = [IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        $info.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -PlanPath "' + $PlanPath + '"'
        $info.UseShellExecute = $true
        $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $started = [Diagnostics.Process]::Start($info)
        if ($null -eq $started) { throw 'Windows could not launch the independent update helper.' }
        $receipt = @{ token = $launchPlan.token; helperPid = $started.Id } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText([IO.Path]::Combine($directory, 'started.json'), $receipt, $utf8)
        $started.Dispose()
        exit 0
    } catch {
        $failed = @{ schemaVersion = 1; phase = 'failed'; message = $_.Exception.Message } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($statusPath, $failed, $utf8)
        exit 1
    }
}

function Write-Json([string]$Path, $Value) {
    $temporary = $Path + '.tmp'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5 -Compress), $utf8)
    # This helper is the sole status writer. Preserve the previous complete
    # record while a short-lived Windows reader prevents atomic replacement.
    $until = [DateTime]::UtcNow.AddSeconds(2)
    do {
        try {
            if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
            else { [IO.File]::Move($temporary, $Path) }
            return
        } catch [IO.IOException] {
            if (![IO.File]::Exists($temporary) -or [DateTime]::UtcNow -ge $until) { throw }
        } catch [UnauthorizedAccessException] {
            if (![IO.File]::Exists($temporary) -or [DateTime]::UtcNow -ge $until) { throw }
        }
        Start-Sleep -Milliseconds 20
    } while ($true)
}
function Write-Status([string]$Phase, [string]$Message) {
    Write-Json $statusPath ([ordered]@{ schemaVersion = 1; phase = $Phase; message = $Message; at = [DateTime]::UtcNow.ToString('o'); targetPath = $plan.targetPath; backupPath = $backupPath; failedPath = $failedPath })
}
function Read-Control {
    # Immutable signals avoid replacing a file while another Windows process is
    # reading it. Cancellation always takes precedence over a prior commit.
    foreach ($action in @('cancel', 'commit')) {
        $controlPath = [IO.Path]::Combine($directory, $action + '.json')
        if (![IO.File]::Exists($controlPath)) { continue }
        $value = [IO.File]::ReadAllText($controlPath) | ConvertFrom-Json
        if ($value.token -cne $plan.token -or $value.action -cne $action) { throw 'The update control identity does not match.' }
        return $action
    }
    return ''
}
function Check-Cancelled {
    if ((Read-Control) -eq 'cancel') { throw (New-Object OperationCanceledException('Update cancelled.')) }
}
function Require-File([string]$Path) {
    if (![IO.Path]::IsPathRooted($Path) -or $Path -match '[\x00\r\n"]') { throw 'An update path is invalid.' }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Update files must be regular files, not links.' }
    return $item
}
function File-Hash([string]$Path) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Verify-Payload([string]$Path) {
    $item = Require-File $Path
    if ($item.Length -ne $plan.size -or (File-Hash $Path) -cne $plan.sha256) { throw 'The downloaded update failed its size or SHA-256 verification.' }
}
function Get-InstallMode([string]$TargetDirectory) {
    # electron-builder derives this UUID from appId com.konx.app. Its install
    # location and uninstall metadata belong to two separate, paired keys.
    $registrationId = 'e1e4513c-47e1-589d-a8c8-61851534c8b6'
    $modes = New-Object 'Collections.Generic.List[string]'
    $targetLocation = [IO.Path]::GetFullPath($TargetDirectory).TrimEnd('\')
    $uninstaller = [IO.Path]::Combine($targetLocation, 'Uninstall KonX.exe')
    foreach ($entry in @(@('HKCU', 'currentuser'), @('HKLM', 'allusers'))) {
        $installKey = $entry[0] + ':\Software\' + $registrationId
        $uninstallKey = $entry[0] + ':\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $registrationId
        $expectedCommand = '"' + $uninstaller + '" /' + $entry[1]
        $installation = if (Test-Path -LiteralPath $installKey) { Get-ItemProperty -LiteralPath $installKey -ErrorAction Stop } else { $null }
        $uninstall = if (Test-Path -LiteralPath $uninstallKey) { Get-ItemProperty -LiteralPath $uninstallKey -ErrorAction Stop } else { $null }
        $location = ''
        # GetFullPath alone accepts drive-relative paths such as C:KonX.
        if ($installation.InstallLocation -is [string] -and $installation.InstallLocation -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') {
            try { $location = [IO.Path]::GetFullPath($installation.InstallLocation).TrimEnd('\') } catch { }
        }
        $ownsDirectory = $location -ieq $targetLocation
        $ownsCommand = $uninstall.UninstallString -is [string] -and $uninstall.UninstallString -ieq $expectedCommand
        # Another installation of this app in the other scope may coexist.
        if (!$ownsDirectory -and !$ownsCommand) { continue }
        if (!$ownsDirectory -or !$ownsCommand -or $uninstall.DisplayName -isnot [string] -or $uninstall.DisplayName -cne 'KonX') {
            throw 'The existing installation registration does not consistently identify this KonX directory and mode. Run the downloaded installer manually.'
        }
        $modes.Add($entry[1])
    }
    if ($modes.Count -ne 1) { throw 'The existing installation mode could not be identified unambiguously. Run the downloaded installer manually.' }
    return @($modes)[0]
}
function Start-Application([string]$Executable) {
    # Portable bootstrap markers must refer to the new launcher, never the old extraction.
    foreach ($entry in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if ([string]$entry -match '^(PORTABLE_EXECUTABLE_|ELECTRON_RUN_AS_NODE$|KONX_CAPTURE(?:_|$)|KONX_DEMO(?:_|$))') { [Environment]::SetEnvironmentVariable([string]$entry, $null, 'Process') }
    }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.WorkingDirectory = [IO.Path]::GetDirectoryName($Executable)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($info)
    if ($null -eq $process) { throw 'Windows could not start KonX.' }
    # A failed immediate bootstrap can be rolled back, without terminating anything.
    if ($process.WaitForExit(1500) -and $process.ExitCode -ne 0) { throw "KonX exited immediately with code $($process.ExitCode)." }
    $process.Dispose()
}
function Replace-WithRetry([string]$Source, [string]$Destination, [string]$Backup) {
    $until = [DateTime]::UtcNow.AddMilliseconds([double]$plan.replaceTimeoutMs)
    do {
        Check-Cancelled
        if ((File-Hash $Destination) -cne $originalHash) { throw 'The application changed while its launcher was closing. It was not overwritten.' }
        try { [IO.File]::Replace($Source, $Destination, $Backup, $true); return }
        catch [IO.IOException] {
            if ([IO.File]::Exists($Backup) -or ![IO.File]::Exists($Source) -or [DateTime]::UtcNow -ge $until) { throw }
            Start-Sleep -Milliseconds 200
        }
    } while ($true)
}

try {
    $plan = [IO.File]::ReadAllText($PlanPath) | ConvertFrom-Json
    if ($plan.schemaVersion -ne 1 -or $plan.token -notmatch '^[a-f0-9]{48}$' -or $plan.mode -notin @('installed', 'portable') -or $plan.sha256 -notmatch '^[a-f0-9]{64}$' -or $plan.size -le 0 -or $plan.size -gt 2147483648 -or $plan.parentPid -le 0) { throw 'The update plan is invalid.' }
    foreach ($name in @('exitTimeoutMs', 'replaceTimeoutMs', 'commitTimeoutMs')) {
        if ($plan.$name -lt 500 -or $plan.$name -gt 300000) { throw 'The update timeout is invalid.' }
    }
    if ([IO.Path]::GetFullPath($plan.file) -ine [IO.Path]::Combine($directory, 'payload.exe')) { throw 'The update payload is outside its handoff directory.' }
    $ownsPayload = $true
    Write-Status 'preparing' 'Verifying the update and the existing application.'
    Check-Cancelled
    Verify-Payload $plan.file
    $target = Require-File $plan.targetPath
    if ($target.Extension -ine '.exe') { throw 'The target is not an executable.' }
    $targetDirectory = $target.DirectoryName
    $originalHash = File-Hash $plan.targetPath
    $installMode = ''
    if ($plan.mode -eq 'installed') {
        if ($target.Name -ine 'KonX.exe') { throw 'The installed application name is invalid.' }
        [void](Require-File ([IO.Path]::Combine($targetDirectory, 'resources', 'app.asar')))
        [void](Require-File ([IO.Path]::Combine($targetDirectory, 'Uninstall KonX.exe')))
        $installMode = Get-InstallMode $targetDirectory
    } else {
        if ($target.Attributes -band [IO.FileAttributes]::ReadOnly) { throw 'The portable executable is read-only. Move it to a writable folder before updating.' }
        $stem = '.konx-update-' + $plan.token
        $stagedPortable = [IO.Path]::Combine($targetDirectory, $stem + '.new.exe')
        $backupPath = [IO.Path]::Combine($targetDirectory, $stem + '.backup.exe')
        $failedPath = [IO.Path]::Combine($targetDirectory, $stem + '.failed.exe')
        # Creating the sibling before readiness checks destination write permission.
        [IO.File]::Copy($plan.file, $stagedPortable, $false)
        Verify-Payload $stagedPortable
    }
    Check-Cancelled
    $parentProcess = [Diagnostics.Process]::GetProcessById([int]$plan.parentPid)
    $parentStartTicks = $parentProcess.StartTime.ToUniversalTime().Ticks.ToString()
    # Acquire and retain the native process handle: PID reuse cannot satisfy this wait.
    [void]$parentProcess.Handle
    if ($parentProcess.HasExited) { throw 'KonX exited before the update handoff was ready.' }
    Write-Status 'ready' 'The verified update helper is ready; KonX has not been closed.'
    Write-Json ([IO.Path]::Combine($directory, 'ready.json')) @{ token = $plan.token; parentPid = [int]$plan.parentPid; parentStartTicks = $parentStartTicks; helperPid = $PID }
    $until = [DateTime]::UtcNow.AddMilliseconds([double]$plan.commitTimeoutMs)
    while ((Read-Control) -ne 'commit') {
        Check-Cancelled
        if ($parentProcess.HasExited) { throw 'KonX exited without committing the update.' }
        if ([DateTime]::UtcNow -ge $until) { throw 'The update was not committed in time. KonX was not changed.' }
        Start-Sleep -Milliseconds 100
    }
    Check-Cancelled
    if ($parentProcess.HasExited -or $parentProcess.StartTime.ToUniversalTime().Ticks.ToString() -cne $parentStartTicks) { throw 'The original KonX process is no longer available for handoff.' }
    Write-Status 'waiting-for-exit' 'Update committed. Waiting for this KonX process to exit normally.'
    $until = [DateTime]::UtcNow.AddMilliseconds([double]$plan.exitTimeoutMs)
    while (!$parentProcess.HasExited) {
        Check-Cancelled
        if ([DateTime]::UtcNow -ge $until) { throw 'KonX did not exit in time. No update was installed.' }
        Start-Sleep -Milliseconds 100
    }
    $parentExited = $true
    Check-Cancelled
    [void](Require-File $plan.targetPath)
    if ((File-Hash $plan.targetPath) -cne $originalHash) { throw 'The application changed after the update was prepared. It was not overwritten.' }
    Verify-Payload $plan.file
    if ($plan.mode -eq 'installed') {
        if ((Get-InstallMode $targetDirectory) -cne $installMode) { throw 'The installation registration changed after preparation.' }
        Write-Status 'installing' 'Running the verified installer for the existing installation.'
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $plan.file
        # NSIS /D is deliberately last and unquoted, including a directory with spaces.
        # ProcessStartInfo starts the EXE directly; these are never shell commands.
        $info.Arguments = '--updated /S --force-run /' + $installMode + ' /D=' + $targetDirectory
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $installer = [Diagnostics.Process]::Start($info)
        $installer.WaitForExit()
        $code = $installer.ExitCode
        $installer.Dispose()
        if ($code -ne 0) { throw "The installer failed or was cancelled (exit code $code)." }
    } else {
        Verify-Payload $stagedPortable
        Write-Status 'replacing' 'Replacing the portable executable after its launcher releases the file.'
        Replace-WithRetry $stagedPortable $plan.targetPath $backupPath
        $replacementMade = $true
        Write-Status 'restarting' 'Starting the updated portable executable at its original filename.'
        Start-Application $plan.targetPath
    }
    $terminalPhase = 'complete'
    $terminalMessage = 'Update installed. The portable backup, if present, is retained for recovery.'
} catch {
    $errorMessage = $_.Exception.Message
    $cancelled = $_.Exception -is [OperationCanceledException]
    if ($replacementMade -or ($backupPath -and [IO.File]::Exists($backupPath))) {
        try {
            if ((File-Hash $plan.targetPath) -cne $originalHash) {
                # No process is killed. A still-running replacement keeps its lock;
                # the original remains available at backupPath if rollback cannot run.
                [IO.File]::Replace($backupPath, $plan.targetPath, $failedPath, $true)
            }
            if ((File-Hash $plan.targetPath) -cne $originalHash) { throw 'Restored file did not match the original application.' }
            $errorMessage += ' The previous portable executable was restored.'
        } catch { $errorMessage += " Rollback could not complete; preserve the backup at $backupPath. $($_.Exception.Message)" }
    }
    if ($parentExited -and $plan -and [IO.File]::Exists($plan.targetPath)) {
        try { Start-Application $plan.targetPath }
        catch { $errorMessage += " KonX could not be restarted: $($_.Exception.Message)" }
    }
    $terminalPhase = $(if ($cancelled) { 'cancelled' } else { 'failed' })
    $terminalMessage = $errorMessage
    $exitCode = 1
} finally {
    foreach ($ownedFile in @($stagedPortable, $(if ($ownsPayload) { $plan.file } else { $null }))) {
        if ($ownedFile -and [IO.File]::Exists($ownedFile)) {
            try { [IO.File]::Delete($ownedFile) }
            catch { $terminalMessage += " Temporary update file could not be removed: $ownedFile." }
        }
    }
    if ($parentProcess) { $parentProcess.Dispose() }
    try { Write-Status $terminalPhase $terminalMessage } catch {}
}
if ($terminalPhase -eq 'failed' -and $parentExited -and $plan.showFailure) {
    try {
        $popup = New-Object -ComObject WScript.Shell
        [void]$popup.Popup("$terminalMessage`r`n`r`nUpdate diagnostics: $statusPath", 15, 'KonX update did not complete', 16)
    } catch {}
}
exit $exitCode
