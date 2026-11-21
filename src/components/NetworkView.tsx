import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, FileText, Globe, Save } from 'lucide-react';
import type { NetworkSettings } from '../../shared/types';

interface NetworkViewProps {
  network: NetworkSettings;
  onSaveNetwork: (serverIp: string, serverPort: number) => Promise<void>;
  onToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

const IPV4_REGEX =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME_REGEX =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function NetworkView({ network, onSaveNetwork, onToast }: NetworkViewProps) {
  const initialIp = network.shareIp ?? network.serverIp;
  const [serverIp, setServerIp] = useState(initialIp);
  const [portText, setPortText] = useState(String(network.serverPort));
  const [saving, setSaving] = useState(false);
  const [copiedJustNow, setCopiedJustNow] = useState(false);

  useEffect(() => {
    setServerIp(network.shareIp ?? network.serverIp);
    setPortText(String(network.serverPort));
  }, [network.shareIp, network.serverIp, network.serverPort]);

  const ipError = useMemo(() => {
    const trimmed = serverIp.trim();
    if (!trimmed) return null;
    if (!IPV4_REGEX.test(trimmed) && !HOSTNAME_REGEX.test(trimmed)) {
      return 'Укажите корректный IPv4-адрес, домен или оставьте пустым для всех интерфейсов.';
    }
    return null;
  }, [serverIp]);

  const portError = useMemo(() => {
    if (!/^\d+$/.test(portText.trim())) {
      return 'Порт должен содержать только цифры.';
    }
    const num = Number(portText.trim());
    if (num < 1 || num > 65535) {
      return 'Допустимый диапазон портов: 1–65535 (по умолчанию 25565).';
    }
    return null;
  }, [portText]);

  const isValid = !ipError && !portError;
  const parsedPort = Number(portText.trim()) || 25565;
  const trimmedIp = serverIp.trim();
  const displayAddress = `${trimmedIp || '127.0.0.1'}:${parsedPort}`;

  const localIps = network.localIps ?? [];
  const isNonLocalExternalIp = useMemo(() => {
    if (!trimmedIp || ipError) return false;
    const lower = trimmedIp.toLowerCase();
    if (lower === '0.0.0.0' || lower === '127.0.0.1' || lower === 'localhost') return false;
    if (localIps.length === 0) return false;
    return !localIps.includes(trimmedIp);
  }, [trimmedIp, ipError, localIps]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    setSaving(true);
    try {
      await onSaveNetwork(trimmedIp, parsedPort);
      onToast(
        'success',
        'Настройки сети сохранены',
        isNonLocalExternalIp
          ? `Адрес для друзей ${displayAddress} запомнен; в server.properties записан бинд 0.0.0.0:${parsedPort}`
          : `Сохранены значения server-ip=${trimmedIp || '(все)'} и server-port=${parsedPort}`
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCopyAddress = async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(displayAddress);
      } else {
        const temp = document.createElement('textarea');
        temp.value = displayAddress;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
      }
      setCopiedJustNow(true);
      onToast('success', 'Скопировано!', `Адрес ${displayAddress} помещен в буфер обмена`);
      setTimeout(() => setCopiedJustNow(false), 1800);
    } catch {
      onToast('error', 'Не удалось скопировать', `Скопируйте вручную: ${displayAddress}`);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Left: Network settings + Warning Callout */}
      <div className="xl:col-span-7 space-y-6">
        <form
          onSubmit={(e) => void handleSave(e)}
          className="rounded-xl bg-[#111827] border border-slate-800 p-6 space-y-5"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-100">Настройка сети сервера</h2>
              <p className="text-xs text-slate-400 mt-1">
                Изменения сохраняются постоянно и автоматически применяются в <span className="font-mono text-slate-300">server.properties</span>
              </p>
            </div>
            <Globe className="w-5 h-5 text-indigo-400 shrink-0" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2 space-y-1.5">
              <label htmlFor="network-ip" className="block text-xs font-medium text-slate-300">
                IP-адрес сервера (<span className="font-mono text-slate-400">server-ip</span>)
              </label>
              <input
                id="network-ip"
                type="text"
                value={serverIp}
                onChange={(e) => setServerIp(e.target.value)}
                placeholder="Пусто (0.0.0.0 — рекомендуется) или IP Radmin VPN"
                className={`w-full px-3.5 py-2.5 rounded-lg bg-[#0B1120] border text-sm font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none transition-colors ${
                  ipError
                    ? 'border-red-500/70 focus:border-red-400'
                    : isNonLocalExternalIp
                      ? 'border-amber-500/60 focus:border-amber-400'
                      : 'border-slate-800 focus:border-indigo-500'
                }`}
              />
              {ipError ? (
                <p className="text-xs text-red-400">{ipError}</p>
              ) : isNonLocalExternalIp ? (
                <p className="text-xs text-amber-300 leading-relaxed">
                  Внешний IP <span className="font-mono">{trimmedIp}</span> сохраняется для друзей (<span className="font-mono">{displayAddress}</span>), а в <span className="font-mono">server.properties</span> автоматически пишется <span className="font-mono">server-ip=</span> (<span className="font-mono">0.0.0.0</span>), чтобы сервер запускался без <span className="font-mono">BindException</span>.
                </p>
              ) : (
                <p className="text-xs text-slate-500">
                  Оставьте пустым (<span className="font-mono">0.0.0.0</span>) для прослушивания всех сетевых интерфейсов, либо выберите локальный/VPN IP ниже.
                </p>
              )}

              {localIps.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setServerIp('')}
                    className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
                      trimmedIp === ''
                        ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-200'
                        : 'bg-[#0B1120] border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Все (0.0.0.0)
                  </button>
                  {localIps
                    .filter((ip) => ip !== '0.0.0.0' && ip !== '127.0.0.1')
                    .map((ip) => (
                      <button
                        key={ip}
                        type="button"
                        onClick={() => setServerIp(ip)}
                        className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
                          trimmedIp === ip
                            ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-200'
                            : 'bg-[#0B1120] border-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {ip}
                      </button>
                    ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="network-port" className="block text-xs font-medium text-slate-300">
                Порт (<span className="font-mono text-slate-400">server-port</span>)
              </label>
              <input
                id="network-port"
                type="text"
                inputMode="numeric"
                value={portText}
                onChange={(e) => setPortText(e.target.value)}
                placeholder="25565"
                className={`w-full px-3.5 py-2.5 rounded-lg bg-[#0B1120] border text-sm font-mono tabular-nums text-slate-100 placeholder:text-slate-500 focus:outline-none transition-colors ${
                  portError
                    ? 'border-red-500/70 focus:border-red-400'
                    : 'border-slate-800 focus:border-indigo-500'
                }`}
              />
              {portError ? (
                <p className="text-xs text-red-400">{portError}</p>
              ) : (
                <p className="text-xs text-slate-500">Стандартный порт: 25565</p>
              )}
            </div>
          </div>

          {/* Share address preview & buttons */}
          <div className="pt-4 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="text-xs text-slate-500 block">Адрес для подключения</span>
              <span className="font-mono text-sm font-medium text-slate-100 tabular-nums">
                {displayAddress}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={!isValid}
                onClick={() => void handleCopyAddress()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                {copiedJustNow ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    Скопировано!
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-300" />
                    Скопировать адрес для друзей
                  </>
                )}
              </button>

              <button
                type="submit"
                disabled={!isValid || saving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? 'Сохранение...' : 'Сохранить в server.properties'}
              </button>
            </div>
          </div>
        </form>

        {/* Required Informational Alert / Callout (clean hairline border, no thick left bar) */}
        <aside
          role="note"
          aria-label="Важная информация о сетевом подключении"
          className="rounded-xl bg-amber-500/[0.06] border border-amber-500/25 p-5 flex items-start gap-3.5"
        >
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <h3 className="text-sm font-semibold text-amber-200">
              Доступность сервера из интернета
            </h3>
            <p className="text-sm text-slate-300 leading-relaxed">
              Внимание: для игры через интернет ваш IP должен быть публичным (белым) с открытыми
              портами. В противном случае подключение возможно только внутри одной локальной сети
              или через VPN-сервисы для локальных сетей (Radmin VPN, Hamachi, ZeroTier).
            </p>
          </div>
        </aside>
      </div>

      {/* Right: Live server.properties inspection */}
      <section className="xl:col-span-5 rounded-xl bg-[#111827] border border-slate-800 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-100">Файл server.properties</h2>
            <p className="text-xs text-slate-500 font-mono truncate mt-0.5">
              {network.propertiesPath}
            </p>
          </div>
          <FileText className="w-4 h-4 text-slate-500 shrink-0" />
        </div>

        <div className="p-4 bg-[#070B14] font-mono text-xs leading-6 overflow-x-auto max-h-[420px] overflow-y-auto">
          {network.rawPreview.split(/\r?\n/).map((line, index) => {
            const isHighlighted =
              line.trim().startsWith('server-ip=') || line.trim().startsWith('server-port=');
            const isComment = line.trim().startsWith('#');
            return (
              <div
                key={`${index}-${line}`}
                className={`px-2 rounded ${
                  isHighlighted
                    ? 'bg-indigo-500/15 text-indigo-200 font-medium'
                    : isComment
                      ? 'text-slate-500'
                      : 'text-slate-300'
                }`}
              >
                <span className="inline-block w-7 text-slate-600 select-none tabular-nums">
                  {index + 1}
                </span>
                <span>{line || ' '}</span>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 text-xs text-slate-400 flex items-center justify-between">
          <span>Сохранено ключей: {network.otherKeysCount + (network.fileExists ? 2 : 0)}</span>
          <span className={network.fileExists ? 'text-emerald-400' : 'text-amber-400'}>
            {network.fileExists ? 'Файл синхронизирован с диском' : 'Будет создан при сохранении'}
          </span>
        </div>
      </section>
    </div>
  );
}
