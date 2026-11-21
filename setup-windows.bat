@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

title NeoCraft Control — Автоматическая сборка и установка (Windows)
echo ====================================================================
echo   NeoCraft Control — Подготовка и сборка установщика Setup.exe
echo ====================================================================
echo.

:: 1. Проверка и автоустановка Node.js LTS через winget
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [1/4] Node.js не найден. Устанавливаем Node.js LTS автоматически через winget...
  where winget >nul 2>nul
  if %errorlevel% neq 0 (
    echo ОШИБКА: winget недоступен. Установите Node.js 22 LTS вручную с https://nodejs.org/
    pause
    exit /b 1
  )
  winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
  where node >nul 2>nul
  if %errorlevel% neq 0 (
    echo Node.js установлен! Перезапустите этот файл ^(setup-windows.bat^), чтобы применился PATH.
    pause
    exit /b 0
  )
) else (
  for /f "tokens=*" %%v in ('node -v') do echo [1/4] Node.js обнаружен: %%v
)

:: 2. Проверка и опциональная автоустановка Java 21 (для Minecraft 1.21.1 / NeoForge)
java -version 2>&1 | findstr /R /C:"version \"21\." /C:"version \"22\." /C:"version \"23\." >nul
if %errorlevel% neq 0 (
  echo [2/4] Java 21 не обнаружена. Пробуем установить Eclipse Temurin JDK 21 через winget...
  where winget >nul 2>nul
  if %errorlevel% equ 0 (
    winget install --id EclipseAdoptium.Temurin.21.JDK --exact --silent --accept-package-agreements --accept-source-agreements
  ) else (
    echo Предупреждение: установите Java 21 с https://adoptium.net/ для запуска сервера Minecraft 1.21.1.
  )
) else (
  echo [2/4] Java 21+ уже установлена.
)

:: 3. Установка зависимостей проекта
echo.
echo [3/4] Установка зависимостей npm...
call npm install
if %errorlevel% neq 0 (
  echo ОШИБКА при установке зависимостей npm.
  pause
  exit /b 1
)

:: 4. Сборка полноценного установщика NeoCraft-Control-Setup-1.0.0.exe
echo.
echo [4/4] Сборка установщика NeoCraft-Control-Setup-1.0.0.exe...
call npm run electron:build:win
if %errorlevel% neq 0 (
  echo ОШИБКА при сборке установщика Windows.
  pause
  exit /b 1
)

echo.
echo ====================================================================
echo   ГОТОВО! Установщик создан в папке release\
echo   Его можно передавать друзьям — Node.js им устанавливать НЕ нужно!
echo ====================================================================
echo.

if exist "release\NeoCraft-Control-Setup-1.0.0.exe" (
  explorer /select,"release\NeoCraft-Control-Setup-1.0.0.exe"
) else (
  explorer "release"
)
pause
