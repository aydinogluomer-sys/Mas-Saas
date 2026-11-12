@echo off
title MAS Nakit Radar - Sunucuyu Durdur
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NO_PAUSE=0"
:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"
shift
goto parse_args
:args_done

echo ========================================================
echo  MAS Nakit Radar - Sunucu Kapatma
echo ========================================================
echo.

:: Sonunda boslukla tam port eslesmesi (:30000 gibi portlari yanlislikla sonlandirmaz)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":3000 " ^| findstr "LISTENING"') do (
    echo [BILGI] Port 3000 uzerinde calisan PID %%a sonlandiriliyor...
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo Sunucu basariyla durduruldu.
if "%NO_PAUSE%"=="0" timeout /t 3 >nul
exit /b 0
