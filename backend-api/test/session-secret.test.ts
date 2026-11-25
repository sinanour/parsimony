import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SignJWT, decodeJwt } from 'jose';
import { ADMIN, refreshCookie, startApp, type TestApp } from './helpers';
import { Db } from '../src/db';
import { listMigrations, migrate } from '../src/migrations';

// Regression tests for pentest finding 8 (2026-11-24): logout deleted (and audited) the session named by the
// part of the cookie before the dot without checking the secret; refresh with a known session id and a wrong
// secret was treated as token theft (session deleted, `auth.refresh_reuse` written against the owner,
// SESSION_REVOKED vs SESSION_EXPIRED for unknown ids: an existence oracle); the session id was readable in
// clear from every access token's `sid` claim; and both routes sent a cookie-clearing Set-Cookie even to
// requests that carried no cookie.

const VICTIM = { email: 'victim@example.test', password: 'victim-password-1' };

let t: TestApp;
let admin = '';
let victimId = 0;

before(async () => {
  t = await startApp();
  admin = (await t.login(ADMIN.email, ADMIN.password)).token;
  const res = await t.api('POST', '/api/users', { ...VICTIM, role: 'EDITOR', displayName: null }, { token: admin });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  victimId = res.data.userId;
});
after(() => t.close());

/** Signs the victim in; returns the access token, the cookie pair and the session id (the part before the dot). */
async function signIn() {
  const s = await t.login(VICTIM.email, VICTIM.password);
  const value = s.cookie.slice('parsimony_refresh='.length);
  return { ...s, sid: decodeURIComponent(value).split('.')[0] };
}

const sessionExists = (sid: string) => t.app.db.scalar<number>('SELECT COUNT(*) FROM user_session WHERE session_id = ?', [sid]) === 1;
const auditCount = (action: string) => t.app.db.scalar<number>('SELECT COUNT(*) FROM audit_log WHERE action = ? AND user_id = ?', [action, victimId]);
const refresh = (cookie?: string) => t.api('POST', '/api/auth/refresh', undefined, cookie === undefined ? {} : { cookie });
const logout = (cookie?: string) => t.api('POST', '/api/auth/logout', undefined, cookie === undefined ? {} : { cookie });
const me = (token: string) => t.api('GET', '/api/auth/me', undefined, { token });
const WRONG = 'A'.repeat(43);

describe('logout requires the full refresh cookie', () => {
  test('session id alone: 204, but the session survives and nothing is audited', async () => {
    const v = await signIn();
    const before = auditCount('auth.logout');
    for (const cookie of [`parsimony_refresh=${v.sid}`, `parsimony_refresh=${v.sid}.`, `parsimony_refresh=${v.sid}.x.y`]) {
      assert.equal((await logout(cookie)).status, 204, cookie);
    }
    assert.ok(sessionExists(v.sid));
    assert.equal(auditCount('auth.logout'), before);
    assert.equal((await me(v.token)).status, 200);
    assert.equal((await refresh(v.cookie)).status, 200);
  });

  test('session id with a wrong secret: same', async () => {
    const v = await signIn();
    const before = auditCount('auth.logout');
    assert.equal((await logout(`parsimony_refresh=${v.sid}.${WRONG}`)).status, 204);
    assert.ok(sessionExists(v.sid));
    assert.equal(auditCount('auth.logout'), before);
    assert.equal((await me(v.token)).status, 200);
  });

  test('a superseded secret (outside the grace window) does not sign out either', async () => {
    const v = await signIn();
    const r = await refresh(v.cookie);
    assert.equal(r.status, 200);
    t.app.db.run('UPDATE user_session SET rotated_at = rotated_at - 3600 WHERE session_id = ?', [v.sid]);
    assert.equal((await logout(v.cookie)).status, 204);
    assert.ok(sessionExists(v.sid));
    assert.equal((await me(r.data.accessToken)).status, 200);
  });

  test('the correct cookie ends the session and is audited against its owner', async () => {
    const v = await signIn();
    const before = auditCount('auth.logout');
    const out = await logout(v.cookie);
    assert.equal(out.status, 204);
    assert.equal(refreshCookie(out.headers), '');
    assert.ok(!sessionExists(v.sid));
    assert.equal(auditCount('auth.logout'), before + 1);
    assert.equal((await me(v.token)).status, 401);
  });

  test('a tab still holding the just-rotated cookie (in grace) can sign out', async () => {
    const v = await signIn();
    assert.equal((await refresh(v.cookie)).status, 200);
    assert.equal((await logout(v.cookie)).status, 204);
    assert.ok(!sessionExists(v.sid));
  });
});

describe('refresh with a wrong secret changes nothing and reveals nothing', () => {
  test('known session id + wrong secret answers exactly like an unknown id; session intact, no reuse audit', async () => {
    const v = await signIn();
    const reuse = auditCount('auth.refresh_reuse');
    const known = await refresh(`parsimony_refresh=${v.sid}.${WRONG}`);
    const unknown = await refresh(`parsimony_refresh=${'Z'.repeat(v.sid.length)}.${WRONG}`);
    const malformed = await refresh(`parsimony_refresh=${v.sid}`);
    for (const r of [known, unknown, malformed]) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.data, unknown.data);
    }
    assert.equal(known.data.code, 'SESSION_EXPIRED');
    assert.ok(sessionExists(v.sid));
    assert.equal(auditCount('auth.refresh_reuse'), reuse);
    // The owner's cookie still works (and the wrong guesses didn't spend its refresh budget either).
    assert.equal((await refresh(v.cookie)).status, 200);
  });

  test('expired and revoked sessions answer the same as unknown ones to a caller without the secret', async () => {
    const v = await signIn();
    t.app.db.run('UPDATE user_session SET expires_at = 1 WHERE session_id = ?', [v.sid]);
    const r = await refresh(`parsimony_refresh=${v.sid}.${WRONG}`);
    assert.equal(r.status, 401);
    assert.equal(r.data.code, 'SESSION_EXPIRED');
    // A wrong secret doesn't even remove the dead row; the owner's own cookie does.
    assert.ok(sessionExists(v.sid));
    const own = await refresh(v.cookie);
    assert.equal(own.status, 401);
    assert.equal(own.data.code, 'SESSION_EXPIRED');
    assert.ok(!sessionExists(v.sid));
  });

  test('genuine reuse of a superseded cookie outside the grace window revokes the session', async () => {
    const v = await signIn();
    const reuse = auditCount('auth.refresh_reuse');
    const r1 = await refresh(v.cookie);
    const c2 = refreshCookie(r1.headers)!;
    const r2 = await refresh(c2);
    const c3 = refreshCookie(r2.headers)!;
    assert.ok(c2 && c3 && c3 !== c2);
    t.app.db.run('UPDATE user_session SET rotated_at = rotated_at - 3600 WHERE session_id = ?', [v.sid]);
    t.app.db.run('UPDATE user_session_superseded SET superseded_at = superseded_at - 3600 WHERE session_id = ?', [v.sid]);
    // The first cookie is two rotations old: no longer prev_token_hash, but still recognised from the history.
    const stolen = await refresh(v.cookie);
    assert.equal(stolen.status, 401);
    assert.equal(stolen.data.code, 'SESSION_REVOKED');
    assert.ok(!sessionExists(v.sid));
    assert.equal(auditCount('auth.refresh_reuse'), reuse + 1);
    assert.equal((await refresh(c3)).status, 401);
    assert.equal((await me(r2.data.accessToken)).status, 401);
    assert.equal(t.app.db.scalar('SELECT COUNT(*) FROM user_session_superseded WHERE session_id = ?', [v.sid]), 0);
  });

  test('the previous cookie right after rotation (another tab) still refreshes without rotating', async () => {
    const v = await signIn();
    const [a, b] = await Promise.all([refresh(v.cookie), refresh(v.cookie)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal([a, b].filter((r) => refreshCookie(r.headers)).length, 1, 'exactly one of them rotates');
    assert.equal((await me(a.data.accessToken)).status, 200);
    assert.equal((await me(b.data.accessToken)).status, 200);
    assert.ok(sessionExists(v.sid));
  });

  test('superseded history is bounded per session', async () => {
    const v = await signIn();
    let cookie = v.cookie;
    for (let i = 0; i < 55; i++) {
      t.app.auth.refreshLimiter.reset();
      const r = await refresh(cookie);
      assert.equal(r.status, 200);
      cookie = refreshCookie(r.headers)!;
    }
    assert.equal(t.app.db.scalar('SELECT COUNT(*) FROM user_session_superseded WHERE session_id = ?', [v.sid]), 50);
  });
});

describe('cookie-clearing headers only for requests that carried the cookie', () => {
  test('logout and refresh without a cookie send no Set-Cookie', async () => {
    const out = await logout();
    assert.equal(out.status, 204);
    assert.deepEqual(out.headers.getSetCookie(), []);
    const r = await refresh();
    assert.equal(r.status, 401);
    assert.deepEqual(r.headers.getSetCookie(), []);
    // Other cookies don't count as the refresh cookie.
    assert.deepEqual((await logout('theme=dark')).headers.getSetCookie(), []);
  });
  test('a failed refresh with a cookie clears it', async () => {
    const r = await refresh(`parsimony_refresh=nope.${WRONG}`);
    assert.equal(r.status, 401);
    assert.equal(refreshCookie(r.headers), '');
  });
});

describe('access tokens do not reveal the session id', () => {
  test('no claim equals or contains the session id, and the key claim is no cookie handle', async () => {
    const v = await signIn();
    const r = await refresh(v.cookie);
    for (const token of [v.token, r.data.accessToken]) {
      const payload = decodeJwt(token);
      assert.equal(payload.sid, undefined);
      for (const value of Object.values(payload)) assert.ok(!String(value).includes(v.sid), `claim leaks the session id: ${value}`);
      assert.equal(typeof payload.sk, 'string');
      // Using the claim as a cookie prefix gets nowhere and doesn't touch the session.
      const before = auditCount('auth.logout');
      assert.equal((await logout(`parsimony_refresh=${payload.sk}.${WRONG}`)).status, 204);
      assert.equal((await refresh(`parsimony_refresh=${payload.sk}.${WRONG}`)).data.code, 'SESSION_EXPIRED');
      assert.equal(auditCount('auth.logout'), before);
    }
    assert.ok(sessionExists(v.sid));
    assert.equal((await me(r.data.accessToken)).status, 200);
  });

  test('old-format tokens (raw session id in `sid`) are refused, and the cookie gets a working one', async () => {
    const v = await signIn();
    const secret = new TextEncoder().encode(fs.readFileSync(path.join(t.dir, 'jwt-secret'), 'utf8').trim());
    const legacy = await new SignJWT({ sid: v.sid, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(victimId))
      .setIssuer('parsimony')
      .setIssuedAt()
      .setExpirationTime('900s')
      .sign(secret);
    const res = await me(legacy);
    assert.equal(res.status, 401);
    assert.equal(res.data.code, 'TOKEN_EXPIRED', 'the SPA refreshes on this and retries');
    const r = await refresh(v.cookie);
    assert.equal(r.status, 200);
    assert.equal((await me(r.data.accessToken)).status, 200);
  });

  test('a session from before migration 007 (no access key) gets one on refresh', async () => {
    const v = await signIn();
    t.app.db.run('UPDATE user_session SET access_key = NULL WHERE session_id = ?', [v.sid]);
    assert.equal((await me(v.token)).status, 401);
    const r = await refresh(v.cookie);
    assert.equal(r.status, 200);
    const key = t.app.db.scalar<string>('SELECT access_key FROM user_session WHERE session_id = ?', [v.sid]);
    assert.ok(key && key !== v.sid);
    assert.equal(decodeJwt(r.data.accessToken).sk, key);
    assert.equal((await me(r.data.accessToken)).status, 200);
  });
});

describe('migration 007', () => {
  test('adds access keys and superseded history, backfilled from prev_token_hash and cleaned up on delete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsimony-mig-'));
    const db = new Db(path.join(dir, 'db.sqlite'));
    try {
      db.raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
      for (const m of listMigrations().filter((m) => m.id < '007')) {
        db.raw.exec(fs.readFileSync(m.file, 'utf8'));
        db.run('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
      }
      db.run(`INSERT INTO app_user (user_id, email, password_hash, role) VALUES (1, 'a@example.test', 'h', 'ADMINISTRATOR')`);
      db.run(`INSERT INTO user_session (session_id, user_id, token_hash, prev_token_hash, rotated_at, expires_at, created_ms)
              VALUES ('rotated', 1, 'cur', 'old', 1000, 9999999999, 5)`);
      db.run(`INSERT INTO user_session (session_id, user_id, token_hash, expires_at, created_ms) VALUES ('fresh', 1, 'cur2', 9999999999, 5)`);

      assert.ok(migrate(db).includes('007_session_access_key'));
      assert.equal(db.scalar('SELECT COUNT(*) FROM user_session WHERE access_key IS NULL'), 2);
      assert.deepEqual(
        db.all('SELECT session_id, token_hash, superseded_at FROM user_session_superseded').map((r) => ({ ...r })),
        [{ session_id: 'rotated', token_hash: 'old', superseded_at: 1000 }],
      );
      db.run("DELETE FROM user_session WHERE session_id = 'rotated'");
      assert.equal(db.scalar('SELECT COUNT(*) FROM user_session_superseded'), 0);
      assert.equal(db.scalar('SELECT COUNT(*) FROM user_session'), 1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
