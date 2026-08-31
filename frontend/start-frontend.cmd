@echo off
REM Pulse Endpoint agent UI only (NOT Command Centre).
REM Serves this repo's frontend/dist on http://127.0.0.1:5173
REM Command Centre is start-dashboard.cmd on port 5175.
cd /d "C:\Pulse endpoint\frontend"
npm run preview
