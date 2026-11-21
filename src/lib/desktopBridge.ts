import type {
  AppFullState,
  ClientDetectionResult,
  ClientSetupResult,
  ClientSetupStep,
  CopyModsResult,
  DesktopAPI,
  FsBrowseResult,
  JavaDetectionResult,
  LogEntry,
  ModsState,
  NetworkSettings,
  PlayerLists,
  ServerConfig,
  ServerCoreStatus,
  ServerRuntimeState,
  WorkspaceMode,
} from '../../shared/types';

declare global {
  interface Window {
    electronAPI?: DesktopAPI;
  }
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Ошибка запроса (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

class WebEventBus {
  private source: EventSource | null = null;
  private listeners = new Map<string, Set<(payload: unknown) => void>>();

  private ensureConnected(): void {
    if (this.source) return;
    const es = new EventSource('/api/events');
    this.source = es;

    const eventNames = [
      'server-status',
      'server-log',
      'players-update',
      'client-setup-progress',
      'server-install-progress',
    ];

    for (const name of eventNames) {
      es.addEventListener(name, (evt) => {
        const msgEvent = evt as MessageEvent<string>;
        try {
          const parsed = JSON.parse(msgEvent.data) as unknown;
          const set = this.listeners.get(name);
          if (set) {
            for (const cb of set) cb(parsed);
          }
        } catch {
          // ignore malformed SSE payload
        }
      });
    }

    es.onerror = () => {
      // Browser EventSource automatically reconnects
    };
  }

  public on<T>(eventName: string, cb: (payload: T) => void): () => void {
    this.ensureConnected();
    let set = this.listeners.get(eventName);
    if (!set) {
      set = new Set();
      this.listeners.set(eventName, set);
    }
    const wrapped = cb as (payload: unknown) => void;
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }
}

const webEventBus = new WebEventBus();

const webPreviewApi: DesktopAPI = {
  isElectron: false,
  getState: () => apiJson<AppFullState>('/api/state'),
  setWorkspaceMode: (mode: WorkspaceMode) =>
    apiJson<AppFullState>('/api/mode', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  updateServerConfig: (patch: Partial<ServerConfig>) =>
    apiJson<AppFullState>('/api/server/config', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  initializeServer: (serverDir?: string) =>
    apiJson<{ ok: boolean; state?: AppFullState; error?: string }>('/api/server/initialize', {
      method: 'POST',
      body: JSON.stringify({ serverDir }),
    }),
  dismissInitialSetup: () =>
    apiJson<{ ok: boolean }>('/api/server/dismiss-setup', { method: 'POST' }),
  startServer: () =>
    apiJson<{ ok: boolean; error?: string }>('/api/server/start', { method: 'POST' }),
  stopServer: () =>
    apiJson<{ ok: boolean; error?: string }>('/api/server/stop', { method: 'POST' }),
  restartServer: () =>
    apiJson<{ ok: boolean; error?: string }>('/api/server/restart', { method: 'POST' }),
  sendCommand: (command: string) =>
    apiJson<{ ok: boolean; error?: string }>('/api/server/command', {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
  clearLogs: () =>
    apiJson<{ ok: boolean }>('/api/server/clear-logs', { method: 'POST' }),
  readNetworkProperties: () => apiJson<NetworkSettings>('/api/network/properties'),
  saveNetworkProperties: (serverIp: string, serverPort: number) =>
    apiJson<NetworkSettings>('/api/network/properties', {
      method: 'POST',
      body: JSON.stringify({ serverIp, serverPort }),
    }),
  scanMods: (sourceDir?: string) => {
    const query = sourceDir ? `?sourceDir=${encodeURIComponent(sourceDir)}` : '';
    return apiJson<ModsState>(`/api/mods/scan${query}`);
  },
  copyModsToServer: (sourceDir?: string) =>
    apiJson<{ result: CopyModsResult; mods: ModsState }>('/api/mods/copy', {
      method: 'POST',
      body: JSON.stringify({ sourceDir }),
    }),
  deleteServerMod: (fileName: string) =>
    apiJson<ModsState>(`/api/mods/server/${encodeURIComponent(fileName)}`, {
      method: 'DELETE',
    }),
  detectJava: () => apiJson<JavaDetectionResult>('/api/java/detect'),
  detectTLauncher: () => apiJson<ClientDetectionResult>('/api/client/detect'),
  setupNeoForgeClient: (options) =>
    apiJson<ClientSetupResult>('/api/client/setup', {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  selectDirectoryNative: async () => null,
  selectFileNative: async () => null,
  browseDirectory: (targetPath?: string) => {
    const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : '';
    return apiJson<FsBrowseResult>(`/api/fs/browse${query}`);
  },

  onServerStatus: (cb) => webEventBus.on<ServerRuntimeState>('server-status', cb),
  onServerLog: (cb) => webEventBus.on<LogEntry>('server-log', cb),
  onPlayersUpdate: (cb) => webEventBus.on<PlayerLists>('players-update', cb),
  onClientSetupProgress: (cb) =>
    webEventBus.on<ClientSetupStep[]>('client-setup-progress', cb),
  onServerInstallProgress: (cb) =>
    webEventBus.on<ServerCoreStatus>('server-install-progress', cb),
};

export const desktopApi: DesktopAPI =
  typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : webPreviewApi;
