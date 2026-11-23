import { run } from './shell';
import { DeployError, type Log } from './log';
import type { Shell } from './local';

export interface HostInfo {
  os: 'linux' | 'macos' | 'other';
  arch: string;
  home: string;
  docker: boolean;
  dockerAccess: 'direct' | 'sudo' | 'none';
  dockerVersion: string | null;
  compose: 'plugin' | 'standalone' | null;
  finch: boolean;
  finchVm: string | null;
  finchPublicPorts: boolean;
  hasCurl: boolean;
}

/** How to run containers on a host. */
export interface Runtime {
  name: 'docker' | 'finch';
  /** e.g. `docker`, `sudo -n docker`, `finch` */
  cli: string;
  /** e.g. `docker compose`, `sudo -n docker-compose`, `finch compose` */
  compose: string;
}

/** One SSH round trip that prints key=value facts about the host. */
export const PROBE_SCRIPT = `
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "home=$HOME"
if command -v curl >/dev/null 2>&1; then echo "curl=yes"; fi
if command -v docker >/dev/null 2>&1; then
  echo "docker=yes"
  if docker info >/dev/null 2>&1; then echo "docker_access=direct"
  elif sudo -n docker info >/dev/null 2>&1; then echo "docker_access=sudo"
  else echo "docker_access=none"; fi
  echo "docker_version=$( (docker version --format '{{.Server.Version}}' 2>/dev/null || sudo -n docker version --format '{{.Server.Version}}' 2>/dev/null) | head -1)"
  if docker compose version >/dev/null 2>&1; then echo "compose=plugin"
  elif command -v docker-compose >/dev/null 2>&1; then echo "compose=standalone"; fi
fi
if command -v finch >/dev/null 2>&1; then
  echo "finch=yes"
  echo "finch_vm=$(finch vm status 2>/dev/null | head -1)"
  if grep -q 'hostIP: *"\\{0,1\\}0\\.0\\.0\\.0' "$HOME/.finch/finch.yaml" 2>/dev/null; then echo "finch_public_ports=yes"; fi
fi
`;

export function parseProbe(out: string): HostInfo {
  const kv = new Map<string, string>();
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const uname = kv.get('os') ?? '';
  return {
    os: uname === 'Linux' ? 'linux' : uname === 'Darwin' ? 'macos' : 'other',
    arch: kv.get('arch') ?? '',
    home: kv.get('home') ?? '',
    docker: kv.get('docker') === 'yes',
    dockerAccess: (kv.get('docker_access') as HostInfo['dockerAccess']) ?? 'none',
    dockerVersion: kv.get('docker_version') || null,
    compose: (kv.get('compose') as HostInfo['compose']) ?? null,
    finch: kv.get('finch') === 'yes',
    finchVm: kv.get('finch_vm') || null,
    finchPublicPorts: kv.get('finch_public_ports') === 'yes',
    hasCurl: kv.get('curl') === 'yes',
  };
}

/** Maps `uname -m` to a container platform. */
export function platformFor(arch: string): string {
  if (['x86_64', 'amd64'].includes(arch)) return 'linux/amd64';
  if (['aarch64', 'arm64'].includes(arch)) return 'linux/arm64';
  throw new DeployError(`Unsupported CPU architecture on the target: ${arch || 'unknown'}`);
}

/** Picks Docker when it's usable, otherwise Finch. Throws with installation advice when neither is. */
export function chooseRuntime(h: HostInfo): Runtime {
  if (h.docker && h.dockerAccess !== 'none') {
    const major = Number((h.dockerVersion ?? '').split('.')[0]);
    if (h.dockerVersion && major > 0 && major < 20) {
      throw new DeployError(`Docker ${h.dockerVersion} is too old; Parsimony needs Docker 20.10 or later.`);
    }
    const sudo = h.dockerAccess === 'sudo' ? 'sudo -n ' : '';
    if (!h.compose) {
      throw new DeployError(
        'Docker is installed but Docker Compose is not. Install the compose plugin ' +
          '(e.g. `sudo apt-get install docker-compose-plugin`, or see https://docs.docker.com/compose/install/).',
      );
    }
    return { name: 'docker', cli: `${sudo}docker`, compose: h.compose === 'plugin' ? `${sudo}docker compose` : `${sudo}docker-compose` };
  }
  if (h.finch) return { name: 'finch', cli: 'finch', compose: 'finch compose' };

  if (h.docker && h.dockerAccess === 'none') {
    throw new DeployError(
      'Docker is installed, but this SSH user cannot use it. Add the user to the docker group ' +
        '(`sudo usermod -aG docker $USER`, then log in again) or allow passwordless sudo for docker.',
    );
  }
  if (h.os === 'macos') {
    throw new DeployError('No container runtime on the macOS host. Install Finch (`brew install --cask finch`, then `finch vm init`) or Docker Desktop.');
  }
  throw new DeployError(
    'Docker is not installed on the target. Install it (https://docs.docker.com/engine/install/), ' +
      'or re-run with --install-docker to use the official convenience script (needs passwordless sudo).',
  );
}

export async function probeHost(ssh: Shell): Promise<HostInfo> {
  return parseProbe(await ssh.must(PROBE_SCRIPT, 'Inspecting the host'));
}

/** Gets the host ready: optionally installs Docker on Linux, starts the Finch VM on macOS. */
export async function prepareHost(ssh: Shell, log: Log, opts: { installDocker: boolean }): Promise<{ host: HostInfo; runtime: Runtime }> {
  let host = await probeHost(ssh);
  log.info(`Host: ${host.os} ${host.arch}${host.dockerVersion ? `, Docker ${host.dockerVersion}` : ''}${host.finch ? `, Finch (VM ${host.finchVm ?? 'unknown'})` : ''}`);
  if (host.os === 'other') throw new DeployError('The target must run Linux or macOS.');

  if (!host.docker && !host.finch && host.os === 'linux' && opts.installDocker) {
    log.info('Installing Docker with the official convenience script…');
    if (!host.hasCurl) throw new DeployError('curl is needed to install Docker; install curl first.');
    await ssh.must('curl -fsSL https://get.docker.com | sudo -n sh', 'Installing Docker');
    host = await probeHost(ssh);
  }

  const runtime = chooseRuntime(host);
  if (runtime.name === 'finch' && host.finchVm !== 'Running') {
    log.info(`Starting the Finch VM (status: ${host.finchVm ?? 'unknown'})…`);
    await ssh.must(host.finchVm === 'Nonexistent' ? 'finch vm init' : 'finch vm start', 'Starting the Finch VM');
  }
  return { host, runtime };
}

/** The container CLI on this machine, for local builds. */
export async function localRuntime(log: Log): Promise<'docker' | 'finch'> {
  const docker = await run('docker', ['info'], {}).catch(() => null);
  if (docker?.code === 0) return 'docker';
  const finch = await run('finch', ['vm', 'status'], {}).catch(() => null);
  if (finch && finch.code === 0) {
    if (!finch.stdout.includes('Running')) {
      log.info('Starting the local Finch VM…');
      await run('finch', ['vm', 'start']);
    }
    return 'finch';
  }
  throw new DeployError('Local builds need Docker or Finch on this machine. Install one, or use --build-mode remote.');
}
