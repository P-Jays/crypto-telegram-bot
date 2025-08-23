export type CacheEntry<T> = { value: T; expires: number };

export class TTLCache {
  private store = new Map<string, CacheEntry<any>>();

  constructor(private defaultTtlMs = 30_000) {}

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs = this.defaultTtlMs) {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  async with<T>(
    key: string,
    fn: () => Promise<T>,
    ttlMs = this.defaultTtlMs
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const fresh = await fn();
    this.set(key, fresh, ttlMs);
    return fresh;
  }

  clear() {
    this.store.clear();
  }
}

export const sharedCache = new TTLCache(45_000); // default 45s
