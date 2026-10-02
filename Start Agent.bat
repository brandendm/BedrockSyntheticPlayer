@echo off
rem Brings the folder up to date from GitHub first (tools\update.ps1: a fast-forward only, never over uncommitted changes; it says why if it
rem cannot and the start goes on with what is here), then starts the brain and the Bedrock Dedicated Server. "Start Agent.bat noupdate" skips the update.
rem The update runs inside one parenthesised block (cmd reads it whole before running it), so a changed copy of this file cannot upset the run,
rem and then starts the new copy of this file.
if /i "%~1"=="--updated" goto run
if /i "%~1"=="noupdate" goto run
(
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update.ps1"
  if errorlevel 1 timeout /t 6
  call "%~f0" --updated %*
  exit /b
)
:run
shift
rem Starts the brain and the Bedrock Dedicated Server. With Python the brain runs the server itself, in ONE window (its console is that window: you
rem can still type "stop" there), so the bot can ask the game where the nearest village or forest is (/locate, typed into the console).
rem Without Python the server gets its own window as before. Close the window to stop.
title Bedrock Agent launcher
cd /d "%~dp0"

set "PY="
python --version >nul 2>&1 && set "PY=python"
if not defined PY py -3 --version >nul 2>&1 && set "PY=py -3"

if not exist "server\bedrock_server.exe" (
  echo server\bedrock_server.exe is missing. See README, Setup step 1.
  pause
  exit /b 1
)
rem A new world for each update (tools\new_world.ps1): only when the build changed; "Start Agent.bat keep" skips it.
if /i "%~1"=="keep" (set "NEWWORLD=-Keep") else (set "NEWWORLD=")
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\new_world.ps1" %NEWWORLD%

if defined PY (
  rem "Start Agent.bat noserver": the brain alone, the server started by hand (no /locate answers).
  if /i "%~1"=="noserver" (
    start "Bedrock Agent - brain" cmd /k %PY% -m brain.server
    start "Bedrock Agent - server" /d "%~dp0server" bedrock_server.exe
  ) else (
    start "Bedrock Agent - brain + server" cmd /k %PY% -m brain.server --server
  )
) else (
  echo Python 3 not found, so the brain won't run.
  echo The bot still understands: come, follow me, stop, goto x y z
  echo Install Python from python.org to enable Jev and free-form commands.
  echo.
  start "Bedrock Agent - server" /d "%~dp0server" bedrock_server.exe
)

rem The dashboard (status and controls) is served by the brain.
if defined PY (
  timeout /t 3 >nul
  start "" http://127.0.0.1:8765/
)

echo Started. In Minecraft: Play ^> Servers ^> Add Server, address 127.0.0.1 port 19132.
echo Then type in chat:  !bot spawn   (or use the dashboard that just opened: http://127.0.0.1:8765/)
timeout /t 15
