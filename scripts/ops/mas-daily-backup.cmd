@echo off
rem MAS Nakit Radar -- gunluk yedek gorevi (Windows Task Scheduler bunu calistirir).
rem Yol bagimsiz: repo koku bu dosyanin konumundan turetilir (%~dp0 = scripts\ops\).
rem ASCII-only: Task Scheduler'in kod sayfasi Turkce karakterleri bozabilir.
setlocal
pushd "%~dp0..\.." || exit /b 1
if not exist "backups" mkdir "backups"
set "LOG=%CD%\backups\daily-backup-task.log"
echo. >> "%LOG%"
echo [%DATE% %TIME%] MAS daily backup START (cwd=%CD%) >> "%LOG%"
call pnpm exec tsx scripts/ops/backup-daily.ts >> "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
echo [%DATE% %TIME%] MAS daily backup END exit=%CODE% >> "%LOG%"
popd
endlocal & exit /b %CODE%
