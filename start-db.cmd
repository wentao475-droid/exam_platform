@echo off
rem Start the packaged PostgreSQL 16 for the grading workbench (port 55432).
rem Postgres opens in its OWN minimized window titled "PostgreSQL grading".
rem Keep that window open (minimized is fine). Closing it stops the database.
setlocal
set BIN=C:\Users\Vision\AppData\Local\Temp\exam-platform-win-98d39c4\package\native\bin
set DATA=C:\Users\Vision\AppData\Local\Temp\exam-platform-win-98d39c4\pgdata

rem Stop any leftover instance from a previous session.
"%BIN%\pg_ctl.exe" -D "%DATA%" -m fast stop >nul 2>&1
taskkill /IM postgres.exe /F >nul 2>&1

start "PostgreSQL grading" /min "%BIN%\postgres.exe" -D "%DATA%"

rem Wait up to 30 seconds for port 55432.
set /a tries=0
:wait
timeout /t 2 /nobreak >nul
netstat -ano | findstr ":55432" | findstr "LISTENING" >nul
if %errorlevel%==0 goto ready
set /a tries+=1
if %tries% lss 15 goto wait

echo [FAIL] PostgreSQL did not start. Check the log:
echo        %DATA%\server.log
pause
exit /b 1

:ready
echo [OK] PostgreSQL is running on 127.0.0.1:55432
echo Keep the minimized "PostgreSQL grading" window open while grading.
pause
