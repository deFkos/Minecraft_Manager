import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  description?: string;
}

interface ToastContainerProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none"
    >
      {toasts.map((toast) => {
        const Icon =
          toast.type === 'success'
            ? CheckCircle2
            : toast.type === 'error'
              ? AlertCircle
              : Info;

        const iconColor =
          toast.type === 'success'
            ? 'text-emerald-400'
            : toast.type === 'error'
              ? 'text-red-400'
              : 'text-indigo-400';

        const borderColor =
          toast.type === 'success'
            ? 'border-emerald-500/30'
            : toast.type === 'error'
              ? 'border-red-500/30'
              : 'border-slate-700';

        return (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto flex items-start gap-3 rounded-lg bg-[#162032] border ${borderColor} px-4 py-3 shadow-xl shadow-black/40 transition-all duration-150`}
          >
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${iconColor}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-100 leading-snug">{toast.title}</p>
              {toast.description && (
                <p className="text-xs text-slate-400 mt-0.5 leading-relaxed break-words">
                  {toast.description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Закрыть уведомление"
              className="text-slate-400 hover:text-slate-200 transition-colors p-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
