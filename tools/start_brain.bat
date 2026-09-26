@echo off
rem Starts the brain from the repo root. Set JEV_API_KEY first to enable Jev; without it the bot runs on rules only.
cd /d "%~dp0\.."
python -m brain.server
