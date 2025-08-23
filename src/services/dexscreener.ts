import { sharedCache } from "../utils/cache";
import { http } from "./http";

export type DexPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  url?: string;
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
  txns?: {
    m5?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  volume?: { h24?: number };
};


export async function searchDexPairs(query: string, limit = 5) {
  const key = `dex:search:${query.toLowerCase()}:${limit}`;
  return sharedCache.with(
    key,
    async () => {
      const { data } = await http.get(
        "https://api.dexscreener.com/latest/dex/search",
        { params: { q: query } }
      );
      const pairs: any[] = data?.pairs ?? [];
      return pairs
        .sort(
          (a, b) =>
            (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0) ||
            (b?.volume?.h24 ?? 0) - (a?.volume?.h24 ?? 0)
        )
        .slice(0, limit);
    },
    60_000
  );
}

export async function getPairByChainAndAddress(
  chainId: string,
  pairAddress: string
) {
  const key = `dex:pair:${chainId}:${pairAddress}`;
  return sharedCache.with(
    key,
    async () => {
      const { data } = await http.get(
        `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress}`
      );
      return (data?.pairs ?? [])[0];
    },
    60_000
  );
}

export async function getDexByContract(contracts: string) {
  const key = `dex:contract:${contracts.toLowerCase()}`;
  return sharedCache.with(
    key,
    async () => {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${contracts}`;
      const res = await http.get(url);
      const pairs: DexPair[] = res.data?.pairs ?? [];
      if (!pairs.length)
        throw new Error("No pairs found for that contract on Dexscreener");
      // Sort by best liquidity (desc)
      return pairs.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
      );
    },
    45_000
  );
}
