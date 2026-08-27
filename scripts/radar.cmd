@echo off
rem Viral Radar launcher. Starts the server and opens the dashboard.
rem Close this window to stop collecting.
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or not on PATH.
  echo   Install Node.js 24 or newer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "apps\web\dist\index.html" (
  echo   Building the dashboard for the first time...
  call npm run build || goto :failed
)

rem Give the server a moment to bind before the browser asks for the page.
start "" /b cmd /c "timeout /t 4 >nul & start "" http://127.0.0.1:7788"

echo.
echo   Viral Radar is starting. The dashboard will open shortly.
echo   Close this window to stop it.
echo.
node apps/api/src/main.ts serve
exit /b 0

:failed
echo.
echo   The build failed. Run "npm run setup" in this folder to see why.
echo.
pause
exit /b 1
