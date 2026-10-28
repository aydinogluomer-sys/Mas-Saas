@echo off
title MAS Nakit Radar - Production Server
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ========================================================
echo  MAS Nakit Radar - 7/24 Kesintisiz Production Sunucusu
echo ========================================================
echo.

:: Check if port 3000 is already in use
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [BILGI] Port 3000 zaten aktif! Tarayici aciliyor...
    start http://localhost:3000
    exit /b 0
)

echo Sunucu baslatiliyor...
start http://localhost:3000
:: pnpm (packageManager) + "call": kontrol bu dosyaya geri doner ve "pause" calisir.
:: PostgreSQL kapaliysa zincirdeki scripts\db\ensure.ts durumu ve sonraki adimi yazar.
call pnpm start
pause
