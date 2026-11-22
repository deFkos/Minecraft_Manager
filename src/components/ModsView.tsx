import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  CopyPlus,
  FolderOpen,
  Package,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import type { ModsState } from '../../shared/types';

interface ModsViewProps {
  mods: ModsState;
  onSelectSourceDir: (currentPath: string) => void;
  onRefreshMods: () => Promise<void>;
  onCopyToServer: () => Promise<void>;
  onDeleteServerMod: (fileName: string) => Promise<void>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function ModsView({
  mods,
  onSelectSourceDir,
  onRefreshMods,
  onCopyToServer,
  onDeleteServerMod,
}: ModsViewProps) {
  const [viewMode, setViewMode] = useState<'source' | 'server'>('source');
  const [search, setSearch] = useState('');
  const [copying, setCopying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const unsyncedCount = useMemo(
    () => mods.sourceMods.filter((m) => !m.syncedToServer || !m.sizeMatchesServer).length,
    [mods.sourceMods]
  );

  const modsWithMissingDeps = useMemo(
    () => mods.serverMods.filter((m) => m.missingDeps && m.missingDeps.length > 0),
    [mods.serverMods]
  );

  const visibleList = useMemo(() => {
    const base = viewMode === 'source' ? mods.sourceMods : mods.serverMods;
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter((item) => item.name.toLowerCase().includes(q));
  }, [mods.sourceMods, mods.serverMods, viewMode, search]);

  const handleCopy = async () => {
    setCopying(true);
    try {
      await onCopyToServer();
    } finally {
      setCopying(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshMods();
    } finally {
      setRefreshing(false);
    }
  };

  const handleDelete = async (name: string) => {
    setDeletingName(name);
    try {
      await onDeleteServerMod(name);
    } finally {
      setDeletingName(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Action & Folder Selection Bar */}
      <section className="rounded-xl bg-[#111827] border border-slate-800 p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-100">Управление модами сервера</h2>
            <p className="text-xs text-slate-400">
              Выберите локальную папку с <span className="font-mono text-slate-300">.jar</span> файлами и скопируйте их в каталог модов сервера
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => onSelectSourceDir(mods.sourceDir)}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 transition-colors whitespace-nowrap"
            >
              <FolderOpen className="w-3.5 h-3.5 text-slate-300" />
              Выбрать папку с модами
            </button>

            <button
              type="button"
              disabled={copying || mods.sourceMods.length === 0}
              onClick={() => void handleCopy()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              <CopyPlus className="w-3.5 h-3.5" />
              {copying ? 'Копирование...' : 'Копировать .jar на сервер'}
            </button>
          </div>
        </div>

        {/* Clean path & summary grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-4 border-t border-slate-800/80 text-xs">
          <div className="space-y-1 min-w-0">
            <span className="text-slate-500">Локальная папка-источник</span>
            <p className="font-mono text-slate-200 truncate">{mods.sourceDir}</p>
          </div>
          <div className="space-y-1 min-w-0">
            <span className="text-slate-500">Целевая директория сервера (создается автоматически)</span>
            <p className="font-mono text-slate-200 truncate">{mods.serverModsDir}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400 pt-1">
          <span>
            В источнике:{' '}
            <strong className="font-mono tabular-nums text-slate-200">
              {mods.sourceMods.length} .jar
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            На сервере:{' '}
            <strong className="font-mono tabular-nums text-slate-200">
              {mods.serverMods.length} .jar
            </strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Ожидают копирования:{' '}
            <strong
              className={`font-mono tabular-nums ${
                unsyncedCount > 0 ? 'text-amber-400' : 'text-emerald-400'
              }`}
            >
              {unsyncedCount}
            </strong>
          </span>
        </div>
      </section>

      {/* Missing Mod Dependencies Warning Banner */}
      {modsWithMissingDeps.length > 0 && (
        <section className="rounded-xl bg-red-950/25 border border-red-500/35 px-5 py-4 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0">
              <p className="text-xs font-semibold text-red-300">
                Обнаружены моды сервера без обязательных библиотек ({modsWithMissingDeps.length}) — сервер не запустится до исправления
              </p>
              <ul className="space-y-0.5 text-xs text-red-200/90 font-mono">
                {modsWithMissingDeps.map((m) => (
                  <li key={m.name} className="break-words">
                    {m.name} → требуется: {m.missingDeps?.join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {viewMode !== 'server' && (
            <button
              type="button"
              onClick={() => setViewMode('server')}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-200 transition-colors whitespace-nowrap"
            >
              Показать проблемные моды
            </button>
          )}
        </section>
      )}

      {/* Mods Table */}
      <section className="rounded-xl bg-[#111827] border border-slate-800 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Список модов"
            className="flex items-center gap-1 p-1 rounded-lg bg-[#0B1120] border border-slate-800"
          >
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'source'}
              onClick={() => setViewMode('source')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                viewMode === 'source'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Локальная папка ({mods.sourceMods.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'server'}
              onClick={() => setViewMode('server')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                viewMode === 'server'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Установлено на сервере ({mods.serverMods.length})
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Фильтр по названию..."
                className="w-52 pl-8 pr-3 py-1.5 rounded-lg bg-[#0B1120] border border-slate-800 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <button
              type="button"
              onClick={() => void handleRefresh()}
              aria-label="Обновить список модов"
              className="p-1.5 rounded-lg bg-[#0B1120] border border-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {visibleList.length === 0 ? (
          <div className="p-12 text-center space-y-2">
            <Package className="w-8 h-8 text-slate-600 mx-auto" />
            <p className="text-sm text-slate-300">
              {search
                ? 'По запросу ничего не найдено.'
                : viewMode === 'source'
                  ? 'В выбранной папке нет .jar файлов.'
                  : 'На сервере пока не установлены моды.'}
            </p>
            <p className="text-xs text-slate-500">
              {viewMode === 'source'
                ? 'Выберите другую директорию с модами NeoForge 1.21.1.'
                : 'Нажмите «Копировать .jar на сервер», чтобы синхронизировать моды.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0B1120]/60 text-xs text-slate-400">
                  <th className="py-2.5 px-5 font-medium">Файл мода (.jar)</th>
                  <th className="py-2.5 px-4 font-medium text-right">Размер</th>
                  <th className="py-2.5 px-4 font-medium">Изменен</th>
                  <th className="py-2.5 px-5 font-medium text-right">
                    {viewMode === 'source' ? 'Статус синхронизации' : 'Действие'}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 text-sm">
                {visibleList.map((mod) => (
                  <tr key={mod.name} className="hover:bg-slate-800/35 transition-colors">
                    <td className="py-2.5 px-5 font-mono text-xs text-slate-100">
                      <div>{mod.name}</div>
                      {mod.missingDeps && mod.missingDeps.length > 0 && (
                        <div className="text-[11px] text-red-400 mt-0.5">
                          Не хватает зависимостей: {mod.missingDeps.join(', ')}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-xs tabular-nums text-slate-400 text-right whitespace-nowrap">
                      {formatSize(mod.sizeBytes)}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-xs tabular-nums text-slate-400 whitespace-nowrap">
                      {formatDate(mod.modifiedAt)}
                    </td>
                    <td className="py-2.5 px-5 text-right whitespace-nowrap">
                      {viewMode === 'source' ? (
                        mod.syncedToServer && mod.sizeMatchesServer ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            На сервере
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-amber-400 font-medium">
                            <Clock className="w-3.5 h-3.5" />
                            Ожидает копирования
                          </span>
                        )
                      ) : (
                        <button
                          type="button"
                          disabled={deletingName === mod.name}
                          onClick={() => void handleDelete(mod.name)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-slate-400 hover:text-red-300 hover:bg-red-500/15 transition-colors disabled:opacity-40"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Удалить
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
