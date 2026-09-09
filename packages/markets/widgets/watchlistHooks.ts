import { useCallback, useEffect, useMemo, useState } from "react";
import type { MarketDataResult, MarketQuote } from "../src/types.ts";
import type { MarketWatchlists } from "../src/watchlists.ts";
import { marketsApi } from "./api.ts";

const WATCHLIST_EVENT = "polyth:markets-watchlists-changed";

const message = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const aborted = (cause: unknown): boolean => cause instanceof DOMException && cause.name === "AbortError";

export function useMarketWatchlists(active = true) {
  const [data, setData] = useState<MarketWatchlists | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const next = await marketsApi.watchlists(signal);
      setData(next);
      return next;
    } catch (cause) {
      if (!aborted(cause)) setError(message(cause));
      throw cause;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void reload(controller.signal).catch(() => undefined);
    const changed = () => void reload().catch(() => undefined);
    window.addEventListener(WATCHLIST_EVENT, changed);
    return () => {
      controller.abort();
      window.removeEventListener(WATCHLIST_EVENT, changed);
    };
  }, [active, reload]);

  const save = useCallback(async (next: MarketWatchlists) => {
    const saved = await marketsApi.saveWatchlists(next);
    setData(saved);
    window.dispatchEvent(new Event(WATCHLIST_EVENT));
    return saved;
  }, []);

  return { data, loading, error, reload, save };
}

export function useQuoteBatch(symbols: readonly string[], active = true, refreshMs = 15_000) {
  const key = symbols.join("\u0000");
  const [items, setItems] = useState<MarketDataResult<MarketQuote>[]>([]);
  const [errors, setErrors] = useState<Array<{ symbol: string; message: string }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active || !key) return;
    const requested = key.split("\u0000");
    let disposed = false;
    let running = false;
    let controller: AbortController | null = null;

    const load = async () => {
      if (running || disposed || document.visibilityState === "hidden") return;
      running = true;
      controller?.abort();
      controller = new AbortController();
      setLoading(true);
      try {
        const result = await marketsApi.quotes(requested, controller.signal);
        if (!disposed) {
          setItems(result.items);
          setErrors(result.errors);
        }
      } catch (cause) {
        if (!disposed && !aborted(cause)) {
          setErrors(requested.map((symbol) => ({ symbol, message: message(cause) })));
        }
      } finally {
        running = false;
        if (!disposed) setLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    const visible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, key, refreshMs]);

  const quotes = useMemo(() => new Map(items.map((item) => [item.data.symbol, item])), [items]);
  return { items, quotes, errors, loading };
}
