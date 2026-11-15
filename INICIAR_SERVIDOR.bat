@echo off
REM ============================================================
REM   Servidor FastAPI de Telemetria — TP05
REM   UADE · Desarrollo de Aplicaciones II
REM ============================================================
cd /d "%~dp0"

echo ============================================================
echo   Servidor FastAPI de Telemetria — TP05
echo ============================================================
echo.

set PYTHON=
py -3 -c "import fastapi" >nul 2>&1 && set PYTHON=py -3
if not defined PYTHON python -c "import fastapi" >nul 2>&1 && set PYTHON=python
if not defined PYTHON where py >nul 2>&1 && set PYTHON=py -3
if not defined PYTHON where python >nul 2>&1 && set PYTHON=python

if not defined PYTHON (
  echo   ERROR: No se encontro Python con FastAPI.
  echo   Instalar con: py -3 -m pip install fastapi uvicorn websockets
  pause
  exit /b 1
)

echo   Liberando puerto 8001 si estaba ocupado...
powershell -Command "Get-NetTCPConnection -LocalPort 8001 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo   Iniciando servidor de telemetria en http://127.0.0.1:8001...
echo.

%PYTHON% robot_telemetry_server.py --puerto 8001
pause
