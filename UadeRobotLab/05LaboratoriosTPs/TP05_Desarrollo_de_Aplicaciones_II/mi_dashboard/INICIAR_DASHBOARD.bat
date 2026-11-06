@echo off
REM ============================================================
REM   Iniciador del Dashboard Web de Telemetria — TP05
REM   Abre dashboard.html en el navegador predeterminado
REM ============================================================
cd /d "%~dp0"

echo ============================================================
echo   Unitree Telemetry Dashboard - TP05 (Desarrollo de Apps II)
echo ============================================================
echo.
echo   Abriendo el dashboard en tu navegador...
echo.

start "" "%~dp0dashboard.html"

echo   Listo! Recorda que para ver datos en vivo tenes que tener
echo   corriendo el backend (ejecutando INICIAR_TP05.bat en la carpeta del TP).
echo.
pause
