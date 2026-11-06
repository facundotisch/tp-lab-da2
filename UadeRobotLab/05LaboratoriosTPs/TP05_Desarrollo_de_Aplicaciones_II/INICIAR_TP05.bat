@echo off
REM ============================================================
REM   Desarrollo de Aplicaciones II
REM   Levanta el simulador y el backend para tu app.
REM ============================================================
cd /d "%~dp0"

echo ============================================================
echo    Desarrollo de Aplicaciones II
echo ============================================================
echo.
echo    Que robot queres usar?
echo.
echo      1)  G1   - robot humanoide (camina en dos patas)
echo      2)  Go2  - robot perro     (camina en cuatro patas)
echo      3)  DEMO - backend rapido sin ventana 3D (Go2)
echo.
set OPCION=1
set /p OPCION="   Elegi 1, 2 o 3 [1]: "
set ROBOT=g1
if "%OPCION%"=="2" set ROBOT=go2
if "%OPCION%"=="3" set ROBOT=demo
echo.

set PYTHON=
py -3 -c "import mujoco" >nul 2>&1 && set PYTHON=py -3
if not defined PYTHON python -c "import mujoco" >nul 2>&1 && set PYTHON=python
if not defined PYTHON where py >nul 2>&1 && set PYTHON=py -3
if not defined PYTHON where python >nul 2>&1 && set PYTHON=python
if not defined PYTHON (
  echo    ERROR: no encuentro Python. Instalalo desde https://python.org
  pause ^& exit /b 1
)

if "%ROBOT%"=="demo" (
  echo    Arrancando backend en Modo Demo...
  %PYTHON% entorno\arrancar_api.py --robot go2 --demo
) else (
  echo    Abriendo el simulador 3D...
  start "Simulador" cmd /c "cd entorno ^&^& %PYTHON% -m sim --robot %ROBOT% --materia tp05"
  echo    Esperando 5 segundos a que inicie el simulador...
  timeout /t 5 >nul
  %PYTHON% entorno\arrancar_api.py --robot %ROBOT%
)
echo.
pause
