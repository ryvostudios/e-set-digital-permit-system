import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Transient confirmations ("Permit submitted", "Permission granted").
 *
 * Rendered into an `aria-live="polite"` region so the outcome of an
 * action is announced, not just seen. Toasts confirm what happened; they
 * are never the only place an error appears - a failed action also shows
 * an inline message on the screen that failed.
 */

export type ToastTone = 'success' | 'danger' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_DURATION_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const dismissTimers = useRef(new Set<ReturnType<typeof globalThis.setTimeout>>());

  useEffect(() => {
    const timers = dismissTimers.current;
    return () => {
      for (const timer of timers) {
        globalThis.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const show = useCallback((message: string, tone: ToastTone = 'success') => {
    nextId.current += 1;
    const id = nextId.current;
    setToasts((current) => [...current, { id, tone, message }]);
    const timer = globalThis.setTimeout(() => {
      dismissTimers.current.delete(timer);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);
    dismissTimers.current.add(timer);
  }, []);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  // A missing provider must not break a screen: confirmations are a
  // convenience, and every action also reports its outcome inline.
  return context ?? { show: () => {} };
}
