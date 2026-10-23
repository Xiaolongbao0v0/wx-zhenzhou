@echo off
REM ===================================================================
REM  AI WeChat Bot - graphical control panel (launcher)
REM
REM  Pure ASCII on purpose: cmd.exe parses .cmd with the console
REM  codepage (GBK on zh-CN), so Chinese here would corrupt and the
REM  window would close instantly. All Chinese UI lives in
REM  bot-panel.ps1 (UTF-8 with BOM).
REM ===================================================================
setlocal
cd /d "%~dp0"

if not exist "%~dp0bot-panel.ps1" (
  echo.
  echo   [ERROR] bot-panel.ps1 is missing next to this launcher.
  echo.
  pause
  exit /b 1
)

REM Prefer PowerShell 7, fall back to Windows PowerShell 5.1.
REM -STA is required for WinForms.
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

start "" %PS% -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0bot-panel.ps1"
exit /b 0
