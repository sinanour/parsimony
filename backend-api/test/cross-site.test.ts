import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN, refreshCookie, startApp, type TestApp } from './helpers';

// Finding 4: an off-site page must not be able to sign a victim into another account (login CSRF), or
// make any other state-changing API call, and a JSON route must never parse an HTML form's body.

interface Raw {
  status: number;
  data: any;
  setCookie: string[];
}

/** A request with full control over headers (fetch won't let us set Host or omit its own). */
function raw(base: string, method: string, path: string, headers: Record<string, string>, body?: string | Buffer): Promise<Raw> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, method, path, headers: { ...headers, ...(body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: any = text;
          try {
            data = text ? JSON.parse(text) : undefined;
          } catch {
            /* not JSON */
          }
          const sc = res.headers['set-cookie'] ?? [];
          resolve({ status: res.statusCode ?? 0, data, setCookie: sc });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const loginJson = JSON.stringify(ADMIN);
/** What an auto-submitting `<form enctype="text/plain">` produces: name + '=' + value. */
const formShaped = `{"email":"${ADMIN.email}","password":"${ADMIN.password}","x":"=}"}`;
const setsSession = (r: Raw) => r.setCookie.some((c) => c.startsWith('parsimony_refresh=') && !c.startsWith('parsimony_refresh=;'));

let t: TestApp;
before(async () => {
  t = await startApp();
});
after(() => t.close());

describe('JSON routes require a JSON content type', () => {
  test('a text/plain sign-in (cross-site form shape) is refused with 415 and sets no cookie', async () => {
    const r = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': 'text/plain;charset=UTF-8' }, formShaped);
    assert.equal(r.status, 415);
    assert.equal(r.data.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(setsSession(r), false);
    // Even a perfectly valid JSON document is refused when labelled text/plain.
    assert.equal((await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': 'text/plain' }, loginJson)).status, 415);
  });
  test('form-urlencoded, multipart and unlabelled bodies are refused', async () => {
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/octet-stream']) {
      const r = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': type }, loginJson);
      assert.equal(r.status, 415, type);
    }
    const none = await raw(t.base, 'POST', '/api/auth/login', {}, loginJson);
    assert.equal(none.status, 415);
  });
  test('application/json with parameters and +json types are accepted', async () => {
    for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/merge-patch+json']) {
      const r = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': type }, loginJson);
      assert.equal(r.status, 200, type);
    }
  });
  test('authenticated JSON routes are covered too', async () => {
    const { token } = await t.login(ADMIN.email, ADMIN.password);
    const r = await raw(t.base, 'PATCH', '/api/auth/me', { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, '{"displayName":"x"}');
    assert.equal(r.status, 415);
  });
  test('bodyless POSTs need no content type', async () => {
    const { cookie } = await t.login(ADMIN.email, ADMIN.password);
    const r = await raw(t.base, 'POST', '/api/auth/refresh', { Cookie: cookie });
    assert.equal(r.status, 200);
    // A content type on an empty body is harmless.
    assert.equal((await raw(t.base, 'POST', '/api/auth/logout', { Cookie: cookie, 'Content-Type': 'text/plain' }, '')).status, 204);
  });
});

describe('cross-site state-changing requests are refused', () => {
  test('a foreign Origin is refused before sign-in, with no cookie set', async () => {
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:1', 'not a url']) {
      const r = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', Origin: origin }, loginJson);
      assert.equal(r.status, 403, origin);
      assert.equal(r.data.code, 'CROSS_SITE_REQUEST');
      assert.equal(setsSession(r), false);
    }
    // The pentest repro: text/plain from a foreign origin.
    const repro = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://evil.example' }, formShaped);
    assert.equal(repro.status, 403);
    assert.equal(setsSession(repro), false);
  });
  test('Sec-Fetch-Site other than same-origin/none is refused', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const r = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', 'Sec-Fetch-Site': site }, loginJson);
      assert.equal(r.status, 403, site);
      assert.equal(r.data.code, 'CROSS_SITE_REQUEST');
    }
    const same = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: t.base }, loginJson);
    assert.equal(same.status, 200);
    // `none` (user-initiated) still has to pass the Origin check.
    const none = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'none', Origin: 'https://evil.example' }, loginJson);
    assert.equal(none.status, 403);
  });
  test('bodyless auth POSTs are covered (refresh, logout)', async () => {
    const { cookie } = await t.login(ADMIN.email, ADMIN.password);
    const refresh = await raw(t.base, 'POST', '/api/auth/refresh', { Cookie: cookie, Origin: 'https://evil.example' });
    assert.equal(refresh.status, 403);
    const logout = await raw(t.base, 'POST', '/api/auth/logout', { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(logout.status, 403);
    // Neither touched the session.
    assert.equal((await raw(t.base, 'POST', '/api/auth/refresh', { Cookie: cookie })).status, 200);
  });
  test('the raw statement upload route is covered', async () => {
    const { token } = await t.login(ADMIN.email, ADMIN.password);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.csv' };
    const cross = await raw(t.base, 'POST', '/api/import/parse', { ...headers, Origin: 'https://evil.example' }, Buffer.from('a,b'));
    assert.equal(cross.status, 403);
    assert.equal(cross.data.code, 'CROSS_SITE_REQUEST');
    assert.equal((await raw(t.base, 'POST', '/api/import/parse', { ...headers, 'Sec-Fetch-Site': 'cross-site' }, Buffer.from('a,b'))).status, 403);
    // Same-origin uploads keep their own content type and handling.
    const ok = await raw(t.base, 'POST', '/api/import/parse', { ...headers, Origin: t.base, 'Sec-Fetch-Site': 'same-origin' }, Buffer.from('a,b'));
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
  });
  test('reads are unaffected', async () => {
    const r = await raw(t.base, 'GET', '/api/config', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(r.status, 200);
  });
});

describe('same-origin and non-browser requests still work', () => {
  test('no Origin and no Sec-Fetch-Site (curl, scripts) is allowed', async () => {
    const r = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': 'application/json' }, loginJson);
    assert.equal(r.status, 200);
    assert.ok(refreshCookie(new Headers(r.setCookie.map((c) => ['set-cookie', c]))));
  });
  test('Origin matching the Host the browser used, or PUBLIC_URL, is allowed', async () => {
    const own = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', Origin: t.base }, loginJson);
    assert.equal(own.status, 200);
    const pub = await raw(t.base, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', Origin: 'https://parsimony.example.test' }, loginJson);
    assert.equal(pub.status, 200);
  });
  test('without a trusted proxy, forwarded headers are ignored', async () => {
    const r = await raw(
      t.base,
      'POST',
      '/api/auth/login',
      { 'Content-Type': 'application/json', Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' },
      loginJson,
    );
    assert.equal(r.status, 403);
  });

  test('behind nginx on a non-default port', async () => {
    const p = await startApp({ overrides: { trustProxy: true, publicUrl: '' } });
    try {
      const login = (headers: Record<string, string>) =>
        raw(p.base, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', ...headers }, loginJson);
      const origin = 'https://parsimony.lan:19100';
      // nginx: Host $host (port stripped), X-Forwarded-Host $http_host (port kept).
      assert.equal((await login({ Host: 'parsimony.lan', 'X-Forwarded-Host': 'parsimony.lan:19100', Origin: origin })).status, 200);
      // An older nginx config without X-Forwarded-Host: the host name alone has to match.
      assert.equal((await login({ Host: 'parsimony.lan', Origin: origin })).status, 200);
      // A further TLS-terminating hop: nginx itself saw plain HTTP.
      assert.equal((await login({ Host: 'parsimony.lan', 'X-Forwarded-Host': 'parsimony.lan:19100', 'X-Forwarded-Proto': 'http', Origin: origin })).status, 200);
      // Default port.
      assert.equal((await login({ Host: 'parsimony.lan', 'X-Forwarded-Host': 'parsimony.lan', Origin: 'https://parsimony.lan' })).status, 200);

      assert.equal((await login({ Host: 'parsimony.lan', 'X-Forwarded-Host': 'parsimony.lan:19100', Origin: 'https://evil.example' })).status, 403);
      assert.equal((await login({ Host: 'parsimony.lan', 'X-Forwarded-Host': 'parsimony.lan:19100', Origin: 'https://parsimony.lan:19101' })).status, 403);
      assert.equal((await login({ Host: 'parsimony.lan', Origin: 'https://parsimony.lan.evil.example' })).status, 403);
      assert.equal((await login({ Host: 'parsimony.lan', 'X-Forwarded-Host': 'parsimony.lan:19100', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    } finally {
      await p.close();
    }
  });
  test('PUBLIC_URL is accepted even when the proxy forwards a different host', async () => {
    const p = await startApp({ overrides: { trustProxy: true, publicUrl: 'https://books.example.test:19100' } });
    try {
      const r = await raw(
        p.base,
        'POST',
        '/api/auth/login',
        { 'Content-Type': 'application/json', Host: 'backend:3001', Origin: 'https://books.example.test:19100' },
        loginJson,
      );
      assert.equal(r.status, 200);
    } finally {
      await p.close();
    }
  });
});
