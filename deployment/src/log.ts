/** Timestamped console logging that also keeps a transcript for the host-side deploy log. */
export class Log {
  readonly lines: string[] = [];
  constructor(public verbose = false) {}

  private write(level: string, msg: string, stream: NodeJS.WriteStream = process.stdout) {
    const line = `${new Date().toISOString()} ${level} ${msg}`;
    this.lines.push(line);
    stream.write(`${level === 'INFO' ? '' : `${level} `}${msg}\n`);
  }
  step(msg: string) {
    this.write('INFO', `\n▸ ${msg}`);
  }
  info(msg: string) {
    this.write('INFO', `  ${msg}`);
  }
  ok(msg: string) {
    this.write('INFO', `  ✓ ${msg}`);
  }
  warn(msg: string) {
    this.write('WARN', msg, process.stderr);
  }
  error(msg: string) {
    this.write('ERROR', msg, process.stderr);
  }
  debug(msg: string) {
    this.lines.push(`${new Date().toISOString()} DEBUG ${msg}`);
    if (this.verbose) process.stderr.write(`  · ${msg}\n`);
  }
}

export class DeployError extends Error {}
