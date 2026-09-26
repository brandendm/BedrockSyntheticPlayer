@echo off
rem Starts the brain (if Python is installed) and the Bedrock Dedicated Server in their own windows.
rem Close either window to stop it. In the server window you can type "stop" to shut down cleanly.
title Bedrock Agent launcher
cd /d "%~dp0"

set "PY="
python --version >nul 2>&1 && set "PY=python"
if not defined PY py -3 --version >nul 2>&1 && set "PY=py -3"

if defined PY (
  start "Bedrock Agent - brain" cmd /k %PY% -m brain.server
) else (
  echo Python 3 not found, so the brain won't run.
  echo The bot still understands: come, follow me, stop, goto x y z
  echo Install Python from python.org to enable Jev and free-form commands.
  echo.
)

if not exist "server\bedrock_server.exe" (
  echo server\bedrock_server.exe is missing. See README, Setup step 1.
  pause
  exit /b 1
)
start "Bedrock Agent - server" /d "%~dp0server" bedrock_server.exe

rem The dashboard (status and controls) is served by the brain.
if defined PY (
  timeout /t 3 >nul
  start "" http://127.0.0.1:8765/
)

echo Started. In Minecraft: Play ^> Servers ^> Add Server, address 127.0.0.1 port 19132.
echo Then type in chat:  !bot spawn   (or use the dashboard that just opened: http://127.0.0.1:8765/)
timeout /t 15
