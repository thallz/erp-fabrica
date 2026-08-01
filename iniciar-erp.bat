@echo off
title ERP Fabrica — Servidor
echo ========================================
echo   ERP Fabrica - Iniciando sistema...
echo ========================================
echo.

echo [1/2] Iniciando banco de dados (PostgreSQL)...
docker start erp-fabrica-banco-dados-erp-1
timeout /t 3 /nobreak > nul

echo.
echo [2/2] Iniciando servidor Node.js na porta 3001...
echo.
echo ========================================
echo   Sistema rodando!
echo   Acesse: http://localhost:3001/almoxarifado.html
echo ========================================
echo.

cd /d "%~dp0backend"
node src/server.js

pause
