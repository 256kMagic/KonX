; KonX installer additions (electron-builder NSIS hooks).
; Adds a "Packet capture" page that detects Npcap and, if it is missing, offers to
; download Npcap's official installer, verify its signature and run it. KonX captures
; without Npcap (Windows' built-in capture driver), so this is an optional upgrade and
; unchecked by default. Npcap is not bundled: its free license does not allow
; redistribution, and its free edition cannot be installed silently, so the user goes
; through Npcap's own setup and license.

!include LogicLib.nsh
!include x64.nsh
!include nsDialogs.nsh

; Sets $KonxNpcapFound = 1 when Npcap is installed, and $KonxNpcapVer to its version ("" if unknown).
!macro KonxDetectNpcap
  StrCpy $KonxNpcapFound 0
  StrCpy $KonxNpcapVer ""
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  ${If} ${FileExists} "$WINDIR\System32\Npcap\wpcap.dll"
    StrCpy $KonxNpcapFound 1
    ClearErrors
    GetDLLVersion "$WINDIR\System32\Npcap\wpcap.dll" $R6 $R7
    ${IfNot} ${Errors}
      IntOp $R4 $R6 >> 16
      IntOp $R5 $R6 & 0xFFFF
      StrCpy $KonxNpcapVer "$R4.$R5"
    ${EndIf}
  ${EndIf}
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Var KonxNpcapWanted
  Var KonxNpcapBox
  Var KonxNpcapFound
  Var KonxNpcapVer

  Page custom KonxNpcapPageCreate KonxNpcapPageLeave

  Function KonxNpcapPageCreate
    StrCpy $KonxNpcapWanted ${BST_UNCHECKED}
    !insertmacro KonxDetectNpcap
    !insertmacro MUI_HEADER_TEXT "Packet capture" "KonX captures live traffic with the driver built into Windows; Npcap is optional."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${If} $KonxNpcapFound == 1
      ${If} $KonxNpcapVer != ""
        ${NSD_CreateLabel} 0 0 100% 24u "Npcap $KonxNpcapVer is already installed. KonX will use it for live capture."
      ${Else}
        ${NSD_CreateLabel} 0 0 100% 24u "Npcap is already installed. KonX will use it for live capture."
      ${EndIf}
      Pop $0
    ${Else}
      ${NSD_CreateLabel} 0 0 100% 30u "Live capture works without extra software: KonX uses the packet capture driver built into Windows, and Windows asks for administrator permission each time you start a capture."
      Pop $0
      ${NSD_CreateCheckbox} 0 34u 100% 12u "&Also download and install Npcap from npcap.com (optional)"
      Pop $KonxNpcapBox
      ${NSD_CreateLabel} 12u 50u 95% 62u "Npcap captures without the permission prompt, sees loopback traffic and supports BPF capture filters. Setup downloads Npcap's official installer, checks its digital signature and opens it; you go through Npcap's own setup and license. Npcap is free for personal use on up to 5 computers; wider use needs an Npcap OEM license (npcap.com/oem)."
      Pop $0
      ${NSD_CreateLabel} 12u 114u 95% 20u "You can also install Npcap later from KonX: Packet Capture > Install Npcap."
      Pop $0
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function KonxNpcapPageLeave
    ${If} $KonxNpcapFound != 1
      ${NSD_GetState} $KonxNpcapBox $KonxNpcapWanted
    ${EndIf}
  FunctionEnd
!macroend

!macro customInstall
  ${If} $KonxNpcapWanted == ${BST_CHECKED}
  ${AndIfNot} ${Silent}
    InitPluginsDir
    SetDetailsPrint both
    DetailPrint "Downloading Npcap from npcap.com..."
    File "/oname=$PLUGINSDIR\get-npcap.ps1" "${BUILD_RESOURCES_DIR}\get-npcap.ps1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\get-npcap.ps1" -Out "$PLUGINSDIR\npcap-setup.exe"'
    Pop $0
    Pop $1
    ${If} $0 == 0
      DetailPrint "Verified: $1"
      DetailPrint "Opening the Npcap installer..."
      ClearErrors
      ExecShellWait "open" "$PLUGINSDIR\npcap-setup.exe"
      !insertmacro KonxDetectNpcap
      ${If} $KonxNpcapFound == 1
        DetailPrint "Npcap is installed. Live packet capture is ready."
      ${Else}
        DetailPrint "Npcap was not installed. You can install it later from KonX."
      ${EndIf}
    ${Else}
      DetailPrint "Npcap was not installed: $1"
      MessageBox MB_OK|MB_ICONEXCLAMATION "KonX could not get Npcap:$\r$\n$\r$\n$1$\r$\n$\r$\nKonX itself will still be installed. Install Npcap later from KonX (Packet Capture > Install Npcap) or from https://npcap.com/#download." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend
