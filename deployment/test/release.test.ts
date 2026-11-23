import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkCertificates,
  parseEnv,
  parseState,
  previousRelease,
  recordDeploy,
  recordRollback,
  renderEnv,
  stripBuildSections,
  validateConfig,
  versionTag,
  emptyState,
} from '../src/release';
import { chooseRuntime, parseProbe, platformFor } from '../src/host';
import { q } from '../src/shell';

describe('.env', () => {
  test('parses values, quotes, comments and export', () => {
    const env = parseEnv('# c\nA=1\nexport B="two words"\nC=\'x\'\n\nBAD LINE\nD=\n');
    assert.deepEqual([...env], [['A', '1'], ['B', 'two words'], ['C', 'x'], ['D', '']]);
  });
  test('validation catches mistakes before anything is uploaded', () => {
    const v = validateConfig(parseEnv('HTTP_PORT=80\nHTTPS_PORT=80\nENABLE_HTTPS=yes\nDATA_VOLUME_PATH=data\nJWT_SECRET=short\nADMIN_EMAIL=a@b.c\nPUBLIC_URL=example.com'));
    assert.equal(v.errors.length, 6, v.errors.join('\n'));
    const ok = validateConfig(parseEnv('HTTP_PORT=8080\nHTTPS_PORT=8443\nENABLE_HTTPS=true\nADMIN_EMAIL=a@b.c\nADMIN_PASSWORD=long-enough-password'));
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.httpsEnabled, true);
    assert.equal(ok.httpsPort, 8443);
  });
  test('rejects the placeholder admin password and warns about plain HTTP', () => {
    const v = validateConfig(parseEnv('ADMIN_EMAIL=a@b.c\nADMIN_PASSWORD=change-me-to-something-long'));
    assert.ok(v.errors.some((e) => e.includes('placeholder')));
    assert.ok(v.warnings.some((w) => w.includes('unencrypted')));
  });
  test('rendered env pins the image tag and project name', () => {
    const out = renderEnv(parseEnv('IMAGE_TAG=old\nCURRENCY=EUR'), 'v2');
    assert.match(out, /^IMAGE_TAG=v2$/m);
    assert.match(out, /^COMPOSE_PROJECT_NAME=parsimony$/m);
    assert.match(out, /^CURRENCY=EUR$/m);
    assert.doesNotMatch(out, /IMAGE_TAG=old/);
  });
});

describe('compose', () => {
  test('build sections are removed and everything else kept', () => {
    const src = fs.readFileSync(new URL('../config/docker-compose.yml', import.meta.url), 'utf8');
    const out = stripBuildSections(src);
    assert.doesNotMatch(out, /^\s*build:/m);
    assert.doesNotMatch(out, /dockerfile:/);
    assert.match(out, /image: parsimony-backend:\$\{IMAGE_TAG:-latest\}/);
    assert.match(out, /container_name: parsimony-backend/);
    assert.match(out, /container_name: parsimony-frontend/);
    assert.equal((out.match(/healthcheck:/g) ?? []).length, 2);
  });
});

describe('release history', () => {
  test('deploys keep the newest releases and report the pruned ones', () => {
    let s = emptyState();
    const pruned: string[] = [];
    for (const v of ['r1', 'r2', 'r3', 'r4']) {
      const r = recordDeploy(s, v, 3);
      s = r.state;
      pruned.push(...r.pruned);
    }
    assert.equal(s.current, 'r4');
    assert.deepEqual(s.releases, ['r4', 'r3', 'r2']);
    assert.deepEqual(pruned, ['r1']);
    assert.equal(previousRelease(s), 'r3');
  });
  test('rollback moves back one release at a time', () => {
    let s = recordDeploy(recordDeploy(recordDeploy(emptyState(), 'a', 5).state, 'b', 5).state, 'c', 5).state;
    s = recordRollback(s, previousRelease(s)!);
    assert.equal(s.current, 'b');
    assert.equal(previousRelease(s), 'a');
    s = recordRollback(s, previousRelease(s)!);
    assert.equal(s.current, 'a');
    assert.equal(previousRelease(s), null);
  });
  test('corrupt state files are treated as empty', () => {
    assert.deepEqual(parseState('{not json'), emptyState());
  });
  test('version tags sort chronologically', () => {
    const a = versionTag(new Date('2026-01-02T03:04:05Z'), 'abcdef1234');
    assert.equal(a, '20260102-030405-abcdef1');
    assert.ok(versionTag(new Date('2026-01-02T03:04:06Z')) > a.slice(0, 15));
  });
});

describe('certificates', () => {
  const hasOpenssl = (() => {
    try {
      execFileSync('openssl', ['version']);
      return true;
    } catch {
      return false;
    }
  })();
  test('finds and validates a matching pair', { skip: !hasOpenssl && 'openssl not installed' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsimony-certs-'));
    try {
      fs.mkdirSync(path.join(dir, 'example.com'));
      const gen = (cn: string, out: string) =>
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', `/CN=${cn}`, '-keyout', `${out}.key`, '-out', `${out}.crt`], { stdio: 'ignore' });
      gen('example.com', path.join(dir, 'a'));
      gen('other.com', path.join(dir, 'b'));
      fs.renameSync(path.join(dir, 'a.crt'), path.join(dir, 'example.com', 'fullchain.pem'));
      fs.renameSync(path.join(dir, 'a.key'), path.join(dir, 'example.com', 'privkey.pem'));
      const c = checkCertificates(dir);
      assert.match(c.subject, /example\.com/);
      assert.ok(c.daysLeft >= 29);
      // A key from another certificate is rejected.
      fs.copyFileSync(path.join(dir, 'b.key'), path.join(dir, 'example.com', 'privkey.pem'));
      assert.throws(() => checkCertificates(dir), /does not belong/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test('reports a missing pair', () => {
    assert.throws(() => checkCertificates(path.join(os.tmpdir(), 'does-not-exist-parsimony')), /No certificate\/key pair/);
  });
});

describe('host detection', () => {
  const probe = (s: string) => parseProbe(s);
  test('Linux with docker via sudo and the compose plugin', () => {
    const h = probe('os=Linux\narch=x86_64\nhome=/home/deploy\ndocker=yes\ndocker_access=sudo\ndocker_version=27.3.1\ncompose=plugin\n');
    assert.deepEqual(chooseRuntime(h), { name: 'docker', cli: 'sudo -n docker', compose: 'sudo -n docker compose' });
    assert.equal(platformFor(h.arch), 'linux/amd64');
  });
  test('macOS with Finch', () => {
    const h = probe('os=Darwin\narch=arm64\nhome=/Users/x\nfinch=yes\nfinch_vm=Stopped\n');
    assert.equal(chooseRuntime(h).compose, 'finch compose');
    assert.equal(platformFor(h.arch), 'linux/arm64');
    assert.equal(h.finchPublicPorts, false);
  });
  test('helpful errors when nothing usable is installed', () => {
    assert.throws(() => chooseRuntime(probe('os=Linux\narch=x86_64')), /--install-docker/);
    assert.throws(() => chooseRuntime(probe('os=Darwin\narch=arm64')), /Finch/);
    assert.throws(() => chooseRuntime(probe('os=Linux\ndocker=yes\ndocker_access=none\ncompose=plugin')), /docker group/);
    assert.throws(() => chooseRuntime(probe('os=Linux\ndocker=yes\ndocker_access=direct\ndocker_version=19.03.1\ncompose=plugin')), /too old/);
    assert.throws(() => chooseRuntime(probe('os=Linux\ndocker=yes\ndocker_access=direct\ndocker_version=27.0.0')), /Compose/);
    assert.throws(() => platformFor('mips'), /Unsupported/);
  });
});

describe('shell quoting', () => {
  test('survives quotes and metacharacters', () => {
    const nasty = `it's $HOME; rm -rf / "x" \`y\``;
    assert.equal(execFileSync('sh', ['-c', `printf %s ${q(nasty)}`]).toString(), nasty);
  });
});
