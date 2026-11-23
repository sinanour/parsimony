import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { localRuntime, platformFor, prepareHost, type HostInfo, type Runtime } from './host';
import { DeployError, type Log } from './log';
import {
  checkCertificates,
  emptyState,
  parseEnv,
  parseState,
  previousRelease,
  recordDeploy,
  recordFailure,
  recordRollback,
  renderEnv,
  stripBuildSections,
  validateConfig,
  versionTag,
  type ReleaseState,
} from './release';
import { q, run, runVisible } from './shell';
import { Ssh } from './ssh';
import { LocalShell, type Shell } from './local';

const here = path.dirname(fileURLToPath(import.meta.url));
export const deploymentRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(deploymentRoot, '..');

const PROJECT = 'parsimony';
const IMAGES = ['parsimony-backend', 'parsimony-frontend'] as const;
const KEEP_RELEASES = 5;

export interface CommonOptions {
  target: string;
  port?: number;
  identity?: string;
  /** Directory on the host; relative paths are under the SSH user's home. */
  dir: string;
  verbose: boolean;
}

export interface DeployOptions extends CommonOptions {
  envFile: string;
  certsDir: string;
  buildMode: 'local' | 'remote';
  installDocker: boolean;
  healthTimeout: number;
}

interface Session {
  shell: Shell;
  host: HostInfo;
  rt: Runtime;
  dir: string;
}

function connect(opts: CommonOptions, log: Log): Shell {
  return opts.target === 'local' ? new LocalShell(log) : new Ssh({ target: opts.target, port: opts.port, identity: opts.identity }, log);
}

async function open(opts: CommonOptions, log: Log, installDocker = false): Promise<Session> {
  const shell = connect(opts, log);
  await shell.check();
  log.ok(`Connected to ${opts.target}`);
  const { host, runtime } = await prepareHost(shell, log, { installDocker });
  log.ok(`Using ${runtime.compose}`);
  const dir = opts.dir.startsWith('/') ? opts.dir : `${host.home}/${opts.dir}`;
  return { shell, host, rt: runtime, dir };
}

const releaseDir = (s: Session, v: string) => `${s.dir}/releases/${v}`;

async function readState(s: Session): Promise<ReleaseState> {
  const r = await s.shell.exec(`cat ${q(`${s.dir}/state.json`)} 2>/dev/null`);
  return r.code === 0 && r.stdout.trim() ? parseState(r.stdout) : emptyState();
}

async function writeState(s: Session, state: ReleaseState): Promise<void> {
  await s.shell.writeFile(`${s.dir}/state.json`, JSON.stringify(state, null, 2) + '\n', '0644');
}

const compose = (s: Session, version: string, args: string) => `cd ${q(releaseDir(s, version))} && ${s.rt.compose} -p ${PROJECT} ${args}`;

/** Polls both containers until nginx serves /health and can reach the API, or the timeout passes. */
async function waitHealthy(s: Session, log: Log, timeoutSec: number): Promise<{ ok: boolean; reason: string }> {
  const deadline = Date.now() + timeoutSec * 1000;
  let reason = 'not started';
  while (Date.now() < deadline) {
    const status = await s.shell.exec(`${s.rt.cli} inspect -f '{{.State.Status}}' parsimony-backend parsimony-frontend 2>/dev/null`);
    const states = status.stdout.trim().split('\n');
    if (states.some((st) => st === 'exited' || st === 'dead')) return { ok: false, reason: `a container stopped (${states.join(', ')})` };
    const probe = await s.shell.exec(
      `${s.rt.cli} exec parsimony-frontend wget -q -O - http://127.0.0.1/health && ` +
        `${s.rt.cli} exec parsimony-frontend wget -q -O - http://backend:3001/api/health`,
    );
    if (probe.code === 0 && probe.stdout.includes('"status":"ok"')) return { ok: true, reason: '' };
    reason = (probe.stderr || probe.stdout).trim().split('\n').pop() || 'health check failed';
    log.debug(`waiting for health: ${reason}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, reason: `timed out after ${timeoutSec}s (${reason})` };
}

async function showContainerLogs(s: Session, version: string, log: Log): Promise<void> {
  const r = await s.shell.exec(`${compose(s, version, 'logs --tail 60')} 2>&1`);
  log.info('Container logs:');
  for (const line of r.stdout.trim().split('\n')) log.info(`  ${line}`);
}

async function gitSha(): Promise<string | null> {
  const r = await run('git', ['-C', repoRoot, 'rev-parse', 'HEAD']).catch(() => null);
  return r?.code === 0 ? r.stdout.trim() : null;
}

/** Streams a local command's stdout, gzipped, into a remote script's stdin. */
async function pipeToRemote(s: Session, log: Log, cmd: string, args: string[], remoteScript: string, what: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: repoRoot, env: env ?? process.env });
  let localErr = '';
  child.stderr.on('data', (d) => (localErr += d));
  let bytes = 0;
  let lastReport = 0;
  const gzip = createGzip({ level: 6 });
  gzip.on('data', (d: Buffer) => {
    bytes += d.length;
    if (process.stdout.isTTY && bytes - lastReport > 5_000_000) {
      lastReport = bytes;
      process.stdout.write(`\r  … ${(bytes / 1_000_000).toFixed(0)} MB sent`);
    }
  });
  const localDone = new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  const remote = s.shell.exec(remoteScript, { input: child.stdout.pipe(gzip) });
  const [code, r] = await Promise.all([localDone, remote]);
  if (process.stdout.isTTY && lastReport) process.stdout.write('\n');
  if (code !== 0) throw new DeployError(`${what}: \`${cmd} ${args.join(' ')}\` failed:\n${localErr.trim().split('\n').slice(-15).join('\n')}`);
  if (r.code !== 0) throw new DeployError(`${what} failed on the host:\n${(r.stderr || r.stdout).trim().split('\n').slice(-15).join('\n')}`);
  log.ok(`${what} (${(bytes / 1_000_000).toFixed(1)} MB compressed)`);
}

async function buildImages(s: Session, log: Log, opts: DeployOptions, version: string): Promise<void> {
  const platform = platformFor(s.host.arch);
  const local = opts.target === 'local';
  if (opts.buildMode === 'local' || local) {
    const cli = local ? s.rt.cli.replace(/^sudo -n /, '') : await localRuntime(log);
    for (const image of IMAGES) {
      const dockerfile = `deployment/dockerfiles/Dockerfile.${image.replace('parsimony-', '')}`;
      log.info(`Building ${image}:${version} for ${platform} with ${cli}…`);
      const args = ['build', '--platform', platform, '-f', dockerfile, '-t', `${image}:${version}`, '.'];
      const code = opts.verbose ? await runVisible(cli, args, { cwd: repoRoot }) : (await run(cli, args, { cwd: repoRoot })).code;
      if (code !== 0) {
        throw new DeployError(`Building ${image} failed. Re-run with --verbose to see the build output.`);
      }
    }
    log.ok('Images built');
    if (!local) {
      log.info('Copying images to the host…');
      await pipeToRemote(s, log, cli, ['save', ...IMAGES.map((i) => `${i}:${version}`)], `gunzip | ${s.rt.cli} load`, 'Images transferred');
    }
    return;
  }

  // Remote build: upload the source (minus secrets and build output) and build on the host.
  const src = `${s.dir}/build`;
  log.info('Uploading the source to build on the host…');
  const excludes = ['node_modules', 'dist', '.git', 'data', 'backups', '*.sqlite*', '.env', '.env.*', 'deployment/config', '__pycache__', '.DS_Store'];
  await pipeToRemote(
    s,
    log,
    'tar',
    ['-cf', '-', ...excludes.flatMap((e) => ['--exclude', e]), '.'],
    `rm -rf ${q(src)} && mkdir -p ${q(src)} && gunzip | tar -xf - -C ${q(src)}`,
    'Source uploaded',
    { ...process.env, COPYFILE_DISABLE: '1' },
  );
  for (const image of IMAGES) {
    log.info(`Building ${image}:${version} on the host…`);
    const dockerfile = `deployment/dockerfiles/Dockerfile.${image.replace('parsimony-', '')}`;
    await s.shell.must(`cd ${q(src)} && ${s.rt.cli} build -f ${dockerfile} -t ${image}:${version} .`, `Building ${image}`);
  }
  log.ok('Images built on the host');
}

async function uploadCerts(s: Session, log: Log, certsDir: string, targetDir: string): Promise<void> {
  await s.shell.must(`rm -rf ${q(targetDir)} && mkdir -p ${q(targetDir)} && chmod 0700 ${q(targetDir)}`, 'Preparing the certificate directory');
  const files = fs.existsSync(certsDir) ? fs.readdirSync(certsDir).filter((f) => f !== '.gitkeep') : [];
  if (files.length === 0) return;
  await pipeToRemote(s, log, 'tar', ['-cf', '-', '-C', certsDir, ...files], `gunzip | tar -xf - -C ${q(targetDir)}`, 'Certificates uploaded', {
    ...process.env,
    COPYFILE_DISABLE: '1',
  });
}

function loadConfig(opts: DeployOptions, log: Log) {
  if (!fs.existsSync(opts.envFile)) {
    throw new DeployError(`No configuration at ${opts.envFile}. Copy deployment/config/.env.example to deployment/config/.env and edit it.`);
  }
  const cfg = validateConfig(parseEnv(fs.readFileSync(opts.envFile, 'utf8')));
  for (const w of cfg.warnings) log.warn(w);
  if (cfg.errors.length) throw new DeployError(`Fix ${opts.envFile}:\n  - ${cfg.errors.join('\n  - ')}`);
  if (cfg.httpsEnabled) {
    try {
      const c = checkCertificates(opts.certsDir);
      log.ok(`Certificate ${path.relative(opts.certsDir, c.certificate)} for ${c.subject}, valid until ${c.validTo.toISOString().slice(0, 10)}`);
      if (c.daysLeft < 14) log.warn(`The certificate expires in ${c.daysLeft} day(s). Renew it and run update-certs.`);
    } catch (e) {
      throw new DeployError(`ENABLE_HTTPS=true, but the certificate check failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  log.ok('Configuration is valid');
  return cfg;
}

const who = () => `${os.userInfo().username}@${os.hostname()}`;

// ---------- commands ----------

export async function deploy(opts: DeployOptions, log: Log): Promise<void> {
  log.step('Checking configuration');
  const cfg = loadConfig(opts, log);

  log.step(`Preparing ${opts.target}`);
  const s = await open(opts, log, opts.installDocker);
  try {
    await s.shell.must(`mkdir -p ${q(`${s.dir}/releases`)} ${q(`${s.dir}/logs`)}`, 'Creating directories');
    const state = await readState(s);
    const version = versionTag(new Date(), await gitSha());
    log.info(`Release ${version}${state.current ? ` (currently running ${state.current})` : ' (first deployment)'}`);

    log.step('Building images');
    await buildImages(s, log, opts, version);

    log.step('Uploading the release');
    const rel = releaseDir(s, version);
    await s.shell.must(`mkdir -p ${q(rel)}`, 'Creating the release directory');
    await s.shell.writeFile(`${rel}/docker-compose.yml`, stripBuildSections(fs.readFileSync(path.join(deploymentRoot, 'config', 'docker-compose.yml'), 'utf8')));
    await s.shell.writeFile(`${rel}/.env`, renderEnv(cfg.env, version), '0600');
    await uploadCerts(s, log, opts.certsDir, `${rel}/certs`);
    log.ok(`Release files in ${rel}`);

    log.step('Starting containers');
    const up = await s.shell.exec(`${compose(s, version, 'up -d --remove-orphans')} 2>&1`);
    log.debug(up.stdout);
    const health = up.code === 0 ? await waitHealthy(s, log, opts.healthTimeout) : { ok: false, reason: up.stdout.trim().split('\n').slice(-5).join('\n') };

    if (!health.ok) {
      log.error(`Release ${version} is not healthy: ${health.reason}`);
      await showContainerLogs(s, version, log);
      await writeState(s, recordFailure(state, version, who()));
      if (state.current) {
        log.step(`Rolling back to ${state.current}`);
        await s.shell.exec(`${compose(s, state.current, 'up -d --remove-orphans')} 2>&1`);
        const back = await waitHealthy(s, log, opts.healthTimeout);
        if (back.ok) log.ok(`${state.current} is running again`);
        else log.error(`The previous release is not healthy either: ${back.reason}`);
      } else {
        await s.shell.exec(`${compose(s, version, 'down')} 2>&1`);
      }
      throw new DeployError(`Deployment of ${version} failed.`);
    }
    log.ok('Both containers are healthy');

    const { state: next, pruned } = recordDeploy(state, version, KEEP_RELEASES, who());
    await writeState(s, next);
    if (pruned.length) {
      const images = pruned.flatMap((v) => IMAGES.map((i) => `${i}:${v}`)).join(' ');
      await s.shell.exec(`rm -rf ${pruned.map((v) => q(releaseDir(s, v))).join(' ')}; ${s.rt.cli} image rm ${images} >/dev/null 2>&1 || true`);
      log.info(`Removed old releases: ${pruned.join(', ')}`);
    }
    await s.shell.exec(`rm -rf ${q(`${s.dir}/build`)}`);

    log.step('Done');
    const scheme = cfg.httpsEnabled ? 'https' : 'http';
    const port = cfg.httpsEnabled ? cfg.httpsPort : cfg.httpPort;
    const host = opts.target === 'local' ? 'localhost' : opts.target.replace(/^.*@/, '');
    log.ok(`Parsimony ${version} is running: ${scheme}://${host}${port === (cfg.httpsEnabled ? 443 : 80) ? '' : `:${port}`}/`);
    const setup = await s.shell.exec(`${s.rt.cli} logs parsimony-backend 2>&1 | grep -E '^ +[A-Z0-9]{5}-[A-Z0-9]{5}$' | tail -1`);
    if (setup.stdout.trim()) log.info(`No users yet. Create the first administrator in the browser with setup code ${setup.stdout.trim()}`);
    if (s.host.os === 'macos' && s.rt.name === 'finch' && !s.host.finchPublicPorts && opts.target !== 'local') {
      log.warn('Finch on macOS forwards ports to localhost only. Run deployment/scripts/configure-finch-ports.sh on the host to allow access from other machines.');
    }
  } finally {
    await s.shell.exec(`cat >> ${q(`${s.dir}/logs/deploy.log`)}`, { input: log.lines.join('\n') + '\n' }).catch(() => undefined);
    s.shell.close();
  }
}

export async function rollback(opts: CommonOptions & { healthTimeout: number }, log: Log): Promise<void> {
  const s = await open(opts, log);
  try {
    const state = await readState(s);
    const prev = previousRelease(state);
    if (!state.current || !prev) throw new DeployError('There is no earlier release to roll back to.');
    log.step(`Rolling back from ${state.current} to ${prev}`);
    await s.shell.must(compose(s, prev, 'up -d --remove-orphans'), 'Starting the previous release');
    const health = await waitHealthy(s, log, opts.healthTimeout);
    if (!health.ok) {
      await showContainerLogs(s, prev, log);
      throw new DeployError(`${prev} is not healthy: ${health.reason}`);
    }
    await writeState(s, recordRollback(state, prev, who()));
    log.ok(`${prev} is running`);
  } finally {
    s.shell.close();
  }
}

export async function status(opts: CommonOptions, log: Log): Promise<void> {
  const s = await open(opts, log);
  try {
    const state = await readState(s);
    if (!state.current) {
      log.info('Parsimony has not been deployed to this host yet.');
      return;
    }
    log.step('Releases (newest first)');
    for (const r of state.releases) log.info(`${r === state.current ? '● ' : '  '}${r}${r === state.current ? '  (running)' : ''}`);
    log.step('Containers');
    const ps = await s.shell.exec(`${compose(s, state.current, 'ps')} 2>&1`);
    for (const line of ps.stdout.trim().split('\n')) log.info(line);
    const health = await waitHealthy(s, log, 5);
    if (health.ok) log.ok('Healthy');
    else log.warn(`Not healthy: ${health.reason}`);
    log.step('Recent events');
    for (const h of state.history.slice(-5)) log.info(`${h.at}  ${h.event.padEnd(8)} ${h.version}${h.by ? `  by ${h.by}` : ''}`);
  } finally {
    s.shell.close();
  }
}

export async function logs(opts: CommonOptions & { service?: string; follow: boolean; tail: number }, log: Log): Promise<void> {
  const s = await open(opts, log);
  try {
    const state = await readState(s);
    if (!state.current) throw new DeployError('Parsimony has not been deployed to this host yet.');
    const service = opts.service ? ` ${q(opts.service)}` : '';
    await s.shell.interactive(`${compose(s, state.current, `logs --tail ${opts.tail}${opts.follow ? ' -f' : ''}${service}`)}`);
  } finally {
    s.shell.close();
  }
}

export async function updateCerts(opts: CommonOptions & { envFile: string; certsDir: string; healthTimeout: number }, log: Log): Promise<void> {
  const c = checkCertificates(opts.certsDir);
  log.ok(`Certificate for ${c.subject}, valid until ${c.validTo.toISOString().slice(0, 10)}`);
  const s = await open(opts, log);
  try {
    const state = await readState(s);
    if (!state.current) throw new DeployError('Deploy Parsimony before updating its certificates.');
    await uploadCerts(s, log, opts.certsDir, `${releaseDir(s, state.current)}/certs`);
    await s.shell.must(`${s.rt.cli} restart parsimony-frontend`, 'Restarting nginx');
    const health = await waitHealthy(s, log, opts.healthTimeout);
    if (!health.ok) throw new DeployError(`nginx is not healthy after the certificate update: ${health.reason}`);
    log.ok('nginx restarted with the new certificate');
  } finally {
    s.shell.close();
  }
}

/** Runs the backend's user CLI inside the container, e.g. to reset a forgotten administrator password. */
export async function users(opts: CommonOptions & { args: string[] }, log: Log): Promise<number> {
  const s = await open(opts, log);
  try {
    const args = opts.args.map(q).join(' ');
    return await s.shell.interactive(`${s.rt.cli} exec -it -u parsimony parsimony-backend npm run --silent users -- ${args}`, true);
  } finally {
    s.shell.close();
  }
}
