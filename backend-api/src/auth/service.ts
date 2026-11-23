import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../config';
import type { Db } from '../db';
import { badRequest, conflict, HttpError, notFound, unauthorized } from '../http';
import type { AuditEntry, AuthSession, AuthUser, Role, User } from '../../../shared/types';
import { dummyHash, hashPassword, verifyPassword } from './passwords';
import { fingerprint, randomToken, safeEqual, sha256, TokenSigner } from './tokens';
import type { Mailer } from './mailer';
import { RateLimiter } from './rate-limit';

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

export class AuthService {
  readonly authLimiter: RateLimiter;
  readonly apiLimiter: RateLimiter;
  /** One-time code required to create the first administrator; null once any user exists. */
  private setupCode: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly signer: TokenSigner,
    private readonly mailer: Mailer | null,
  ) {
    this.authLimiter = new RateLimiter(config.auth.authRateLimit);
    this.apiLimiter = new RateLimiter(config.auth.apiRateLimit);
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

  async createUser(input: { email: string; password: string; role: Role; displayName?: string | null }): Promise<AuthUser> {
    const email = input.email.trim();
    if (this.findByEmail(email)) throw conflict(`A user with email ${email} already exists`);
    const hash = await hashPassword(input.password);
    const { lastInsertRowid } = this.db.run('INSERT INTO app_user (email, display_name, password_hash, role) VALUES (?, ?, ?, ?)', [
      email,
      input.displayName?.trim() || null,
      hash,
      input.role,
    ]);
    return toAuthUser(this.findById(lastInsertRowid)!);
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
    const u = this.findById(id);
    if (!u) throw notFound('User');
    if (patch.role && patch.role !== 'ADMINISTRATOR' && u.role === 'ADMINISTRATOR' && this.adminCount() <= 1) {
      throw conflict('This is the only administrator. Make someone else an administrator first.');
    }
    const hash = patch.password === undefined ? null : await hashPassword(patch.password);
    this.db.tx(() => {
      if (patch.displayName !== undefined) this.db.run('UPDATE app_user SET display_name = ? WHERE user_id = ?', [patch.displayName?.trim() || null, id]);
      if (patch.role !== undefined) this.db.run('UPDATE app_user SET role = ? WHERE user_id = ?', [patch.role, id]);
      if (hash) this.db.run('UPDATE app_user SET password_hash = ? WHERE user_id = ?', [hash, id]);
      this.db.run(`UPDATE app_user SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`, [id]);
      // A new role or password must take effect everywhere immediately.
      if ((patch.role !== undefined && patch.role !== u.role) || hash) this.revokeAll(id);
    });
    return this.getUser(id);
  }

  deleteUser(id: number, actorId: number): void {
    const u = this.findById(id);
    if (!u) throw notFound('User');
    if (id === actorId) throw conflict('You cannot delete your own account');
    if (u.role === 'ADMINISTRATOR' && this.adminCount() <= 1) throw conflict('Cannot delete the only administrator');
    this.db.tx(() => {
      this.db.run('DELETE FROM user_session WHERE user_id = ?', [id]);
      this.db.run('DELETE FROM app_user WHERE user_id = ?', [id]);
    });
  }

  updateProfile(userId: number, displayName: string | null): AuthUser {
    this.db.run(`UPDATE app_user SET display_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`, [
      displayName?.trim() || null,
      userId,
    ]);
    return toAuthUser(this.findById(userId)!);
  }

  // ---------- sessions ----------

  private async issue(user: UserRow, client: ClientInfo): Promise<IssuedSession> {
    const sessionId = randomToken(16);
    const secret = randomToken(32);
    this.db.run('INSERT INTO user_session (session_id, user_id, token_hash, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)', [
      sessionId,
      user.user_id,
      sha256(secret),
      nowSeconds() + this.config.auth.refreshTokenTtl,
      client.ip,
      client.userAgent?.slice(0, 300) ?? null,
    ]);
    return { session: await this.accessFor(user, sessionId), refreshToken: `${sessionId}.${secret}` };
  }

  private async accessFor(user: UserRow, sessionId: string): Promise<AuthSession> {
    const ttl = this.config.auth.accessTokenTtl;
    return { accessToken: await this.signer.signAccess(user.user_id, sessionId, ttl), expiresIn: ttl, user: toAuthUser(user) };
  }

  async login(email: string, password: string, client: ClientInfo): Promise<IssuedSession> {
    const user = this.findByEmail(email);
    // Hash even when the user doesn't exist so response time doesn't reveal which emails are registered.
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash()));
    if (!user || !ok) {
      this.audit({ action: 'auth.login_failed', ip: client.ip, details: email.trim().slice(0, 200) });
      throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
    }
    this.db.run(`UPDATE app_user SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`, [user.user_id]);
    this.audit({ action: 'auth.login', user: toAuthUser(user), ip: client.ip });
    return this.issue(user, client);
  }

  async setup(code: string, input: { email: string; password: string; displayName?: string | null }, client: ClientInfo): Promise<IssuedSession> {
    if (!this.setupCode || !this.setupRequired) throw new HttpError(409, 'Parsimony is already set up', undefined, 'ALREADY_SET_UP');
    if (!safeEqual(code.trim().toUpperCase(), this.setupCode)) {
      this.audit({ action: 'auth.setup_failed', ip: client.ip });
      throw unauthorized('The setup code is not correct. It is printed in the server log.', 'INVALID_SETUP_CODE');
    }
    const user = await this.createUser({ ...input, role: 'ADMINISTRATOR' });
    this.setupCode = null;
    this.audit({ action: 'auth.setup', user, ip: client.ip });
    return this.issue(this.findById(user.userId)!, client);
  }

  /** Rotates the refresh token. Presenting an already-rotated token revokes the session (likely theft). */
  async refresh(token: string | undefined, client: ClientInfo): Promise<IssuedSession> {
    const [sessionId, secret] = (token ?? '').split('.');
    if (!sessionId || !secret) throw unauthorized('Your session has ended. Sign in again.', 'SESSION_EXPIRED');
    const s = this.db.get<SessionRow>('SELECT * FROM user_session WHERE session_id = ?', [sessionId]);
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
    const u = this.findById(userId);
    if (!u) throw notFound('User');
    if (!(await verifyPassword(current, u.password_hash))) throw badRequest('The current password is not correct');
    const hash = await hashPassword(next);
    this.db.tx(() => {
      this.db.run(`UPDATE app_user SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`, [hash, userId]);
      this.revokeAll(userId);
    });
    this.audit({ action: 'auth.password_changed', user: toAuthUser(u), ip: client.ip });
    // Tokens issued in the same second as the revocation are still valid, so the new session works immediately.
    return this.issue(this.findById(userId)!, client);
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
    const u = this.findById(claims.userId);
    if (!u || !safeEqual(claims.fingerprint, fingerprint(u.password_hash))) throw invalid();
    const hash = await hashPassword(next);
    this.db.tx(() => {
      this.db.run(`UPDATE app_user SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`, [hash, u.user_id]);
      this.revokeAll(u.user_id);
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
