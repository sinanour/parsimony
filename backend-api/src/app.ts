import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Db } from './db';
import { Router, SECURITY_HEADERS, sendJson, serveStatic, type Route, type Ctx } from './http';
import { packageRoot, type Config } from './config';
import { migrate } from './migrations';
import { backupDatabase } from './services/backup';
import { AuthService } from './auth/service';
import { TokenSigner, loadJwtSecret } from './auth/tokens';
import { createMailer, type Mailer } from './auth/mailer';
import { authRoutes } from './routes/auth';
import { accountRoutes } from './routes/accounts';
import { payeeRoutes } from './routes/payees';
import { paymentRoutes } from './routes/payments';
import { transactionRoutes } from './routes/transactions';
import { ruleRoutes } from './routes/rules';
import { importRoutes } from './routes/imports';
import { statementFormatRoutes } from './routes/statement-formats';
import { reportRoutes } from './routes/reports';

export interface App {
  server: http.Server;
  db: Db;
  auth: AuthService;
  router: Router;
  /** Set when no users exist: the one-time code needed to create the first administrator. */
  setupCode: string | null;
  backupFile: string | null;
  migrationsApplied: string[];
}

export const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface AppOptions {
  /** Overrides the SMTP mailer (tests). */
  mailer?: Mailer | null;
}

/** Opens (or creates) the database, backs it up, migrates it, and builds the HTTP server. */
export async function createApp(config: Config, opts: AppOptions = {}): Promise<App> {
  const isNew = !fs.existsSync(config.dbPath);
  const db = new Db(config.dbPath);

  let backupFile: string | null = null;
  if (config.backupOnStart && !isNew) {
    try {
      backupFile = backupDatabase(db, config.backupDir, config.backupKeep);
    } catch (e) {
      db.close();
      throw new Error(`Database backup failed, so migrations were not run: ${e instanceof Error ? e.message : e}`);
    }
  }
  const migrationsApplied = migrate(db);

  const signer = new TokenSigner(loadJwtSecret(config.auth.jwtSecret, config.dataDir));
  const mailer = opts.mailer !== undefined ? opts.mailer : createMailer(config.smtp);
  const auth = new AuthService(db, config, signer, mailer);
  const setupCode = await auth.bootstrap();

  const router = new Router();
  router.trustProxy = config.trustProxy;
  router.guard = {
    authenticate: (req) => auth.authenticate(req),
    rateLimit: (route: Route, ctx: Ctx) => {
      if (route.limit === 'auth') auth.limitAuthRoute(route, ctx.user, { ip: ctx.ip });
      else if (ctx.user) auth.apiLimiter.hit(`user:${ctx.user.userId}`);
    },
    audit: (route: Route, ctx: Ctx, status: number) =>
      auth.audit({ action: 'api.write', user: ctx.user, method: route.method, path: new URL(ctx.req.url ?? '/', 'http://x').pathname, status, ip: ctx.ip }),
  };

  const deps = { db, config, auth, version: VERSION };
  for (const mod of [authRoutes, accountRoutes, payeeRoutes, paymentRoutes, transactionRoutes, ruleRoutes, importRoutes, statementFormatRoutes, reportRoutes]) {
    mod(router, deps);
  }
  router.get(
    '/api/health',
    () => {
      db.scalar('SELECT 1');
      return { status: 'ok', version: VERSION };
    },
    { access: 'public' },
  );

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (await router.handle(req, res)) return;
    if (req.url?.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(config.webDist, req, res)) return;
    sendJson(res, 404, { error: 'Not found. Run `npm run build` to serve the web app from this server, or use `npm run dev`.' });
  });
  server.on('close', () => db.close());
  return { server, db, auth, router, setupCode, backupFile, migrationsApplied };
}
