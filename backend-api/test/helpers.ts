import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import type { Mailer } from '../src/auth/mailer';
import { seedDemoData, type DemoIds } from '../src/services/demo-data';

export const ADMIN = { email: 'admin@example.test', password: 'admin-password-1' };

export interface Sent {
  to: string;
  subject: string;
  text: string;
}

export interface TestApp {
  app: App;
  config: Config;
  base: string;
  dir: string;
  ids: DemoIds | null;
  mail: Sent[];
  api: <T = any>(method: string, url: string, body?: unknown, opts?: RequestOpts) => Promise<{ status: number; data: T; headers: Headers }>;
  /** Signs in and returns the access token and refresh cookie. */
  login: (email: string, password: string) => Promise<{ token: string; cookie: string }>;
  close: () => Promise<void>;
}

export interface RequestOpts {
  token?: string;
  cookie?: string;
  headers?: Record<string, string>;
}

type Overrides = Partial<Omit<Config, 'auth'>> & { auth?: Partial<Config['auth']> };

/** Starts the app on a fresh temporary database. `seed` loads the demo dataset and an admin user. */
export async function startApp(opts: { seed?: boolean; overrides?: Overrides } = {}): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsimony-test-'));
  const base = loadConfig();
  const seed = opts.seed ?? true;
  const config: Config = {
    ...base,
    dataDir: dir,
    dbPath: path.join(dir, 'parsimony.sqlite'),
    backupDir: path.join(dir, 'backups'),
    backupOnStart: false,
    webDist: path.join(dir, 'no-dist'),
    publicUrl: 'https://parsimony.example.test',
    ...opts.overrides,
    auth: {
      ...base.auth,
      jwtSecret: '',
      adminEmail: seed ? ADMIN.email : '',
      adminPassword: seed ? ADMIN.password : '',
      authRateLimit: 1000,
      apiRateLimit: 0,
      heavyRateLimit: 0,
      ...opts.overrides?.auth,
    },
  };
  const mail: Sent[] = [];
  const mailer: Mailer = {
    async send(to, subject, text) {
      mail.push({ to, subject, text });
    },
  };
  const app = await createApp(config, { mailer });
  const ids = seed ? seedDemoData(app.db) : null;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const api: TestApp['api'] = async (method, u, body, o = {}) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.cookie) headers.Cookie = o.cookie;
    const init: RequestInit = { method, headers };
    if (body instanceof Buffer) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url + u, init);
    const text = await res.text();
    const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
    return { status: res.status, data, headers: res.headers };
  };

  const login: TestApp['login'] = async (email, password) => {
    const res = await api('POST', '/api/auth/login', { email, password });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.data)}`);
    return { token: res.data.accessToken, cookie: refreshCookie(res.headers) ?? '' };
  };

  return {
    app,
    config,
    base: url,
    dir,
    ids,
    mail,
    api,
    login,
    close: async () => {
      app.server.closeAllConnections();
      await new Promise((r) => app.server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Extracts `parsimony_refresh=…` from Set-Cookie (null when absent; '' when the cookie is cleared). */
export function refreshCookie(headers: Headers): string | null {
  const c = headers.getSetCookie().find((s) => s.startsWith('parsimony_refresh='));
  if (!c) return null;
  const pair = c.split(';')[0];
  return pair === 'parsimony_refresh=' ? '' : pair;
}

// ---------- deterministic races ----------

export interface Hold {
  entered: Promise<void>;
  release: () => void;
}

/** Lets a test pause the hash/verify of a given plaintext until it calls `release()`. */
export function gate(t: TestApp) {
  const real = { ...t.app.auth.passwords };
  const held = new Map<string, { enter: () => void; released: Promise<void> }>();
  const wrap =
    <A extends unknown[], R>(fn: (pw: string, ...rest: A) => Promise<R>) =>
    async (pw: string, ...rest: A): Promise<R> => {
      const g = held.get(pw);
      if (g) {
        held.delete(pw);
        g.enter();
        await g.released;
      }
      return fn(pw, ...rest);
    };
  t.app.auth.passwords.hash = wrap(real.hash);
  t.app.auth.passwords.verify = wrap(real.verify);
  return (pw: string): Hold => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const released = new Promise<void>((r) => (release = r));
    held.set(pw, { enter, released });
    return { entered, release };
  };
}

export async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
