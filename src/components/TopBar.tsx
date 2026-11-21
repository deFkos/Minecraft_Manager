import {
  AlertTriangle,
  Circle,
  Loader2,
  Maximize2,
  Minus,
  Play,
  RotateCw,
  Square,
  X,
} from 'lucide-react';
import type { ServerRuntimeState, ServerStatus } from '../../shared/types';
import { desktopApi } from '../lib/desktopBridge';
import type { ActiveTab } from './Sidebar';

interface TopBarProps {
  activeTab: ActiveTab;
  runtime: ServerRuntimeState;
  busyAction: 'start' | 'stop' | 'restart' | null;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}

const TAB_TITLES: Record<ActiveTab, string> = {
  console: 'Консоль и сервер',
  network: 'Сеть и свойства',
  mods: 'Моды сервера',
  client: 'Клиент / TLauncher',
};

const STATUS_META: Record<
  ServerStatus,
  { label: string; textColor: string; dotColor: string; pulse?: boolean }
> = {
  offline: {
    label: 'Оффлайн',
    textColor: 'text-slate-400',
    dotColor: 'text-slate-500 fill-slate-500',
  },
  starting: {
    label: 'Запускается',
    textColor: 'text-amber-400',
    dotColor: 'text-amber-400 fill-amber-400',
    pulse: true,
  },
  online: {
    label: 'Онлайн',
    textColor: 'text-emerald-400',
    dotColor: 'text-emerald-400 fill-emerald-400',
  },
  error: {
    label: 'Ошибка',
    textColor: 'text-red-400',
    dotColor: 'text-red-400',
  },
};

export function TopBar({
  activeTab,
  runtime,
  busyAction,
  onStart,
  onStop,
  onRestart,
}: TopBarProps) {
  const statusInfo = STATUS_META[runtime.status];
  const isRunning = runtime.status === 'online' || runtime.status === 'starting';

  return (
    <header className="h-14 shrink-0 bg-[#0E1526] border-b border-slate-800/90 px-6 flex items-center justify-between gap-6 app-drag-region">
      {/* Contextual breadcrumb + real-time server status */}
      <div className="flex items-center gap-4 min-w-0 app-no-drag">
        <div className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-slate-500 whitespace-nowrap">NeoForge 1.21.1</span>
          <span className="text-slate-600" aria-hidden="true">
            /
          </span>
          <h1 className="font-semibold text-slate-100 whitespace-nowrap truncate">
            {TAB_TITLES[activeTab]}
          </h1>
        </div>

        <span className="h-4 w-px bg-slate-800 shrink-0" aria-hidden="true" />

        {/* Live process status indicator (explicit icon + color + text) */}
        <div
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-2 text-xs font-medium whitespace-nowrap shrink-0"
        >
          {runtime.status === 'error' ? (
            <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
          ) : runtime.status === 'starting' ? (
            <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
          ) : (
            <Circle className={`w-2.5 h-2.5 shrink-0 ${statusInfo.dotColor}`} />
          )}
          <span className={statusInfo.textColor}>{statusInfo.label}</span>
          {runtime.pid && (
            <span className="text-slate-500 font-mono tabular-nums">
              · PID {runtime.pid}
            </span>
          )}
        </div>
      </div>

      {/* Power controls + optional Electron frameless window controls */}
      <div className="flex items-center gap-2.5 shrink-0 app-no-drag">
        <button
          type="button"
          disabled={isRunning || busyAction !== null}
          onClick={onStart}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          <Play className="w-3.5 h-3.5 fill-current" />
          Старт
        </button>

        <button
          type="button"
          disabled={!isRunning || busyAction !== null}
          onClick={onStop}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-red-500/20 hover:text-red-300 border border-slate-700 hover:border-red-500/40 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        >
          <Square className="w-3 h-3 fill-current" />
          Стоп
        </button>

        <button
          type="button"
          disabled={busyAction !== null}
          onClick={onRestart}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          <RotateCw
            className={`w-3.5 h-3.5 ${busyAction === 'restart' ? 'animate-spin' : ''}`}
          />
          Перезапуск
        </button>

        {desktopApi.isElectron && desktopApi.windowAction && (
          <div className="flex items-center gap-1 ml-2 pl-2 border-l border-slate-800">
            <button
              type="button"
              onClick={() => desktopApi.windowAction?.('minimize')}
              aria-label="Свернуть окно"
              className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => desktopApi.windowAction?.('maximize')}
              aria-label="Развернуть окно"
              className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => desktopApi.windowAction?.('close')}
              aria-label="Закрыть окно"
              className="p-1.5 rounded text-slate-400 hover:text-red-300 hover:bg-red-500/20 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
