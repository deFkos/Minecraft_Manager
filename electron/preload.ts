import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  type AppFullState,
  type ClientDetectionResult,
  type ClientSetupResult,
  type ClientSetupStep,
  type CopyModsResult,
  type DesktopAPI,
  type FsBrowseResult,
  type JavaDetectionResult,
  type LogEntry,
  type ModsState,
  type NetworkSettings,
  type PlayerLists,
  type ServerConfig,
  type ServerCoreStatus,
  type ServerRuntimeState,
  type WorkspaceMode,
} from '../shared/types.ts';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: unknown) => cb(payload as T);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const electronAPI: DesktopAPI = {
  isElectron: true,
  getState: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_STATE) as Promise<AppFullState>,
  setWorkspaceMode: (mode: WorkspaceMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_SET_MODE, mode) as Promise<AppFullState>,
  updateServerConfig: (patch: Partial<ServerConfig>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVER_UPDATE_CONFIG, patch) as Promise<AppFullState>,
  initializeServer: (serverDir?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVER_INITIALIZE, serverDir) as Promise<{
      ok: boolean;
      state?: AppFullState;
      error?: string;
    }>,
  dismissInitialSetup: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVER_DISMISS_SETUP) as Promise<{ ok: boolean }>,
  startServer: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVER_START) as Promise<{ ok: boolean; error?: string }>,
  stopServer: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVER_STOP) as Promise<{ ok: boolean; error?: string }>,
  restartServer: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVER_RESTART) as Promise<{ ok: boolean; error?: string }>,
  sendCommand: (command: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SERVER_SEND_COMMAND, command) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  clearLogs: () => ipcRenderer.invoke(IPC_CHANNELS.SERVER_CLEAR_LOGS) as Promise<{ ok: boolean }>,
  readNetworkProperties: () =>
    ipcRenderer.invoke(IPC_CHANNELS.NETWORK_READ_PROPERTIES) as Promise<NetworkSettings>,
  saveNetworkProperties: (serverIp: string, serverPort: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.NETWORK_SAVE_PROPERTIES, {
      serverIp,
      serverPort,
    }) as Promise<NetworkSettings>,
  scanMods: (sourceDir?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MODS_SCAN, sourceDir) as Promise<ModsState>,
  copyModsToServer: (sourceDir?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MODS_COPY_TO_SERVER, sourceDir) as Promise<{
      result: CopyModsResult;
      mods: ModsState;
    }>,
  deleteServerMod: (fileName: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MODS_DELETE_SERVER_MOD, fileName) as Promise<ModsState>,
  detectJava: () =>
    ipcRenderer.invoke(IPC_CHANNELS.JAVA_DETECT) as Promise<JavaDetectionResult>,
  detectTLauncher: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CLIENT_DETECT_TLAUNCHER) as Promise<ClientDetectionResult>,
  setupNeoForgeClient: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.CLIENT_SETUP_NEOFORGE, options) as Promise<ClientSetupResult>,
  selectDirectoryNative: (title?: string, defaultPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, {
      title,
      defaultPath,
    }) as Promise<string | null>,
  selectFileNative: (title?: string, defaultPath?: string, extensions?: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FILE, {
      title,
      defaultPath,
      extensions,
    }) as Promise<string | null>,
  browseDirectory: (targetPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FS_BROWSE, targetPath) as Promise<FsBrowseResult>,
  windowAction: (action: 'minimize' | 'maximize' | 'close') => {
    if (action === 'minimize') ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE);
    if (action === 'maximize') ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE);
    if (action === 'close') ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE);
  },

  onServerStatus: (cb) => subscribe<ServerRuntimeState>(IPC_CHANNELS.EVENT_SERVER_STATUS, cb),
  onServerLog: (cb) => subscribe<LogEntry>(IPC_CHANNELS.EVENT_SERVER_LOG, cb),
  onPlayersUpdate: (cb) => subscribe<PlayerLists>(IPC_CHANNELS.EVENT_PLAYERS_UPDATE, cb),
  onClientSetupProgress: (cb) =>
    subscribe<ClientSetupStep[]>(IPC_CHANNELS.EVENT_CLIENT_SETUP_PROGRESS, cb),
  onServerInstallProgress: (cb) =>
    subscribe<ServerCoreStatus>(IPC_CHANNELS.EVENT_SERVER_INSTALL_PROGRESS, cb),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
