import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { putPayload, takePayload } from "../utils/cbStore.js";

import { getCoinGeckoBySymbol } from "../services/coingecko";
import {
  searchDexPairs,
  getPairByChainAndAddress,
  getDexByContract,
  DexPair,
} from "../services/dexscreener";
import { resolveContractFromQuery } from "../services/resolver";
import { aiSafetyInsight } from "../services/ai";

import { rateLimiter } from "../middleware/rateLimiter";
import { getSettings, setSettings } from "../state/settings";
import { logQuery } from "../utils/log";
import { prisma } from "../db/client.js";
import { extractSymbolish } from "../utils/parse.js";

// ----------------- Utils -----------------
const isAddress = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(s);
const fmtUSD = (n?: number) =>
  typeof n === "number" && !Number.isNaN(n)
    ? `$${n.toLocaleString(undefined, {
        maximumFractionDigits:
          Math.abs(n) >= 1 ? 4 : Math.abs(n) >= 0.01 ? 6 : 8,
      })}`
    : "N/A";
const mdEscape = (s: string) =>
  String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
function escapeMd(text: string) {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
const html = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function typing<T>(ctx: any, fn: () => Promise<T>): Promise<T> {
  try {
    await ctx.sendChatAction("typing");
  } catch {}
  return fn();
}

function userError(e: any, fallback = "Something went wrong.") {
  const msg = (e?.message || "").toLowerCase();
  if (msg.includes("not found")) return "I couldn’t find that token.";
  if (msg.includes("quota") || msg.includes("429"))
    return "AI is busy right now — try again in a moment.";
  if (msg.includes("address"))
    return "That doesn’t look like a valid contract address.";
  return fallback;
}

const isEvm = (addr?: string) => !!addr && /^0x[a-fA-F0-9]{40}$/.test(addr);
function now() {
  return Date.now();
}
function elapsed(t0: number) {
  return Date.now() - t0;
}

// --------------- Bot init ----------------
if (!process.env.BOT_TOKEN)
  throw new Error("❌ BOT_TOKEN is not defined in .env");
const bot = new Telegraf(process.env.BOT_TOKEN);

// ✅ Rate limiter BEFORE handlers
bot.use(rateLimiter);

// --------------- Commands ----------------

bot.use(async (ctx, next) => {
  console.log("update:", JSON.stringify(ctx.update, null, 2));
  return next();
});

bot.start(async (ctx) => {
  const t0 = Date.now();
  console.log("✅ Bot started");
  await ctx.reply(
    `👋 Welcome to *Crypto Safety Bot*!\n
Here’s what I can do for you:\n
💰 /price <SYMBOL> — Get token price (e.g. /price BTC)\n
🔍 /analyze <ADDRESS> — AI safety check of a token contract\n
🛠 /settings — View your settings\n
🌐 /setchain <CHAIN> — Set default chain (e.g. Ethereum, BSC, Solana)\n
🤖 /provider <openai|gemini|auto> — Choose AI provider(openAI still not pay yet, will have no respond)\n
📜 /logs — View your recent queries\n
💬 Just type a token *symbol*, *name*, or *contract address* directly and I’ll resolve it for you.\n
—
Tip: Try typing "BTC" or paste a contract address to begin.`,
    { parse_mode: "Markdown" }
  );

  await logQuery({
    chatId: ctx.chat!.id,
    type: "start",
    input: "/start",
    outcome: "ok",
    latencyMs: Date.now() - t0,
  });
});

bot.help(async (ctx) => {
  const t0 = Date.now();
  await ctx.reply(
    `🛠 *What I can do*

• Paste a *contract address* → I analyze it and give a safety score.
• Type a *symbol or name* (e.g., $PEPE or pepe) → I show price and offer an Analyze button.
• Ask in English: “What’s the price of $TOKEN?”

*Commands*
💰 /price <SYMBOL> — Get token price (e.g. /price ETH)\n
🔍 /analyze <ADDRESS> — AI safety check of a token contract\n
🛠 /settings — View your settings\n
🌐 /setchain <CHAIN> — Set default chain (Ethereum, BSC, Solana…)\n
🤖 /provider <openai|gemini|auto> — Switch AI provider\n
📜 /logs — View your recent queries\n
💬 Free-form: Just type a symbol, name, or contract address directly!

*Tip:* You don’t need commands. Just type.`,
    { parse_mode: "Markdown" }
  );
  await logQuery({
    chatId: ctx.chat!.id,
    type: "help",
    input: "/settings",
    outcome: "ok",
    latencyMs: Date.now() - t0,
  });
});

bot.command("settings", async (ctx) => {
  const t0 = Date.now();
  const chatId = ctx.chat?.id!;
  const s = getSettings(chatId);
  await ctx.reply(
    `⚙️ Settings
• Default chain: ${s.defaultChain ?? "auto"}
• AI provider: ${s.provider ?? "auto"}

Change:
 /setchain <ethereum|bsc|polygon|solana|base|arbitrum|optimism|fantom>
 /provider <auto|openai|gemini>`
  );
  await logQuery({
    chatId: ctx.chat!.id,
    type: "settings",
    input: "/settings",
    outcome: "ok",
    latencyMs: Date.now() - t0,
  });
});

bot.command("setchain", async (ctx) => {
  const chatId = ctx.chat?.id!;
  const arg = (ctx.message.text || "").split(/\s+/)[1]?.toLowerCase();
  const allowed = new Set([
    "ethereum",
    "bsc",
    "polygon",
    "solana",
    "base",
    "arbitrum",
    "optimism",
    "fantom",
  ]);
  if (!arg || !allowed.has(arg)) {
    await ctx.reply(
      "Usage: /setchain <ethereum|bsc|polygon|solana|base|arbitrum|optimism|fantom>"
    );
    return;
  }
  setSettings(chatId, { defaultChain: arg });
  await ctx.reply(`✅ Default chain set to *${arg}*`, {
    parse_mode: "Markdown",
  });
});

bot.command("provider", async (ctx) => {
  const chatId = ctx.chat?.id!;
  const arg = (ctx.message.text || "").split(/\s+/)[1]?.toLowerCase();
  const allowed = new Set(["auto", "openai", "gemini"]);
  if (!arg || !allowed.has(arg)) {
    await ctx.reply("Usage: /provider <auto|openai|gemini>");
    return;
  }
  setSettings(chatId, { provider: arg as any });
  await ctx.reply(`✅ AI provider set to *${arg}*`, { parse_mode: "Markdown" });
});

bot.command("price", async (ctx) => {
  const t0 = now();
  await typing(ctx, async () => {
    const arg = (ctx.message.text || "").split(/\s+/).slice(1).join(" ").trim();
    if (!arg) {
      await ctx.reply("Usage: /price <SYMBOL>  e.g. /price btc");
      return;
    }
    try {
      await handlePrice(ctx, arg);
      await logQuery({
        chatId: ctx.chat.id,
        type: "price",
        input: arg,
        latencyMs: Date.now() - t0,
        outcome: "ok",
      });
    } catch (e: any) {
      console.error(e);
      await ctx.reply(`⚠️ ${userError(e, "Failed to fetch price")}`);
      await logQuery({
        chatId: ctx.chat.id,
        type: "error",
        input: arg,
        latencyMs: Date.now() - t0,
        outcome: "ok",
      });
    }
  });
});

bot.command("analyze", async (ctx) => {
  const t0 = now();
  await typing(ctx, async () => {
    const arg = (ctx.message.text || "").split(/\s+/).slice(1).join("").trim();
    if (!arg) {
      await ctx.reply("Usage: /analyze 0x<contractAddress>");
      return;
    }
    if (!isAddress(arg)) {
      await ctx.reply("That doesn’t look like a contract address (0x…40 hex).");
      return;
    }
    try {
      await handleContractAnalysis(ctx, arg);
      await logQuery({
        chatId: ctx.chat.id,
        type: "analyze",
        input: arg,
        latencyMs: Date.now() - t0,
        outcome: "ok",
      });
    } catch (e: any) {
      console.error(e);
      await logQuery({
        chatId: ctx.chat.id,
        type: "error",
        input: arg,
        latencyMs: Date.now() - t0,
        outcome: "ok",
      });

      await ctx.reply(`⚠️ ${userError(e, "Failed to analyze contract")}`);
    }
  });
});

bot.command("logs", async (ctx) => {
  const rows = await prisma.queryLog.findMany({
    orderBy: { id: "desc" },
    take: 5,
  });
  const msg = rows
    .map(
      (r) =>
        `${r.id}. ${r.type} [${r.outcome}] ${r.latencyMs}ms\n${r.input.slice(
          0,
          30
        )}...`
    )
    .join("\n\n");
  await ctx.reply(msg || "No logs yet");
});

// --------------- Free-form input ----------------
bot.on("text", async (ctx) => {
  const t0 = now();
  await typing(ctx, async () => {
    const text = (ctx.message.text || "").trim();

    // contract → analyze
    if (isAddress(text)) {
      try {
        await handleContractAnalysis(ctx, text);
        console.log("[freeform] ok", { chat: ctx.chat?.id, ms: elapsed(t0) });
        await logQuery({
          chatId: ctx.chat.id,
          type: "freeform",
          input: text,
          latencyMs: Date.now() - t0,
          outcome: "ok",
        });
      } catch (e: any) {
        console.error("[freeform] fail", {
          chat: ctx.chat?.id,
          err: e?.message,
          ms: elapsed(t0),
        });
        await ctx.reply(`⚠️ ${userError(e, "Failed to analyze contract")}`);
        await logQuery({
          chatId: ctx.chat.id,
          type: "error",
          input: text,
          latencyMs: Date.now() - t0,
          outcome: "ok",
        });
      }
      return;
    }

    // symbol/name → price + analyze button
    const symbolish = extractSymbolish(text);
    if (!symbolish) {
      await ctx.reply(
        "🤔 I can handle:\n• 0x… (contract)\n• token symbol/name (ex: $PEPE, BTC, pepe)\n• “price of $TOKEN”"
      );
      return;
    }

    try {
      // Show price
      await handlePrice(ctx, symbolish);

      // Also show Dex candidates (filtered to actionable)
      const candidates = await searchDexPairs(symbolish, 5);
      const actionable = candidates.filter(
        (p) => isEvm(p?.baseToken?.address) || (p?.chainId && p?.pairAddress)
      );

      // Reorder by user’s preferred chain
      const pref = getSettings(ctx.chat!.id).defaultChain;
      if (pref) {
        actionable.sort((a, b) => {
          const ap = (a.chainId || "").toLowerCase() === pref ? 1 : 0;
          const bp = (b.chainId || "").toLowerCase() === pref ? 1 : 0;
          return bp - ap;
        });
      }

      if (actionable.length) {
        const rows = actionable.map((p) => {
          const base = p.baseToken?.symbol || p.baseToken?.name || "Token";
          const chain = (p.chainId || "").toUpperCase();
          const liq = fmtUSD(p?.liquidity?.usd);

          // If EVM address is available, use ANALYZE_ADDR (always <64 bytes)
          if (/^0x[a-fA-F0-9]{40}$/.test(p.baseToken?.address)) {
            return [
              Markup.button.callback(
                `${base} · ${chain} · Liq ${liq}`,
                `ANALYZE_ADDR:${p.baseToken.address}`
              ),
            ];
          }
          // Otherwise store payload and send short id
          if (p.chainId && p.pairAddress) {
            const id = putPayload({
              kind: "PAIR",
              chainId: p.chainId,
              pairAddress: p.pairAddress,
            });
            return [
              Markup.button.callback(
                `${base} · ${chain} · Liq ${liq}`,
                `CB:${id}` // always short
              ),
            ];
          }
          return [
            Markup.button.callback(
              `${base} · ${chain} · Liq ${liq}`,
              `ANALYZE_PAIR:${p.chainId}:${p.pairAddress}`
            ),
          ];
        });

        await ctx.reply("Choose a token to analyze on-chain:", {
          ...Markup.inlineKeyboard(rows),
        });
      }
    } catch (e: any) {
      console.error(e);
      await ctx.reply(`⚠️ ${userError(e, "Failed to fetch price or pairs")}`);
      await logQuery({
        chatId: ctx.chat.id,
        type: "error",
        input: text,
        latencyMs: Date.now() - t0,
        outcome: "ok",
      });
    }
  });
});

// --------------- Callback handlers ----------------

// Analyze by resolved EVM contract
bot.action(/ANALYZE_ADDR:(0x[a-fA-F0-9]{40})/, async (ctx) => {
  const t0 = now();
  const address = ctx.match[1];
  try {
    await ctx.answerCbQuery("Analyzing…", { show_alert: false });
    await handleContractAnalysis(ctx, address);
    await logQuery({
      chatId: ctx.chat!.id,
      type: "analyze",
      input: address,
      latencyMs: Date.now() - t0,
      outcome: "ok",
    });
  } catch (e: any) {
    console.error(e);
    await ctx.reply(`⚠️ ${userError(e, "Failed to analyze contract")}`);
    await logQuery({
      chatId: ctx.chat!.id,
      type: "error",
      input: address,
      latencyMs: Date.now() - t0,
      outcome: e?.message || "fail",
    });
    throw e;
  }
});

// Analyze by chain+pair (non-EVM pairs like Solana; try to resolve)
bot.action(/ANALYZE_PAIR:([^:]+):([^:]+)/, async (ctx) => {
  const t0 = now();
  const chainId = ctx.match[1];
  const pairAddr = ctx.match[2];
  try {
    await ctx.answerCbQuery("Resolving pair…", { show_alert: false });
    const detail = await getPairByChainAndAddress(chainId, pairAddr);
    const baseAddr: string | undefined = detail?.baseToken?.address;

    if (isEvm(baseAddr)) {
      await handleContractAnalysis(ctx, baseAddr!);
      await logQuery({
        chatId: ctx.chat!.id,
        type: "analyze",
        input: `${chainId}:${pairAddr}`,
        latencyMs: Date.now() - t0,
        outcome: "ok",
      });
      return;
    }

    // Optional: map native BTC/ETH to WBTC/WETH (EVM) for analysis
    const baseSym = detail?.baseToken?.symbol?.toUpperCase?.() || "";
    if (baseSym === "BTC") {
      await ctx.reply("ℹ️ BTC on non-EVM. Analyzing WBTC (Ethereum) instead.");
      await handleContractAnalysis(
        ctx,
        "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"
      );
      await logQuery({
        chatId: ctx.chat!.id,
        type: "analyze",
        input: `${chainId}:${pairAddr}`,
        latencyMs: Date.now() - t0,
        outcome: "ok",
      });
      return;
    }
    if (baseSym === "ETH") {
      await ctx.reply("ℹ️ ETH on non-EVM. Analyzing WETH (Ethereum) instead.");
      await handleContractAnalysis(
        ctx,
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
      );
      await logQuery({
        chatId: ctx.chat!.id,
        type: "analyze",
        input: `${chainId}:${pairAddr}`,
        latencyMs: Date.now() - t0,
        outcome: "ok",
      });
      return;
    }

    await ctx.reply(
      `⚠️ ${String(
        chainId
      ).toUpperCase()} token has no EVM-style contract. EVM analysis is supported right now.`
    );
  } catch (e: any) {
    console.error("ANALYZE_PAIR error:", e?.message || e);
    await ctx.reply(`⚠️ ${userError(e, "Failed to analyze this pair")}`);
    await logQuery({
      chatId: ctx.chat!.id,
      type: "error",
      input: `${chainId}:${pairAddr}`,
      latencyMs: Date.now() - t0,
      outcome: e?.message || "fail",
    });
    throw e;
  }
});

// Analyze by free-form query from button
bot.action(/ANALYZE_Q:(.+)/, async (ctx) => {
  const q = decodeURIComponent(ctx.match[1]);
  try {
    await ctx.answerCbQuery("Resolving…", { show_alert: false });
    const res = await resolveContractFromQuery(q);
    if (!res?.address) {
      await ctx.reply("I couldn’t resolve a contract for that query.");
      return;
    }
    if (res.note) await ctx.reply(`ℹ️ ${res.note}`);
    await handleContractAnalysis(ctx, res.address);
  } catch (e: any) {
    console.error(e);
    await ctx.reply(`⚠️ ${userError(e, "Failed to analyze")}`);
  }
});

// quick price button
bot.action(/PRICE_Q:([A-Za-z0-9]{2,12})/, async (ctx) => {
  const sym = ctx.match[1];
  try {
    await ctx.answerCbQuery();
    await handlePrice(ctx, sym);
  } catch (e: any) {
    console.error(e);
    await ctx.reply(`⚠️ ${userError(e, "Failed to fetch price")}`);
  }
});

bot.action(/CB:([A-Za-z0-9_-]{6,32})/, async (ctx) => {
  const id = ctx.match[1];
  const payload = takePayload(id);
  if (!payload) {
    await ctx.answerCbQuery("Expired. Please search again.", {
      show_alert: true,
    });
    return;
  }

  try {
    await ctx.answerCbQuery();

    if (payload.kind === "PAIR") {
      const { chainId, pairAddress } = payload as {
        chainId: string;
        pairAddress: string;
      };
      const detail = await getPairByChainAndAddress(chainId, pairAddress);
      const baseAddr: string | undefined = detail?.baseToken?.address;

      if (baseAddr && /^0x[a-fA-F0-9]{40}$/.test(baseAddr)) {
        await handleContractAnalysis(ctx, baseAddr);
        return;
      }

      const baseSym = detail?.baseToken?.symbol?.toUpperCase?.() || "";
      if (baseSym === "BTC") {
        await ctx.reply("ℹ️ Non-EVM pair. Analyzing WBTC (Ethereum) instead.");
        await handleContractAnalysis(
          ctx,
          "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"
        );
        return;
      }
      if (baseSym === "ETH") {
        await ctx.reply("ℹ️ Non-EVM pair. Analyzing WETH (Ethereum) instead.");
        await handleContractAnalysis(
          ctx,
          "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
        );
        return;
      }

      await ctx.reply(
        `⚠️ ${String(
          chainId
        ).toUpperCase()} token has no EVM contract. EVM analysis supported for now.`
      );
      return;
    }

    // Future: handle other payload kinds here
  } catch (e: any) {
    console.error("CB handler error:", e?.message || e);
    await ctx.reply(`⚠️ ${e.message || "Failed to analyze selection"}`);
  }
});

// --------------- Core handlers ----------------

async function handlePrice(ctx: any, symbolish: string) {
  const info = await getCoinGeckoBySymbol(symbolish);
  const msg = `💰 *${mdEscape(info.name)}* ($${mdEscape(info.symbol)})
*Price*: ${fmtUSD(info.price)}
*Market Cap*: ${fmtUSD(info.marketCap)}
*Volume 24h*: ${fmtUSD(info.volume24h)}
*Liquidity Score*: ${info.liquidityScore ?? "N/A"}`;

  await ctx.reply(msg, { parse_mode: "Markdown" });

  // Offer 1-tap Analyze based on resolver too
  try {
    const res = await resolveContractFromQuery(info.symbol);
    if (res?.address) {
      await ctx.reply(
        `Analyze ${mdEscape(info.symbol)} on-chain?`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔍 Analyze", `ANALYZE_ADDR:${res.address}`)],
        ])
      );
    }
  } catch (e: any) {
    console.warn("Auto-resolve failed:", e?.message || e);
  }
}

async function handleContractAnalysis(ctx: any, address: string) {
  const chatId = ctx.chat?.id!;

  // Dexscreener token data
  const pairs: DexPair[] = await getDexByContract(address);
  const top = pairs[0]; // ✅ just index into the array
  if (!top) throw new Error("Token not found on Dexscreener");

  const name = top.baseToken?.name || "Token";
  const symbol = top.baseToken?.symbol || "";
  const chain = (top.chainId || "").toUpperCase();

  const price = top.priceUsd ? Number(top.priceUsd) : undefined;
  const liq = top.liquidity?.usd ? Number(top.liquidity.usd) : undefined;
  const vol24 = top.volume?.h24 ? Number(top.volume.h24) : undefined;
  const fdv = typeof top.fdv === "number" ? top.fdv : undefined;
  const buys = top.txns?.h24?.buys ?? undefined;
  const sells = top.txns?.h24?.sells ?? undefined;

  const pref = getSettings(chatId).provider || "auto";
  const prev = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = pref === "auto" ? "" : pref;

  let ai;
  try {
    ai = await aiSafetyInsight({
      token: { name, symbol, chain },
      metrics: {
        priceUsd: price,
        liquidityUsd: liq,
        volume24h: vol24,
        fdv,
        buys24h: buys,
        sells24h: sells,
      },
    });
  } finally {
    process.env.AI_PROVIDER = prev;
  }

  const header = `📊 Token: *${mdEscape(name)}* (${mdEscape(symbol)})
Chain: ${mdEscape(chain)}
Price: ${fmtUSD(price)}
Liquidity: ${fmtUSD(liq)}
Volume 24h: ${fmtUSD(vol24)}
FDV: ${fmtUSD(fdv)}`;

  const insight = `🧠 *AI Insight* (via ${ai.provider})
${html(ai.explanation)}

🛡 *Safety Score*: ${ai.score}%`;

  // also fix the URL typo: "dexsc reener.com" → "dexscreener.com"
  const dexUrl =
    (top as any).url ||
    `https://dexscreener.com/${(top.chainId || "").toLowerCase()}/${
      top.pairAddress || ""
    }`;

  await ctx.reply(`${header}\n\n${insight}`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("🔄 Refresh", `ANALYZE_ADDR:${address}`),
        Markup.button.url("🧭 DexScreener", dexUrl),
      ],
    ]),
  });
}

// ---- STARTUP LOGIC ----
async function startBot() {
  const mode = process.env.BOT_MODE || "polling";
  if (mode === "webhook") {
    console.log("Bot running in WEBHOOK mode (handled by Fastify server).");
    return; // Fastify will call setWebhook + handleUpdate
  }

  // Polling mode (dev/local)
  await bot.launch();
  console.log("✅ Bot started (polling)");

  // Enable graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

// CJS-safe "run if called directly"
declare const require: any, module: any; // TS hint; harmless in ESM too
if (
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module
) {
  startBot().catch((e) => {
    console.error("Failed to start bot:", e);
    process.exit(1);
  });
}

export { bot, startBot };

// --------------- Launch ----------------
// (async () => {
//   await bot.launch();
// })();

// // Enable graceful stop
// process.once("SIGINT", () => bot.stop("SIGINT"));
// process.once("SIGTERM", () => bot.stop("SIGTERM"));
