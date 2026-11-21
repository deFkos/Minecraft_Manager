import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import type { AppFullState, ServerConfig } from '../shared/types';
import { desktopApi } from './lib/desktopBridge';
import { Sidebar, type ActiveTab } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { ConsoleServerView } from './components/ConsoleServerView';
import { NetworkView } from './components/NetworkView';
import { ModsView } from './components/ModsView';
import { TLauncherClientView } from './components/TLauncherClientView';
import { FileBrowserModal, type FilePickerRequest } from './components/FileBrowserModal';
import { ToastContainer, type ToastItem } from './components/ToastContainer';

export default function App() {
  const [state, setState] = useState<AppFullState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('console');
  const [busyAction, setBusyAction] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [pickerRequest, setPickerRequest] = useState<FilePickerRequest | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback(
    (type: ToastItem['type'], title: string, description?: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, type, title, description }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((item) => item.id !== id));
      }, 4200);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const loadInitialState = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const fullState = await desktopApi.getState();
      setState(fullState);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Не удалось подключиться к бэкенду.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInitialState();

    const unsubStatus = desktopApi.onServerStatus((runtime) => {
      setState((prev) => (prev ? { ...prev, runtime } : prev));
    });

    const unsubLog = desktopApi.onServerLog((entry) => {
      setState((prev) => {
        if (!prev) return prev;
        const nextLogs = [...prev.logs, entry];
        return {
          ...prev,
          logs: nextLogs.length > 1000 ? nextLogs.slice(nextLogs.length - 1000) : nextLogs,
        };
      });
    });

    const unsubPlayers = desktopApi.onPlayersUpdate((players) => {
      setState((prev) =>
        prev ? { ...prev, runtime: { ...prev.runtime, players } } : prev
      );
    });

    const unsubSteps = desktopApi.onClientSetupProgress((steps) => {
      setState((prev) => (prev ? { ...prev, clientSteps: steps } : prev));
    });

    return () => {
      unsubStatus();
      unsubLog();
      unsubPlayers();
      unsubSteps();
    };
  }, [loadInitialState]);

  const openDirectoryPicker = useCallback(
    async (title: string, initialPath: string, onSelect: (selectedPath: string) => void) => {
      if (desktopApi.isElectron) {
        const nativePath = await desktopApi.selectDirectoryNative(title, initialPath);
        if (nativePath) onSelect(nativePath);
        return;
      }
      setPickerRequest({
        mode: 'directory',
        title,
        initialPath,
        onSelect,
      });
    },
    []
  );

  const openFilePicker = useCallback(
    async (
      title: string,
      initialPath: string,
      extension: string,
      onSelect: (selectedPath: string) => void
    ) => {
      if (desktopApi.isElectron) {
        const cleanExt = extension.replace(/^\./, '');
        const nativePath = await desktopApi.selectFileNative(title, initialPath, [cleanExt]);
        if (nativePath) onSelect(nativePath);
        return;
      }
      setPickerRequest({
        mode: 'file',
        title,
        initialPath,
        fileExtension: extension,
        onSelect,
      });
    },
    []
  );

  const handleStart = async () => {
    setBusyAction('start');
    try {
      const res = await desktopApi.startServer();
      if (!res.ok) {
        pushToast('error', 'Не удалось запустить сервер', res.error);
      }
    } catch (err) {
      pushToast('error', 'Ошибка запуска', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const handleStop = async () => {
    setBusyAction('stop');
    try {
      const res = await desktopApi.stopServer();
      if (!res.ok) {
        pushToast('error', 'Не удалось остановить сервер', res.error);
      }
    } catch (err) {
      pushToast('error', 'Ошибка остановки', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestart = async () => {
    setBusyAction('restart');
    try {
      const res = await desktopApi.restartServer();
      if (!res.ok) {
        pushToast('error', 'Не удалось перезапустить сервер', res.error);
      }
    } catch (err) {
      pushToast('error', 'Ошибка перезапуска', err instanceof Error ? err.message : undefined);
    } finally {
      setBusyAction(null);
    }
  };

  const handleSendCommand = async (command: string) => {
    try {
      const res = await desktopApi.sendCommand(command);
      if (!res.ok) {
        pushToast('error', 'Команда не отправлена', res.error);
      }
    } catch (err) {
      pushToast('error', 'Ошибка команды', err instanceof Error ? err.message : undefined);
    }
  };

  const handleClearLogs = async () => {
    try {
      await desktopApi.clearLogs();
      setState((prev) => (prev ? { ...prev, logs: [] } : prev));
    } catch (err) {
      pushToast('error', 'Не удалось очистить лог', err instanceof Error ? err.message : undefined);
    }
  };

  const handleUpdateConfig = async (patch: Partial<ServerConfig>) => {
    try {
      const next = await desktopApi.updateServerConfig(patch);
      setState(next);
    } catch (err) {
      pushToast('error', 'Ошибка сохранения настроек', err instanceof Error ? err.message : undefined);
      throw err;
    }
  };

  const handleSaveNetwork = async (serverIp: string, serverPort: number) => {
    try {
      const network = await desktopApi.saveNetworkProperties(serverIp, serverPort);
      setState((prev) => (prev ? { ...prev, network } : prev));
    } catch (err) {
      pushToast('error', 'Ошибка записи server.properties', err instanceof Error ? err.message : undefined);
      throw err;
    }
  };

  const handleRefreshMods = async (overrideDir?: string) => {
    try {
      const mods = await desktopApi.scanMods(overrideDir);
      setState((prev) =>
        prev
          ? {
              ...prev,
              mods,
              config: overrideDir ? { ...prev.config, modsSourceDir: overrideDir } : prev.config,
            }
          : prev
      );
    } catch (err) {
      pushToast('error', 'Ошибка сканирования модов', err instanceof Error ? err.message : undefined);
    }
  };

  const handleCopyModsToServer = async () => {
    try {
      const { result, mods } = await desktopApi.copyModsToServer(state?.config.modsSourceDir);
      setState((prev) => (prev ? { ...prev, mods } : prev));
      pushToast(
        'success',
        `Скопировано ${result.copiedCount} .jar на сервер`,
        `Папка назначения: ${result.targetDir}`
      );
    } catch (err) {
      pushToast('error', 'Ошибка копирования модов', err instanceof Error ? err.message : undefined);
    }
  };

  const handleDeleteServerMod = async (fileName: string) => {
    try {
      const mods = await desktopApi.deleteServerMod(fileName);
      setState((prev) => (prev ? { ...prev, mods } : prev));
      pushToast('info', 'Мод удален с сервера', fileName);
    } catch (err) {
      pushToast('error', 'Не удалось удалить мод', err instanceof Error ? err.message : undefined);
    }
  };

  const handleDetectTLauncher = async () => {
    try {
      const clientDetection = await desktopApi.detectTLauncher();
      setState((prev) => (prev ? { ...prev, clientDetection } : prev));
      pushToast(
        clientDetection.exists ? 'success' : 'info',
        clientDetection.exists ? 'Папка .minecraft найдена' : 'Папка .minecraft не найдена',
        clientDetection.detectedPath
      );
    } catch (err) {
      pushToast('error', 'Ошибка автопоиска', err instanceof Error ? err.message : undefined);
    }
  };

  const handleRunClientSetup = async (options: {
    minecraftDir: string;
    buildName: string;
    modsSourceDir: string;
  }) => {
    try {
      const result = await desktopApi.setupNeoForgeClient(options);
      const refreshed = await desktopApi.getState();
      setState({ ...refreshed, lastClientSetup: result });
      if (result.success) {
        pushToast(
          'success',
          'Сборка NeoForge 1.21.1 готова!',
          `Созданы обе папки mods и скопировано ${result.copiedModsCount} .jar файлов.`
        );
      } else {
        pushToast('error', 'Ошибка сборки клиента', result.error);
      }
    } catch (err) {
      pushToast('error', 'Ошибка сборки клиента', err instanceof Error ? err.message : undefined);
    }
  };

  const unsyncedModsCount = useMemo(() => {
    if (!state) return 0;
    return state.mods.sourceMods.filter((m) => !m.syncedToServer || !m.sizeMatchesServer).length;
  }, [state]);

  if (loading) {
    return (
      <div className="h-full bg-[#0B1120] flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl bg-[#111827] border border-slate-800 p-6 space-y-4">
          <div className="h-5 w-44 rounded bg-slate-800 animate-pulse" />
          <div className="space-y-2.5">
            <div className="h-3.5 w-full rounded bg-slate-800/70 animate-pulse" />
            <div className="h-3.5 w-3/4 rounded bg-slate-800/70 animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (loadError || !state) {
    return (
      <div className="h-full bg-[#0B1120] flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl bg-[#111827] border border-red-500/30 p-6 text-center space-y-4">
          <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
          <div className="space-y-1">
            <h1 className="text-base font-semibold text-slate-100">
              Не удалось инициализировать панель
            </h1>
            <p className="text-xs text-slate-400">{loadError || 'Неизвестная ошибка'}</p>
          </div>
          <button
            type="button"
            onClick={() => void loadInitialState()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Повторить попытку
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex bg-[#0B1120] text-slate-100 overflow-hidden">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        environment={state.environment}
        platform={state.platform}
        mode={state.config.mode}
        modsCount={state.mods.serverMods.length}
        unsyncedModsCount={unsyncedModsCount}
      />

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <TopBar
          activeTab={activeTab}
          runtime={state.runtime}
          busyAction={busyAction}
          onStart={() => void handleStart()}
          onStop={() => void handleStop()}
          onRestart={() => void handleRestart()}
        />

        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-[1360px] mx-auto">
            {activeTab === 'console' && (
              <ConsoleServerView
                logs={state.logs}
                runtime={state.runtime}
                config={state.config}
                onSendCommand={handleSendCommand}
                onClearLogs={handleClearLogs}
                onUpdateConfig={handleUpdateConfig}
                onPickDirectory={(title, initialPath, onSelect) =>
                  void openDirectoryPicker(title, initialPath, onSelect)
                }
                onPickFile={(title, initialPath, ext, onSelect) =>
                  void openFilePicker(title, initialPath, ext, onSelect)
                }
                onToast={pushToast}
              />
            )}

            {activeTab === 'network' && (
              <NetworkView
                network={state.network}
                onSaveNetwork={handleSaveNetwork}
                onToast={pushToast}
              />
            )}

            {activeTab === 'mods' && (
              <ModsView
                mods={state.mods}
                onSelectSourceDir={(currentPath) =>
                  void openDirectoryPicker('Выбрать папку с .jar модами', currentPath, (selected) => {
                    void handleUpdateConfig({ modsSourceDir: selected }).then(() =>
                      handleRefreshMods(selected)
                    );
                  })
                }
                onRefreshMods={() => handleRefreshMods()}
                onCopyToServer={handleCopyModsToServer}
                onDeleteServerMod={handleDeleteServerMod}
              />
            )}

            {activeTab === 'client' && (
              <TLauncherClientView
                config={state.config}
                detection={state.clientDetection}
                steps={state.clientSteps}
                lastSetup={state.lastClientSetup}
                sourceModsCount={state.mods.sourceMods.length}
                onDetectAgain={handleDetectTLauncher}
                onSelectMinecraftDir={(currentPath, onSelect) =>
                  void openDirectoryPicker('Выбрать папку .minecraft', currentPath, (selected) => {
                    onSelect(selected);
                    void handleUpdateConfig({ minecraftDir: selected });
                  })
                }
                onSelectModsDir={(currentPath, onSelect) =>
                  void openDirectoryPicker('Выбрать папку с модами клиента', currentPath, (selected) => {
                    onSelect(selected);
                    void handleUpdateConfig({ modsSourceDir: selected });
                  })
                }
                onRunSetup={handleRunClientSetup}
              />
            )}
          </div>
        </main>
      </div>

      <FileBrowserModal request={pickerRequest} onClose={() => setPickerRequest(null)} />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
