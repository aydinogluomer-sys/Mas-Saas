@echo off
setlocal
REM MAS Nakit Radar — Birlesik TypeScript Arka Plan Iscisi (Faz 42 / B2)
REM Windows Gorev Zamanlayici (Task Scheduler) ve servis gozetleyicisi sarmalayicisi.

cd /d "%~dp0..\.."
if errorlevel 1 exit /b 1

if not exist "logs" mkdir "logs"
set "NODE_ENV=production"
set "PGAPPNAME=mas_background_worker"

node --max-old-space-size=256 --import tsx scripts/ops/background-worker.ts %* >> "logs\background-worker.log" 2>&1
exit /b %ERRORLEVEL%

