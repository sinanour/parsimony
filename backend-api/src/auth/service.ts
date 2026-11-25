import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../config';
import type { Db } from '../db';
import { badRequest, conflict, HttpError, notFound, unauthorized } from '../http';
import type { AuditEntry, AuthSession, AuthUser, Role, User } from '../../../shared/types';
import { dummyHash, hashPassword, verifyPassword } from './passwords';
import { fingerprint, randomToken, safeEqual, sha256, TokenSigner } from './tokens';
import type { Mailer } from './mailer';
import { LoginLockout, RateLimiter, tooManyRequests } from './rate-limit';
import { KeyedMutex } from './locks';

interface UserRow {
  user_id: number;
  email: string;
  display_name: string | null;
  password_hash: string;
  role: Role;
  tokens_invalid_before: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  session_id: string;
  user_id: number;
  token_hash: string;
  prev_token_hash: string | null;
  rotated_at: number | null;
  expires_at: number;
}

export interface ClientInfo {
  ip: string;
  userAgent?: string;
}

export interface AuditInput {
  action: string;
  user?: Pick<AuthUser, 'userId' | 'email'> | null;
  method?: string;
  path?: string;
  status?: number;
  ip?: string;
  details?: string;
}

/** A freshly issued session: the JSON body plus the refresh token for the cookie (null = leave the cookie alone). */
export interface IssuedSession {
  session: AuthSession;
  refreshToken: string | null;
}

/** How long a just-rotated refresh token is still accepted (concurrent refreshes from several tabs). */
const ROTATION_GRACE_SECONDS = 30;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const toAuthUser = (u: UserRow): AuthUser => ({ userId: u.user_id, email: u.email, displayName: u.display_name, role: u.role });

/** Normalises a submitted email for throttling, so case/whitespace variants share one budget. */
const accountKey = (email: string) => email.trim().toLowerCase();

const sessionEnded = () => unauthorized('Your session has ended. Sign in again.', 'TOKEN_REVOKED');
const lastAdminDemote = () => conflict('This is the only administrator. Make someone else an administrator first.');
const alreadySetUp = () => new HttpError(409, 'Parsimony is already set up', undefined, 'ALREADY_SET_UP');

const isUniqueViolation = (e: unknown) =>
  e instanceof Error && ((e as { errcode?: number }).errcode === 2067 || /UNIQUE constraint failed/.test(e.message));

export class AuthService {
  /** Per IP (or per user on authenticated routes) request budget for the other `limit: 'auth'` routes. */
  readonly authLimiter: RateLimiter;
  readonly apiLimiter: RateLimiter;
  /** Failed sign-ins per client IP. Only failures count, so others' junk can't spend a caller's success. */
  readonly loginIpLimiter: RateLimiter;
  /** Per-account (submitted email) escalating lock after repeated failures. */
  readonly loginLockout: LoginLockout;
  /** Refresh requests per presented session id (never per IP, so other callers can't spend it). */
  readonly refreshLimiter: RateLimiter;
  /** At most one audit row per throttled key per minute, so 429 floods can't flood the audit log. */
  private readonly throttleAudit = new RateLimiter(1, 60_000);
  /** One-time code required to create the first administrator; null once any user exists. */
  private setupCode: string | null = null;
  /**
   * Serialises every credential/role/session-revocation write for one user id: the precondition check, the
   * (slow, event-loop-yielding) scrypt hash and the write. Writers also re-check inside the transaction, since
   * the `users` CLI runs in another process.
   */
  readonly userLocks = new KeyedMutex<number>();
  /** Password hashing; a field so tests can hold a hash in flight to reproduce races. */
  readonly passwords = { hash: hashPassword, verify: verifyPassword };

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly signer: TokenSigner,
    private readonly mailer: Mailer | null,
  ) {
    this.authLimiter = new RateLimiter(config.auth.authRateLimit);
    this.apiLimiter = new RateLimiter(config.auth.apiRateLimit);
    this.loginIpLimiter = new RateLimiter(config.auth.loginIpFailureLimit);
    this.refreshLimiter = new RateLimiter(config.auth.refreshRateLimit);
    this.loginLockout = new LoginLockout({
      threshold: config.auth.loginLockoutThreshold,
      baseMs: config.auth.loginLockoutBase * 1000,
      maxMs: Math.max(config.auth.loginLockoutBase, config.auth.loginLockoutMax) * 1000,
    });
  }

  // ---------- throttling ----------

  /** Counts a request against the `auth` bucket of a route; audits (sparingly) and rethrows a 429. */
  limitAuthRoute(route: { method: string; pattern: string }, user: AuthUser | null, client: ClientInfo): void {
    const key = `${route.pattern}|${user ? `user:${user.userId}` : client.ip}`;
    try {
      this.authLimiter.hit(key);
    } catch (e) {
      this.auditThrottled(key, { action: 'auth.rate_limited', user, method: route.method, path: route.pattern, status: 429, ip: client.ip });
      throw e;
    }
  }

  /** Writes a throttling audit row unless one was already written for `key` in the last minute. */
  private auditThrottled(key: string, e: AuditInput): void {
    if (this.throttleAudit.allow(key)) this.audit(e);
  }


  // ---------- startup ----------

  /** Creates the first administrator from ADMIN_EMAIL/ADMIN_PASSWORD, or arms a setup code. Returns the code, if any. */
  async bootstrap(): Promise<string | null> {
    this.db.run('DELETE FROM user_session WHERE expires_at < ?', [nowSeconds()]);
    const days = this.config.auth.auditRetentionDays;
    if (days > 0) this.db.run(`DELETE FROM audit_log WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`, [`-${days} days`]);

    if (this.userCount() > 0) return null;
    const { adminEmail, adminPassword } = this.config.auth;
    if (adminEmail && adminPassword) {
      const u = await this.createUser({ email: adminEmail, password: adminPassword, role: 'ADMINISTRATOR', displayName: 'Administrator' });
      this.audit({ action: 'user.bootstrap', user: u, details: 'Created from ADMIN_EMAIL' });
      return null;
    }
    // 10 characters from an unambiguous alphabet ≈ 50 bits; only usable while no user exists.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(10);
    const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    this.setupCode = `${code.slice(0, 5)}-${code.slice(5)}`;
    return this.setupCode;
  }

  userCount(): number {
    return this.db.scalar<number>('SELECT COUNT(*) FROM app_user');
  }

  get setupRequired(): boolean {
    return this.userCount() === 0;
  }

  get passwordResetEnabled(): boolean {
    // A public URL is required so reset links can't be pointed elsewhere via a forged Host header.
    return this.mailer !== null && this.config.publicUrl !== '';
  }

  // ---------- users ----------

  private findByEmail(email: string): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM app_user WHERE email = ?', [email.trim()]);
  }

  private findById(id: number): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM app_user WHERE user_id = ?', [id]);
  }

  /** Re-reads `u` (same id *and* created_at, so never a different account); undefined if it was deleted. */
  private reread(u: UserRow): UserRow | undefined {
    return this.db.get<UserRow>('SELECT * FROM app_user WHERE user_id = ? AND created_at = ?', [u.user_id, u.created_at]);
  }

  /** `onlyIfNoUsers`: fail (409) if any user exists by the time of the insert — first-run setup. */
  async createUser(
    input: { email: string; password: string; role: Role; displayName?: string | null },
    opts: { onlyIfNoUsers?: boolean } = {},
  ): Promise<AuthUser> {
    const email = input.email.trim();
    const duplicate = () => conflict(`A user with email ${email} already exists`);
    if (this.findByEmail(email)) throw duplicate();
    const hash = await this.passwords.hash(input.password);
    // Re-check after hashing, inside the inserting transaction: a concurrent create may have won meanwhile.
    const id = this.db.tx(() => {
      if (opts.onlyIfNoUsers && this.userCount() > 0) throw alreadySetUp();
      if (this.findByEmail(email)) throw duplicate();
      try {
        return this.db.run('INSERT INTO app_user (email, display_name, password_hash, role) VALUES (?, ?, ?, ?)', [
          email,
          input.displayName?.trim() || null,
          hash,
          input.role,
        ]).lastInsertRowid;
      } catch (e) {
        if (isUniqueViolation(e)) throw duplicate();
        throw e;
      }
    });
    return toAuthUser(this.findById(id)!);
  }

  listUsers(): User[] {
    const now = nowSeconds();
    return this.db
      .all<UserRow & { sessions: number }>(
        `SELECT u.*, (SELECT COUNT(*) FROM user_session s WHERE s.user_id = u.user_id AND s.expires_at > ?) AS sessions
         FROM app_user u ORDER BY u.email`,
        [now],
      )
      .map((u) => this.toUser(u, Number(u.sessions)));
  }

  getUser(id: number): User {
    const u = this.findById(id);
    if (!u) throw notFound('User');
    const sessions = this.db.scalar<number>('SELECT COUNT(*) FROM user_session WHERE user_id = ? AND expires_at > ?', [id, nowSeconds()]);
    return this.toUser(u, sessions);
  }

  private toUser(u: UserRow, sessions: number): User {
    return { ...toAuthUser(u), createdAt: u.created_at, updatedAt: u.updated_at, lastLoginAt: u.last_login_at, activeSessions: sessions };
  }

  private adminCount(): number {
    return this.db.scalar<number>("SELECT COUNT(*) FROM app_user WHERE role = 'ADMINISTRATOR'");
  }

  async updateUser(id: number, patch: { displayName?: string | null; role?: Role; password?: string }): Promise<User> {
    const demotes = (row: UserRow) => patch.role !== undefined && patch.role !== 'ADMINISTRATOR' && row.role === 'ADMINISTRATOR';
    return this.userLocks.run(id, async () => {
      const u = this.findById(id);
      if (!u) throw notFound('User');
      if (demotes(u) && this.adminCount() <= 1) throw lastAdminDemote();
      const hash = patch.password === undefined ? null : await this.passwords.hash(patch.password);
      this.db.tx(() => {
        // Everything checked above may have changed while hashing; re-check against the committed state.
        const cur = this.reread(u);
        if (!cur) throw notFound('User');
        if (demotes(cur) && this.adminCount() <= 1) throw lastAdminDemote();
        if (hash) {
          const r = this.db.run('UPDATE app_user SET password_hash = ? WHERE user_id = ? AND password_hash = ?', [hash, id, u.password_hash]);
          if (r.changes === 0) throw conflict('The password was changed meanwhile. Reload and try again.');
        }
        if (patch.displayName !== undefined) this.db.run('UPDATE app_user SET display_name = ? WHERE user_id = ?', [patch.displayName?.trim() || null, id]);
        if (patch.role !== undefined) this.db.run('UPDATE app_user SET role = ? WHERE user_id = ?', [patch.role, id]);
        this.db.run(`UPDATE app_user SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`, [id]);
        // A new role or password must take effect everywhere immediately.
        if ((patch.role !== undefined && patch.role !== cur.role) || hash) this.revokeAll(id);
      });
      return this.getUser(id);
    });
  }

  /** Deletes the user and their sessions; returns who was deleted (for the audit log). */
  async deleteUser(id: number, actorId: number): Promise<AuthUser> {
    return this.userLocks.run(id, () =>
      this.db.tx(() => {
        const u = this.findById(id);
        if (!u) throw notFound('User');
        if (id === actorId) throw conflict('You cannot delete your own account');
        if (u.role === 'ADMINISTRATOR' && this.adminCount() <= 1) throw conflict('Cannot delete the only administrator');
        this.db.run('DELETE FROM user_session WHERE user_id = ?', [id]);
        this.db.run('DELETE FROM app_user WHERE user_id = ?', [id]);
        return toAuthUser(u);
      }),
    );
  }

  /** Revokes all of a user's sessions, after any credential write already in flight for them. Returns the user. */
  async revokeSessions(id: number): Promise<AuthUser> {
    return this.userLocks.run(id, () =>
      this.db.tx(() => {
        const u = this.findById(id);
        if (!u) throw notFound('User');
        this.revokeAll(id);
        return toAuthUser(u);
      }),
    );
  }

  updateProfile(userId: number, displayName: string | null): AuthUser {
    this.db.run(`UPDATE app_user SET display_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`, [
      displayName?.trim() || null,
      userId,
    ]);
    return toAuthUser(this.findById(userId)!);
  }

  // ---------- sessions ----------

  /** Inserts a session row (synchronous, so it can run inside a transaction). */
  private insertSession(userId: number, client: ClientInfo): { sessionId: string; secret: string } {
    const sessionId = randomToken(16);
    const secret = randomToken(32);
    this.db.run('INSERT INTO user_session (session_id, user_id, token_hash, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)', [
      sessionId,
      userId,
      sha256(secret),
      nowSeconds() + this.config.auth.refreshTokenTtl,
      client.ip,
      client.userAgent?.slice(0, 300) ?? null,
    ]);
    return { sessionId, secret };
  }

  private async issue(user: UserRow, client: ClientInfo): Promise<IssuedSession> {
    const { sessionId, secret } = this.insertSession(user.user_id, client);
    return { session: await this.accessFor(user, sessionId), refreshToken: `${sessionId}.${secret}` };
  }

  private async accessFor(user: UserRow, sessionId: string): Promise<AuthSession> {
    const ttl = this.config.auth.accessTokenTtl;
    return { accessToken: await this.signer.signAccess(user.user_id, sessionId, ttl), expiresIn: ttl, user: toAuthUser(user) };
  }

  async login(email: string, password: string, client: ClientInfo): Promise<IssuedSession> {
    const account = accountKey(email);
    const shownEmail = email.trim().slice(0, 200);
    const user = this.findByEmail(email);
    const who = user ? toAuthUser(user) : null;
    const throttled = (key: string, details: string) =>
      this.auditThrottled(key, { action: 'auth.login_throttled', user: who, path: '/api/auth/login', status: 429, ip: client.ip, details });

    // 1. Per-account lock. Applied to unknown emails exactly the same way, so it doesn't reveal which exist.
    const lockedMs = this.loginLockout.lockedFor(account);
    if (lockedMs > 0) {
      throttled(`lock|${account}`, `Account locked after repeated failures: ${shownEmail}`);
      const minutes = Math.ceil(lockedMs / 60_000);
      throw tooManyRequests(
        lockedMs / 1000,
        `Too many failed sign-in attempts for this email. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        'LOGIN_LOCKED',
      );
    }
    // 2. Per-IP failure budget (large; a caller's successes never count, so it only bites on mass guessing).
    const ipKey = `ip|${client.ip}`;
    try {
      this.loginIpLimiter.check(ipKey);
    } catch (e) {
      throttled(ipKey, `Too many failed sign-ins from this address: ${shownEmail}`);
      throw e;
    }

    // Count the attempt as a failure *before* the (slow) hash check so concurrent guesses can't all slip
    // through before the first one is recorded; a success gives it back.
    const failure = this.loginLockout.fail(account);
    this.loginIpLimiter.allow(ipKey);

    // Hash even when the user doesn't exist so response time doesn't reveal which emails are registered.
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash()));
    if (!user || !ok) {
      const streak = failure.failures > 1 ? ` (${failure.failures} consecutive failures)` : '';
      this.audit({
        action: 'auth.login_failed',
        user: who,
        ip: client.ip,
        details: user ? `Incorrect password${streak}` : `Unknown email: ${shownEmail}${streak}`,
      });
      if (failure.lockMs > 0) {
        this.audit({
          action: 'auth.login_locked',
          user: who,
          ip: client.ip,
          details: `${shownEmail} locked for ${Math.round(failure.lockMs / 1000)} s after ${failure.failures} consecutive failures`,
        });
      }
      throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
    }
    this.loginLockout.succeed(account);
    this.loginIpLimiter.refund(ipKey);
    this.db.run(`UPDATE app_user SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`, [user.user_id]);
    this.audit({ action: 'auth.login', user: toAuthUser(user), ip: client.ip });
    return this.issue(user, client);
  }

  async setup(code: string, input: { email: string; password: string; displayName?: string | null }, client: ClientInfo): Promise<IssuedSession> {
    if (!this.setupCode || !this.setupRequired) throw alreadySetUp();
    if (!safeEqual(code.trim().toUpperCase(), this.setupCode)) {
      this.audit({ action: 'auth.setup_failed', ip: client.ip });
      throw unauthorized('The setup code is not correct. It is printed in the server log.', 'INVALID_SETUP_CODE');
    }
    // Two setups racing with the code must not both create an administrator.
    const user = await this.createUser({ ...input, role: 'ADMINISTRATOR' }, { onlyIfNoUsers: true });
    this.setupCode = null;
    this.audit({ action: 'auth.setup', user, ip: client.ip });
    return this.issue(this.findById(user.userId)!, client);
  }

  /** Rotates the refresh token. Presenting an already-rotated token revokes the session (likely theft). */
  async refresh(token: string | undefined, client: ClientInfo): Promise<IssuedSession> {
    const [sessionId, secret] = (token ?? '').split('.');
    if (!sessionId || !secret) throw unauthorized('Your session has ended. Sign in again.', 'SESSION_EXPIRED');
    const s = this.db.get<SessionRow>('SELECT * FROM user_session WHERE session_id = ?', [sessionId]);
    // Throttle per session (only sessions that exist, so random ids can't grow the limiter's memory).
    if (s) {
      const key = `refresh|${sessionId}`;
      try {
        this.refreshLimiter.hit(key);
      } catch (e) {
        const u = this.findById(s.user_id);
        this.auditThrottled(key, { action: 'auth.rate_limited', user: u ? toAuthUser(u) : null, path: '/api/auth/refresh', status: 429, ip: client.ip });
        throw e;
      }
    }
    const now = nowSeconds();
    if (!s || s.expires_at <= now) {
      if (s) this.db.run('DELETE FROM user_session WHERE session_id = ?', [sessionId]);
      throw unauthorized('Your session has ended. Sign in again.', 'SESSION_EXPIRED');
    }
    const user = this.findById(s.user_id);
    if (!user) throw unauthorized('Your session has ended. Sign in again.', 'SESSION_EXPIRED');
    const presented = sha256(secret);

    if (safeEqual(presented, s.token_hash)) {
      const next = randomToken(32);
      this.db.run(
        `UPDATE user_session SET prev_token_hash = token_hash, token_hash = ?, rotated_at = ?, expires_at = ?,
           last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ip = ? WHERE session_id = ?`,
        [sha256(next), now, now + this.config.auth.refreshTokenTtl, client.ip, sessionId],
      );
      return { session: await this.accessFor(user, sessionId), refreshToken: `${sessionId}.${next}` };
    }
    if (s.prev_token_hash && safeEqual(presented, s.prev_token_hash) && s.rotated_at && now - s.rotated_at <= ROTATION_GRACE_SECONDS) {
      // Another tab rotated a moment ago; the browser already holds the new cookie.
      return { session: await this.accessFor(user, sessionId), refreshToken: null };
    }
    this.db.run('DELETE FROM user_session WHERE session_id = ?', [sessionId]);
    this.audit({ action: 'auth.refresh_reuse', user: toAuthUser(user), ip: client.ip, details: 'Rotated refresh token reused; session revoked' });
    throw unauthorized('Your session has ended. Sign in again.', 'SESSION_REVOKED');
  }

  logout(token: string | undefined, client: ClientInfo): void {
    const [sessionId] = (token ?? '').split('.');
    if (!sessionId) return;
    const s = this.db.get<SessionRow>('SELECT * FROM user_session WHERE session_id = ?', [sessionId]);
    if (!s) return;
    this.db.run('DELETE FROM user_session WHERE session_id = ?', [sessionId]);
    const u = this.findById(s.user_id);
    this.audit({ action: 'auth.logout', user: u ? toAuthUser(u) : null, ip: client.ip });
  }

  /** Revokes every session of the user and rejects access tokens issued until now. */
  revokeAll(userId: number): void {
    this.db.run('DELETE FROM user_session WHERE user_id = ?', [userId]);
    this.db.run('UPDATE app_user SET tokens_invalid_before = ? WHERE user_id = ?', [nowSeconds(), userId]);
  }

  /** Validates the bearer token on a request. Returns null without a token; throws 401 for a bad one. */
  async authenticate(req: IncomingMessage): Promise<AuthUser | null> {
    const h = req.headers.authorization;
    if (!h) return null;
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m) throw unauthorized('Malformed Authorization header');
    const claims = await this.signer.verifyAccess(m[1]);
    if (!claims) throw unauthorized('Your session has expired', 'TOKEN_EXPIRED');
    const user = this.findById(claims.userId);
    if (!user || claims.issuedAt < user.tokens_invalid_before) throw unauthorized('Your session has ended. Sign in again.', 'TOKEN_REVOKED');
    const s = this.db.get<{ expires_at: number }>('SELECT expires_at FROM user_session WHERE session_id = ? AND user_id = ?', [
      claims.sessionId,
      user.user_id,
    ]);
    if (!s || s.expires_at <= nowSeconds()) throw unauthorized('Your session has ended. Sign in again.', 'TOKEN_REVOKED');
    return toAuthUser(user);
  }

  // ---------- passwords ----------

  /** Changes the password, signs out every other session and returns a fresh session for this browser. */
  async changePassword(userId: number, current: string, next: string, client: ClientInfo): Promise<IssuedSession> {
    // Snapshot taken when the request arrives, before waiting for the lock: if this user's sessions are revoked
    // (or the user deleted) after that point, even by a write queued ahead of us, this request must not go on
    // to set a password and hand out a fresh session.
    const start = this.findById(userId);
    if (!start) throw sessionEnded();
    const unchanged = (row: UserRow | undefined): row is UserRow => !!row && row.tokens_invalid_before === start.tokens_invalid_before;
    return this.userLocks.run(userId, async () => {
      const u = this.reread(start);
      if (!unchanged(u)) throw sessionEnded();
      if (!(await this.passwords.verify(current, u.password_hash))) throw badRequest('The current password is not correct');
      const hash = await this.passwords.hash(next);
      const { sessionId, secret } = this.db.tx(() => {
        if (!unchanged(this.reread(u))) throw sessionEnded();
        // Only replace the hash that was verified above.
        const r = this.db.run(
          `UPDATE app_user SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND password_hash = ?`,
          [hash, userId, u.password_hash],
        );
        if (r.changes === 0) throw conflict('Your password was changed meanwhile. Sign in again and retry.');
        this.revokeAll(userId);
        // The replacement session is created in the same transaction, so any later revocation removes it too.
        // Tokens issued in the same second as the revocation are still valid, so it works immediately.
        return this.insertSession(userId, client);
      });
      const fresh = this.findById(userId)!;
      this.audit({ action: 'auth.password_changed', user: toAuthUser(fresh), ip: client.ip });
      return { session: await this.accessFor(fresh, sessionId), refreshToken: `${sessionId}.${secret}` };
    });
  }

  /** Always resolves the same way whether or not the email is registered. */
  async requestPasswordReset(email: string, client: ClientInfo): Promise<void> {
    if (!this.passwordResetEnabled) throw new HttpError(404, 'Password reset by email is not enabled', undefined, 'NOT_ENABLED');
    const u = this.findByEmail(email);
    this.audit({ action: 'auth.password_reset_requested', user: u ? toAuthUser(u) : null, ip: client.ip, details: u ? undefined : 'unknown email' });
    if (!u) return;
    const ttl = this.config.auth.passwordResetTtl;
    const token = await this.signer.signReset(u.user_id, u.password_hash, ttl);
    const link = `${this.config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const text =
      `Someone (hopefully you) asked to reset the password for ${u.email} on Parsimony.\n\n` +
      `Open this link within ${Math.round(ttl / 60)} minutes to choose a new password:\n\n${link}\n\n` +
      `If you didn't ask for this, ignore this email; your password stays the same.\n`;
    // Don't make the response time depend on the mail server (or reveal that the email exists).
    this.mailer!.send(u.email, 'Reset your Parsimony password', text).catch((e) => console.error('Password-reset email failed:', e instanceof Error ? e.message : e));
  }

  async resetPassword(token: string, next: string, client: ClientInfo): Promise<void> {
    const invalid = () => new HttpError(400, 'This reset link is invalid or has expired. Request a new one.', undefined, 'INVALID_RESET_TOKEN');
    const claims = await this.signer.verifyReset(token);
    if (!claims) throw invalid();
    const u = await this.userLocks.run(claims.userId, async () => {
      const u = this.findById(claims.userId);
      if (!u || !safeEqual(claims.fingerprint, fingerprint(u.password_hash))) throw invalid();
      const hash = await this.passwords.hash(next);
      this.db.tx(() => {
        // Only replace the hash the link was issued for, on the same account: a link is good for one change.
        const r = this.db.run(
          `UPDATE app_user SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE user_id = ? AND created_at = ? AND password_hash = ?`,
          [hash, u.user_id, u.created_at, u.password_hash],
        );
        if (r.changes === 0) throw invalid();
        this.revokeAll(u.user_id);
      });
      return u;
    });
    this.audit({ action: 'auth.password_reset', user: toAuthUser(u), ip: client.ip });
  }

  // ---------- audit ----------

  audit(e: AuditInput): void {
    this.db.run('INSERT INTO audit_log (user_id, user_email, action, method, path, status, ip, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      e.user?.userId ?? null,
      e.user?.email ?? null,
      e.action,
      e.method ?? null,
      e.path ?? null,
      e.status ?? null,
      e.ip ?? null,
      e.details ?? null,
    ]);
  }

  listAudit(q: { page: number; pageSize: number; userId?: number; action?: string }): { items: AuditEntry[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.userId !== undefined) {
      where.push('user_id = ?');
      params.push(q.userId);
    }
    if (q.action) {
      where.push('action LIKE ?');
      params.push(`${q.action}%`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.scalar<number>(`SELECT COUNT(*) FROM audit_log ${w}`, params);
    const items = this.db
      .all(`SELECT * FROM audit_log ${w} ORDER BY audit_idx DESC LIMIT ? OFFSET ?`, [...params, q.pageSize, (q.page - 1) * q.pageSize])
      .map((r) => ({
        auditIdx: Number(r.audit_idx),
        at: String(r.at),
        userId: r.user_id === null ? null : Number(r.user_id),
        userEmail: (r.user_email as string | null) ?? null,
        action: String(r.action),
        method: (r.method as string | null) ?? null,
        path: (r.path as string | null) ?? null,
        status: r.status === null ? null : Number(r.status),
        ip: (r.ip as string | null) ?? null,
        details: (r.details as string | null) ?? null,
      }));
    return { items, total };
  }
}
