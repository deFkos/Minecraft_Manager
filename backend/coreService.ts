import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Ignore on older Node runtimes
}
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
  private readonly activePidFilePath: string;
  private serverInitialized = false;
  private setupPromptDismissed = false;
  private installingCore = false;
  private installStage: string | null = null;
  private installPercent = 0;
  private installError: string | null = null;
  private networkPrefs: {
    shareIp: string;
    bindIp: string;
    serverPort: number;
    hasSavedNetwork: boolean;
  } = {
    shareIp: '',
    bindIp: '',
    serverPort: 25565,
    hasSavedNetwork: false,
  };

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
    this.activePidFilePath = path.join(this.appDataRoot, 'active-server.pid');

    this.sandboxRoot =
      environment === 'electron' && isPackagedAsar
        ? path.join(this.appDataRoot, 'sandbox')
        : path.resolve(projectRoot, '.neocraft-sandbox');
    this.runnerScriptPath = path.resolve(unpackedRoot, 'backend', 'sandboxRunner.mjs');

    this.ensureSandboxWorkspace();
    this.cleanupStaleServerProcess();

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

  private writeActivePidFile(pid: number, port: number, serverDir: string): void {
    try {
      fs.mkdirSync(this.appDataRoot, { recursive: true });
      fs.writeFileSync(
        this.activePidFilePath,
        JSON.stringify({ pid, port, serverDir, startedAt: new Date().toISOString() }),
        'utf8'
      );
    } catch {
      // non-fatal
    }
  }

  private clearActivePidFile(): void {
    try {
      if (fs.existsSync(this.activePidFilePath)) {
        fs.unlinkSync(this.activePidFilePath);
      }
    } catch {
      // non-fatal
    }
  }

  private killProcessTreeSync(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
          timeout: 4000,
        });
      } else {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already exited
        }
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already exited
        }
      }
    } catch {
      // ignore if process already gone
    }
  }

  private cleanupStaleServerProcess(): void {
    try {
      if (!fs.existsSync(this.activePidFilePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.activePidFilePath, 'utf8')) as {
        pid?: number;
        port?: number;
      };
      if (typeof raw.pid === 'number' && raw.pid > 0 && raw.pid !== process.pid) {
        let alive = false;
        try {
          process.kill(raw.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive) {
          this.killProcessTreeSync(raw.pid);
        }
      }
    } catch {
      // ignore malformed pid file
    } finally {
      this.clearActivePidFile();
    }
  }

  private getLocalInterfaceIps(): string[] {
    const ips = new Set<string>(['127.0.0.1', '0.0.0.0']);
    try {
      const ifaces = os.networkInterfaces();
      for (const entries of Object.values(ifaces)) {
        if (!entries) continue;
        for (const info of entries) {
          if (info.family === 'IPv4' && info.address) {
            ips.add(info.address);
          }
        }
      }
    } catch {
      // ignore
    }
    return Array.from(ips);
  }

  private isBindableLocalIp(ip: string): boolean {
    const cleaned = ip.trim().toLowerCase();
    if (!cleaned || cleaned === '0.0.0.0' || cleaned === '127.0.0.1' || cleaned === 'localhost' || cleaned === '::') {
      return true;
    }
    return this.getLocalInterfaceIps().includes(cleaned);
  }

  private loadPersistedConfig(): void {
    try {
      if (!fs.existsSync(this.configFilePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.configFilePath, 'utf8')) as {
        config?: Partial<ServerConfig>;
        serverInitialized?: boolean;
        setupPromptDismissed?: boolean;
        networkPrefs?: {
          shareIp?: string;
          bindIp?: string;
          serverPort?: number;
          hasSavedNetwork?: boolean;
        };
      };
      if (raw.config) {
        const allowPath = (p: string) => {
          if (this.environment === 'electron') return true;
          const root = path.resolve(this.sandboxRoot);
          const resolved = path.resolve(p);
          return resolved === root || resolved.startsWith(root + path.sep);
        };
        if (typeof raw.config.serverDir === 'string' && raw.config.serverDir.trim() && allowPath(raw.config.serverDir.trim())) {
          this.config.serverDir = raw.config.serverDir.trim();
        }
        if (typeof raw.config.jarFile === 'string' && raw.config.jarFile.trim() && allowPath(raw.config.jarFile.trim())) {
          this.config.jarFile = raw.config.jarFile.trim();
        }
        if (typeof raw.config.modsSourceDir === 'string' && raw.config.modsSourceDir.trim() && allowPath(raw.config.modsSourceDir.trim())) {
          this.config.modsSourceDir = raw.config.modsSourceDir.trim();
        }
        if (typeof raw.config.minecraftDir === 'string' && raw.config.minecraftDir.trim() && allowPath(raw.config.minecraftDir.trim())) {
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
      if (typeof raw.setupPromptDismissed === 'boolean') {
        this.setupPromptDismissed = raw.setupPromptDismissed;
      }
      if (raw.networkPrefs && typeof raw.networkPrefs === 'object') {
        if (typeof raw.networkPrefs.shareIp === 'string') {
          this.networkPrefs.shareIp = raw.networkPrefs.shareIp.trim();
        }
        if (typeof raw.networkPrefs.bindIp === 'string') {
          this.networkPrefs.bindIp = raw.networkPrefs.bindIp.trim();
        }
        if (
          typeof raw.networkPrefs.serverPort === 'number' &&
          Number.isInteger(raw.networkPrefs.serverPort) &&
          raw.networkPrefs.serverPort >= 1 &&
          raw.networkPrefs.serverPort <= 65535
        ) {
          this.networkPrefs.serverPort = raw.networkPrefs.serverPort;
        }
        if (typeof raw.networkPrefs.hasSavedNetwork === 'boolean') {
          this.networkPrefs.hasSavedNetwork = raw.networkPrefs.hasSavedNetwork;
        }
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
            setupPromptDismissed: this.setupPromptDismissed,
            networkPrefs: this.networkPrefs,
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
    this.savePersistedConfig();
    return { ok: true };
  }

  private formatNetworkError(err: unknown): string {
    if (!(err instanceof Error)) return String(err || 'неизвестная сетевая ошибка');
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const code = (cause as Error & { code?: string }).code;
      return code ? `${code}: ${cause.message}` : cause.message;
    }
    const code = (err as Error & { code?: string }).code;
    return code ? `${code}: ${err.message}` : err.message;
  }

  private async downloadViaNodeHttp(
    url: string,
    destPath: string | null,
    family: 4 | 0,
    onProgress?: (received: number, total: number) => void,
    redirectDepth = 0
  ): Promise<Buffer> {
    if (redirectDepth > 6) {
      throw new Error('Слишком много HTTP-перенаправлений');
    }
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error(`Неподдерживаемый протокол: ${parsedUrl.protocol}`);
    }

    return new Promise<Buffer>((resolve, reject) => {
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const req = transport.get(
        parsedUrl,
        {
          family: family === 4 ? 4 : undefined,
          headers: {
            'User-Agent': 'NeoCraft-Control/1.0 (Linux/Windows)',
            Accept: '*/*',
          },
          timeout: 30_000,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            const nextUrl = new URL(res.headers.location, parsedUrl).toString();
            void this.downloadViaNodeHttp(nextUrl, destPath, family, onProgress, redirectDepth + 1)
              .then(resolve)
              .catch(reject);
            return;
          }

          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`HTTP ${status}`));
            return;
          }

          const totalBytes = Number(res.headers['content-length'] || 0);
          let received = 0;

          if (destPath) {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            const fileStream = fs.createWriteStream(destPath);
            fileStream.on('error', (err) => {
              res.destroy();
              reject(err);
            });
            res.on('data', (chunk: Buffer) => {
              received += chunk.byteLength;
              onProgress?.(received, totalBytes);
            });
            res.on('error', (err) => {
              fileStream.destroy();
              reject(err);
            });
            fileStream.on('finish', () => {
              resolve(Buffer.alloc(0));
            });
            res.pipe(fileStream);
          } else {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
              received += chunk.byteLength;
              onProgress?.(received, totalBytes);
            });
            res.on('error', reject);
            res.on('end', () => resolve(Buffer.concat(chunks)));
          }
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error('ETIMEDOUT: превышено время ожидания ответа сервера'));
      });
      req.on('error', reject);
    });
  }

  private async downloadViaCliTool(url: string, destPath: string): Promise<void> {
    if (!url.startsWith('https://')) {
      throw new Error('Разрешены только HTTPS-ссылки');
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const runCli = (cmd: string, args: string[]) =>
      new Promise<void>((resolve, reject) => {
        let stderr = '';
        const proc = spawn(cmd, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
        proc.stderr.on('data', (c: Buffer) => {
          stderr += c.toString('utf8');
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
            resolve();
          } else {
            reject(new Error(`${cmd} завершился с кодом ${code ?? 1}${stderr.trim() ? `: ${stderr.trim().slice(-160)}` : ''}`));
          }
        });
      });

    try {
      await runCli('curl', [
        '-4',
        '-fsSL',
        '--retry',
        '2',
        '--connect-timeout',
        '20',
        '--max-time',
        '180',
        '-A',
        'NeoCraft-Control/1.0',
        '-o',
        destPath,
        url,
      ]);
      return;
    } catch {
      // Retry curl without -4 (for IPv6-only networks) before falling back to wget
      try {
        await runCli('curl', [
          '-fsSL',
          '--retry',
          '1',
          '--connect-timeout',
          '20',
          '--max-time',
          '180',
          '-A',
          'NeoCraft-Control/1.0',
          '-o',
          destPath,
          url,
        ]);
        return;
      } catch (curlErr) {
        if (process.platform === 'win32') {
          throw curlErr;
        }
        await runCli('wget', ['-q', '--tries=2', '--timeout=20', '-O', destPath, url]);
      }
    }
  }

  private async downloadUrlToFile(
    url: string,
    destPath: string,
    onProgress?: (received: number, total: number) => void
  ): Promise<void> {
    const errors: string[] = [];

    const cleanupPartial = () => {
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch {
        // ignore
      }
    };

    // 1. Node https.get forced IPv4 (fixes Linux undici fetch failed / broken IPv6 routing)
    try {
      cleanupPartial();
      await this.downloadViaNodeHttp(url, destPath, 4, onProgress);
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) return;
    } catch (err) {
      errors.push(`IPv4: ${this.formatNetworkError(err)}`);
    }

    // 2. Node https.get default IP family (IPv6 fallback)
    try {
      cleanupPartial();
      await this.downloadViaNodeHttp(url, destPath, 0, onProgress);
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) return;
    } catch (err) {
      errors.push(`HTTPS: ${this.formatNetworkError(err)}`);
    }

    // 3. System curl / wget fallback (respects Linux system CA store & HTTP_PROXY/HTTPS_PROXY)
    try {
      cleanupPartial();
      await this.downloadViaCliTool(url, destPath);
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) return;
    } catch (err) {
      errors.push(`CLI: ${this.formatNetworkError(err)}`);
    }

    cleanupPartial();
    throw new Error(errors.join(' | ') || 'сетевая ошибка загрузки');
  }

  private async downloadUrlToBuffer(url: string): Promise<Buffer> {
    const errors: string[] = [];

    try {
      const buf = await this.downloadViaNodeHttp(url, null, 4);
      if (buf.length > 0) return buf;
    } catch (err) {
      errors.push(`IPv4: ${this.formatNetworkError(err)}`);
    }

    try {
      const buf = await this.downloadViaNodeHttp(url, null, 0);
      if (buf.length > 0) return buf;
    } catch (err) {
      errors.push(`HTTPS: ${this.formatNetworkError(err)}`);
    }

    const tmpFile = path.join(os.tmpdir(), `neocraft-dl-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    try {
      await this.downloadViaCliTool(url, tmpFile);
      const buf = fs.readFileSync(tmpFile);
      if (buf.length > 0) return buf;
    } catch (err) {
      errors.push(`CLI: ${this.formatNetworkError(err)}`);
    } finally {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }

    throw new Error(errors.join(' | ') || 'сетевая ошибка загрузки');
  }

  private async downloadNeoForgeInstaller(): Promise<string> {
    const existing = this.findCachedInstaller();
    if (existing) {
      this.appendLog('SYSTEM', 'system', `Используется предзагруженный установщик NeoForge: ${existing}`);
      this.emitInstallProgress('Найден предзагруженный установщик NeoForge 21.1.267', 35);
      return existing;
    }

    fs.mkdirSync(this.installerCacheDir, { recursive: true });
    let lastErrorReason = '';

    const tryDownloadVersion = async (version: string): Promise<string | null> => {
      if (!/^21\.1\.\d+$/.test(version)) return null;
      const url = `${NEOFORGE_MAVEN_BASE}/${version}/neoforge-${version}-installer.jar`;
      const targetPath = path.join(this.installerCacheDir, `neoforge-${version}-installer.jar`);
      const tempPath = `${targetPath}.part`;

      this.appendLog('SYSTEM', 'system', `Загрузка официального установщика NeoForge ${version} с maven.neoforged.net...`);
      this.emitInstallProgress(`Загрузка neoforge-${version}-installer.jar...`, 12);

      let lastPct = 12;
      try {
        await this.downloadUrlToFile(url, tempPath, (received, totalBytes) => {
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
        });

        if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 100_000) {
          fs.renameSync(tempPath, targetPath);
          return targetPath;
        }
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return null;
      } catch (err) {
        lastErrorReason = this.formatNetworkError(err);
        this.appendLog(
          'WARN',
          'system',
          `Не удалось скачать NeoForge ${version}: ${lastErrorReason}`
        );
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {
          // ignore
        }
        return null;
      }
    };

    // 1. Try target NeoForge 21.1.267 first
    let downloaded = await tryDownloadVersion(NEOFORGE_LOADER_VERSION);

    // 2. Fallback to latest published 21.1.x from official maven-metadata.xml if 21.1.267 is unavailable
    if (!downloaded) {
      this.emitInstallProgress('Поиск актуальной сборки NeoForge 21.1.x в официальном Maven...', 10);
      try {
        const xmlBuf = await this.downloadUrlToBuffer(`${NEOFORGE_MAVEN_BASE}/maven-metadata.xml`);
        const xml = xmlBuf.toString('utf8');
        const matches = Array.from(xml.matchAll(/<version>(21\.1\.\d+)<\/version>/g)).map((m) => m[1]);
        const latest211 = matches.sort((a, b) => {
          const pa = Number(a.split('.')[2] || 0);
          const pb = Number(b.split('.')[2] || 0);
          return pb - pa;
        })[0];
        if (latest211 && latest211 !== NEOFORGE_LOADER_VERSION) {
          downloaded = await tryDownloadVersion(latest211);
        }
      } catch (err) {
        lastErrorReason = this.formatNetworkError(err);
        this.appendLog(
          'WARN',
          'system',
          `Не удалось получить maven-metadata.xml: ${lastErrorReason}`
        );
      }
    }

    if (!downloaded) {
      throw new Error(
        `Не удалось скачать установщик NeoForge 1.21.1 с maven.neoforged.net${lastErrorReason ? ` (${lastErrorReason})` : ''}. Проверьте доступ к интернету или положите neoforge-21.1.267-installer.jar в папку .minecraft.`
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
        if (this.networkPrefs.hasSavedNetwork) {
          this.saveNetworkProperties(this.networkPrefs.shareIp, this.networkPrefs.serverPort);
        }
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
          ['-Djava.net.preferIPv4Stack=true', '-Djava.awt.headless=true', '-jar', installerPath, '--installServer'],
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

    const visitedScanDirs = new Set<string>();
    const scanChildrenForJava = (baseDir: string, source: string, depth = 1) => {
      try {
        if (!baseDir || !fs.existsSync(baseDir)) return;
        const realBase = fs.realpathSync(baseDir);
        const dirKey = isWin ? realBase.toLowerCase() : realBase;
        if (visitedScanDirs.has(dirKey)) return;
        visitedScanDirs.add(dirKey);

        const directBin = path.join(baseDir, 'bin', exeName);
        if (fs.existsSync(directBin)) {
          addCandidate(directBin, source);
        }
        if (depth <= 0) return;
        for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
          const childPath = path.join(baseDir, entry.name);
          let isDir = entry.isDirectory();
          if (!isDir && entry.isSymbolicLink()) {
            try {
              isDir = fs.statSync(childPath).isDirectory();
            } catch {
              isDir = false;
            }
          }
          if (!isDir) continue;
          scanChildrenForJava(childPath, source, depth - 1);
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
        { dir: path.join(appData, '.tlauncher', 'jvms'), source: 'TLauncher JVM', depth: 3 },
        { dir: path.join(appData, '.minecraft', 'runtime'), source: 'Minecraft Runtime', depth: 4 },
      ];
      for (const root of winRoots) {
        scanChildrenForJava(root.dir, root.source, root.depth);
      }
    } else {
      const home = os.homedir();
      const linuxRoots: Array<{ dir: string; source: string; depth: number }> = [
        { dir: '/usr/lib/jvm', source: '/usr/lib/jvm', depth: 2 },
        { dir: '/usr/java', source: '/usr/java', depth: 2 },
        { dir: '/opt/java', source: '/opt/java', depth: 2 },
        { dir: path.join(home, '.local', 'share', 'mise', 'installs', 'java'), source: 'mise Java', depth: 3 },
        { dir: path.join(home, '.asdf', 'installs', 'java'), source: 'asdf Java', depth: 3 },
        { dir: path.join(home, '.sdkman', 'candidates', 'java'), source: 'SDKMAN', depth: 2 },
        { dir: path.join(home, '.jdks'), source: 'User JDKs', depth: 2 },
        { dir: path.join(home, '.tlauncher', 'jvms'), source: 'TLauncher JVM', depth: 3 },
        { dir: path.join(home, '.minecraft', 'runtime'), source: 'Minecraft Runtime', depth: 4 },
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
    if (mode === 'native') {
      this.loadPersistedConfig();
      this.config.mode = 'native';
      this.syncAutoDetectedCorePath();
    }
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
    const localIps = this.getLocalInterfaceIps();

    if (!fs.existsSync(propsPath)) {
      const rememberedIp = this.networkPrefs.hasSavedNetwork ? this.networkPrefs.shareIp : '';
      const rememberedPort = this.networkPrefs.hasSavedNetwork ? this.networkPrefs.serverPort : 25565;
      return {
        serverIp: rememberedIp,
        shareIp: rememberedIp,
        bindIp: this.networkPrefs.bindIp,
        serverPort: rememberedPort,
        propertiesPath: propsPath,
        fileExists: false,
        rawPreview: '# Файл server.properties еще не создан. Он будет создан автоматически при сохранении.',
        otherKeysCount: 0,
        localIps,
      };
    }

    const content = fs.readFileSync(propsPath, 'utf8');
    let fileServerIp = '';
    let serverPort = this.networkPrefs.hasSavedNetwork ? this.networkPrefs.serverPort : 25565;
    let otherKeysCount = 0;

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key === 'server-ip') {
        fileServerIp = val;
      } else if (key === 'server-port') {
        const parsed = Number.parseInt(val, 10);
        if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
          serverPort = parsed;
        }
      } else {
        otherKeysCount += 1;
      }
    }

    // If fileServerIp is empty (bound to 0.0.0.0) because user configured an external WAN IP,
    // keep exposing their saved shareIp so it never vanishes from the UI or "Copy for friends".
    const effectiveShareIp =
      fileServerIp || (this.networkPrefs.hasSavedNetwork ? this.networkPrefs.shareIp : '');

    return {
      serverIp: effectiveShareIp,
      shareIp: effectiveShareIp,
      bindIp: fileServerIp,
      serverPort,
      propertiesPath: propsPath,
      fileExists: true,
      rawPreview: content,
      otherKeysCount,
      localIps,
    };
  }

  private writeServerPropertiesIpPort(bindIp: string, port: number): void {
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
        return `server-ip=${bindIp}`;
      }
      if (key === 'server-port') {
        updatedPort = true;
        return `server-port=${port}`;
      }
      return line;
    });

    if (!updatedIp) nextLines.push(`server-ip=${bindIp}`);
    if (!updatedPort) nextLines.push(`server-port=${port}`);

    const finalContent = `${nextLines.join('\n').replace(/\n+$/, '')}\n`;
    fs.writeFileSync(propsPath, finalContent, 'utf8');
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

    // If user entered an external WAN/router IP not assigned to a local adapter,
    // persist it as shareIp (for UI + "Copy for friends") while writing server-ip= (0.0.0.0)
    // to server.properties so Minecraft binds cleanly without BindException!
    const isLocalBindable = this.isBindableLocalIp(ip);
    const bindIp = isLocalBindable ? ip : '';

    this.networkPrefs = {
      shareIp: ip,
      bindIp,
      serverPort: port,
      hasSavedNetwork: true,
    };
    this.savePersistedConfig();
    this.writeServerPropertiesIpPort(bindIp, port);

    if (!isLocalBindable && ip) {
      this.appendLog(
        'SYSTEM',
        'system',
        `Сохранено: адрес для друзей ${ip}:${port}, а в server.properties записан server-ip= (0.0.0.0) и server-port=${port} для запуска без BindException.`
      );
    } else {
      this.appendLog(
        'SYSTEM',
        'system',
        `Обновлен server.properties: server-ip=${bindIp || '(все интерфейсы)'}, server-port=${port}`
      );
    }

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
      this.cleanupStaleServerProcess();

      const safeServerDir = this.resolveSafePath(this.config.serverDir);
      let safeJarPath = this.resolveSafePath(this.config.jarFile);
      fs.mkdirSync(safeServerDir, { recursive: true });

      const createdEula = this.ensureEulaAccepted(safeServerDir);
      if (createdEula) {
        this.appendLog('SYSTEM', 'system', `Создан файл eula.txt (eula=true) в ${safeServerDir}`);
      } else {
        this.appendLog('SYSTEM', 'system', 'Проверка eula.txt пройдена (eula=true).');
      }

      // Preserve user's saved IP+Port permanently while ensuring server.properties has a bindable IP
      const netProps = this.readNetworkProperties();
      const fileBindIp = (netProps.bindIp ?? '').trim();
      if (!netProps.fileExists && this.networkPrefs.hasSavedNetwork) {
        this.writeServerPropertiesIpPort(this.networkPrefs.bindIp, this.networkPrefs.serverPort);
      } else if (fileBindIp && !this.isBindableLocalIp(fileBindIp)) {
        // Remember the user's external WAN IP in shareIp BEFORE setting server-ip= (0.0.0.0) in server.properties!
        this.networkPrefs = {
          shareIp: fileBindIp,
          bindIp: '',
          serverPort: netProps.serverPort,
          hasSavedNetwork: true,
        };
        this.savePersistedConfig();
        this.writeServerPropertiesIpPort('', netProps.serverPort);
        this.appendLog(
          'WARN',
          'system',
          `IP ${fileBindIp} сохранён как адрес для друзей (${fileBindIp}:${netProps.serverPort}), а server-ip переключён на 0.0.0.0 для запуска без BindException.`
        );
      } else if (this.networkPrefs.hasSavedNetwork && netProps.serverPort !== this.networkPrefs.serverPort) {
        this.writeServerPropertiesIpPort(this.networkPrefs.bindIp, this.networkPrefs.serverPort);
      }

      this.savePersistedConfig();

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
      if (child.pid) {
        const currentPort = this.readNetworkProperties().serverPort;
        this.writeActivePidFile(child.pid, currentPort, safeServerDir);
      }
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
        this.clearActivePidFile();
        this.appendLog('ERROR', 'system', `Ошибка запуска процесса: ${err.message}`);
        this.updateRuntimeStatus('error', err.message);
      });

      child.on('close', (code) => {
        const wasStopping = this.runtime.status === 'offline';
        this.childProc = null;
        this.runtime.pid = null;
        this.runtime.startedAt = null;
        this.clearActivePidFile();
        if (code === 0 || code === null || wasStopping) {
          this.appendLog('SYSTEM', 'system', `Процесс сервера остановлен и порт освобождён (код выхода: ${code ?? 0}).`);
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

  /**
   * Synchronous emergency cleanup for process exit / crashes / SIGINT / SIGTERM / Alt+F4.
   * Guarantees the Java server process tree is terminated and the port is immediately unbound.
   */
  public forceKillServerSync(): void {
    const pid = this.childProc?.pid ?? this.runtime.pid;
    if (pid) {
      this.killProcessTreeSync(pid);
    }
    if (this.childProc) {
      try {
        this.childProc.kill('SIGKILL');
      } catch {
        // ignore
      }
      this.childProc = null;
    }
    this.runtime.pid = null;
    this.runtime.startedAt = null;
    this.cleanupStaleServerProcess();
  }

  /**
   * Graceful shutdown with guaranteed force-kill fallback to ensure the server port is always released.
   */
  public async shutdownAndReleasePort(): Promise<void> {
    try {
      if (this.childProc) {
        await this.stopServer();
      }
    } finally {
      this.forceKillServerSync();
    }
  }

  public async stopServer(): Promise<{ ok: boolean; error?: string }> {
    const proc = this.childProc;
    if (!proc) {
      this.cleanupStaleServerProcess();
      this.updateRuntimeStatus('offline', null);
      return { ok: true };
    }

    const pid = proc.pid;
    this.appendLog('SYSTEM', 'system', 'Отправка команды остановки (stop) и освобождение порта...');

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        this.clearActivePidFile();
        resolve({ ok: true });
      };

      proc.once('close', finish);

      try {
        proc.stdin.write('stop\n');
      } catch {
        if (pid) this.killProcessTreeSync(pid);
        else proc.kill('SIGTERM');
      }

      const killTimer = setTimeout(() => {
        if (this.childProc === proc) {
          this.appendLog(
            'WARN',
            'system',
            'Превышено время ожидания остановки — принудительное завершение дерева процессов для освобождения порта.'
          );
          if (pid) {
            this.killProcessTreeSync(pid);
          } else {
            proc.kill('SIGKILL');
          }
          this.childProc = null;
          this.runtime.pid = null;
          this.runtime.startedAt = null;
          this.updateRuntimeStatus('offline', null);
        }
        finish();
      }, 4500);
    });
  }

  public async restartServer(): Promise<{ ok: boolean; error?: string }> {
    this.appendLog('SYSTEM', 'system', 'Перезапуск сервера...');
    await this.stopServer();
    await sleep(300);
    return this.startServer();
  }

  private createMinecraftOfflineUuid(exactName: string): string {
    const hash = crypto.createHash('md5').update(`OfflinePlayer:${exactName}`, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x30; // UUID v3
    hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = hash.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private isOfflineModeServer(serverDir: string): boolean {
    try {
      const propsPath = path.join(serverDir, 'server.properties');
      if (!fs.existsSync(propsPath)) return true;
      const content = fs.readFileSync(propsPath, 'utf8');
      return /^online-mode\s*=\s*false$/im.test(content);
    } catch {
      return true;
    }
  }

  private upsertUserCacheEntry(serverDir: string, exactName: string, uuid: string): void {
    try {
      const cachePath = path.join(serverDir, 'usercache.json');
      let entries: Array<{ name?: string; uuid?: string; expiresOn?: string }> = [];
      if (fs.existsSync(cachePath)) {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (Array.isArray(parsed)) entries = parsed;
      }
      const lower = exactName.toLowerCase();
      const filtered = entries.filter(
        (item) => typeof item?.name === 'string' && item.name.toLowerCase() !== lower
      );
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const expiresOn = `${expires.toISOString().slice(0, 19).replace('T', ' ')} +0000`;
      filtered.unshift({ name: exactName, uuid, expiresOn });
      fs.writeFileSync(cachePath, JSON.stringify(filtered, null, 2), 'utf8');
    } catch {
      // non-fatal
    }
  }

  private syncOfflinePlayerFile(
    serverDir: string,
    fileName: 'whitelist.json' | 'ops.json',
    action: 'add' | 'remove',
    exactName: string
  ): void {
    const filePath = path.join(serverDir, fileName);
    let entries: Array<Record<string, unknown>> = [];
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(parsed)) entries = parsed;
      } catch {
        entries = [];
      }
    }

    const lower = exactName.toLowerCase();
    const filtered = entries.filter(
      (item) => typeof item?.name !== 'string' || item.name.toLowerCase() !== lower
    );

    if (action === 'add') {
      const uuid = this.createMinecraftOfflineUuid(exactName);
      if (fileName === 'ops.json') {
        filtered.push({
          uuid,
          name: exactName,
          level: 4,
          bypassesPlayerLimit: false,
        });
      } else {
        filtered.push({
          uuid,
          name: exactName,
        });
      }
      this.upsertUserCacheEntry(serverDir, exactName, uuid);
    }

    fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), 'utf8');
    const players = this.readPlayersFromDisk(serverDir);
    this.runtime.players = players;
    this.emit('players-update', players);
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
      const safeServerDir = this.resolveSafePath(this.config.serverDir);
      const offlineMode = this.isOfflineModeServer(safeServerDir);

      // In offline-mode (online-mode=false, TLauncher), Minecraft 1.21.1 lowercases unknown nicknames
      // via GameProfileCache and generates the WRONG lowercase OfflinePlayer UUID, blocking caps nicknames.
      // Handle whitelist & op commands with exact-case OfflinePlayer UUID v3 and reload cleanly!
      const wlAddMatch = command.match(/^whitelist\s+add\s+([A-Za-z0-9_]{3,16})$/i);
      const wlRemoveMatch = command.match(/^whitelist\s+remove\s+([A-Za-z0-9_]{3,16})$/i);
      const opMatch = command.match(/^op\s+([A-Za-z0-9_]{3,16})$/i);
      const deopMatch = command.match(/^deop\s+([A-Za-z0-9_]{3,16})$/i);

      if (offlineMode && wlAddMatch) {
        const exactName = wlAddMatch[1];
        this.syncOfflinePlayerFile(safeServerDir, 'whitelist.json', 'add', exactName);
        this.childProc.stdin.write('whitelist reload\n');
        this.appendLog(
          'SYSTEM',
          'system',
          `Игрок ${exactName} добавлен в whitelist.json с сохранением регистра (Offline UUID) и список перезагружен.`
        );
        return { ok: true };
      }

      if (offlineMode && wlRemoveMatch) {
        const exactName = wlRemoveMatch[1];
        this.syncOfflinePlayerFile(safeServerDir, 'whitelist.json', 'remove', exactName);
        this.childProc.stdin.write('whitelist reload\n');
        this.appendLog(
          'SYSTEM',
          'system',
          `Игрок ${exactName} удалён из whitelist.json и список перезагружен.`
        );
        return { ok: true };
      }

      if (offlineMode && opMatch) {
        const exactName = opMatch[1];
        // Pre-seed exact-case usercache + ops.json, run live op command for online player,
        // and verify exact-case entry after Minecraft flushes ops.json
        this.syncOfflinePlayerFile(safeServerDir, 'ops.json', 'add', exactName);
        this.childProc.stdin.write(`op ${exactName}\n`);
        setTimeout(() => {
          try {
            this.syncOfflinePlayerFile(safeServerDir, 'ops.json', 'add', exactName);
          } catch {
            // ignore
          }
        }, 450);
        return { ok: true };
      }

      if (offlineMode && deopMatch) {
        const exactName = deopMatch[1];
        this.childProc.stdin.write(`deop ${exactName}\n`);
        setTimeout(() => {
          try {
            this.syncOfflinePlayerFile(safeServerDir, 'ops.json', 'remove', exactName);
          } catch {
            // ignore
          }
        }, 450);
        return { ok: true };
      }

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
    if (overrideSourceDir && sourceDir !== this.config.modsSourceDir) {
      this.config.modsSourceDir = sourceDir;
      this.savePersistedConfig();
    }
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
      this.savePersistedConfig();
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
    this.savePersistedConfig();

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

      // Step 2: Install NeoForge 1.21.1 (21.1.267) via official installer in native mode
      this.emitClientStep(
        'neoforge',
        'running',
        `Подготовка установщика Minecraft ${NEOFORGE_MC_VERSION} / NeoForge ${NEOFORGE_LOADER_VERSION}...`
      );

      fs.mkdirSync(versionDir, { recursive: true });
      let installedOfficialDir: string | null = null;
      let installedLoaderVer = NEOFORGE_LOADER_VERSION;

      if (this.config.mode === 'native' && this.environment === 'electron') {
        // Ensure Java 21 is detected before invoking NeoForge installer
        this.detectJavaInstallations(true);
        const javaExe = this.javaDetection.selectedPath || this.config.javaPath;
        if (!javaExe || (!this.javaDetection.selectedPath && !fs.existsSync(javaExe))) {
          throw new Error(
            process.platform === 'linux'
              ? 'Java 21 не найдена в системе. На Arch/Omarchy выполните: sudo pacman -S jdk21-openjdk (или mise use -g java@temurin-21) и повторите попытку.'
              : 'Java 21 не найдена в системе. Установите Eclipse Temurin JDK 21 (adoptium.net) и повторите попытку.'
          );
        }

        // Locate existing or cached installer, or download automatically from maven.neoforged.net
        const localInstaller = path.join(
          minecraftDir,
          `neoforge-${NEOFORGE_LOADER_VERSION}-installer.jar`
        );
        let installerJar: string;
        if (fs.existsSync(localInstaller) && fs.statSync(localInstaller).size > 100_000) {
          installerJar = localInstaller;
        } else {
          this.emitClientStep(
            'neoforge',
            'running',
            'Загрузка официального установщика NeoForge 1.21.1 с maven.neoforged.net...'
          );
          installerJar = await this.downloadNeoForgeInstaller();
        }

        const verMatch = path.basename(installerJar).match(/neoforge-(21\.1\.\d+)-installer\.jar/i);
        if (verMatch?.[1]) {
          installedLoaderVer = verMatch[1];
        }

        // Official NeoForge --installClient requires launcher_profiles.json inside .minecraft
        // (TLauncher only maintains TLauncherProfiles.json by default)
        const vanillaProfilesPath = path.join(minecraftDir, 'launcher_profiles.json');
        if (!fs.existsSync(vanillaProfilesPath)) {
          fs.writeFileSync(
            vanillaProfilesPath,
            JSON.stringify(
              {
                profiles: {},
                selectedProfile: '',
                clientToken: 'neocraft-control',
              },
              null,
              2
            ),
            'utf8'
          );
        }

        const runClientInstaller = (flag: '--installClient' | '--install-client') =>
          new Promise<{ code: number; output: string }>((resolve, reject) => {
            let output = '';
            const installerProc = spawn(
              javaExe,
              ['-Djava.net.preferIPv4Stack=true', '-Djava.awt.headless=true', '-jar', installerJar, flag, minecraftDir],
              { cwd: minecraftDir, shell: false }
            );

            const handleLine = (chunk: Buffer) => {
              const text = chunk.toString('utf8');
              output += text;
              const lines = text
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean);
              const lastLine = lines[lines.length - 1];
              if (lastLine) {
                this.appendLog('INFO', 'stdout', `[NeoForge Client] ${lastLine}`);
                if (/Downloading|Patching|Building|Extracting|Successfully/i.test(lastLine)) {
                  this.emitClientStep('neoforge', 'running', lastLine.slice(0, 120));
                }
              }
            };

            installerProc.stdout.on('data', handleLine);
            installerProc.stderr.on('data', handleLine);
            installerProc.on('error', reject);
            installerProc.on('close', (code) => resolve({ code: code ?? 1, output }));
          });

        this.emitClientStep(
          'neoforge',
          'running',
          `Установка библиотек NeoForge ${installedLoaderVer} (--installClient)... Это займёт 1–2 минуты.`
        );
        this.appendLog(
          'SYSTEM',
          'system',
          `Запуск установки клиента NeoForge: "${javaExe}" -Djava.awt.headless=true -jar "${installerJar}" --installClient "${minecraftDir}"`
        );

        let installOutcome = await runClientInstaller('--installClient');
        if (
          installOutcome.code !== 0 &&
          /unrecognized|not a recognized option|unknown option/i.test(installOutcome.output)
        ) {
          installOutcome = await runClientInstaller('--install-client');
        }

        if (installOutcome.code !== 0) {
          const tail = installOutcome.output
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-3)
            .join(' | ');
          throw new Error(
            `Официальный инсталлятор NeoForge завершился с кодом ${installOutcome.code}${tail ? `: ${tail}` : ''}`
          );
        }

        installerUsed = true;

        // Locate the REAL version JSON generated by NeoForge installer (with all BootstrapLauncher & FML libraries!)
        const versionsRoot = path.join(minecraftDir, 'versions');
        const expectedOfficialName = `neoforge-${installedLoaderVer}`;
        let officialJsonPath = path.join(
          versionsRoot,
          expectedOfficialName,
          `${expectedOfficialName}.json`
        );

        if (!fs.existsSync(officialJsonPath) && fs.existsSync(versionsRoot)) {
          const candidates = fs
            .readdirSync(versionsRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory() && /^neoforge-21\.1\./i.test(e.name))
            .map((e) => e.name)
            .sort()
            .reverse();
          for (const dirName of candidates) {
            const p = path.join(versionsRoot, dirName, `${dirName}.json`);
            if (fs.existsSync(p)) {
              officialJsonPath = p;
              break;
            }
          }
        }

        if (!fs.existsSync(officialJsonPath)) {
          throw new Error(
            `Инсталлятор NeoForge завершился, но не создал профиль versions/${expectedOfficialName}/${expectedOfficialName}.json.`
          );
        }

        installedOfficialDir = path.dirname(officialJsonPath);
        const realManifest = JSON.parse(fs.readFileSync(officialJsonPath, 'utf8')) as Record<
          string,
          unknown
        >;

        // Verify ALL NeoForge libraries (especially bootstraplauncher & securejarhandler) exist on disk
        this.emitClientStep(
          'neoforge',
          'running',
          'Проверка и докачка библиотек NeoForge (BootstrapLauncher, SecureJarHandler, ASM)...'
        );
        const nfLibraries = Array.isArray(realManifest.libraries) ? realManifest.libraries : [];
        const libCheck = await this.ensureManifestLibrariesOnDisk(minecraftDir, nfLibraries);
        this.appendLog(
          'SYSTEM',
          'system',
          `Библиотеки NeoForge проверены: ${libCheck.verified} на диске, ${libCheck.downloaded} докачано. BootstrapLauncher: ${libCheck.bootstrapPath}`
        );

        // Fetch vanilla 1.21.1 manifest (local cache or Mojang piston-meta) so we can produce
        // a 100% standalone JSON without inheritsFrom (fixes TLauncher Linux/Windows inheritsFrom & classpath bugs!)
        this.emitClientStep(
          'neoforge',
          'running',
          `Сборка автономного профиля TLauncher (MC ${NEOFORGE_MC_VERSION} + NeoForge ${installedLoaderVer})...`
        );
        const vanillaManifest = await this.fetchVanillaVersionManifest(
          minecraftDir,
          NEOFORGE_MC_VERSION
        );

        const officialId =
          typeof realManifest.id === 'string' && realManifest.id.trim()
            ? realManifest.id.trim()
            : path.basename(officialJsonPath, '.json');

        // Build TLauncher-ready manifest with expanded ${library_directory}, ${classpath_separator}, ${version_name}
        // and merged vanilla 1.21.1 libraries/arguments/javaVersion
        const customManifest = this.buildTLauncherReadyNeoForgeManifest(
          realManifest,
          vanillaManifest,
          minecraftDir,
          buildName
        );
        fs.writeFileSync(versionJsonPath, JSON.stringify(customManifest, null, 2), 'utf8');

        // Also patch the official neoforge-21.1.x.json so launching either profile in TLauncher works cleanly
        if (path.resolve(officialJsonPath) !== path.resolve(versionJsonPath)) {
          const patchedOfficialManifest = this.buildTLauncherReadyNeoForgeManifest(
            realManifest,
            vanillaManifest,
            minecraftDir,
            officialId
          );
          fs.writeFileSync(
            officialJsonPath,
            JSON.stringify(patchedOfficialManifest, null, 2),
            'utf8'
          );
        }

        // Sync client version JAR if vanilla 1.21.1.jar (or official JAR) is already present locally
        const officialJarPath = officialJsonPath.replace(/\.json$/i, '.jar');
        const vanillaJarPath = path.join(
          versionsRoot,
          NEOFORGE_MC_VERSION,
          `${NEOFORGE_MC_VERSION}.jar`
        );
        const customJarPath = path.join(versionDir, `${buildName}.jar`);
        const sourceJarCandidate =
          fs.existsSync(officialJarPath) && fs.statSync(officialJarPath).size > 1_000_000
            ? officialJarPath
            : fs.existsSync(vanillaJarPath) && fs.statSync(vanillaJarPath).size > 1_000_000
              ? vanillaJarPath
              : null;

        if (sourceJarCandidate && path.resolve(sourceJarCandidate) !== path.resolve(customJarPath)) {
          fs.copyFileSync(sourceJarCandidate, customJarPath);
        } else if (fs.existsSync(customJarPath) && fs.statSync(customJarPath).size < 100_000) {
          // Remove any broken/empty stub JAR so TLauncher downloads the real 1.21.1 client JAR via downloads.client
          try {
            fs.unlinkSync(customJarPath);
          } catch {
            // ignore
          }
        }

        this.appendLog(
          'SYSTEM',
          'system',
          `Патч TLauncher применён (${vanillaManifest ? 'автономный профиль без inheritsFrom' : 'inheritsFrom + патч JVM'}): library_directory="${path.join(minecraftDir, 'libraries')}", разделитель="${path.delimiter}", javaVersion=21.`
        );
      } else {
        // Sandbox / Web-preview mode: create lightweight preview manifest
        await sleep(420);
        const sandboxManifest = {
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
              '--fml.mcVersion',
              NEOFORGE_MC_VERSION,
              '--launchTarget',
              'forgeclient',
            ],
          },
          libraries: [],
          tlauncher: {
            managedBy: 'NeoCraft Control',
            isolatedDirectory: true,
          },
        };
        fs.writeFileSync(versionJsonPath, JSON.stringify(sandboxManifest, null, 2), 'utf8');
      }

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
          ? `Установлены все библиотеки NeoForge ${installedLoaderVer} и профиль ${buildName}`
          : `Профиль ${buildName}.json создан (режим песочницы)`
      );

      // Step 3: Force-create BOTH .minecraft/mods AND .minecraft/versions/<BuildName>/mods BEFORE first launch
      this.emitClientStep(
        'init-mods',
        'running',
        'Принудительное создание корневой и изолированной папок mods...'
      );
      await sleep(300);
      fs.mkdirSync(rootModsDir, { recursive: true });
      fs.mkdirSync(isolatedModsDir, { recursive: true });
      const officialModsDir =
        installedOfficialDir && installedOfficialDir !== versionDir
          ? path.join(installedOfficialDir, 'mods')
          : null;
      if (officialModsDir) {
        fs.mkdirSync(officialModsDir, { recursive: true });
      }
      this.emitClientStep(
        'init-mods',
        'completed',
        `Созданы директории: ${rootModsDir} и ${isolatedModsDir}`
      );

      // Step 4: Copy all .jar mods from sourceDir into BOTH client mods directories
      this.emitClientStep('copy-mods', 'running', `Копирование .jar файлов из ${modsSourceDir}...`);
      await sleep(320);

      const safeCopyMod = (src: string, dst: string) => {
        if (path.resolve(src) === path.resolve(dst)) return;
        fs.copyFileSync(src, dst);
      };

      const copiedMods: string[] = [];
      if (fs.existsSync(modsSourceDir)) {
        for (const entry of fs.readdirSync(modsSourceDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
          const src = path.join(modsSourceDir, entry.name);
          safeCopyMod(src, path.join(rootModsDir, entry.name));
          safeCopyMod(src, path.join(isolatedModsDir, entry.name));
          if (officialModsDir) {
            safeCopyMod(src, path.join(officialModsDir, entry.name));
          }
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

  private async fetchVanillaVersionManifest(
    minecraftDir: string,
    mcVersion: string
  ): Promise<Record<string, unknown> | null> {
    const localVanillaDir = path.join(minecraftDir, 'versions', mcVersion);
    const localVanillaJson = path.join(localVanillaDir, `${mcVersion}.json`);

    if (fs.existsSync(localVanillaJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(localVanillaJson, 'utf8')) as Record<
          string,
          unknown
        >;
        if (
          Array.isArray(parsed.libraries) &&
          parsed.libraries.length > 0 &&
          typeof parsed.arguments === 'object' &&
          parsed.arguments !== null
        ) {
          return parsed;
        }
      } catch {
        // Ignore corrupted local cache and refetch below
      }
    }

    try {
      const metaBuf = await this.downloadUrlToBuffer(
        'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
      );
      const meta = JSON.parse(metaBuf.toString('utf8')) as {
        versions?: Array<{ id?: string; url?: string }>;
      };
      const entry = meta.versions?.find((v) => v.id === mcVersion && typeof v.url === 'string');
      if (!entry?.url || !entry.url.startsWith('https://')) {
        throw new Error(`Версия ${mcVersion} не найдена в version_manifest_v2.json`);
      }

      const verBuf = await this.downloadUrlToBuffer(entry.url);
      const vanillaJson = JSON.parse(verBuf.toString('utf8')) as Record<string, unknown>;
      fs.mkdirSync(localVanillaDir, { recursive: true });
      fs.writeFileSync(localVanillaJson, JSON.stringify(vanillaJson, null, 2), 'utf8');
      return vanillaJson;
    } catch (err) {
      this.appendLog(
        'WARN',
        'system',
        `Не удалось получить манифест Minecraft ${mcVersion} с piston-meta.mojang.com (${this.formatNetworkError(err)}). Будет использован режим inheritsFrom с патчем JVM.`
      );
      return null;
    }
  }

  private async ensureManifestLibrariesOnDisk(
    minecraftDir: string,
    libraries: unknown[]
  ): Promise<{ verified: number; downloaded: number; bootstrapPath: string }> {
    const librariesRoot = path.resolve(path.join(minecraftDir, 'libraries'));
    fs.mkdirSync(librariesRoot, { recursive: true });

    let verified = 0;
    let downloaded = 0;
    let bootstrapPath: string | null = null;

    for (const item of libraries) {
      if (typeof item !== 'object' || item === null) continue;
      const lib = item as {
        name?: string;
        downloads?: {
          artifact?: {
            path?: string;
            url?: string;
            size?: number;
          };
        };
      };
      const artifact = lib.downloads?.artifact;
      if (!artifact?.path || typeof artifact.path !== 'string') continue;

      const relPath = artifact.path.replace(/^[/\\]+/, '');
      const destPath = path.resolve(librariesRoot, relPath);
      if (destPath !== librariesRoot && !destPath.startsWith(librariesRoot + path.sep)) {
        continue;
      }

      const isBootstrap =
        relPath.toLowerCase().includes('bootstraplauncher') &&
        relPath.toLowerCase().endsWith('.jar');

      let existsOk = false;
      if (fs.existsSync(destPath)) {
        try {
          const stat = fs.statSync(destPath);
          existsOk = stat.isFile() && stat.size > 0 && (!artifact.size || stat.size === artifact.size);
        } catch {
          existsOk = false;
        }
      }

      if (existsOk) {
        verified++;
        if (isBootstrap) bootstrapPath = destPath;
        continue;
      }

      if (artifact.url && typeof artifact.url === 'string' && artifact.url.startsWith('https://')) {
        try {
          await this.downloadUrlToFile(artifact.url, destPath);
          if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
            downloaded++;
            if (isBootstrap) bootstrapPath = destPath;
          }
        } catch {
          // Will be caught below if critical bootstraplauncher is still missing
        }
      }
    }

    // Fallback scan for bootstraplauncher-*.jar on disk
    if (!bootstrapPath) {
      const bsRoot = path.join(librariesRoot, 'cpw', 'mods', 'bootstraplauncher');
      if (fs.existsSync(bsRoot)) {
        const stack = [bsRoot];
        while (stack.length > 0 && !bootstrapPath) {
          const dir = stack.pop()!;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              stack.push(full);
            } else if (
              entry.isFile() &&
              /^bootstraplauncher-.*\.jar$/i.test(entry.name) &&
              fs.statSync(full).size > 0
            ) {
              bootstrapPath = full;
              break;
            }
          }
        }
      }
    }

    if (!bootstrapPath || !fs.existsSync(bootstrapPath)) {
      throw new Error(
        'Критическая библиотека cpw/mods/bootstraplauncher не найдена на диске после установки NeoForge. Проверьте доступ к maven.neoforged.net и повторите попытку.'
      );
    }

    return { verified, downloaded, bootstrapPath };
  }

  private resolveArgPlaceholders(
    args: unknown[],
    replacements: Record<string, string>,
    targetVersionName: string
  ): unknown[] {
    const replaceStr = (raw: string): string => {
      let out = raw;
      for (const [token, value] of Object.entries(replacements)) {
        if (out.includes(token)) {
          out = out.split(token).join(value);
        }
      }
      if (out.startsWith('-DignoreList=')) {
        const prefix = '-DignoreList=';
        const existing = out
          .slice(prefix.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const required = ['client-extra', `${targetVersionName}.jar`, `${NEOFORGE_MC_VERSION}.jar`];
        for (const item of required) {
          if (!existing.includes(item)) {
            existing.push(item);
          }
        }
        out = `${prefix}${existing.join(',')}`;
      }
      return out;
    };

    return args.map((entry) => {
      if (typeof entry === 'string') {
        return replaceStr(entry);
      }
      if (typeof entry === 'object' && entry !== null) {
        const obj = entry as Record<string, unknown>;
        if (typeof obj.value === 'string') {
          return { ...obj, value: replaceStr(obj.value) };
        }
        if (Array.isArray(obj.value)) {
          return {
            ...obj,
            value: obj.value.map((v) => (typeof v === 'string' ? replaceStr(v) : v)),
          };
        }
      }
      return entry;
    });
  }

  private buildTLauncherReadyNeoForgeManifest(
    neoforgeManifest: Record<string, unknown>,
    vanillaManifest: Record<string, unknown> | null,
    minecraftDir: string,
    targetId: string
  ): Record<string, unknown> {
    const librariesDir = path.join(minecraftDir, 'libraries');
    const replacements: Record<string, string> = {
      '${library_directory}': librariesDir,
      '${classpath_separator}': path.delimiter,
      '${version_name}': targetId,
    };

    const nfArguments =
      typeof neoforgeManifest.arguments === 'object' && neoforgeManifest.arguments !== null
        ? (neoforgeManifest.arguments as { game?: unknown[]; jvm?: unknown[] })
        : {};
    const nfGameArgs = Array.isArray(nfArguments.game)
      ? this.resolveArgPlaceholders(nfArguments.game, replacements, targetId)
      : [];
    const nfJvmArgs = Array.isArray(nfArguments.jvm)
      ? this.resolveArgPlaceholders(nfArguments.jvm, replacements, targetId)
      : [];
    const nfLibraries = Array.isArray(neoforgeManifest.libraries) ? neoforgeManifest.libraries : [];

    const defaultJavaVersion = {
      component: 'java-runtime-delta',
      majorVersion: 21,
    };

    if (!vanillaManifest) {
      return {
        ...neoforgeManifest,
        id: targetId,
        javaVersion: neoforgeManifest.javaVersion ?? defaultJavaVersion,
        arguments: {
          ...nfArguments,
          game: nfGameArgs,
          jvm: nfJvmArgs,
        },
        libraries: nfLibraries,
      };
    }

    const vanillaArguments =
      typeof vanillaManifest.arguments === 'object' && vanillaManifest.arguments !== null
        ? (vanillaManifest.arguments as { game?: unknown[]; jvm?: unknown[] })
        : {};
    const vanillaGameArgs = Array.isArray(vanillaArguments.game) ? vanillaArguments.game : [];
    const vanillaJvmArgs = Array.isArray(vanillaArguments.jvm) ? vanillaArguments.jvm : [];
    const vanillaLibraries = Array.isArray(vanillaManifest.libraries)
      ? vanillaManifest.libraries
      : [];

    // Deduplicate libraries by Maven group:artifact[:classifier], prioritizing NeoForge's entries first
    const getLibraryCoordKey = (lib: unknown): string | null => {
      if (typeof lib !== 'object' || lib === null) return null;
      const name = (lib as { name?: unknown }).name;
      if (typeof name !== 'string' || !name.includes(':')) return null;
      const parts = name.split(':');
      if (parts.length >= 4) {
        return `${parts[0]}:${parts[1]}:${parts[3]}`;
      }
      return `${parts[0]}:${parts[1]}`;
    };

    const seenKeys = new Set<string>();
    const mergedLibraries: unknown[] = [];

    for (const lib of nfLibraries) {
      const key = getLibraryCoordKey(lib);
      if (key) seenKeys.add(key);
      mergedLibraries.push(lib);
    }
    for (const lib of vanillaLibraries) {
      const key = getLibraryCoordKey(lib);
      // Keep vanilla libraries with OS rules (LWJGL natives) even if coordinates overlap
      const hasRules =
        typeof lib === 'object' &&
        lib !== null &&
        Array.isArray((lib as { rules?: unknown }).rules);
      if (!hasRules && key && seenKeys.has(key)) {
        continue;
      }
      if (key && !hasRules) seenKeys.add(key);
      mergedLibraries.push(lib);
    }

    // Place resolved NeoForge JVM flags (module path -p, -DlibraryDirectory, --add-modules, --add-opens)
    // right before "-cp ${classpath}" so every launcher (including TLauncher on Linux) parses both cleanly
    const vanillaJvmBeforeCp: unknown[] = [];
    for (let i = 0; i < vanillaJvmArgs.length; i++) {
      if (vanillaJvmArgs[i] === '-cp' && vanillaJvmArgs[i + 1] === '${classpath}') {
        i++;
        continue;
      }
      vanillaJvmBeforeCp.push(vanillaJvmArgs[i]);
    }

    const mergedJvmArgs: unknown[] = [
      ...vanillaJvmBeforeCp,
      ...nfJvmArgs,
      '-cp',
      '${classpath}',
    ];

    const mergedGameArgs: unknown[] = [...vanillaGameArgs, ...nfGameArgs];

    return {
      id: targetId,
      type: neoforgeManifest.type ?? vanillaManifest.type ?? 'release',
      time: neoforgeManifest.time ?? vanillaManifest.time ?? new Date().toISOString(),
      releaseTime:
        neoforgeManifest.releaseTime ?? vanillaManifest.releaseTime ?? new Date().toISOString(),
      mainClass: neoforgeManifest.mainClass ?? 'cpw.mods.bootstraplauncher.BootstrapLauncher',
      minimumLauncherVersion: vanillaManifest.minimumLauncherVersion ?? 21,
      complianceLevel: vanillaManifest.complianceLevel ?? 1,
      assets: vanillaManifest.assets,
      assetIndex: vanillaManifest.assetIndex,
      downloads: vanillaManifest.downloads,
      logging: vanillaManifest.logging,
      javaVersion: vanillaManifest.javaVersion ?? defaultJavaVersion,
      arguments: {
        game: mergedGameArgs,
        jvm: mergedJvmArgs,
      },
      libraries: mergedLibraries,
    };
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
