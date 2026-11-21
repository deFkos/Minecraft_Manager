export type ServerStatus = 'offline' | 'starting' | 'online' | 'error';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SYSTEM' | 'CMD';

export type RuntimeEnvironment = 'electron' | 'web-preview';

export type WorkspaceMode = 'sandbox' | 'native';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: 'stdout' | 'stderr' | 'system' | 'stdin';
  message: string;
}

export interface ServerConfig {
  serverDir: string;
  jarFile: string;
  javaPath: string;
  xmsMb: number;
  xmxMb: number;
  modsSourceDir: string;
  minecraftDir: string;
  clientBuildName: string;
  mode: WorkspaceMode;
}

export interface NetworkSettings {
  serverIp: string;
  serverPort: number;
  propertiesPath: string;
  fileExists: boolean;
  rawPreview: string;
  otherKeysCount: number;
  localIps?: string[];
}

export interface ModFileInfo {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  syncedToServer: boolean;
  sizeMatchesServer: boolean;
}

export interface ModsState {
  sourceDir: string;
  serverModsDir: string;
  sourceMods: ModFileInfo[];
  serverMods: ModFileInfo[];
}

export interface CopyModsResult {
  copiedCount: number;
  skippedCount: number;
  targetDir: string;
  copiedFiles: string[];
}

export type SetupStepId =
  | 'detect'
  | 'neoforge'
  | 'init-mods'
  | 'copy-mods'
  | 'done';

export type SetupStepStatus = 'idle' | 'running' | 'completed' | 'error';

export interface ClientSetupStep {
  id: SetupStepId;
  title: string;
  description: string;
  status: SetupStepStatus;
  detail?: string;
}

export interface ClientDetectionResult {
  platform: 'win32' | 'linux' | 'darwin' | string;
  platformLabel: string;
  detectedPath: string;
  exists: boolean;
  tlauncherProfilesFound: boolean;
  mode: WorkspaceMode;
}

export interface ClientSetupResult {
  success: boolean;
  buildName: string;
  minecraftDir: string;
  versionDir: string;
  rootModsDir: string;
  isolatedModsDir: string;
  versionJsonPath: string;
  copiedModsCount: number;
  copiedMods: string[];
  installerUsed: boolean;
  error?: string;
}

export interface PlayerLists {
  whitelist: string[];
  ops: string[];
  onlinePlayers: string[];
}

export interface ServerRuntimeState {
  status: ServerStatus;
  pid: number | null;
  startedAt: string | null;
  eulaAccepted: boolean;
  executionEngine: 'java' | 'sandbox-runner' | null;
  lastError: string | null;
  players: PlayerLists;
}

export interface JavaInstallation {
  path: string;
  version: string;
  majorVersion: number;
  vendor: string;
  source: string;
  isRecommended: boolean;
}

export interface JavaDetectionResult {
  installations: JavaInstallation[];
  selectedPath: string | null;
  hasCompatible21: boolean;
  detectedAt: string;
}

export interface ServerCoreStatus {
  initialized: boolean;
  needsInitialSetup: boolean;
  coreDetected: boolean;
  coreType: 'neoforge-args' | 'jar' | 'sandbox' | 'missing';
  coreLabel: string;
  corePath: string | null;
  cachedInstallerPath: string | null;
  installing: boolean;
  installStage: string | null;
  installPercent: number;
  installError: string | null;
}

export interface AppFullState {
  environment: RuntimeEnvironment;
  platform: string;
  sandboxRoot: string;
  config: ServerConfig;
  network: NetworkSettings;
  runtime: ServerRuntimeState;
  logs: LogEntry[];
  mods: ModsState;
  javaDetection: JavaDetectionResult;
  serverCore: ServerCoreStatus;
  clientDetection: ClientDetectionResult;
  clientSteps: ClientSetupStep[];
  lastClientSetup: ClientSetupResult | null;
}

export interface FsBrowseEntry {
  name: string;
  fullPath: string;
  isDirectory: boolean;
  sizeBytes?: number;
}

export interface FsBrowseResult {
  currentPath: string;
  parentPath: string | null;
  rootPath: string;
  entries: FsBrowseEntry[];
}

export const IPC_CHANNELS = {
  // Request / Response (invoke)
  APP_GET_STATE: 'app:get-state',
  APP_SET_MODE: 'app:set-mode',
  SERVER_UPDATE_CONFIG: 'server:update-config',
  SERVER_INITIALIZE: 'server:initialize',
  SERVER_DISMISS_SETUP: 'server:dismiss-setup',
  SERVER_START: 'server:start',
  SERVER_STOP: 'server:stop',
  SERVER_RESTART: 'server:restart',
  SERVER_SEND_COMMAND: 'server:send-command',
  SERVER_CLEAR_LOGS: 'server:clear-logs',
  NETWORK_READ_PROPERTIES: 'network:read-properties',
  NETWORK_SAVE_PROPERTIES: 'network:save-properties',
  MODS_SCAN: 'mods:scan-folder',
  MODS_COPY_TO_SERVER: 'mods:copy-to-server',
  MODS_DELETE_SERVER_MOD: 'mods:delete-server-mod',
  JAVA_DETECT: 'java:detect',
  CLIENT_DETECT_TLAUNCHER: 'client:detect-tlauncher',
  CLIENT_SETUP_NEOFORGE: 'client:setup-neoforge',
  DIALOG_SELECT_DIRECTORY: 'dialog:select-directory',
  DIALOG_SELECT_FILE: 'dialog:select-file',
  FS_BROWSE: 'fs:browse',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',

  // Real-Time Push Events (Main -> Renderer / SSE -> Browser)
  EVENT_SERVER_STATUS: 'event:server-status',
  EVENT_SERVER_LOG: 'event:server-log',
  EVENT_PLAYERS_UPDATE: 'event:players-update',
  EVENT_CLIENT_SETUP_PROGRESS: 'event:client-setup-progress',
  EVENT_SERVER_INSTALL_PROGRESS: 'event:server-install-progress',
} as const;

export interface DesktopAPI {
  isElectron: boolean;
  getState(): Promise<AppFullState>;
  setWorkspaceMode(mode: WorkspaceMode): Promise<AppFullState>;
  updateServerConfig(patch: Partial<ServerConfig>): Promise<AppFullState>;
  initializeServer(serverDir?: string): Promise<{ ok: boolean; state?: AppFullState; error?: string }>;
  dismissInitialSetup(): Promise<{ ok: boolean }>;
  startServer(): Promise<{ ok: boolean; error?: string }>;
  stopServer(): Promise<{ ok: boolean; error?: string }>;
  restartServer(): Promise<{ ok: boolean; error?: string }>;
  sendCommand(command: string): Promise<{ ok: boolean; error?: string }>;
  clearLogs(): Promise<{ ok: boolean }>;
  readNetworkProperties(): Promise<NetworkSettings>;
  saveNetworkProperties(serverIp: string, serverPort: number): Promise<NetworkSettings>;
  scanMods(sourceDir?: string): Promise<ModsState>;
  copyModsToServer(sourceDir?: string): Promise<{ result: CopyModsResult; mods: ModsState }>;
  deleteServerMod(fileName: string): Promise<ModsState>;
  detectJava(): Promise<JavaDetectionResult>;
  detectTLauncher(): Promise<ClientDetectionResult>;
  setupNeoForgeClient(options: {
    minecraftDir: string;
    buildName: string;
    modsSourceDir: string;
  }): Promise<ClientSetupResult>;
  selectDirectoryNative(title?: string, defaultPath?: string): Promise<string | null>;
  selectFileNative(title?: string, defaultPath?: string, extensions?: string[]): Promise<string | null>;
  browseDirectory(targetPath?: string): Promise<FsBrowseResult>;
  windowAction?(action: 'minimize' | 'maximize' | 'close'): void;

  onServerStatus(cb: (runtime: ServerRuntimeState) => void): () => void;
  onServerLog(cb: (entry: LogEntry) => void): () => void;
  onPlayersUpdate(cb: (players: PlayerLists) => void): () => void;
  onClientSetupProgress(cb: (steps: ClientSetupStep[]) => void): () => void;
  onServerInstallProgress(cb: (status: ServerCoreStatus) => void): () => void;
}
