; NeoCraft Control — Custom NSIS Installer Hook
; Automatically checks for Java 21 (required for Minecraft 1.21.1 + NeoForge 21.1.267)
; and installs Eclipse Temurin 21 JRE via winget if not detected.

!macro customInstall
  DetailPrint "Проверка наличия Java 21 для Minecraft 1.21.1 (NeoForge)..."
  nsExec::ExecToStack 'cmd /c "java -version 2>&1 | findstr /R /C:\"version \\\"21\\.\" /C:\"version \\\"22\\.\" /C:\"version \\\"23\\.\""'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "На этом ПК не обнаружена Java 21 (необходима для запуска сервера Minecraft 1.21.1 / NeoForge 21.1.267).$\r$\n$\r$\nСкачать и установить Eclipse Temurin JDK 21 автоматически через winget?" \
      IDNO skip_java_install
    DetailPrint "Загрузка и установка Eclipse Temurin 21 JDK через winget..."
    nsExec::ExecToLog 'winget install --id EclipseAdoptium.Temurin.21.JDK --exact --silent --accept-package-agreements --accept-source-agreements'
    Pop $2
    ${If} $2 == 0
      DetailPrint "Java 21 успешно установлена!"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "Не удалось автоматически установить Java 21 через winget. Вы сможете указать путь к Java позже в настройках NeoCraft Control или установить JDK 21 с сайта adoptium.net."
    ${EndIf}
    skip_java_install:
  ${Else}
    DetailPrint "Java 21+ уже установлена в системе."
  ${EndIf}
!macroend
