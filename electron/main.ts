import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreBackendService } from '../backend/coreService.ts';
import {
  IPC_CHANNELS,
  type ClientSetupStep,
  type LogEntry,
  type PlayerLists,
  type ServerConfig,
  type ServerCoreStatus,
  type ServerRuntimeState,
  type WorkspaceMode,
} from '../shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let coreService: CoreBackendService | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0B1120',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl && !app.isPackaged) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function registerIpcHandlers(service: CoreBackendService): void {
  // Real-time event forwarding from CoreBackendService -> Renderer
  service.on('server-status', (runtime: ServerRuntimeState) => {
    sendToRenderer(IPC_CHANNELS.EVENT_SERVER_STATUS, runtime);
  });
  service.on('server-log', (entry: LogEntry) => {
    sendToRenderer(IPC_CHANNELS.EVENT_SERVER_LOG, entry);
  });
  service.on('players-update', (players: PlayerLists) => {
    sendToRenderer(IPC_CHANNELS.EVENT_PLAYERS_UPDATE, players);
  });
  service.on('client-setup-progress', (steps: ClientSetupStep[]) => {
    sendToRenderer(IPC_CHANNELS.EVENT_CLIENT_SETUP_PROGRESS, steps);
  });
  service.on('server-install-progress', (status: ServerCoreStatus) => {
    sendToRenderer(IPC_CHANNELS.EVENT_SERVER_INSTALL_PROGRESS, status);
  });

  // Request/Response IPC handlers
  ipcMain.handle(IPC_CHANNELS.APP_GET_STATE, () => service.getFullState());
  ipcMain.handle(IPC_CHANNELS.APP_SET_MODE, (_e, mode: unknown) =>
    service.setWorkspaceMode(mode as WorkspaceMode)
  );
  ipcMain.handle(IPC_CHANNELS.SERVER_UPDATE_CONFIG, (_e, patch: unknown) =>
    service.updateServerConfig(patch as Partial<ServerConfig>)
  );
  ipcMain.handle(IPC_CHANNELS.SERVER_INITIALIZE, (_e, serverDir: unknown) =>
    service.initializeServer(typeof serverDir === 'string' ? serverDir : undefined)
  );
  ipcMain.handle(IPC_CHANNELS.SERVER_DISMISS_SETUP, () => service.dismissInitialSetup());
  ipcMain.handle(IPC_CHANNELS.SERVER_START, () => service.startServer());
  ipcMain.handle(IPC_CHANNELS.SERVER_STOP, () => service.stopServer());
  ipcMain.handle(IPC_CHANNELS.SERVER_RESTART, () => service.restartServer());
  ipcMain.handle(IPC_CHANNELS.SERVER_SEND_COMMAND, (_e, command: unknown) =>
    service.sendCommand(String(command ?? ''))
  );
  ipcMain.handle(IPC_CHANNELS.SERVER_CLEAR_LOGS, () => {
    service.clearLogs();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.NETWORK_READ_PROPERTIES, () => service.readNetworkProperties());
  ipcMain.handle(
    IPC_CHANNELS.NETWORK_SAVE_PROPERTIES,
    (_e, payload: unknown) => {
      const data = payload as { serverIp: string; serverPort: number };
      return service.saveNetworkProperties(data.serverIp, data.serverPort);
    }
  );

  ipcMain.handle(IPC_CHANNELS.MODS_SCAN, (_e, sourceDir: unknown) =>
    service.scanMods(typeof sourceDir === 'string' ? sourceDir : undefined)
  );
  ipcMain.handle(IPC_CHANNELS.MODS_COPY_TO_SERVER, (_e, sourceDir: unknown) =>
    service.copyModsToServer(typeof sourceDir === 'string' ? sourceDir : undefined)
  );
  ipcMain.handle(IPC_CHANNELS.MODS_DELETE_SERVER_MOD, (_e, fileName: unknown) =>
    service.deleteServerMod(String(fileName ?? ''))
  );

  ipcMain.handle(IPC_CHANNELS.JAVA_DETECT, () => service.detectJavaInstallations(true));

  ipcMain.handle(IPC_CHANNELS.CLIENT_DETECT_TLAUNCHER, () => service.detectTLauncher());
  ipcMain.handle(IPC_CHANNELS.CLIENT_SETUP_NEOFORGE, (_e, options: unknown) =>
    service.setupNeoForgeClient(
      options as { minecraftDir: string; buildName: string; modsSourceDir: string }
    )
  );

  // Native OS Folder & File Pickers
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, async (_e, payload: unknown) => {
    const opts = (payload || {}) as { title?: string; defaultPath?: string };
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: opts.title || 'Выберите папку',
      defaultPath: opts.defaultPath,
      properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FILE, async (_e, payload: unknown) => {
    const opts = (payload || {}) as {
      title?: string;
      defaultPath?: string;
      extensions?: string[];
    };
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: opts.title || 'Выберите файл',
      defaultPath: opts.defaultPath,
      properties: ['openFile', 'showHiddenFiles'],
      filters: opts.extensions?.length
        ? [{ name: 'Файлы', extensions: opts.extensions }]
        : undefined,
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.FS_BROWSE, (_e, targetPath: unknown) =>
    service.browseDirectory(typeof targetPath === 'string' ? targetPath : undefined)
  );

  // Frameless window controls
  ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, () => mainWindow?.close());
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    coreService = new CoreBackendService('electron', app.getAppPath());
    registerIpcHandlers(coreService);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (coreService) {
    void coreService.stopServer().finally(() => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });
  } else if (process.platform !== 'darwin') {
    app.quit();
  }
});
