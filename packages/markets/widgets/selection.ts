let selectedSymbol = "SPY";
const listeners = new Set<() => void>();

export function getMarketSymbol(): string {
  return selectedSymbol;
}

export function subscribeMarketSymbol(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function selectMarketSymbol(symbol: string): void {
  const next = symbol.trim().toUpperCase();
  if (!next || next === selectedSymbol) return;
  selectedSymbol = next;
  for (const listener of listeners) listener();
}
