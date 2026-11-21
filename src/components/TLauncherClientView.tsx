import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  FolderCheck,
  FolderOpen,
  Laptop,
  Loader2,
  RefreshCw,
  Rocket,
} from 'lucide-react';
import type {
  ClientDetectionResult,
  ClientSetupResult,
  ClientSetupStep,
  ServerConfig,
} from '../../shared/types';

interface TLauncherClientViewProps {
  config: ServerConfig;
  detection: ClientDetectionResult;
  steps: ClientSetupStep[];
  lastSetup: ClientSetupResult | null;
  sourceModsCount: number;
  onDetectAgain: () => Promise<void>;
  onSelectMinecraftDir: (currentPath: string, onSelect: (path: string) => void) => void;
  onSelectModsDir: (currentPath: string, onSelect: (path: string) => void) => void;
  onRunSetup: (options: {
    minecraftDir: string;
    buildName: string;
    modsSourceDir: string;
  }) => Promise<void>;
}

const BUILD_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function TLauncherClientView({
  config,
  detection,
  steps,
  lastSetup,
  sourceModsCount,
  onDetectAgain,
  onSelectMinecraftDir,
  onSelectModsDir,
  onRunSetup,
}: TLauncherClientViewProps) {
  const [minecraftDir, setMinecraftDir] = useState(config.minecraftDir || detection.detectedPath);
  const [buildName, setBuildName] = useState(config.clientBuildName || 'NeoForge-1.21.1-21.1.267');
  const [modsSourceDir, setModsSourceDir] = useState(config.modsSourceDir);
  const [running, setRunning] = useState(false);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    setMinecraftDir(config.minecraftDir || detection.detectedPath);
  }, [config.minecraftDir, detection.detectedPath]);

  useEffect(() => {
    setModsSourceDir(config.modsSourceDir);
  }, [config.modsSourceDir]);

  const trimmedBuild = buildName.trim();
  const buildNameError =
    !BUILD_NAME_REGEX.test(trimmedBuild) || trimmedBuild.includes('..')
      ? 'Имя сборки должно начинаться с буквы/цифры, без «..» (до 64 символов).'
      : null;

  const handleDetect = async () => {
    setDetecting(true);
    try {
      await onDetectAgain();
    } finally {
      setDetecting(false);
    }
  };

  const handleRunSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (buildNameError || running) return;
    setRunning(true);
    try {
      await onRunSetup({
        minecraftDir: minecraftDir.trim(),
        buildName: buildName.trim(),
        modsSourceDir: modsSourceDir.trim(),
      });
    } finally {
      setRunning(false);
    }
  };

  const pathMatchesDetected = minecraftDir.trim() === detection.detectedPath;
  const isPathFound = pathMatchesDetected ? detection.exists : minecraftDir.trim().length > 0;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Left: Auto-detection & Build Configuration */}
      <div className="xl:col-span-7 space-y-6">
        {/* TLauncher / .minecraft detection block */}
        <section className="rounded-xl bg-[#111827] border border-slate-800 p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Автопоиск клиента TLauncher (.minecraft)
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Определенная ОС: <span className="font-mono text-slate-300">{detection.platformLabel}</span>
              </p>
            </div>
            <Laptop className="w-5 h-5 text-indigo-400 shrink-0" />
          </div>

          <div
            className={`rounded-lg px-4 py-3 border flex flex-wrap items-center justify-between gap-3 ${
              isPathFound
                ? 'bg-emerald-500/[0.06] border-emerald-500/25'
                : 'bg-amber-500/[0.06] border-amber-500/25'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {isPathFound ? (
                  <FolderCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                )}
                <span
                  className={`text-xs font-semibold ${
                    isPathFound ? 'text-emerald-300' : 'text-amber-300'
                  }`}
                >
                  {isPathFound
                    ? 'Директория .minecraft найдена'
                    : 'Стандартная папка .minecraft не найдена'}
                </span>
                {detection.tlauncherProfilesFound && pathMatchesDetected && (
                  <span className="text-xs text-slate-400">· TLauncherProfiles.json обнаружен</span>
                )}
              </div>
              <p className="font-mono text-xs text-slate-200 truncate mt-1.5">{minecraftDir}</p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleDetect()}
                aria-label="Перепроверить путь .minecraft"
                className="p-2 rounded-lg bg-slate-800/90 hover:bg-slate-700 border border-slate-700 text-slate-300 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${detecting ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() =>
                  onSelectMinecraftDir(minecraftDir, (selected) => setMinecraftDir(selected))
                }
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 transition-colors whitespace-nowrap"
              >
                <FolderOpen className="w-3.5 h-3.5 text-slate-300" />
                Выбрать папку .minecraft вручную
              </button>
            </div>
          </div>
        </section>

        {/* NeoForge 1.21.1 Build Setup Form */}
        <form
          onSubmit={(e) => void handleRunSetup(e)}
          className="rounded-xl bg-[#111827] border border-slate-800 p-6 space-y-5"
        >
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Авто-сборка NeoForge 1.21.1 для TLauncher
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Целевая версия: <span className="font-mono text-slate-200">Minecraft 1.21.1</span> ·
              Загрузчик: <span className="font-mono text-slate-200">NeoForge 21.1.267</span>
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="build-name" className="block text-xs font-medium text-slate-300">
                Имя кастомной версии в TLauncher
              </label>
              <input
                id="build-name"
                type="text"
                value={buildName}
                onChange={(e) => setBuildName(e.target.value)}
                className={`w-full px-3.5 py-2 rounded-lg bg-[#0B1120] border text-sm font-mono text-slate-100 focus:outline-none transition-colors ${
                  buildNameError
                    ? 'border-red-500/70 focus:border-red-400'
                    : 'border-slate-800 focus:border-indigo-500'
                }`}
              />
              {buildNameError ? (
                <p className="text-xs text-red-400">{buildNameError}</p>
              ) : (
                <p className="text-xs text-slate-500">
                  До первого запуска игры будут принудительно созданы обе директории:{' '}
                  <span className="font-mono text-slate-400">.minecraft/mods</span> и{' '}
                  <span className="font-mono text-slate-400">
                    .minecraft/versions/{buildName || 'NeoForge-1.21.1-21.1.267'}/mods
                  </span>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="client-mods-src" className="block text-xs font-medium text-slate-300">
                Папка с модами для установки в клиент ({sourceModsCount} .jar)
              </label>
              <div className="flex gap-2">
                <input
                  id="client-mods-src"
                  type="text"
                  value={modsSourceDir}
                  onChange={(e) => setModsSourceDir(e.target.value)}
                  className="flex-1 min-w-0 px-3.5 py-2 rounded-lg bg-[#0B1120] border border-slate-800 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={() =>
                    onSelectModsDir(modsSourceDir, (selected) => setModsSourceDir(selected))
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Выбрать
                </button>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={running || Boolean(buildNameError) || !minecraftDir.trim()}
            className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {running ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Выполняется настройка клиента...
              </>
            ) : (
              <>
                <Rocket className="w-4 h-4" />
                Создать сборку NeoForge 1.21.1 и установить моды
              </>
            )}
          </button>
        </form>

        {/* Verified Result Directories */}
        {lastSetup && lastSetup.success && (
          <section className="rounded-xl bg-[#111827] border border-emerald-500/30 p-5 space-y-3">
            <div className="flex items-center gap-2 text-emerald-400">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <h3 className="text-sm font-semibold">
                Сборка {lastSetup.buildName} успешно подготовлена
              </h3>
            </div>

            <dl className="space-y-2 text-xs">
              <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-1.5 border-b border-slate-800/80">
                <dt className="text-slate-400">Манифест версии TLauncher</dt>
                <dd className="font-mono text-slate-200 truncate">{lastSetup.versionJsonPath}</dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-1.5 border-b border-slate-800/80">
                <dt className="text-slate-400">Корневая папка mods (создана заранее)</dt>
                <dd className="font-mono text-emerald-300 truncate">{lastSetup.rootModsDir}</dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-1.5 border-b border-slate-800/80">
                <dt className="text-slate-400">Изолированная папка mods (создана заранее)</dt>
                <dd className="font-mono text-emerald-300 truncate">{lastSetup.isolatedModsDir}</dd>
              </div>
              <div className="flex flex-col sm:flex-row sm:justify-between gap-1 pt-1">
                <dt className="text-slate-400">Установлено модов (.jar)</dt>
                <dd className="font-mono tabular-nums text-slate-100 font-medium">
                  {lastSetup.copiedModsCount} файл(ов)
                </dd>
              </div>
            </dl>
          </section>
        )}
      </div>

      {/* Right: 5-Step Real-Time Installation Stepper */}
      <section className="xl:col-span-5 rounded-xl bg-[#111827] border border-slate-800 p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Ход установки клиента</h2>
          <p className="text-xs text-slate-400 mt-1">
            Пошаговый пайплайн синхронизации статуса с бэкендом
          </p>
        </div>

        <ol className="space-y-0">
          {steps.map((step, index) => {
            const isLast = index === steps.length - 1;
            const iconColor =
              step.status === 'completed'
                ? 'text-emerald-400'
                : step.status === 'running'
                  ? 'text-indigo-400'
                  : step.status === 'error'
                    ? 'text-red-400'
                    : 'text-slate-600';

            const lineColor =
              step.status === 'completed' ? 'bg-emerald-500/40' : 'bg-slate-800';

            return (
              <li key={step.id} className="relative flex gap-3.5 pb-6 last:pb-0">
                {!isLast && (
                  <span
                    aria-hidden="true"
                    className={`absolute left-[11px] top-6 bottom-0 w-px ${lineColor}`}
                  />
                )}

                <div className="relative z-10 mt-0.5 shrink-0 bg-[#111827]">
                  {step.status === 'completed' ? (
                    <CheckCircle2 className={`w-[22px] h-[22px] ${iconColor}`} />
                  ) : step.status === 'running' ? (
                    <Loader2 className={`w-[22px] h-[22px] animate-spin ${iconColor}`} />
                  ) : step.status === 'error' ? (
                    <AlertCircle className={`w-[22px] h-[22px] ${iconColor}`} />
                  ) : (
                    <Circle className={`w-[22px] h-[22px] ${iconColor}`} />
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p
                      className={`text-sm font-medium ${
                        step.status === 'idle' ? 'text-slate-400' : 'text-slate-100'
                      }`}
                    >
                      {index + 1}. {step.title}
                    </p>
                    <span
                      className={`text-[11px] font-medium whitespace-nowrap ${
                        step.status === 'completed'
                          ? 'text-emerald-400'
                          : step.status === 'running'
                            ? 'text-indigo-300'
                            : step.status === 'error'
                              ? 'text-red-400'
                              : 'text-slate-500'
                      }`}
                    >
                      {step.status === 'completed'
                        ? 'Готово'
                        : step.status === 'running'
                          ? 'Выполняется'
                          : step.status === 'error'
                            ? 'Ошибка'
                            : 'Ожидание'}
                    </span>
                  </div>

                  <p className="text-xs text-slate-400 leading-relaxed">{step.description}</p>

                  {step.detail && (
                    <p
                      className={`text-xs font-mono break-all pt-0.5 ${
                        step.status === 'error' ? 'text-red-300' : 'text-slate-300'
                      }`}
                    >
                      {step.detail}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
