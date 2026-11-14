@echo off
REM Print Nimbus - Windows launcher that auto-updates from GitHub every minute. Double-click to start.
cd /d "%~dp0\.."
where node >nul 2>nul
if errorlevel 1 ( echo Node.js is not installed. Install the LTS version from https://nodejs.org & pause & exit /b 1 )
where git >nul 2>nul
if errorlevel 1 ( echo Git is not installed. Install it from https://git-scm.com & pause & exit /b 1 )
if not exist node_modules (
  echo First run: installing components, this takes a minute...
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 ( echo Install failed. & pause & exit /b 1 )
)
set PORT=3000
set PRINT_BACKEND=windows
echo.
echo Starting Print Nimbus on http://localhost:%PORT% with auto-update   (close this window to stop)
echo.
start "" "http://localhost:%PORT%/admin"
node scripts\run-synced.js
pause
