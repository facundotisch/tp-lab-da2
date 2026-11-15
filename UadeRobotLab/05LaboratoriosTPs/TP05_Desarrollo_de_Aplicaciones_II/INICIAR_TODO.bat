@echo off
REM ============================================================
REM   INICIAR TODO — Servidor FastAPI + Dashboard Web TP05
REM   Desarrollo de Aplicaciones II · UADE
REM ============================================================
cd /d "%~dp0"

echo ============================================================
echo   Iniciando TP05 — Servidor y Dashboard Web
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

echo 1) Liberando puerto 8001 si estaba ocupado...
powershell -Command "Get-NetTCPConnection -LocalPort 8001 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo 2) Iniciando Servidor FastAPI en segundo plano...
start "Servidor Telemetria TP05" %PYTHON% robot_telemetry_server.py --puerto 8001

echo 3) Esperando que inicie el servidor...
timeout /t 2 >nul

echo 4) Abriendo Dashboard Web en tu navegador...
start "" "http://127.0.0.1:8001"

echo.
echo ============================================================
echo   TODO LISTO Y FUNCIONANDO!
echo   Dashboard: http://127.0.0.1:8001
echo   Swagger Docs: http://127.0.0.1:8001/docs
echo ============================================================
echo.
pause