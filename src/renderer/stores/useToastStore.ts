import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastStore {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],

  showToast: (message: string, type: ToastType = 'info', duration: number = 4000) => {
    // Defence in depth. Toast text is rendered as a React child, and a non-string
    // throws in render — with only an app-level ErrorBoundary above, that takes
    // the window down. The plugin bridge coerces before it gets here
    // (sandbox/SandboxedPluginManager.toDisplayText), but a toast can be raised
    // from anywhere, and no caller is worth crashing the app over.
    if (typeof message !== 'string') {
      // eslint-disable-next-line no-console
      console.warn('[toast] non-string message coerced', message);
      message = (message as unknown) === null || message === undefined ? '' : String(message);
    }
    const id = `toast-${Date.now()}-${Math.random()}`;
    const toast: Toast = { id, message, type, duration };

    set((state) => ({
      toasts: [...state.toasts, toast],
    }));

    // Auto-remove after duration
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, duration);
    }
  },

  removeToast: (id: string) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },

  clearToasts: () => {
    set({ toasts: [] });
  },
}));
