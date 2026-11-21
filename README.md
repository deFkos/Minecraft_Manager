# NeoCraft Control

Кроссплатформенное десктопное приложение (Windows и Linux) на базе **Electron + TypeScript + React** для управления сервером Minecraft и автоматической настройки клиента **TLauncher + NeoForge 1.21.1 (21.1.267)**.

## Как получить готовый `NeoCraft-Control-Setup-1.0.0.exe`

Установщик **NSIS (`Setup.exe`)** полностью автономный: он содержит встроенный Electron и Node.js (пользователю не нужно ставить Node.js), создаёт ярлыки на рабочем столе и в меню «Пуск», а во время установки автоматически проверяет наличие **Java 21** и предлагает докачать **Eclipse Temurin JDK 21** через `winget`.

### Вариант 1 — Сборка в один клик на Windows
1. Скачайте архив репозитория и распакуйте его.
2. Дважды кликните по файлу **`setup-windows.bat`**.
3. Скрипт сам проверит и при необходимости установит Node.js LTS и Java 21 через `winget`, скачает зависимости и соберёт **`release\NeoCraft-Control-Setup-1.0.0.exe`**.
4. Полученный `Setup.exe` можно запускать на любом ПК с Windows 10/11 и отправлять друзьям.

### Вариант 2 — Автоматическая облачная сборка через GitHub Actions (без локальной сборки)
1. Загрузите проект в свой репозиторий на GitHub.
2. Откройте вкладку **Actions → Build Desktop Installers (Setup.exe & AppImage) → Run workflow** (или создайте тег `v1.0.0` для автоматической публикации в **Releases**).
3. GitHub автоматически соберёт готовые **`NeoCraft-Control-Setup-1.0.0.exe`** (Windows) и **`NeoCraft-Control-1.0.0.AppImage` / `.deb`** (Linux).

### Вариант 3 — Сборка на Linux
```bash
chmod +x setup-linux.sh
./setup-linux.sh
```
Готовые пакеты появятся в папке `release/`.

---

## Быстрый запуск в режиме локальной Web-панели (разработка)

```bash
npm install
npm run dev
```

Приложение откроется на `http://localhost:3000`.
