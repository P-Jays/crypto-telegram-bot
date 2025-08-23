export type ProviderPref = 'auto' | 'openai' | 'gemini';
export type Settings = {
  defaultChain?: string;     // e.g., 'ethereum', 'bsc', 'solana'
  provider?: ProviderPref;   // ai provider preference
};

const store = new Map<number, Settings>();

export function getSettings(chatId: number): Settings {
  return store.get(chatId) || { provider: 'auto' };
}

export function setSettings(chatId: number, patch: Partial<Settings>) {
  const cur = getSettings(chatId);
  const next = { ...cur, ...patch };
  store.set(chatId, next);
  return next;
}
