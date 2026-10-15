@echo off
title Respaldo - Sistema de Retenciones
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Primero abri el sistema con "Iniciar.bat" para que se instale lo necesario.
  pause
  exit /b
)
node --no-warnings scripts\respaldo.js
echo.
echo Guarda una copia de la carpeta "respaldos" en un pendrive o en la nube.
echo.
pause
