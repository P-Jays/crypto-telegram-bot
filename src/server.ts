import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { getCoinGeckoBySymbol } from "./services/coingecko";
import { getDexByContract } from "./services/dexscreener";
import { aiSafetyInsight } from "./services/ai";
import { prisma } from "./db/client";

const app = Fastify({ logger: true });

// --- plugins ---
// @ts-ignore
await app.register(cors, { origin: true });
// @ts-ignore
await app.register(helmet);

// --- tiny helpers ---
const isEvmAddress = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(s);
const fmtErr = (e: any) => e?.message || "Internal error";

// --- health ---
app.get("/health", async () => ({
  ok: true,
  mode: process.env.BOT_MODE || "polling",
}));

// --- Webhook endpoint (Telegram will POST updates here) ---
const token = process.env.BOT_TOKEN!;
const webhookPath = `/tg/${token}`;

app.post(webhookPath, async (req, reply) => {
  try {
    // Telegraf expects the raw update JSON
    // @ts-ignore
    await bot.handleUpdate(req.body);
    reply.send({ ok: true });
  } catch (e: any) {
    req.log.error({ err: e }, "handleUpdate failed");
    reply.code(500).send({ ok: false });
  }
});

/**
 * GET /token/:address
 * Returns top Dexscreener pair metrics + AI safety insight
 */
app.get("/token/:address", async (req, reply) => {
  const t0 = Date.now();
  const { address } = req.params as { address: string };

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

    const token = {
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

    const ai = await aiSafetyInsight({ token, metrics });

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

    return { token, metrics, ai };
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
});

app.get("/price/:symbol", async (req, reply) => {
  const t0 = Date.now();
  const symbol = (req.params as any).symbol;
  try {
    const info = await getCoinGeckoBySymbol(symbol);
    await prisma.queryLog.create({
      data: {
        chatId: 0n,
        type: "price",
        input: symbol,
        outcome: "ok",
        latencyMs: Date.now() - t0,
      },
    });
    return {
      symbol: info.symbol,
      price: info.price,
      marketCap: info.marketCap,
      volume24h: info.volume24h,
    };
  } catch (e: any) {
    await prisma.queryLog.create({
      data: {
        chatId: 0n,
        type: "error",
        input: symbol,
        outcome: fmtErr(e),
        latencyMs: Date.now() - t0,
      },
    });
    reply.code(500).send({ error: fmtErr(e) });
  }
});

const PORT = Number(process.env.PORT || 5555);
const HOST = process.env.HOST || "0.0.0.0";

app
  .listen({ port: PORT, host: HOST })
  .then(async (addr) => {
    app.log.info(`HTTP server on ${addr}`);

    if ((process.env.BOT_MODE || "polling") === "webhook") {
      const base = process.env.PUBLIC_URL;
      if (!base) {
        app.log.error("BOT_MODE=webhook but PUBLIC_URL is missing");
        process.exit(1);
      }
      const fullUrl = `${base}${webhookPath}`;

      try {
        // Remove any old webhook, then set the new webhookk
        // @ts-ignore
        await bot.telegram.deleteWebhook({ drop_pending_updates: false });
        // @ts-ignore
        await bot.telegram.setWebhook(fullUrl);
        app.log.info(`Webhook set: ${fullUrl}`);
      } catch (e: any) {
        app.log.error({ err: e }, "Failed to set webhook");
        process.exit(1);
      }
    }
  })
  .catch((err) => {
    app.log.error(err, "Failed to start HTTP server");
    process.exit(1);
  });
export { app };
