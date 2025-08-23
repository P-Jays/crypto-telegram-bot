import type { Context, MiddlewareFn } from "telegraf";

/**
 * Token-bucket per-chat limiter:
 * - capacity: 5 tokens
 * - refill: 1 token every 6s (≈ 5 per 30s)
 * - hard cooldown: 900ms between actions (anti-burst)
 */
type Bucket = { tokens: number; last: number; lastHit: number };
const buckets = new Map<number, Bucket>();

const CAPACITY = 5;
const REFILL_MS = 6_000; // add 1 token / 6s
const MIN_GAP_MS = 900; // min spacing between actions

export const rateLimiter: MiddlewareFn<Context> = async (ctx, next) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return next();

  const now = Date.now();
  let b = buckets.get(chatId);
  if (!b) {
    b = { tokens: CAPACITY, last: now, lastHit: 0 };
    buckets.set(chatId, b);
  }

  // refill
  const elapsed = now - b.last;
  if (elapsed > 0) {
    const add = Math.floor(elapsed / REFILL_MS);
    if (add > 0) {
      b.tokens = Math.min(CAPACITY, b.tokens + add);
      b.last = now;
    }
  }

  // gap check
  if (now - b.lastHit < MIN_GAP_MS) {
    return ctx.reply("⏱ Please slow down a bit…");
  }

  if (b.tokens <= 0) {
    const secs = Math.ceil((REFILL_MS - ((now - b.last) % REFILL_MS)) / 1000);
    return ctx.reply(`⏳ Too many requests. Try again in ~${secs}s.`);
  }

  // consume
  b.tokens -= 1;
  b.lastHit = now;
  return next();
};
