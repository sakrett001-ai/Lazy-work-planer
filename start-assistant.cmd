@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto need_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) === 24 ? 0 : 1)"
if errorlevel 1 goto need_node
if not exist node_modules\zod\package.json (
  echo Installing project dependencies. Please wait...
  call npm ci
  if errorlevel 1 goto failed
)
echo Open http://127.0.0.1:8787/assistant/workspace after the server starts.
echo The terminal will show your one-time manager login code.
echo Keep this window open while using the assistant.
node --env-file-if-exists=.env scripts/prototype.mjs
if errorlevel 1 goto failed
exit /b 0
:need_node
echo Install Node.js 24 from https://nodejs.org/ and run this file again.
pause
exit /b 1
:failed
echo Startup failed. The error is shown above.
pause
exit /b 1
