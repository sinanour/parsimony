import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADMIN, gate, refreshCookie, startApp, type TestApp } from './helpers';
import { Db } from '../src/db';
import { listMigrations, migrate } from '../src/migrations';
import { hashPassword } from '../src/auth/passwords';

// Regression tests for pentest finding 3 (2026-11-24): sign-in looked the account up, spent ~0.25 s in scrypt,
// then inserted the session row unconditionally, so a delete / password reset / role change that revoked the
// user's sessions meanwhile was overtaken and the new session survived. Revocation was also whole seconds, so
// a token minted in the same second as a revocation was accepted. The sign-in hash is held deterministically.

const VICTIM = { email: 'victim@example.test', password: 'victim-password-1' };

async function withApp(fn: (t: TestApp, admin: string, hold: ReturnType<typeof gate>) => Promise<void>): Promise<void> {
  const t = await startApp();
  try {
    const { token } = await t.login(ADMIN.email, ADMIN.password);
    await fn(t, token, gate(t));
  } finally {
    await t.close();
  }
}

async function createUser(t: TestApp, token: string, role = 'EDITOR'): Promise<number> {
  const res = await t.api('POST', '/api/users', { ...VICTIM, role, displayName: null }, { token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.userId;
}

const sessionRows = (t: TestApp, id: number) => t.app.db.scalar<number>('SELECT COUNT(*) FROM user_session WHERE user_id = ?', [id]);
const me = (t: TestApp, token: string) => t.api('GET', '/api/auth/me', undefined, { token });
const refresh = (t: TestApp, cookie: string) => t.api('POST', '/api/auth/refresh', undefined, { cookie });

/** Starts a sign-in as the victim and waits until its password check is in flight. */
async function loginInFlight(t: TestApp, hold: ReturnType<typeof gate>) {
  const h = hold(VICTIM.password);
  const login = t.api('POST', '/api/auth/login', VICTIM);
  await h.entered;
  return { login, release: h.release };
}

describe('sign-in is atomic with revocation', () => {
  test('login racing account deletion: 401 and no session row', async () => {
    await withApp(async (t, admin, hold) => {
      const id = await createUser(t, admin, 'READ_ONLY');
      const { login, release } = await loginInFlight(t, hold);
      assert.equal((await t.api('DELETE', `/api/users/${id}`, undefined, { token: admin })).status, 204);
      release();
      const res = await login;
      assert.equal(res.status, 401, JSON.stringify(res.data));
      assert.equal(res.data.accessToken, undefined);
      assert.equal(refreshCookie(res.headers), null);
      assert.equal(sessionRows(t, id), 0);
      // An administrator created afterwards inherits nothing.
      const next = await t.api('POST', '/api/users', { email: 'new-admin@example.test', password: 'new-admin-pass-1', role: 'ADMINISTRATOR' }, { token: admin });
      assert.equal(next.status, 200);
      assert.equal(sessionRows(t, next.data.userId), 0);
    });
  });

  test('login with the superseded password racing an admin password reset gets no usable session', async () => {
    await withApp(async (t, admin, hold) => {
      const id = await createUser(t, admin);
      const { login, release } = await loginInFlight(t, hold);
      const reset = await t.api('PATCH', `/api/users/${id}`, { password: 'reset-by-admin-1' }, { token: admin });
      assert.equal(reset.status, 200);
      assert.equal(reset.data.activeSessions, 0);
      release();
      const res = await login;
      assert.equal(res.status, 401, JSON.stringify(res.data));
      assert.equal(res.data.code, 'INVALID_CREDENTIALS');
      assert.equal(sessionRows(t, id), 0);
      const user = ((await t.api('GET', '/api/users', undefined, { token: admin })).data as any[]).find((u) => u.userId === id);
      assert.equal(user.activeSessions, 0);
      // Not counted as a guess, and the new password works.
      assert.equal((await t.api('POST', '/api/auth/login', { email: VICTIM.email, password: 'reset-by-admin-1' })).status, 200);
      const audit = (await t.api('GET', '/api/audit?action=auth.login_failed', undefined, { token: admin })).data.items as any[];
      assert.ok(audit.some((a) => a.userId === id && /changed during sign-in/.test(a.details)));
    });
  });

  test('login racing an out-of-process password reset (users CLI) gets no session', async () => {
    await withApp(async (t, _admin, hold) => {
      const id = await createUser(t, _admin);
      const { login, release } = await loginInFlight(t, hold);
      const cliHash = await hashPassword('reset-by-cli-1');
      t.app.db.run('UPDATE app_user SET password_hash = ? WHERE user_id = ?', [cliHash, id]);
      release();
      assert.equal((await login).status, 401);
      assert.equal(sessionRows(t, id), 0);
    });
  });

  test('login racing a role change is not issued with the stale role', async () => {
    await withApp(async (t, admin, hold) => {
      const id = await createUser(t, admin, 'ADMINISTRATOR');
      const { login, release } = await loginInFlight(t, hold);
      const patch = await t.api('PATCH', `/api/users/${id}`, { role: 'READ_ONLY' }, { token: admin });
      assert.equal(patch.status, 200);
      release();
      const res = await login;
      assert.equal(res.status, 401, JSON.stringify(res.data));
      assert.equal(sessionRows(t, id), 0);
      // Signing in again gives the new role.
      const again = await t.api('POST', '/api/auth/login', VICTIM);
      assert.equal(again.status, 200);
      assert.equal(again.data.user.role, 'READ_ONLY');
      assert.equal((await t.api('GET', '/api/users', undefined, { token: again.data.accessToken })).status, 403);
    });
  });

  test('login racing revoke-sessions gets no session', async () => {
    await withApp(async (t, admin, hold) => {
      const id = await createUser(t, admin);
      const { login, release } = await loginInFlight(t, hold);
      assert.equal((await t.api('POST', `/api/users/${id}/revoke-sessions`, undefined, { token: admin })).status, 204);
      release();
      assert.equal((await login).status, 401);
      assert.equal(sessionRows(t, id), 0);
    });
  });

  test('a login that completes before the revocation is removed by it', async () => {
    await withApp(async (t, admin) => {
      const id = await createUser(t, admin);
      const v = await t.login(VICTIM.email, VICTIM.password);
      assert.equal((await t.api('PATCH', `/api/users/${id}`, { password: 'reset-by-admin-1' }, { token: admin })).status, 200);
      assert.equal((await me(t, v.token)).status, 401);
      assert.equal((await refresh(t, v.cookie)).status, 401);
    });
  });
});

describe('revocation has sub-second precision', () => {
  test('with the clock frozen, revocation rejects earlier sessions; the session changePassword issues works', async () => {
    await withApp(async (t, admin) => {
      const id = await createUser(t, admin);
      // Everything below happens in the same millisecond.
      mock.timers.enable({ apis: ['Date'], now: Date.now() });
      try {
        const a = await t.login(VICTIM.email, VICTIM.password);
        const b = await t.login(VICTIM.email, VICTIM.password);
        assert.equal((await me(t, a.token)).status, 200);

        // An admin revocation in the same ms kills session a (and b).
        assert.equal((await t.api('POST', `/api/users/${id}/revoke-sessions`, undefined, { token: admin })).status, 204);
        assert.equal((await me(t, a.token)).status, 401);

        // A later session, then a password change in the same ms: it revokes c and issues a fresh one.
        const c = await t.login(VICTIM.email, VICTIM.password);
        const changed = await t.api('POST', '/api/auth/password', { currentPassword: VICTIM.password, newPassword: 'changed-pass-1' }, { token: c.token });
        assert.equal(changed.status, 200, JSON.stringify(changed.data));
        assert.equal((await me(t, c.token)).status, 401);
        assert.equal((await me(t, b.token)).status, 401);

        // changePassword's own fresh session, issued in the same ms after its revocation, works.
        assert.equal((await me(t, changed.data.accessToken)).status, 200);
        const r = await refresh(t, refreshCookie(changed.headers)!);
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal((await me(t, r.data.accessToken)).status, 200);
      } finally {
        mock.timers.reset();
      }
    });
  });

  test('first-run setup returns a working session', async () => {
    const t = await startApp({ seed: false });
    try {
      const res = await t.api('POST', '/api/auth/setup', { setupCode: t.app.setupCode, email: 'first@example.test', password: 'first-admin-pass-1' });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal((await me(t, res.data.accessToken)).status, 200);
      assert.equal((await refresh(t, refreshCookie(res.headers)!)).status, 200);
    } finally {
      await t.close();
    }
  });
});

describe('authenticate and refresh refuse orphaned or stale sessions', () => {
  test('a session row whose user no longer exists can neither authenticate nor refresh', async () => {
    await withApp(async (t, admin) => {
      const id = await createUser(t, admin);
      const v = await t.login(VICTIM.email, VICTIM.password);
      // Remove the account behind the service's back, leaving the session row (as the race did).
      t.app.db.run('DELETE FROM app_user WHERE user_id = ?', [id]);
      assert.equal(sessionRows(t, id), 1);
      assert.equal((await me(t, v.token)).status, 401);
      assert.equal((await refresh(t, v.cookie)).status, 401);
      assert.equal(sessionRows(t, id), 0);
    });
  });

  test('a session row created at or before the revocation instant is refused and removed', async () => {
    await withApp(async (t, admin) => {
      const id = await createUser(t, admin);
      const v = await t.login(VICTIM.email, VICTIM.password);
      // Revocation recorded at exactly the session's creation ms, without deleting the row.
      t.app.db.run('UPDATE app_user SET revoked_at_ms = (SELECT created_ms FROM user_session WHERE user_id = ?) WHERE user_id = ?', [id, id]);
      assert.equal((await me(t, v.token)).status, 401);
      assert.equal((await refresh(t, v.cookie)).status, 401);
      assert.equal(sessionRows(t, id), 0);
    });
  });

  test('startup sweeps orphaned and revoked sessions', async () => {
    await withApp(async (t, admin) => {
      const id = await createUser(t, admin);
      await t.login(VICTIM.email, VICTIM.password);
      t.app.db.run("INSERT INTO user_session (session_id, user_id, token_hash, expires_at, created_ms) VALUES ('orphan', 999, 'x', 9999999999, 1)");
      t.app.db.run('UPDATE app_user SET revoked_at_ms = ? WHERE user_id = ?', [Date.now() + 1000, id]);
      await t.app.auth.bootstrap();
      assert.equal(t.app.db.scalar("SELECT COUNT(*) FROM user_session WHERE session_id = 'orphan'"), 0);
      assert.equal(sessionRows(t, id), 0);
      // The administrator's own session is untouched.
      assert.equal((await me(t, admin)).status, 200);
    });
  });
});

describe('migration 005', () => {
  test('converts revocation to ms and drops orphaned and same-second sessions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsimony-mig-'));
    const db = new Db(path.join(dir, 'db.sqlite'));
    try {
      db.raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
      for (const m of listMigrations().filter((m) => m.id < '005')) {
        db.raw.exec(fs.readFileSync(m.file, 'utf8'));
        db.run('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
      }
      const revokedAt = Date.parse('2026-01-01T00:00:10.000Z') / 1000; // whole seconds, as before
      db.run(`INSERT INTO app_user (user_id, email, password_hash, role, tokens_invalid_before) VALUES (1, 'a@example.test', 'h', 'ADMINISTRATOR', ?)`, [revokedAt]);
      db.run(`INSERT INTO app_user (user_id, email, password_hash, role, tokens_invalid_before) VALUES (2, 'b@example.test', 'h', 'EDITOR', 0)`);
      const session = (id: string, user: number, createdAt: string) =>
        db.run('INSERT INTO user_session (session_id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, 9999999999, ?)', [id, user, 'x', createdAt]);
      session('same-second', 1, '2026-01-01T00:00:10.500Z');
      session('after', 1, '2026-01-01T00:00:11.250Z');
      session('never-revoked', 2, '2025-06-01T12:00:00.123Z');
      session('orphan', 7, '2026-02-01T00:00:00.000Z');

      assert.ok(migrate(db).includes('005_revocation_ms'));
      assert.equal(db.scalar('SELECT revoked_at_ms FROM app_user WHERE user_id = 1'), revokedAt * 1000 + 999);
      assert.equal(db.scalar('SELECT revoked_at_ms FROM app_user WHERE user_id = 2'), 0);
      // The legacy seconds column is left as it was, for older code after a rollback.
      assert.equal(db.scalar('SELECT tokens_invalid_before FROM app_user WHERE user_id = 1'), revokedAt);
      const rows = db.all<{ session_id: string; created_ms: number }>('SELECT session_id, created_ms FROM user_session ORDER BY session_id');
      assert.deepEqual(
        rows.map((r) => [r.session_id, r.created_ms]),
        [
          ['after', Date.parse('2026-01-01T00:00:11.250Z')],
          ['never-revoked', Date.parse('2025-06-01T12:00:00.123Z')],
        ],
      );
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
