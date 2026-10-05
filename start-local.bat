@echo off
chcp 65001 >nul
title Slo AI Stremio Addon (Sonnet 5.5 + Whisper Local)

echo ========================================================
echo  Zagon Slo AI Stremio Addona (Lokalni Whisper + Sonnet 5.5)
echo ========================================================

cd /d "%~dp0"

REM Nastavitev poti za Node, Python in FFmpeg
if exist "%LOCALAPPDATA%\hermes\node" set "PATH=%LOCALAPPDATA%\hermes\node;%PATH%"
if exist "%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts" set "PATH=%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts;%PATH%"
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin" set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin;%PATH%"

set PORT=7002
set PUBLIC_BASE_URL=http://127.0.0.1:7002
set ANTHROPIC_MODEL=claude-sonnet-5-5

echo [INFO] Strežnik se zaganja na: http://127.0.0.1:7002/manifest.json
echo [INFO] V Stremio dodajte povezavo: http://127.0.0.1:7002/manifest.json
echo ========================================================

node index.js
pause
