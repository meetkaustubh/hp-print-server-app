@echo off
REM Makes Print Nimbus start automatically whenever you log in to Windows.
cd /d "%~dp0"
schtasks /create /tn "PrintNimbus" /tr "\"%~dp0start-laptop.bat\"" /sc onlogon /rl limited /f
if errorlevel 1 ( echo Could not create the task. Try running this file as Administrator. ) else ( echo Done. Print Nimbus will start at login. To remove: schtasks /delete /tn PrintNimbus /f )
echo.
echo Tip: Settings - System - Power - set "Sleep" to Never while plugged in, or the kiosk goes offline when the laptop sleeps.
pause
