// Simple ephemeral callback store (in-memory)
const store = new Map<string, { v: any; exp: number }>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

function gc() {
  const now = Date.now();
  for (const [k, { exp }] of store) if (exp < now) store.delete(k);
}

function randomId(len = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function putPayload(value: any, ttlMs = TTL_MS): string {
  gc();
  const id = randomId();
  store.set(id, { v: value, exp: Date.now() + ttlMs });
  return id;
}

export function takePayload(id: string) {
  gc();
  const hit = store.get(id);
  if (!hit) return null;
  store.delete(id); // one-time
  return hit.v;
}
