@echo off
rem Lets Minecraft (Store/UWP build) connect to a server on this same PC. Run as administrator, once.
CheckNetIsolation LoopbackExempt -a -n="Microsoft.MinecraftUWP_8wekyb3d8bbwe"
CheckNetIsolation LoopbackExempt -a -n="Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe"
echo Done. Restart Minecraft and connect to 127.0.0.1 port 19132.
pause
