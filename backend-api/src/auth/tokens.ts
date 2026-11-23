import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { jwtVerify, SignJWT, errors as joseErrors } from 'jose';

const ISSUER = 'parsimony';

/**
 * Uses JWT_SECRET when given; otherwise generates a random secret on first start and keeps it in
 * `<dataDir>/jwt-secret` (mode 0600), so sessions survive restarts without any configuration.
 */
export function loadJwtSecret(configured: string, dataDir: string): Uint8Array {
  if (configured) {
    if (configured.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
    return new TextEncoder().encode(configured);
  }
  const file = path.join(dataDir, 'jwt-secret');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' });
  }
  const secret = fs.readFileSync(file, 'utf8').trim();
  if (secret.length < 32) throw new Error(`${file} is too short; delete it to regenerate`);
  return new TextEncoder().encode(secret);
}

export interface AccessClaims {
  userId: number;
  sessionId: string;
  issuedAt: number;
}

export class TokenSigner {
  constructor(private readonly secret: Uint8Array) {}

  signAccess(userId: number, sessionId: string, ttlSeconds: number): Promise<string> {
    return new SignJWT({ sid: sessionId, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(userId))
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.secret);
  }

  /** Returns null for anything that isn't a valid, unexpired access token. */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, algorithms: ['HS256'] });
      if (payload.typ !== 'access' || typeof payload.sid !== 'string' || !payload.sub || !payload.iat) return null;
      return { userId: Number(payload.sub), sessionId: payload.sid, issuedAt: payload.iat };
    } catch (e) {
      if (e instanceof joseErrors.JOSEError) return null;
      throw e;
    }
  }

  /**
   * Password-reset tokens embed a fingerprint of the current password hash, so a link stops working
   * as soon as the password changes (making it single-use).
   */
  signReset(userId: number, passwordHash: string, ttlSeconds: number): Promise<string> {
    return new SignJWT({ typ: 'reset', pwh: fingerprint(passwordHash) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(userId))
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.secret);
  }

  async verifyReset(token: string): Promise<{ userId: number; fingerprint: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, algorithms: ['HS256'] });
      if (payload.typ !== 'reset' || typeof payload.pwh !== 'string' || !payload.sub) return null;
      return { userId: Number(payload.sub), fingerprint: payload.pwh };
    } catch (e) {
      if (e instanceof joseErrors.JOSEError) return null;
      throw e;
    }
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');

export const fingerprint = (passwordHash: string) => sha256(passwordHash).slice(0, 22);

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
