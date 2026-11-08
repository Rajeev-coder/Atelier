@echo off
setlocal
title Atelier - Multi-Tenant Service Business Platform

echo ======================================================================
echo    ATELIER - MULTI-TENANT SERVICE BUSINESS PLATFORM
echo    Next-Gen Web3 Glass Console and Storefront
echo ======================================================================
echo.

REM 1. Navigate to script directory
cd /d "%~dp0"

REM 2. Ensure Node.js and NVM paths are present
set "PATH=C:\nvm4w\nodejs;%LOCALAPPDATA%\nvm\v22.19.0;%NVM_HOME%;%NVM_SYMLINK%;%PATH%"

REM 3. Check for Node.js
where node >nul 2>nul
if errorlevel 1 goto :no_node

REM 4. Free port 3000 if occupied
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo [INFO] Freeing port 3000 - PID %%a
    taskkill /f /pid %%a >nul 2>nul
)

REM 5. Automatically open browser in background
echo [1/2] Launching browser at http://localhost:3000 ...
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"

REM 6. Start server
echo [2/2] Starting Atelier Web3 Application Server ...
echo.
echo ======================================================================
echo    Server is LIVE at: http://localhost:3000
echo    Press Ctrl+C in this window at any time to stop the server.
echo ======================================================================
echo.

call npx tsx src/server.ts
goto :end

:no_node
echo.
echo [ERROR] Node.js was not detected in PATH.
echo Please ensure Node.js is installed or run: nvm use 22
echo.
pause
exit /b 1

:end
if errorlevel 1 (
    echo.
    echo [ERROR] Application stopped unexpectedly.
    pause
)
