@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  PicSelect launcher
rem  Kept ASCII-only on purpose: batch files are parsed with the
rem  console code page, and non-ASCII lines can break parsing on
rem  some Windows locales. Chinese docs live in README.md.
rem ============================================================

set "ELECTRON_BIN=node_modules\electron\dist\electron.exe"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [PicSelect] Node.js not found. Install it from https://nodejs.org/ then run again.
  echo.
  pause
  exit /b 1
)

if not exist "%ELECTRON_BIN%" (
  echo [PicSelect] First run: installing dependencies ^(electron only^) ...
  call npm install
  if errorlevel 1 (
    echo.
    echo [PicSelect] npm install failed. Check your network and retry, or run "npm install" manually.
    echo.
    pause
    exit /b 1
  )
)

if not exist "%ELECTRON_BIN%" (
  echo [PicSelect] Downloading the Electron runtime ...
  call node node_modules\electron\install.js
)

if not exist "%ELECTRON_BIN%" (
  echo.
  echo [PicSelect] Electron runtime is missing. Run "npm install" manually and retry.
  echo.
  pause
  exit /b 1
)

rem Inherited ELECTRON_RUN_AS_NODE would degrade electron.exe into plain Node
set "ELECTRON_RUN_AS_NODE="

start "" "%ELECTRON_BIN%" .
