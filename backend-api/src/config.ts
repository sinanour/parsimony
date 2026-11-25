import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** backend-api/ */
export const packageRoot = path.resolve(here, '..');
/** The repository root (parent of backend-api/). */
export const repoRoot = path.resolve(packageRoot, '..');

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const v = env(name, String(fallback)).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function int(name: string, fallback: number): number {
  const n = Number(env(name, String(fallback)));
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

/** Parses durations like "900", "15m", "12h", "7d" into seconds. */
export function parseDuration(name: string, value: string): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec(value.trim());
  if (!m) throw new Error(`${name} must be a duration such as 15m, 12h or 7d`);
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as '' | 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

/** Resolves relative paths against the repository root so the server behaves the same from any cwd. */
const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.resolve(repoRoot, p));

export function loadConfig() {
  const dataDir = resolvePath(env('DATA_DIR', 'data'));
  const cookieSecure = env('COOKIE_SECURE', 'auto').toLowerCase();
  if (!['auto', 'true', 'false'].includes(cookieSecure)) throw new Error('COOKIE_SECURE must be auto, true or false');
  const smtpHost = env('SMTP_HOST', '');

  return {
    dataDir,
    dbPath: resolvePath(env('DATABASE_PATH', path.join(dataDir, 'parsimony.sqlite'))),
    host: env('HOST', '127.0.0.1'),
    port: int('PORT', 3001),
    trustProxy: bool('TRUST_PROXY', false),
    backupDir: resolvePath(env('BACKUP_DIR', path.join(dataDir, 'backups'))),
    backupKeep: int('BACKUP_KEEP', 10),
    backupOnStart: bool('BACKUP_ON_START', true),
    webDist: resolvePath(env('WEB_DIST', path.join(repoRoot, 'web-frontend', 'dist'))),
    currency: env('CURRENCY', 'CAD'),
    locale: env('LOCALE', 'en-CA'),
    auth: {
      jwtSecret: env('JWT_SECRET', ''),
      accessTokenTtl: parseDuration('ACCESS_TOKEN_TTL', env('ACCESS_TOKEN_TTL', '15m')),
      refreshTokenTtl: parseDuration('REFRESH_TOKEN_TTL', env('REFRESH_TOKEN_TTL', '7d')),
      passwordResetTtl: parseDuration('PASSWORD_RESET_TTL', env('PASSWORD_RESET_TTL', '30m')),
      cookieSecure: cookieSecure as 'auto' | 'true' | 'false',
      /** Per client IP, per route: setup, forgot-password and reset-password requests; per user: password changes. */
      authRateLimit: int('AUTH_RATE_LIMIT_PER_MINUTE', 10),
      /** Failed sign-ins per client IP per minute (successful sign-ins never count). */
      loginIpFailureLimit: int('LOGIN_IP_FAILURES_PER_MINUTE', 100),
      /** Consecutive failed sign-ins for one email before it is temporarily locked (0 disables). */
      loginLockoutThreshold: int('LOGIN_LOCKOUT_THRESHOLD', 5),
      /** First lock length; each further failure doubles it up to loginLockoutMax (seconds). */
      loginLockoutBase: parseDuration('LOGIN_LOCKOUT_BASE', env('LOGIN_LOCKOUT_BASE', '1m')),
      loginLockoutMax: parseDuration('LOGIN_LOCKOUT_MAX', env('LOGIN_LOCKOUT_MAX', '15m')),
      /** Refresh requests per session per minute. */
      refreshRateLimit: int('REFRESH_RATE_LIMIT_PER_MINUTE', 30),
      apiRateLimit: int('API_RATE_LIMIT_PER_MINUTE', 600),
      auditRetentionDays: int('AUDIT_RETENTION_DAYS', 365),
      adminEmail: env('ADMIN_EMAIL', ''),
      adminPassword: env('ADMIN_PASSWORD', ''),
    },
    smtp: smtpHost
      ? {
          host: smtpHost,
          port: int('SMTP_PORT', 587),
          secure: bool('SMTP_SECURE', false),
          user: env('SMTP_USER', ''),
          password: env('SMTP_PASSWORD', ''),
          from: env('SMTP_FROM', env('SMTP_USER', 'parsimony@localhost')),
        }
      : null,
    publicUrl: env('PUBLIC_URL', '').replace(/\/+$/, ''),
  };
}

export type Config = ReturnType<typeof loadConfig>;
