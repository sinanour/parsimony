import { loadConfig } from './config';
import { loadDotEnv } from './dotenv';
import { createApp } from './app';

let config: ReturnType<typeof loadConfig>;
try {
  loadDotEnv();
  config = loadConfig();
} catch (e) {
  console.error(`Configuration error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const app = await createApp(config).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

if (app.backupFile) console.log(`Backed up database to ${app.backupFile}`);
if (app.migrationsApplied.length) console.log(`Applied migrations: ${app.migrationsApplied.join(', ')}`);

if (app.setupCode) {
  const line = '─'.repeat(64);
  console.log(
    `\n${line}\n  No users exist yet. Open Parsimony in a browser and create the first\n` +
      `  administrator with this one-time setup code:\n\n      ${app.setupCode}\n\n` +
      `  (Or set ADMIN_EMAIL and ADMIN_PASSWORD and restart.)\n${line}\n`,
  );
}

if (!app.auth.passwordResetEnabled && config.smtp && !config.publicUrl) {
  console.warn('SMTP is configured but PUBLIC_URL is not; password reset by email stays disabled.');
}

app.server.listen(config.port, config.host, () => {
  console.log(`Parsimony API listening on http://${config.host}:${config.port} (database: ${config.dbPath})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.server.close(() => process.exit(0));
    app.server.closeAllConnections();
  });
}
