@echo off
title Interactive PDF Reader - server
cd /d "%~dp0"
if not exist node_modules\pdfjs-dist call npm install

rem Start the player in fullscreen once the server is up
start "" /min cmd /c "timeout /t 2 >nul & start msedge --user-data-dir="%LOCALAPPDATA%\PdfReaderPlayer" --kiosk http://localhost:3000/ --edge-kiosk-type=fullscreen --no-first-run"

node server.js
echo.
echo Server stopped. (If you see "EADDRINUSE", the server is already running in another window.)
pause
