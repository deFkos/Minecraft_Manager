import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  CheckCircle2,
  Cpu,
  FolderOpen,
  Search,
  Send,
  Shield,
  ShieldOff,
  Trash2,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import type {
  LogEntry,
  LogLevel,
  ServerConfig,
  ServerRuntimeState,
} from '../../shared/types';

interface ConsoleServerViewProps {
  logs: LogEntry[];
  runtime: ServerRuntimeState;
  config: ServerConfig;
  onSendCommand: (command: string) => Promise<void>;
  onClearLogs: () => Promise<void>;
  onUpdateConfig: (patch: Partial<ServerConfig>) => Promise<void>;
  onPickDirectory: (title: string, initialPath: string, onSelect: (path: string) => void) => void;
  onPickFile: (
    title: string,
    initialPath: string,
    extension: string,
    onSelect: (path: string) => void
  ) => void;
  onToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

const USERNAME_REGEX = /^[A-Za-z0-9_]{3,16}$/;

export function ConsoleServerView({
  logs,
  runtime,
  config,
  onSendCommand,
  onClearLogs,
  onUpdateConfig,
  onPickDirectory,
  onPickFile,
  onToast,
}: ConsoleServerViewProps) {
  const [commandInput, setCommandInput] = useState('');
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [logFilter, setLogFilter] = useState<'ALL' | 'WARN' | 'ERROR'>('ALL');
  const [logSearch, setLogSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);

  // Quick player actions
  const [nickname, setNickname] = useState('');
  const [nickError, setNickError] = useState<string | null>(null);

  // Launch settings form state
  const [serverDir, setServerDir] = useState(config.serverDir);
  const [jarFile, setJarFile] = useState(config.jarFile);
  const [javaPath, setJavaPath] = useState(config.javaPath);
  const [xmsMb, setXmsMb] = useState(config.xmsMb);
  const [xmxMb, setXmxMb] = useState(config.xmxMb);
  const [savingConfig, setSavingConfig] = useState(false);

  const consoleEndRef = useRef<HTMLDivElement | null>(null);
  const consoleScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setServerDir(config.serverDir);
    setJarFile(config.jarFile);
    setJavaPath(config.javaPath);
    setXmsMb(config.xmsMb);
    setXmxMb(config.xmxMb);
  }, [config]);

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return logs.filter((entry) => {
      if (logFilter === 'WARN' && entry.level !== 'WARN') return false;
      if (logFilter === 'ERROR' && entry.level !== 'ERROR') return false;
      if (q && !entry.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, logFilter, logSearch]);

  useEffect(() => {
    if (autoScroll) {
      consoleEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [filteredLogs, autoScroll]);

  const handleConsoleScroll = () => {
    const el = consoleScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 48 && autoScroll) {
      setAutoScroll(false);
    } else if (distanceFromBottom <= 20 && !autoScroll) {
      setAutoScroll(true);
    }
  };

  const handleCommandSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = commandInput.trim();
    if (!trimmed) return;
    setCmdHistory((prev) => [trimmed, ...prev.slice(0, 49)]);
    setHistoryIndex(-1);
    setCommandInput('');
    await onSendCommand(trimmed);
  };

  const handleCommandKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdHistory.length === 0) return;
      const nextIdx = Math.min(historyIndex + 1, cmdHistory.length - 1);
      setHistoryIndex(nextIdx);
      setCommandInput(cmdHistory[nextIdx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setCommandInput('');
      } else {
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        setCommandInput(cmdHistory[nextIdx]);
      }
    }
  };

  const runPlayerCommand = async (action: 'whitelist-add' | 'whitelist-remove' | 'op' | 'deop') => {
    const cleaned = nickname.trim();
    if (!USERNAME_REGEX.test(cleaned)) {
      setNickError('Никнейм: 3–16 символов (латиница, цифры, _).');
      return;
    }
    setNickError(null);

    const commandMap = {
      'whitelist-add': `whitelist add ${cleaned}`,
      'whitelist-remove': `whitelist remove ${cleaned}`,
      op: `op ${cleaned}`,
      deop: `deop ${cleaned}`,
    };
    await onSendCommand(commandMap[action]);
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (xmsMb > xmxMb) {
      onToast('error', 'Ошибка параметров памяти', 'Xms не может быть больше Xmx.');
      return;
    }
    setSavingConfig(true);
    try {
      await onUpdateConfig({
        serverDir: serverDir.trim(),
        jarFile: jarFile.trim(),
        javaPath: javaPath.trim(),
        xmsMb,
        xmxMb,
      });
      onToast('success', 'Параметры запуска сохранены', `Память: ${xmsMb} МБ — ${xmxMb} МБ`);
    } finally {
      setSavingConfig(false);
    }
  };

  const isRunning = runtime.status === 'online' || runtime.status === 'starting';

  const getLogTextClass = (level: LogLevel) => {
    switch (level) {
      case 'ERROR':
        return 'text-red-400';
      case 'WARN':
        return 'text-amber-300';
      case 'CMD':
        return 'text-indigo-300 font-medium';
      case 'SYSTEM':
        return 'text-slate-400';
      default:
        return 'text-slate-200';
    }
  };

  const configDirty =
    serverDir !== config.serverDir ||
    jarFile !== config.jarFile ||
    javaPath !== config.javaPath ||
    xmsMb !== config.xmsMb ||
    xmxMb !== config.xmxMb;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Main Real-time Console Column */}
      <section className="xl:col-span-8 rounded-xl bg-[#111827] border border-slate-800 overflow-hidden flex flex-col">
        {/* Console toolbar */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-sm font-semibold text-slate-100 whitespace-nowrap">
              Консоль в реальном времени
            </h2>
            <span className="text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap">
              {filteredLogs.length} / {logs.length} строк
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Level segmented filter */}
            <div
              role="group"
              aria-label="Фильтр уровня логов"
              className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[#0B1120] border border-slate-800"
            >
              {(['ALL', 'WARN', 'ERROR'] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setLogFilter(lvl)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                    logFilter === lvl
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {lvl === 'ALL' ? 'Все' : lvl}
                </button>
              ))}
            </div>

            {/* Search input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Поиск в логе..."
                className="w-40 pl-8 pr-2.5 py-1.5 rounded-lg bg-[#0B1120] border border-slate-800 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>

            <button
              type="button"
              onClick={() => {
                setAutoScroll(true);
                consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
              }}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${
                autoScroll
                  ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300'
                  : 'bg-[#0B1120] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <ArrowDown className="w-3.5 h-3.5" />
              Автоскролл
            </button>

            <button
              type="button"
              onClick={() => void onClearLogs()}
              aria-label="Очистить консоль"
              className="p-1.5 rounded-lg bg-[#0B1120] border border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Monospace terminal viewport */}
        <div
          ref={consoleScrollRef}
          onScroll={handleConsoleScroll}
          className="h-[460px] bg-[#070B14] overflow-y-auto p-4 font-mono text-[12.5px] leading-[1.65] tabular-nums"
        >
          {filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <p className="text-sm text-slate-400 font-sans">
                {logs.length === 0
                  ? 'Журнал пуст. Нажмите «Старт» в верхней панели, чтобы запустить сервер Minecraft.'
                  : 'Нет записей, соответствующих текущему фильтру.'}
              </p>
              {logs.length === 0 && (
                <p className="text-xs text-slate-500 font-sans mt-1.5">
                  Перед запуском автоматически проверяется и создается файл eula.txt (eula=true).
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filteredLogs.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2.5 break-all hover:bg-slate-900/50 px-1.5 py-0.5 rounded"
                >
                  <span className="text-slate-600 shrink-0 select-none">{entry.timestamp}</span>
                  <span
                    className={`w-12 shrink-0 text-[11px] font-semibold select-none ${
                      entry.level === 'ERROR'
                        ? 'text-red-500'
                        : entry.level === 'WARN'
                          ? 'text-amber-400'
                          : entry.level === 'CMD'
                            ? 'text-indigo-400'
                            : 'text-slate-500'
                    }`}
                  >
                    {entry.level}
                  </span>
                  <span className={getLogTextClass(entry.level)}>{entry.message}</span>
                </div>
              ))}
              <div ref={consoleEndRef} />
            </div>
          )}
        </div>

        {/* Stdin command bar */}
        <form
          onSubmit={(e) => void handleCommandSubmit(e)}
          className="px-4 py-3 bg-[#0B1120] border-t border-slate-800 flex items-center gap-2.5"
        >
          <span className="font-mono text-indigo-400 text-sm select-none">&gt;</span>
          <input
            type="text"
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            onKeyDown={handleCommandKeyDown}
            disabled={!isRunning}
            placeholder={
              isRunning
                ? 'Введите команду сервера (help, list, tps, say Привет, stop)...'
                : 'Запустите сервер для отправки команд в stdin...'
            }
            className="flex-1 bg-transparent text-sm font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!isRunning || !commandInput.trim()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            Отправить
          </button>
        </form>
      </section>

      {/* Right Column: Quick Player Actions + JVM Launch Settings */}
      <div className="xl:col-span-4 space-y-6">
        {/* Quick Player Management */}
        <section className="rounded-xl bg-[#111827] border border-slate-800 p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Управление игроками</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Быстрые команды в stdin запущенного сервера
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="player-nickname" className="block text-xs font-medium text-slate-300">
              Никнейм игрока
            </label>
            <input
              id="player-nickname"
              type="text"
              value={nickname}
              onChange={(e) => {
                setNickname(e.target.value);
                if (nickError) setNickError(null);
              }}
              placeholder="Например, Steve_2026"
              className="w-full px-3 py-2 rounded-lg bg-[#0B1120] border border-slate-800 text-sm font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
            />
            {nickError && <p className="text-xs text-red-400">{nickError}</p>}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!isRunning}
              onClick={() => void runPlayerCommand('whitelist-add')}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              <UserPlus className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              В белый список
            </button>
            <button
              type="button"
              disabled={!isRunning}
              onClick={() => void runPlayerCommand('whitelist-remove')}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              <UserMinus className="w-3.5 h-3.5 text-red-400 shrink-0" />
              Удалить
            </button>
            <button
              type="button"
              disabled={!isRunning}
              onClick={() => void runPlayerCommand('op')}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              <Shield className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              Выдать OP
            </button>
            <button
              type="button"
              disabled={!isRunning}
              onClick={() => void runPlayerCommand('deop')}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              <ShieldOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              Снять OP
            </button>
          </div>

          {/* Current whitelist & ops summary */}
          <div className="pt-3 border-t border-slate-800/80 space-y-2 text-xs">
            <div className="flex items-start justify-between gap-2">
              <span className="text-slate-500 shrink-0">Белый список:</span>
              <div className="flex flex-wrap justify-end gap-x-2 gap-y-1 font-mono text-slate-300">
                {runtime.players.whitelist.length === 0 ? (
                  <span className="text-slate-500 font-sans">пусто</span>
                ) : (
                  runtime.players.whitelist.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setNickname(name)}
                      className="hover:text-indigo-300 underline-offset-2 hover:underline"
                    >
                      {name}
                    </button>
                  ))
                )}
              </div>
            </div>
            <div className="flex items-start justify-between gap-2">
              <span className="text-slate-500 shrink-0">Операторы (OP):</span>
              <div className="flex flex-wrap justify-end gap-x-2 gap-y-1 font-mono text-indigo-300">
                {runtime.players.ops.length === 0 ? (
                  <span className="text-slate-500 font-sans">нет</span>
                ) : (
                  runtime.players.ops.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setNickname(name)}
                      className="hover:text-indigo-200 underline-offset-2 hover:underline"
                    >
                      {name}
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Server Launch Settings (RAM Xms/Xmx, JAR Core, Java Path) */}
        <form
          onSubmit={(e) => void handleSaveConfig(e)}
          className="rounded-xl bg-[#111827] border border-slate-800 p-5 space-y-4"
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Параметры запуска и JVM</h2>
              <p className="text-xs text-slate-400 mt-0.5">RAM (Xms/Xmx), ядро JAR и путь к Java</p>
            </div>
            <Cpu className="w-4 h-4 text-slate-500 shrink-0" />
          </div>

          {/* EULA status */}
          <div className="flex items-center justify-between text-xs py-2 border-y border-slate-800/80">
            <span className="text-slate-400">Файл eula.txt</span>
            <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {runtime.eulaAccepted ? 'Принято (eula=true)' : 'Автосоздание при старте'}
            </span>
          </div>

          {/* RAM controls */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="ram-xms" className="text-slate-300 font-medium">
                  Память Xms
                </label>
                <span className="font-mono tabular-nums text-slate-400">
                  {(xmsMb / 1024).toFixed(1)} ГБ
                </span>
              </div>
              <input
                id="ram-xms"
                type="number"
                min={512}
                max={65536}
                step={512}
                value={xmsMb}
                onChange={(e) => setXmsMb(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg bg-[#0B1120] border border-slate-800 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="ram-xmx" className="text-slate-300 font-medium">
                  Память Xmx
                </label>
                <span className="font-mono tabular-nums text-slate-400">
                  {(xmxMb / 1024).toFixed(1)} ГБ
                </span>
              </div>
              <input
                id="ram-xmx"
                type="number"
                min={512}
                max={65536}
                step={512}
                value={xmxMb}
                onChange={(e) => setXmxMb(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg bg-[#0B1120] border border-slate-800 text-xs font-mono tabular-nums text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Server directory */}
          <div className="space-y-1.5">
            <label htmlFor="server-dir" className="block text-xs font-medium text-slate-300">
              Директория сервера
            </label>
            <div className="flex gap-1.5">
              <input
                id="server-dir"
                type="text"
                value={serverDir}
                onChange={(e) => setServerDir(e.target.value)}
                className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-[#0B1120] border border-slate-800 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
              />
              <button
                type="button"
                onClick={() =>
                  onPickDirectory('Выбрать директорию сервера', serverDir, (p) => setServerDir(p))
                }
                aria-label="Выбрать директорию сервера"
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition-colors shrink-0"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* JAR core file */}
          <div className="space-y-1.5">
            <label htmlFor="jar-file" className="block text-xs font-medium text-slate-300">
              JAR-файл ядра сервера
            </label>
            <div className="flex gap-1.5">
              <input
                id="jar-file"
                type="text"
                value={jarFile}
                onChange={(e) => setJarFile(e.target.value)}
                className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-[#0B1120] border border-slate-800 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
              />
              <button
                type="button"
                onClick={() =>
                  onPickFile('Выбрать JAR-файл сервера', jarFile, '.jar', (p) => setJarFile(p))
                }
                aria-label="Выбрать JAR-файл сервера"
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition-colors shrink-0"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Java path */}
          <div className="space-y-1.5">
            <label htmlFor="java-path" className="block text-xs font-medium text-slate-300">
              Путь к Java (JDK 21)
            </label>
            <input
              id="java-path"
              type="text"
              value={javaPath}
              onChange={(e) => setJavaPath(e.target.value)}
              placeholder="java"
              className="w-full px-3 py-1.5 rounded-lg bg-[#0B1120] border border-slate-800 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <button
            type="submit"
            disabled={!configDirty || savingConfig}
            className="w-full py-2 px-4 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {savingConfig ? 'Сохранение...' : 'Сохранить параметры запуска'}
          </button>
        </form>
      </div>
    </div>
  );
}
