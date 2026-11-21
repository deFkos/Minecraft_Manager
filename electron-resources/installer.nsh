; NeoCraft Control — Custom NSIS Installer Hook
; 1. Automatically detects Java 21+ (PATH, Adoptium, Program Files, TLauncher JVM)
;    and installs Eclipse Temurin JDK 21 via winget if missing.
; 2. Pre-downloads official NeoForge 1.21.1 (21.1.267) installer JAR into
;    %USERPROFILE%\.neocraft-control\cache\ right during Setup.exe!

!macro customInstall
  InitPluginsDir

  ; --- Step 1: Check Java 21+ via clean temporary PowerShell script ---
  DetailPrint "Проверка наличия Java 21 для Minecraft 1.21.1 (NeoForge)..."
  FileOpen $R0 "$PLUGINSDIR\check-java21.ps1" w
  FileWrite $R0 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R0 "$$bins = @()$\r$\n"
  FileWrite $R0 "$$cmd = Get-Command java$\r$\n"
  FileWrite $R0 "if ($$cmd) { $$bins += $$cmd.Source }$\r$\n"
  FileWrite $R0 "$$roots = @($\r$\n"
  FileWrite $R0 "  (Join-Path $$env:ProgramFiles 'Eclipse Adoptium'),$\r$\n"
  FileWrite $R0 "  (Join-Path $$env:ProgramFiles 'Java'),$\r$\n"
  FileWrite $R0 "  (Join-Path $$env:ProgramFiles 'Microsoft'),$\r$\n"
  FileWrite $R0 "  (Join-Path $$env:ProgramFiles 'Zulu'),$\r$\n"
  FileWrite $R0 "  (Join-Path $$env:APPDATA '.tlauncher\jvms')$\r$\n"
  FileWrite $R0 ")$\r$\n"
  FileWrite $R0 "foreach ($$r in $$roots) {$\r$\n"
  FileWrite $R0 "  if (Test-Path $$r) {$\r$\n"
  FileWrite $R0 "    $$bins += (Get-ChildItem -Path $$r -Filter java.exe -Recurse | Select-Object -ExpandProperty FullName)$\r$\n"
  FileWrite $R0 "  }$\r$\n"
  FileWrite $R0 "}$\r$\n"
  FileWrite $R0 "foreach ($$b in ($$bins | Select-Object -Unique)) {$\r$\n"
  FileWrite $R0 "  try {$\r$\n"
  FileWrite $R0 "    $$psi = New-Object System.Diagnostics.ProcessStartInfo$\r$\n"
  FileWrite $R0 "    $$psi.FileName = $$b$\r$\n"
  FileWrite $R0 "    $$psi.Arguments = '-version'$\r$\n"
  FileWrite $R0 "    $$psi.RedirectStandardError = $$true$\r$\n"
  FileWrite $R0 "    $$psi.RedirectStandardOutput = $$true$\r$\n"
  FileWrite $R0 "    $$psi.UseShellExecute = $$false$\r$\n"
  FileWrite $R0 "    $$psi.CreateNoWindow = $$true$\r$\n"
  FileWrite $R0 "    $$proc = [System.Diagnostics.Process]::Start($$psi)$\r$\n"
  FileWrite $R0 "    $$out = $$proc.StandardError.ReadToEnd() + ' ' + $$proc.StandardOutput.ReadToEnd()$\r$\n"
  FileWrite $R0 "    $$proc.WaitForExit(4000) | Out-Null$\r$\n"
  FileWrite $R0 "    if ($$out -match 'version $\"2[1-9]\.') { exit 0 }$\r$\n"
  FileWrite $R0 "  } catch {}$\r$\n"
  FileWrite $R0 "}$\r$\n"
  FileWrite $R0 "exit 1$\r$\n"
  FileClose $R0

  nsExec::ExecToStack 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\check-java21.ps1"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "Java 21 не найдена. Автоматическая установка Eclipse Temurin JDK 21 через winget..."
    nsExec::ExecToLog 'winget install --id EclipseAdoptium.Temurin.21.JDK --exact --silent --accept-package-agreements --accept-source-agreements'
    Pop $2
    ${If} $2 == 0
      DetailPrint "Java 21 (Eclipse Temurin JDK 21) успешно установлена!"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "Не удалось автоматически установить Java 21 через winget. Установите JDK 21 вручную с https://adoptium.net/ — NeoCraft Control найдёт её автоматически."
    ${EndIf}
  ${Else}
    DetailPrint "Java 21+ уже установлена в системе."
  ${EndIf}

  ; --- Step 2: Pre-download official NeoForge 1.21.1 (21.1.267) installer JAR ---
  DetailPrint "Предзагрузка установщика ядра NeoForge 1.21.1 (21.1.267)..."
  FileOpen $R1 "$PLUGINSDIR\prefetch-neoforge.ps1" w
  FileWrite $R1 "$$ProgressPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $R1 "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12$\r$\n"
  FileWrite $R1 "$$cacheDir = Join-Path $$env:USERPROFILE '.neocraft-control\cache'$\r$\n"
  FileWrite $R1 "New-Item -ItemType Directory -Force -Path $$cacheDir | Out-Null$\r$\n"
  FileWrite $R1 "$$target = Join-Path $$cacheDir 'neoforge-21.1.267-installer.jar'$\r$\n"
  FileWrite $R1 "if ((Test-Path $$target) -and ((Get-Item $$target).Length -gt 100000)) {$\r$\n"
  FileWrite $R1 "  Write-Host 'NeoForge 21.1.267 already cached'$\r$\n"
  FileWrite $R1 "  exit 0$\r$\n"
  FileWrite $R1 "}$\r$\n"
  FileWrite $R1 "$$baseUrl = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'$\r$\n"
  FileWrite $R1 "try {$\r$\n"
  FileWrite $R1 "  Invoke-WebRequest -Uri $\"$$baseUrl/21.1.267/neoforge-21.1.267-installer.jar$\" -OutFile $$target -UseBasicParsing$\r$\n"
  FileWrite $R1 "  Write-Host 'NeoForge 21.1.267 downloaded to cache'$\r$\n"
  FileWrite $R1 "  exit 0$\r$\n"
  FileWrite $R1 "} catch {$\r$\n"
  FileWrite $R1 "  try {$\r$\n"
  FileWrite $R1 "    $$xml = (Invoke-WebRequest -Uri $\"$$baseUrl/maven-metadata.xml$\" -UseBasicParsing).Content$\r$\n"
  FileWrite $R1 "    $$vers = [regex]::Matches($$xml, '<version>(21\.1\.\d+)</version>') | ForEach-Object { $$_.Groups[1].Value }$\r$\n"
  FileWrite $R1 "    $$latest = $$vers | Sort-Object { [int]($$_.Split('.')[2]) } -Descending | Select-Object -First 1$\r$\n"
  FileWrite $R1 "    if ($$latest) {$\r$\n"
  FileWrite $R1 "      $$fallback = Join-Path $$cacheDir $\"neoforge-$$latest-installer.jar$\"$\r$\n"
  FileWrite $R1 "      Invoke-WebRequest -Uri $\"$$baseUrl/$$latest/neoforge-$$latest-installer.jar$\" -OutFile $$fallback -UseBasicParsing$\r$\n"
  FileWrite $R1 "      Write-Host $\"NeoForge $$latest downloaded to cache$\"$\r$\n"
  FileWrite $R1 "    }$\r$\n"
  FileWrite $R1 "  } catch {$\r$\n"
  FileWrite $R1 "    Write-Host 'Offline prefetch skipped; app will download on demand'$\r$\n"
  FileWrite $R1 "  }$\r$\n"
  FileWrite $R1 "  exit 0$\r$\n"
  FileWrite $R1 "}$\r$\n"
  FileClose $R1

  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\prefetch-neoforge.ps1"'
  Pop $3
  DetailPrint "Предзагрузка компонентов NeoCraft Control завершена."
!macroend
