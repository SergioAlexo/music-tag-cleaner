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

!macro NSIS_HOOK_POSTINSTALL
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
