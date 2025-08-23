import type { FastifyInstance } from 'fastify';
import { getDexByContract } from '../services/dexscreener';
import { aiSafetyInsight } from '../services/ai';

export default async function tokenRoute(app: FastifyInstance) {
  app.get('/token/:address', async (req, reply) => {
    const { address } = req.params as { address: string };

    const pairs = await getDexByContract(address);
    const top = pairs[0];

    const token = {
      name: top.baseToken?.name ?? 'Unknown',
      symbol: top.baseToken?.symbol ?? '???',
      chain: top.chainId?.toUpperCase() ?? '—',
    };
    const metrics = {
      priceUsd: top.priceUsd ? Number(top.priceUsd) : undefined,
      liquidityUsd: top.liquidity?.usd ?? 0,
      volume24h: top.volume?.h24 ?? 0,
      fdv: top.fdv,
      buys24h: top.txns?.h24?.buys,
      sells24h: top.txns?.h24?.sells,
    };

    const ai = await aiSafetyInsight({ token, metrics });

    return reply.send({ token, metrics, ai });
  });
}
