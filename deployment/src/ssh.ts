import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { q, type RunResult } from './shell';
import { DeployError, type Log } from './log';
import type { Shell } from './local';

export interface SshOptions {
  /** `host`, `user@host`, or an alias from ~/.ssh/config. */
  target: string;
  port?: number;
  identity?: string;
}

/** Non-interactive login shells on macOS don't include Homebrew/Finch on PATH. */
const PATH_PREFIX = 'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"; export PATH; ';

/**
 * Runs commands on the target with the system `ssh`, so keys, agents, jump hosts and ~/.ssh/config
 * all work as usual. One multiplexed connection is reused for the whole run.
 */
/**
 * Picks a short directory for the SSH ControlPath socket. macOS caps unix-socket
 * paths at 104 bytes (`sun_path`), and `os.tmpdir()` on macOS is a long
 * `/var/folders/...` path that, combined with SSH's 40-char `%C` expansion,
 * overflows that limit. `/tmp` is short on macOS and Linux both; fall back to
 * `os.tmpdir()` if it isn't writable.
 */
function makeControlDir(): string {
  const prefix = 'psm-ssh.';
  try {
    return fs.mkdtempSync(path.join('/tmp', prefix));
  } catch {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }
}

export class Ssh implements Shell {
  private readonly controlDir = makeControlDir();

  constructor(
    private readonly opts: SshOptions,
    private readonly log: Log,
  ) {}

  get target(): string {
    return this.opts.target;
  }

  private args(tty = false): string[] {
    const a = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${path.join(this.controlDir, '%C')}`,
      '-o', 'ControlPersist=120',
    ];
    if (this.opts.port) a.push('-p', String(this.opts.port));
    if (this.opts.identity) a.push('-i', this.opts.identity);
    if (tty) a.push('-t');
    return a;
  }

  /** Runs a shell script remotely and captures its output. `input` is piped to the script's stdin. */
  exec(script: string, opts: { input?: Readable | string; tty?: boolean } = {}): Promise<RunResult> {
    this.log.debug(`ssh ${this.target}: ${script.length > 300 ? `${script.slice(0, 300)}…` : script}`);
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', [...this.args(opts.tty), this.target, `sh -c ${q(PATH_PREFIX + script)}`], {
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (d) => (stdout += d));
      child.stderr!.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (typeof opts.input === 'string') child.stdin!.end(opts.input);
      else if (opts.input) {
        opts.input.on('error', (e) => {
          child.kill();
          reject(e);
        });
        opts.input.pipe(child.stdin!);
      }
    });
  }

  /** Like exec, but throws with the remote error output when the script fails. */
  async must(script: string, what: string, opts: { input?: Readable | string } = {}): Promise<string> {
    const r = await this.exec(script, opts);
    if (r.code !== 0) throw new DeployError(`${what} failed on ${this.target}:\n${(r.stderr || r.stdout).trim().split('\n').slice(-20).join('\n')}`);
    return r.stdout;
  }

  /** Runs a script with the remote output streamed to this terminal. */
  interactive(script: string, tty = false): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', [...this.args(tty), this.target, `sh -c ${q(PATH_PREFIX + script)}`], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
  }

  /** Writes a file on the remote host with the given mode. */
  async writeFile(remotePath: string, content: string, mode = '0644'): Promise<void> {
    await this.must(`umask 077; cat > ${q(remotePath)} && chmod ${mode} ${q(remotePath)}`, `Writing ${remotePath}`, { input: content });
  }

  async check(): Promise<void> {
    const r = await this.exec('echo ok');
    if (r.code !== 0 || !r.stdout.includes('ok')) {
      throw new DeployError(
        `Cannot connect to ${this.target} over SSH.\n${r.stderr.trim()}\n\n` +
          'Check that `ssh ' + this.target + '` works without a password prompt (key-based login), ' +
          'or pass --identity and --port.',
      );
    }
  }

  close(): void {
    spawn('ssh', [...this.args(), '-O', 'exit', this.target], { stdio: 'ignore' }).on('close', () =>
      fs.rmSync(this.controlDir, { recursive: true, force: true }),
    );
  }
}
