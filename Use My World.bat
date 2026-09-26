@echo off
rem Pick one of your single-player worlds and put a copy of it on the agent's server.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\import_world.ps1"
pause
