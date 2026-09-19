import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";
import { normalizeSymbol } from "./service.ts";

export interface MarketWatchlist {
  id: string;
  name: string;
  symbols: string[];
}

export interface MarketWatchlists {
  version: 1;
  activeId: string;
  items: MarketWatchlist[];
}

const WATCHLIST_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MAX_LISTS = 12;
const MAX_SYMBOLS = 100;

export const DEFAULT_WATCHLISTS: MarketWatchlists = {
  version: 1,
  activeId: "default",
  items: [{ id: "default", name: "Watchlist", symbols: ["SPY", "QQQ"] }],
};

const fail: (message: string) => never = (message) => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

export function parseWatchlists(value: unknown): MarketWatchlists {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("watchlists must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) fail("unsupported watchlist version");
  const activeId = raw.activeId;
  if (typeof activeId !== "string" || !WATCHLIST_ID.test(activeId)) return fail("active watchlist id is invalid");
  const rawItems = raw.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_LISTS) {
    return fail(`watchlists must contain 1-${MAX_LISTS} lists`);
  }

  const ids = new Set<string>();
  const items = rawItems.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("each watchlist must be an object");
    const item = value as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || !WATCHLIST_ID.test(id)) return fail("watchlist id is invalid");
    if (ids.has(id)) return fail(`duplicate watchlist id: ${id}`);
    ids.add(id);
    const rawName = item.name;
    if (typeof rawName !== "string" || !rawName.trim() || rawName.trim().length > 64) {
      return fail("watchlist name must be 1-64 characters");
    }
    const rawSymbols = item.symbols;
    if (!Array.isArray(rawSymbols) || rawSymbols.length > MAX_SYMBOLS) {
      return fail(`a watchlist may contain at most ${MAX_SYMBOLS} symbols`);
    }
    const symbols: string[] = [];
    const seen = new Set<string>();
    for (const candidate of rawSymbols) {
      if (typeof candidate !== "string") fail("watchlist symbols must be strings");
      const symbol = normalizeSymbol(candidate);
      if (!seen.has(symbol)) {
        seen.add(symbol);
        symbols.push(symbol);
      }
    }
    return { id, name: rawName.trim(), symbols };
  });

  if (!ids.has(activeId)) return fail("active watchlist does not exist");
  return { version: 1, activeId, items };
}

export async function loadWatchlists(storage: SpaceStorage): Promise<MarketWatchlists> {
  const file = join(storage.packageDir("markets"), "watchlists.json");
  try {
    return parseWatchlists(JSON.parse(await readFile(file, "utf8")));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_WATCHLISTS);
    throw cause;
  }
}

export async function saveWatchlists(storage: SpaceStorage, value: unknown): Promise<MarketWatchlists> {
  const document = parseWatchlists(value);
  const dir = storage.packageDir("markets");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "watchlists.json");
  const temporary = join(dir, `.watchlists.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return document;
}
