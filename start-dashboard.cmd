@echo off
REM Command Centre only (NOT Pulse Endpoint).
REM Pulse Endpoint UI is frontend/start-frontend.cmd on http://127.0.0.1:5173
REM This dashboard is http://127.0.0.1:5175 — never bind 5173.
cd /d "C:\Users\Dell\Desktop\pulse-endpoint-integration\dashboard"
npm run dev
