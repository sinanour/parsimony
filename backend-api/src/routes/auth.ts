import { z } from 'zod';
import { HttpError, unauthorized, type Ctx } from '../http';
import type { IssuedSession } from '../auth/service';
import { passwordSchema } from '../auth/passwords';
import { ROLES, type AuthSession, type PublicConfig, type User } from '../../../shared/types';
import { idParam, pagingSchema, queryObject, type Deps, type RouteModule } from './common';

export const REFRESH_COOKIE = 'parsimony_refresh';

const email = z.string().trim().toLowerCase().email('must be a valid email address').max(254);
const displayName = z.string().trim().max(100).nullable().optional();

function readCookie(ctx: Ctx, name: string): string | undefined {
  for (const part of (ctx.req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function cookieSecure(ctx: Ctx, deps: Deps): boolean {
  const mode = deps.config.auth.cookieSecure;
  return mode === 'auto' ? ctx.secure : mode === 'true';
}

function setRefreshCookie(ctx: Ctx, deps: Deps, value: string | null): void {
  const attrs = ['Path=/api/auth', 'HttpOnly', 'SameSite=Strict'];
  if (cookieSecure(ctx, deps)) attrs.push('Secure');
  const cookie =
    value === null
      ? `${REFRESH_COOKIE}=; ${attrs.join('; ')}; Max-Age=0`
      : `${REFRESH_COOKIE}=${encodeURIComponent(value)}; ${attrs.join('; ')}; Max-Age=${deps.config.auth.refreshTokenTtl}`;
  ctx.res.setHeader('Set-Cookie', cookie);
}

function respond(ctx: Ctx, deps: Deps, issued: IssuedSession): AuthSession {
  if (issued.refreshToken) setRefreshCookie(ctx, deps, issued.refreshToken);
  return issued.session;
}

const client = (ctx: Ctx) => ({ ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });

export const authRoutes: RouteModule = (r, deps) => {
  const { auth } = deps;
  // Auth routes return the caller's own session (access tokens, whose base64 can contain digit runs) and
  // no bookkeeping data, so they are exempt from read-only redaction (redact.ts).
  /** Public routes with a per-IP request budget. */
  const pub = { access: 'public', audit: false, limit: 'auth', redact: false } as const;
  /**
   * Public routes that throttle themselves on something callers can't share or spend for each other:
   * login (per submitted account + per-IP *failures*), refresh (per presented session), logout (no-op without a cookie).
   */
  const selfThrottled = { access: 'public', audit: false, redact: false } as const;

  r.get(
    '/api/config',
    (): PublicConfig => ({
      setupRequired: auth.setupRequired,
      passwordResetEnabled: auth.passwordResetEnabled,
      currency: deps.config.currency,
      locale: deps.config.locale,
      version: deps.version,
    }),
    { access: 'public', redact: false },
  );

  r.post(
    '/api/auth/setup',
    async (ctx) => {
      const b = z.object({ setupCode: z.string().min(1), email, password: passwordSchema, displayName }).parse(ctx.body);
      return respond(ctx, deps, await auth.setup(b.setupCode, b, client(ctx)));
    },
    pub,
  );

  r.post(
    '/api/auth/login',
    async (ctx) => {
      const b = z.object({ email: z.string().max(254), password: z.string().max(1024) }).parse(ctx.body);
      return respond(ctx, deps, await auth.login(b.email, b.password, client(ctx)));
    },
    selfThrottled,
  );

  r.post(
    '/api/auth/refresh',
    async (ctx) => {
      const token = readCookie(ctx, REFRESH_COOKIE);
      // No cookie (e.g. a cross-site request): reject before any limiter or database work.
      if (!token) throw unauthorized('Your session has ended. Sign in again.', 'SESSION_EXPIRED');
      try {
        return respond(ctx, deps, await auth.refresh(token, client(ctx)));
      } catch (e) {
        // Being throttled doesn't end the session; keep the cookie so the next attempt can succeed.
        if (!(e instanceof HttpError && e.status === 429)) setRefreshCookie(ctx, deps, null);
        throw e;
      }
    },
    selfThrottled,
  );

  r.post(
    '/api/auth/logout',
    (ctx) => {
      auth.logout(readCookie(ctx, REFRESH_COOKIE), client(ctx));
      setRefreshCookie(ctx, deps, null);
    },
    selfThrottled,
  );

  r.post(
    '/api/auth/logout-all',
    async (ctx) => {
      await auth.revokeSessions(ctx.user!.userId);
      auth.audit({ action: 'auth.logout_all', user: ctx.user, ip: ctx.ip });
      setRefreshCookie(ctx, deps, null);
    },
    { access: 'user', audit: false, redact: false },
  );

  r.get('/api/auth/me', (ctx) => ctx.user, { redact: false });

  r.patch(
    '/api/auth/me',
    (ctx) => {
      const b = z.object({ displayName: z.string().trim().max(100).nullable() }).strict().parse(ctx.body);
      return auth.updateProfile(ctx.user!.userId, b.displayName);
    },
    { access: 'user', redact: false },
  );

  r.post(
    '/api/auth/password',
    async (ctx) => {
      const b = z.object({ currentPassword: z.string().max(1024), newPassword: passwordSchema }).parse(ctx.body);
      return respond(ctx, deps, await auth.changePassword(ctx.user!.userId, b.currentPassword, b.newPassword, client(ctx)));
    },
    { access: 'user', audit: false, limit: 'auth', redact: false },
  );

  r.post(
    '/api/auth/forgot-password',
    async (ctx) => {
      const b = z.object({ email: z.string().max(254) }).parse(ctx.body);
      await auth.requestPasswordReset(b.email, client(ctx));
      return { message: 'If an account exists for that email, a reset link is on its way.' };
    },
    pub,
  );

  r.post(
    '/api/auth/reset-password',
    async (ctx) => {
      const b = z.object({ token: z.string().min(1).max(4096), newPassword: passwordSchema }).parse(ctx.body);
      await auth.resetPassword(b.token, b.newPassword, client(ctx));
      return { message: 'Your password has been changed. Sign in with the new password.' };
    },
    pub,
  );

  // ---------- user administration ----------

  const admin = { access: 'admin', audit: false } as const;
  const role = z.enum(ROLES as [string, ...string[]]).transform((s) => s as (typeof ROLES)[number]);

  r.get('/api/users', (): User[] => auth.listUsers(), { access: 'admin' });

  r.post(
    '/api/users',
    async (ctx): Promise<User> => {
      const b = z.object({ email, displayName, role, password: passwordSchema }).parse(ctx.body);
      const u = await auth.createUser(b);
      auth.audit({ action: 'user.create', user: ctx.user, ip: ctx.ip, details: `${u.email} as ${u.role}` });
      return auth.getUser(u.userId);
    },
    admin,
  );

  r.patch(
    '/api/users/:id',
    async (ctx): Promise<User> => {
      const id = idParam.parse(ctx.params.id);
      const b = z.object({ displayName, role: role.optional(), password: passwordSchema.optional() }).strict().parse(ctx.body);
      // Demoting yourself is allowed unless you're the last administrator (checked in the service).
      const u = await auth.updateUser(id, b);
      const changed = [b.displayName !== undefined && 'display name', b.role && `role → ${b.role}`, b.password && 'password reset'].filter(Boolean);
      auth.audit({ action: 'user.update', user: ctx.user, ip: ctx.ip, details: `${u.email}: ${changed.join(', ') || 'no changes'}` });
      return u;
    },
    admin,
  );

  r.post(
    '/api/users/:id/revoke-sessions',
    async (ctx) => {
      const id = idParam.parse(ctx.params.id);
      // Waits for any password change in flight for this user, so its fresh session is revoked too.
      const u = await auth.revokeSessions(id);
      auth.audit({ action: 'user.revoke_sessions', user: ctx.user, ip: ctx.ip, details: u.email });
    },
    admin,
  );

  r.delete(
    '/api/users/:id',
    async (ctx) => {
      const id = idParam.parse(ctx.params.id);
      const u = await auth.deleteUser(id, ctx.user!.userId);
      auth.audit({ action: 'user.delete', user: ctx.user, ip: ctx.ip, details: u.email });
    },
    admin,
  );

  r.get(
    '/api/audit',
    (ctx) => {
      const q = pagingSchema
        .omit({ dir: true })
        .extend({ userId: z.coerce.number().int().optional(), action: z.string().max(100).optional() })
        .parse(queryObject(ctx.query));
      return auth.listAudit(q);
    },
    { access: 'admin' },
  );
};
