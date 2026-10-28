@echo off
rem MAS Nakit Radar -- telemetri gozetim gorevi (Windows Task Scheduler bunu calistirir).
rem ASAMA 09: rehber §14 "Schedule" -- telemetry snapshot + backup-age + stale-data + queue.
rem Yol bagimsiz: repo koku bu dosyanin konumundan turetilir (%~dp0 = scripts\ops\).
rem ASCII-only: Task Scheduler'in kod sayfasi Turkce karakterleri bozabilir.
setlocal
pushd "%~dp0..\.." || exit /b 1
if not exist "logs" mkdir "logs"
set "LOG=%CD%\logs\telemetry-watch-task.log"
echo. >> "%LOG%"
echo [%DATE% %TIME%] MAS telemetry watch START (cwd=%CD%) >> "%LOG%"
call pnpm exec tsx scripts/ops/telemetry-watch.ts >> "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
echo [%DATE% %TIME%] MAS telemetry watch END exit=%CODE% >> "%LOG%"
rem exit 0 = temiz, 1 = uyari teslim edildi, 2 = ALARM TESLIMATI BASARISIZ, 3 = snapshot kosamadi.
popd
endlocal & exit /b %CODE%
