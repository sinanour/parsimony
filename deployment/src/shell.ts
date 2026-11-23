import { spawn, type SpawnOptions } from 'node:child_process';

/** Quotes a string for POSIX sh. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a local command and captures its output. */
export function run(cmd: string, args: string[], opts: SpawnOptions & { input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => (stdout += d));
    child.stderr!.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

/** Runs a local command with its output shown to the user. Resolves with the exit code. */
export function runVisible(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
