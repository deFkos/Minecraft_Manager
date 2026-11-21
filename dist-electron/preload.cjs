// electron/preload.ts
var import_electron = require("electron");

// shared/types.ts
var IPC_CHANNELS = {
  // Request / Response (invoke)
  APP_GET_STATE: "app:get-state",
  APP_SET_MODE: "app:set-mode",
  SERVER_UPDATE_CONFIG: "server:update-config",
  SERVER_START: "server:start",
  SERVER_STOP: "server:stop",
  SERVER_RESTART: "server:restart",
  SERVER_SEND_COMMAND: "server:send-command",
  SERVER_CLEAR_LOGS: "server:clear-logs",
  NETWORK_READ_PROPERTIES: "network:read-properties",
  NETWORK_SAVE_PROPERTIES: "network:save-properties",
  MODS_SCAN: "mods:scan-folder",
  MODS_COPY_TO_SERVER: "mods:copy-to-server",
  MODS_DELETE_SERVER_MOD: "mods:delete-server-mod",
  CLIENT_DETECT_TLAUNCHER: "client:detect-tlauncher",
  CLIENT_SETUP_NEOFORGE: "client:setup-neoforge",
  DIALOG_SELECT_DIRECTORY: "dialog:select-directory",
  DIALOG_SELECT_FILE: "dialog:select-file",
  FS_BROWSE: "fs:browse",
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE: "window:maximize",
  WINDOW_CLOSE: "window:close",
  // Real-Time Push Events (Main -> Renderer / SSE -> Browser)
  EVENT_SERVER_STATUS: "event:server-status",
  EVENT_SERVER_LOG: "event:server-log",
  EVENT_PLAYERS_UPDATE: "event:players-update",
  EVENT_CLIENT_SETUP_PROGRESS: "event:client-setup-progress"
};

// electron/preload.ts
function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  import_electron.ipcRenderer.on(channel, listener);
  return () => import_electron.ipcRenderer.removeListener(channel, listener);
}
var electronAPI = {
  isElectron: true,
  getState: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.APP_GET_STATE),
  setWorkspaceMode: (mode) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.APP_SET_MODE, mode),
  updateServerConfig: (patch) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SERVER_UPDATE_CONFIG, patch),
  startServer: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SERVER_START),
  stopServer: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SERVER_STOP),
  restartServer: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SERVER_RESTART),
  sendCommand: (command) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SERVER_SEND_COMMAND, command),
  clearLogs: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SERVER_CLEAR_LOGS),
  readNetworkProperties: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.NETWORK_READ_PROPERTIES),
  saveNetworkProperties: (serverIp, serverPort) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.NETWORK_SAVE_PROPERTIES, {
    serverIp,
    serverPort
  }),
  scanMods: (sourceDir) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.MODS_SCAN, sourceDir),
  copyModsToServer: (sourceDir) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.MODS_COPY_TO_SERVER, sourceDir),
  deleteServerMod: (fileName) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.MODS_DELETE_SERVER_MOD, fileName),
  detectTLauncher: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.CLIENT_DETECT_TLAUNCHER),
  setupNeoForgeClient: (options) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.CLIENT_SETUP_NEOFORGE, options),
  selectDirectoryNative: (title, defaultPath) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, {
    title,
    defaultPath
  }),
  selectFileNative: (title, defaultPath, extensions) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FILE, {
    title,
    defaultPath,
    extensions
  }),
  browseDirectory: (targetPath) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.FS_BROWSE, targetPath),
  windowAction: (action) => {
    if (action === "minimize") import_electron.ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE);
    if (action === "maximize") import_electron.ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE);
    if (action === "close") import_electron.ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE);
  },
  onServerStatus: (cb) => subscribe(IPC_CHANNELS.EVENT_SERVER_STATUS, cb),
  onServerLog: (cb) => subscribe(IPC_CHANNELS.EVENT_SERVER_LOG, cb),
  onPlayersUpdate: (cb) => subscribe(IPC_CHANNELS.EVENT_PLAYERS_UPDATE, cb),
  onClientSetupProgress: (cb) => subscribe(IPC_CHANNELS.EVENT_CLIENT_SETUP_PROGRESS, cb)
};
import_electron.contextBridge.exposeInMainWorld("electronAPI", electronAPI);
