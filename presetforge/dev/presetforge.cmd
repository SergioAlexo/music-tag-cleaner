@echo off
rem Dev shim: lets the app run the engine from source (set MTC_PRESETFORGE to this file).
if defined PRESETFORGE_PYTHON (
  "%PRESETFORGE_PYTHON%" -m presetforge %*
) else (
  py -3 -m presetforge %*
)
