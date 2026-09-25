import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CircleCheck, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  leaving?: boolean;
}

interface ToastApi {
  show: (message: string, type?: ToastType) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast は ToastProvider の内側で使用してください');
  return ctx;
}

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CircleCheck size={16} className="text-ok" />,
  error: <AlertTriangle size={16} className="text-danger" />,
  info: <Info size={16} className="text-ink-mute" />,
};
const STYLES: Record<ToastType, string> = {
  success: 'border-ok/30 bg-ok-soft text-ok',
  error: 'border-danger/30 bg-danger-soft text-danger',
  info: 'border-rule bg-surface text-ink',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    // leaving フラグでフェードアウトさせてから除去
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const show = useCallback(
    (message: string, type: ToastType = 'info') => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-4), { id, type, message }]);
      window.setTimeout(() => dismiss(id), type === 'error' ? 8000 : 4500);
    },
    [dismiss],
  );

  const api: ToastApi = {
    show,
    success: (m) => show(m, 'success'),
    error: (m) => show(m, 'error'),
    info: (m) => show(m, 'info'),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-14 right-4 z-[100] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg transition-all duration-200 ${STYLES[t.type]} ${
              t.leaving ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100'
            }`}
            role="status"
          >
            <span className="mt-0.5 shrink-0">{ICONS[t.type]}</span>
            <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
              title="閉じる"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
