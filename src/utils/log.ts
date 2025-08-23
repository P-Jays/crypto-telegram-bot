import { prisma } from '../db/client';

export async function logQuery(params: {
  chatId: number;
  type: 'price' | 'analyze' | 'freeform' | 'error' | 'start'| 'help' | 'settings' | 'provider';
  input: string;
  outcome?: string;
  latencyMs?: number;
  provider?: string;
  cacheKey?: string;
}) {
  try {
    console.log('[logQuery] called with:', {
      chatId: params.chatId,
      type: params.type,
      input: params.input.slice(0, 30) + (params.input.length > 30 ? '...' : ''),
      outcome: params.outcome ?? 'ok',
      latencyMs: params.latencyMs,
      provider: params.provider,
      cacheKey: params.cacheKey,
    });

    await prisma.queryLog.create({
      data: {
        chatId: BigInt(params.chatId),
        type: params.type,
        input: params.input.slice(0, 2000),
        outcome: params.outcome ?? 'ok',
        latencyMs: params.latencyMs ?? null,
        provider: params.provider ?? null,
        cacheKey: params.cacheKey ?? null,
      },
    });

    console.log('[logQuery] ✅ wrote to DB');
  } catch (e) {
    console.error('[logQuery] ❌ error', (e as any)?.message || e);
  }
}
