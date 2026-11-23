import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { z } from 'zod';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

// OWASP-recommended scrypt parameters: N=2^17, r=8, p=1 (≈128 MiB, ~0.1–0.3 s).
// Parameters are stored with each hash, so they can be raised later without breaking old hashes.
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEYLEN = 32;
const maxmem = (n: number, r: number) => 128 * n * r * 2;

export const passwordSchema = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(128, 'must be at most 128 characters');

/** Returns `scrypt$N$r$p$salt$hash` (salt and hash base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || expected.length === 0) return false;
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N: n, r, p, maxmem: maxmem(n, r) });
  return timingSafeEqual(key, expected);
}

/** A valid hash of a random password, used to keep sign-in timing the same for unknown emails. */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}
