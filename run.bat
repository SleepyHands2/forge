@echo off
setlocal
title Forge Launcher
rem One-click Forge: ensures Ollama is up, starts the Forge server if it
rem is not already running, then opens the web UI in the default browser.
rem Safe to double-click again while Forge is running (just opens the UI).

set "FORGE_DIR=%~dp0"
set "FORGE_URL=http://localhost:6800"
set "OLLAMA_URL=http://localhost:11434"

rem --- Already running? Just open the UI. ---
curl -s -o nul --max-time 2 "%FORGE_URL%"
if %errorlevel%==0 (
  echo Forge is already running. Opening the UI...
  start "" "%FORGE_URL%"
  exit /b 0
)

rem --- Make sure Ollama is reachable. ---
curl -s -o nul --max-time 2 "%OLLAMA_URL%/api/version"
if %errorlevel%==0 goto ollama_ready

rem The tray app must be used (not bare `ollama serve`): the app knows the
rem configured model location; a bare serve falls back to an empty default dir.
echo Starting Ollama...
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
  start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
) else (
  start "Ollama" /min cmd /c "ollama serve"
)

set /a tries=0
:wait_ollama
set /a tries+=1
if %tries% gtr 30 (
  echo Ollama did not come up within 30 seconds. Is it installed?
  pause
  exit /b 1
)
rem ping -n 2 sleeps ~1s and works even without an interactive console
ping -n 2 127.0.0.1 >nul
curl -s -o nul --max-time 2 "%OLLAMA_URL%/api/version"
if not %errorlevel%==0 goto wait_ollama

:ollama_ready
echo Ollama is up.

rem --- Start the Forge server in its own minimized window. ---
rem cmd /k keeps the window open if the server crashes, so errors stay visible.
echo Starting Forge...
start "Forge Server" /min cmd /k "cd /d %FORGE_DIR% && npm start"

set /a tries=0
:wait_forge
set /a tries+=1
if %tries% gtr 60 (
  echo Forge did not come up within 60 seconds. Check the "Forge Server" window for errors.
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
curl -s -o nul --max-time 2 "%FORGE_URL%"
if not %errorlevel%==0 goto wait_forge

echo Forge is up. Opening the UI...
start "" "%FORGE_URL%"
exit /b 0
