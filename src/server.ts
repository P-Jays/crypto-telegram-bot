// src/server.ts
import "dotenv/config";
import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";

import { getCoinGeckoBySymbol } from "./services/coingecko";
import { getDexByContract } from "./services/dexscreener";
import { aiSafetyInsight } from "./services/ai";
import { prisma } from "./db/client";

// If bot is exported, uncomment this import.
// Make sure src/bot/index.ts exports:  `export const bot = new Telegraf(...);`
import { bot } from "./bot";

const isEvmAddress = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(s);
const fmtErr = (e: any) => (e?.message ? String(e.message) : "Internal error");
const token = process.env.BOT_TOKEN;
const useWebhook = (process.env.BOT_MODE || "polling") === "webhook";
const webhookPath = token ? `/tg/${token}` : undefined;

function getPort() {
  return Number(process.env.PORT || 5555);
}

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // Register plugins INSIDE async function (no top-level await in CJS)
  await app.register(cors, { origin: true });
  await app.register(helmet);

  // --- health ---
  app.get("/health", async () => ({
    ok: true,
    mode: process.env.BOT_MODE || "polling",
  }));

  // --- Webhook endpoint (if run webhook mode & bot imported) ---
  // const token = process.env.BOT_TOKEN;
  // const useWebhook = (process.env.BOT_MODE || 'polling') === 'webhook';
  // const webhookPath = token ? `/tg/${token}` : undefined;

  if (useWebhook && webhookPath && bot) {
    app.post(webhookPath, async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        // @ts-ignore Telegraf expects raw update JSON
        await bot.handleUpdate(req.body);
        reply.send({ ok: true });
      } catch (e: any) {
        req.log.error({ err: e }, "handleUpdate failed");
        reply.code(500).send({ ok: false, error: fmtErr(e) });
      }
    });
  }

  /**
   * GET /token/:address
   * Returns top Dexscreener pair metrics + AI safety insight
   */
  app.get(
    "/token/:address",
    async (
      req: FastifyRequest<{ Params: { address: string } }>,
      reply: FastifyReply
    ) => {
      const t0 = Date.now();
      const { address } = req.params;

      if (!address || !isEvmAddress(address)) {
        reply.code(400);
        return { error: "Invalid contract address (expected 0x…40 hex)." };
      }

      try {
        const pairs = await getDexByContract(address);
        const top = pairs?.[0];
        if (!top) {
          reply.code(404);
          return { error: "Token not found on Dexscreener" };
        }

        const tokenInfo = {
          name: top.baseToken?.name ?? "Unknown",
          symbol: top.baseToken?.symbol ?? "???",
          chain: (top.chainId || "").toUpperCase(),
        };

        const metrics = {
          priceUsd: top.priceUsd ? Number(top.priceUsd) : undefined,
          liquidityUsd: top.liquidity?.usd ?? 0,
          volume24h: top.volume?.h24 ?? 0,
          fdv: typeof top.fdv === "number" ? top.fdv : undefined,
          buys24h: top.txns?.h24?.buys,
          sells24h: top.txns?.h24?.sells,
        };

        const ai = await aiSafetyInsight({ token: tokenInfo, metrics });

        // best-effort log (ignore failures)
        try {
          await prisma.queryLog.create({
            data: {
              chatId: 0n, // HTTP (not a Telegram chat)
              type: "analyze",
              input: address,
              outcome: "ok",
              latencyMs: Date.now() - t0,
              provider: ai.provider,
            },
          });
        } catch (e) {
          req.log.warn({ err: e }, "queryLog write failed");
        }

        return { token: tokenInfo, metrics, ai };
      } catch (e: any) {
        // best-effort error log
        try {
          await prisma.queryLog.create({
            data: {
              chatId: 0n,
              type: "error",
              input: address,
              outcome: fmtErr(e),
              latencyMs: Date.now() - t0,
            },
          });
        } catch {}

        req.log.error({ err: e }, "token endpoint failed");
        reply.code(500);
        return { error: fmtErr(e) };
      }
    }
  );

  // GET /price/:symbol
  app.get(
    "/price/:symbol",
    async (
      req: FastifyRequest<{ Params: { symbol: string } }>,
      reply: FastifyReply
    ) => {
      const t0 = Date.now();
      const { symbol } = req.params;

      try {
        const info = await getCoinGeckoBySymbol(symbol);
        // best-effort log
        try {
          await prisma.queryLog.create({
            data: {
              chatId: 0n,
              type: "price",
              input: symbol,
              outcome: "ok",
              latencyMs: Date.now() - t0,
            },
          });
        } catch {}

        return {
          symbol: info.symbol,
          price: info.price,
          marketCap: info.marketCap,
          volume24h: info.volume24h,
        };
      } catch (e: any) {
        try {
          await prisma.queryLog.create({
            data: {
              chatId: 0n,
              type: "error",
              input: symbol,
              outcome: fmtErr(e),
              latencyMs: Date.now() - t0,
            },
          });
        } catch {}

        reply.code(500).send({ error: fmtErr(e) });
      }
    }
  );

  return app;
}

async function main() {
  const app = await buildServer();
  const port = getPort();
  const host = process.env.HOST || "0.0.0.0";
  const webhookPath = token ? `/tg/${token}` : undefined;

  await app.listen({ port, host });
  app.log.info(`HTTP server on http://${host}:${port}`);

  // If using webhook mode, set webhook after the server is listening
  if ((process.env.BOT_MODE || "polling") === "webhook" && webhookPath && bot) {
    const base = process.env.PUBLIC_URL;
    if (!base) {
      app.log.error("BOT_MODE=webhook but PUBLIC_URL is missing");
      process.exit(1);
    }
    const fullUrl = `${base}${webhookPath}`;
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      await bot.telegram.setWebhook(fullUrl);
      app.log.info(`Webhook set: ${fullUrl}`);
    } catch (e: any) {
      app.log.error({ err: e }, "Failed to set webhook");
      process.exit(1);
    }
  }
}

// In CommonJS builds, this ensures we only start the server when run directly.
declare const require: NodeJS.Require | undefined;
declare const module: NodeJS.Module | undefined;
if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Failed to start HTTP server", err);
    process.exit(1);
  });
}

// Export for tests (optional)
export {};
