import { z } from "zod";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export type SafetyResult = {
  score: number; // 0–100
  explanation: string;
  provider: "openai" | "gemini" | "mock";
};

// ---------------- Heuristic (used as feature + final fallback) -------------
function heuristicScore(input: {
  liquidityUsd: number;
  volume24h: number;
  fdv?: number;
  buys24h?: number;
  sells24h?: number;
}) {
  let s = 50;
  if (input.liquidityUsd > 100_000) s += 15;
  else if (input.liquidityUsd < 10_000) s -= 15;

  if (input.volume24h > 1_000_000) s += 15;
  else if (input.volume24h < 25_000) s -= 10;

  if (input.fdv && input.liquidityUsd > 0) {
    const r = input.liquidityUsd / input.fdv;
    if (r > 0.01) s += 10;
    else if (r < 0.001) s -= 10;
  }

  if ((input.buys24h ?? 0) + (input.sells24h ?? 0) < 100) s -= 5;

  return Math.max(0, Math.min(100, Math.round(s)));
}

// ---------------- Types for prompt inputs ----------------------------------
type PromptInputs = {
  name: string;
  symbol: string;
  chain: string;
  priceUsd: number | string;
  liquidityUsd: number | string;
  volume24h: number | string;
  fdv: number | string;
  buys24h: number | string;
  sells24h: number | string;
  heuristicScore: number;
};

// ---------------- JSON shape & validation (avoid StructuredOutputParser TS)-
const SafetySchema = z.object({
  score: z.number().min(0).max(100),
  explanation: z.string().min(10),
});
type SafetyShape = z.infer<typeof SafetySchema>;

// ---------------- Prompt (brace-escaped for literal JSON) ------------------
const prompt = ChatPromptTemplate.fromTemplate(
  `You are an analyst. Explain the safety of a crypto token for a retail user in 3–5 sentences.
Be neutral and specific. Avoid hype. Use the metrics to justify the safety score.

Context:
- Token: {name} ({symbol}) on {chain}
- Price: {priceUsd}
- Liquidity: {liquidityUsd}
- 24h Volume: {volume24h}
- FDV: {fdv}
- 24h Txns: buys={buys24h}, sells={sells24h}
- Heuristic Safety Score (0–100): {heuristicScore}

Return ONLY valid JSON with exactly these keys:
{{
  "score": <number 0-100>,
  "explanation": <string 3-5 sentences>
}}`
) as ChatPromptTemplate<PromptInputs, any>;

// ---------------- Providers -------------------------------------------------
function makeOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  return new ChatOpenAI({ model, temperature: 0.5 });
}

function makeGemini() {
  // LangChain uses GOOGLE_API_KEY (you can duplicate your Gemini key into this var)
  if (!process.env.GOOGLE_API_KEY) return null;
  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  return new ChatGoogleGenerativeAI({ model, temperature: 0.5 });
}

// ---------------- Build chain: Prompt → LLM → JSON parser -------------------
function buildChainForLLM(llm: ChatOpenAI | ChatGoogleGenerativeAI) {
  const jsonParser = new JsonOutputParser<SafetyShape>();
  // input PromptInputs → output SafetyShape
  return RunnableSequence.from<PromptInputs, SafetyShape>([
    prompt,
    llm,
    jsonParser,
  ]);
}

// ---------------- Safe chain runner (Zod validate + minor coercion) --------
async function runChain(
  chain: ReturnType<typeof buildChainForLLM>,
  inputs: PromptInputs,
  provider: "openai" | "gemini"
): Promise<SafetyResult> {
  const raw = await chain.invoke(inputs);
  const result = SafetySchema.safeParse(raw);
  if (result.success) return { ...result.data, provider };

  // Coerce common mistakes (e.g., "78%" as string)
  const maybeScore =
    typeof (raw as any)?.score === "string"
      ? Number(
          String((raw as any).score)
            .replace("%", "")
            .trim()
        )
      : (raw as any)?.score;

  const scoreNum = Number.isFinite(maybeScore)
    ? Math.max(0, Math.min(100, Math.round(Number(maybeScore))))
    : 50;

  const explanation =
    typeof (raw as any)?.explanation === "string"
      ? (raw as any).explanation
      : "No explanation.";

  return { score: scoreNum, explanation, provider };
}

// ---------------- Public API (auto-select + robust fallback) ----------------
export async function aiSafetyInsight(data: {
  token: { name: string; symbol: string; chain: string };
  metrics: {
    priceUsd?: number;
    liquidityUsd?: number;
    volume24h?: number;
    fdv?: number;
    buys24h?: number;
    sells24h?: number;
  };
}): Promise<SafetyResult> {
  const heur = heuristicScore({
    liquidityUsd: data.metrics.liquidityUsd ?? 0,
    volume24h: data.metrics.volume24h ?? 0,
    fdv: data.metrics.fdv,
    buys24h: data.metrics.buys24h,
    sells24h: data.metrics.sells24h,
  });

  const inputs: PromptInputs = {
    name: data.token.name,
    symbol: data.token.symbol,
    chain: data.token.chain,
    priceUsd: data.metrics.priceUsd ?? "N/A",
    liquidityUsd: data.metrics.liquidityUsd ?? "N/A",
    volume24h: data.metrics.volume24h ?? "N/A",
    fdv: data.metrics.fdv ?? "N/A",
    buys24h: data.metrics.buys24h ?? "N/A",
    sells24h: data.metrics.sells24h ?? "N/A",
    heuristicScore: heur,
  };

  const force = (process.env.AI_PROVIDER || "").toLowerCase(); // "openai" | "gemini" | ""
  const openai = makeOpenAI();
  const gemini = makeGemini();

  const tryOpenAI = async () => {
    if (!openai)
      throw Object.assign(new Error("OPENAI_API_KEY missing"), { status: 401 });
    const chain = buildChainForLLM(openai);
    return runChain(chain, inputs, "openai");
  };

  const tryGemini = async () => {
    if (!gemini)
      throw Object.assign(new Error("GOOGLE_API_KEY missing"), { status: 401 });
    const chain = buildChainForLLM(gemini);
    return runChain(chain, inputs, "gemini");
  };

  // Orchestration with strong fallback on OpenAI 429/quota
  try {
    if (force === "openai") return await tryOpenAI();
    if (force === "gemini") return await tryGemini();

    // Auto mode: prefer OpenAI, fall back to Gemini on any OpenAI error (esp. 429/quota)
    try {
      return await tryOpenAI();
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const code = e?.code ?? e?.response?.data?.error?.code;
      const msg = e?.message || String(e);

      console.warn("OpenAI failed; considering Gemini fallback →", {
        status,
        code,
        msg,
      });

      // If we have Gemini configured, try it whenever OpenAI fails.
      // (We still prefer to fallback on 429/insufficient_quota, but this will catch all OpenAI errors.)
      if (gemini) {
        try {
          return await tryGemini();
        } catch (ge: any) {
          console.error("Gemini also failed:", ge?.message || ge);
          throw ge;
        }
      }

      // No Gemini available → rethrow to hit the final mock
      throw e;
    }
  } catch (e: any) {
    console.error("AI pipeline failed completely:", e?.message || e);
    // Final mock fallback using heuristic only
    return {
      score: heur,
      explanation:
        "⚠️ AI providers unavailable. Showing heuristic-only safety score based on liquidity, 24h volume, and FDV.",
      provider: "mock",
    };
  }
}
