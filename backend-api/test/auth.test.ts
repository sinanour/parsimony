import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, refreshCookie, startApp, type TestApp } from './helpers';

let t: TestApp;
let admin = { token: '', cookie: '' };

const EDITOR = { email: 'editor@example.test', password: 'editor-password-1' };
const VIEWER = { email: 'viewer@example.test', password: 'viewer-password-1' };

before(async () => {
  t = await startApp();
  admin = await t.login(ADMIN.email, ADMIN.password);
  for (const [u, role] of [
    [EDITOR, 'EDITOR'],
    [VIEWER, 'READ_ONLY'],
  ] as const) {
    const res = await t.api('POST', '/api/users', { ...u, role, displayName: role }, { token: admin.token });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  }
});
after(() => t.close());

describe('authentication', () => {
  test('every non-public route requires a token', async () => {
    const routes = t.app.router.list().filter((r) => r.access !== 'public');
    assert.ok(routes.length > 40);
    for (const r of routes) {
      const url = r.pattern.replace(/:[a-zA-Z]+/g, '1');
      const res = await t.api(r.method, url, r.method === 'GET' ? undefined : {});
      assert.equal(res.status, 401, `${r.method} ${r.pattern} returned ${res.status}`);
    }
  });
  test('invalid tokens are rejected', async () => {
    assert.equal((await t.api('GET', '/api/meta', undefined, { token: 'not-a-jwt' })).status, 401);
    const forged = admin.token.slice(0, -4) + (admin.token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    assert.equal((await t.api('GET', '/api/meta', undefined, { token: forged })).status, 401);
    assert.equal((await t.api('GET', '/api/meta', undefined, { headers: { Authorization: 'Basic abc' } })).status, 401);
  });
  test('wrong password and unknown email get the same answer', async () => {
    const a = await t.api('POST', '/api/auth/login', { email: ADMIN.email, password: 'wrong-password' });
    const b = await t.api('POST', '/api/auth/login', { email: 'nobody@example.test', password: 'wrong-password' });
    assert.equal(a.status, 401);
    assert.deepEqual(a.data, b.data);
  });
  test('sign-in sets a hardened refresh cookie', async () => {
    const res = await t.api('POST', '/api/auth/login', ADMIN);
    const c = res.headers.getSetCookie().find((s) => s.startsWith('parsimony_refresh='))!;
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /Path=\/api\/auth/);
    assert.equal(res.data.user.role, 'ADMINISTRATOR');
    assert.ok(res.data.expiresIn > 0);
  });
  test('Secure is added when the request came over HTTPS through a trusted proxy', async () => {
    const p = await startApp({ overrides: { trustProxy: true } });
    try {
      const res = await p.api('POST', '/api/auth/login', ADMIN, { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.match(res.headers.getSetCookie().join(';'), /Secure/);
      const plain = await p.api('POST', '/api/auth/login', ADMIN);
      assert.doesNotMatch(plain.headers.getSetCookie().join(';'), /Secure/);
    } finally {
      await p.close();
    }
  });
});

describe('sessions', () => {
  test('refresh rotates the cookie; reusing an old one revokes the session', async () => {
    const s = await t.login(EDITOR.email, EDITOR.password);
    const r1 = await t.api('POST', '/api/auth/refresh', undefined, { cookie: s.cookie });
    assert.equal(r1.status, 200);
    const c2 = refreshCookie(r1.headers)!;
    assert.ok(c2 && c2 !== s.cookie);
    assert.equal((await t.api('GET', '/api/auth/me', undefined, { token: r1.data.accessToken })).data.email, EDITOR.email);

    // Within the grace period the previous cookie still works (another tab), without rotating again.
    const grace = await t.api('POST', '/api/auth/refresh', undefined, { cookie: s.cookie });
    assert.equal(grace.status, 200);
    assert.equal(refreshCookie(grace.headers), null);

    // After the grace period, the old cookie is treated as stolen.
    t.app.db.run('UPDATE user_session SET rotated_at = rotated_at - 3600');
    const reuse = await t.api('POST', '/api/auth/refresh', undefined, { cookie: s.cookie });
    assert.equal(reuse.status, 401);
    assert.equal((await t.api('POST', '/api/auth/refresh', undefined, { cookie: c2 })).status, 401);
    assert.equal((await t.api('GET', '/api/meta', undefined, { token: r1.data.accessToken })).status, 401);
  });
  test('sign out revokes the session and its access token', async () => {
    const s = await t.login(EDITOR.email, EDITOR.password);
    const out = await t.api('POST', '/api/auth/logout', undefined, { cookie: s.cookie });
    assert.equal(out.status, 204);
    assert.equal(refreshCookie(out.headers), '');
    assert.equal((await t.api('GET', '/api/meta', undefined, { token: s.token })).status, 401);
    assert.equal((await t.api('POST', '/api/auth/refresh', undefined, { cookie: s.cookie })).status, 401);
  });
  test('sign out everywhere', async () => {
    const a = await t.login(EDITOR.email, EDITOR.password);
    const b = await t.login(EDITOR.email, EDITOR.password);
    assert.equal((await t.api('POST', '/api/auth/logout-all', undefined, { token: a.token })).status, 204);
    assert.equal((await t.api('GET', '/api/meta', undefined, { token: b.token })).status, 401);
  });
  test('changing the password signs out other sessions but keeps this one', async () => {
    const a = await t.login(VIEWER.email, VIEWER.password);
    const b = await t.login(VIEWER.email, VIEWER.password);
    const bad = await t.api('POST', '/api/auth/password', { currentPassword: 'nope-nope', newPassword: 'another-password-2' }, { token: a.token });
    assert.equal(bad.status, 400);
    const res = await t.api('POST', '/api/auth/password', { currentPassword: VIEWER.password, newPassword: 'another-password-2' }, { token: a.token });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal((await t.api('GET', '/api/meta', undefined, { token: b.token })).status, 401);
    assert.equal((await t.api('GET', '/api/meta', undefined, { token: res.data.accessToken })).status, 200);
    VIEWER.password = 'another-password-2';
  });
});

describe('authorization', () => {
  test('read-only users can read but not write', async () => {
    const v = await t.login(VIEWER.email, VIEWER.password);
    assert.equal((await t.api('GET', '/api/expenses', undefined, { token: v.token })).status, 200);
    assert.equal((await t.api('POST', '/api/accounts', { name: 'X', isCreditCard: false, isCorporate: false, isActive: true, accountNumbers: [] }, { token: v.token })).status, 403);
    assert.equal((await t.api('PATCH', `/api/expenses/${t.ids!.dollarExemptExpense}`, { category: 'X' }, { token: v.token })).status, 403);
    assert.equal((await t.api('POST', '/api/rules/preview', { descriptionFilter: 'a', minimumAmount: null, maximumAmount: null, isCorporate: false }, { token: v.token })).status, 200);
    assert.equal((await t.api('POST', '/api/rules/run', { scope: 'personal', dryRun: true }, { token: v.token })).status, 200);
    assert.equal((await t.api('POST', '/api/rules/run', { scope: 'personal', dryRun: false }, { token: v.token })).status, 403);
    assert.equal((await t.api('POST', '/api/import/parse', Buffer.from('x'), { token: v.token, headers: { 'X-File-Name': 'a.csv' } })).status, 403);
    assert.equal((await t.api('GET', '/api/users', undefined, { token: v.token })).status, 403);
  });
  test('read-only users only see masked account numbers', async () => {
    const v = await t.login(VIEWER.email, VIEWER.password);
    const accounts = (await t.api('GET', '/api/accounts', undefined, { token: v.token })).data;
    const visa = accounts.find((a: any) => a.accountIdx === t.ids!.personalVisa);
    assert.deepEqual(visa.accountNumbers, ['••••1111']);
    const full = (await t.api('GET', `/api/accounts/${t.ids!.personalVisa}`, undefined, { token: admin.token })).data;
    assert.deepEqual(full.accountNumbers, ['4500000000001111']);
  });
  test('editors can write data but not manage users', async () => {
    const e = await t.login(EDITOR.email, EDITOR.password);
    assert.equal((await t.api('PATCH', `/api/expenses/${t.ids!.dollarExemptExpense}`, { category: 'Health' }, { token: e.token })).status, 200);
    assert.equal((await t.api('GET', '/api/users', undefined, { token: e.token })).status, 403);
    assert.equal((await t.api('GET', '/api/audit', undefined, { token: e.token })).status, 403);
  });
  test('everyone can edit their own display name', async () => {
    const v = await t.login(VIEWER.email, VIEWER.password);
    const res = await t.api('PATCH', '/api/auth/me', { displayName: 'Viewer Person' }, { token: v.token });
    assert.equal(res.status, 200);
    assert.equal(res.data.displayName, 'Viewer Person');
    assert.equal((await t.api('PATCH', '/api/auth/me', { role: 'ADMINISTRATOR' }, { token: v.token })).status, 400);
  });
});

describe('user administration', () => {
  const find = async (email: string) => ((await t.api('GET', '/api/users', undefined, { token: admin.token })).data as any[]).find((u) => u.email === email);

  test('lists users with session counts', async () => {
    const list = (await t.api('GET', '/api/users', undefined, { token: admin.token })).data;
    assert.equal(list.length, 3);
    assert.ok(list.every((u: any) => !('passwordHash' in u) && !('password_hash' in u)));
  });
  test('rejects duplicate emails and weak passwords', async () => {
    assert.equal((await t.api('POST', '/api/users', { email: EDITOR.email.toUpperCase(), role: 'EDITOR', password: 'long-enough-1' }, { token: admin.token })).status, 409);
    assert.equal((await t.api('POST', '/api/users', { email: 'new@example.test', role: 'EDITOR', password: 'short' }, { token: admin.token })).status, 400);
  });
  test('changing a role takes effect immediately', async () => {
    const e = await t.login(EDITOR.email, EDITOR.password);
    const id = (await find(EDITOR.email)).userId;
    const res = await t.api('PATCH', `/api/users/${id}`, { role: 'READ_ONLY' }, { token: admin.token });
    assert.equal(res.data.role, 'READ_ONLY');
    assert.equal((await t.api('GET', '/api/meta', undefined, { token: e.token })).status, 401);
    await t.api('PATCH', `/api/users/${id}`, { role: 'EDITOR' }, { token: admin.token });
  });
  test('an administrator can reset a password', async () => {
    const id = (await find(EDITOR.email)).userId;
    assert.equal((await t.api('PATCH', `/api/users/${id}`, { password: 'reset-by-admin-1' }, { token: admin.token })).status, 200);
    EDITOR.password = 'reset-by-admin-1';
    await t.login(EDITOR.email, EDITOR.password);
  });
  test('the last administrator cannot be demoted or deleted, and nobody can delete themselves', async () => {
    const me = await find(ADMIN.email);
    assert.equal((await t.api('PATCH', `/api/users/${me.userId}`, { role: 'EDITOR' }, { token: admin.token })).status, 409);
    assert.equal((await t.api('DELETE', `/api/users/${me.userId}`, undefined, { token: admin.token })).status, 409);
  });
  test('deleting a user ends their sessions', async () => {
    const res = await t.api('POST', '/api/users', { email: 'temp@example.test', role: 'EDITOR', password: 'temporary-pass-1' }, { token: admin.token });
    const s = await t.login('temp@example.test', 'temporary-pass-1');
    assert.equal((await t.api('DELETE', `/api/users/${res.data.userId}`, undefined, { token: admin.token })).status, 204);
    assert.equal((await t.api('GET', '/api/meta', undefined, { token: s.token })).status, 401);
  });
});

describe('password reset by email', () => {
  test('sends a link that works exactly once', async () => {
    t.mail.length = 0;
    const unknown = await t.api('POST', '/api/auth/forgot-password', { email: 'nobody@example.test' });
    const known = await t.api('POST', '/api/auth/forgot-password', { email: EDITOR.email });
    assert.equal(known.status, 200);
    assert.deepEqual(unknown.data, known.data);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.mail.length, 1);
    assert.equal(t.mail[0].to, EDITOR.email);
    const link = /https:\/\/parsimony\.example\.test\/reset-password\?token=(\S+)/.exec(t.mail[0].text);
    assert.ok(link, t.mail[0].text);
    const token = decodeURIComponent(link[1]);
    assert.equal((await t.api('POST', '/api/auth/reset-password', { token, newPassword: 'from-the-email-1' })).status, 200);
    assert.equal((await t.api('POST', '/api/auth/reset-password', { token, newPassword: 'second-try-pass-1' })).status, 400);
    EDITOR.password = 'from-the-email-1';
    await t.login(EDITOR.email, EDITOR.password);
  });
  test('is disabled without a public URL', async () => {
    const p = await startApp({ seed: false, overrides: { publicUrl: '' } });
    try {
      assert.equal((await p.api('GET', '/api/config')).data.passwordResetEnabled, false);
      assert.equal((await p.api('POST', '/api/auth/forgot-password', { email: 'a@b.c' })).status, 404);
    } finally {
      await p.close();
    }
  });
});

describe('first run', () => {
  test('requires the setup code from the log, and works only once', async () => {
    const p = await startApp({ seed: false });
    try {
      assert.ok(p.app.setupCode);
      assert.equal((await p.api('GET', '/api/config')).data.setupRequired, true);
      const body = { email: 'first@example.test', password: 'first-admin-pass', displayName: 'First' };
      assert.equal((await p.api('POST', '/api/auth/setup', { ...body, setupCode: 'WRONG-CODE' })).status, 401);
      const ok = await p.api('POST', '/api/auth/setup', { ...body, setupCode: p.app.setupCode!.toLowerCase() });
      assert.equal(ok.status, 200, JSON.stringify(ok.data));
      assert.equal(ok.data.user.role, 'ADMINISTRATOR');
      assert.equal((await p.api('GET', '/api/meta', undefined, { token: ok.data.accessToken })).status, 200);
      assert.equal((await p.api('POST', '/api/auth/setup', { ...body, email: 'second@example.test', setupCode: p.app.setupCode })).status, 409);
      assert.equal((await p.api('GET', '/api/config')).data.setupRequired, false);
    } finally {
      await p.close();
    }
  });
});

describe('abuse protection and audit', () => {
  test('sign-in is rate-limited per IP', async () => {
    const p = await startApp({ seed: false, overrides: { auth: { authRateLimit: 3 } } });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await p.api('POST', '/api/auth/login', { email: 'x@y.z', password: 'whatever-1' })).status);
      assert.deepEqual(statuses, [401, 401, 401, 429]);
      const res = await p.api('POST', '/api/auth/login', { email: 'x@y.z', password: 'whatever-1' });
      assert.ok(Number(res.headers.get('retry-after')) > 0);
    } finally {
      await p.close();
    }
  });
  test('writes and sign-ins are audited', async () => {
    const res = await t.api('GET', '/api/audit?pageSize=500', undefined, { token: admin.token });
    assert.equal(res.status, 200);
    const actions = new Set(res.data.items.map((e: any) => e.action));
    for (const a of ['auth.login', 'auth.login_failed', 'auth.logout', 'user.create', 'user.update', 'api.write', 'auth.refresh_reuse', 'auth.password_reset']) {
      assert.ok(actions.has(a), `missing ${a}`);
    }
    const write = res.data.items.find((e: any) => e.action === 'api.write');
    assert.ok(write.userEmail && write.method && write.path && write.status);
    // Bodies (which may contain passwords) are never logged.
    assert.ok(!JSON.stringify(res.data).includes(ADMIN.password));
  });
  test('security headers are set and errors do not leak internals', async () => {
    const res = await t.api('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(res.data).includes(t.dir));
  });
});
