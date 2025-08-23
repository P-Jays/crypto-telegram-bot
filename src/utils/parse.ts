const STOPWORDS = new Set([
  'what', 'whats', "what's", 'is', 'the', 'price', 'of', 'for', 'a', 'an',
  'token', 'coin', 'current', 'now', 'how', 'much', 'worth', 'value',
  'please', 'tell', 'me'
]);

export function extractSymbolish(text: string): string | null {
  const raw = (text || "").trim();

  // 1) explicit $SYMBOL
  const mDollar = raw.match(/\$([a-z0-9]{2,15})\b/i);
  if (mDollar) return mDollar[1].toUpperCase();

  // 2) phrases: "price of xrp", "what is the price of pepe"
  const lower = raw.toLowerCase();
  const mPriceOf =
    lower.match(
      /(?:price|value|worth)\s+(?:of|for)?\s*\$?([a-z0-9]{2,15})\b/i
    ) ||
    lower.match(/what(?:'s| is)?\s+the\s+price\s+of\s+\$?([a-z0-9]{2,15})\b/i);
  if (mPriceOf) return mPriceOf[1].toUpperCase();

  // 3) single-token query like "xrp", "pepe", "eth?"
  const cleaned = raw
    .toLowerCase()
    .replace(/[?!.:,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ").filter(Boolean);

  if (parts.length === 1 && /^[a-z0-9]{2,15}$/i.test(parts[0])) {
    return parts[0].toUpperCase();
  }

  // 4) fallback: take the LAST non-stopword token if it looks like a symbol
  for (let i = parts.length - 1; i >= 0; i--) {
    const w = parts[i].toLowerCase();
    if (STOPWORDS.has(w)) continue;
    if (/^[a-z0-9]{2,15}$/i.test(w)) return w.toUpperCase();
    break;
  }

  return null;
}
