import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuthSession, AuthUser, PublicConfig, SetupRequest } from '../../../shared/types';
import { api, session } from '../api/client';
import { configureFormatting } from '../utils/format';
import SignInAnimation, { prefersReducedMotion } from '../components/SignInAnimation';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: Status;
  user: AuthUser | null;
  config: PublicConfig | null;
  /** EDITOR or ADMINISTRATOR: may change data. */
  canEdit: boolean;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  setup: (r: SetupRequest) => Promise<void>;
  /** Installs a session returned by another call (e.g. a password change). */
  applySession: (s: AuthSession) => void;
  updateUser: (u: AuthUser) => void;
  signOut: () => Promise<void>;
  signOutEverywhere: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

// Lets other tabs know when this one signs out.
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('parsimony-auth');

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Set while the post-sign-in animation plays; `reveal` installs the new session once the overlay hides the form.
  const [intro, setIntro] = useState<{ reveal: () => void } | null>(null);

  useEffect(() => {
    const unsubscribe = session.subscribe((s) => {
      clearTimeout(timer.current);
      if (s) {
        setUser(s.user);
        setStatus('signedIn');
        // Refresh a minute before the access token expires.
        timer.current = setTimeout(() => void session.refresh(), Math.max(10, s.expiresIn - 60) * 1000);
      } else {
        setUser(null);
        setStatus('signedOut');
      }
    });
    const onMessage = (e: MessageEvent) => {
      if (e.data === 'signed-out') session.set(null);
    };
    channel?.addEventListener('message', onMessage);

    api
      .config()
      .then((c) => {
        configureFormatting(c.locale, c.currency);
        setConfig(c);
      })
      .catch(() => undefined)
      .finally(() => void session.refresh());

    return () => {
      unsubscribe();
      channel?.removeEventListener('message', onMessage);
      clearTimeout(timer.current);
    };
  }, []);

  /** Signs in with the logo animation, or straight away when the user prefers reduced motion. */
  const welcome = useCallback((reveal: () => void) => {
    if (prefersReducedMotion()) reveal();
    else setIntro({ reveal });
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const s = await api.auth.login({ email, password });
      welcome(() => session.set(s));
    },
    [welcome],
  );

  const setup = useCallback(
    async (r: SetupRequest) => {
      const s = await api.auth.setup(r);
      welcome(() => {
        session.set(s);
        setConfig((c) => (c ? { ...c, setupRequired: false } : c));
      });
    },
    [welcome],
  );

  const endIntro = useCallback(() => setIntro(null), []);

  const end = useCallback(async (call: () => Promise<void>) => {
    try {
      await call();
    } finally {
      session.set(null);
      channel?.postMessage('signed-out');
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      config,
      canEdit: user?.role === 'ADMINISTRATOR' || user?.role === 'EDITOR',
      isAdmin: user?.role === 'ADMINISTRATOR',
      signIn,
      setup,
      applySession: (s) => session.set(s),
      updateUser: (u) => setUser(u),
      signOut: () => end(() => api.auth.logout()),
      signOutEverywhere: () => end(() => api.auth.logoutAll()),
    }),
    [status, user, config, signIn, setup, end],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {intro && <SignInAnimation onCovered={intro.reveal} onDone={endIntro} />}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
