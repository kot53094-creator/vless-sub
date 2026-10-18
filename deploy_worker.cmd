@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy_worker.ps1"
echo.
pause
