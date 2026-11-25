import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADMIN, gate, refreshCookie, startApp, waitFor, type TestApp } from './helpers';
import { Db } from '../src/db';
import { listMigrations, migrate } from '../src/migrations';
import { hashPassword } from '../src/auth/passwords';
import { KeyedMutex } from '../src/auth/locks';

// Regression tests for pentest finding 2 (2026-11-24): credential writes checked preconditions, yielded the
// event loop for scrypt, then wrote by a (reusable) numeric user id with nothing serialising the halves.
// Hashing is held in flight deterministically by gating `auth.passwords` on specific plaintexts.

async function withApp(fn: (t: TestApp, adminToken: string, hold: ReturnType<typeof gate>) => Promise<void>): Promise<void> {
  const t = await startApp();
  try {
    const { token } = await t.login(ADMIN.email, ADMIN.password);
    await fn(t, token, gate(t));
  } finally {
    await t.close();
  }
}

async function createUser(t: TestApp, token: string, email: string, password: string, role = 'EDITOR'): Promise<number> {
  const res = await t.api('POST', '/api/users', { email, password, role, displayName: null }, { token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.userId;
}

const userById = async (t: TestApp, token: string, id: number) =>
  ((await t.api('GET', '/api/users', undefined, { token })).data as any[]).find((u) => u.userId === id);

const loginStatus = async (t: TestApp, email: string, password: string) => (await t.api('POST', '/api/auth/login', { email, password })).status;

/** Asserts a session returned by an API call is dead: its access token and its refresh cookie. */
async function assertSessionDead(t: TestApp, res: { data: any; headers: Headers }) {
  assert.equal((await t.api('GET', '/api/auth/me', undefined, { token: res.data.accessToken })).status, 401);
  const cookie = refreshCookie(res.headers);
  assert.ok(cookie);
  assert.equal((await t.api('POST', '/api/auth/refresh', undefined, { cookie })).status, 401);
}

describe('credential writes are serialised per user', () => {
  test('case 1: revoke-sessions and an admin password reset land after an in-flight password change', async () => {
    await withApp(async (t, admin, hold) => {
      const id = await createUser(t, admin, 'victim@example.test', 'victim-password-1');
      const victim = await t.login('victim@example.test', 'victim-password-1');

      const h = hold('chosen-by-user-1');
      const change = t.api('POST', '/api/auth/password', { currentPassword: 'victim-password-1', newPassword: 'chosen-by-user-1' }, { token: victim.token });
      await h.entered;
      const revoke = t.api('POST', `/api/users/${id}/revoke-sessions`, undefined, { token: admin });
      await waitFor(() => t.app.auth.userLocks.pending(id) === 2, 'revoke to queue');
      const reset = t.api('PATCH', `/api/users/${id}`, { password: 'chosen-by-admin-1' }, { token: admin });
      await waitFor(() => t.app.auth.userLocks.pending(id) === 3, 'reset to queue');
      h.release();

      const [c, r, p] = await Promise.all([change, revoke, reset]);
      assert.equal(c.status, 200, JSON.stringify(c.data));
      assert.equal(r.status, 204);
      assert.equal(p.status, 200);
      // The administrator's actions win: their password works, the user's doesn't, and "sign out all
      // sessions" ended the session the password change handed out.
      assert.equal(await loginStatus(t, 'victim@example.test', 'chosen-by-user-1'), 401);
      assert.equal(await loginStatus(t, 'victim@example.test', 'chosen-by-admin-1'), 200);
      await assertSessionDead(t, c);
    });
  });

  test('case 1 (out of process): a revocation committed during the hash stops the change and its session', async () => {
    await withApp(async (t, admin, hold) => {
      const id = await createUser(t, admin, 'victim@example.test', 'victim-password-1');
      const victim = await t.login('victim@example.test', 'victim-password-1');
      const h = hold('chosen-by-user-1');
      const change = t.api('POST', '/api/auth/password', { currentPassword: 'victim-password-1', newPassword: 'chosen-by-user-1' }, { token: victim.token });
      await h.entered;
      // What `npm run users -- reset-password` does from another process (no shared lock).
      const cliHash = await hashPassword('chosen-by-cli-1');
      t.app.db.run(`UPDATE app_user SET password_hash = ?, revoked_at_ms = ? WHERE user_id = ?`, [cliHash, Date.now(), id]);
      t.app.db.run('DELETE FROM user_session WHERE user_id = ?', [id]);
      h.release();

      const c = await change;
      assert.equal(c.status, 401, JSON.stringify(c.data));
      assert.equal(refreshCookie(c.headers), null);
      assert.equal(t.app.db.scalar('SELECT COUNT(*) FROM user_session WHERE user_id = ?', [id]), 0);
      assert.equal(await loginStatus(t, 'victim@example.test', 'chosen-by-user-1'), 401);
      assert.equal(await loginStatus(t, 'victim@example.test', 'chosen-by-cli-1'), 200);
    });
  });

  test('case 2: a password change in flight while the user is deleted never reaches a new administrator', async () => {
    await withApp(async (t, admin, hold) => {
      const id = await createUser(t, admin, 'reader@example.test', 'reader-password-1', 'READ_ONLY');
      const reader = await t.login('reader@example.test', 'reader-password-1');

      // Through the API: the delete waits for the change, then removes the user and the fresh session.
      const h = hold('attacker-pass-1');
      const change = t.api('POST', '/api/auth/password', { currentPassword: 'reader-password-1', newPassword: 'attacker-pass-1' }, { token: reader.token });
      await h.entered;
      const del = t.api('DELETE', `/api/users/${id}`, undefined, { token: admin });
      await waitFor(() => t.app.auth.userLocks.pending(id) === 2, 'delete to queue');
      h.release();
      const [c, d] = await Promise.all([change, del]);
      assert.equal(c.status, 200);
      assert.equal(d.status, 204);
      await assertSessionDead(t, c);

      const newAdmin = await createUser(t, admin, 'new-admin@example.test', 'new-admin-pass-1', 'ADMINISTRATOR');
      assert.ok(newAdmin > id, `id ${id} was reused`);
      assert.equal(await loginStatus(t, 'new-admin@example.test', 'attacker-pass-1'), 401);
      assert.equal(await loginStatus(t, 'new-admin@example.test', 'new-admin-pass-1'), 200);
    });
  });

  test('case 2 (pentest sequence): delete + create while the hash is in flight; the change is refused', async () => {
    await withApp(async (t, admin, hold) => {
      const id = await createUser(t, admin, 'reader@example.test', 'reader-password-1', 'READ_ONLY');
      const reader = await t.login('reader@example.test', 'reader-password-1');
      const h = hold('attacker-pass-1');
      const change = t.api('POST', '/api/auth/password', { currentPassword: 'reader-password-1', newPassword: 'attacker-pass-1' }, { token: reader.token });
      await h.entered;
      // Delete without the lock (as another process would), then create an administrator: before the fix it
      // recycled the id and the in-flight change wrote onto it and returned an admin token.
      t.app.db.run('DELETE FROM user_session WHERE user_id = ?', [id]);
      t.app.db.run('DELETE FROM app_user WHERE user_id = ?', [id]);
      const newAdmin = await createUser(t, admin, 'new-admin@example.test', 'new-admin-pass-1', 'ADMINISTRATOR');
      assert.notEqual(newAdmin, id);
      h.release();

      const c = await change;
      assert.equal(c.status, 401, JSON.stringify(c.data));
      assert.equal(c.data.accessToken, undefined);
      assert.equal(await loginStatus(t, 'new-admin@example.test', 'attacker-pass-1'), 401);
      assert.equal(await loginStatus(t, 'new-admin@example.test', 'new-admin-pass-1'), 200);
    });
  });

  test('case 3: an admin PATCH racing delete + create never writes onto the new account', async () => {
    await withApp(async (t, admin, hold) => {
      const x = await createUser(t, admin, 'x@example.test', 'x-password-1');

      const h = hold('patched-pass-1');
      const patch = t.api('PATCH', `/api/users/${x}`, { role: 'ADMINISTRATOR', password: 'patched-pass-1' }, { token: admin });
      await h.entered;
      const del = t.api('DELETE', `/api/users/${x}`, undefined, { token: admin });
      await waitFor(() => t.app.auth.userLocks.pending(x) === 2, 'delete to queue');
      const y = await createUser(t, admin, 'y@example.test', 'y-password-1');
      assert.notEqual(y, x);
      h.release();
      const [p, d] = await Promise.all([patch, del]);
      assert.equal(p.status, 200);
      assert.equal(p.data.email, 'x@example.test');
      assert.equal(d.status, 204);

      const yUser = await userById(t, admin, y);
      assert.equal(yUser.role, 'EDITOR');
      assert.equal(await loginStatus(t, 'y@example.test', 'patched-pass-1'), 401);
      assert.equal(await loginStatus(t, 'y@example.test', 'y-password-1'), 200);
      const audit = (await t.api('GET', '/api/audit?action=user.&pageSize=50', undefined, { token: admin })).data.items as any[];
      assert.ok(audit.some((a) => a.action === 'user.update' && a.details.startsWith('x@example.test:')));
      assert.ok(audit.some((a) => a.action === 'user.delete' && a.details === 'x@example.test'));
    });
  });

  test('case 3 (out of process): a PATCH whose target vanished during the hash is a 404 and writes nothing', async () => {
    await withApp(async (t, admin, hold) => {
      const x = await createUser(t, admin, 'x@example.test', 'x-password-1');
      const h = hold('patched-pass-1');
      const patch = t.api('PATCH', `/api/users/${x}`, { role: 'ADMINISTRATOR', password: 'patched-pass-1' }, { token: admin });
      await h.entered;
      t.app.db.run('DELETE FROM app_user WHERE user_id = ?', [x]);
      const y = await createUser(t, admin, 'y@example.test', 'y-password-1');
      h.release();
      const p = await patch;
      assert.equal(p.status, 404);
      assert.equal(t.app.db.scalar("SELECT COUNT(*) FROM app_user WHERE role = 'ADMINISTRATOR'"), 1);
      assert.equal((await userById(t, admin, y)).role, 'EDITOR');
      assert.equal(await loginStatus(t, 'y@example.test', 'y-password-1'), 200);
      const audit = (await t.api('GET', '/api/audit?action=user.update', undefined, { token: admin })).data.items as any[];
      assert.equal(audit.length, 0);
    });
  });

  test('case 4: two concurrent creates with the same email give 200 and 409, not 500', async () => {
    await withApp(async (t, admin, hold) => {
      const h = hold('first-pass-1');
      const first = t.api('POST', '/api/users', { email: 'dup@example.test', password: 'first-pass-1', role: 'EDITOR' }, { token: admin });
      await h.entered;
      const second = await t.api('POST', '/api/users', { email: 'DUP@example.test', password: 'second-pass-1', role: 'EDITOR' }, { token: admin });
      assert.equal(second.status, 200);
      h.release();
      const f = await first;
      assert.equal(f.status, 409, JSON.stringify(f.data));
      assert.equal(f.data.code, 'CONFLICT');
      assert.equal(t.app.db.scalar("SELECT COUNT(*) FROM app_user WHERE email = 'dup@example.test'"), 1);
      assert.equal(await loginStatus(t, 'dup@example.test', 'second-pass-1'), 200);
    });
  });

  test('case 5: two concurrent demotions cannot leave the deployment without an administrator', async () => {
    await withApp(async (t, admin, hold) => {
      const me = (await t.api('GET', '/api/auth/me', undefined, { token: admin })).data.userId;
      const other = await createUser(t, admin, 'admin2@example.test', 'admin2-password-1', 'ADMINISTRATOR');
      const h1 = hold('demoted-pass-1');
      const h2 = hold('demoted-pass-2');
      const a = t.api('PATCH', `/api/users/${me}`, { role: 'EDITOR', password: 'demoted-pass-1' }, { token: admin });
      const b = t.api('PATCH', `/api/users/${other}`, { role: 'EDITOR', password: 'demoted-pass-2' }, { token: admin });
      await Promise.all([h1.entered, h2.entered]);
      h1.release();
      assert.equal((await a).status, 200);
      h2.release();
      const rb = await b;
      assert.equal(rb.status, 409, JSON.stringify(rb.data));
      assert.equal(t.app.db.scalar("SELECT COUNT(*) FROM app_user WHERE role = 'ADMINISTRATOR'"), 1);
      assert.equal(await loginStatus(t, 'admin2@example.test', 'admin2-password-1'), 200);
    });
  });

  test('a password-reset link used twice concurrently changes the password once', async () => {
    await withApp(async (t, _admin, hold) => {
      assert.equal((await t.api('POST', '/api/auth/forgot-password', { email: ADMIN.email })).status, 200);
      await waitFor(() => t.mail.length === 1, 'reset mail');
      const token = decodeURIComponent(/token=([^\s]+)/.exec(t.mail[0].text)![1]);
      const h = hold('reset-one-pass-1');
      const one = t.api('POST', '/api/auth/reset-password', { token, newPassword: 'reset-one-pass-1' });
      await h.entered;
      const two = t.api('POST', '/api/auth/reset-password', { token, newPassword: 'reset-two-pass-1' });
      await waitFor(() => t.app.auth.userLocks.pending(1) === 2, 'second reset to queue');
      h.release();
      assert.equal((await one).status, 200);
      assert.equal((await two).status, 400);
      assert.equal(await loginStatus(t, ADMIN.email, 'reset-one-pass-1'), 200);
      assert.equal(await loginStatus(t, ADMIN.email, 'reset-two-pass-1'), 401);
    });
  });

  test('two first-run setups racing with the code create only one administrator', async () => {
    const t = await startApp({ seed: false });
    try {
      const hold = gate(t);
      const code = t.app.setupCode!;
      const h = hold('first-admin-pass-1');
      const one = t.api('POST', '/api/auth/setup', { setupCode: code, email: 'one@example.test', password: 'first-admin-pass-1' });
      await h.entered;
      const two = await t.api('POST', '/api/auth/setup', { setupCode: code, email: 'two@example.test', password: 'second-admin-pass-1' });
      assert.equal(two.status, 200);
      h.release();
      assert.equal((await one).status, 409);
      assert.equal(t.app.db.scalar('SELECT COUNT(*) FROM app_user'), 1);
    } finally {
      await t.close();
    }
  });
});

describe('user ids are never reused', () => {
  test('migration 004 keeps users and ids, and numbers new users after every id in history', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsimony-mig-'));
    const db = new Db(path.join(dir, 'db.sqlite'));
    try {
      // A database as it was before migration 004.
      db.raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
      for (const m of listMigrations().filter((m) => m.id < '004')) {
        db.raw.exec(fs.readFileSync(m.file, 'utf8'));
        db.run('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
      }
      for (const [id, email, role] of [
        [1, 'a@example.test', 'ADMINISTRATOR'],
        [2, 'b@example.test', 'EDITOR'],
        [3, 'c@example.test', 'READ_ONLY'],
      ] as const) {
        db.run(`INSERT INTO app_user (user_id, email, password_hash, role, tokens_invalid_before, created_at) VALUES (?, ?, 'h', ?, 42, '2025-01-01T00:00:00.000Z')`, [id, email, role]);
      }
      db.run("INSERT INTO user_session (session_id, user_id, token_hash, expires_at) VALUES ('s', 2, 't', 0)");
      db.run("INSERT INTO audit_log (user_id, action) VALUES (9, 'user.create')"); // a user deleted long ago
      db.run('DELETE FROM app_user WHERE user_id = 3');

      assert.ok(migrate(db).includes('004_user_id_autoincrement'));
      assert.match(db.scalar<string>("SELECT sql FROM sqlite_master WHERE name = 'app_user'"), /AUTOINCREMENT/);
      const rows = db.all<{ user_id: number; email: string; tokens_invalid_before: number; created_at: string }>('SELECT * FROM app_user ORDER BY user_id');
      assert.deepEqual(
        rows.map((r) => [r.user_id, r.email, r.tokens_invalid_before, r.created_at]),
        [
          [1, 'a@example.test', 42, '2025-01-01T00:00:00.000Z'],
          [2, 'b@example.test', 42, '2025-01-01T00:00:00.000Z'],
        ],
      );
      // Email stays unique and case-insensitive.
      assert.throws(() => db.run("INSERT INTO app_user (email, password_hash, role) VALUES ('A@EXAMPLE.TEST', 'h', 'EDITOR')"), /UNIQUE/);
      const { lastInsertRowid } = db.run("INSERT INTO app_user (email, password_hash, role) VALUES ('d@example.test', 'h', 'EDITOR')");
      assert.equal(lastInsertRowid, 10);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('deleting the newest user and creating another gives a new id', async () => {
    await withApp(async (t, admin) => {
      const a = await createUser(t, admin, 'gone@example.test', 'gone-password-1');
      assert.equal((await t.api('DELETE', `/api/users/${a}`, undefined, { token: admin })).status, 204);
      const b = await createUser(t, admin, 'next@example.test', 'next-password-1');
      assert.ok(b > a);
    });
  });
});

describe('KeyedMutex', () => {
  test('runs work for one key in order, other keys independently, and survives errors', async () => {
    const m = new KeyedMutex<number>();
    const log: string[] = [];
    let open!: () => void;
    const gateP = new Promise<void>((r) => (open = r));
    const a = m.run(1, async () => {
      await gateP;
      log.push('a');
      throw new Error('boom');
    });
    const b = m.run(1, () => log.push('b'));
    const c = m.run(2, () => log.push('c'));
    await c;
    assert.deepEqual(log, ['c']);
    assert.equal(m.pending(1), 2);
    open();
    await assert.rejects(a, /boom/);
    await b;
    assert.deepEqual(log, ['c', 'a', 'b']);
    assert.equal(m.pending(1), 0);
  });
});
