import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { FlashbarProps } from '@cloudscape-design/components/flashbar';
import type { Meta } from '../../../shared/types';
import { api } from '../api/client';
import { useAsync } from '../hooks/useAsync';
import { errorMessage } from '../utils/format';

type NotifyType = 'success' | 'error' | 'warning' | 'info';

interface AppContextValue {
  notifications: FlashbarProps.MessageDefinition[];
  notify: (type: NotifyType, content: ReactNode, header?: string) => void;
  notifyError: (e: unknown, header?: string) => void;
  meta: Meta | undefined;
  reloadMeta: () => void;
}

const Ctx = createContext<AppContextValue | null>(null);

let nextId = 0;

export function AppProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<FlashbarProps.MessageDefinition[]>([]);
  const meta = useAsync(() => api.meta(), []);

  const notify = useCallback((type: NotifyType, content: ReactNode, header?: string) => {
    const id = `n${++nextId}`;
    const dismiss = () => setNotifications((items) => items.filter((i) => i.id !== id));
    setNotifications((items) => [...items.slice(-4), { id, type, content, header, dismissible: true, onDismiss: dismiss }]);
    if (type === 'success' || type === 'info') setTimeout(dismiss, 6000);
  }, []);

  const notifyError = useCallback((e: unknown, header = 'Something went wrong') => notify('error', errorMessage(e), header), [notify]);

  const value = useMemo(
    () => ({ notifications, notify, notifyError, meta: meta.data, reloadMeta: meta.reload }),
    [notifications, notify, notifyError, meta.data, meta.reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside AppProvider');
  return v;
}
