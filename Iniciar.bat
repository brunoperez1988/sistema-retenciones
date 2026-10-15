@echo off
title Sistema de Retenciones
cd /d "%~dp0"

rem Si se abrio desde adentro del .zip, Windows lo corre en una carpeta temporal y los datos se perderian.
set "CARPETA=%~dp0"
if /i not "%CARPETA:\Temp\=%"=="%CARPETA%" (
  echo.
  echo  ATENCION: parece que abriste este archivo desde adentro del .zip.
  echo  Primero hace clic derecho en el .zip, elegi "Extraer todo..." y
  echo  despues abri "Iniciar.bat" desde la carpeta extraida.
  echo.
  pause
  exit /b
)

rem Revisa que Node.js este instalado (version 22.5 o mas nueva).
where node >nul 2>nul
if errorlevel 1 goto instalar
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
if errorlevel 1 goto instalar
goto iniciar

:instalar
echo.
echo  Para funcionar, el sistema necesita un programa gratuito llamado Node.js.
echo  Lo voy a instalar ahora. Si Windows pregunta si permitis cambios, decile que Si.
echo.
where winget >nul 2>nul
if errorlevel 1 goto manual
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto manual
echo.
echo  Listo, Node.js quedo instalado.
echo  Cerra esta ventana y volve a hacer doble clic en "Iniciar.bat".
echo.
pause
exit /b

:manual
echo.
echo  No pude instalarlo solo. Se va a abrir la pagina de descarga:
echo  descarga el instalador "LTS" para Windows, instalalo con Siguiente, Siguiente...
echo  y despues volve a hacer doble clic en "Iniciar.bat".
echo.
start "" "https://nodejs.org/es/download"
pause
exit /b

:iniciar
echo.
echo  Abriendo el Sistema de Retenciones en el navegador...
echo  NO cierres esta ventana mientras uses el sistema.
echo.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"
node --no-warnings server.js
pause
