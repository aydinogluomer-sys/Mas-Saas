@echo off
title MAS Nakit Radar - Sunucuyu Durdur
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ========================================================
echo  MAS Nakit Radar - Sunucu Kapatma
echo ========================================================
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo [BILGI] Port 3000 uzerinde calisan PID %%a sonlandiriliyor...
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo Sunucu basariyla durduruldu.
timeout /t 3 >nul
