@echo off
cd /d "%~dp0"
title NeoCraft Control - Windows Installer Builder
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" (
    echo [ERROR] Setup finished with exit code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
