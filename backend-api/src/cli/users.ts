/**
 * User administration from the command line — for creating the first account on a headless host or
 * recovering when no administrator can sign in.
 *
 *   npm run users -- list
 *   npm run users -- create --email you@example.com --role ADMINISTRATOR [--name "Your Name"]
 *   npm run users -- reset-password --email you@example.com
 *   npm run users -- set-role --email you@example.com --role EDITOR
 *
 * The password is read from the PARSIMONY_PASSWORD environment variable or, if unset, prompted for.
 * In a container: docker compose exec backend npm run users -- list
 */
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { loadConfig } from '../config';
import { loadDotEnv } from '../dotenv';
import { Db } from '../db';
import { migrate } from '../migrations';
import { hashPassword, passwordSchema } from '../auth/passwords';
import { ROLES, type Role } from '../../../shared/types';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function readPassword(prompt: string): Promise<string> {
  if (process.env.PARSIMONY_PASSWORD) return process.env.PARSIMONY_PASSWORD;
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted || s.includes(prompt)) out.output.write(s);
  };
  const ask = (q: string) =>
    new Promise<string>((resolve) => {
      muted = false;
      rl.question(q, (a) => resolve(a));
      muted = true;
    });
  const first = await ask(prompt);
  process.stdout.write('\n');
  const second = await ask('Repeat password: ');
  process.stdout.write('\n');
  rl.close();
  if (first !== second) fail('The passwords do not match.');
  return first;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { email: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' } },
  });
  loadDotEnv();
  const config = loadConfig();
  const db = new Db(config.dbPath);
  migrate(db);

  const role = (): Role => {
    const r = (values.role ?? '').toUpperCase();
    if (!ROLES.includes(r as Role)) fail(`--role must be one of ${ROLES.join(', ')}`);
    return r as Role;
  };
  const email = () => (values.email?.trim().toLowerCase() || fail('--email is required'));
  const newPassword = async () => {
    const p = passwordSchema.safeParse(await readPassword('Password: '));
    if (!p.success) fail(`Password ${p.error.issues[0].message}`);
    return hashPassword(p.data);
  };
  const audit = (action: string, details: string) =>
    db.run("INSERT INTO audit_log (action, details, ip) VALUES (?, ?, 'cli')", [action, details]);

  switch (command) {
    case 'list': {
      const rows = db.all<{ email: string; role: string; display_name: string | null; last_login_at: string | null }>(
        'SELECT email, role, display_name, last_login_at FROM app_user ORDER BY email',
      );
      if (rows.length === 0) console.log('No users yet.');
      for (const r of rows) console.log(`${r.email.padEnd(36)} ${r.role.padEnd(14)} ${r.display_name ?? ''}  last sign-in: ${r.last_login_at ?? 'never'}`);
      break;
    }
    case 'create': {
      const e = email();
      const r = role();
      if (db.get('SELECT 1 FROM app_user WHERE email = ?', [e])) fail(`${e} already exists; use reset-password or set-role.`);
      const hash = await newPassword();
      db.run('INSERT INTO app_user (email, display_name, password_hash, role) VALUES (?, ?, ?, ?)', [e, values.name ?? null, hash, r]);
      audit('cli.user_create', `${e} as ${r}`);
      console.log(`Created ${e} (${r}).`);
      break;
    }
    case 'reset-password': {
      const e = email();
      if (!db.get('SELECT 1 FROM app_user WHERE email = ?', [e])) fail(`No user ${e}.`);
      const hash = await newPassword();
      db.tx(() => {
        db.run(`UPDATE app_user SET password_hash = ?, tokens_invalid_before = strftime('%s', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE email = ?`, [hash, e]);
        db.run('DELETE FROM user_session WHERE user_id = (SELECT user_id FROM app_user WHERE email = ?)', [e]);
      });
      audit('cli.password_reset', e);
      console.log(`Password changed for ${e}; their sessions were signed out.`);
      break;
    }
    case 'set-role': {
      const e = email();
      const r = role();
      const u = db.get<{ role: string }>('SELECT role FROM app_user WHERE email = ?', [e]) ?? fail(`No user ${e}.`);
      if (u.role === 'ADMINISTRATOR' && r !== 'ADMINISTRATOR' && db.scalar<number>("SELECT COUNT(*) FROM app_user WHERE role = 'ADMINISTRATOR'") <= 1) {
        fail('That is the only administrator.');
      }
      db.tx(() => {
        db.run(`UPDATE app_user SET role = ?, tokens_invalid_before = strftime('%s', 'now') WHERE email = ?`, [r, e]);
        db.run('DELETE FROM user_session WHERE user_id = (SELECT user_id FROM app_user WHERE email = ?)', [e]);
      });
      audit('cli.set_role', `${e} → ${r}`);
      console.log(`${e} is now ${r}.`);
      break;
    }
    default:
      console.log('Usage: npm run users -- <list | create | reset-password | set-role> [--email E] [--role R] [--name N]');
      process.exit(command ? 1 : 0);
  }
  db.close();
}

await main();
