import { HttpError } from '../http';

/** Fixed-window, in-memory rate limiter. Good enough for a single API process. */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a hit for `key`; throws 429 when the limit is exceeded. A limit of 0 disables limiting. */
  hit(key: string): void {
    if (this.limit === 0) return;
    const now = this.now();
    if (now - this.lastSweep > this.windowMs) this.sweep(now);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    if (w.count > this.limit) {
      const retry = Math.max(1, Math.ceil((w.resetAt - now) / 1000));
      throw new HttpError(429, `Too many requests. Try again in ${retry} s.`, undefined, 'RATE_LIMITED', { 'Retry-After': String(retry) });
    }
  }

  reset(): void {
    this.windows.clear();
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    this.lastSweep = now;
  }
}
