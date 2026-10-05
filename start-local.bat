@echo off
title Slo AI Stremio Addon (Claude Sonnet + Whisper Local)
echo ========================================================
echo  Zagon Slo AI Stremio Addona (Lokalni Whisper + Claude Sonnet)
echo ========================================================
cd /d "%~dp0"

if not exist node_modules (
    echo [INFO] Namescanje potrebnih Node.js paketov...
    call npm install
)

set PORT=7002
set PUBLIC_BASE_URL=http://127.0.0.1:7002
set ANTHROPIC_MODEL=claude-3-5-sonnet-20241022

echo [INFO] Strežnik se zaganja na: http://127.0.0.1:7002/manifest.json
echo [INFO] V Stremio dodajte povezavo: http://127.0.0.1:7002/manifest.json
echo ========================================================
node index.js
pause
