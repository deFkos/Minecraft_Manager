import { Boxes, Globe, Laptop, Package, Terminal } from 'lucide-react';
import type { RuntimeEnvironment, WorkspaceMode } from '../../shared/types';

export type ActiveTab = 'console' | 'network' | 'mods' | 'client';

interface SidebarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  environment: RuntimeEnvironment;
  platform: string;
  mode: WorkspaceMode;
  onSwitchMode: (mode: WorkspaceMode) => void;
  modsCount: number;
  unsyncedModsCount: number;
}

const NAV_ITEMS: Array<{
  id: ActiveTab;
  label: string;
  subtitle: string;
  icon: typeof Terminal;
}> = [
  {
    id: 'console',
    label: 'Консоль и сервер',
    subtitle: 'Журнал, игроки, JVM',
    icon: Terminal,
  },
  {
    id: 'network',
    label: 'Сеть и свойства',
    subtitle: 'IP, порт, server.properties',
    icon: Globe,
  },
  {
    id: 'mods',
    label: 'Моды сервера',
    subtitle: 'Синхронизация .jar',
    icon: Package,
  },
  {
    id: 'client',
    label: 'Клиент / TLauncher',
    subtitle: 'NeoForge 1.21.1',
    icon: Laptop,
  },
];

export function Sidebar({
  activeTab,
  onSelectTab,
  environment,
  platform,
  mode,
  onSwitchMode,
  modsCount,
  unsyncedModsCount,
}: SidebarProps) {
  const osLabel =
    platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';

  return (
    <aside className="w-[248px] shrink-0 bg-[#0E1526] border-r border-slate-800/90 flex flex-col select-none">
      {/* Brand header */}
      <div className="h-14 px-5 flex items-center gap-3 border-b border-slate-800/90 app-drag-region">
        <div className="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center shrink-0">
          <Boxes className="w-4 h-4 text-white" />
        </div>
        <span className="font-semibold text-[15px] tracking-tight text-slate-100 whitespace-nowrap truncate">
          NeoCraft Control
        </span>
      </div>

      {/* Navigation */}
      <nav aria-label="Разделы управления" className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                isActive
                  ? 'bg-indigo-500/15 text-white'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Icon
                className={`w-[18px] h-[18px] shrink-0 ${
                  isActive ? 'text-indigo-400' : 'text-slate-500'
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium whitespace-nowrap truncate">
                    {item.label}
                  </span>
                  {item.id === 'mods' && unsyncedModsCount > 0 && (
                    <span className="text-[11px] font-mono tabular-nums text-amber-400">
                      +{unsyncedModsCount}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500 truncate mt-0.5">{item.subtitle}</p>
              </div>
            </button>
          );
        })}
      </nav>

      {/* Compact environment metadata footer */}
      <div className="px-4 py-3.5 border-t border-slate-800/90 text-xs text-slate-400 space-y-2">
        {environment === 'electron' && (
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#0B1120] border border-slate-800">
            <button
              type="button"
              onClick={() => onSwitchMode('native')}
              className={`flex-1 py-1 rounded-md text-[11px] font-medium transition-colors ${
                mode === 'native'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Реальный ПК
            </button>
            <button
              type="button"
              onClick={() => onSwitchMode('sandbox')}
              className={`flex-1 py-1 rounded-md text-[11px] font-medium transition-colors ${
                mode === 'sandbox'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Песочница
            </button>
          </div>
        )}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Среда</span>
            <span className="font-mono text-slate-300">
              {environment === 'electron' ? 'Electron IPC' : 'Web Песочница'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Платформа</span>
            <span className="font-mono text-slate-300">
              {osLabel} · {mode === 'sandbox' ? 'Sandbox' : 'Native'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Модов на сервере</span>
            <span className="font-mono tabular-nums text-slate-300">{modsCount} .jar</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
