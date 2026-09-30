@echo off
rem Brings this folder up to date from GitHub: a fast-forward only, never over uncommitted changes.
rem "Update Agent.bat -Check" only says what would come in.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\update.ps1" %*
pause
