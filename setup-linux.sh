#!/usr/bin/env bash
set -euo pipefail

echo "===================================================================="
echo "  NeoCraft Control — Сборка установщика для Linux (AppImage / deb)"
echo "===================================================================="

if ! command -v node >/dev/null 2>&1; then
  echo "Ошибка: Node.js 20+ не найден."
  echo "Установите Node.js (например: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs)"
  exit 1
fi

echo "[1/3] Node.js обнаружен: $(node -v)"

if ! command -v java >/dev/null 2>&1; then
  echo "Предупреждение: Java 21 не найдена. Для запуска Minecraft 1.21.1 установите openjdk-21-jre (например: sudo apt install openjdk-21-jre)."
else
  echo "[1/3] Java обнаружена: $(java -version 2>&1 | head -n 1)"
fi

echo "[2/3] Установка зависимостей npm..."
npm install

echo "[3/3] Сборка AppImage и .deb..."
npm run electron:build:linux

echo ""
echo "✓ Готово! Пакеты находятся в папке ./release/"
ls -lh release/*.AppImage release/*.deb 2>/dev/null || true
