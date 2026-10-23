@echo off
rem ===========================================================================
rem  wx-bridge launcher (ASCII only on purpose).
rem
rem  cmd.exe parses .bat/.cmd using the console ANSI codepage (GBK on a Chinese
rem  Windows). A UTF-8 file containing Chinese text gets decoded as garbage and
rem  the window closes instantly. All Chinese output lives in start.ps1 instead.
rem
rem  This machine has no node on PATH, so before the usual lookup we prepend
rem  every bundled Node.js we can find (DSH ships one under %LOCALAPPDATA%).
rem ===========================================================================
cd /d "%~dp0"

rem Switch console to UTF-8 so node's Chinese log isn't mangled.
chcp 65001 >nul 2>nul

rem ---- locate a usable node.exe -------------------------------------------
set "NODE_EXE="

rem 1) already on PATH
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"

rem 2) DSH bundled runtime
if not defined NODE_EXE call :try_node "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE call :try_node "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\bin\node.exe"

rem 3) common install locations
if not defined NODE_EXE call :try_node "%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE call :try_node "%LOCALAPPDATA%\Programs\nodejs\node.exe"

rem 4) the .cmd on PATH points at a real node.exe
if not defined NODE_EXE call :try_node "%APPDATA%\npm\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found. Install from https://nodejs.org
  echo.
  pause >nul
  exit /b 1
)

rem Put its folder first so node / start.ps1 both resolve to this one.
for %%A in ("%NODE_EXE%") do set "NODE_DIR=%%~dpA"
set "PATH=%NODE_DIR%;%PATH%"

rem Prefer PowerShell 7 when available; fall back to Windows PowerShell 5.1.
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

%PS% -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo   [ERROR] launcher exited with code %EXITCODE%.
  pause >nul
)
exit /b %EXITCODE%

:try_node
rem Accept only a real executable (some machines have a 0-byte placeholder).
if not exist "%~1" exit /b 0
for %%A in ("%~1") do if %%~zA LEQ 1024 exit /b 0
set "NODE_EXE=%~1"
exit /b 0
