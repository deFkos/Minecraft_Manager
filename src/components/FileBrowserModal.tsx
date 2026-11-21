import { useEffect, useState } from 'react';
import { ArrowUp, Check, FileCode2, Folder, FolderOpen, X } from 'lucide-react';
import type { FsBrowseResult } from '../../shared/types';
import { desktopApi } from '../lib/desktopBridge';

export interface FilePickerRequest {
  mode: 'directory' | 'file';
  title: string;
  initialPath?: string;
  fileExtension?: string;
  onSelect: (selectedPath: string) => void;
}

interface FileBrowserModalProps {
  request: FilePickerRequest | null;
  onClose: () => void;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

export function FileBrowserModal({ request, onClose }: FileBrowserModalProps) {
  const [data, setData] = useState<FsBrowseResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPath = async (targetPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await desktopApi.browseDirectory(targetPath);
      setData(res);
      setSelectedPath(request?.mode === 'directory' ? res.currentPath : null);
    } catch (err) {
      // Fallback to workspace root if initial path didn't exist yet
      if (targetPath) {
        try {
          const fallback = await desktopApi.browseDirectory();
          setData(fallback);
          setSelectedPath(request?.mode === 'directory' ? fallback.currentPath : null);
          return;
        } catch {
          // fall through
        }
      }
      setError(err instanceof Error ? err.message : 'Не удалось открыть каталог.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!request) return;
    let initial = request.initialPath;
    if (request.mode === 'file' && initial) {
      const lastSlash = Math.max(initial.lastIndexOf('/'), initial.lastIndexOf('\\'));
      if (lastSlash > 0) initial = initial.slice(0, lastSlash);
    }
    void loadPath(initial);
  }, [request]);

  if (!request) return null;

  const visibleEntries = (data?.entries ?? []).filter((entry) => {
    if (entry.isDirectory) return true;
    if (request.mode === 'directory') return false;
    if (request.fileExtension) {
      return entry.name.toLowerCase().endsWith(request.fileExtension.toLowerCase());
    }
    return true;
  });

  const handleConfirm = () => {
    const finalTarget =
      request.mode === 'directory' ? selectedPath || data?.currentPath : selectedPath;
    if (!finalTarget) return;
    request.onSelect(finalTarget);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={request.title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-2xl rounded-xl bg-[#111827] border border-slate-800 shadow-2xl overflow-hidden flex flex-col max-h-[82vh]">
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-100 truncate">{request.title}</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Обозреватель песочницы (в десктопном Electron открывается системный диалог ОС)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть диалог"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-5 py-3 bg-[#0B1120] border-b border-slate-800">
          <button
            type="button"
            disabled={!data?.parentPath || loading}
            onClick={() => data?.parentPath && void loadPath(data.parentPath)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-800/80 text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
          >
            <ArrowUp className="w-3.5 h-3.5" />
            Вверх
          </button>
          <div className="flex-1 min-w-0 px-3 py-1.5 rounded-md bg-[#111827] border border-slate-800 font-mono text-xs text-slate-300 truncate">
            {data?.currentPath || 'Загрузка...'}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 min-h-[260px]">
          {loading ? (
            <div className="p-6 space-y-2.5">
              {[1, 2, 3, 4].map((row) => (
                <div key={row} className="h-9 rounded-md bg-slate-800/50 animate-pulse" />
              ))}
            </div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-red-400">{error}</div>
          ) : visibleEntries.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400">
              {request.mode === 'directory'
                ? 'Вложенных папок нет — можно выбрать текущую директорию.'
                : 'Подходящие файлы в этой директории не найдены.'}
            </div>
          ) : (
            visibleEntries.map((entry) => {
              const isSelected = selectedPath === entry.fullPath;
              return (
                <button
                  key={entry.fullPath}
                  type="button"
                  onClick={() => {
                    if (entry.isDirectory) {
                      setSelectedPath(entry.fullPath);
                    } else if (request.mode === 'file') {
                      setSelectedPath(entry.fullPath);
                    }
                  }}
                  onDoubleClick={() => {
                    if (entry.isDirectory) {
                      void loadPath(entry.fullPath);
                    } else if (request.mode === 'file') {
                      request.onSelect(entry.fullPath);
                      onClose();
                    }
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-5 py-2.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-indigo-500/15 text-indigo-200'
                      : 'text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {entry.isDirectory ? (
                      isSelected ? (
                        <FolderOpen className="w-4 h-4 text-indigo-400 shrink-0" />
                      ) : (
                        <Folder className="w-4 h-4 text-slate-400 shrink-0" />
                      )
                    ) : (
                      <FileCode2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    )}
                    <span className="text-sm truncate font-mono">{entry.name}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {!entry.isDirectory && (
                      <span className="text-xs font-mono tabular-nums text-slate-400">
                        {formatBytes(entry.sizeBytes)}
                      </span>
                    )}
                    {entry.isDirectory && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          void loadPath(entry.fullPath);
                        }}
                        className="text-xs text-slate-400 hover:text-indigo-300 px-2 py-0.5 rounded bg-slate-800/70"
                      >
                        Открыть
                      </span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-4 px-5 py-3.5 border-t border-slate-800 bg-[#0B1120]">
          <p className="text-xs text-slate-400 font-mono truncate">
            {selectedPath ? selectedPath : 'Выберите элемент'}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-lg text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              Отмена
            </button>
            <button
              type="button"
              disabled={!selectedPath && request.mode === 'file'}
              onClick={handleConfirm}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              <Check className="w-3.5 h-3.5" />
              Выбрать
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
