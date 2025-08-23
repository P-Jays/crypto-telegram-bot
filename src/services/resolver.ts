import { searchDexPairs, getPairByChainAndAddress } from "./dexscreener";
import { http } from "./http";

const GOOD_QUOTES = new Set(["USDC", "USDT", "WETH", "WBNB", "BUSD", "WBTC"]);

const SPECIAL_MAP: Record<string, { address: string; note: string }> = {
  eth: {
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    note: "Mapped to WETH (Ethereum)",
  },
  btc: {
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    note: "Mapped to WBTC (Ethereum)",
  },
};

const isAddress = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(s);

export type ResolveResult = {
  address: string;
  source: "dex" | "pair" | "coingecko" | "special";
  note?: string;
};

export async function resolveContractFromQuery(
  query: string
): Promise<ResolveResult | null> {
  const q = query.trim().toLowerCase();
  if (isAddress(q)) return { address: q, source: "dex" };

  // 1) Dexscreener search: prefer pairs with baseToken.address and good quotes
  const pairs = await searchDexPairs(q, 8);
  const withAddr = pairs.filter(
    (p) => p?.baseToken?.address && isAddress(p.baseToken.address)
  );
  withAddr.sort((a, b) => {
    const qa = GOOD_QUOTES.has((a?.quoteToken?.symbol || "").toUpperCase())
      ? 1
      : 0;
    const qb = GOOD_QUOTES.has((b?.quoteToken?.symbol || "").toUpperCase())
      ? 1
      : 0;
    return qb - qa || (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0);
  });
  if (withAddr[0]) {
    return { address: withAddr[0].baseToken.address, source: "dex" };
  }

  // 2) If only pairAddress is present, fetch pair detail to discover base address
  for (const p of pairs) {
    if (p?.pairAddress && p?.chainId) {
      try {
        const detail = await getPairByChainAndAddress(p.chainId, p.pairAddress);
        const addr = detail?.baseToken?.address;
        if (addr && isAddress(addr)) return { address: addr, source: "pair" };
      } catch {}
    }
  }

  // 3) CoinGecko platforms (Ethereum first)
  try {
    const { data: search } = await http.get(
      "https://api.coingecko.com/api/v3/search",
      { params: { query: q } }
    );
    const coins: any[] = search?.coins ?? [];
    if (coins.length) {
      // rank by market cap rank (smallest is better)
      coins.sort(
        (a, b) => (a?.market_cap_rank ?? 1e9) - (b?.market_cap_rank ?? 1e9)
      );
      const topId = coins[0].id;
      const { data: full } = await http.get(
        `https://api.coingecko.com/api/v3/coins/${topId}`
      );
      const platforms = full?.platforms ?? {};
      const candidates: string[] = [
        platforms.ethereum,
        platforms.bsc,
        platforms.polygon_pos,
        platforms.arbitrum_one,
        platforms.avalanche,
        platforms.base,
        platforms.optimism,
        platforms.fantom,
      ].filter(Boolean);
      const evm = candidates.find((a: string) => isAddress(a));
      if (evm) return { address: evm, source: "coingecko" };
    }
  } catch {}

  // 4) Special mapping (native coins -> wrapped Ethereum ERC-20)
  const sp = SPECIAL_MAP[q];
  if (sp) return { address: sp.address, source: "special", note: sp.note };

  return null;
}
