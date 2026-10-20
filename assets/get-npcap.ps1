# Downloads the official Npcap installer from npcap.com and checks its digital signature.
# Used by the KonX installer and by KonX itself (Packet Capture > Install Npcap).
# KonX does not bundle Npcap: its free license does not allow redistribution, so the user
# runs Npcap's own installer and accepts its license.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File get-npcap.ps1 -Out C:\path\npcap-setup.exe
#
# Prints one line ("OK <version> <publisher>" or "ERROR: <reason>").
# Exit codes: 0 ok, 2 download failed, 3 signature check failed.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  # Used when the release list cannot be read; the newest release is preferred.
  [string]$Version = '1.89',
  # Only check the signature of an existing file at -Out (no download). Used by tests.
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072 -bor 12288 } catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
}

function Fail([int]$code, [string]$message) {
  Write-Output "ERROR: $message"
  exit $code
}

function Reason($err) {
  $m = $err.Exception.Message
  if ($err.Exception.InnerException) { $m = $err.Exception.InnerException.Message }
  if ($m -match 'trust relationship|certificate') { return "npcap.com's security certificate is not valid right now ($m)" }
  return $m
}

if (-not $VerifyOnly) {
  $base = 'https://npcap.com/dist/'
  try {
    $page = Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec 20
    if ($page.Content -match 'latest Npcap release is version (\d+\.\d+)') { $Version = $Matches[1] }
  } catch {
    Fail 2 "Could not reach npcap.com: $(Reason $_)"
  }

  $url = "${base}npcap-$Version.exe"
  try {
    if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
    Invoke-WebRequest -Uri $url -OutFile $Out -UseBasicParsing -TimeoutSec 180
  } catch {
    Fail 2 "Could not download $url : $(Reason $_)"
  }
}

# Only run an installer that is validly signed by the Npcap publisher.
$sig = Get-AuthenticodeSignature -LiteralPath $Out
if ($sig.Status -ne 'Valid') {
  Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue
  Fail 3 "The downloaded installer's signature is not valid ($($sig.Status)); it was deleted."
}
$subject = $sig.SignerCertificate.Subject
if ($subject -notmatch 'Nmap Software|Insecure\.Com') {
  Remove-Item -LiteralPath $Out -Force -ErrorAction SilentlyContinue
  Fail 3 "The downloaded installer is signed by an unexpected publisher ($subject); it was deleted."
}
$publisher = ($subject -split ',')[0] -replace '^CN=', ''
Write-Output "OK $Version $publisher"
exit 0
