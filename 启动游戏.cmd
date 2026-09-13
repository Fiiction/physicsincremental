@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run dev -- --port 5173 --strictPort --open
pause
