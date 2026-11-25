import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, refreshCookie, startApp, type TestApp } from './helpers';
import { LoginLockout, RateLimiter } from '../src/auth/rate-limit';

// Regression tests for pentest finding 1 (2026-11-24): the auth rate limit could be spent by other callers
// behind the same proxy address, and there was no per-account lockout.

const SHARED_IP = { 'X-Real-IP': '203.0.113.7' };
const OTHER_IP = { 'X-Real-IP': '198.51.100.9' };
const USER = { email: 'victim@example.test', password: 'victim-password-1' };
const OTHER = { email: 'bystander@example.test', password: 'bystander-password-1' };

type Overrides = NonNullable<Parameters<typeof startApp>[0]>['overrides'];

/** A seeded app behind a trusted proxy, with two extra users. Production defaults unless overridden. */
async function withApp(auth: NonNullable<Overrides>['auth'], fn: (t: TestApp, adminToken: string) => Promise<void>): Promise<void> {
  const t = await startApp({
    overrides: {
      trustProxy: true,
      auth: { authRateLimit: 10, loginIpFailureLimit: 100, loginLockoutThreshold: 5, loginLockoutBase: 60, loginLockoutMax: 900, refreshRateLimit: 30, ...auth },
    },
  });
  try {
    const admin = await t.api('POST', '/api/auth/login', ADMIN, { headers: { 'X-Real-IP': '192.0.2.1' } });
    assert.equal(admin.status, 200);
    for (const u of [USER, OTHER]) {
      const res = await t.api('POST', '/api/users', { ...u, role: 'EDITOR', displayName: null }, { token: admin.data.accessToken });
      assert.equal(res.status, 200, JSON.stringify(res.data));
    }
    await fn(t, admin.data.accessToken);
  } finally {
    await t.close();
  }
}

const login = (t: TestApp, body: { email: string; password: string }, headers = SHARED_IP) => t.api('POST', '/api/auth/login', body, { headers });

async function auditRows(t: TestApp, token: string, action: string): Promise<any[]> {
  const res = await t.api('GET', `/api/audit?pageSize=500&action=${encodeURIComponent(action)}`, undefined, { token });
  assert.equal(res.status, 200);
  return res.data.items.filter((e: any) => e.action === action);
}

describe('sign-in throttling (finding 1a, 1c)', () => {
  test("anonymous junk sign-ins don't block another user's correct sign-in from the same address", async () => {
    await withApp({}, async (t) => {
      for (let i = 0; i < 12; i++) assert.equal((await login(t, { email: `nobody${i}@example.test`, password: 'junk-junk-1' })).status, 401);
      // Pentest step (a): this used to be 429.
      assert.equal((await login(t, USER)).status, 200);
    });
  });

  test('successful sign-ins never use up the per-IP budget', async () => {
    await withApp({ loginIpFailureLimit: 3 }, async (t) => {
      for (let i = 0; i < 8; i++) assert.equal((await login(t, USER)).status, 200);
      assert.equal((await login(t, { email: 'nobody@example.test', password: 'junk-junk-1' })).status, 401);
    });
  });

  test('the per-IP failure budget stops mass guessing without affecting other addresses', async () => {
    await withApp({ loginIpFailureLimit: 3 }, async (t) => {
      for (let i = 0; i < 3; i++) assert.equal((await login(t, { email: `spray${i}@example.test`, password: 'junk-junk-1' })).status, 401);
      const res = await login(t, { email: 'spray9@example.test', password: 'junk-junk-1' });
      assert.equal(res.status, 429);
      assert.equal(res.data.code, 'RATE_LIMITED');
      assert.ok(Number(res.headers.get('retry-after')) > 0);
      assert.equal((await login(t, USER, OTHER_IP)).status, 200);
    });
  });

  test('repeated wrong passwords lock the account, even for the right password afterwards', async () => {
    await withApp({}, async (t) => {
      // Pentest step (c): 18 wrong passwords spaced under the IP budget, then the right one, used to succeed.
      const statuses: number[] = [];
      for (let i = 0; i < 18; i++) statuses.push((await login(t, { email: USER.email, password: `guess-${i}-password` })).status);
      assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
      assert.ok(statuses.slice(5).every((s) => s === 429), JSON.stringify(statuses));
      const right = await login(t, USER);
      assert.equal(right.status, 429);
      assert.equal(right.data.code, 'LOGIN_LOCKED');
      const retry = Number(right.headers.get('retry-after'));
      assert.ok(retry > 0 && retry <= 60, `retry-after ${retry}`);
      // Case/whitespace variants share the lock; the lock is per account, not per address.
      assert.equal((await login(t, { email: ` ${USER.email.toUpperCase()} `, password: USER.password }, OTHER_IP)).status, 429);
      // Other accounts on the same address are unaffected.
      assert.equal((await login(t, OTHER)).status, 200);
    });
  });

  test("a lock looks the same for registered and unregistered emails", async () => {
    await withApp({}, async (t) => {
      const ghost = 'ghost@example.test';
      for (let i = 0; i < 5; i++) {
        assert.equal((await login(t, { email: USER.email, password: `guess-${i}-password` })).status, 401);
        assert.equal((await login(t, { email: ghost, password: `guess-${i}-password` })).status, 401);
      }
      const known = await login(t, { email: USER.email, password: 'whatever-pass-1' });
      const unknown = await login(t, { email: ghost, password: 'whatever-pass-1' });
      assert.equal(known.status, 429);
      assert.deepEqual(unknown.data, known.data);
      assert.equal(unknown.headers.get('retry-after'), known.headers.get('retry-after'));
    });
  });

  test('a successful sign-in resets the failure streak', async () => {
    await withApp({}, async (t) => {
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 4; i++) assert.equal((await login(t, { email: USER.email, password: `guess-${i}-password` })).status, 401);
        assert.equal((await login(t, USER)).status, 200);
      }
    });
  });

  test('concurrent guesses cannot race past the lockout', async () => {
    await withApp({}, async (t) => {
      const res = await Promise.all(Array.from({ length: 25 }, (_, i) => login(t, { email: USER.email, password: `parallel-${i}-guess` })));
      const counts = res.reduce<Record<number, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
      assert.equal(counts[401], 5, JSON.stringify(counts));
      assert.equal(counts[429], 20, JSON.stringify(counts));
    });
  });
});

describe('refresh throttling (finding 1b)', () => {
  test("cookieless refresh requests (e.g. from another site) don't spend the victim's refresh budget", async () => {
    await withApp({ refreshRateLimit: 3 }, async (t) => {
      const victim = await login(t, USER);
      const cookie = refreshCookie(victim.headers)!;
      for (let i = 0; i < 12; i++) {
        const r = await t.api('POST', '/api/auth/refresh', undefined, { headers: SHARED_IP });
        assert.equal(r.status, 401);
        assert.equal(r.data.code, 'SESSION_EXPIRED');
      }
      // Pentest step (b): the SPA's session restore used to get 429 here.
      const restored = await t.api('POST', '/api/auth/refresh', undefined, { cookie, headers: SHARED_IP });
      assert.equal(restored.status, 200);
    });
  });

  test('refresh is limited per session; throttling keeps the cookie and spares other sessions', async () => {
    await withApp({ refreshRateLimit: 2 }, async (t) => {
      let cookie = refreshCookie((await login(t, USER)).headers)!;
      const otherCookie = refreshCookie((await login(t, OTHER)).headers)!;
      for (let i = 0; i < 2; i++) {
        const r = await t.api('POST', '/api/auth/refresh', undefined, { cookie, headers: SHARED_IP });
        assert.equal(r.status, 200);
        cookie = refreshCookie(r.headers)!;
      }
      const limited = await t.api('POST', '/api/auth/refresh', undefined, { cookie, headers: SHARED_IP });
      assert.equal(limited.status, 429);
      assert.equal(refreshCookie(limited.headers), null, 'a throttled refresh must not clear the cookie');
      assert.equal((await t.api('POST', '/api/auth/refresh', undefined, { cookie: otherCookie, headers: SHARED_IP })).status, 200);
    });
  });
});

describe('other auth routes', () => {
  test('password changes are throttled per user, not per address', async () => {
    await withApp({ authRateLimit: 2 }, async (t) => {
      const a = (await login(t, USER)).data.accessToken;
      const b = (await login(t, OTHER)).data.accessToken;
      const wrong = { currentPassword: 'not-the-password', newPassword: 'brand-new-password-1' };
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await t.api('POST', '/api/auth/password', wrong, { token: a, headers: SHARED_IP })).status);
      assert.deepEqual(statuses, [400, 400, 429]);
      assert.equal((await t.api('POST', '/api/auth/password', wrong, { token: b, headers: SHARED_IP })).status, 400);
    });
  });

  test('logout is not throttled per address', async () => {
    await withApp({ authRateLimit: 2 }, async (t) => {
      for (let i = 0; i < 5; i++) assert.equal((await t.api('POST', '/api/auth/logout', undefined, { headers: SHARED_IP })).status, 204);
      const cookie = refreshCookie((await login(t, USER)).headers)!;
      assert.equal((await t.api('POST', '/api/auth/logout', undefined, { cookie, headers: SHARED_IP })).status, 204);
      assert.equal((await t.api('POST', '/api/auth/refresh', undefined, { cookie, headers: SHARED_IP })).status, 401);
    });
  });
});

describe('auth audit trail', () => {
  test('failed sign-ins record the resolved account; locks and throttling are audited sparingly', async () => {
    await withApp({ loginIpFailureLimit: 8 }, async (t, adminToken) => {
      const users = (await t.api('GET', '/api/users', undefined, { token: adminToken })).data;
      const victimId = users.find((u: any) => u.email === USER.email).userId;

      for (let i = 0; i < 5; i++) await login(t, { email: USER.email, password: `guess-${i}-password` });
      for (let i = 0; i < 10; i++) assert.equal((await login(t, USER)).status, 429);
      await login(t, { email: 'nobody@example.test', password: 'junk-junk-1' });

      const failed = await auditRows(t, adminToken, 'auth.login_failed');
      const known = failed.filter((e) => e.userId === victimId);
      assert.equal(known.length, 5, 'failures against a real account carry its userId');
      assert.ok(known.every((e) => e.userEmail === USER.email && e.ip === SHARED_IP['X-Real-IP']));
      const unknown = failed.find((e) => e.userId === null);
      assert.match(unknown.details, /nobody@example\.test/);

      const locked = await auditRows(t, adminToken, 'auth.login_locked');
      assert.equal(locked.length, 1);
      assert.equal(locked[0].userId, victimId);

      // Ten throttled attempts, one audit row (the log itself can't be flooded).
      const throttled = (await auditRows(t, adminToken, 'auth.login_throttled')).filter((e) => e.userId === victimId);
      assert.equal(throttled.length, 1);
      assert.equal(throttled[0].status, 429);

      // Exhaust the per-IP failure budget (6 failures so far): throttled rows are written once per key too.
      for (let i = 0; i < 2; i++) await login(t, { email: `spray${i}@example.test`, password: 'junk-junk-1' });
      for (let i = 0; i < 5; i++) assert.equal((await login(t, { email: `spray-more${i}@example.test`, password: 'junk-junk-1' })).status, 429);
      const ipRows = (await auditRows(t, adminToken, 'auth.login_throttled')).filter((e) => /from this address/.test(e.details));
      assert.equal(ipRows.length, 1);
      // Passwords never reach the audit log.
      assert.ok(!JSON.stringify(failed).includes('guess-0-password'));
    });
  });

  test('429s from route limits are audited once per window', async () => {
    await withApp({ authRateLimit: 1 }, async (t, adminToken) => {
      for (let i = 0; i < 6; i++) await t.api('POST', '/api/auth/reset-password', { token: 'x', newPassword: 'whatever-pass-1' }, { headers: SHARED_IP });
      const rows = await auditRows(t, adminToken, 'auth.rate_limited');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].path, '/api/auth/reset-password');
      assert.equal(rows[0].ip, SHARED_IP['X-Real-IP']);
    });
  });
});

describe('limiter units', () => {
  test('LoginLockout escalates 1, 2, 4 … minutes up to the cap and resets on success', () => {
    let now = 0;
    const l = new LoginLockout({ threshold: 5, baseMs: 60_000, maxMs: 15 * 60_000, now: () => now });
    for (let i = 0; i < 4; i++) assert.equal(l.fail('a').lockMs, 0);
    const locks = [];
    for (let i = 0; i < 7; i++) {
      const { lockMs } = l.fail('a');
      locks.push(lockMs / 60_000);
      assert.equal(l.lockedFor('a'), lockMs);
      now += lockMs; // wait the lock out, then fail again
      assert.equal(l.lockedFor('a'), 0);
    }
    assert.deepEqual(locks, [1, 2, 4, 8, 15, 15, 15]);
    assert.equal(l.lockedFor('b'), 0);
    l.succeed('a');
    assert.equal(l.fail('a').lockMs, 0);
  });

  test('LoginLockout forgets old failures and stays bounded in size', () => {
    let now = 0;
    const l = new LoginLockout({ threshold: 2, baseMs: 1000, maxMs: 1000, forgetMs: 10_000, maxEntries: 50, now: () => now });
    l.fail('a');
    now += 20_000;
    assert.equal(l.fail('a').lockMs, 0, 'a stale failure is forgotten');
    l.fail('locked');
    l.fail('locked');
    for (let i = 0; i < 500; i++) l.fail(`junk${i}`);
    assert.ok(l.size <= 50);
    assert.ok(l.lockedFor('locked') > 0, 'flooding unrelated keys does not evict an active lock');
    assert.equal(new LoginLockout({ threshold: 0, baseMs: 1, maxMs: 1 }).fail('x').lockMs, 0);
  });

  test('RateLimiter check/refund count only what they should', () => {
    let now = 0;
    const r = new RateLimiter(2, 1000, () => now);
    r.check('k');
    assert.ok(r.allow('k'));
    assert.ok(r.allow('k'));
    assert.throws(() => r.check('k'), (e: any) => e.status === 429);
    r.refund('k');
    r.check('k');
    now += 1001;
    r.check('k');
    assert.ok(r.allow('k'));
  });
});
