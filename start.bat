@echo off
title SliceLab - Image Element Splitter
cd /d "%~dp0"

echo ============================================
echo   SliceLab starting...
echo   Web:  http://localhost:5180
echo   API:  http://localhost:5181
echo ============================================
echo.

rem ---- 1. Pick the Node runtime ----
rem A bundled runtime under runtime\node\node.exe wins.
rem Pinning the runtime keeps the native module ABI identical,
rem so copying this folder to another PC just works.
set "NODE_BIN="
set "NODE_FROM=bundled runtime"
if exist "%~dp0runtime\node\node.exe" set "NODE_BIN=%~dp0runtime\node\node.exe"
if not defined NODE_BIN (
  where node >nul 2>nul
  if errorlevel 1 goto :nonode
  set "NODE_BIN=node"
  set "NODE_FROM=system PATH"
)

echo [check] Node source: %NODE_FROM%
"%NODE_BIN%" -v
echo.

rem ---- 2. Self-check and auto-repair (deps / native ABI) ----
echo [env] checking environment, auto-repairing if needed...
"%NODE_BIN%" "%~dp0tools\ensure-env.mjs"
if errorlevel 1 goto :envfail

rem ---- 3. Start: backend first, then frontend after health check ----
echo.
echo [start] backend (5181) first, then frontend (5180)...
echo.
"%NODE_BIN%" "%~dp0tools\dev-all.mjs"

echo.
echo [exit] SliceLab stopped.
pause
exit /b 0

:nonode
echo [error] Node.js not found.
echo         Install Node 18+ from https://nodejs.org/
echo         or drop a portable node.exe into runtime\node\
pause
exit /b 1

:envfail
echo.
echo [error] environment self-check failed. Read the messages above.
pause
exit /b 1
