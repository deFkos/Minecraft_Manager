import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AppFullState,
  ClientDetectionResult,
  ClientSetupResult,
  ClientSetupStep,
  CopyModsResult,
  FsBrowseEntry,
  FsBrowseResult,
  JavaDetectionResult,
  JavaInstallation,
  LogEntry,
  LogLevel,
  ModFileInfo,
  ModsState,
  NetworkSettings,
  PlayerLists,
  RuntimeEnvironment,
  ServerConfig,
  ServerCoreStatus,
  ServerRuntimeState,
  ServerStatus,
  SetupStepId,
  WorkspaceMode,
} from '../shared/types.ts';

const MAX_LOG_LINES = 1000;
const NEOFORGE_MC_VERSION = '1.21.1';
const NEOFORGE_LOADER_VERSION = '21.1.267';
const DEFAULT_BUILD_NAME = `NeoForge-${NEOFORGE_MC_VERSION}-${NEOFORGE_LOADER_VERSION}`;
const NEOFORGE_MAVEN_BASE = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

const SAMPLE_MODS: Array<{ name: string; sizeKb: number; modId: string }> = [
  { name: 'sodium-neoforge-0.6.5+mc1.21.1.jar', sizeKb: 1184, modId: 'sodium' },
  { name: 'iris-neoforge-1.8.1+mc1.21.1.jar', sizeKb: 2496, modId: 'iris' },
  { name: 'jei-1.21.1-neoforge-19.21.0.247.jar', sizeKb: 1412, modId: 'jei' },
  { name: 'create-1.21.1-6.0.2.jar', sizeKb: 14820, modId: 'create' },
  { name: 'waystones-neoforge-1.21.1-21.1.7.jar', sizeKb: 642, modId: 'waystones' },
  { name: 'appleskin-neoforge-mc1.21-3.0.6.jar', sizeKb: 96, modId: 'appleskin' },
];

const DEFAULT_SERVER_PROPERTIES = `#Minecraft server properties
#Managed by NeoCraft Control
motd=NeoForge 1.21.1 Server — Welcome!
server-ip=
server-port=25565
max-players=20
online-mode=false
white-list=true
difficulty=normal
gamemode=survival
level-name=world
view-distance=10
simulation-distance=8
enable-command-block=false
pvp=true
`;

function formatTimestamp(date = new Date()): string {
  return date.toTimeString().slice(0, 8);
}

function classifyLogLevel(line: string, source: 'stdout' | 'stderr'): LogLevel {
  if (source === 'stderr') return 'ERROR';
  if (/\[[^\]]*\/ERROR\]|ERROR:|Exception|FATAL/i.test(line)) return 'ERROR';
  if (/\[[^\]]*\/WARN\]|WARN:|WARNING/i.test(line)) return 'WARN';
  return 'INFO';
}

function createInitialSteps(): ClientSetupStep[] {
  return [
    {
      id: 'detect',
      title: 'Поиск клиента',
      description: 'Проверка директории .minecraft и конфигурации TLauncher',
      status: 'idle',
    },
    {
      id: 'neoforge',
      title: `Установка NeoForge ${NEOFORGE_LOADER_VERSION}`,
      description: `Подготовка профиля Minecraft ${NEOFORGE_MC_VERSION} + NeoForge ${NEOFORGE_LOADER_VERSION}`,
      status: 'idle',
    },
    {
      id: 'init-mods',
      title: 'Инициализация папки mods',
      description: 'Принудительное создание .minecraft/mods и .minecraft/versions/<Сборка>/mods',
      status: 'idle',
    },
    {
      id: 'copy-mods',
      title: 'Копирование модов',
      description: 'Перенос всех .jar файлов из локальной библиотеки в директории клиента',
      status: 'idle',
    },
    {
      id: 'done',
      title: 'Готово!',
      description: 'Сборка готова к первому запуску в TLauncher',
      status: 'idle',
    },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CoreBackendService extends EventEmitter {
  private readonly environment: RuntimeEnvironment;
  private readonly sandboxRoot: string;
  private readonly runnerScriptPath: string;
  private config: ServerConfig;
  private runtime: ServerRuntimeState;
  private logs: LogEntry[] = [];
  private childProc: ChildProcessWithoutNullStreams | null = null;
  private clientSteps: ClientSetupStep[] = createInitialSteps();
  private lastClientSetup: ClientSetupResult | null = null;
  private isClientSetupRunning = false;
  private javaDetection: JavaDetectionResult;
  private readonly appDataRoot: string;
  private readonly configFilePath: string;
  private readonly installerCacheDir: string;
  private serverInitialized = false;
  private setupPromptDismissed = false;
  private installingCore = false;
  private installStage: string | null = null;
  private installPercent = 0;
  private installError: string | null = null;

  constructor(environment: RuntimeEnvironment, projectRoot = process.cwd()) {
    super();
    this.environment = environment;
    const isPackagedAsar = projectRoot.includes('app.asar');
    const unpackedRoot = isPackagedAsar
      ? projectRoot.replace('app.asar', 'app.asar.unpacked')
      : projectRoot;
    this.appDataRoot =
      environment === 'electron'
        ? path.join(os.homedir(), '.neocraft-control')
        : path.resolve(projectRoot, '.neocraft-sandbox', '.neocraft-meta');
    this.configFilePath = path.join(this.appDataRoot, 'config.json');
    this.installerCacheDir = path.join(this.appDataRoot, 'cache');

    this.sandboxRoot =
      environment === 'electron' && isPackagedAsar
        ? path.join(this.appDataRoot, 'sandbox')
        : path.resolve(projectRoot, '.neocraft-sandbox');
    this.runnerScriptPath = path.resolve(unpackedRoot, 'backend', 'sandboxRunner.mjs');

    this.ensureSandboxWorkspace();

    const defaultMode: WorkspaceMode = environment === 'electron' ? 'native' : 'sandbox';
    this.config = this.buildDefaultConfig(defaultMode);
    this.loadPersistedConfig();

    this.javaDetection = this.detectJavaInstallations(true);
    this.syncAutoDetectedCorePath();

    this.runtime = {
      status: 'offline',
      pid: null,
      startedAt: null,
      eulaAccepted: this.checkEulaAccepted(this.config.serverDir),
      executionEngine: null,
      lastError: null,
      players: this.readPlayersFromDisk(this.config.serverDir),
    };
  }

  private loadPersistedConfig(): void {
    try {
      if (!fs.existsSync(this.configFilePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.configFilePath, 'utf8')) as {
        config?: Partial<ServerConfig>;
        serverInitialized?: boolean;
      };
      if (raw.config && this.environment === 'electron') {
        if (typeof raw.config.serverDir === 'string' && raw.config.serverDir.trim()) {
          this.config.serverDir = raw.config.serverDir.trim();
        }
        if (typeof raw.config.jarFile === 'string' && raw.config.jarFile.trim()) {
          this.config.jarFile = raw.config.jarFile.trim();
        }
        if (typeof raw.config.modsSourceDir === 'string' && raw.config.modsSourceDir.trim()) {
          this.config.modsSourceDir = raw.config.modsSourceDir.trim();
        }
        if (typeof raw.config.minecraftDir === 'string' && raw.config.minecraftDir.trim()) {
          this.config.minecraftDir = raw.config.minecraftDir.trim();
        }
        if (typeof raw.config.clientBuildName === 'string' && raw.config.clientBuildName.trim()) {
          this.config.clientBuildName = raw.config.clientBuildName.trim();
        }
        if (typeof raw.config.xmsMb === 'number' && Number.isInteger(raw.config.xmsMb)) {
          this.config.xmsMb = raw.config.xmsMb;
        }
        if (typeof raw.config.xmxMb === 'number' && Number.isInteger(raw.config.xmxMb)) {
          this.config.xmxMb = raw.config.xmxMb;
        }
      }
      if (typeof raw.serverInitialized === 'boolean') {
        this.serverInitialized = raw.serverInitialized;
      }
    } catch {
      // ignore corrupted config file
    }
  }

  private savePersistedConfig(): void {
    try {
      fs.mkdirSync(this.appDataRoot, { recursive: true });
      fs.writeFileSync(
        this.configFilePath,
        JSON.stringify(
          {
            config: this.config,
            serverInitialized: this.serverInitialized,
          },
          null,
          2
        ),
        'utf8'
      );
    } catch {
      // ignore persistence errors
    }
  }

  private findCachedInstaller(): string | null {
    const candidates = [
      path.join(this.installerCacheDir, `neoforge-${NEOFORGE_LOADER_VERSION}-installer.jar`),
    ];
    try {
      if (fs.existsSync(this.installerCacheDir)) {
        for (const entry of fs.readdirSync(this.installerCacheDir)) {
          if (/^neoforge-21\.1\.\d+-installer\.jar$/i.test(entry)) {
            candidates.push(path.join(this.installerCacheDir, entry));
          }
        }
      }
    } catch {
      // ignore
    }
    for (const c of candidates) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).size > 100_000) {
          return c;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  private syncAutoDetectedCorePath(): void {
    try {
      const safeDir = this.resolveSafePath(this.config.serverDir);
      const nfArgs = this.findNeoForgeArgsFile(safeDir);
      if (nfArgs) {
        this.config.jarFile = path.join(safeDir, nfArgs);
        return;
      }
      if (!fs.existsSync(this.config.jarFile)) {
        const discovered = this.autoFindServerJar(safeDir);
        if (discovered) {
          this.config.jarFile = discovered;
        }
      }
    } catch {
      // ignore
    }
  }

  public inspectServerCore(): ServerCoreStatus {
    const cachedInstallerPath = this.findCachedInstaller();
    let coreDetected = false;
    let coreType: ServerCoreStatus['coreType'] = 'missing';
    let coreLabel = 'Ядро не установлено (скачается автоматически)';
    let corePath: string | null = null;

    try {
      const safeDir = this.resolveSafePath(this.config.serverDir);
      const nfArgs = this.findNeoForgeArgsFile(safeDir);
      if (nfArgs) {
        coreDetected = true;
        coreType = 'neoforge-args';
        corePath = path.join(safeDir, nfArgs);
        const verMatch = nfArgs.match(/neoforge[\\/]([^\\/]+)[\\/]/i);
        coreLabel = `NeoForge ${verMatch ? verMatch[1] : NEOFORGE_LOADER_VERSION} (автовыбор)`;
      } else if (this.config.jarFile && fs.existsSync(this.config.jarFile)) {
        coreDetected = true;
        const isStub = this.isSandboxStubJar(this.config.jarFile);
        coreType = isStub ? 'sandbox' : 'jar';
        corePath = this.config.jarFile;
        coreLabel = isStub
          ? `${path.basename(this.config.jarFile)} (песочница)`
          : `${path.basename(this.config.jarFile)} (автовыбор)`;
      } else {
        const autoJar = this.autoFindServerJar(safeDir);
        if (autoJar) {
          coreDetected = true;
          const isStub = this.isSandboxStubJar(autoJar);
          coreType = isStub ? 'sandbox' : 'jar';
          corePath = autoJar;
          this.config.jarFile = autoJar;
          coreLabel = `${path.basename(autoJar)} (найдено автоматически)`;
        }
      }
    } catch {
      // ignore
    }

    const initialized = this.serverInitialized || coreDetected;
    const needsInitialSetup =
      !this.setupPromptDismissed &&
      !coreDetected &&
      this.config.mode === 'native';

    return {
      initialized,
      needsInitialSetup,
      coreDetected,
      coreType,
      coreLabel,
      corePath,
      cachedInstallerPath,
      installing: this.installingCore,
      installStage: this.installStage,
      installPercent: this.installPercent,
      installError: this.installError,
    };
  }

  private emitInstallProgress(stage: string | null, percent: number, error: string | null = null): void {
    this.installStage = stage;
    this.installPercent = percent;
    this.installError = error;
    this.emit('server-install-progress', this.inspectServerCore());
  }

  public dismissInitialSetup(): { ok: boolean } {
    this.setupPromptDismissed = true;
    return { ok: true };
  }

  private async downloadNeoForgeInstaller(): Promise<string> {
    const existing = this.findCachedInstaller();
    if (existing) {
      this.appendLog('SYSTEM', 'system', `Используется предзагруженный установщик NeoForge: ${existing}`);
      this.emitInstallProgress('Найден предзагруженный установщик NeoForge 21.1.267', 35);
      return existing;
    }

    fs.mkdirSync(this.installerCacheDir, { recursive: true });

    const tryDownloadVersion = async (version: string): Promise<string | null> => {
      if (!/^21\.1\.\d+$/.test(version)) return null;
      const url = `${NEOFORGE_MAVEN_BASE}/${version}/neoforge-${version}-installer.jar`;
      const targetPath = path.join(this.installerCacheDir, `neoforge-${version}-installer.jar`);
      const tempPath = `${targetPath}.part`;

      this.appendLog('SYSTEM', 'system', `Загрузка официального установщика NeoForge ${version} с maven.neoforged.net...`);
      this.emitInstallProgress(`Загрузка neoforge-${version}-installer.jar...`, 12);

      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok || !response.body) {
        return null;
      }

      const totalBytes = Number(response.headers.get('content-length') || 0);
      const fileStream = fs.createWriteStream(tempPath);
      const reader = response.body.getReader();
      let received = 0;
      let lastPct = 12;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            fileStream.write(Buffer.from(value));
            received += value.byteLength;
            if (totalBytes > 0) {
              const pct = Math.min(44, 12 + Math.round((received / totalBytes) * 32));
              if (pct > lastPct + 2) {
                lastPct = pct;
                this.emitInstallProgress(
                  `Загрузка neoforge-${version}-installer.jar (${(received / 1024 / 1024).toFixed(1)} МБ)...`,
                  pct
                );
              }
            }
          }
        }
      } finally {
        await new Promise<void>((resolve) => fileStream.end(() => resolve()));
      }

      if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 100_000) {
        fs.renameSync(tempPath, targetPath);
        return targetPath;
      }
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      return null;
    };

    // 1. Try target NeoForge 21.1.267 first
    let downloaded = await tryDownloadVersion(NEOFORGE_LOADER_VERSION);

    // 2. Fallback to latest published 21.1.x from official maven-metadata.xml if 21.1.267 is unavailable
    if (!downloaded) {
      this.emitInstallProgress('Поиск актуальной сборки NeoForge 21.1.x в официальном Maven...', 10);
      const metaRes = await fetch(`${NEOFORGE_MAVEN_BASE}/maven-metadata.xml`);
      if (metaRes.ok) {
        const xml = await metaRes.text();
        const matches = Array.from(xml.matchAll(/<version>(21\.1\.\d+)<\/version>/g)).map((m) => m[1]);
        const latest211 = matches.sort((a, b) => {
          const pa = Number(a.split('.')[2] || 0);
          const pb = Number(b.split('.')[2] || 0);
          return pb - pa;
        })[0];
        if (latest211 && latest211 !== NEOFORGE_LOADER_VERSION) {
          downloaded = await tryDownloadVersion(latest211);
        }
      }
    }

    if (!downloaded) {
      throw new Error(
        'Не удалось скачать установщик NeoForge 1.21.1 с maven.neoforged.net. Проверьте подключение к интернету.'
      );
    }

    this.emitInstallProgress('Установщик NeoForge успешно загружен', 45);
    return downloaded;
  }

  public async initializeServer(
    overrideServerDir?: string
  ): Promise<{ ok: boolean; state?: AppFullState; error?: string }> {
    if (this.installingCore) {
      return { ok: false, error: 'Инициализация ядра сервера уже выполняется.' };
    }

    this.installingCore = true;
    this.installError = null;
    this.setupPromptDismissed = true;

    try {
      const targetDir = this.resolveSafePath(overrideServerDir || this.config.serverDir);
      this.config.serverDir = targetDir;
      this.emitInstallProgress(`Создание структуры директории ${targetDir}...`, 5);

      fs.mkdirSync(targetDir, { recursive: true });
      fs.mkdirSync(path.join(targetDir, 'mods'), { recursive: true });
      this.ensureEulaAccepted(targetDir);

      const propsPath = path.join(targetDir, 'server.properties');
      if (!fs.existsSync(propsPath)) {
        fs.writeFileSync(propsPath, DEFAULT_SERVER_PROPERTIES, 'utf8');
      }

      // Check if server core already exists in targetDir
      const existingArgs = this.findNeoForgeArgsFile(targetDir);
      const existingJar = this.autoFindServerJar(targetDir);
      if (existingArgs) {
        this.config.jarFile = path.join(targetDir, existingArgs);
        this.serverInitialized = true;
        this.savePersistedConfig();
        this.emitInstallProgress('Обнаружено готовое ядро NeoForge 1.21.1', 100);
        this.appendLog('SYSTEM', 'system', `Сервер инициализирован. Найдено ядро: ${this.config.jarFile}`);
        return { ok: true, state: this.getFullState() };
      }
      if (existingJar && !this.isSandboxStubJar(existingJar)) {
        this.config.jarFile = existingJar;
        this.serverInitialized = true;
        this.savePersistedConfig();
        this.emitInstallProgress(`Найдено готовое JAR-ядро: ${path.basename(existingJar)}`, 100);
        this.appendLog('SYSTEM', 'system', `Сервер инициализирован. Найдено ядро: ${existingJar}`);
        return { ok: true, state: this.getFullState() };
      }

      // Sandbox / Web preview mode initialization
      if (this.environment === 'web-preview' || this.config.mode === 'sandbox') {
        this.emitInstallProgress('Подготовка тестового ядра NeoForge 21.1.267 (песочница)...', 40);
        await sleep(300);
        const stubJar = path.join(targetDir, `neoforge-${NEOFORGE_LOADER_VERSION}-server.jar`);
        fs.writeFileSync(
          stubJar,
          `NEOCRAFT-SANDBOX-JAR\nversion=neoforge-${NEOFORGE_MC_VERSION}-${NEOFORGE_LOADER_VERSION}\n`,
          'utf8'
        );
        this.config.jarFile = stubJar;
        this.serverInitialized = true;
        this.emitInstallProgress('Ядро NeoForge 1.21.1 (песочница) готово к запуску', 100);
        this.appendLog('SYSTEM', 'system', `Директория сервера инициализирована: ${targetDir}`);
        return { ok: true, state: this.getFullState() };
      }

      // Native Electron mode: verify Java 21 + download installer + run --installServer
      this.detectJavaInstallations(true);
      if (!this.javaDetection.selectedPath) {
        throw new Error(
          'Java 21 не найдена в системе. Установите Eclipse Temurin JDK 21 (adoptium.net) и повторите инициализацию.'
        );
      }

      const installerPath = await this.downloadNeoForgeInstaller();

      this.emitInstallProgress(
        'Установка серверных библиотек NeoForge 1.21.1 (--installServer)... Это займёт 1–2 минуты.',
        50
      );
      this.appendLog(
        'SYSTEM',
        'system',
        `Запуск установки ядра: "${this.config.javaPath}" -jar "${installerPath}" --installServer`
      );

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          this.config.javaPath,
          ['-jar', installerPath, '--installServer'],
          {
            cwd: targetDir,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );

        let progressPct = 52;
        const onChunk = (chunk: Buffer, isErr: boolean) => {
          const text = chunk.toString('utf8');
          for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            this.appendLog(isErr ? 'WARN' : 'INFO', isErr ? 'stderr' : 'stdout', `[Installer] ${line}`);
            if (progressPct < 94) {
              progressPct = Math.min(94, progressPct + 1);
              this.emitInstallProgress(`Установка NeoForge: ${line.slice(0, 72)}`, progressPct);
            }
          }
        };

        proc.stdout.on('data', (c: Buffer) => onChunk(c, false));
        proc.stderr.on('data', (c: Buffer) => onChunk(c, true));
        proc.on('error', (err) => reject(err));
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Установщик NeoForge завершился с кодом ${code}.`));
        });
      });

      this.syncAutoDetectedCorePath();
      const verifiedArgs = this.findNeoForgeArgsFile(targetDir);
      const verifiedJar = this.autoFindServerJar(targetDir);
      if (verifiedArgs) {
        this.config.jarFile = path.join(targetDir, verifiedArgs);
      } else if (verifiedJar) {
        this.config.jarFile = verifiedJar;
      }

      this.serverInitialized = true;
      this.savePersistedConfig();
      this.emitInstallProgress('Ядро NeoForge 1.21.1 установлено и выбрано автоматически!', 100);
      this.appendLog(
        'SYSTEM',
        'system',
        `Инициализация сервера завершена! Ядро подставлено автоматически: ${this.config.jarFile}`
      );
      return { ok: true, state: this.getFullState() };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Ошибка инициализации ядра сервера.';
      this.appendLog('ERROR', 'system', msg);
      this.emitInstallProgress(null, 0, msg);
      return { ok: false, error: msg };
    } finally {
      this.installingCore = false;
      this.emit('server-install-progress', this.inspectServerCore());
    }
  }

  private probeJavaBinary(javaBin: string, source: string): JavaInstallation | null {
    try {
      const result = spawnSync(javaBin, ['-version'], {
        shell: false,
        timeout: 3000,
        encoding: 'utf8',
      });
      if (result.error) return null;
      const output = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
      if (!output) return null;

      const verMatch = output.match(/version\s+"([^"]+)"/i);
      const rawVersion = verMatch ? verMatch[1] : 'unknown';
      let majorVersion = 0;
      if (rawVersion.startsWith('1.')) {
        majorVersion = Number.parseInt(rawVersion.split('.')[1] || '0', 10) || 0;
      } else {
        majorVersion = Number.parseInt(rawVersion.split('.')[0] || '0', 10) || 0;
      }

      const vendorLine =
        output
          .split(/\r?\n/)
          .find((l) => /Temurin|OpenJDK|Java\(TM\)|Zulu|Corretto|Microsoft|Liberica|GraalVM/i.test(l)) ||
        'OpenJDK';
      const vendor = /Temurin/i.test(vendorLine)
        ? 'Eclipse Temurin'
        : /Microsoft/i.test(vendorLine)
          ? 'Microsoft OpenJDK'
          : /Zulu/i.test(vendorLine)
            ? 'Azul Zulu'
            : /Corretto/i.test(vendorLine)
              ? 'Amazon Corretto'
              : /Liberica/i.test(vendorLine)
                ? 'BellSoft Liberica'
                : /Java\(TM\)/i.test(vendorLine)
                  ? 'Oracle Java'
                  : 'OpenJDK';

      return {
        path: javaBin,
        version: rawVersion,
        majorVersion,
        vendor,
        source,
        isRecommended: majorVersion >= 21,
      };
    } catch {
      return null;
    }
  }

  public detectJavaInstallations(autoSelectBest = true): JavaDetectionResult {
    const isWin = process.platform === 'win32';
    const exeName = isWin ? 'java.exe' : 'java';
    const candidates: Array<{ bin: string; source: string }> = [];
    const seen = new Set<string>();

    const addCandidate = (bin: string, source: string) => {
      if (!bin) return;
      const normalized = bin === exeName || bin === 'java' ? bin : path.resolve(bin);
      const key = isWin ? normalized.toLowerCase() : normalized;
      if (seen.has(key)) return;
      if (normalized !== exeName && normalized !== 'java' && !fs.existsSync(normalized)) return;
      seen.add(key);
      candidates.push({ bin: normalized, source });
    };

    const scanChildrenForJava = (baseDir: string, source: string, depth = 1) => {
      try {
        if (!baseDir || !fs.existsSync(baseDir)) return;
        const directBin = path.join(baseDir, 'bin', exeName);
        if (fs.existsSync(directBin)) {
          addCandidate(directBin, source);
        }
        if (depth <= 0) return;
        for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          scanChildrenForJava(path.join(baseDir, entry.name), source, depth - 1);
        }
      } catch {
        // Ignore unreadable system folders
      }
    };

    // 1. JAVA_HOME
    if (process.env.JAVA_HOME) {
      addCandidate(path.join(process.env.JAVA_HOME, 'bin', exeName), 'JAVA_HOME');
    }

    // 2. System PATH resolution (where / which)
    try {
      const locator = spawnSync(isWin ? 'where' : 'which', [isWin ? 'java.exe' : 'java'], {
        shell: false,
        timeout: 2500,
        encoding: 'utf8',
      });
      if (locator.status === 0 && locator.stdout) {
        for (const line of locator.stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) addCandidate(trimmed, 'PATH');
        }
      }
    } catch {
      // Ignore if where/which fails
    }

    // 3. OS-specific standard JDK/JRE & TLauncher JVM folders
    if (isWin) {
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

      const winRoots: Array<{ dir: string; source: string; depth: number }> = [
        { dir: path.join(programFiles, 'Eclipse Adoptium'), source: 'Eclipse Adoptium', depth: 2 },
        { dir: path.join(programFiles, 'Java'), source: 'Program Files\\Java', depth: 2 },
        { dir: path.join(programFiles, 'Microsoft'), source: 'Microsoft JDK', depth: 2 },
        { dir: path.join(programFiles, 'Zulu'), source: 'Azul Zulu', depth: 2 },
        { dir: path.join(programFiles, 'BellSoft'), source: 'BellSoft Liberica', depth: 2 },
        { dir: path.join(programFiles, 'Amazon Corretto'), source: 'Amazon Corretto', depth: 2 },
        { dir: path.join(programFiles, 'AdoptOpenJDK'), source: 'AdoptOpenJDK', depth: 2 },
        { dir: path.join(localAppData, 'Programs', 'Eclipse Adoptium'), source: 'Eclipse Adoptium', depth: 2 },
        { dir: path.join(programFilesX86, 'Java'), source: 'Program Files (x86)\\Java', depth: 2 },
        { dir: path.join(appData, '.tlauncher', 'jvms'), source: 'TLauncher JVM', depth: 2 },
        { dir: path.join(appData, '.minecraft', 'runtime'), source: 'Minecraft Runtime', depth: 3 },
      ];
      for (const root of winRoots) {
        scanChildrenForJava(root.dir, root.source, root.depth);
      }
    } else {
      const linuxRoots: Array<{ dir: string; source: string; depth: number }> = [
        { dir: '/usr/lib/jvm', source: '/usr/lib/jvm', depth: 2 },
        { dir: '/usr/java', source: '/usr/java', depth: 2 },
        { dir: '/opt/java', source: '/opt/java', depth: 2 },
        { dir: path.join(os.homedir(), '.sdkman', 'candidates', 'java'), source: 'SDKMAN', depth: 2 },
        { dir: path.join(os.homedir(), '.tlauncher', 'jvms'), source: 'TLauncher JVM', depth: 2 },
      ];
      for (const root of linuxRoots) {
        scanChildrenForJava(root.dir, root.source, root.depth);
      }
    }

    // 4. Fallback to bare java command in PATH
    addCandidate(exeName, 'PATH');

    const installations: JavaInstallation[] = [];
    const seenRealPaths = new Set<string>();

    for (const candidate of candidates) {
      const probed = this.probeJavaBinary(candidate.bin, candidate.source);
      if (!probed) continue;
      let realKey = isWin ? probed.path.toLowerCase() : probed.path;
      try {
        if (fs.existsSync(probed.path)) {
          const rp = fs.realpathSync(probed.path);
          realKey = isWin ? rp.toLowerCase() : rp;
        }
      } catch {
        // ignore realpath errors
      }
      if (seenRealPaths.has(realKey)) continue;
      seenRealPaths.add(realKey);
      installations.push(probed);
    }

    // Sort: Java 21 exact first, then >= 21 descending, then highest majorVersion
    installations.sort((a, b) => {
      const score = (j: JavaInstallation) => {
        if (j.majorVersion === 21) return 1000;
        if (j.majorVersion > 21) return 900 - (j.majorVersion - 21);
        return j.majorVersion;
      };
      return score(b) - score(a);
    });

    const best = installations[0] ?? null;
    if (autoSelectBest && best) {
      this.config.javaPath = best.path;
    }

    this.javaDetection = {
      installations,
      selectedPath: best ? best.path : null,
      hasCompatible21: installations.some((j) => j.majorVersion >= 21),
      detectedAt: new Date().toISOString(),
    };

    return this.javaDetection;
  }

  private getNativeMinecraftPath(): string {
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, '.minecraft');
    }
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
    }
    return path.join(os.homedir(), '.minecraft');
  }

  private buildDefaultConfig(mode: WorkspaceMode): ServerConfig {
    if (mode === 'sandbox') {
      return {
        serverDir: path.join(this.sandboxRoot, 'server'),
        jarFile: path.join(this.sandboxRoot, 'server', `neoforge-${NEOFORGE_LOADER_VERSION}-server.jar`),
        javaPath: 'java',
        xmsMb: 2048,
        xmxMb: 4096,
        modsSourceDir: path.join(this.sandboxRoot, 'mods-library'),
        minecraftDir: path.join(this.sandboxRoot, 'tlauncher-home', '.minecraft'),
        clientBuildName: DEFAULT_BUILD_NAME,
        mode: 'sandbox',
      };
    }

    const homeServerDir = path.join(os.homedir(), 'minecraft-server');
    return {
      serverDir: homeServerDir,
      jarFile: path.join(homeServerDir, `neoforge-${NEOFORGE_LOADER_VERSION}-server.jar`),
      javaPath: process.platform === 'win32' ? 'java.exe' : 'java',
      xmsMb: 2048,
      xmxMb: 4096,
      modsSourceDir: path.join(os.homedir(), 'minecraft-mods'),
      minecraftDir: this.getNativeMinecraftPath(),
      clientBuildName: DEFAULT_BUILD_NAME,
      mode: 'native',
    };
  }

  private ensureSandboxWorkspace(): void {
    const serverDir = path.join(this.sandboxRoot, 'server');
    const serverModsDir = path.join(serverDir, 'mods');
    const modsLibraryDir = path.join(this.sandboxRoot, 'mods-library');
    const minecraftDir = path.join(this.sandboxRoot, 'tlauncher-home', '.minecraft');

    fs.mkdirSync(serverModsDir, { recursive: true });
    fs.mkdirSync(modsLibraryDir, { recursive: true });
    fs.mkdirSync(path.join(minecraftDir, 'versions'), { recursive: true });

    const propsPath = path.join(serverDir, 'server.properties');
    if (!fs.existsSync(propsPath)) {
      fs.writeFileSync(propsPath, DEFAULT_SERVER_PROPERTIES, 'utf8');
    }

    const jarPath = path.join(serverDir, `neoforge-${NEOFORGE_LOADER_VERSION}-server.jar`);
    if (!fs.existsSync(jarPath)) {
      fs.writeFileSync(
        jarPath,
        `NEOCRAFT-SANDBOX-JAR\nversion=neoforge-${NEOFORGE_MC_VERSION}-${NEOFORGE_LOADER_VERSION}\n`,
        'utf8'
      );
    }

    const whitelistPath = path.join(serverDir, 'whitelist.json');
    if (!fs.existsSync(whitelistPath)) {
      fs.writeFileSync(
        whitelistPath,
        JSON.stringify([{ uuid: '00000000-0000-3000-8000-alex00000000', name: 'Alex_Builder' }], null, 2),
        'utf8'
      );
    }

    const opsPath = path.join(serverDir, 'ops.json');
    if (!fs.existsSync(opsPath)) {
      fs.writeFileSync(
        opsPath,
        JSON.stringify(
          [{ uuid: '00000000-0000-3000-8000-alex00000000', name: 'Alex_Builder', level: 4, bypassesPlayerLimit: false }],
          null,
          2
        ),
        'utf8'
      );
    }

    for (const mod of SAMPLE_MODS) {
      const modPath = path.join(modsLibraryDir, mod.name);
      if (!fs.existsSync(modPath)) {
        // Create deterministic lightweight stub bytes with realistic header + metadata
        const header = Buffer.from(
          `PK\x03\x04NEOCRAFT_MOD:${mod.modId}:MC${NEOFORGE_MC_VERSION}:NF${NEOFORGE_LOADER_VERSION}\n`,
          'utf8'
        );
        const padding = Buffer.alloc(Math.min(mod.sizeKb * 8, 16384), 0x20);
        fs.writeFileSync(modPath, Buffer.concat([header, padding]));
      }
    }

    // Pre-sync two mods on the server so the user can clearly see synced vs unsynced states
    for (const mod of SAMPLE_MODS.slice(0, 2)) {
      const src = path.join(modsLibraryDir, mod.name);
      const dst = path.join(serverModsDir, mod.name);
      if (!fs.existsSync(dst) && fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }

    const tlauncherProfilesPath = path.join(minecraftDir, 'TLauncherProfiles.json');
    if (!fs.existsSync(tlauncherProfilesPath)) {
      fs.writeFileSync(
        tlauncherProfilesPath,
        JSON.stringify(
          {
            clientToken: 'neocraft-sandbox-token',
            selectedProfile: 'default',
            profiles: {
              default: {
                name: 'NeoCraft Sandbox Profile',
                lastVersionId: '1.21.1',
                useSeparateDirectory: true,
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );
    }
  }

  /**
   * Security boundary: in sandbox mode (and always in web-preview), confine all
   * filesystem access strictly inside sandboxRoot using normalized trailing separator check.
   */
  public resolveSafePath(inputPath: string): string {
    if (!inputPath || typeof inputPath !== 'string' || inputPath.includes('\0')) {
      throw new Error('Некорректный путь к файлу или директории.');
    }

    const resolved = path.resolve(inputPath);
    const mustConfine = this.environment === 'web-preview' || this.config.mode === 'sandbox';

    if (mustConfine) {
      const root = path.resolve(this.sandboxRoot);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error('В режиме веб-песочницы доступ разрешен только внутри рабочей директории песочницы.');
      }
    }

    return resolved;
  }

  public getFullState(): AppFullState {
    return {
      environment: this.environment,
      platform: process.platform,
      sandboxRoot: this.sandboxRoot,
      config: { ...this.config },
      network: this.readNetworkProperties(),
      runtime: {
        ...this.runtime,
        eulaAccepted: this.checkEulaAccepted(this.config.serverDir),
        players: this.readPlayersFromDisk(this.config.serverDir),
      },
      logs: [...this.logs],
      mods: this.scanMods(this.config.modsSourceDir),
      javaDetection: { ...this.javaDetection },
      serverCore: this.inspectServerCore(),
      clientDetection: this.detectTLauncher(),
      clientSteps: this.clientSteps.map((s) => ({ ...s })),
      lastClientSetup: this.lastClientSetup ? { ...this.lastClientSetup } : null,
    };
  }

  public async setWorkspaceMode(mode: WorkspaceMode): Promise<AppFullState> {
    if (mode !== 'sandbox' && mode !== 'native') {
      throw new Error('Неверный режим рабочего пространства.');
    }
    if (this.environment === 'web-preview' && mode === 'native') {
      // Allow switching view to inspect OS detection paths safely, while keeping write confinement
      this.config = this.buildDefaultConfig('sandbox');
      this.appendLog('SYSTEM', 'system', 'Web-превью работает в защищенной песочнице. Нативные системные пути активны в десктопной сборке Electron.');
      return this.getFullState();
    }
    if (this.childProc) {
      await this.stopServer();
    }
    this.config = this.buildDefaultConfig(mode);
    if (this.javaDetection.selectedPath) {
      this.config.javaPath = this.javaDetection.selectedPath;
    }
    this.runtime.eulaAccepted = this.checkEulaAccepted(this.config.serverDir);
    this.runtime.players = this.readPlayersFromDisk(this.config.serverDir);
    return this.getFullState();
  }

  public updateServerConfig(patch: Partial<ServerConfig>): AppFullState {
    const next = { ...this.config };

    if (typeof patch.serverDir === 'string' && patch.serverDir.trim()) {
      next.serverDir = this.resolveSafePath(patch.serverDir.trim());
    }
    if (typeof patch.jarFile === 'string' && patch.jarFile.trim()) {
      next.jarFile = this.resolveSafePath(patch.jarFile.trim());
    }
    if (typeof patch.modsSourceDir === 'string' && patch.modsSourceDir.trim()) {
      next.modsSourceDir = this.resolveSafePath(patch.modsSourceDir.trim());
    }
    if (typeof patch.minecraftDir === 'string' && patch.minecraftDir.trim()) {
      next.minecraftDir = this.resolveSafePath(patch.minecraftDir.trim());
    }
    if (typeof patch.javaPath === 'string' && patch.javaPath.trim()) {
      const cleanedJava = patch.javaPath.trim();
      if (cleanedJava.includes('\0') || /[\r\n]/.test(cleanedJava)) {
        throw new Error('Некорректный путь к исполняемому файлу Java.');
      }
      next.javaPath = cleanedJava;
    }
    if (typeof patch.clientBuildName === 'string' && patch.clientBuildName.trim()) {
      const cleanedBuild = patch.clientBuildName.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cleanedBuild) || cleanedBuild.includes('..')) {
        throw new Error('Имя сборки может содержать только латинские буквы, цифры, дефис, точку и подчеркивание (без «..»).');
      }
      next.clientBuildName = cleanedBuild;
    }

    const nextXms = patch.xmsMb !== undefined ? Number(patch.xmsMb) : next.xmsMb;
    const nextXmx = patch.xmxMb !== undefined ? Number(patch.xmxMb) : next.xmxMb;

    if (!Number.isInteger(nextXms) || nextXms < 512 || nextXms > 65536) {
      throw new Error('Минимальная память (Xms) должна быть от 512 МБ до 65536 МБ.');
    }
    if (!Number.isInteger(nextXmx) || nextXmx < 512 || nextXmx > 65536) {
      throw new Error('Максимальная память (Xmx) должна быть от 512 МБ до 65536 МБ.');
    }
    if (nextXms > nextXmx) {
      throw new Error('Минимальная память (Xms) не может превышать максимальную (Xmx).');
    }

    next.xmsMb = nextXms;
    next.xmxMb = nextXmx;

    this.config = next;
    this.syncAutoDetectedCorePath();
    this.savePersistedConfig();
    this.runtime.eulaAccepted = this.checkEulaAccepted(this.config.serverDir);
    this.runtime.players = this.readPlayersFromDisk(this.config.serverDir);
    return this.getFullState();
  }

  private checkEulaAccepted(serverDir: string): boolean {
    try {
      const safeDir = this.resolveSafePath(serverDir);
      const eulaPath = path.join(safeDir, 'eula.txt');
      if (!fs.existsSync(eulaPath)) return false;
      const content = fs.readFileSync(eulaPath, 'utf8');
      return /^eula\s*=\s*true$/im.test(content);
    } catch {
      return false;
    }
  }

  public ensureEulaAccepted(serverDir: string): boolean {
    const safeDir = this.resolveSafePath(serverDir);
    fs.mkdirSync(safeDir, { recursive: true });
    const eulaPath = path.join(safeDir, 'eula.txt');

    if (this.checkEulaAccepted(safeDir)) {
      return false;
    }

    const content = `#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n#${new Date().toUTCString()}\neula=true\n`;
    fs.writeFileSync(eulaPath, content, 'utf8');
    this.runtime.eulaAccepted = true;
    return true;
  }

  public readNetworkProperties(): NetworkSettings {
    const safeServerDir = this.resolveSafePath(this.config.serverDir);
    const propsPath = path.join(safeServerDir, 'server.properties');

    if (!fs.existsSync(propsPath)) {
      return {
        serverIp: '',
        serverPort: 25565,
        propertiesPath: propsPath,
        fileExists: false,
        rawPreview: '# Файл server.properties еще не создан. Он будет создан автоматически при сохранении.',
        otherKeysCount: 0,
      };
    }

    const content = fs.readFileSync(propsPath, 'utf8');
    let serverIp = '';
    let serverPort = 25565;
    let otherKeysCount = 0;

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key === 'server-ip') {
        serverIp = val;
      } else if (key === 'server-port') {
        const parsed = Number.parseInt(val, 10);
        if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
          serverPort = parsed;
        }
      } else {
        otherKeysCount += 1;
      }
    }

    return {
      serverIp,
      serverPort,
      propertiesPath: propsPath,
      fileExists: true,
      rawPreview: content,
      otherKeysCount,
    };
  }

  public saveNetworkProperties(rawIp: string, rawPort: number): NetworkSettings {
    const ip = (rawIp ?? '').trim();
    const port = Number(rawPort);

    if (ip.length > 0) {
      const ipv4Regex =
        /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
      const hostRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
      if (!ipv4Regex.test(ip) && !hostRegex.test(ip)) {
        throw new Error('Введите корректный IPv4-адрес, домен или оставьте поле пустым (0.0.0.0).');
      }
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Порт должен быть целым числом от 1 до 65535.');
    }

    const safeServerDir = this.resolveSafePath(this.config.serverDir);
    fs.mkdirSync(safeServerDir, { recursive: true });
    const propsPath = path.join(safeServerDir, 'server.properties');

    const baseContent = fs.existsSync(propsPath)
      ? fs.readFileSync(propsPath, 'utf8')
      : DEFAULT_SERVER_PROPERTIES;

    const lines = baseContent.split(/\r?\n/);
    let updatedIp = false;
    let updatedPort = false;

    const nextLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) return line;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key === 'server-ip') {
        updatedIp = true;
        return `server-ip=${ip}`;
      }
      if (key === 'server-port') {
        updatedPort = true;
        return `server-port=${port}`;
      }
      return line;
    });

    if (!updatedIp) nextLines.push(`server-ip=${ip}`);
    if (!updatedPort) nextLines.push(`server-port=${port}`);

    const finalContent = `${nextLines.join('\n').replace(/\n+$/, '')}\n`;
    fs.writeFileSync(propsPath, finalContent, 'utf8');

    this.appendLog(
      'SYSTEM',
      'system',
      `Обновлен server.properties: server-ip=${ip || '(все интерфейсы)'}, server-port=${port}`
    );

    return this.readNetworkProperties();
  }

  private readPlayersFromDisk(serverDir: string): PlayerLists {
    try {
      const safeDir = this.resolveSafePath(serverDir);
      const readList = (file: string): string[] => {
        const p = path.join(safeDir, file);
        if (!fs.existsSync(p)) return [];
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((item) => (typeof item === 'string' ? item : item?.name))
          .filter((name): name is string => typeof name === 'string' && name.length > 0);
      };
      return {
        whitelist: readList('whitelist.json'),
        ops: readList('ops.json'),
        onlinePlayers: [],
      };
    } catch {
      return { whitelist: [], ops: [], onlinePlayers: [] };
    }
  }

  private updateRuntimeStatus(status: ServerStatus, lastError: string | null = null): void {
    this.runtime = {
      ...this.runtime,
      status,
      lastError,
      players: this.readPlayersFromDisk(this.config.serverDir),
    };
    this.emit('server-status', { ...this.runtime });
  }

  private appendLog(level: LogLevel, source: LogEntry['source'], message: string): void {
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: formatTimestamp(),
      level,
      source,
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs = this.logs.slice(this.logs.length - MAX_LOG_LINES);
    }
    this.emit('server-log', entry);
  }

  public clearLogs(): void {
    this.logs = [];
  }

  private isSandboxStubJar(jarPath: string): boolean {
    try {
      if (!fs.existsSync(jarPath)) return false;
      const fd = fs.openSync(jarPath, 'r');
      const buf = Buffer.alloc(24);
      fs.readSync(fd, buf, 0, 24, 0);
      fs.closeSync(fd);
      return buf.toString('utf8').startsWith('NEOCRAFT-SANDBOX-JAR');
    } catch {
      return false;
    }
  }

  private findNeoForgeArgsFile(serverDir: string): string | null {
    const argsFileName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    const nfBase = path.join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge');
    try {
      if (!fs.existsSync(nfBase)) return null;
      const versions = fs
        .readdirSync(nfBase, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
      for (const ver of versions) {
        const candidate = path.join(nfBase, ver, argsFileName);
        if (fs.existsSync(candidate)) {
          return path.relative(serverDir, candidate);
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  private autoFindServerJar(serverDir: string): string | null {
    try {
      if (!fs.existsSync(serverDir)) return null;
      const jars = fs
        .readdirSync(serverDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.jar'))
        .map((e) => e.name)
        .filter((name) => !/installer/i.test(name));
      if (jars.length === 0) return null;
      const preferred =
        jars.find((n) => /neoforge|server|forge|paper|purpur|fabric/i.test(n)) || jars[0];
      return path.join(serverDir, preferred);
    } catch {
      return null;
    }
  }

  public async startServer(): Promise<{ ok: boolean; error?: string }> {
    if (this.childProc || this.runtime.status === 'starting' || this.runtime.status === 'online') {
      return { ok: false, error: 'Сервер уже запущен или находится в процессе запуска.' };
    }

    try {
      const safeServerDir = this.resolveSafePath(this.config.serverDir);
      let safeJarPath = this.resolveSafePath(this.config.jarFile);
      fs.mkdirSync(safeServerDir, { recursive: true });

      const createdEula = this.ensureEulaAccepted(safeServerDir);
      if (createdEula) {
        this.appendLog('SYSTEM', 'system', `Создан файл eula.txt (eula=true) в ${safeServerDir}`);
      } else {
        this.appendLog('SYSTEM', 'system', 'Проверка eula.txt пройдена (eula=true).');
      }

      const useSandboxRunner =
        this.environment === 'web-preview' ||
        this.config.mode === 'sandbox' ||
        this.isSandboxStubJar(safeJarPath);

      this.runtime.executionEngine = useSandboxRunner ? 'sandbox-runner' : 'java';
      this.runtime.startedAt = new Date().toISOString();
      this.updateRuntimeStatus('starting', null);

      let child: ChildProcessWithoutNullStreams;

      if (useSandboxRunner) {
        this.appendLog(
          'SYSTEM',
          'system',
          `Запуск процесса NeoForge 1.21.1 (режим песочницы): -Xms${this.config.xmsMb}M -Xmx${this.config.xmxMb}M -jar ${path.basename(safeJarPath)}`
        );
        // CRITICAL: ELECTRON_RUN_AS_NODE=1 ensures packaged Electron spawns pure Node.js
        // instead of launching a duplicate Chromium Electron instance (which locks GPU/disk cache).
        child = spawn(
          process.execPath,
          [
            this.runnerScriptPath,
            safeServerDir,
            path.basename(safeJarPath),
            String(this.config.xmsMb),
            String(this.config.xmxMb),
          ],
          {
            cwd: safeServerDir,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1',
            },
          }
        );
      } else {
        // Re-detect Java automatically if current path isn't found
        if (!this.javaDetection.installations.length || this.config.javaPath === 'java.exe' || this.config.javaPath === 'java') {
          this.detectJavaInstallations(true);
        }

        if (!this.javaDetection.selectedPath && !fs.existsSync(this.config.javaPath)) {
          const errMsg =
            'Java 21 не найдена в системе. Установите Eclipse Temurin JDK 21 (adoptium.net) и нажмите «Найти Java».';
          this.appendLog('ERROR', 'system', errMsg);
          this.updateRuntimeStatus('error', errMsg);
          return { ok: false, error: errMsg };
        }

        let neoForgeArgsRel = this.findNeoForgeArgsFile(safeServerDir);
        let jvmArgs: string[];

        // Auto-download & install NeoForge 1.21.1 server core if missing on disk!
        if (!neoForgeArgsRel && !fs.existsSync(safeJarPath)) {
          const discoveredJar = this.autoFindServerJar(safeServerDir);
          if (discoveredJar) {
            safeJarPath = discoveredJar;
            this.config.jarFile = discoveredJar;
            this.appendLog('SYSTEM', 'system', `Автоматически найдено ядро сервера: ${discoveredJar}`);
          } else {
            this.appendLog(
              'SYSTEM',
              'system',
              'Ядро сервера не найдено — запускается автоматическая загрузка и установка NeoForge 1.21.1...'
            );
            const initRes = await this.initializeServer(safeServerDir);
            if (!initRes.ok) {
              const errMsg = initRes.error || 'Не удалось автоматически установить ядро NeoForge 1.21.1.';
              this.updateRuntimeStatus('error', errMsg);
              return { ok: false, error: errMsg };
            }
            neoForgeArgsRel = this.findNeoForgeArgsFile(safeServerDir);
            safeJarPath = this.resolveSafePath(this.config.jarFile);
          }
        }

        if (neoForgeArgsRel) {
          this.appendLog(
            'SYSTEM',
            'system',
            `Обнаружено серверное ядро NeoForge (${neoForgeArgsRel}). Используется Java: ${this.config.javaPath}`
          );
          jvmArgs = [
            `-Xms${this.config.xmsMb}M`,
            `-Xmx${this.config.xmxMb}M`,
            `@${neoForgeArgsRel}`,
            'nogui',
          ];
        } else {
          jvmArgs = [
            `-Xms${this.config.xmsMb}M`,
            `-Xmx${this.config.xmxMb}M`,
            '-jar',
            safeJarPath,
            'nogui',
          ];
        }

        this.appendLog('SYSTEM', 'system', `Выполнение: "${this.config.javaPath}" ${jvmArgs.join(' ')}`);
        child = spawn(this.config.javaPath, jvmArgs, {
          cwd: safeServerDir,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      this.childProc = child;
      this.runtime.pid = child.pid ?? null;
      this.emit('server-status', { ...this.runtime });

      const handleStreamChunk = (chunk: Buffer, source: 'stdout' | 'stderr') => {
        const text = chunk.toString('utf8');
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trimEnd();
          if (!line) continue;
          const level = classifyLogLevel(line, source);
          this.appendLog(level, source, line);

          if (/Done\s*\([^)]+\)!/i.test(line) && this.runtime.status !== 'online') {
            this.updateRuntimeStatus('online', null);
          }

          if (
            /(Added|Removed).*whitelist|Made .* server operator|no longer a server operator/i.test(line)
          ) {
            const players = this.readPlayersFromDisk(this.config.serverDir);
            this.runtime.players = players;
            this.emit('players-update', players);
          }
        }
      };

      child.stdout.on('data', (chunk: Buffer) => handleStreamChunk(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => handleStreamChunk(chunk, 'stderr'));

      child.on('error', (err) => {
        this.childProc = null;
        this.runtime.pid = null;
        this.appendLog('ERROR', 'system', `Ошибка запуска процесса: ${err.message}`);
        this.updateRuntimeStatus('error', err.message);
      });

      child.on('close', (code) => {
        const wasStopping = this.runtime.status === 'offline';
        this.childProc = null;
        this.runtime.pid = null;
        this.runtime.startedAt = null;
        if (code === 0 || code === null || wasStopping) {
          this.appendLog('SYSTEM', 'system', `Процесс сервера остановлен (код выхода: ${code ?? 0}).`);
          this.updateRuntimeStatus('offline', null);
        } else {
          const errMsg = `Сервер завершился аварийно с кодом ${code}.`;
          this.appendLog('ERROR', 'system', errMsg);
          this.updateRuntimeStatus('error', errMsg);
        }
      });

      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Неизвестная ошибка запуска сервера.';
      this.appendLog('ERROR', 'system', msg);
      this.updateRuntimeStatus('error', msg);
      return { ok: false, error: msg };
    }
  }

  public async stopServer(): Promise<{ ok: boolean; error?: string }> {
    const proc = this.childProc;
    if (!proc) {
      this.updateRuntimeStatus('offline', null);
      return { ok: true };
    }

    this.appendLog('SYSTEM', 'system', 'Отправка команды остановки (stop)...');

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve({ ok: true });
      };

      proc.once('close', finish);

      try {
        proc.stdin.write('stop\n');
      } catch {
        proc.kill('SIGTERM');
      }

      const killTimer = setTimeout(() => {
        if (this.childProc === proc) {
          this.appendLog('WARN', 'system', 'Превышено время ожидания остановки, принудительное завершение (SIGTERM).');
          proc.kill('SIGTERM');
        }
        finish();
      }, 5000);
    });
  }

  public async restartServer(): Promise<{ ok: boolean; error?: string }> {
    this.appendLog('SYSTEM', 'system', 'Перезапуск сервера...');
    await this.stopServer();
    await sleep(300);
    return this.startServer();
  }

  public sendCommand(rawCommand: string): { ok: boolean; error?: string } {
    if (!this.childProc || this.runtime.status === 'offline') {
      return { ok: false, error: 'Сервер не запущен. Запустите сервер перед отправкой команд.' };
    }

    const command = rawCommand.replace(/[\r\n\0]/g, '').trim();
    if (!command) {
      return { ok: false, error: 'Команда не может быть пустой.' };
    }
    if (command.length > 256) {
      return { ok: false, error: 'Команда превышает допустимую длину (256 символов).' };
    }

    this.appendLog('CMD', 'stdin', `> ${command}`);
    try {
      this.childProc.stdin.write(`${command}\n`);
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Не удалось записать команду в stdin процесса.';
      this.appendLog('ERROR', 'system', msg);
      return { ok: false, error: msg };
    }
  }

  public scanMods(overrideSourceDir?: string): ModsState {
    const sourceDir = this.resolveSafePath(overrideSourceDir || this.config.modsSourceDir);
    const serverModsDir = path.join(this.resolveSafePath(this.config.serverDir), 'mods');

    const readJarDir = (dir: string): Map<string, fs.Stats> => {
      const map = new Map<string, fs.Stats>();
      if (!fs.existsSync(dir)) return map;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
        const full = path.join(dir, entry.name);
        map.set(entry.name, fs.statSync(full));
      }
      return map;
    };

    const sourceMap = readJarDir(sourceDir);
    const serverMap = readJarDir(serverModsDir);

    const sourceMods: ModFileInfo[] = Array.from(sourceMap.entries())
      .map(([name, stat]) => {
        const srvStat = serverMap.get(name);
        return {
          name,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          syncedToServer: Boolean(srvStat),
          sizeMatchesServer: Boolean(srvStat && srvStat.size === stat.size),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const serverMods: ModFileInfo[] = Array.from(serverMap.entries())
      .map(([name, stat]) => ({
        name,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        syncedToServer: true,
        sizeMatchesServer: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      sourceDir,
      serverModsDir,
      sourceMods,
      serverMods,
    };
  }

  public copyModsToServer(overrideSourceDir?: string): { result: CopyModsResult; mods: ModsState } {
    const sourceDir = this.resolveSafePath(overrideSourceDir || this.config.modsSourceDir);
    if (overrideSourceDir) {
      this.config.modsSourceDir = sourceDir;
    }

    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Папка с модами не найдена: ${sourceDir}`);
    }

    const serverModsDir = path.join(this.resolveSafePath(this.config.serverDir), 'mods');
    fs.mkdirSync(serverModsDir, { recursive: true });

    const copiedFiles: string[] = [];
    let skippedCount = 0;

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.jar')) {
        skippedCount += 1;
        continue;
      }
      const srcPath = path.join(sourceDir, entry.name);
      const dstPath = path.join(serverModsDir, entry.name);
      fs.copyFileSync(srcPath, dstPath);
      copiedFiles.push(entry.name);
    }

    this.appendLog(
      'SYSTEM',
      'system',
      `Скопировано ${copiedFiles.length} .jar модов на сервер (${serverModsDir}).`
    );

    return {
      result: {
        copiedCount: copiedFiles.length,
        skippedCount,
        targetDir: serverModsDir,
        copiedFiles,
      },
      mods: this.scanMods(sourceDir),
    };
  }

  public deleteServerMod(fileName: string): ModsState {
    if (!fileName || fileName !== path.basename(fileName) || !fileName.toLowerCase().endsWith('.jar')) {
      throw new Error('Некорректное имя файла мода (.jar).');
    }

    const serverModsDir = path.join(this.resolveSafePath(this.config.serverDir), 'mods');
    const targetPath = path.resolve(serverModsDir, fileName);
    if (!targetPath.startsWith(serverModsDir + path.sep)) {
      throw new Error('Недопустимый путь к файлу мода.');
    }

    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      this.appendLog('SYSTEM', 'system', `Удален мод с сервера: ${fileName}`);
    }

    return this.scanMods(this.config.modsSourceDir);
  }

  public detectTLauncher(): ClientDetectionResult {
    const platform = process.platform;
    const platformLabel =
      platform === 'win32'
        ? 'Windows (%APPDATA%\\.minecraft)'
        : platform === 'darwin'
          ? 'macOS (~/Library/Application Support/minecraft)'
          : 'Linux (~/.minecraft)';

    const detectedPath =
      this.config.mode === 'sandbox' || this.environment === 'web-preview'
        ? this.config.minecraftDir
        : this.getNativeMinecraftPath();

    const exists = fs.existsSync(detectedPath);
    const tlauncherProfilesFound = exists && fs.existsSync(path.join(detectedPath, 'TLauncherProfiles.json'));

    return {
      platform,
      platformLabel,
      detectedPath,
      exists,
      tlauncherProfilesFound,
      mode: this.config.mode,
    };
  }

  private emitClientStep(stepId: SetupStepId, status: ClientSetupStep['status'], detail?: string): void {
    this.clientSteps = this.clientSteps.map((step) =>
      step.id === stepId ? { ...step, status, detail: detail ?? step.detail } : step
    );
    this.emit(
      'client-setup-progress',
      this.clientSteps.map((s) => ({ ...s }))
    );
  }

  public async setupNeoForgeClient(options: {
    minecraftDir: string;
    buildName: string;
    modsSourceDir: string;
  }): Promise<ClientSetupResult> {
    if (this.isClientSetupRunning) {
      throw new Error('Установка клиентской сборки уже выполняется.');
    }

    const buildName = (options.buildName || DEFAULT_BUILD_NAME).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(buildName) || buildName.includes('..')) {
      throw new Error('Имя сборки должно начинаться с буквы или цифры и не содержать «..».');
    }

    const minecraftDir = this.resolveSafePath(options.minecraftDir || this.config.minecraftDir);
    const modsSourceDir = this.resolveSafePath(options.modsSourceDir || this.config.modsSourceDir);

    this.config.minecraftDir = minecraftDir;
    this.config.clientBuildName = buildName;
    this.config.modsSourceDir = modsSourceDir;

    this.isClientSetupRunning = true;
    this.clientSteps = createInitialSteps();
    this.emit(
      'client-setup-progress',
      this.clientSteps.map((s) => ({ ...s }))
    );

    const versionDir = path.join(minecraftDir, 'versions', buildName);
    const rootModsDir = path.join(minecraftDir, 'mods');
    const isolatedModsDir = path.join(versionDir, 'mods');
    const versionJsonPath = path.join(versionDir, `${buildName}.json`);
    let installerUsed = false;

    try {
      // Step 1: Detect client
      this.emitClientStep('detect', 'running', `Проверка ${minecraftDir}...`);
      await sleep(320);
      fs.mkdirSync(minecraftDir, { recursive: true });
      this.emitClientStep('detect', 'completed', `Каталог клиента подтвержден: ${minecraftDir}`);

      // Step 2: Install NeoForge 21.1.267 for Minecraft 1.21.1
      this.emitClientStep(
        'neoforge',
        'running',
        `Создание структуры профиля Minecraft ${NEOFORGE_MC_VERSION} / NeoForge ${NEOFORGE_LOADER_VERSION}...`
      );
      await sleep(420);

      fs.mkdirSync(versionDir, { recursive: true });

      // If user placed official neoforge-21.1.267-installer.jar next to mods or minecraftDir in native mode, invoke it safely
      const candidateInstaller = path.join(
        minecraftDir,
        `neoforge-${NEOFORGE_LOADER_VERSION}-installer.jar`
      );
      if (this.config.mode === 'native' && this.environment === 'electron' && fs.existsSync(candidateInstaller)) {
        await new Promise<void>((resolve, reject) => {
          const installerProc = spawn(
            this.config.javaPath,
            ['-jar', candidateInstaller, '--installClient', minecraftDir],
            { shell: false }
          );
          installerProc.on('error', reject);
          installerProc.on('close', (code) => {
            if (code === 0) {
              installerUsed = true;
              resolve();
            } else {
              reject(new Error(`Инсталлятор NeoForge завершился с кодом ${code}`));
            }
          });
        });
      }

      // Write TLauncher-compatible NeoForge 1.21.1 version profile JSON
      const versionManifest = {
        id: buildName,
        inheritsFrom: NEOFORGE_MC_VERSION,
        releaseTime: new Date().toISOString(),
        time: new Date().toISOString(),
        type: 'release',
        mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
        arguments: {
          game: [
            '--fml.neoForgeVersion',
            NEOFORGE_LOADER_VERSION,
            '--fml.fmlVersion',
            '4.0.34',
            '--fml.mcVersion',
            NEOFORGE_MC_VERSION,
            '--fml.neoFormVersion',
            '20240808.144430',
            '--launchTarget',
            'forgeclient',
          ],
        },
        libraries: [
          {
            name: `net.neoforged:neoforge:${NEOFORGE_LOADER_VERSION}`,
            downloads: {
              artifact: {
                url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_LOADER_VERSION}/neoforge-${NEOFORGE_LOADER_VERSION}-installer.jar`,
              },
            },
          },
        ],
        tlauncher: {
          managedBy: 'NeoCraft Control',
          isolatedDirectory: true,
        },
      };

      fs.writeFileSync(versionJsonPath, JSON.stringify(versionManifest, null, 2), 'utf8');

      // Register profile inside TLauncherProfiles.json if present (or create it)
      const tlProfilesPath = path.join(minecraftDir, 'TLauncherProfiles.json');
      let tlProfiles: Record<string, unknown> = { selectedProfile: buildName, profiles: {} };
      if (fs.existsSync(tlProfilesPath)) {
        try {
          tlProfiles = JSON.parse(fs.readFileSync(tlProfilesPath, 'utf8'));
        } catch {
          tlProfiles = { selectedProfile: buildName, profiles: {} };
        }
      }
      const profilesMap =
        typeof tlProfiles.profiles === 'object' && tlProfiles.profiles !== null
          ? (tlProfiles.profiles as Record<string, unknown>)
          : {};
      profilesMap[buildName] = {
        name: buildName,
        lastVersionId: buildName,
        gameDir: versionDir,
        useSeparateDirectory: true,
      };
      tlProfiles.profiles = profilesMap;
      tlProfiles.selectedProfile = buildName;
      fs.writeFileSync(tlProfilesPath, JSON.stringify(tlProfiles, null, 2), 'utf8');

      this.emitClientStep(
        'neoforge',
        'completed',
        installerUsed
          ? `Установлено через neoforge-${NEOFORGE_LOADER_VERSION}-installer.jar`
          : `Профиль ${buildName}.json зарегистрирован в TLauncher`
      );

      // Step 3: Force-create BOTH .minecraft/mods AND .minecraft/versions/<BuildName>/mods BEFORE first launch
      this.emitClientStep(
        'init-mods',
        'running',
        'Принудительное создание корневой и изолированной папок mods...'
      );
      await sleep(360);
      fs.mkdirSync(rootModsDir, { recursive: true });
      fs.mkdirSync(isolatedModsDir, { recursive: true });
      this.emitClientStep(
        'init-mods',
        'completed',
        `Созданы обе директории: ${rootModsDir} и ${isolatedModsDir}`
      );

      // Step 4: Copy all .jar mods from sourceDir into BOTH client mods directories
      this.emitClientStep('copy-mods', 'running', `Копирование .jar файлов из ${modsSourceDir}...`);
      await sleep(420);

      const copiedMods: string[] = [];
      if (fs.existsSync(modsSourceDir)) {
        for (const entry of fs.readdirSync(modsSourceDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
          const src = path.join(modsSourceDir, entry.name);
          fs.copyFileSync(src, path.join(rootModsDir, entry.name));
          fs.copyFileSync(src, path.join(isolatedModsDir, entry.name));
          copiedMods.push(entry.name);
        }
      }

      this.emitClientStep(
        'copy-mods',
        'completed',
        copiedMods.length > 0
          ? `Установлено ${copiedMods.length} мод(ов) в обе директории mods`
          : 'Папка-источник не содержит .jar файлов (директории mods созданы пустыми)'
      );

      // Step 5: Done
      await sleep(220);
      this.emitClientStep(
        'done',
        'completed',
        `Сборка ${buildName} полностью готова к запуску в TLauncher`
      );

      const result: ClientSetupResult = {
        success: true,
        buildName,
        minecraftDir,
        versionDir,
        rootModsDir,
        isolatedModsDir,
        versionJsonPath,
        copiedModsCount: copiedMods.length,
        copiedMods,
        installerUsed,
      };
      this.lastClientSetup = result;
      this.appendLog(
        'SYSTEM',
        'system',
        `Клиентская сборка ${buildName} создана. Модов установлено: ${copiedMods.length}.`
      );
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Ошибка сборки клиента TLauncher.';
      const runningStep = this.clientSteps.find((s) => s.status === 'running')?.id ?? 'neoforge';
      this.emitClientStep(runningStep, 'error', msg);
      const failResult: ClientSetupResult = {
        success: false,
        buildName,
        minecraftDir,
        versionDir,
        rootModsDir,
        isolatedModsDir,
        versionJsonPath,
        copiedModsCount: 0,
        copiedMods: [],
        installerUsed,
        error: msg,
      };
      this.lastClientSetup = failResult;
      return failResult;
    } finally {
      this.isClientSetupRunning = false;
    }
  }

  public browseDirectory(targetPath?: string): FsBrowseResult {
    const rootPath =
      this.environment === 'web-preview' || this.config.mode === 'sandbox'
        ? this.sandboxRoot
        : os.homedir();

    const currentPath = targetPath ? this.resolveSafePath(targetPath) : rootPath;

    if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isDirectory()) {
      throw new Error('Указанная директория не существует.');
    }

    const entries: FsBrowseEntry[] = fs
      .readdirSync(currentPath, { withFileTypes: true })
      .map((entry) => {
        const fullPath = path.join(currentPath, entry.name);
        let sizeBytes: number | undefined;
        if (entry.isFile()) {
          try {
            sizeBytes = fs.statSync(fullPath).size;
          } catch {
            sizeBytes = 0;
          }
        }
        return {
          name: entry.name,
          fullPath,
          isDirectory: entry.isDirectory(),
          sizeBytes,
        };
      })
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const parentCandidate = path.dirname(currentPath);
    let parentPath: string | null = null;
    if (parentCandidate !== currentPath) {
      if (this.environment === 'web-preview' || this.config.mode === 'sandbox') {
        if (
          parentCandidate === this.sandboxRoot ||
          parentCandidate.startsWith(this.sandboxRoot + path.sep)
        ) {
          parentPath = parentCandidate;
        }
      } else {
        parentPath = parentCandidate;
      }
    }

    return {
      currentPath,
      parentPath,
      rootPath,
      entries,
    };
  }
}
