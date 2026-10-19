; Explorer integration for audio files.
;
; `bundle.fileAssociations` only registers the "MusicTagCleaner Audio" ProgID,
; which Explorer ignores whenever another player owns the extension's
; UserChoice (AIMP, foobar, ...). So we also add:
;   - a dedicated verb under SystemFileAssociations\<ext>, shown regardless of
;     the default app (Windows 11: under "Show more options" / Shift+F10);
;   - the ProgID under <ext>\OpenWithProgids, so it lists in "Open with".
; MultiSelectModel=Player keeps the verb visible for any number of selected
; files; each file launches the exe and the single-instance hook merges them.
; The key and ProgID names keep the old "MusicTagCleaner" spelling so upgrades
; overwrite and uninstalls remove what older versions wrote; only the visible
; MUIVerb text carries the Vatra Wave name.

!macro MTC_ADD_AUDIO_VERB EXT
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\MusicTagCleaner" "MUIVerb" "Open with Vatra Wave"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\MusicTagCleaner" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\MusicTagCleaner" "MultiSelectModel" "Player"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\MusicTagCleaner\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegNone SHCTX "Software\Classes\${EXT}\OpenWithProgids" "MusicTagCleaner Audio"
!macroend

!macro MTC_ADD_OPEN_WITH EXT
  WriteRegNone SHCTX "Software\Classes\${EXT}\OpenWithProgids" "MusicTagCleaner Audio"
!macroend

!macro MTC_REMOVE_AUDIO_VERB EXT
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\${EXT}\shell\MusicTagCleaner"
  DeleteRegValue SHCTX "Software\Classes\${EXT}\OpenWithProgids" "MusicTagCleaner Audio"
!macroend

!macro MTC_FOR_EACH_AUDIO_EXT MACRO
  !insertmacro ${MACRO} ".mp3"
  !insertmacro ${MACRO} ".flac"
  !insertmacro ${MACRO} ".ogg"
  !insertmacro ${MACRO} ".aac"
  !insertmacro ${MACRO} ".m4a"
  !insertmacro ${MACRO} ".wav"
  !insertmacro ${MACRO} ".aiff"
  !insertmacro ${MACRO} ".aif"
!macroend

; One-time move from the "MusicTagCleaner" productName (v0.19.1 and earlier).
;
; productName names the install dir, the uninstall key, MANUPRODUCTKEY and the
; shortcuts, so a "Vatra Wave" installer (or the updater running it with
; /UPDATE) finds no previous install and would put a second copy in
; $LOCALAPPDATA\Vatra Wave beside the old one. PREINSTALL runs before any file
; is copied or association written: it closes the old app, runs the old
; uninstaller silently in place, then removes what that left. /UPDATE keeps
; the old uninstaller from unpinning the taskbar and clearing the jump list of
; the AppUserModelID, which is the bundle identifier and so shared with the
; new install. App data lives under the identifier too and is never touched.
; POSTINSTALL then recreates the shortcuts the old install had (an /UPDATE run
; of the template creates none) and repoints a taskbar pin at the new exe.
!define MTC_OLD_NAME "MusicTagCleaner"
!define MTC_OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${MTC_OLD_NAME}"
!define MTC_OLD_MANUPRODUCTKEY "${MANUKEY}\${MTC_OLD_NAME}"
!define MTC_TASKBAR_PINS "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"

Var MtcOldDir
Var MtcOldExe
Var MtcHadStartLnk
Var MtcHadDesktopLnk

!macro MTC_MIGRATE_OLD_INSTALL
  StrCpy $MtcHadStartLnk 0
  StrCpy $MtcHadDesktopLnk 0
  ReadRegStr $MtcOldDir SHCTX "${MTC_OLD_MANUPRODUCTKEY}" ""
  ${If} $MtcOldDir == ""
    ; InstallLocation is written quoted.
    ReadRegStr $MtcOldDir SHCTX "${MTC_OLD_UNINSTKEY}" "InstallLocation"
    StrCpy $0 $MtcOldDir 1
    ${If} $0 == '"'
      StrCpy $MtcOldDir $MtcOldDir -1 1
    ${EndIf}
  ${EndIf}

  ${If} $MtcOldDir != ""
    ReadRegStr $MtcOldExe SHCTX "${MTC_OLD_UNINSTKEY}" "MainBinaryName"
    ${IfThen} $MtcOldExe == "" ${|} StrCpy $MtcOldExe "${MAINBINARYNAME}.exe" ${|}
    StrCpy $MtcOldExe "$MtcOldDir\$MtcOldExe"

    !insertmacro IsShortcutTarget "$SMPROGRAMS\${MTC_OLD_NAME}.lnk" "$MtcOldExe"
    Pop $MtcHadStartLnk
    !insertmacro IsShortcutTarget "$DESKTOP\${MTC_OLD_NAME}.lnk" "$MtcOldExe"
    Pop $MtcHadDesktopLnk

    !insertmacro CheckIfAppIsRunning "$MtcOldExe" "${PRODUCTNAME}"

    ${If} ${FileExists} "$MtcOldDir\uninstall.exe"
      DetailPrint "Removing the previous ${MTC_OLD_NAME} install in $MtcOldDir"
      ExecWait '"$MtcOldDir\uninstall.exe" /S /UPDATE _?=$MtcOldDir'
      ; Run in place (_?=), the uninstaller can't delete itself or its folder.
      Delete "$MtcOldDir\uninstall.exe"
      RMDir "$MtcOldDir"
    ${EndIf}

    ${If} $MtcHadStartLnk = 1
      Delete "$SMPROGRAMS\${MTC_OLD_NAME}.lnk"
    ${EndIf}
    ${If} $MtcHadDesktopLnk = 1
      Delete "$DESKTOP\${MTC_OLD_NAME}.lnk"
    ${EndIf}
    ; The uninstaller drops its key itself; this covers a missing uninstall.exe.
    DeleteRegKey SHCTX "${MTC_OLD_UNINSTKEY}"
    DeleteRegKey SHCTX "${MTC_OLD_MANUPRODUCTKEY}"
    DeleteRegKey HKCU "${MTC_OLD_MANUPRODUCTKEY}"
  ${EndIf}
!macroend

!macro MTC_FINISH_MIGRATION
  ${If} $MtcOldDir != ""
    ${If} $MtcHadStartLnk = 1
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} $MtcHadDesktopLnk = 1
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    ; Renaming a pin's .lnk would orphan it, so only its target moves; the pin
    ; keeps its old tooltip until it is unpinned and pinned again.
    !insertmacro IsShortcutTarget "${MTC_TASKBAR_PINS}\${MTC_OLD_NAME}.lnk" "$MtcOldExe"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "${MTC_TASKBAR_PINS}\${MTC_OLD_NAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MTC_MIGRATE_OLD_INSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro MTC_FINISH_MIGRATION
  ; With the Windows 11 main-menu extension installed (its DLL sits in
  ; $INSTDIR), that entry already shows under "Show more options" too, so the
  ; classic verb would list twice there. OpenWithProgids is still wanted.
  IfFileExists "$INSTDIR\music_tag_cleaner_shell.dll" 0 mtc_add_verbs
    !insertmacro MTC_FOR_EACH_AUDIO_EXT MTC_REMOVE_AUDIO_VERB
    !insertmacro MTC_FOR_EACH_AUDIO_EXT MTC_ADD_OPEN_WITH
    Goto mtc_verbs_done
  mtc_add_verbs:
    !insertmacro MTC_FOR_EACH_AUDIO_EXT MTC_ADD_AUDIO_VERB
  mtc_verbs_done:
  ; Tell Explorer the associations changed so the menu updates without a restart.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro MTC_FOR_EACH_AUDIO_EXT MTC_REMOVE_AUDIO_VERB
  ; The Windows 11 main-menu entry (windows\sparse\build.ps1 -Install) is a
  ; sparse package pointing at $INSTDIR plus a DLL there; drop both if present.
  nsExec::Exec 'powershell -NoProfile -Command "Get-AppxPackage SergioAlexo.MusicTagCleaner.ShellExtension | Remove-AppxPackage"'
  Delete "$INSTDIR\music_tag_cleaner_shell.dll"
  RMDir "$INSTDIR"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
