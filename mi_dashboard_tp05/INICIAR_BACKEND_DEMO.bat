@echo off
REM ============================================================
REM   Servidor de Telemetria Autónomo en Modo Demo (FastAPI)
REM   UADE · Desarrollo de Aplicaciones II
REM ============================================================
cd /d "%~dp0"

echo ============================================================
echo   Servidor FastAPI Demo - TP05
echo ============================================================
echo.
echo   Levantando servidor de telemetria en http://127.0.0.1:8001...
echo.

set PYTHON=
py -3 -c "import fastapi" >nul 2>&1 && set PYTHON=py -3
if not defined PYTHON python -c "import fastapi" >nul 2>&1 && set PYTHON=python
if not defined PYTHON where py >nul 2>&1 && set PYTHON=py -3
if not defined PYTHON where python >nul 2>&1 && set PYTHON=python

if not defined PYTHON (
  echo   ERROR: No se encontro Python en el PATH.
  pause & exit /b 1
)

%PYTHON% servidor_demo.py
pause
