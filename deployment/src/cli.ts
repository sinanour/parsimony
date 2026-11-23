import path from 'node:path';
import { parseArgs } from 'node:util';
import { deploy, deploymentRoot, logs, rollback, status, updateCerts, users } from './commands';
import { DeployError, Log } from './log';

const HELP = `Parsimony deployment

Usage: npm run <command> -- --target [user@]host [options]
       (or: npm run cli -- <command> --target … from deployment/)

Commands
  deploy         Build, upload and start a new release; rolls back automatically if it isn't healthy
  rollback       Go back to the previous release
  status         Show releases and container health
  logs           Show container logs (the first-run setup code appears here)
  update-certs   Upload renewed TLS certificates and restart nginx
  users          Run the user CLI in the container, e.g. -- users --target h -- reset-password --email you@example.com

Options
  -t, --target <host>    SSH target: host, user@host or an ~/.ssh/config alias; "local" for this machine
  -p, --port <n>         SSH port
  -i, --identity <file>  SSH private key
  -d, --dir <path>       Directory on the host (default: parsimony, under the SSH user's home)
      --env-file <file>  Configuration (default: deployment/config/.env)
      --certs <dir>      Certificates (default: deployment/config/certs)
      --build-mode <m>   local (build here, copy images; default) or remote (build on the host)
      --install-docker   Install Docker on a Linux host that doesn't have it (needs passwordless sudo)
      --timeout <s>      Seconds to wait for health checks (default: 180)
      --service <name>   logs: backend or frontend
  -f, --follow           logs: keep streaming
      --tail <n>         logs: lines to show (default: 200)
  -v, --verbose          Show every command and build output
  -h, --help
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const passthrough = sep >= 0 ? argv.slice(sep + 1) : [];
  const { values, positionals } = parseArgs({
    args: sep >= 0 ? argv.slice(0, sep) : argv,
    allowPositionals: true,
    options: {
      target: { type: 'string', short: 't' },
      port: { type: 'string', short: 'p' },
      identity: { type: 'string', short: 'i' },
      dir: { type: 'string', short: 'd', default: 'parsimony' },
      'env-file': { type: 'string', default: path.join(deploymentRoot, 'config', '.env') },
      certs: { type: 'string', default: path.join(deploymentRoot, 'config', 'certs') },
      'build-mode': { type: 'string', default: 'local' },
      'install-docker': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '180' },
      service: { type: 'string' },
      follow: { type: 'boolean', short: 'f', default: false },
      tail: { type: 'string', default: '200' },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(HELP);
    return command || values.help ? 0 : 1;
  }
  if (!values.target) throw new DeployError('--target is required (e.g. --target deploy@server.example.com, or --target local)');
  if (values['build-mode'] !== 'local' && values['build-mode'] !== 'remote') throw new DeployError('--build-mode must be local or remote');
  if (values.dir!.includes('..') || /['"$`\\]/.test(values.dir!)) throw new DeployError('--dir must be a plain path');

  const log = new Log(values.verbose);
  const common = {
    target: values.target,
    port: values.port ? Number(values.port) : undefined,
    identity: values.identity,
    dir: values.dir!.replace(/\/+$/, ''),
    verbose: !!values.verbose,
  };
  const healthTimeout = Number(values.timeout);
  const envFile = path.resolve(values['env-file']!);
  const certsDir = path.resolve(values.certs!);

  switch (command) {
    case 'deploy':
      await deploy({ ...common, envFile, certsDir, buildMode: values['build-mode'] as 'local' | 'remote', installDocker: !!values['install-docker'], healthTimeout }, log);
      return 0;
    case 'rollback':
      await rollback({ ...common, healthTimeout }, log);
      return 0;
    case 'status':
      await status(common, log);
      return 0;
    case 'logs':
      await logs({ ...common, service: values.service, follow: !!values.follow, tail: Number(values.tail) || 200 }, log);
      return 0;
    case 'update-certs':
      await updateCerts({ ...common, envFile, certsDir, healthTimeout }, log);
      return 0;
    case 'users':
      return users({ ...common, args: passthrough }, log);
    default:
      throw new DeployError(`Unknown command "${command}". Run with --help.`);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`\n✗ ${e instanceof Error ? e.message : String(e)}\n`);
    if (!(e instanceof DeployError) && e instanceof Error && e.stack) process.stderr.write(`${e.stack}\n`);
    process.exit(1);
  },
);
