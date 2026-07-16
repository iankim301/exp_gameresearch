@echo off
setlocal
cd /d "%~dp0"
set "PORT=3001"
echo.
echo Game Signal Desk
echo Paste your OpenAI API key, then press Enter.
echo The key is used only while this window stays open.
set /p "OPENAI_API_KEY=API key: "
if not defined OPENAI_API_KEY (
  echo No API key was entered.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Node.js is not installed.
  echo Install the LTS version from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
echo.
echo Server is starting.
echo Open this address in Chrome or Edge: http://localhost:3001
echo Keep this window open while using the tool.
echo.
node server.mjs
echo.
echo Server stopped.
pause
