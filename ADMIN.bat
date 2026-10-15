@echo off
title PDF Reader Admin
cd /d "%~dp0"

rem Start the server if it is not already running
curl -s -o nul http://localhost:3000/api/config
if not errorlevel 1 goto open

echo Server is not running - starting it...
if not exist node_modules\pdfjs-dist call npm install
start "Interactive PDF Reader - server" /min node server.js

:wait
timeout /t 1 >nul
curl -s -o nul http://localhost:3000/api/config
if errorlevel 1 goto wait

:open
rem Open the admin panel in its own window, on top of the player
start "" msedge --user-data-dir="%LOCALAPPDATA%\PdfReaderAdmin" --no-first-run --app=http://localhost:3000/admin
