@echo off
rem Registers the overnight loop to run every day at 05:30 (Windows Task Scheduler). Needs Node on the PATH. Remove with:  schtasks /delete /tn BedrockNightly /f
cd /d "%~dp0.."
schtasks /create /tn BedrockNightly /tr "cmd /c cd /d %CD% && node tools/nightly.mjs --tune >> brain\reports\nightly.log 2>&1" /sc daily /st 05:30 /f
echo Registered: BedrockNightly daily 05:30. Reports land in brain\reports\nightly-DATE.md
