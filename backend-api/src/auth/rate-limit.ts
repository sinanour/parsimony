import { HttpError } from '../http';

export const tooManyRequests = (retrySeconds: number, message?: string, code = 'RATE_LIMITED') => {
  const retry = Math.max(1, Math.ceil(retrySeconds));
  return new HttpError(429, message ?? `Too many requests. Try again in ${retry} s.`, undefined, code, { 'Retry-After': String(retry) });
};

/** Fixed-window, in-memory rate limiter. Good enough for a single API process. */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    this.lastSweep = now();
  }

  /** Counts a hit for `key`; throws 429 when the limit is exceeded. A limit of 0 disables limiting. */
  hit(key: string): void {
    if (!this.allow(key)) throw tooManyRequests(this.retryAfter(key));
  }

  /** Counts a hit for `key` and reports whether it is within the limit (never throws). */
  allow(key: string): boolean {
    if (this.limit === 0) return true;
    const w = this.window(key, true)!;
    w.count++;
    return w.count <= this.limit;
  }

  /** Throws 429 when `key` has already used up its budget, without counting anything. */
  check(key: string): void {
    if (this.limit === 0) return;
    const w = this.window(key, false);
    if (w && w.count >= this.limit) throw tooManyRequests(this.retryAfter(key));
  }

  /** Gives back one hit (e.g. a provisionally counted failure that turned out to be a success). */
  refund(key: string): void {
    const w = this.window(key, false);
    if (w && w.count > 0) w.count--;
  }

  /** Seconds until `key`'s window resets. */
  retryAfter(key: string): number {
    const w = this.windows.get(key);
    return w ? Math.max(1, Math.ceil((w.resetAt - this.now()) / 1000)) : 1;
  }

  reset(): void {
    this.windows.clear();
  }

  private window(key: string, create: boolean): { count: number; resetAt: number } | undefined {
    const now = this.now();
    if (now - this.lastSweep > this.windowMs) this.sweep(now);
    let w = this.windows.get(key);
    if (w && w.resetAt <= now) {
      this.windows.delete(key);
      w = undefined;
    }
    if (!w && create) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    return w;
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    this.lastSweep = now;
  }
}

interface LockoutEntry {
  failures: number;
  lockedUntil: number;
  lastFailure: number;
}

export interface LockoutOptions {
  /** Consecutive failures before the first lock. 0 disables the lockout. */
  threshold: number;
  /** Length of the first lock; each further failure doubles it. */
  baseMs: number;
  /** Upper bound for a single lock. */
  maxMs: number;
  /** Failure history is forgotten after this long without a failure. */
  forgetMs?: number;
  /** Bound on remembered keys (oldest are dropped first). */
  maxEntries?: number;
  now?: () => number;
}

/**
 * Per-account failed sign-in tracking with an escalating temporary lock, kept in memory.
 *
 * After `threshold` consecutive failures the key is locked for `baseMs`; every further failure (once the lock
 * has passed) doubles the lock, up to `maxMs`. A success clears the key. Keys are whatever the caller submits
 * (normalised email), registered or not, so a lock never reveals whether an account exists.
 */
export class LoginLockout {
  private entries = new Map<string, LockoutEntry>();
  private readonly forgetMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private lastSweep: number;

  constructor(private readonly opts: LockoutOptions) {
    this.forgetMs = opts.forgetMs ?? 24 * 3600_000;
    this.maxEntries = opts.maxEntries ?? 20_000;
    this.now = opts.now ?? Date.now;
    this.lastSweep = this.now();
  }

  get enabled(): boolean {
    return this.opts.threshold > 0;
  }

  /** Milliseconds the key stays locked (0 when it isn't). */
  lockedFor(key: string): number {
    const e = this.live(key);
    return e ? Math.max(0, e.lockedUntil - this.now()) : 0;
  }

  /** Records a failure. Returns the consecutive-failure count and the lock it started (0 = none). */
  fail(key: string): { failures: number; lockMs: number } {
    if (!this.enabled) return { failures: 0, lockMs: 0 };
    const now = this.now();
    let e = this.live(key);
    if (!e) {
      this.makeRoom(now);
      e = { failures: 0, lockedUntil: 0, lastFailure: now };
    } else {
      this.entries.delete(key); // re-insert so Map order stays least-recently-failed first
    }
    e.failures++;
    e.lastFailure = now;
    let lockMs = 0;
    if (e.failures >= this.opts.threshold) {
      const steps = Math.min(e.failures - this.opts.threshold, 30);
      lockMs = Math.min(this.opts.maxMs, this.opts.baseMs * 2 ** steps);
      e.lockedUntil = now + lockMs;
    }
    this.entries.set(key, e);
    return { failures: e.failures, lockMs };
  }

  /** Clears the key after a successful sign-in. */
  succeed(key: string): void {
    this.entries.delete(key);
  }

  reset(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private live(key: string): LockoutEntry | undefined {
    const e = this.entries.get(key);
    if (e && this.expired(e, this.now())) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  private expired(e: LockoutEntry, now: number): boolean {
    return e.lockedUntil <= now && now - e.lastFailure > this.forgetMs;
  }

  private makeRoom(now: number): void {
    if (this.entries.size < this.maxEntries && now - this.lastSweep < 60_000) return;
    for (const [k, e] of this.entries) if (this.expired(e, now)) this.entries.delete(k);
    this.lastSweep = now;
    // Still full: forget the entries that failed longest ago, but never one that is currently locked.
    for (const [k, e] of this.entries) {
      if (this.entries.size < this.maxEntries) break;
      if (e.lockedUntil <= now) this.entries.delete(k);
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
