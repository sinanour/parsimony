import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { q, type RunResult } from './shell';
import { DeployError, type Log } from './log';

/** What the commands need from a host connection — implemented by Ssh and LocalShell. */
export interface Shell {
  readonly target: string;
  exec(script: string, opts?: { input?: Readable | string; tty?: boolean }): Promise<RunResult>;
  must(script: string, what: string, opts?: { input?: Readable | string }): Promise<string>;
  interactive(script: string, tty?: boolean): Promise<number>;
  writeFile(remotePath: string, content: string, mode?: string): Promise<void>;
  check(): Promise<void>;
  close(): void;
}

const PATH_PREFIX = 'PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"; export PATH; ';

/** `--target local`: runs everything on this machine, without SSH or image transfer. */
export class LocalShell implements Shell {
  readonly target = 'local';
  constructor(private readonly log: Log) {}

  exec(script: string, opts: { input?: Readable | string } = {}): Promise<RunResult> {
    this.log.debug(`local: ${script.length > 300 ? `${script.slice(0, 300)}…` : script}`);
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', PATH_PREFIX + script], { stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (d) => (stdout += d));
      child.stderr!.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (typeof opts.input === 'string') child.stdin!.end(opts.input);
      else if (opts.input) opts.input.pipe(child.stdin!);
    });
  }

  async must(script: string, what: string, opts: { input?: Readable | string } = {}): Promise<string> {
    const r = await this.exec(script, opts);
    if (r.code !== 0) throw new DeployError(`${what} failed:\n${(r.stderr || r.stdout).trim().split('\n').slice(-20).join('\n')}`);
    return r.stdout;
  }

  interactive(script: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', PATH_PREFIX + script], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
  }

  async writeFile(path: string, content: string, mode = '0644'): Promise<void> {
    await this.must(`umask 077; cat > ${q(path)} && chmod ${mode} ${q(path)}`, `Writing ${path}`, { input: content });
  }

  async check(): Promise<void> {}
  close(): void {}
}
