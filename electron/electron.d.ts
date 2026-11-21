declare module 'electron' {
  export interface OpenDialogOptions {
    title?: string;
    defaultPath?: string;
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory'>;
    filters?: Array<{ name: string; extensions: string[] }>;
  }

  export interface OpenDialogReturnValue {
    canceled: boolean;
    filePaths: string[];
  }

  export interface WebContents {
    send(channel: string, ...args: unknown[]): void;
  }

  export class BrowserWindow {
    constructor(options: Record<string, unknown>);
    webContents: WebContents;
    loadURL(url: string): Promise<void>;
    loadFile(filePath: string): Promise<void>;
    minimize(): void;
    maximize(): void;
    unmaximize(): void;
    restore(): void;
    focus(): void;
    isMinimized(): boolean;
    isMaximized(): boolean;
    close(): void;
    isDestroyed(): boolean;
    on(event: string, listener: (...args: unknown[]) => void): this;
    static getAllWindows(): BrowserWindow[];
  }

  export interface ElectronEvent {
    preventDefault(): void;
  }

  export const app: {
    whenReady(): Promise<void>;
    on(event: 'before-quit', listener: (event: ElectronEvent) => void): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    quit(): void;
    exit(exitCode?: number): void;
    getAppPath(): string;
    requestSingleInstanceLock(): boolean;
    isPackaged: boolean;
  };

  export const ipcMain: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  };

  export const dialog: {
    showOpenDialog(window: BrowserWindow | undefined, options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
  };

  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: unknown): void;
  };

  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    send(channel: string, ...args: unknown[]): void;
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
    removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  };
}
