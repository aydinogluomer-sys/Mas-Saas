@echo off
title MAS Nakit Radar - Production Server
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NO_PAUSE=0"
set "NO_BROWSER=0"
:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"
if /I "%~1"=="--no-browser" set "NO_BROWSER=1"
shift
goto parse_args
:args_done

echo ========================================================
echo  MAS Nakit Radar - 7/24 Kesintisiz Production Sunucusu
echo ========================================================
echo.

:: Sonunda boslukla tam port eslesmesi (:30000 gibi portlari yanlislikla yakalamaz)
netstat -ano | findstr /R /C:":3000 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [BILGI] Port 3000 zaten aktif! Hazirlik kontrol ediliyor...
    if "%NO_BROWSER%"=="0" start "" "http://127.0.0.1:3000"
    exit /b 0
)

echo Sunucu baslatiliyor (127.0.0.1:3000)...
if "%NO_BROWSER%"=="0" (
    start /b "" powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Seconds 1; try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/ready' -TimeoutSec 2; if ($r.StatusCode -eq 200) { Start-Process 'http://127.0.0.1:3000'; break } } catch {} }"
)

:: pnpm (packageManager) + "call": kontrol bu dosyaya geri doner.
:: PostgreSQL kapaliysa zincirdeki scripts\db\ensure.ts durumu ve sonraki adimi yazar.
call pnpm start
set "EXIT_CODE=%ERRORLEVEL%"
if "%NO_PAUSE%"=="0" pause
exit /b %EXIT_CODE%
