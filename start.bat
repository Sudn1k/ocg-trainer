@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запуск локального сервера ОЦГ Тренажёра...
start "" http://127.0.0.1:4173
node server.mjs
