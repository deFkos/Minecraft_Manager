$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Refresh-SessionPath {
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host "  NeoCraft Control - Сборка установщика Setup.exe (Windows)" -ForegroundColor Cyan
Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check / auto-install Node.js LTS
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "[1/4] Node.js не найден. Устанавливаем Node.js LTS через winget..." -ForegroundColor Yellow
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $wingetCmd) {
        Write-Host "ОШИБКА: winget не найден. Установите Node.js 22 LTS вручную с https://nodejs.org/" -ForegroundColor Red
        exit 1
    }
    winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements
    Refresh-SessionPath
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Host "Node.js установлен. Закройте это окно и запустите setup-windows.bat ещё раз." -ForegroundColor Yellow
        exit 0
    }
}
$nodeVer = & node -v
Write-Host "[1/4] Node.js обнаружен: $nodeVer" -ForegroundColor Green

# 2. Check / auto-install Java 21 (required for Minecraft 1.21.1 / NeoForge)
$hasJava21 = $false
$javaCmd = Get-Command java -ErrorAction SilentlyContinue
if ($javaCmd) {
    $javaOut = (& cmd /c "java -version 2>&1") -join "`n"
    if ($javaOut -match 'version "(21|22|23|24)\.') {
        $hasJava21 = $true
    }
}

if (-not $hasJava21) {
    Write-Host "[2/4] Java 21 не обнаружена. Пробуем установить Eclipse Temurin JDK 21 через winget..." -ForegroundColor Yellow
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetCmd) {
        try {
            winget install --id EclipseAdoptium.Temurin.21.JDK --exact --silent --accept-package-agreements --accept-source-agreements
            Refresh-SessionPath
            Write-Host "[2/4] Java 21 установлена." -ForegroundColor Green
        } catch {
            Write-Host "[2/4] Предупреждение: не удалось автоматически установить Java 21. Установите JDK 21 с https://adoptium.net/" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[2/4] Предупреждение: winget недоступен. Установите Java 21 с https://adoptium.net/" -ForegroundColor Yellow
    }
} else {
    Write-Host "[2/4] Java 21+ уже установлена." -ForegroundColor Green
}

# 3. Install npm dependencies
Write-Host ""
Write-Host "[3/4] Установка зависимостей npm..." -ForegroundColor Cyan
& npm.cmd install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ОШИБКА при выполнении npm install (код $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}

# 4. Build standalone Windows NSIS Setup.exe
Write-Host ""
Write-Host "[4/4] Сборка установщика NeoCraft-Control-Setup-1.0.0.exe..." -ForegroundColor Cyan
& npm.cmd run electron:build:win
if ($LASTEXITCODE -ne 0) {
    Write-Host "ОШИБКА при сборке установщика Windows (код $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "====================================================================" -ForegroundColor Green
Write-Host "  ГОТОВО! Установщик создан в папке release\" -ForegroundColor Green
Write-Host "  Его можно передавать друзьям — Node.js им ставить НЕ нужно!" -ForegroundColor Green
Write-Host "====================================================================" -ForegroundColor Green

$setupExe = Join-Path (Get-Location) "release\NeoCraft-Control-Setup-1.0.0.exe"
if (Test-Path $setupExe) {
    Start-Process explorer.exe -ArgumentList "/select,`"$setupExe`""
} else {
    $releaseDir = Join-Path (Get-Location) "release"
    if (Test-Path $releaseDir) {
        Start-Process explorer.exe -ArgumentList "`"$releaseDir`""
    }
}
