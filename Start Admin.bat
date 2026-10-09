@echo off
rem The Bedrock admin service: a program of its own that owns the Bedrock server (start/stop/restart, console, hot backups, restore, server.properties,
rem saved command chains). The panel opens in the browser, already signed in. The bot gets a limited token (see README, "Admin service").
rem Use it INSTEAD of "Start Agent.bat" for the server: start this first, then run the brain alone:  python -m brain.server
rem (brain\config.json: "admin_url": "http://127.0.0.1:8780", "admin_bot_token": the bot token from admin\config.json)
title Bedrock Admin
cd /d "%~dp0"
set "PY="
python --version >nul 2>&1 && set "PY=python"
if not defined PY py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY (
  echo Python 3 is needed for the admin service.
  pause
  exit /b 1
)
%PY% -m admin.service --open %*
pause
