import { http } from './http';
import { sharedCache } from '../utils/cache';
import { prisma } from '../db/client';

export type CoinInfo = {
  id: string;
  symbol: string;
  name: string;
  price: number;
  marketCap: number;
  volume24h: number;
  liquidityScore?: number;
};

const MEM_TTL_MS = 45_000;   // memory cache ~45s
const DB_TTL_SEC = 45;       // DB cache ~45s

export async function getCoinGeckoBySymbol(symbol: string): Promise<CoinInfo> {
  const sym = symbol.trim().toLowerCase();
  const key = `cg:symbol:${sym}`;

  // 1) Memory cache
  const mem = sharedCache.get<CoinInfo>(key);
  if (mem) return mem;

  // 2) DB cache
  const now = new Date();
  const dbRow = await prisma.priceCache.findUnique({ where: { key } });
  if (dbRow && dbRow.ttlAt > now) {
    const value = dbRow.payload as unknown as CoinInfo;
    // write-through to memory to avoid another DB hit
    sharedCache.set(key, value, MEM_TTL_MS);
    return value;
  }

  // 3) Live fetch (with one retry on 429/5xx)
  const value = await fetchFromCoinGecko(sym);

  // 4) Write-through to DB + memory
  const ttlAt = new Date(Date.now() + DB_TTL_SEC * 1000);
  await prisma.priceCache.upsert({
    where: { key },
    update: { payload: value as any, ttlAt },
    create: { key, payload: value as any, ttlAt },
  });
  sharedCache.set(key, value, MEM_TTL_MS);

  return value;
}

/* ---------------- internals ---------------- */

async function fetchFromCoinGecko(sym: string): Promise<CoinInfo> {
  const doFetch = async () => {
    // 1) /search → candidate ids (prefer exact symbol)
    const { data: search } = await http.get('https://api.coingecko.com/api/v3/search', {
      params: { query: sym },
    });

    const coins: any[] = search?.coins ?? [];
    const exact = coins.filter((c) => c?.symbol?.toLowerCase() === sym);
    const candidates = exact.length ? exact : coins;
    if (!candidates.length) {
      throw new Error(`Symbol $${sym.toUpperCase()} not found on CoinGecko`);
    }

    // 2) markets for top few (rank by market cap)
    const topIds = candidates.slice(0, 5).map((c: any) => c.id).join(',');
    const { data: markets } = await http.get(
      'https://api.coingecko.com/api/v3/coins/markets',
      { params: { vs_currency: 'usd', ids: topIds, price_change_percentage: '24h' } }
    );

    const best = pickBestByMarketCap(markets);
    if (!best) throw new Error(`No market data for $${sym.toUpperCase()}`);

    // 3) full coin (for liquidity_score + fallbacks)
    const { data: full } = await http.get(`https://api.coingecko.com/api/v3/coins/${best.id}`);

    return {
      id: best.id,
      symbol: String(best.symbol ?? '').toUpperCase(),
      name: best.name ?? full?.name ?? sym.toUpperCase(),
      price: best.current_price ?? full?.market_data?.current_price?.usd ?? 0,
      marketCap: best.market_cap ?? full?.market_data?.market_cap?.usd ?? 0,
      volume24h: best.total_volume ?? full?.market_data?.total_volume?.usd ?? 0,
      liquidityScore: full?.liquidity_score,
    } as CoinInfo;
  };

  try {
    return await doFetch();
  } catch (e: any) {
    const status = e?.response?.status;
    if (status === 429 || (status && status >= 500)) {
      await sleep(400);
      return await doFetch();
    }
    throw e;
  }
}

function pickBestByMarketCap(coins: any[]) {
  return coins
    .filter(Boolean)
    .sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))[0];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
