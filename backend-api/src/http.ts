import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import type { AuthUser, Role } from '../../shared/types';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    readonly code?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`, undefined, 'NOT_FOUND');
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details, 'BAD_REQUEST');
export const conflict = (msg: string) => new HttpError(409, msg, undefined, 'CONFLICT');
export const unauthorized = (msg = 'Sign in to continue', code = 'UNAUTHORIZED') => new HttpError(401, msg, undefined, code);
export const forbidden = (msg = 'Your role does not allow this action') => new HttpError(403, msg, undefined, 'FORBIDDEN');

/**
 * Who may call a route:
 * - `public` — anyone (sign-in, health, public config)
 * - `user`   — any signed-in user
 * - `editor` — EDITOR or ADMINISTRATOR
 * - `admin`  — ADMINISTRATOR only
 */
export type Access = 'public' | 'user' | 'editor' | 'admin';

const ALLOWED: Record<Exclude<Access, 'public'>, Role[]> = {
  user: ['ADMINISTRATOR', 'EDITOR', 'READ_ONLY'],
  editor: ['ADMINISTRATOR', 'EDITOR'],
  admin: ['ADMINISTRATOR'],
};

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body (undefined when there is none). */
  body: unknown;
  /** Raw body buffer — populated only for routes registered with { raw: true }. */
  rawBody?: Buffer;
  /** The signed-in user; always set on non-public routes. */
  user: AuthUser | null;
  /** Client IP (from X-Real-IP when behind a trusted proxy). */
  ip: string;
  /** Whether the client connected over HTTPS (directly or via a trusted proxy). */
  secure: boolean;
}

/** Return a value from a handler to send it as JSON, or a Reply to control the response. */
export class Reply {
  constructor(
    readonly body: string | Buffer,
    readonly headers: Record<string, string> = {},
    readonly status = 200,
  ) {}
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export interface RouteOptions {
  /** Deliver the body as a Buffer instead of parsing JSON. */
  raw?: boolean;
  /** Defaults: GET → `user`, everything else → `editor`. */
  access?: Access;
  /** Set false for routes that write their own, more specific audit entries. */
  audit?: boolean;
  /** Rate-limit bucket. `auth` routes are limited per IP; others per user. */
  limit?: 'auth' | 'api';
}

export interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  raw: boolean;
  access: Access;
  audit: boolean;
  limit: 'auth' | 'api';
}

/** Cross-cutting concerns the router delegates to the auth layer. */
export interface Guard {
  /** Resolves the bearer token. Returns null when no token is present; throws 401 when it is invalid. */
  authenticate(req: IncomingMessage): Promise<AuthUser | null>;
  /** Throws a 429 HttpError when the caller is over its limit. */
  rateLimit(route: Route, ctx: Ctx): void;
  /** Called after every request on a route that changes data. */
  audit(route: Route, ctx: Ctx, status: number): void;
}

const JSON_LIMIT = 10 * 1024 * 1024;
const RAW_LIMIT = 50 * 1024 * 1024;

export class Router {
  private routes: Route[] = [];
  guard: Guard | null = null;
  trustProxy = false;

  add(method: string, pattern: string, handler: Handler, opts: RouteOptions = {}): this {
    const keys: string[] = [];
    const source = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({
      method,
      pattern,
      regex: new RegExp(`^${source}/?$`),
      keys,
      handler,
      raw: !!opts.raw,
      access: opts.access ?? (method === 'GET' ? 'user' : 'editor'),
      audit: opts.audit ?? method !== 'GET',
      limit: opts.limit ?? 'api',
    });
    return this;
  }

  get = (p: string, h: Handler, o?: RouteOptions) => this.add('GET', p, h, o);
  post = (p: string, h: Handler, o?: RouteOptions) => this.add('POST', p, h, o);
  put = (p: string, h: Handler, o?: RouteOptions) => this.add('PUT', p, h, o);
  patch = (p: string, h: Handler, o?: RouteOptions) => this.add('PATCH', p, h, o);
  delete = (p: string, h: Handler, o?: RouteOptions) => this.add('DELETE', p, h, o);

  /** All registered routes (used by tests to check every route is protected). */
  list(): readonly Route[] {
    return this.routes;
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route, params };
    }
    if (pathMatched) throw new HttpError(405, `Method ${method} not allowed`, undefined, 'METHOD_NOT_ALLOWED');
    return null;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let route: Route | null = null;
    const ctx: Ctx = {
      req,
      res,
      params: {},
      query: url.searchParams,
      body: undefined,
      user: null,
      ip: clientIp(req, this.trustProxy),
      secure: isSecure(req, this.trustProxy),
    };
    let status = 500;
    try {
      const found = this.match(req.method ?? 'GET', url.pathname);
      if (!found) return false;
      route = found.route;
      ctx.params = found.params;

      // Authenticate and authorize before reading the body, so anonymous callers can't make us buffer uploads.
      ctx.user = this.guard ? await this.guard.authenticate(req) : null;
      if (route.access !== 'public') {
        if (!ctx.user) throw unauthorized();
        if (!ALLOWED[route.access].includes(ctx.user.role)) throw forbidden();
      }
      this.guard?.rateLimit(route, ctx);

      const buf = await readBody(req, route.raw ? RAW_LIMIT : JSON_LIMIT);
      if (route.raw) {
        ctx.rawBody = buf;
      } else if (buf.length > 0) {
        try {
          ctx.body = JSON.parse(buf.toString('utf8'));
        } catch {
          throw badRequest('Request body is not valid JSON');
        }
      }
      const result = await route.handler(ctx);
      if (result instanceof Reply) {
        status = result.status;
        res.writeHead(result.status, { 'Cache-Control': 'no-store', ...result.headers });
        res.end(result.body);
      } else {
        status = result === undefined ? 204 : 200;
        sendJson(res, status, result);
      }
    } catch (e) {
      status = sendError(res, e);
    }
    if (route && route.audit && ctx.user && status !== 401 && status !== 403) {
      try {
        this.guard?.audit(route, ctx, status);
      } catch (e) {
        console.error('Audit logging failed:', e);
      }
    }
    return true;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const real = header(req, 'x-real-ip')?.trim();
    if (real) return real;
    const fwd = header(req, 'x-forwarded-for')?.split(',').pop()?.trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function isSecure(req: IncomingMessage, trustProxy: boolean): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return trustProxy && header(req, 'x-forwarded-proto')?.split(',')[0].trim() === 'https';
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large', undefined, 'PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (status === 204) {
    res.writeHead(204, { 'Cache-Control': 'no-store', ...headers });
    res.end();
    return;
  }
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** Sends an error response and returns its status code. */
export function sendError(res: ServerResponse, e: unknown): number {
  if (e instanceof ZodError) {
    const msg = e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    sendJson(res, 400, { error: msg, code: 'VALIDATION_ERROR', details: e.issues });
    return 400;
  }
  if (e instanceof HttpError) {
    sendJson(res, e.status, { error: e.message, code: e.code, details: e.details }, e.headers);
    return e.status;
  }
  console.error(e);
  // Never leak internals (SQL, paths) to clients.
  sendJson(res, 500, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
  return 500;
}

/** Headers applied to every response. The CSP allows scripts only from this origin. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Serves the built web app with SPA fallback to index.html. */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (!fs.existsSync(root)) return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  let rel: string;
  try {
    rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  } catch {
    return false;
  }
  let file = path.join(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) return false;
  const ext = path.extname(file);
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
