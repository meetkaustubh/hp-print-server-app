@echo off
REM Print Nimbus - Windows laptop launcher. Double-click to start.
cd /d "%~dp0\.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing components, this takes a minute...
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 ( echo Install failed. Check your internet connection. & pause & exit /b 1 )
)
if not defined PORT set PORT=3000
set PRINT_BACKEND=windows
echo.
echo Starting Print Nimbus on http://localhost:%PORT%   (close this window to stop)
echo.
start "" "http://localhost:%PORT%/admin"
node --disable-warning=ExperimentalWarning src\server.js
echo.
echo Print Nimbus stopped.
pause
