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
  /** Legacy revocation instant in epoch seconds (kept up to date for older code; not read by this version). */
  tokens_invalid_before: number;
  /** Revocation instant, epoch ms: sessions created at or before it (and their access tokens) are rejected. */
  revoked_at_ms: number;
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
  /** Epoch ms of creation; the session is valid only while this is > the user's revoked_at_ms. */
  created_ms: number;
  /** What access tokens carry (`sk`) instead of the session id; null for sessions from before migration 007. */
  access_key: string | null;
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
/** How many superseded refresh-secret hashes are kept per session for reuse (theft) detection. */
const SUPERSEDED_HISTORY = 50;

/**
 * Splits a refresh cookie `<sessionId>.<secret>`. Both halves are required: nothing that ends or touches a
 * session is ever done on the session id alone.
 */
function parseRefreshToken(token: string | undefined): { sessionId: string; secret: string } | null {
  const parts = (token ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0].length > 64 || parts[1].length > 128) return null;
  return { sessionId: parts[0], secret: parts[1] };
}

/** Every refresh failure a caller without the session's secret can cause looks exactly the same. */
const refreshFailed = () => unauthorized('Your session has ended. Sign in again.', 'SESSION_EXPIRED');

const nowSeconds = () => Math.floor(Date.now() / 1000);

const toAuthUser = (u: UserRow): AuthUser => ({ userId: u.user_id, email: u.email, displayName: u.display_name, role: u.role });

/** Normalises a submitted email for throttling, so case/whitespace variants share one budget. */
const accountKey = (email: string) => email.trim().toLowerCase();

/** True if the session row was created after the user's last revocation (and so may be used). */
const sessionCurrent = (s: { created_ms: number }, u: { revoked_at_ms: number }) => s.created_ms > u.revoked_at_ms;

const invalidCredentials = () => unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
const sessionEnded = () => unauthorized('Your session has ended. Sign in again.', 'TOKEN_REVOKED');
const lastAdminDemote = () => conflict('This is the only administrator. Make someone else an administrator first.');
const alreadySetUp = () => new HttpError(409, 'Parsimony is already set up', undefined, 'ALREADY_SET_UP');

const isUniqueViolation = (e: unknown) =>
  e instanceof Error && ((e as { errcode?: number }).errcode === 2067 || /UNIQUE constraint failed/.test(e.message));

export class AuthService {
  /** Per IP (or per user on authenticated routes) request budget for the other `limit: 'auth'` routes. */
  readonly authLimiter: RateLimiter;
  readonly apiLimiter: RateLimiter;
  /** Per user: rule runs, statement parse/commit and statement-format writes. */
  readonly heavyLimiter: RateLimiter;
  /** Failed sign-ins per client IP. Only failures count, so others' junk can't spend a caller's success. */
  readonly loginIpLimiter: RateLimiter;
  /** Per-account (submitted email) escalating lock after repeated failures. */
  readonly loginLockout: LoginLockout;
  /** Refresh requests per session, counted only for callers holding one of its secrets (never per IP). */
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
    this.heavyLimiter = new RateLimiter(config.auth.heavyRateLimit);
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
    // Sessions whose account is gone or that predate its revocation can never be used again.
    this.db.run(
      `DELETE FROM user_session WHERE NOT EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = user_session.user_id
         AND user_session.created_ms > u.revoked_at_ms)`,
    );
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
        // revoked_at_ms starts at the creation instant: no session row created before the account existed
        // (whatever its user_id) can ever authenticate as it.
        return this.db.run('INSERT INTO app_user (email, display_name, password_hash, role, revoked_at_ms) VALUES (?, ?, ?, ?, ?)', [
          email,
          input.displayName?.trim() || null,
          hash,
          input.role,
          Date.now(),
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
      const revoked = this.db.tx(() => {
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
        const revoke = (patch.role !== undefined && patch.role !== cur.role) || !!hash;
        if (revoke) this.revokeAll(id);
        return revoke;
      });
      // Belt and braces: sign-ins re-check inside their own transaction, but sweep again after the commit too.
      if (revoked) this.revokeAll(id);
      return this.getUser(id);
    });
  }

  /** Deletes the user and their sessions; returns who was deleted (for the audit log). */
  async deleteUser(id: number, actorId: number): Promise<AuthUser> {
    return this.userLocks.run(id, () => {
      const deleted = this.db.tx(() => {
        const u = this.findById(id);
        if (!u) throw notFound('User');
        if (id === actorId) throw conflict('You cannot delete your own account');
        if (u.role === 'ADMINISTRATOR' && this.adminCount() <= 1) throw conflict('Cannot delete the only administrator');
        this.db.run('DELETE FROM user_session WHERE user_id = ?', [id]);
        this.db.run('DELETE FROM app_user WHERE user_id = ?', [id]);
        return toAuthUser(u);
      });
      // Belt and braces: no session may outlive its account (sign-in also refuses to insert one for a
      // deleted user, and authenticate/refresh reject sessions without a user).
      this.db.run('DELETE FROM user_session WHERE user_id = ?', [id]);
      return deleted;
    });
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

  /**
   * Inserts a session row for an existing user. Synchronous, so callers run it inside the transaction that
   * re-checked the account. Its created_ms is strictly after the user's current revocation instant, so it
   * survives a revocation that the same transaction already made (changePassword) and no later one.
   */
  private insertSession(userId: number, client: ClientInfo): { sessionId: string; secret: string; accessKey: string } {
    const u = this.db.get<{ revoked_at_ms: number }>('SELECT revoked_at_ms FROM app_user WHERE user_id = ?', [userId]);
    if (!u) throw sessionEnded();
    const sessionId = randomToken(16);
    const secret = randomToken(32);
    // Independent of sessionId, so an access token can't be turned into (half of) a refresh cookie.
    const accessKey = randomToken(16);
    this.db.run(
      'INSERT INTO user_session (session_id, user_id, token_hash, expires_at, ip, user_agent, created_ms, access_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        sessionId,
        userId,
        sha256(secret),
        nowSeconds() + this.config.auth.refreshTokenTtl,
        client.ip,
        client.userAgent?.slice(0, 300) ?? null,
        Math.max(Date.now(), Number(u.revoked_at_ms) + 1),
        accessKey,
      ],
    );
    return { sessionId, secret, accessKey };
  }

  private async accessFor(user: UserRow, accessKey: string): Promise<AuthSession> {
    const ttl = this.config.auth.accessTokenTtl;
    return { accessToken: await this.signer.signAccess(user.user_id, accessKey, ttl), expiresIn: ttl, user: toAuthUser(user) };
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
    const ok = await this.passwords.verify(password, user?.password_hash ?? (await dummyHash()));
    // The account may have been deleted, its password reset or its sessions revoked (e.g. a role change) while
    // the hash ran. Re-check against the committed row and create the session in the same transaction, so a
    // revocation either lands first (and this sign-in fails) or after (and removes this session).
    const issued = user && ok ? this.db.tx(() => {
      const cur = this.reread(user);
      if (!cur || cur.password_hash !== user.password_hash || cur.revoked_at_ms !== user.revoked_at_ms) return null;
      this.db.run(`UPDATE app_user SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`, [cur.user_id]);
      return { user: cur, ...this.insertSession(cur.user_id, client) };
    }) : null;
    if (user && ok && !issued) {
      // Not a guess, so it neither counts towards the lockout nor spends the IP budget.
      this.loginLockout.succeed(account);
      this.loginIpLimiter.refund(ipKey);
      this.audit({ action: 'auth.login_failed', user: who, ip: client.ip, details: 'Account changed during sign-in (deleted, password reset or sessions revoked)' });
      throw invalidCredentials();
    }
    if (!issued) {
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
      throw invalidCredentials();
    }
    this.loginLockout.succeed(account);
    this.loginIpLimiter.refund(ipKey);
    this.audit({ action: 'auth.login', user: toAuthUser(issued.user), ip: client.ip });
    return { session: await this.accessFor(issued.user, issued.accessKey), refreshToken: `${issued.sessionId}.${issued.secret}` };
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
    const { sessionId, secret, accessKey } = this.db.tx(() => this.insertSession(user.userId, client));
    return { session: await this.accessFor(this.findById(user.userId)!, accessKey), refreshToken: `${sessionId}.${secret}` };
  }

  /**
   * What the presented secret is to session `s`: its current secret, the one it rotated away from moments ago
   * (`grace`: another tab's concurrent refresh), one it rotated away from earlier (`superseded`: a copy of an
   * old cookie is in use, i.e. likely theft), or nothing at all (null). Only the first three prove the caller
   * holds, or once held, this session's cookie.
   */
  private matchSecret(s: SessionRow, secret: string, now: number): 'current' | 'grace' | 'superseded' | null {
    const presented = sha256(secret);
    if (safeEqual(presented, s.token_hash)) return 'current';
    if (s.prev_token_hash && safeEqual(presented, s.prev_token_hash)) {
      return s.rotated_at && now - s.rotated_at <= ROTATION_GRACE_SECONDS ? 'grace' : 'superseded';
    }
    const old = this.db.scalar<number>('SELECT COUNT(*) FROM user_session_superseded WHERE session_id = ? AND token_hash = ?', [s.session_id, presented]);
    return old > 0 ? 'superseded' : null;
  }

  /**
   * Rotates the refresh token. Presenting a token the session has already rotated away from (outside the
   * short grace window) revokes the session (likely theft). A wrong secret, an unknown session, an expired
   * or revoked one all fail identically (401 SESSION_EXPIRED) and a wrong secret changes nothing, so the
   * session id alone can neither end a session nor tell whether it exists.
   */
  async refresh(token: string | undefined, client: ClientInfo): Promise<IssuedSession> {
    const parsed = parseRefreshToken(token);
    if (!parsed) throw refreshFailed();
    const { sessionId, secret } = parsed;
    const s = this.db.get<SessionRow>('SELECT * FROM user_session WHERE session_id = ?', [sessionId]);
    const now = nowSeconds();
    const match = s ? this.matchSecret(s, secret, now) : null;
    if (!s || !match) throw refreshFailed();
    // Throttle per session, counting only callers that hold one of its secrets: someone with just the id
    // can't spend the owner's budget, learn that the id exists, or grow the limiter's memory.
    const key = `refresh|${sessionId}`;
    try {
      this.refreshLimiter.hit(key);
    } catch (e) {
      const u = this.findById(s.user_id);
      this.auditThrottled(key, { action: 'auth.rate_limited', user: u ? toAuthUser(u) : null, path: '/api/auth/refresh', status: 429, ip: client.ip });
      throw e;
    }
    const user = this.findById(s.user_id);
    // Expired, or (defence in depth) its account is gone or it predates the account's last revocation: dead.
    if (s.expires_at <= now || !user || !sessionCurrent(s, user)) {
      this.db.run('DELETE FROM user_session WHERE session_id = ?', [sessionId]);
      throw refreshFailed();
    }
    // Sessions from before migration 007 get their access key on first refresh.
    const accessKey = s.access_key ?? randomToken(16);

    if (match === 'current') {
      const next = randomToken(32);
      this.db.tx(() => {
        this.db.run(
          `UPDATE user_session SET prev_token_hash = token_hash, token_hash = ?, rotated_at = ?, expires_at = ?,
             last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ip = ?, access_key = ? WHERE session_id = ?`,
          [sha256(next), now, now + this.config.auth.refreshTokenTtl, client.ip, accessKey, sessionId],
        );
        this.db.run('INSERT OR IGNORE INTO user_session_superseded (session_id, token_hash, superseded_at) VALUES (?, ?, ?)', [
          sessionId,
          s.token_hash,
          now,
        ]);
        this.db.run(
          `DELETE FROM user_session_superseded WHERE session_id = ? AND rowid NOT IN
             (SELECT rowid FROM user_session_superseded WHERE session_id = ? ORDER BY superseded_at DESC, rowid DESC LIMIT ?)`,
          [sessionId, sessionId, SUPERSEDED_HISTORY],
        );
      });
      return { session: await this.accessFor(user, accessKey), refreshToken: `${sessionId}.${next}` };
    }
    if (match === 'grace') {
      // Another tab rotated a moment ago; the browser already holds the new cookie.
      if (!s.access_key) this.db.run('UPDATE user_session SET access_key = ? WHERE session_id = ?', [accessKey, sessionId]);
      return { session: await this.accessFor(user, accessKey), refreshToken: null };
    }
    // A secret this session has genuinely rotated away from: two holders of the cookie, so end the session.
    this.db.run('DELETE FROM user_session WHERE session_id = ?', [sessionId]);
    this.audit({ action: 'auth.refresh_reuse', user: toAuthUser(user), ip: client.ip, details: 'Rotated refresh token reused; session revoked' });
    throw unauthorized('Your session has ended. Sign in again.', 'SESSION_REVOKED');
  }

  /**
   * Ends the session the cookie belongs to, but only if the cookie's secret is the session's current one (or
   * the one rotated away from within the grace window, for a tab that hasn't seen the new cookie yet).
   * Anything else is silently ignored: no deletion, no audit row. The route answers 204 either way.
   */
  logout(token: string | undefined, client: ClientInfo): void {
    const parsed = parseRefreshToken(token);
    if (!parsed) return;
    const s = this.db.get<SessionRow>('SELECT * FROM user_session WHERE session_id = ?', [parsed.sessionId]);
    if (!s) return;
    const match = this.matchSecret(s, parsed.secret, nowSeconds());
    if (match !== 'current' && match !== 'grace') return;
    this.db.run('DELETE FROM user_session WHERE session_id = ?', [s.session_id]);
    const u = this.findById(s.user_id);
    this.audit({ action: 'auth.logout', user: u ? toAuthUser(u) : null, ip: client.ip });
  }

  /**
   * Revokes every session of the user: deletes the rows and moves the revocation instant (epoch ms) to now,
   * strictly past the previous instant and every session that existed, so nothing created up to this point,
   * even in the same millisecond, is accepted again. Sessions inserted afterwards get a later created_ms.
   */
  revokeAll(userId: number): void {
    this.db.tx(() => {
      const newest = this.db.scalar<number | null>('SELECT MAX(created_ms) FROM user_session WHERE user_id = ?', [userId]) ?? 0;
      this.db.run('DELETE FROM user_session WHERE user_id = ?', [userId]);
      this.db.run('UPDATE app_user SET revoked_at_ms = MAX(?, revoked_at_ms + 1, ?) WHERE user_id = ?', [Date.now(), Number(newest), userId]);
      // The legacy seconds column, so a rolled-back server still rejects tokens issued before this second.
      this.db.run('UPDATE app_user SET tokens_invalid_before = revoked_at_ms / 1000 WHERE user_id = ?', [userId]);
    });
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
    // An access token is only as good as its session row (found by its access key, never by session id): it must
    // exist, belong to this (existing) user and have been created strictly after the user's last revocation. That
    // comparison is in ms (the token's whole-second `iat` is too coarse: a token minted in the same second as a
    // revocation used to survive it).
    if (!user) throw sessionEnded();
    const s = this.db.get<{ expires_at: number; created_ms: number }>(
      'SELECT expires_at, created_ms FROM user_session WHERE access_key = ? AND user_id = ?',
      [claims.accessKey, user.user_id],
    );
    if (!s || s.expires_at <= nowSeconds() || !sessionCurrent(s, user)) throw sessionEnded();
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
    const unchanged = (row: UserRow | undefined): row is UserRow => !!row && row.revoked_at_ms === start.revoked_at_ms;
    return this.userLocks.run(userId, async () => {
      const u = this.reread(start);
      if (!unchanged(u)) throw sessionEnded();
      if (!(await this.passwords.verify(current, u.password_hash))) throw badRequest('The current password is not correct');
      const hash = await this.passwords.hash(next);
      const { sessionId, secret, accessKey } = this.db.tx(() => {
        if (!unchanged(this.reread(u))) throw sessionEnded();
        // Only replace the hash that was verified above.
        const r = this.db.run(
          `UPDATE app_user SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ? AND password_hash = ?`,
          [hash, userId, u.password_hash],
        );
        if (r.changes === 0) throw conflict('Your password was changed meanwhile. Sign in again and retry.');
        this.revokeAll(userId);
        // The replacement session is created in the same transaction, so any later revocation removes it too.
        // insertSession stamps it strictly after the revocation just made, so it works immediately.
        return this.insertSession(userId, client);
      });
      const fresh = this.findById(userId)!;
      this.audit({ action: 'auth.password_changed', user: toAuthUser(fresh), ip: client.ip });
      return { session: await this.accessFor(fresh, accessKey), refreshToken: `${sessionId}.${secret}` };
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
