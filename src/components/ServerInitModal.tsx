import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
  X,
} from 'lucide-react';
import type { JavaDetectionResult, ServerConfig, ServerCoreStatus } from '../../shared/types';

interface ServerInitModalProps {
  open: boolean;
  config: ServerConfig;
  javaDetection: JavaDetectionResult;
  serverCore: ServerCoreStatus;
  onPickDirectory: (title: string, initialPath: string, onSelect: (path: string) => void) => void;
  onDetectJava: () => Promise<void>;
  onInitialize: (targetDir: string) => Promise<void>;
  onClose: () => void;
}

export function ServerInitModal({
  open,
  config,
  javaDetection,
  serverCore,
  onPickDirectory,
  onDetectJava,
  onInitialize,
  onClose,
}: ServerInitModalProps) {
  const [targetDir, setTargetDir] = useState(config.serverDir);
  const [detectingJava, setDetectingJava] = useState(false);

  useEffect(() => {
    if (open) {
      setTargetDir(config.serverDir);
    }
  }, [open, config.serverDir]);

  if (!open) return null;

  const isInstalling = serverCore.installing;
  const bestJava = javaDetection.installations[0];
  const hasJava = javaDetection.installations.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = targetDir.trim();
    if (!cleaned || isInstalling) return;
    await onInitialize(cleaned);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="server-init-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-xl rounded-xl bg-[#111827] border border-slate-800 overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center shrink-0">
              <Server className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="min-w-0">
              <h2 id="server-init-title" className="text-base font-semibold text-slate-100">
                Инициализация сервера Minecraft 1.21.1
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Выберите папку сервера — ядро NeoForge 21.1.267, eula.txt и server.properties
                настроятся автоматически
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={isInstalling}
            onClick={onClose}
            aria-label="Закрыть окно инициализации"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-40 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={(e) => void handleSubmit(e)} className="p-6 space-y-5">
          {/* Target server directory selector */}
          <div className="space-y-2">
            <label htmlFor="init-server-dir" className="block text-xs font-medium text-slate-300">
              Директория для развёртывания сервера
            </label>
            <div className="flex gap-2">
              <input
                id="init-server-dir"
                type="text"
                value={targetDir}
                disabled={isInstalling}
                onChange={(e) => setTargetDir(e.target.value)}
                placeholder="C:\Users\Имя\minecraft-server"
                className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-[#0B1120] border border-slate-800 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 disabled:opacity-60"
              />
              <button
                type="button"
                disabled={isInstalling}
                onClick={() =>
                  onPickDirectory('Выберите папку для сервера Minecraft', targetDir, (picked) =>
                    setTargetDir(picked)
                  )
                }
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 disabled:opacity-40 transition-colors shrink-0 whitespace-nowrap"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                Выбрать папку
              </button>
            </div>
            <p className="text-[11px] text-slate-500">
              Если директория ещё не существует, она будет создана автоматически вместе с папкой{' '}
              <span className="font-mono text-slate-400">mods/</span>.
            </p>
          </div>

          {/* Environment checklist */}
          <div className="divide-y divide-slate-800/80 border-y border-slate-800">
            {/* Java 21 status */}
            <div className="py-3 flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                {hasJava ? (
                  <CheckCircle2
                    className={`w-4 h-4 shrink-0 mt-0.5 ${
                      javaDetection.hasCompatible21 ? 'text-emerald-400' : 'text-amber-400'
                    }`}
                  />
                ) : (
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                )}
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-200">
                    {hasJava
                      ? `Java ${bestJava.version} (${bestJava.vendor}) обнаружена автоматически`
                      : 'Java 21 не обнаружена в системе'}
                  </p>
                  <p className="text-[11px] font-mono text-slate-500 truncate mt-0.5">
                    {hasJava
                      ? javaDetection.selectedPath
                      : 'Установите Eclipse Temurin JDK 21 (adoptium.net) или перезапустите Setup.exe'}
                  </p>
                </div>
              </div>

              <button
                type="button"
                disabled={detectingJava || isInstalling}
                onClick={async () => {
                  setDetectingJava(true);
                  try {
                    await onDetectJava();
                  } finally {
                    setDetectingJava(false);
                  }
                }}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 disabled:opacity-40 shrink-0 whitespace-nowrap"
              >
                <RefreshCw className={`w-3 h-3 ${detectingJava ? 'animate-spin' : ''}`} />
                Проверить
              </button>
            </div>

            {/* NeoForge 1.21.1 Core / Pre-cached Installer status */}
            <div className="py-3 flex items-start gap-2.5">
              {serverCore.coreDetected ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : serverCore.cachedInstallerPath ? (
                <HardDrive className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              ) : (
                <Download className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-200">
                  {serverCore.coreDetected
                    ? `Ядро уже готово: ${serverCore.coreLabel}`
                    : serverCore.cachedInstallerPath
                      ? 'Установщик NeoForge 1.21.1 уже предзагружен (кэш Setup.exe)'
                      : 'Ядро NeoForge 1.21.1 (21.1.267) будет скачано автоматически'}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {serverCore.coreDetected
                    ? 'Вы можете указать другую папку или подтвердить текущую директорию.'
                    : serverCore.cachedInstallerPath
                      ? 'Повторная загрузка не потребуется — установка ядра в папку начнётся мгновенно.'
                      : 'Загрузка официального установщика с maven.neoforged.net и автоматическая распаковка.'}
                </p>
              </div>
            </div>
          </div>

          {/* Live installation progress bar */}
          {isInstalling && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-2 text-indigo-300 font-medium truncate">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span className="truncate">
                    {serverCore.installStage || 'Подготовка сервера NeoForge 1.21.1...'}
                  </span>
                </span>
                <span className="font-mono tabular-nums text-slate-300 shrink-0">
                  {serverCore.installPercent}%
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-[#0B1120] border border-slate-800 overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all duration-300"
                  style={{ width: `${Math.max(4, Math.min(100, serverCore.installPercent))}%` }}
                />
              </div>
            </div>
          )}

          {/* Error banner */}
          {serverCore.installError && !isInstalling && (
            <div className="rounded-lg bg-red-500/[0.08] border border-red-500/30 px-3.5 py-2.5 text-xs text-red-200 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{serverCore.installError}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-1">
            <button
              type="button"
              disabled={isInstalling}
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 disabled:opacity-40 transition-colors"
            >
              Настроить позже
            </button>
            <button
              type="submit"
              disabled={isInstalling || !targetDir.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isInstalling ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Установка ядра...
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" />
                  Инициализировать сервер
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
