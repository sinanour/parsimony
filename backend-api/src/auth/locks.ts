/**
 * Serialises async work per key (e.g. per user id) within this process.
 *
 * Credential writes check preconditions, then hash with scrypt (which yields the event loop for a few hundred
 * milliseconds), then write. Holding the key's lock across all three stops another write to the same user from
 * landing in between. Callers still re-check inside the writing transaction, because other processes (the
 * `users` CLI) don't share this lock.
 */
export class KeyedMutex<K = number> {
  private readonly tails = new Map<K, Promise<void>>();
  private readonly queued = new Map<K, number>();

  async run<T>(key: K, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    this.queued.set(key, (this.queued.get(key) ?? 0) + 1);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      const n = (this.queued.get(key) ?? 1) - 1;
      if (n > 0) this.queued.set(key, n);
      else this.queued.delete(key);
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Number of holders plus waiters for `key` (for tests and diagnostics). */
  pending(key: K): number {
    return this.queued.get(key) ?? 0;
  }
}
